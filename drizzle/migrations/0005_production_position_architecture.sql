CREATE TYPE "position_mode" AS ENUM ('NET', 'HEDGE');
--> statement-breakpoint
CREATE TYPE "position_direction" AS ENUM ('LONG', 'SHORT');
--> statement-breakpoint
CREATE TYPE "position_lifecycle" AS ENUM ('open', 'closed');
--> statement-breakpoint
ALTER TABLE "market_strategy_configs"
  ADD COLUMN IF NOT EXISTS "position_mode" "position_mode" DEFAULT 'NET' NOT NULL,
  ADD COLUMN IF NOT EXISTS "allow_hedge_opposition" boolean DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS "conflict_blocking" boolean DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS "aggressive_confirmed_at" timestamp,
  ADD COLUMN IF NOT EXISTS "max_positions_per_symbol" integer DEFAULT 2 NOT NULL,
  ADD COLUMN IF NOT EXISTS "max_capital_per_strategy_pct" numeric(6,2) DEFAULT '25.00' NOT NULL,
  ADD COLUMN IF NOT EXISTS "max_drawdown_pct" numeric(6,2) DEFAULT '12.00' NOT NULL,
  ADD COLUMN IF NOT EXISTS "conflict_warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
  ADD COLUMN IF NOT EXISTS "exchange_capabilities" jsonb;
--> statement-breakpoint
ALTER TABLE "backtest_runs"
  ADD COLUMN IF NOT EXISTS "position_mode" "position_mode" DEFAULT 'NET' NOT NULL,
  ADD COLUMN IF NOT EXISTS "allow_hedge_opposition" boolean DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS "strategy_config_id" uuid,
  ADD COLUMN IF NOT EXISTS "strategy_breakdown" jsonb;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "strategy_configs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "market_type" "market_type" NOT NULL,
  "execution_mode" "strategy_execution_mode" NOT NULL,
  "position_mode" "position_mode" DEFAULT 'NET' NOT NULL,
  "allow_hedge_opposition" boolean DEFAULT false NOT NULL,
  "strategy_keys" jsonb NOT NULL,
  "asset" varchar(100),
  "timeframe" varchar(20),
  "initial_capital" numeric(20,2),
  "conflict_warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "exchange_capabilities" jsonb,
  "source" varchar(30) DEFAULT 'manual' NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "strategy_positions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "market_type" "market_type" NOT NULL,
  "symbol" varchar(50) NOT NULL,
  "strategy_id" uuid,
  "strategy_key" varchar(100) NOT NULL,
  "execution_mode" "strategy_execution_mode" NOT NULL,
  "position_mode" "position_mode" DEFAULT 'NET' NOT NULL,
  "direction" "position_direction" NOT NULL,
  "lifecycle" "position_lifecycle" DEFAULT 'open' NOT NULL,
  "size" numeric(20,8) NOT NULL,
  "remaining_size" numeric(20,8) NOT NULL,
  "entry_price" numeric(20,8) NOT NULL,
  "exit_price" numeric(20,8),
  "realized_pnl" numeric(20,8) DEFAULT '0' NOT NULL,
  "unrealized_pnl" numeric(20,8) DEFAULT '0' NOT NULL,
  "max_adverse_excursion" numeric(20,8) DEFAULT '0' NOT NULL,
  "metadata" jsonb,
  "opened_at" timestamp DEFAULT now() NOT NULL,
  "closed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "strategy_performance" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "market_type" "market_type" NOT NULL,
  "strategy_id" uuid,
  "strategy_key" varchar(100) NOT NULL,
  "total_trades" integer DEFAULT 0 NOT NULL,
  "winning_trades" integer DEFAULT 0 NOT NULL,
  "losing_trades" integer DEFAULT 0 NOT NULL,
  "open_positions" integer DEFAULT 0 NOT NULL,
  "realized_pnl" numeric(20,8) DEFAULT '0' NOT NULL,
  "unrealized_pnl" numeric(20,8) DEFAULT '0' NOT NULL,
  "max_drawdown_pct" numeric(8,4) DEFAULT '0' NOT NULL,
  "last_backtest_return_pct" numeric(10,4),
  "last_trade_at" timestamp,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "backtest_results" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "market_type" "market_type" NOT NULL,
  "strategy_keys" jsonb NOT NULL,
  "execution_mode" "strategy_execution_mode" NOT NULL,
  "position_mode" "position_mode" DEFAULT 'NET' NOT NULL,
  "strategy_breakdown" jsonb,
  "performance_metrics" jsonb NOT NULL,
  "equity_curve" jsonb NOT NULL,
  "trade_summary" jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "strategy_configs" ADD CONSTRAINT "strategy_configs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "strategy_positions" ADD CONSTRAINT "strategy_positions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "strategy_positions" ADD CONSTRAINT "strategy_positions_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "strategy_performance" ADD CONSTRAINT "strategy_performance_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "strategy_performance" ADD CONSTRAINT "strategy_performance_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "backtest_results" ADD CONSTRAINT "backtest_results_run_id_backtest_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."backtest_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "backtest_results" ADD CONSTRAINT "backtest_results_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "strategy_configs_user_market_idx" ON "strategy_configs" ("user_id","market_type","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "strategy_positions_user_symbol_idx" ON "strategy_positions" ("user_id","market_type","symbol","lifecycle");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "strategy_positions_strategy_idx" ON "strategy_positions" ("user_id","market_type","strategy_key","lifecycle");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "strategy_performance_user_market_strategy_idx" ON "strategy_performance" ("user_id","market_type","strategy_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "backtest_results_run_idx" ON "backtest_results" ("run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "backtest_results_user_idx" ON "backtest_results" ("user_id","created_at");
