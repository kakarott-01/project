"""
bot-engine/market_regime.py
============================
Market Regime Detection — CRYPTO FOCUSED
-----------------------------------------
Detects whether the market is in a TRENDING or RANGING state.
This directly influences which sub-strategy is preferred:

  TRENDING → Pullback entry + Breakout (momentum continuation)
  RANGING  → Range breakout + (optionally) Scalping

Usage:
    from market_regime import detect_market_regime, MarketRegime

    regime = detect_market_regime(df)
    # regime is "TRENDING" or "RANGING"
"""

from __future__ import annotations

import logging
from typing import Literal

import numpy as np
import pandas as pd
from ta.trend import EMAIndicator
from ta.volatility import AverageTrueRange

logger = logging.getLogger(__name__)

MarketRegime = Literal["TRENDING", "RANGING"]


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def detect_market_regime(df: pd.DataFrame) -> MarketRegime:
    """
    Analyse the DataFrame and return the market regime.

    Requires at least 210 rows for reliable EMA200.
    Falls back to "RANGING" if data is insufficient.

    Trending criteria (ALL must hold):
      1. EMA50 separated from EMA200 by >= 0.5% (not flat)
      2. Price is consistently on one side of EMA50 (last 10 bars)
      3. ATR is expanding or at least not contracting

    Ranging criteria (default if trending criteria fail):
      - EMA50 ≈ EMA200 (within 0.5%)
      - Price oscillates above/below EMA50
      - ATR relatively low/flat
    """
    if len(df) < 211:
        logger.debug("market_regime: insufficient data (%d rows), defaulting RANGING", len(df))
        return "RANGING"

    # FIX C-1: Drop forming candle before regime detection
    df_closed = df.iloc[:-1]

    try:
        return _evaluate_regime(df_closed)
    except Exception as exc:
        logger.warning("market_regime: error during detection: %s", exc, exc_info=True)
        return "RANGING"


def regime_preferred_strategies(regime: MarketRegime) -> list[str]:
    """
    Return the preferred strategy types for a given regime, in priority order.

    TRENDING → ["pullback", "breakout"]
    RANGING  → ["breakout", "scalp"]   (scalp only if enabled in config)
    """
    if regime == "TRENDING":
        return ["pullback", "breakout"]
    return ["breakout", "scalp"]


# ---------------------------------------------------------------------------
# Internal
# ---------------------------------------------------------------------------

def _evaluate_regime(df: pd.DataFrame) -> MarketRegime:
    close = df["close"]
    high  = df["high"]
    low   = df["low"]

    ema50  = EMAIndicator(close, window=50).ema_indicator()
    ema200 = EMAIndicator(close, window=200).ema_indicator()
    atr    = AverageTrueRange(high, low, close, window=14).average_true_range()

    curr_ema50  = float(ema50.iloc[-1])
    curr_ema200 = float(ema200.iloc[-1])
    curr_close  = float(close.iloc[-1])
    curr_atr    = float(atr.iloc[-1])
    avg_atr     = float(atr.rolling(20).mean().iloc[-1])
    if curr_ema50 <= 0 or curr_ema200 <= 0 or curr_close <= 0 or curr_atr < 0:
        raise ValueError("Invalid denominator input for market regime detection")

    # ── Criterion 1: EMA separation ─────────────────────────────────────────
    ema_separation_pct = abs(curr_ema50 - curr_ema200) / curr_ema200 * 100
    ema_separated = ema_separation_pct >= 0.5

    # ── Criterion 2: Price consistency on one side of EMA50 ─────────────────
    recent_close = close.iloc[-10:]
    above_ema50  = (recent_close > ema50.iloc[-10:]).sum()
    below_ema50  = (recent_close < ema50.iloc[-10:]).sum()
    consistent_side = above_ema50 >= 7 or below_ema50 >= 7

    # ── Criterion 3: ATR expansion ───────────────────────────────────────────
    if avg_atr > 0:
        atr_ratio = curr_atr / avg_atr
    else:
        atr_ratio = 1.0
    atr_not_contracting = atr_ratio >= 0.80

    # ── Regime decision ──────────────────────────────────────────────────────
    if ema_separated and consistent_side and atr_not_contracting:
        regime = "TRENDING"
    else:
        regime = "RANGING"

    logger.debug(
        "market_regime: %s  ema_sep=%.2f%%  consistent=%s  atr_ratio=%.2f",
        regime, ema_separation_pct, consistent_side, atr_ratio,
    )
    return regime
