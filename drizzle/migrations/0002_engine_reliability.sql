ALTER TABLE "trades"
  ADD COLUMN IF NOT EXISTS "fee_rate" numeric(8, 6) DEFAULT '0.001',
  ADD COLUMN IF NOT EXISTS "fee_amount" numeric(20, 8),
  ADD COLUMN IF NOT EXISTS "net_pnl" numeric(20, 8),
  ADD COLUMN IF NOT EXISTS "filled_quantity" numeric(20, 8) DEFAULT '0',
  ADD COLUMN IF NOT EXISTS "remaining_quantity" numeric(20, 8);
--> statement-breakpoint
UPDATE "trades"
SET
  "filled_quantity" = COALESCE("filled_quantity", 0),
  "remaining_quantity" = CASE
    WHEN "status" = 'open' THEN COALESCE("remaining_quantity", "quantity")
    ELSE COALESCE("remaining_quantity", 0)
  END,
  "fee_rate" = COALESCE("fee_rate", '0.001'),
  "fee_amount" = COALESCE("fee_amount", 0),
  "net_pnl" = COALESCE("net_pnl", "pnl")
WHERE
  "filled_quantity" IS NULL
  OR "remaining_quantity" IS NULL
  OR "fee_rate" IS NULL
  OR "fee_amount" IS NULL
  OR "net_pnl" IS NULL;
--> statement-breakpoint
ALTER TABLE "risk_settings"
  ADD COLUMN IF NOT EXISTS "paper_balance" numeric(20, 2) DEFAULT '10000.00' NOT NULL;
--> statement-breakpoint
ALTER TABLE "risk_state"
  ADD COLUMN IF NOT EXISTS "last_loss_time" double precision;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_trades_user_market_open"
  ON "trades" ("user_id", "market_type", "status");
