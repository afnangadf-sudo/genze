-- Genze Step 6b: user-registered (custom) MCP connectors.
-- Every statement is idempotent (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS custom_connectors (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name text NOT NULL,
  mcp_url text NOT NULL,
  auth_type text NOT NULL CHECK (auth_type IN ('oauth', 'token')),
  access_token text,
  refresh_token text,
  expires_at timestamptz,
  token_type text NOT NULL DEFAULT 'Bearer',
  fallback text CHECK (fallback IS NULL OR fallback = 'browser'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, mcp_url)
);
CREATE INDEX IF NOT EXISTS custom_connectors_user_id_idx ON custom_connectors (user_id);

-- Step 6b: custom OAuth uses RFC 7591 dynamic client registration. The
-- registered client credentials + discovered token endpoint are stored on
-- the single-use oauth state row (deleted on callback, like built-ins).
-- The client credentials are also kept on the custom row for token refresh.
ALTER TABLE connector_oauth_states ADD COLUMN IF NOT EXISTS client_id text;
ALTER TABLE connector_oauth_states ADD COLUMN IF NOT EXISTS client_secret text;
ALTER TABLE connector_oauth_states ADD COLUMN IF NOT EXISTS token_url text;
ALTER TABLE custom_connectors ADD COLUMN IF NOT EXISTS oauth_client_id text;
ALTER TABLE custom_connectors ADD COLUMN IF NOT EXISTS oauth_client_secret text;
