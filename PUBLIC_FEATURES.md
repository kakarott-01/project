# AlgoBot Features

AlgoBot is designed as a real-world trading operations layer, not just a charting toy. It gives traders and operators one place to configure strategies, manage exchange connections, control risk, and monitor live performance.

## Multi-Market Trading Control

- Operates across Indian markets, crypto, commodities, and global market workflows
- Lets users manage market-specific behavior instead of forcing one universal configuration
- Tracks active bot sessions and market-level status in a single dashboard

## Strategy Engine With Guardrails

- Supports sealed strategy selection per market
- Offers `SAFE` and `AGGRESSIVE` execution modes
- Supports position behavior such as net and hedge-aware configurations
- Includes conflict warnings and market-specific startup checks before the bot runs

## Backtesting Before Deployment

- Run historical backtests from the web dashboard
- Review equity curves, trade summaries, win rate, drawdown, Sharpe ratio, and profit factor
- Compare strategy combinations before pushing them into live or paper execution

## Risk Management Built In

- Global hard limits for position size, daily loss, open trades, and cooldown windows
- Kill switch support for emergency stop behavior
- Risk settings are separated from strategy settings so capital controls stay clear and enforceable
- Startup and stop flows check for open trades, drawdown constraints, and protected state transitions

## Operations Dashboard

- Live bot status with active markets and open trade counts
- Cumulative P&L and daily P&L reporting
- Recent trade history and session history views
- Market, mode, and performance filters for day-to-day monitoring

## Credential Security

- Exchange API credentials are encrypted before being stored
- Sensitive key reveal is OTP-protected
- Email OTP flows are rate-limited
- The product encourages safer exchange permissions and operational hygiene

## Resilience and Reliability

- Dedicated Python execution engine for scheduling and market tasks
- Health endpoint, watchdog loop, and startup cleanup behavior
- Auto-restart support for previously running bots after engine recovery
- Shared control-plane and execution-plane design for cleaner operations

## Ideal Use Cases

- Retail algo trading dashboards
- Small prop-style internal tooling
- Broker and exchange automation consoles
- Paper-to-live workflow products that need risk controls and auditability

## Positioning

AlgoBot fits best as a control tower for automated trading:

- Configure strategies
- Connect exchanges
- Backtest setups
- Enforce risk controls
- Run and monitor bots from one place

It is especially strong for teams or solo operators who want an app-layer product around execution, not just standalone trading scripts.
