-- Step 9: Studio — images, voice (TTS audio), Video Director, Audio Overviews.
-- All tables idempotent (IF NOT EXISTS); safe to re-run.

CREATE TABLE IF NOT EXISTS studio_images (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  prompt text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  aspect_ratio text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready','failed')),
  storage_key text NULL,
  error text NULL,
  -- For edits (image+prompt variation): storage key of the source image.
  edit_source_key text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS studio_images_user_id_idx ON studio_images (user_id, created_at DESC);

-- Spoken-audio artifacts (POST /studio/voice/speak). A row must exist so the
-- signed download endpoint can resolve id -> storage_key with ownership.
CREATE TABLE IF NOT EXISTS studio_audio (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('tts')),
  provider text NOT NULL,
  model text NOT NULL,
  language text NULL,
  chars int NOT NULL DEFAULT 0,
  storage_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS studio_audio_user_id_idx ON studio_audio (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS video_projects (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title text NOT NULL,
  brief text NOT NULL,
  target_minutes int NOT NULL DEFAULT 2,
  preferred_provider text NULL,
  music_file_id uuid NULL REFERENCES files (id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'estimating'
    CHECK (status IN ('estimating','awaiting_approval','running','done','failed','discarded')),
  estimate jsonb NULL,
  approved_at timestamptz NULL,
  current_stage text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS video_projects_user_id_idx ON video_projects (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS video_shots (
  id uuid PRIMARY KEY,
  video_id uuid NOT NULL REFERENCES video_projects (id) ON DELETE CASCADE,
  n int NOT NULL,
  prompt text NOT NULL,
  duration_s int NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','generating','ready','failed')),
  storage_key text NULL,
  error text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS video_shots_video_id_idx ON video_shots (video_id, n);

CREATE TABLE IF NOT EXISTS audio_overviews (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title text NOT NULL,
  length text NOT NULL CHECK (length IN ('short','medium','long')),
  source_file_ids jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','ready','failed')),
  storage_key text NULL,
  error text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audio_overviews_user_id_idx ON audio_overviews (user_id, created_at DESC);

-- agent_notifications (014) has task_id NOT NULL. Video Director reuses the
-- same "exactly one notification per finished job" table: task_id becomes
-- nullable and video_id is the alternative key (CHECK enforces one of them).
ALTER TABLE agent_notifications ADD COLUMN IF NOT EXISTS video_id uuid NULL
  REFERENCES video_projects (id) ON DELETE CASCADE;
ALTER TABLE agent_notifications ALTER COLUMN task_id DROP NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_notifications_task_or_video_chk') THEN
    ALTER TABLE agent_notifications ADD CONSTRAINT agent_notifications_task_or_video_chk
      CHECK (task_id IS NOT NULL OR video_id IS NOT NULL);
  END IF;
END
$$;
CREATE INDEX IF NOT EXISTS agent_notifications_video_id_idx ON agent_notifications (video_id);
