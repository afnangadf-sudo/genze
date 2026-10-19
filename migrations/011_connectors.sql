-- Genze Step 6 (backend worker A): connector tables ONLY.
-- The skills tables (skills, project_skills, thread_skills) belong to worker B
-- in 012_skills.sql — kept separate on purpose.
--
-- Every statement is idempotent (IF NOT EXISTS / ON CONFLICT) so re-running
-- the migration is a no-op.

-- Connected accounts. Tokens are AES-256-GCM encrypted (format
-- `iv:ciphertext:tag`, hex) — NEVER plaintext. Key: TOKEN_ENCRYPTION_KEY.
CREATE TABLE IF NOT EXISTS connector_accounts (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  connector_id text NOT NULL,
  access_token text NOT NULL,
  refresh_token text,
  expires_at timestamptz,
  scopes text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, connector_id)
);
CREATE INDEX IF NOT EXISTS connector_accounts_user_id_idx ON connector_accounts (user_id);

-- OAuth 2.0 PKCE state rows. Single-use: deleted on callback (success or
-- failure). Stale rows (>30 min) are ignored by the app.
CREATE TABLE IF NOT EXISTS connector_oauth_states (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  connector_id text NOT NULL,
  state text UNIQUE NOT NULL,
  code_verifier text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS connector_oauth_states_user_id_idx ON connector_oauth_states (user_id);

-- Pending write-tool confirmations. TTL 15 min; expired rows are never executed.
CREATE TABLE IF NOT EXISTS connector_confirmations (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  connector_id text NOT NULL,
  tool text NOT NULL,
  arguments jsonb NOT NULL,
  summary text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS connector_confirmations_user_id_idx ON connector_confirmations (user_id);

-- Per-user audit trail of connector actions.
CREATE TABLE IF NOT EXISTS connector_audit_log (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  connector_id text NOT NULL,
  action text NOT NULL,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS connector_audit_log_user_id_idx
  ON connector_audit_log (user_id, created_at DESC);
