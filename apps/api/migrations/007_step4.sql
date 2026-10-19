-- Genze Step 4: research jobs, write drafts/styles, fact checks, user memories.
-- Idempotent: safe to re-run (IF NOT EXISTS everywhere).

CREATE TABLE IF NOT EXISTS research_jobs (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id uuid,
  topic text NOT NULL,
  status text NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'running', 'done', 'failed', 'cancelled')),
  plan jsonb,
  progress jsonb NOT NULL DEFAULT '{"phase":"queued","done":0,"total":100}',
  report_markdown text,
  sources jsonb NOT NULL DEFAULT '[]',
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_research_jobs_user ON research_jobs (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS write_drafts (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  title text NOT NULL,
  template text NOT NULL,
  content text NOT NULL DEFAULT '',
  style_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_write_drafts_user ON write_drafts (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS writing_styles (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_writing_styles_user ON writing_styles (user_id);

-- write_drafts.style_id references writing_styles (added after the table
-- exists so the migration stays order-independent and idempotent).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'write_drafts_style_id_fkey'
  ) THEN
    ALTER TABLE write_drafts
      ADD CONSTRAINT write_drafts_style_id_fkey
      FOREIGN KEY (style_id) REFERENCES writing_styles(id) ON DELETE SET NULL;
  END IF;
END $$;

ALTER TABLE projects ADD COLUMN IF NOT EXISTS default_style_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'projects_default_style_id_fkey'
  ) THEN
    ALTER TABLE projects
      ADD CONSTRAINT projects_default_style_id_fkey
      FOREIGN KEY (default_style_id) REFERENCES writing_styles(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS fact_checks (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  draft_id uuid NOT NULL REFERENCES write_drafts(id) ON DELETE CASCADE,
  thread_id uuid,
  status text NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'running', 'done', 'failed', 'cancelled')),
  claims jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fact_checks_draft ON fact_checks (draft_id);

CREATE TABLE IF NOT EXISTS user_memories (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_user_memories_user ON user_memories (user_id);
