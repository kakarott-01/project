import math
from dataclasses import dataclass
from typing import Dict, List, Optional

import pandas as pd
from ta.momentum import RSIIndicator
from ta.trend import EMAIndicator
from ta.volatility import BollingerBands


@dataclass
class EngineConfig:
    stop_loss_pct: float = 2.0
    take_profit_pct: float = 4.0
    max_hold_bars: int = 16


def timeframe_to_millis(timeframe: str) -> int:
    unit = timeframe[-1]
    value = int(timeframe[:-1])
    if unit == "m":
        return value * 60 * 1000
    if unit == "h":
        return value * 60 * 60 * 1000
    if unit == "d":
        return value * 24 * 60 * 60 * 1000
    raise ValueError(f"Unsupported timeframe: {timeframe}")


def required_lookback() -> int:
    return 60


def strategy_default_timeframe(strategy_key: str) -> str:
    if strategy_key == "MEAN_REVERSION_PRO":
        return "5m"
    if strategy_key == "BREAKOUT_PULSE_X":
        return "1h"
    return "15m"


class BlackBoxStrategyExecutor:
    def evaluate_strategy(self, df: pd.DataFrame, strategy_key: str) -> Optional[str]:
        return self._evaluate_strategy(df, strategy_key)

    def combine(self, votes: List[Optional[str]], execution_mode: str, required_votes: Optional[int] = None) -> Optional[str]:
        usable = [vote for vote in votes if vote in ("BUY", "SELL")]
        if not usable:
            return None

        if execution_mode == "SAFE":
            threshold = required_votes if required_votes is not None else len(votes)
            first = usable[0]
            return first if len(usable) == threshold and all(v == first for v in usable) else None

        buy_votes = sum(1 for vote in usable if vote == "BUY")
        sell_votes = sum(1 for vote in usable if vote == "SELL")
        if buy_votes and sell_votes:
            return None
        return "BUY" if buy_votes else "SELL"

    def evaluate(self, df: pd.DataFrame, strategy_keys: List[str], execution_mode: str) -> Optional[str]:
        votes = []
        for strategy_key in strategy_keys:
            signal = self._evaluate_strategy(df, strategy_key)
            if signal in ("BUY", "SELL"):
                votes.append(signal)
        return self.combine(votes, execution_mode, required_votes=len(strategy_keys))

    def _evaluate_strategy(self, df: pd.DataFrame, strategy_key: str) -> Optional[str]:
        if len(df) < required_lookback():
            return None

        work = df.copy()
        if strategy_key == "TREND_RIDER_V1":
            work["ema20"] = EMAIndicator(work["close"], window=20).ema_indicator()
            work["ema50"] = EMAIndicator(work["close"], window=50).ema_indicator()
            work["rsi"] = RSIIndicator(work["close"], window=14).rsi()
            current = work.iloc[-1]
            previous = work.iloc[-2]
            if any(pd.isna([current["ema20"], current["ema50"], current["rsi"]])):
                return None
            if current["ema20"] > current["ema50"] and current["rsi"] > 55 and current["close"] > previous["close"]:
                return "BUY"
            if current["ema20"] < current["ema50"] and current["rsi"] < 45 and current["close"] < previous["close"]:
                return "SELL"
            return None

        if strategy_key == "MEAN_REVERSION_PRO":
            bb = BollingerBands(work["close"], window=20, window_dev=2)
            work["bb_low"] = bb.bollinger_lband()
            work["bb_high"] = bb.bollinger_hband()
            work["rsi"] = RSIIndicator(work["close"], window=14).rsi()
            current = work.iloc[-1]
            if any(pd.isna([current["bb_low"], current["bb_high"], current["rsi"]])):
                return None
            if current["close"] <= current["bb_low"] and current["rsi"] < 32:
                return "BUY"
            if current["close"] >= current["bb_high"] and current["rsi"] > 68:
                return "SELL"
            return None

        if strategy_key == "BREAKOUT_PULSE_X":
            work["range_high"] = work["high"].rolling(20).max()
            work["range_low"] = work["low"].rolling(20).min()
            work["volume_avg"] = work["volume"].rolling(20).mean()
            current = work.iloc[-1]
            previous = work.iloc[-2]
            if any(pd.isna([current["range_high"], current["range_low"], current["volume_avg"]])):
                return None
            if current["close"] > previous["range_high"] and current["volume"] > current["volume_avg"] * 1.2:
                return "BUY"
            if current["close"] < previous["range_low"] and current["volume"] > current["volume_avg"] * 1.2:
                return "SELL"
            return None

        raise ValueError(f"Unknown strategy: {strategy_key}")


def _calc_pct(side: str, entry: float, current: float) -> float:
    if side == "SELL":
        return ((entry - current) / entry) * 100
    return ((current - entry) / entry) * 100


def _max_drawdown_from_equity(equity_curve: List[Dict]) -> float:
    peak = 0.0
    max_drawdown = 0.0
    for point in equity_curve:
        value = float(point["equity"])
        peak = max(peak, value)
        if peak > 0:
            drawdown = ((peak - value) / peak) * 100
            max_drawdown = max(max_drawdown, drawdown)
    return max_drawdown


def _sharpe_from_trade_returns(returns: List[float]) -> float:
    if len(returns) < 2:
        return 0.0
    series = pd.Series(returns, dtype=float)
    std = float(series.std(ddof=1) or 0)
    if std == 0:
        return 0.0
    return float((series.mean() / std) * math.sqrt(len(series)))


def _run_single_strategy_backtest(
    df: pd.DataFrame,
    strategy_keys: List[str],
    execution_mode: str,
    initial_capital: float,
    engine_cfg: Optional[EngineConfig] = None,
) -> Dict:
    cfg = engine_cfg or EngineConfig()
    executor = BlackBoxStrategyExecutor()

    if len(df) < required_lookback() + 5:
        raise ValueError("Not enough candles for backtest.")

    equity = float(initial_capital)
    equity_curve: List[Dict] = []
    trades: List[Dict] = []
    position = None

    for idx in range(required_lookback(), len(df)):
        window = df.iloc[: idx + 1]
        ts = window.index[-1]
        close = float(window["close"].iloc[-1])

        if position:
            pnl_pct = _calc_pct(position["side"], position["entry_price"], close)
            hold_bars = idx - position["entry_index"]
            reverse_signal = executor.evaluate(window, strategy_keys, execution_mode)
            should_exit = (
                pnl_pct >= cfg.take_profit_pct
                or pnl_pct <= -cfg.stop_loss_pct
                or hold_bars >= cfg.max_hold_bars
                or (
                    reverse_signal is not None
                    and ((position["side"] == "BUY" and reverse_signal == "SELL") or (position["side"] == "SELL" and reverse_signal == "BUY"))
                )
            )
            if should_exit:
                equity *= (1 + pnl_pct / 100)
                trades.append({
                    "tradeNumber": len(trades) + 1,
                    "tradeType": position["side"],
                    "result": round(pnl_pct, 4),
                    "duration": hold_bars,
                })
                position = None

        if position is None:
            signal = executor.evaluate(window, strategy_keys, execution_mode)
            if signal in ("BUY", "SELL"):
                position = {
                    "side": signal,
                    "entry_price": close,
                    "entry_index": idx,
                    "entry_time": ts,
                }

        equity_curve.append({
            "timestamp": ts.isoformat(),
            "equity": round(equity, 2),
        })

    returns = [float(trade["result"]) for trade in trades]
    wins = [ret for ret in returns if ret > 0]
    losses = [abs(ret) for ret in returns if ret < 0]
    total_return_pct = ((equity - initial_capital) / initial_capital) * 100 if initial_capital else 0.0
    profit_factor = (sum(wins) / sum(losses)) if losses else (sum(wins) if wins else 0.0)

    performance_metrics = {
        "totalReturnPct": round(total_return_pct, 4),
        "winRate": round((len(wins) / len(trades)) * 100, 2) if trades else 0.0,
        "maxDrawdown": round(_max_drawdown_from_equity(equity_curve), 4),
        "sharpeRatio": round(_sharpe_from_trade_returns(returns), 4),
        "profitFactor": round(profit_factor, 4),
    }

    return {
        "performance_metrics": performance_metrics,
        "equity_curve": equity_curve,
        "trade_summary": trades,
    }


def run_backtest(
    df: pd.DataFrame,
    strategy_keys: List[str],
    execution_mode: str,
    initial_capital: float,
    position_mode: str = "NET",
    allow_hedge_opposition: bool = False,
    engine_cfg: Optional[EngineConfig] = None,
) -> Dict:
    if execution_mode == "AGGRESSIVE" and position_mode == "HEDGE" and len(strategy_keys) > 1:
        per_strategy_capital = initial_capital / len(strategy_keys)
        strategy_breakdown: Dict[str, Dict] = {}
        aggregate_curve: List[Dict] = []
        aggregate_trades: List[Dict] = []
        trade_returns: List[float] = []

        for strategy_key in strategy_keys:
            result = _run_single_strategy_backtest(
                df=df,
                strategy_keys=[strategy_key],
                execution_mode="AGGRESSIVE",
                initial_capital=per_strategy_capital,
                engine_cfg=engine_cfg,
            )
            strategy_breakdown[strategy_key] = result["performance_metrics"]

            for index, point in enumerate(result["equity_curve"]):
                if len(aggregate_curve) <= index:
                    aggregate_curve.append({
                        "timestamp": point["timestamp"],
                        "equity": 0.0,
                    })
                aggregate_curve[index]["equity"] = round(
                    float(aggregate_curve[index]["equity"]) + float(point["equity"]), 2
                )

            for trade in result["trade_summary"]:
                aggregate_trades.append({
                    **trade,
                    "strategyKey": strategy_key,
                })
                trade_returns.append(float(trade["result"]))

        aggregate_trades.sort(key=lambda item: item.get("tradeNumber", 0))
        wins = [ret for ret in trade_returns if ret > 0]
        losses = [abs(ret) for ret in trade_returns if ret < 0]
        final_equity = float(aggregate_curve[-1]["equity"]) if aggregate_curve else initial_capital
        total_return_pct = ((final_equity - initial_capital) / initial_capital) * 100 if initial_capital else 0.0
        profit_factor = (sum(wins) / sum(losses)) if losses else (sum(wins) if wins else 0.0)

        performance_metrics = {
            "totalReturnPct": round(total_return_pct, 4),
            "winRate": round((len(wins) / len(aggregate_trades)) * 100, 2) if aggregate_trades else 0.0,
            "maxDrawdown": round(_max_drawdown_from_equity(aggregate_curve), 4),
            "sharpeRatio": round(_sharpe_from_trade_returns(trade_returns), 4),
            "profitFactor": round(profit_factor, 4),
        }

        return {
            "performance_metrics": performance_metrics,
            "equity_curve": aggregate_curve,
            "trade_summary": aggregate_trades,
            "strategy_breakdown": strategy_breakdown,
            "position_mode": position_mode,
            "allow_hedge_opposition": allow_hedge_opposition,
        }

    overall = _run_single_strategy_backtest(
        df=df,
        strategy_keys=strategy_keys,
        execution_mode=execution_mode,
        initial_capital=initial_capital,
        engine_cfg=engine_cfg,
    )
    strategy_breakdown = {
        strategy_key: _run_single_strategy_backtest(
            df=df,
            strategy_keys=[strategy_key],
            execution_mode="AGGRESSIVE",
            initial_capital=initial_capital / max(len(strategy_keys), 1),
            engine_cfg=engine_cfg,
        )["performance_metrics"]
        for strategy_key in strategy_keys
    }
    return {
        **overall,
        "strategy_breakdown": strategy_breakdown,
        "position_mode": position_mode,
        "allow_hedge_opposition": allow_hedge_opposition,
    }
