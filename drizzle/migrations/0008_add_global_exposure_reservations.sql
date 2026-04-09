-- Add table for ephemeral global exposure reservations

CREATE TABLE IF NOT EXISTS global_exposure_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount numeric(20,8) NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  expires_at timestamp
);

CREATE INDEX IF NOT EXISTS idx_global_exposure_user ON global_exposure_reservations(user_id, created_at);
