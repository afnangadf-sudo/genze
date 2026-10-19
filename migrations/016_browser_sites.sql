-- Step 8: browser-based connections (sites with no API and no MCP server).
-- Idempotent: every statement uses IF NOT EXISTS.
--
-- browser_sites: one row per user-added site. The authenticated browser
-- profile (cookies snapshot) is stored AES-256-GCM encrypted in
-- profile_blob (format `iv:ciphertext:tag` hex, same as connector tokens,
-- with a `genze:browser-profile:v1:` purpose prefix inside the plaintext).
-- Cookies/tokens are NEVER stored in plaintext.
-- status: 'never' (added, never logged in) | 'active' (logged in) |
--         'expired' (session no longer valid — user must log in again).

CREATE TABLE IF NOT EXISTS browser_sites (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name text NOT NULL,
  url text NOT NULL,
  profile_blob text NULL,
  status text NOT NULL DEFAULT 'never'
    CHECK (status IN ('never', 'active', 'expired')),
  last_checked_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, url)
);
CREATE INDEX IF NOT EXISTS browser_sites_user_idx ON browser_sites (user_id);

-- browser_login_sessions: in-flight guided login sessions. The cloud
-- browser session (driver-side) is tracked here between "begin login" and
-- "login complete" (15-minute TTL). Rows are single-use: deleted on
-- completion, and the boot sweep deletes expired rows (their driver
-- sessions are closed best-effort).

CREATE TABLE IF NOT EXISTS browser_login_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  site_id uuid NOT NULL REFERENCES browser_sites (id) ON DELETE CASCADE,
  driver_session_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS browser_login_sessions_user_idx
  ON browser_login_sessions (user_id);
CREATE INDEX IF NOT EXISTS browser_login_sessions_expires_idx
  ON browser_login_sessions (expires_at);
