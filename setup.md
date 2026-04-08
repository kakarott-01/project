# Setup Guide

This project has two services:

1. A Next.js app in the repo root
2. A FastAPI bot engine in `bot-engine/`

Both services need access to the same database and shared secrets.

## Prerequisites

- Node.js 18+ and `npm`
- Python 3.11
- Postgres database
- Upstash Redis account
- SMTP credentials for OTP email delivery
- Optional: Google OAuth credentials for Google sign-in

`bot-engine/runtime.txt` pins Python to `3.11.9`.

## 1. Install Dependencies

From the repo root:

```bash
npm install
python3 -m venv .venv
source .venv/bin/activate
pip install -r bot-engine/requirements.txt
```

## 2. Create Environment Files

Create `.env.local` in the repo root for the Next.js app.

```env
DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/DB_NAME

NEXTAUTH_SECRET=replace-with-a-long-random-secret
ENCRYPTION_KEY=replace-with-a-long-random-secret
SIGNUP_JWT_SECRET=replace-with-a-long-random-secret

BOT_ENGINE_URL=http://127.0.0.1:8000
BOT_ENGINE_SECRET=replace-with-a-shared-engine-secret
NEXT_PUBLIC_APP_URL=http://127.0.0.1:3000

UPSTASH_REDIS_REST_URL=https://YOUR-UPSTASH-URL
UPSTASH_REDIS_REST_TOKEN=YOUR-UPSTASH-TOKEN

EMAIL_SERVER_HOST=smtp.example.com
EMAIL_SERVER_PORT=587
EMAIL_SERVER_USER=your-user
EMAIL_SERVER_PASSWORD=your-password
EMAIL_FROM=AlgoBot <noreply@example.com>

GOOGLE_CLIENT_ID=optional-google-client-id
GOOGLE_CLIENT_SECRET=optional-google-client-secret
```

Important:

- The Python engine uses `load_dotenv()` with standard `.env` loading behavior, not `.env.local`.
- Easiest local approach: copy the same shared values into `bot-engine/.env`, or export them in your shell before starting the engine.

Minimal `bot-engine/.env`:

```env
DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/DB_NAME
ENCRYPTION_KEY=replace-with-a-long-random-secret
BOT_ENGINE_SECRET=replace-with-a-shared-engine-secret
BOT_ENGINE_URL=http://127.0.0.1:8000
NEXT_PUBLIC_APP_URL=http://127.0.0.1:3000
```

## 3. Run Database Migrations

From the repo root:

```bash
npm run db:migrate
```

If you are bootstrapping a brand new database and want schema sync directly from Drizzle, this repo also includes:

```bash
npm run db:push
```

## 4. Start the App

Terminal 1, from the repo root:

```bash
npm run dev
```

Terminal 2, from the repo root:

```bash
source .venv/bin/activate
cd bot-engine
uvicorn main:app --reload --port 8000
```

Local URLs:

- App: `http://127.0.0.1:3000`
- Engine health: `http://127.0.0.1:8000/health`

## 5. First-Run Checklist

- Confirm the app loads and redirects to `/login`
- Confirm the engine health endpoint returns `status: ok`
- Confirm Postgres is reachable from both services
- Confirm Redis is working for OTP storage and rate limits
- Confirm SMTP is working so login and reveal OTP emails can be sent

## 6. Functional Setup After Boot

- Create or use an account that can access the dashboard
- Add exchange credentials from the Markets page
- Configure per-market strategies in Strategy Engine
- Set global risk controls in Settings
- Run a backtest before enabling live execution

## Common Issues

### `DATABASE_URL is not set`

The Next.js app reads `.env.local`. The Python engine does not. Add the shared variables to `bot-engine/.env` or export them before starting the engine.

### OTP email fails

Check:

- `EMAIL_SERVER_HOST`
- `EMAIL_SERVER_PORT`
- `EMAIL_SERVER_USER`
- `EMAIL_SERVER_PASSWORD`
- `EMAIL_FROM`

### Redis errors during login or reveal flows

Check:

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

### Bot start says engine is unreachable

Check:

- The FastAPI engine is running on the same URL as `BOT_ENGINE_URL`
- `BOT_ENGINE_SECRET` matches in both services

### Exchange key reveal does not work

Reveal flow depends on:

- Logged-in session
- Redis OTP storage
- Email delivery
- Matching `ENCRYPTION_KEY`

## Useful Commands

```bash
npm run dev
npm run build
npm run db:migrate
npm run db:push
npm run db:studio
```
