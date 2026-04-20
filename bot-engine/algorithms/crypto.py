"""
bot-engine/algorithms/crypto.py — v6
======================================
Three battle-tested strategies, ATR-based SL/TP, trailing stop.

Strategies:
  1. EMA_TREND     — 4h trend + 15m pullback to EMA20 (primary)
  2. BREAKOUT      — Donchian 20-period + volume spike (secondary)
  3. MEAN_REVERT   — Bollinger + RSI extremes (ranging markets only)

Key design:
  • No time-limit exits — price action decides everything.
  • SL = min(2×ATR, hard_limit_sl_pct from Bot Settings)   — tighter wins.
  • TP = max(4×ATR, hard_limit_tp_pct from Bot Settings)   — wider wins.
  • Trailing stop activates once position is profitable; controlled by
    the "Trailing Stop" toggle in Bot Settings.
  • risk_pct_per_trade (5.0) drives sizing — matches Bot Settings slider.
  • Confidence engine still selects leverage tier (3/5/7/10×).
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Dict, Optional, Tuple

import pandas as pd
from ta.momentum import RSIIndicator
from ta.trend import EMAIndicator
from ta.volatility import AverageTrueRange, BollingerBands

from algorithms.base_algo import BaseAlgo
from confidence_engine import leverage_from_score, score_confidence
from market_regime import detect_market_regime

logger = logging.getLogger(__name__)

ATR_SL_MULT = 2.0   # SL = entry ± 2×ATR (or hard_limit_sl, whichever is tighter)
ATR_TP_MULT = 4.0   # TP = entry ± 4×ATR (or hard_limit_tp, whichever is wider)
ATR_TRAIL   = 1.5   # trailing stop trails by 1.5×ATR behind high-water mark


# ─── Indicator snapshot ───────────────────────────────────────────────────────

class _Ind:
    __slots__ = [
        "close", "high", "low", "volume",
        "ema20", "ema50", "ema200",
        "rsi", "prev_rsi",
        "atr",
        "bb_upper", "bb_lower",
        "dc_high_20", "dc_low_20",
        "vol_avg",
        "trend_up_4h",
    ]
    def __init__(self, **kw):
        for k, v in kw.items():
            setattr(self, k, v)


def _compute(df: pd.DataFrame, df_4h: pd.DataFrame) -> Optional[_Ind]:
    try:
        close  = df["close"]
        high   = df["high"]
        low    = df["low"]
        volume = df["volume"]

        ema20  = EMAIndicator(close, window=20).ema_indicator()
        ema50  = EMAIndicator(close, window=50).ema_indicator()
        ema200 = EMAIndicator(close, window=min(200, len(df) - 1)).ema_indicator()
        rsi_s  = RSIIndicator(close, window=14).rsi()
        atr_s  = AverageTrueRange(high, low, close, window=14).average_true_range()
        bb     = BollingerBands(close, window=20, window_dev=2)
        vol_avg = volume.rolling(20).mean()

        dc_high = float(high.iloc[-21:-1].max()) if len(high) > 21 else float(high.max())
        dc_low  = float(low.iloc[-21:-1].min())  if len(low)  > 21 else float(low.min())

        ema200_4h   = EMAIndicator(df_4h["close"], window=min(200, len(df_4h) - 1)).ema_indicator()
        trend_up_4h = float(df_4h["close"].iloc[-1]) > float(ema200_4h.iloc[-1])

        critical = [ema20.iloc[-1], ema50.iloc[-1], rsi_s.iloc[-1], atr_s.iloc[-1]]
        if any(pd.isna(v) for v in critical):
            return None

        curr = df.iloc[-1]
        return _Ind(
            close       = float(curr["close"]),
            high        = float(curr["high"]),
            low         = float(curr["low"]),
            volume      = float(curr["volume"]),
            ema20       = float(ema20.iloc[-1]),
            ema50       = float(ema50.iloc[-1]),
            ema200      = float(ema200.iloc[-1]),
            rsi         = float(rsi_s.iloc[-1]),
            prev_rsi    = float(rsi_s.iloc[-2]),
            atr         = float(atr_s.iloc[-1]),
            bb_upper    = float(bb.bollinger_hband().iloc[-1]),
            bb_lower    = float(bb.bollinger_lband().iloc[-1]),
            dc_high_20  = dc_high,
            dc_low_20   = dc_low,
            vol_avg     = float(vol_avg.iloc[-1]) if not pd.isna(vol_avg.iloc[-1]) else float(volume.mean()),
            trend_up_4h = trend_up_4h,
        )
    except Exception as e:
        logger.warning("_compute error: %s", e)
        return None


# ─── SL/TP calculation ────────────────────────────────────────────────────────

def _atr_levels(entry: float, side: str, atr: float,
                hard_sl_pct: float, hard_tp_pct: float) -> Tuple[float, float]:
    """
    SL = entry ± min(ATR_SL_MULT × atr, hard_sl_pct% of entry)
    TP = entry ± max(ATR_TP_MULT × atr, hard_tp_pct% of entry)
    Tighter SL wins; wider TP wins.
    """
    atr_sl_dist  = atr * ATR_SL_MULT
    atr_tp_dist  = atr * ATR_TP_MULT
    hard_sl_dist = entry * hard_sl_pct / 100.0
    hard_tp_dist = entry * hard_tp_pct / 100.0

    sl_dist = min(atr_sl_dist, hard_sl_dist)   # tighter stop
    tp_dist = max(atr_tp_dist, hard_tp_dist)   # wider target

    if side.upper() == "BUY":
        return round(entry - sl_dist, 8), round(entry + tp_dist, 8)
    return round(entry + sl_dist, 8), round(entry - tp_dist, 8)


# ─── Strategy signals ─────────────────────────────────────────────────────────

def _signal_ema_trend(ind: _Ind) -> Optional[str]:
    """
    EMA Trend Pullback (primary):
      BUY:  4h uptrend (price > EMA200 4h) AND 15m EMA50 > EMA200
            AND price near EMA20 (within 1.2%) AND RSI 40-62 and rising
      SELL: mirror
    """
    near = abs(ind.close - ind.ema20) / ind.ema20 <= 0.012

    if ind.trend_up_4h and ind.ema50 > ind.ema200 and near:
        if 40 <= ind.rsi <= 62 and ind.rsi > ind.prev_rsi and ind.close > ind.ema20:
            return "BUY"

    if not ind.trend_up_4h and ind.ema50 < ind.ema200 and near:
        if 38 <= ind.rsi <= 60 and ind.rsi < ind.prev_rsi and ind.close < ind.ema20:
            return "SELL"

    return None


def _signal_breakout(ind: _Ind) -> Optional[str]:
    """
    Donchian Channel Breakout (secondary):
      BUY:  close > 20-period high with volume > 1.3× average AND 4h uptrend
      SELL: close < 20-period low with volume > 1.3× average AND 4h downtrend
    Volume spike separates genuine breakouts from noise.
    """
    vol_spike = ind.volume > ind.vol_avg * 1.3

    if ind.close > ind.dc_high_20 and vol_spike and ind.trend_up_4h and ind.rsi < 75:
        return "BUY"
    if ind.close < ind.dc_low_20 and vol_spike and not ind.trend_up_4h and ind.rsi > 25:
        return "SELL"

    return None


def _signal_mean_revert(ind: _Ind) -> Optional[str]:
    """
    Bollinger Band + RSI Mean Reversion (tertiary — ranging markets only):
      BUY:  price at/below lower BB AND RSI < 28 AND RSI turning up
      SELL: price at/above upper BB AND RSI > 72 AND RSI turning down
    """
    if ind.close <= ind.bb_lower and ind.rsi < 28 and ind.rsi > ind.prev_rsi:
        return "BUY"
    if ind.close >= ind.bb_upper and ind.rsi > 72 and ind.rsi < ind.prev_rsi:
        return "SELL"
    return None


# ─── CryptoAlgo ───────────────────────────────────────────────────────────────

class CryptoAlgo(BaseAlgo):

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._open_positions: Dict[str, Dict] = {}
        self._db_synced:      set = set()
        self._staged_open:    Dict[str, Dict] = {}
        self._trail_high:     Dict[str, float] = {}
        self._trail_low:      Dict[str, float] = {}

    @property
    def market_type(self) -> str:
        return "crypto"

    def config_filename(self) -> str:
        return "crypto.json"

    def default_config(self) -> Dict:
        return {
            "symbols":                 ["BTC/USDT", "ETH/USDT", "SOL/USDT", "XRP/USDT", "BNB/USDT"],
            "timeframe":               "15m",
            "trend_timeframe":         "4h",
            "signal_cooldown_minutes": 15,
            "risk_pct_per_trade":      5.0,
            "max_open_trades":         5,
            "daily_loss_limit_pct":    10.0,
            "min_confidence":          40.0,
            "strategy_order":          ["EMA_TREND", "BREAKOUT", "MEAN_REVERT"],
        }

    def get_symbols(self) -> list:
        return self.config.get("symbols", ["BTC/USDT", "ETH/USDT", "SOL/USDT"])

    # ── DB sync ──────────────────────────────────────────────────────────────

    async def _sync_position_from_db(self, symbol: str):
        if symbol in self._db_synced:
            return
        self._db_synced.add(symbol)
        try:
            row = await self.db.get_open_trade(self.user_id, symbol, self.market_type)
            if row and symbol not in self._open_positions:
                opened_at = row["opened_at"]
                if hasattr(opened_at, "tzinfo") and opened_at.tzinfo is not None:
                    opened_at = opened_at.astimezone(timezone.utc).replace(tzinfo=None)
                meta = row.get("metadata") or {}
                self._open_positions[symbol] = {
                    "signal":      row["side"].upper(),
                    "entry_price": float(row["entry_price"]),
                    "opened_at":   opened_at,
                    "stop_loss":   float(row["stop_loss"])   if row.get("stop_loss")   else None,
                    "take_profit": float(row["take_profit"]) if row.get("take_profit") else None,
                    "atr":         float(meta.get("atr", 0)) if isinstance(meta, dict) else 0.0,
                    "quantity":    float(row.get("remaining_quantity") or row.get("quantity") or 0),
                    "leverage":    int(meta.get("leverage", 1))    if isinstance(meta, dict) else 1,
                    "confidence":  float(meta.get("confidence", 50)) if isinstance(meta, dict) else 50.0,
                    "strategy":    meta.get("strategy", "EMA_TREND") if isinstance(meta, dict) else "EMA_TREND",
                    "liquidation_price": (
                        float(meta.get("liquidation_price"))
                        if isinstance(meta, dict) and meta.get("liquidation_price") not in (None, "")
                        else None
                    ),
                }
                ep = float(row["entry_price"])
                if row["side"].upper() == "BUY":
                    self._trail_high[symbol] = ep
                else:
                    self._trail_low[symbol] = ep
                logger.info("🔄 Restored Crypto: %s %s @ %.4f lev=%d×",
                            row["side"].upper(), symbol, ep,
                            self._open_positions[symbol]["leverage"])
        except Exception as e:
            logger.error("❌ DB sync %s: %s", symbol, e, exc_info=True)

    # ── Position helpers ─────────────────────────────────────────────────────

    def _has_position(self, symbol: str) -> bool:
        return symbol in self._open_positions

    def _stage_open(self, symbol: str, signal: str, price: float,
                    leverage: int, confidence: float, atr: float, strategy: str):
        sl, tp = _atr_levels(
            price, signal, atr,
            float(self.risk.cfg.stop_loss_pct),
            float(self.risk.cfg.take_profit_pct),
        )
        self._staged_open[symbol] = {
            "signal":      signal,
            "entry_price": price,
            "opened_at":   datetime.utcnow(),
            "stop_loss":   sl,
            "take_profit": tp,
            "atr":         atr,
            "leverage":    leverage,
            "confidence":  confidence,
            "strategy":    strategy,
        }
        logger.info("📋 STAGE %s: %s @ %.4f | SL=%.4f TP=%.4f | lev=%d× conf=%.1f [%s]",
                    symbol, signal, price, sl, tp, leverage, confidence, strategy)

    def _confirm_staged_open(self, symbol: str):
        pending = self._staged_open.pop(symbol, None)
        if pending:
            self._open_positions[symbol] = pending
            ep = pending["entry_price"]
            if pending["signal"] == "BUY":
                self._trail_high[symbol] = ep
            else:
                self._trail_low[symbol] = ep
            logger.info("📂 Confirmed: %s %s @ %.4f", pending["signal"], symbol, ep)

    def _discard_staged_open(self, symbol: str):
        discarded = self._staged_open.pop(symbol, None)
        if discarded:
            logger.warning("🚫 Discarded staged open: %s", symbol)

    def _close(self, symbol: str, reason: str):
        pos = self._open_positions.pop(symbol, None)
        self._trail_high.pop(symbol, None)
        self._trail_low.pop(symbol, None)
        if pos:
            logger.info("📁 Closed %s %s entry=%.4f reason=%s",
                        pos["signal"], symbol, pos["entry_price"], reason)

    # ── Main signal ───────────────────────────────────────────────────────────

    async def generate_signal(self, symbol: str) -> Optional[str]:
        await self._sync_position_from_db(symbol)

        try:
            df_4h = await self.connector.fetch_ohlcv_cached(symbol, "4h",  limit=250)
            df    = await self.connector.fetch_ohlcv_cached(symbol, "15m", limit=250)
        except Exception as e:
            logger.error("❌ OHLCV %s: %s", symbol, e)
            return None

        if len(df) < 60 or len(df_4h) < 50:
            return None

        ind = _compute(df, df_4h)
        if ind is None:
            return None

        if self._has_position(symbol):
            return self._check_exit(symbol, ind)

        regime = detect_market_regime(df) if len(df) >= 210 else "RANGING"

        strategy_order = self.config.get("strategy_order", ["EMA_TREND", "BREAKOUT", "MEAN_REVERT"])
        signal   = None
        strategy = None

        for strat in strategy_order:
            if strat == "EMA_TREND":
                sig = _signal_ema_trend(ind)
            elif strat == "BREAKOUT":
                sig = _signal_breakout(ind)
            elif strat == "MEAN_REVERT":
                sig = _signal_mean_revert(ind) if regime == "RANGING" else None
            else:
                continue
            if sig:
                signal, strategy = sig, strat
                break

        if not signal:
            return None

        confidence = score_confidence(df, signal)
        min_conf   = float(self.config.get("min_confidence", 40.0))
        if confidence < min_conf:
            logger.debug("⛔ %s: conf=%.1f < %.1f [%s]", symbol, confidence, min_conf, strategy)
            return None

        leverage = leverage_from_score(confidence)
        if leverage is None:
            return None

        price = ind.close
        self._stage_open(symbol, signal, price, leverage, confidence, ind.atr, strategy)
        self._staged_open[symbol]["regime"] = regime

        logger.info("🎯 %s: %s | %s | conf=%.1f | lev=%d× | regime=%s",
                    symbol, signal, strategy, confidence, leverage, regime)
        return signal

    # ── Exit logic ────────────────────────────────────────────────────────────

    def _check_exit(self, symbol: str, ind: _Ind) -> Optional[str]:
        pos   = self._open_positions[symbol]
        side  = pos["signal"]
        entry = pos["entry_price"]
        sl    = pos.get("stop_loss")
        tp    = pos.get("take_profit")
        atr   = max(pos.get("atr", ind.atr), ind.atr)

        price = ind.close
        high  = ind.high
        low   = ind.low

        # 1. Hard stop loss
        if sl is not None:
            if side == "BUY"  and low  <= sl:
                self._set_exit_price_override(symbol, sl)
                self._close(symbol, f"STOP_LOSS @ {sl:.4f}")
                return "SELL"
            if side == "SELL" and high >= sl:
                self._set_exit_price_override(symbol, sl)
                self._close(symbol, f"STOP_LOSS @ {sl:.4f}")
                return "BUY"

        # 2. Take profit
        if tp and tp > 0:
            if side == "BUY"  and high >= tp:
                self._set_exit_price_override(symbol, tp)
                self._close(symbol, f"TAKE_PROFIT @ {tp:.4f}")
                return "SELL"
            if side == "SELL" and low  <= tp:
                self._set_exit_price_override(symbol, tp)
                self._close(symbol, f"TAKE_PROFIT @ {tp:.4f}")
                return "BUY"

        # 3. Trailing stop (only if enabled in Bot Settings)
        if self.risk.cfg.trailing_stop and atr > 0:
            if side == "BUY":
                new_high = max(self._trail_high.get(symbol, entry), high)
                self._trail_high[symbol] = new_high
                trail = new_high - atr * ATR_TRAIL
                if trail > entry and price < trail:   # only trail once in profit
                    self._set_exit_price_override(symbol, trail)
                    self._close(symbol, f"TRAIL_STOP @ {trail:.4f} (peak={new_high:.4f})")
                    return "SELL"
            else:
                new_low = min(self._trail_low.get(symbol, entry), low)
                self._trail_low[symbol] = new_low
                trail = new_low + atr * ATR_TRAIL
                if trail < entry and price > trail:
                    self._set_exit_price_override(symbol, trail)
                    self._close(symbol, f"TRAIL_STOP @ {trail:.4f} (trough={new_low:.4f})")
                    return "BUY"

        # 4. EMA trend invalidation (EMA50 flips against position + RSI confirms)
        if side == "BUY"  and price < ind.ema50 and ind.rsi < 40:
            self._close(symbol, f"EMA_INVALID rsi={ind.rsi:.1f}")
            return "SELL"
        if side == "SELL" and price > ind.ema50 and ind.rsi > 60:
            self._close(symbol, f"EMA_INVALID rsi={ind.rsi:.1f}")
            return "BUY"

        # 5. RSI exhaustion
        if side == "BUY"  and ind.rsi > 75 and ind.rsi < ind.prev_rsi:
            self._close(symbol, f"RSI_PEAK {ind.rsi:.1f}")
            return "SELL"
        if side == "SELL" and ind.rsi < 25 and ind.rsi > ind.prev_rsi:
            self._close(symbol, f"RSI_TROUGH {ind.rsi:.1f}")
            return "BUY"

        return None