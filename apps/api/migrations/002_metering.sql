-- Genze Step 1: metering schema ONLY (no enforcement yet).
-- Usage enforcement + cost dashboard arrive in Step 5.

CREATE TABLE IF NOT EXISTS usage_events (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  feature text NOT NULL,
  provider text,
  units numeric NOT NULL,
  cost_usd numeric,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usage_events_user_id_idx ON usage_events (user_id);

CREATE TABLE IF NOT EXISTS credit_balances (
  user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  credits numeric NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS plan_limits (
  plan text NOT NULL,
  feature text NOT NULL,
  daily_cap numeric NOT NULL,
  PRIMARY KEY (plan, feature)
);
