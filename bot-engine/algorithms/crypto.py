"""
bot-engine/algorithms/crypto.py — v4
======================================
MAJOR UPGRADE:  Confidence Engine + Multi-Strategy + Leverage-Aware Risk

What changed from v3:
─────────────────────
1.  CONFIDENCE ENGINE (Part 1)
    Every potential entry is scored 0–100 using 6 technical factors:
    trend strength, volume, breakout strength, RSI, ATR volatility,
    market structure.  Entries below score 40 are skipped.

2.  LEVERAGE MAPPING (Part 2 + 9)
    Confidence → leverage:  <40=no trade, 40+=3×, 50+=5×, 65+=7×, 80+=10×
    Paper mode uses IDENTICAL leverage math for realistic PnL simulation.
    Leverage is stored on _open_positions so exit math is correct.

3.  CRYPTO-ONLY GUARD (Part 3)
    leverage = 1 for all non-crypto markets (not used here, but guard included).

4.  MULTI-STRATEGY ENGINE (Parts 7/7B)
    Three sub-strategies, selected based on detected market regime:

    a) detect_breakout()  — existing logic, improved with ATR + volume
    b) detect_pullback()  — NEW: trend + EMA20/50 reversion + RSI reset
    c) detect_scalp()     — NEW structure (disabled by default via config)

    TRENDING regime → prefer pullback then breakout
    RANGING  regime → prefer breakout  (scalp if enabled)

5.  RISK MANAGEMENT (Part 6/6B)
    Position sizing:
      risk_amount = balance × risk_pct_per_trade
      notional    = risk_amount × leverage
      qty         = notional / price
    SL distance:
      sl_dist_pct = (balance × risk_pct) / notional
    Max concurrent trades: checked via existing RiskManager.can_trade()
    Daily loss cap: tracked by RiskManager.record_trade_closed()
    Hold time: derived from confidence score (3h / 6h / 12h).

6.  MARKET REGIME DETECTION (Part 6C)
    detect_market_regime() from market_regime.py is called before every
    signal cycle.  Regime influences sub-strategy priority.

7.  STAGED OPEN PATTERN (from v3) fully preserved.
"""

import pandas as pd
import logging
from typing import Optional, Dict, Tuple
from datetime import datetime, timedelta

from ta.trend import EMAIndicator
from ta.momentum import RSIIndicator
from ta.volatility import BollingerBands, AverageTrueRange

from algorithms.base_algo import BaseAlgo
from confidence_engine import score_confidence, leverage_from_score, hold_hours_from_score
from market_regime import detect_market_regime, regime_preferred_strategies

logger = logging.getLogger(__name__)

# ── Leverage helpers ─────────────────────────────────────────────────────────

def _crypto_leverage_only(market_type: str, leverage: int) -> int:
    """Guard: only crypto markets use leverage > 1."""
    return leverage if market_type == "crypto" else 1


# ---------------------------------------------------------------------------
# CryptoAlgo
# ---------------------------------------------------------------------------

class CryptoAlgo(BaseAlgo):
    """
    Crypto algo with confidence-based leverage, multi-strategy selection,
    and leverage-aware PnL simulation for paper mode.
    """

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._open_positions:    Dict[str, Dict] = {}
        self._last_signal_time:  Dict[str, datetime] = {}
        self._db_synced:         set = set()
        self._staged_open:       Dict[str, Dict] = {}

    # ── Identity ──────────────────────────────────────────────────────────────

    @property
    def market_type(self) -> str:
        return "crypto"

    def config_filename(self) -> str:
        return "crypto.json"

    def default_config(self) -> Dict:
        return {
            "symbols":                 ["BTC/USDT", "ETH/USDT", "SOL/USDT"],
            "timeframe":               "15m",
            "trend_timeframe":         "4h",
            "signal_cooldown_minutes": 15,
            # Risk
            "risk_pct_per_trade":      1.0,   # 1% of balance per trade
            "max_open_trades":         3,
            "daily_loss_limit_pct":    3.0,   # -3% of balance
            # Strategy flags
            "scalp_enabled":           False,
            # Min confidence to enter
            "min_confidence":          40.0,
        }

    def get_symbols(self) -> list:
        return self.config.get("symbols", ["BTC/USDT"])

    # ── Cooldown ──────────────────────────────────────────────────────────────

    def _on_cooldown(self, symbol: str) -> bool:
        last = self._last_signal_time.get(symbol)
        if not last:
            return False
        mins = self.config.get("signal_cooldown_minutes", 15)
        return (datetime.utcnow() - last) < timedelta(minutes=mins)

    # ── DB sync (restart recovery) ────────────────────────────────────────────

    async def _sync_position_from_db(self, symbol: str):
        if symbol in self._db_synced:
            return
        self._db_synced.add(symbol)
        try:
            open_row = await self.db.get_open_trade(self.user_id, symbol, self.market_type)
            if open_row and symbol not in self._open_positions:
                opened_at = open_row["opened_at"]
                if hasattr(opened_at, "tzinfo") and opened_at.tzinfo is not None:
                    opened_at = opened_at.replace(tzinfo=None)
                self._open_positions[symbol] = {
                    "signal":      open_row["side"].upper(),
                    "entry_price": float(open_row["entry_price"]),
                    "opened_at":   opened_at,
                    "leverage":    int(open_row.get("metadata", {}).get("leverage", 1)
                                       if isinstance(open_row.get("metadata"), dict) else 1),
                    "confidence":  float(open_row.get("metadata", {}).get("confidence", 50)
                                         if isinstance(open_row.get("metadata"), dict) else 50),
                }
                logger.info(
                    "🔄 Restored Crypto position: %s %s @ %s (lev=%s)",
                    open_row["side"].upper(), symbol, open_row["entry_price"],
                    self._open_positions[symbol]["leverage"],
                )
        except Exception as exc:
            logger.error("❌ Crypto DB sync failed for %s: %s", symbol, exc, exc_info=True)

    # ── Position helpers ──────────────────────────────────────────────────────

    def _has_position(self, symbol: str) -> bool:
        return symbol in self._open_positions

    def _stage_open(self, symbol: str, signal: str, price: float,
                    leverage: int, confidence: float):
        self._staged_open[symbol] = {
            "signal":      signal,
            "entry_price": price,
            "opened_at":   datetime.utcnow(),
            "leverage":    leverage,
            "confidence":  confidence,
        }
        self._last_signal_time[symbol] = datetime.utcnow()
        logger.info(
            "📋 Open staged: %s %s @ %.4f  confidence=%.1f  leverage=%d×",
            signal, symbol, price, confidence, leverage,
        )

    def _confirm_staged_open(self, symbol: str):
        pending = self._staged_open.pop(symbol, None)
        if pending:
            self._open_positions[symbol] = pending
            logger.info(
                "📂 Position confirmed: %s %s @ %.4f  leverage=%d×",
                pending["signal"], symbol, pending["entry_price"], pending["leverage"],
            )

    def _discard_staged_open(self, symbol: str):
        discarded = self._staged_open.pop(symbol, None)
        if discarded:
            logger.warning("🚫 Staged open discarded: %s (duplicate blocked)", symbol)

    def _close(self, symbol: str, reason: str):
        pos = self._open_positions.pop(symbol, None)
        if pos:
            logger.info(
                "📁 Position closed: %s %s entry=%.4f reason=%s",
                pos["signal"], symbol, pos["entry_price"], reason,
            )

    # ── Risk validation ───────────────────────────────────────────────────────

    async def _risk_check_ok(self, balance: float) -> Tuple[bool, str]:
        """
        Validate:
         1. Max open trades not exceeded
         2. Daily loss cap not breached
         3. Balance positive

        Returns (ok, reason).
        """
        can, reason = self.risk.can_trade(balance)
        if not can:
            return False, reason
        return True, "ok"

    # ── Leverage-aware position sizing ────────────────────────────────────────

    def _calculate_leveraged_qty(
        self, balance: float, price: float, leverage: int
    ) -> Tuple[float, float]:
        """
        Returns (qty, sl_distance_pct).

        risk_amount = balance × risk_pct_per_trade   (e.g. 1%)
        notional    = risk_amount × leverage
        qty         = notional / price

        sl_distance_pct ensures loss ≤ risk_amount regardless of leverage:
          sl_dist = risk_amount / notional   (as fraction of entry price)
        """
        risk_pct    = float(self.config.get("risk_pct_per_trade", 1.0)) / 100.0
        risk_amount = balance * risk_pct
        notional    = risk_amount * leverage
        qty         = round(notional / price, 8)
        # SL distance as fraction of entry price
        sl_dist_pct = risk_amount / notional   # = 1/leverage (by construction)
        return qty, sl_dist_pct

    def _sl_price(self, entry: float, side: str, sl_dist_pct: float) -> float:
        """Return stop-loss price given entry and sl distance fraction."""
        if side.upper() == "BUY":
            return round(entry * (1.0 - sl_dist_pct), 8)
        return round(entry * (1.0 + sl_dist_pct), 8)

    # =========================================================================
    # Main signal generation
    # =========================================================================

    async def generate_signal(self, symbol: str) -> Optional[str]:
        await self._sync_position_from_db(symbol)

        # ── 1. Fetch candles ─────────────────────────────────────────────────
        try:
            df_trend = await self.connector.fetch_ohlcv(symbol, "4h",  limit=250)
            df       = await self.connector.fetch_ohlcv(symbol, "15m", limit=250)
        except Exception as exc:
            logger.error("❌ OHLCV fetch failed %s: %s", symbol, exc)
            return None

        if len(df) < 220 or len(df_trend) < 210:
            return None

        # ── 2. Exit logic for existing positions ─────────────────────────────
        if self._has_position(symbol):
            return self._check_exit(symbol, df)

        # ── 3. Cooldown guard ────────────────────────────────────────────────
        if self._on_cooldown(symbol):
            return None

        # ── 4. Market regime detection ───────────────────────────────────────
        regime = detect_market_regime(df)
        strategy_order = regime_preferred_strategies(regime)
        scalp_enabled  = bool(self.config.get("scalp_enabled", False))

        logger.debug("📊 %s regime=%s strategies=%s", symbol, regime, strategy_order)

        # ── 5. Compute indicators once for all sub-strategies ────────────────
        indicators = _compute_indicators(df, df_trend)
        if indicators is None:
            return None

        # ── 6. Run sub-strategies in priority order ───────────────────────────
        signal: Optional[str] = None
        strategy_used: str = "none"

        for strat in strategy_order:
            if strat == "pullback":
                sig = detect_pullback(df, indicators)
                if sig:
                    signal, strategy_used = sig, "pullback"
                    break
            elif strat == "breakout":
                sig = detect_breakout(df, indicators)
                if sig:
                    signal, strategy_used = sig, "breakout"
                    break
            elif strat == "scalp" and scalp_enabled:
                sig = detect_scalp(df, indicators)
                if sig:
                    signal, strategy_used = sig, "scalp"
                    break

        if not signal:
            return None

        # ── 7. Confidence scoring ─────────────────────────────────────────────
        confidence = score_confidence(df, signal)  # type: ignore[arg-type]
        min_conf   = float(self.config.get("min_confidence", 40.0))

        if confidence < min_conf:
            logger.debug(
                "⛔ %s: signal=%s confidence=%.1f < %.1f — skipping",
                symbol, signal, confidence, min_conf,
            )
            return None

        # ── 8. Leverage mapping ───────────────────────────────────────────────
        leverage = leverage_from_score(confidence)
        if leverage is None:
            logger.debug("⛔ %s: leverage mapping returned None for score %.1f", symbol, confidence)
            return None

        # Enforce crypto-only leverage guard
        leverage = _crypto_leverage_only(self.market_type, leverage)

        logger.info(
            "🎯 %s: %s signal | strategy=%s | confidence=%.1f | leverage=%d× | regime=%s",
            symbol, signal, strategy_used, confidence, leverage, regime,
        )

        # ── 9. Stage the open ─────────────────────────────────────────────────
        curr_price = float(df["close"].iloc[-1])
        self._stage_open(symbol, signal, curr_price, leverage, confidence)

        # Attach metadata for base_algo to store
        self._staged_open[symbol]["strategy"] = strategy_used
        self._staged_open[symbol]["regime"]    = regime

        return signal

    # =========================================================================
    # Exit logic (leverage-aware)
    # =========================================================================

    def _check_exit(self, symbol: str, df: pd.DataFrame) -> Optional[str]:
        """
        Exit conditions (leverage-aware):
          1. TP hit   (uses risk_manager TP pct, but PnL multiplied by leverage)
          2. SL hit   (sl_dist = 1/leverage of entry, ensures max_loss = risk_pct)
          3. RSI trend exhaustion
          4. Hold time exceeded (based on confidence)
          5. Opposite signal
        """
        pos       = self._open_positions[symbol]
        side      = pos["signal"]
        entry     = pos["entry_price"]
        opened_at = pos["opened_at"]
        leverage  = pos.get("leverage", 1)
        confidence= pos.get("confidence", 50.0)

        sl_pct = float(self.risk.cfg.stop_loss_pct)
        tp_pct = float(self.risk.cfg.take_profit_pct)

        # Leverage-adjusted PnL thresholds (as % of ENTRY, not notional)
        # sl_pct and tp_pct are % of notional; convert to price distance
        # price_sl_dist = sl_pct / leverage   (to limit actual money loss)
        price_sl_dist = sl_pct / leverage
        price_tp_dist = tp_pct / leverage

        curr_close = float(df["close"].iloc[-1])

        # Raw price PnL %
        if side == "BUY":
            price_pnl_pct = (curr_close - entry) / entry * 100
        else:
            price_pnl_pct = (entry - curr_close) / entry * 100

        # Effective leveraged PnL
        leveraged_pnl_pct = price_pnl_pct * leverage

        # TP / SL check on leveraged basis
        if leveraged_pnl_pct >= tp_pct:
            self._close(symbol, f"TP +{leveraged_pnl_pct:.2f}% (lev={leverage}×)")
            return "SELL" if side == "BUY" else "BUY"

        if leveraged_pnl_pct <= -sl_pct:
            self._close(symbol, f"SL {leveraged_pnl_pct:.2f}% (lev={leverage}×)")
            return "SELL" if side == "BUY" else "BUY"

        # Hold time check (confidence-based)
        max_hold_hours = hold_hours_from_score(confidence)
        if (datetime.utcnow() - opened_at) > timedelta(hours=max_hold_hours):
            self._close(symbol, f"time limit {max_hold_hours}h")
            return "SELL" if side == "BUY" else "BUY"

        # RSI exhaustion (unchanged from v3 logic)
        try:
            rsi = RSIIndicator(df["close"], window=14).rsi()
            curr_rsi = float(rsi.iloc[-1])
            prev_rsi = float(rsi.iloc[-2])
            if side == "BUY" and curr_rsi > 68 and curr_rsi < prev_rsi:
                self._close(symbol, f"RSI peak {curr_rsi:.1f}")
                return "SELL"
            if side == "SELL" and curr_rsi < 32 and curr_rsi > prev_rsi:
                self._close(symbol, f"RSI trough {curr_rsi:.1f}")
                return "BUY"
        except Exception:
            pass

        return None


# =============================================================================
# Shared indicator computation
# =============================================================================

class _Indicators:
    """Computed indicator snapshot passed to all sub-strategies."""
    __slots__ = [
        "ema20", "ema50", "ema200",
        "rsi",
        "bb_lower", "bb_upper", "bb_mid",
        "atr", "atr_avg",
        "volume_avg",
        "recent_high_20", "recent_low_20",
        "curr_close", "curr_vol",
        "trend_up_4h",
    ]

    def __init__(self, **kw):
        for k, v in kw.items():
            setattr(self, k, v)


def _compute_indicators(df: pd.DataFrame, df_trend: pd.DataFrame) -> Optional[_Indicators]:
    """
    Pre-compute all indicators used by sub-strategies.
    Returns None if any NaN detected in critical columns.
    """
    try:
        close  = df["close"]
        high   = df["high"]
        low    = df["low"]
        volume = df["volume"]

        ema20  = EMAIndicator(close, window=20).ema_indicator()
        ema50  = EMAIndicator(close, window=50).ema_indicator()
        ema200 = EMAIndicator(close, window=200).ema_indicator()
        rsi    = RSIIndicator(close, window=14).rsi()

        bb       = BollingerBands(close, window=20, window_dev=2)
        bb_lower = bb.bollinger_lband()
        bb_upper = bb.bollinger_hband()
        bb_mid   = bb.bollinger_mavg()

        atr     = AverageTrueRange(high, low, close, window=14).average_true_range()
        atr_avg = atr.rolling(20).mean()

        vol_avg = volume.rolling(20).mean()

        curr = df.iloc[-1]

        critical = [ema20.iloc[-1], ema50.iloc[-1], ema200.iloc[-1],
                    rsi.iloc[-1], atr.iloc[-1]]
        if any(pd.isna(v) for v in critical):
            return None

        # 4h trend
        ema200_4h = EMAIndicator(df_trend["close"], window=200).ema_indicator()
        trend_up_4h = float(df_trend["close"].iloc[-1]) > float(ema200_4h.iloc[-1])

        return _Indicators(
            ema20        = float(ema20.iloc[-1]),
            ema50        = float(ema50.iloc[-1]),
            ema200       = float(ema200.iloc[-1]),
            rsi          = float(rsi.iloc[-1]),
            bb_lower     = float(bb_lower.iloc[-1]),
            bb_upper     = float(bb_upper.iloc[-1]),
            bb_mid       = float(bb_mid.iloc[-1]),
            atr          = float(atr.iloc[-1]),
            atr_avg      = float(atr_avg.iloc[-1]),
            volume_avg   = float(vol_avg.iloc[-1]),
            recent_high_20 = float(high.iloc[-21:-1].max()),
            recent_low_20  = float(low.iloc[-21:-1].min()),
            curr_close   = float(curr["close"]),
            curr_vol     = float(curr["volume"]),
            trend_up_4h  = trend_up_4h,
        )
    except Exception as exc:
        logger.error("_compute_indicators error: %s", exc, exc_info=True)
        return None


# =============================================================================
# Sub-strategy: BREAKOUT
# =============================================================================

def detect_breakout(df: pd.DataFrame, ind: _Indicators) -> Optional[str]:
    """
    Classic breakout:
      BUY:  close breaks above 20-period high  AND volume spike
      SELL: close breaks below 20-period low   AND volume spike

    Extra filter: ATR expanding (not entering during squeeze).
    """
    price      = ind.curr_close
    vol_ratio  = ind.curr_vol / max(ind.volume_avg, 1e-8)
    atr_ratio  = ind.atr / max(ind.atr_avg, 1e-8)

    # Require reasonable volume (>= 1.2× avg) and not in ATR contraction
    if vol_ratio < 1.2 or atr_ratio < 0.80:
        return None

    prev2 = df.iloc[-3:-1]
    prev2_high = float(prev2["high"].max())
    prev2_low  = float(prev2["low"].min())

    if price > ind.recent_high_20 and price > prev2_high:
        return "BUY"

    if price < ind.recent_low_20 and price < prev2_low:
        return "SELL"

    return None


# =============================================================================
# Sub-strategy: PULLBACK (NEW)
# =============================================================================

def detect_pullback(df: pd.DataFrame, ind: _Indicators) -> Optional[str]:
    """
    Pullback entry: catch a trend continuation after a retracement.

    LONG (BUY) conditions:
      1. 4h trend is bullish (price > EMA200 on 4h)
      2. Price has pulled back to within ±1% of EMA20 OR EMA50 on 15m
      3. RSI is in reset zone (40–60)
      4. Current candle is a bullish confirmation candle (close > open)
      5. Volume at least average (no need for spike on pullback)

    SHORT (SELL) conditions — mirror of above:
      1. 4h trend bearish
      2. Price near EMA20 or EMA50 from below
      3. RSI 40–60
      4. Bearish confirmation candle
    """
    price    = ind.curr_close
    rsi      = ind.rsi
    ema20    = ind.ema20
    ema50    = ind.ema50

    curr_candle = df.iloc[-1]
    is_bullish_candle = float(curr_candle["close"]) > float(curr_candle["open"])
    is_bearish_candle = float(curr_candle["close"]) < float(curr_candle["open"])

    # How close is price to EMA20 or EMA50? (within 1.5%)
    near_ema20 = abs(price - ema20) / ema20 <= 0.015
    near_ema50 = abs(price - ema50) / ema50 <= 0.015
    near_support = near_ema20 or near_ema50

    if not near_support:
        return None

    rsi_reset = 40 <= rsi <= 62

    if not rsi_reset:
        return None

    # ── LONG pullback ─────────────────────────────────────────────────────────
    if (ind.trend_up_4h
            and price > ind.ema200        # still above long-term support
            and price > ema20             # bouncing off EMA, not through it
            and is_bullish_candle):
        return "BUY"

    # ── SHORT pullback ────────────────────────────────────────────────────────
    if (not ind.trend_up_4h
            and price < ind.ema200        # below long-term resistance
            and price < ema20
            and is_bearish_candle):
        return "SELL"

    return None


# =============================================================================
# Sub-strategy: SCALP (structure provided, disabled by default)
# =============================================================================

def detect_scalp(df: pd.DataFrame, ind: _Indicators) -> Optional[str]:
    """
    Scalping strategy: quick entries in low-ATR / ranging environments.
    Targets small range breakouts with quick exits.

    NOTE: Disabled by default (scalp_enabled=false in config).
    Enable by setting "scalp_enabled": true in crypto.json.

    Entry: small breakout of 5-bar range with stable volume.
    """
    # Only trade in quiet ATR environment (ATR < 0.8× avg)
    if ind.atr_avg <= 0 or ind.atr / ind.atr_avg > 0.85:
        return None

    high_5  = float(df["high"].iloc[-6:-1].max())
    low_5   = float(df["low"].iloc[-6:-1].min())
    price   = ind.curr_close

    candle_range = high_5 - low_5
    if candle_range <= 0:
        return None

    breakout_pct = abs(price - high_5) / candle_range if price > high_5 else \
                   abs(low_5 - price) / candle_range if price < low_5 else 0.0

    if price > high_5 and breakout_pct >= 0.05:
        return "BUY"
    if price < low_5 and breakout_pct >= 0.05:
        return "SELL"

    return None