-- Genze Step 3: projects, files, library stubs, message attachments.
-- Idempotent: safe to re-run (IF NOT EXISTS everywhere).

CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title text NOT NULL,
  instructions text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS projects_user_id_idx ON projects (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS files (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects (id) ON DELETE CASCADE,
  original_name text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL,
  storage_key text NOT NULL,
  status text NOT NULL DEFAULT 'extracting',
  extracted_text text,
  transcript_status text,
  image_width integer,
  image_height integer,
  search tsvector,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS files_user_id_idx ON files (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS files_project_id_idx ON files (project_id);
CREATE INDEX IF NOT EXISTS files_search_idx ON files USING GIN (search);

-- Threads can belong to a project (inherit its instructions + file context).
ALTER TABLE chat_threads ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES projects (id) ON DELETE SET NULL;

-- Which files were attached to a user message (multi-file Q&A).
CREATE TABLE IF NOT EXISTS message_files (
  message_id uuid NOT NULL REFERENCES chat_messages (id) ON DELETE CASCADE,
  file_id uuid NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, file_id)
);

-- Library stub tables for later steps (sources/reports/videos/agent tasks).
-- Step 3 only reads them as empty groups; later steps insert rows.
CREATE TABLE IF NOT EXISTS sources (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects (id) ON DELETE SET NULL,
  title text NOT NULL,
  url text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sources_user_id_idx ON sources (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS reports (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects (id) ON DELETE SET NULL,
  title text NOT NULL,
  format text NOT NULL DEFAULT 'markdown',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reports_user_id_idx ON reports (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS videos (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects (id) ON DELETE SET NULL,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS videos_user_id_idx ON videos (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_tasks (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_tasks_user_id_idx ON agent_tasks (user_id, created_at DESC);

-- Metering detail payload (e.g. file-context assembly stats per chat reply).
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS details jsonb;

-- pgvector embedding column: ready for a later step. Skipped when the
-- extension is unavailable (same pattern as 001_init.sql).
DO $$
BEGIN
  ALTER TABLE files ADD COLUMN embedding vector(1536);
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'pgvector not available, skipping files.embedding (embeddings arrive in a later step)';
END
$$;
