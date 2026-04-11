# UpBot

UpBot is a full-stack trading operations platform with a Next.js control panel and a Python execution engine. It is built for running, monitoring, and analyzing automated strategies across multiple market groups from one dashboard.

The app combines:

- A web control plane for auth, strategy configuration, exchange management, risk controls, backtests, and reporting
- A FastAPI bot engine for market execution, scheduling, watchdog recovery, and backtest runs
- A Postgres data layer for users, sessions, trades, strategies, risk settings, and bot history
 
## What It Does

- Runs bots across `indian`, `crypto`, `commodities`, and `global` market groups
- Supports per-market strategy configuration with `SAFE` and `AGGRESSIVE` execution modes
- Tracks bot status, active markets, recent trades, cumulative P&L, and daily P&L
- Stores encrypted exchange credentials and protects key reveal with OTP verification
- Provides backtests with equity curves, trade summaries, and deploy-ready strategy comparisons
- Applies global risk controls such as max position sizing, max daily loss, cooldowns, and kill switch behavior

## Stack

- Frontend and API: Next.js 14, React, TypeScript, Tailwind, React Query
- Database: Postgres with Drizzle ORM
- Bot engine: FastAPI, CCXT, pandas, APScheduler
- Auth and security: NextAuth, email OTP flows, encrypted secrets, signed cookies
- Caching and OTP state: Upstash Redis

## Project Layout

```text
app/               Next.js pages and API routes
components/        Dashboard and UI components
lib/               Auth, DB, encryption, bot orchestration, strategy services
bot-engine/        Python execution engine, scheduler, exchange connector, algorithms
drizzle/           SQL migrations
```
 
## Local Setup

Setup steps, env vars, and run commands are in [setup.md](./setup.md).

Typical local workflow:

```bash
npm install
python3 -m venv .venv
source .venv/bin/activate
pip install -r bot-engine/requirements.txt
npm run db:migrate
npm run dev
cd bot-engine && uvicorn main:app --reload --port 8000
```

## Extra Docs

- [setup.md](./setup.md): local environment, env vars, database setup, and run commands
- [PUBLIC_FEATURES.md](./PUBLIC_FEATURES.md): public-facing feature overview for product, demo, or launch use

## Notes

- The bot engine and Next.js app share critical env values such as `DATABASE_URL`, `BOT_ENGINE_URL`, `BOT_ENGINE_SECRET`, and `ENCRYPTION_KEY`.
- Exchange credentials are encrypted before storage.
- The engine includes health checks, startup cleanup, watchdog recovery, and bot auto-restart behavior.
