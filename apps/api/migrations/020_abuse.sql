-- Step: abuse protection (owner bans + auto-ban on hammering).
-- Lets the app owner suspend accounts that tamper with the app, and
-- automatically suspends accounts that hammer rate-limited endpoints.

ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_reason text;

CREATE TABLE IF NOT EXISTS abuse_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS abuse_events_user_time ON abuse_events(user_id, created_at DESC);
