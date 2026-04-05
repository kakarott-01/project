from decimal import Decimal, ROUND_HALF_UP
from typing import Tuple


def _quantize(value: float) -> float:
    return float(
        Decimal(str(value)).quantize(Decimal("0.00000001"), rounding=ROUND_HALF_UP)
    )


def calculate_fees(
    entry_price: float,
    exit_price: float,
    quantity: float,
    fee_rate: float = 0.001,
) -> float:
    entry_value = entry_price * quantity
    exit_value = exit_price * quantity
    return _quantize((entry_value + exit_value) * fee_rate)


def calculate_net_pnl(
    gross_pnl: float,
    entry_price: float,
    exit_price: float,
    quantity: float,
    fee_rate: float = 0.001,
) -> Tuple[float, float]:
    fees = calculate_fees(entry_price, exit_price, quantity, fee_rate)
    return _quantize(gross_pnl - fees), fees
