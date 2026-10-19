-- Step 10 — backend store-readiness: Sign in with Apple, AI-notice record,
-- moderation reports, blocked users.
-- Idempotent (IF NOT EXISTS / DO-block guards).

-- Sign in with Apple: stable Apple user id (the token's `sub`).
ALTER TABLE users ADD COLUMN IF NOT EXISTS apple_sub text NULL;
DO $$
BEGIN
  BEGIN
    ALTER TABLE users ADD CONSTRAINT users_apple_sub_unique UNIQUE (apple_sub);
  EXCEPTION
    WHEN duplicate_object THEN NULL;
  END;
END
$$;

-- Apple 5.1.2(i): the mobile app shows the AI notice first-run and records
-- acceptance here (append-only; never cleared).
ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_notice_accepted_at timestamptz NULL;

-- Moderation reports: the report buttons in mobile/web call the API directly,
-- so this is the only store-side moderation surface in v1.
CREATE TABLE IF NOT EXISTS moderation_reports (
  id uuid PRIMARY KEY,
  reporter_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_type text NOT NULL,
  content_id text NOT NULL,
  reason text NOT NULL,
  details text NULL,
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT moderation_reports_status_check
    CHECK (status IN ('open', 'triaged', 'resolved', 'dismissed'))
);
CREATE INDEX IF NOT EXISTS moderation_reports_created_idx
  ON moderation_reports (created_at DESC);

-- Blocked users: block list is per user (reporter-side filtering in v1).
CREATE TABLE IF NOT EXISTS blocked_users (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, blocked_user_id)
);
