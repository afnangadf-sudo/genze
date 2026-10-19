-- Genze Step 5: usage metering enforcement, plans, owner flag, provider
-- kill switches, credit ledger.
--
-- Every statement is idempotent (IF NOT EXISTS / DO blocks / ON CONFLICT
-- DO NOTHING) so re-running the migration is a no-op.

-- Billing plan + owner flag on users. All existing users become free
-- non-owners via the column defaults.
ALTER TABLE users ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'free';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_plan_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_plan_check CHECK (plan IN ('free', 'paid'));
  END IF;
END $$;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_owner boolean NOT NULL DEFAULT false;

-- Owner-toggleable provider kill switches (DB half of the kill switch;
-- the other half is the PROVIDER_DISABLED env var, which always wins).
CREATE TABLE IF NOT EXISTS provider_killswitches (
  provider text PRIMARY KEY,
  killed boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Audit trail for credit grants and spends. The daily free grant is made
-- idempotent by the partial unique index below (one grant per user per day).
CREATE TABLE IF NOT EXISTS credit_ledger (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  delta numeric NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS credit_ledger_user_id_idx ON credit_ledger (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_daily_grant_uidx
  ON credit_ledger (user_id, reason) WHERE reason LIKE 'daily_grant:%';

-- Daily caps per plan/feature. Free: chat 50 msgs/day, research 5/day,
-- files 200 MB/day, agent 30 min/day, video 60 s/day. Paid is a 10x
-- placeholder in v1 (not assignable via the API).
INSERT INTO plan_limits (plan, feature, daily_cap) VALUES
  ('free', 'files', 200),
  ('paid', 'chat', 500),
  ('paid', 'research', 50),
  ('paid', 'files', 2000),
  ('paid', 'agent', 300),
  ('paid', 'video', 600)
ON CONFLICT (plan, feature) DO NOTHING;
