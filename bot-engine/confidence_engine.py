"""
bot-engine/confidence_engine.py
================================
Confidence Scoring Engine — CRYPTO ONLY
----------------------------------------
Produces a 0–100 confidence score for a given trade signal based on
multiple technical factors.  Higher confidence → higher leverage.

Factors and weights:
  Trend strength   (EMA200 direction + price distance)  : 30%
  Volume confirm   (current vs rolling avg)             : 20%
  Breakout strength (price vs recent high/low)          : 15%
  RSI momentum     (zone + direction)                   : 15%
  Volatility (ATR expansion vs 20-period avg)           : 10%
  Market structure  (HH/HL for long, LH/LL for short)  : 10%

Usage:
    from confidence_engine import score_confidence, leverage_from_score

    conf = score_confidence(df, signal="BUY")
    lev  = leverage_from_score(conf)           # 3, 5, 7, 10, or None
"""

from __future__ import annotations

import logging
from typing import Literal, Optional

import numpy as np
import pandas as pd
from ta.momentum import RSIIndicator
from ta.trend import EMAIndicator
from ta.volatility import AverageTrueRange

logger = logging.getLogger(__name__)

Signal = Literal["BUY", "SELL"]


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def score_confidence(df: pd.DataFrame, signal: Signal) -> float:
    """
    Compute confidence score (0–100) for a BUY or SELL signal.

    Requires at least 210 rows (for EMA200 stability).
    Returns 0.0 if the DataFrame is too short.
    """
    if len(df) < 210:
        logger.debug("confidence_engine: too few rows (%d)", len(df))
        return 0.0

    try:
        return _compute_confidence(df, signal)
    except Exception as exc:
        logger.warning("confidence_engine: error computing score: %s", exc, exc_info=True)
        return 0.0


def leverage_from_score(score: float) -> Optional[int]:
    """
    Map confidence score to leverage.

      >= 80  → 10×
      >= 65  →  7×
      >= 50  →  5×
      >= 40  →  3×
       < 40  →  None  (no trade)
    """
    if score >= 80:
        return 10
    if score >= 65:
        return 7
    if score >= 50:
        return 5
    if score >= 40:
        return 3
    return None  # confidence too low — skip trade


def hold_hours_from_score(score: float) -> float:
    """
    Determine max hold time based on confidence.

      HIGH   >= 80  → 12 h
      MEDIUM >= 60  →  6 h
      LOW    >= 40  →  3 h
    """
    if score >= 80:
        return 12.0
    if score >= 60:
        return 6.0
    return 3.0


# ---------------------------------------------------------------------------
# Internal computation
# ---------------------------------------------------------------------------

def _compute_confidence(df: pd.DataFrame, signal: Signal) -> float:
    """
    Returns a float in [0, 100].  Each sub-factor is normalised to [0, 1]
    before weighting.
    """
    weights = {
        "trend":     0.30,
        "volume":    0.20,
        "breakout":  0.15,
        "rsi":       0.15,
        "volatility":0.10,
        "structure": 0.10,
    }

    scores = {
        "trend":      _score_trend(df, signal),
        "volume":     _score_volume(df),
        "breakout":   _score_breakout(df, signal),
        "rsi":        _score_rsi(df, signal),
        "volatility": _score_volatility(df),
        "structure":  _score_structure(df, signal),
    }

    raw = sum(weights[k] * scores[k] for k in weights)
    final = max(0.0, min(100.0, raw * 100.0))

    logger.debug(
        "confidence_engine [%s]: total=%.1f  breakdown=%s",
        signal,
        final,
        {k: f"{v:.2f}" for k, v in scores.items()},
    )
    return final


# ── Factor: Trend strength (30%) ────────────────────────────────────────────

def _score_trend(df: pd.DataFrame, signal: Signal) -> float:
    """
    Score 0–1 based on EMA200 direction and price distance from EMA200.

    For BUY:  price above EMA200 AND close to EMA50 (not too extended)
    For SELL: price below EMA200
    """
    close = df["close"]
    ema200 = EMAIndicator(close, window=200).ema_indicator()
    ema50  = EMAIndicator(close, window=50).ema_indicator()

    curr_price  = float(close.iloc[-1])
    curr_ema200 = float(ema200.iloc[-1])
    curr_ema50  = float(ema50.iloc[-1])

    # Is the overall trend aligned with the signal?
    if signal == "BUY":
        direction_ok = curr_price > curr_ema200 and curr_ema50 > curr_ema200
    else:
        direction_ok = curr_price < curr_ema200 and curr_ema50 < curr_ema200

    if not direction_ok:
        return 0.0

    # Distance from EMA200 as % — ideal window 2–8%
    dist_pct = abs(curr_price - curr_ema200) / curr_ema200 * 100
    if dist_pct < 0.5:
        dist_score = 0.3
    elif dist_pct <= 8.0:
        dist_score = 0.5 + (dist_pct / 8.0) * 0.5
    elif dist_pct <= 15.0:
        dist_score = 1.0 - (dist_pct - 8.0) / 7.0 * 0.5  # fades above 8%
    else:
        dist_score = 0.3  # too extended

    # EMA50 slope (last 5 bars)
    ema50_slope = (float(ema50.iloc[-1]) - float(ema50.iloc[-5])) / float(ema50.iloc[-5]) * 100
    slope_aligned = (signal == "BUY" and ema50_slope > 0) or (signal == "SELL" and ema50_slope < 0)
    slope_bonus = 0.1 if slope_aligned else 0.0

    return min(1.0, dist_score + slope_bonus)


# ── Factor: Volume confirmation (20%) ───────────────────────────────────────

def _score_volume(df: pd.DataFrame) -> float:
    """
    Score based on current volume vs 20-period average.
    Spike: >2× avg → 1.0
    Good:   1.5–2× → 0.7
    OK:     1.1–1.5 → 0.5
    Weak:   <1.1    → 0.2
    """
    vol     = df["volume"]
    vol_avg = vol.rolling(20).mean()

    curr_vol = float(vol.iloc[-1])
    avg_vol  = float(vol_avg.iloc[-1])

    if avg_vol <= 0:
        return 0.2

    ratio = curr_vol / avg_vol
    if ratio >= 2.0:
        return 1.0
    if ratio >= 1.5:
        return 0.7
    if ratio >= 1.1:
        return 0.5
    return 0.2


# ── Factor: Breakout strength (15%) ─────────────────────────────────────────

def _score_breakout(df: pd.DataFrame, signal: Signal) -> float:
    """
    How far has price broken out of the 20-period range?
    """
    close = df["close"]
    high  = df["high"]
    low   = df["low"]

    curr_price   = float(close.iloc[-1])
    recent_high  = float(high.iloc[-21:-1].max())   # 20 bars excluding current
    recent_low   = float(low.iloc[-21:-1].min())
    price_range  = recent_high - recent_low

    if price_range <= 0:
        return 0.2

    if signal == "BUY":
        breakout_dist = curr_price - recent_high
    else:
        breakout_dist = recent_low - curr_price

    if breakout_dist <= 0:
        # Not a breakout candle — partial credit if within range top
        return 0.15

    pct_of_range = breakout_dist / price_range
    if pct_of_range >= 0.20:
        return 1.0
    if pct_of_range >= 0.10:
        return 0.7
    return 0.4


# ── Factor: RSI momentum (15%) ──────────────────────────────────────────────

def _score_rsi(df: pd.DataFrame, signal: Signal) -> float:
    """
    RSI zone scoring.

    BUY:  50–70 is ideal (momentum up, not overbought)
    SELL: 30–50 is ideal (momentum down, not oversold)

    Also reward if RSI is trending in signal direction.
    """
    rsi = RSIIndicator(df["close"], window=14).rsi()
    curr_rsi = float(rsi.iloc[-1])
    prev_rsi = float(rsi.iloc[-2])

    if signal == "BUY":
        if 50 <= curr_rsi <= 65:
            zone_score = 1.0
        elif 65 < curr_rsi <= 72:
            zone_score = 0.7
        elif 40 <= curr_rsi < 50:
            zone_score = 0.5
        elif curr_rsi > 72:
            zone_score = 0.2  # overbought
        else:
            zone_score = 0.1
    else:
        if 35 <= curr_rsi <= 50:
            zone_score = 1.0
        elif 28 <= curr_rsi < 35:
            zone_score = 0.7
        elif 50 < curr_rsi <= 60:
            zone_score = 0.5
        elif curr_rsi < 28:
            zone_score = 0.2  # oversold
        else:
            zone_score = 0.1

    direction_bonus = 0.1 if (signal == "BUY" and curr_rsi > prev_rsi) or \
                              (signal == "SELL" and curr_rsi < prev_rsi) else 0.0
    return min(1.0, zone_score + direction_bonus)


# ── Factor: ATR volatility expansion (10%) ──────────────────────────────────

def _score_volatility(df: pd.DataFrame) -> float:
    """
    Expanding ATR means market is moving — good for momentum trades.
    ATR > 1.2× 20-period avg: excellent
    ATR = 0.8–1.2×: normal
    ATR < 0.8×: quiet/low vol — lower confidence
    """
    atr     = AverageTrueRange(df["high"], df["low"], df["close"], window=14).average_true_range()
    atr_avg = atr.rolling(20).mean()

    curr_atr = float(atr.iloc[-1])
    avg_atr  = float(atr_avg.iloc[-1])

    if avg_atr <= 0:
        return 0.3

    ratio = curr_atr / avg_atr
    if ratio >= 1.5:
        return 1.0
    if ratio >= 1.2:
        return 0.8
    if ratio >= 0.8:
        return 0.5
    return 0.2


# ── Factor: Market structure (10%) ──────────────────────────────────────────

def _score_structure(df: pd.DataFrame, signal: Signal) -> float:
    """
    Look at the last 6 swing candles:
      BUY:  HH + HL pattern (higher highs, higher lows) → 1.0
      SELL: LH + LL pattern → 1.0
    Partial credit for mixed structures.
    """
    # Use 4-bar swing pivots on 15m
    highs = df["high"].values
    lows  = df["low"].values

    # Collect last 4 pivot highs and lows (simplified with rolling max/min)
    window = 5
    pivot_highs = []
    pivot_lows  = []
    for i in range(window, len(highs) - 1, window):
        pivot_highs.append(highs[max(0, i-window):i+1].max())
        pivot_lows.append(lows[max(0, i-window):i+1].min())

    if len(pivot_highs) < 3:
        return 0.5  # not enough data for structure

    # Check last 3 pivots
    ph = pivot_highs[-3:]
    pl = pivot_lows[-3:]

    if signal == "BUY":
        hh = ph[-1] > ph[-2] > ph[-3]  # higher highs
        hl = pl[-1] > pl[-2] > pl[-3]  # higher lows
        if hh and hl:
            return 1.0
        if hh or hl:
            return 0.6
        return 0.2
    else:
        lh = ph[-1] < ph[-2] < ph[-3]  # lower highs
        ll = pl[-1] < pl[-2] < pl[-3]  # lower lows
        if lh and ll:
            return 1.0
        if lh or ll:
            return 0.6
        return 0.2