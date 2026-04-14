-- 0016_restore_audit_tables.sql
-- Restore audit/performance tables used by bot-engine/db.py.

DO $$
BEGIN
  CREATE TYPE risk_event_severity AS ENUM ('info', 'warning', 'critical');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS blocked_trades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  market_type market_type NOT NULL,
  symbol varchar(50) NOT NULL,
  side trade_side NOT NULL,
  strategy_key varchar(100),
  position_scope_key varchar(160),
  reason_code varchar(80) NOT NULL,
  reason_message text NOT NULL,
  details jsonb,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS blocked_trades_user_idx
ON blocked_trades(user_id, created_at);

CREATE INDEX IF NOT EXISTS blocked_trades_strategy_idx
ON blocked_trades(user_id, strategy_key, created_at);

CREATE TABLE IF NOT EXISTS risk_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  market_type market_type,
  symbol varchar(50),
  strategy_key varchar(100),
  event_type varchar(80) NOT NULL,
  severity risk_event_severity NOT NULL DEFAULT 'warning',
  message text NOT NULL,
  payload jsonb,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS risk_events_user_idx
ON risk_events(user_id, created_at);

CREATE INDEX IF NOT EXISTS risk_events_type_idx
ON risk_events(user_id, event_type, created_at);

CREATE TABLE IF NOT EXISTS strategy_performance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  market_type market_type NOT NULL,
  strategy_id uuid REFERENCES strategies(id) ON DELETE SET NULL,
  strategy_key varchar(100) NOT NULL,
  total_trades integer NOT NULL DEFAULT 0,
  winning_trades integer NOT NULL DEFAULT 0,
  losing_trades integer NOT NULL DEFAULT 0,
  loss_streak integer NOT NULL DEFAULT 0,
  best_equity numeric(20,8) NOT NULL DEFAULT 0,
  open_positions integer NOT NULL DEFAULT 0,
  realized_pnl numeric(20,8) NOT NULL DEFAULT 0,
  unrealized_pnl numeric(20,8) NOT NULL DEFAULT 0,
  max_drawdown_pct numeric(8,4) NOT NULL DEFAULT 0,
  last_backtest_return_pct numeric(10,4),
  last_trade_at timestamp,
  last_health_status varchar(30) NOT NULL DEFAULT 'healthy',
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS strategy_performance_user_market_strategy_uq
ON strategy_performance(user_id, market_type, strategy_key);

-- Rollback helpers (uncomment during manual rollback windows):
-- DROP TABLE IF EXISTS strategy_performance;
-- DROP TABLE IF EXISTS risk_events;
-- DROP TABLE IF EXISTS blocked_trades;
