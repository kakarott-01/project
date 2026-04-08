-- Add a column to store exchange stop-loss order IDs so SLs are
-- atomically linked to trade records. This prevents orphaned live
-- positions where an SL exists on the exchange but wasn't persisted.

ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS stop_loss_order_id varchar(255);

CREATE INDEX IF NOT EXISTS idx_trades_stop_loss_order_id ON trades(stop_loss_order_id);
