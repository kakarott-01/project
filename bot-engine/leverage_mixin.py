"""
bot-engine/leverage_mixin.py
==============================
Provides leverage-aware position sizing and execution hooks
that CryptoAlgo (and any future leveraged algo) can use.

This is intentionally a mixin (not a subclass of BaseAlgo) so it can
be composed freely without breaking the existing class hierarchy.

Usage in CryptoAlgo._execute_live_trade:
    # Pull leverage from staged open
    leverage = self._staged_open.get(symbol, {}).get("leverage", 1)

    # Use this mixin's sizing helper
    qty, sl_dist_pct = self.calc_leveraged_position(balance, price, leverage)

    # Then call setup + place order
    await self.connector.setup_futures_position(symbol, leverage)
    order = await self.connector.place_order(symbol, signal, qty)
"""

from __future__ import annotations

import logging
from typing import Tuple

logger = logging.getLogger(__name__)


class LeverageMixin:
    """
    Mixin providing leverage-aware sizing and SL calculation.

    Expects self.risk.cfg.stop_loss_pct to be available (from RiskManager).
    Expects self.config to have "risk_pct_per_trade" (default 1.0).
    """

    def calc_leveraged_position(
        self,
        balance: float,
        price: float,
        leverage: int,
        risk_pct_override: float = None,
    ) -> Tuple[float, float]:
        """
        Calculate leveraged position size and SL distance.

        Formula:
          risk_amount = balance × risk_pct_per_trade / 100
          notional    = risk_amount × leverage
          qty         = notional / price

          sl_dist_pct = risk_amount / notional
                      = 1 / leverage   (as fraction of entry price)

        This ensures that regardless of leverage used, the monetary
        loss if SL is hit = risk_amount = constant 1% of balance.

        Returns:
          (qty, sl_distance_as_fraction_of_entry)
        """
        if risk_pct_override is not None:
            risk_pct = risk_pct_override / 100.0
        else:
            risk_pct = float(getattr(self, "config", {}).get("risk_pct_per_trade", 1.0)) / 100.0

        risk_amount = balance * risk_pct
        notional    = risk_amount * leverage
        qty         = round(notional / max(price, 1e-10), 8)
        sl_dist_pct = risk_amount / max(notional, 1e-10)  # = 1/leverage

        logger.debug(
            "LeverageMixin: balance=%.2f risk_pct=%.3f risk_amount=%.4f "
            "leverage=%d× notional=%.4f qty=%.8f sl_dist_pct=%.6f",
            balance, risk_pct, risk_amount, leverage, notional, qty, sl_dist_pct,
        )
        return qty, sl_dist_pct

    def calc_sl_price(self, entry: float, side: str, sl_dist_fraction: float) -> float:
        """
        Calculate SL price from entry and SL distance fraction.

        sl_dist_fraction: e.g. 0.10 for 10% away (= 1/leverage for 10× leverage)
        """
        if side.upper() == "BUY":
            return round(entry * (1.0 - sl_dist_fraction), 8)
        return round(entry * (1.0 + sl_dist_fraction), 8)

    def calc_tp_price(self, entry: float, side: str, tp_dist_fraction: float) -> float:
        """
        Calculate TP price from entry and TP distance fraction.
        """
        if side.upper() == "BUY":
            return round(entry * (1.0 + tp_dist_fraction), 8)
        return round(entry * (1.0 - tp_dist_fraction), 8)

    def paper_pnl_with_leverage(
        self,
        entry: float,
        exit_price: float,
        quantity: float,
        side: str,
        leverage: int,
        fee_rate: float = 0.001,
    ) -> Tuple[float, float]:
        """
        Simulate PnL for a paper trade with leverage.

        Gross PnL = (exit - entry) × qty × leverage   (for BUY)
                   (entry - exit) × qty × leverage   (for SELL)

        Fee is applied to the total notional value of both legs:
          fee = (entry_notional + exit_notional) × fee_rate

        Returns:
          (net_pnl, fee_amount)
        """
        if side.upper() == "BUY":
            gross_pnl = (exit_price - entry) * quantity * leverage
        else:
            gross_pnl = (entry - exit_price) * quantity * leverage

        entry_notional = entry * quantity * leverage
        exit_notional  = exit_price * quantity * leverage
        fee_amount     = (entry_notional + exit_notional) * fee_rate
        net_pnl        = gross_pnl - fee_amount

        return round(net_pnl, 8), round(fee_amount, 8)