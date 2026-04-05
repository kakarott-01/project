CREATE TYPE "strategy_risk_level" AS ENUM ('LOW', 'MEDIUM', 'HIGH');
--> statement-breakpoint
CREATE TYPE "strategy_market_enum" AS ENUM ('CRYPTO', 'STOCKS', 'FOREX');
--> statement-breakpoint
CREATE TYPE "strategy_execution_mode" AS ENUM ('SAFE', 'AGGRESSIVE');
--> statement-breakpoint
CREATE TYPE "strategy_config_slot" AS ENUM ('PRIMARY', 'SECONDARY');
--> statement-breakpoint
CREATE TYPE "backtest_status" AS ENUM ('queued', 'completed', 'failed');
--> statement-breakpoint
CREATE TABLE "strategies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "strategy_key" varchar(100) NOT NULL,
  "name" varchar(120) NOT NULL,
  "description" text NOT NULL,
  "risk_level" "strategy_risk_level" NOT NULL,
  "supported_markets" jsonb NOT NULL,
  "supported_timeframes" jsonb NOT NULL,
  "historical_win_rate" numeric(6, 2) NOT NULL,
  "historical_avg_return" numeric(10, 4) NOT NULL,
  "historical_max_drawdown" numeric(10, 4) NOT NULL,
  "historical_sharpe_ratio" numeric(10, 4) NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "strategies_strategy_key_unique" UNIQUE("strategy_key"),
  CONSTRAINT "strategies_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "market_strategy_configs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "market_type" "market_type" NOT NULL,
  "execution_mode" "strategy_execution_mode" DEFAULT 'SAFE' NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_strategy_selections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "config_id" uuid NOT NULL,
  "strategy_id" uuid NOT NULL,
  "slot" "strategy_config_slot" NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backtest_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "market_type" "market_type" NOT NULL,
  "asset" varchar(100) NOT NULL,
  "timeframe" varchar(20) NOT NULL,
  "date_from" timestamp NOT NULL,
  "date_to" timestamp NOT NULL,
  "initial_capital" numeric(20, 2) NOT NULL,
  "strategy_keys" jsonb NOT NULL,
  "execution_mode" "strategy_execution_mode" NOT NULL,
  "status" "backtest_status" DEFAULT 'queued' NOT NULL,
  "performance_metrics" jsonb,
  "equity_curve" jsonb,
  "trade_summary" jsonb,
  "comparison_label" varchar(150),
  "error_message" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "completed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "market_strategy_configs" ADD CONSTRAINT "market_strategy_configs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "market_strategy_selections" ADD CONSTRAINT "market_strategy_selections_config_id_market_strategy_configs_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."market_strategy_configs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "market_strategy_selections" ADD CONSTRAINT "market_strategy_selections_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "backtest_runs" ADD CONSTRAINT "backtest_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "market_strategy_configs_user_market_unique" ON "market_strategy_configs" USING btree ("user_id","market_type");
--> statement-breakpoint
CREATE UNIQUE INDEX "market_strategy_selections_config_slot_unique" ON "market_strategy_selections" USING btree ("config_id","slot");
--> statement-breakpoint
CREATE UNIQUE INDEX "market_strategy_selections_config_strategy_unique" ON "market_strategy_selections" USING btree ("config_id","strategy_id");
--> statement-breakpoint
CREATE INDEX "strategies_key_idx" ON "strategies" USING btree ("strategy_key");
--> statement-breakpoint
CREATE INDEX "strategies_active_idx" ON "strategies" USING btree ("is_active");
--> statement-breakpoint
CREATE INDEX "market_strategy_configs_user_market_idx" ON "market_strategy_configs" USING btree ("user_id","market_type");
--> statement-breakpoint
CREATE INDEX "market_strategy_selections_config_slot_idx" ON "market_strategy_selections" USING btree ("config_id","slot");
--> statement-breakpoint
CREATE INDEX "market_strategy_selections_strategy_idx" ON "market_strategy_selections" USING btree ("strategy_id");
--> statement-breakpoint
CREATE INDEX "backtest_runs_user_created_idx" ON "backtest_runs" USING btree ("user_id","created_at");
--> statement-breakpoint
CREATE INDEX "backtest_runs_status_idx" ON "backtest_runs" USING btree ("status");
