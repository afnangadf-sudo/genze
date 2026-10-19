-- Genze Step 7: autonomous Agent (backend core).
-- Every statement is idempotent (ADD COLUMN IF NOT EXISTS / CREATE IF NOT EXISTS).
-- Extends the `agent_tasks` stub from 005_files_projects.sql and adds
-- approval + notification tables.

-- Kind: ad-hoc 'task' or sibling-worker 'scheduled' run (seam, not built here).
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'task'
  CHECK (kind IN ('task', 'scheduled'));
-- The user's request text (title stays as the short label).
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS task text NOT NULL DEFAULT '';
-- Plan: {steps: [{n, action, url?, description}], estimatedMinutes, estimatedCostUsd, requiresBrowser}
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS plan jsonb;
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES projects (id) ON DELETE SET NULL;
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS thread_id uuid REFERENCES chat_threads (id) ON DELETE SET NULL;
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS steps_used int NOT NULL DEFAULT 0;
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS browser_session_id text;
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS live_view_url text;
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS report_markdown text;
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS result_files jsonb NOT NULL DEFAULT '[]';
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS screenshots jsonb NOT NULL DEFAULT '[]';
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS error text;
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS started_at timestamptz;
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS finished_at timestamptz;
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS agent_tasks_project_id_idx ON agent_tasks (project_id);
CREATE INDEX IF NOT EXISTS agent_tasks_thread_id_idx ON agent_tasks (thread_id);

-- Statuses used by the Step 7 backend: planned | awaiting_approval | running
-- | awaiting_confirmation | paused_takeover | done | failed | cancelled | limit_stopped.
-- Kept as free text (no CHECK) so later steps can add states without a migration.

-- Approval gates: risky browser actions pause the run until the user decides.
CREATE TABLE IF NOT EXISTS agent_approvals (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES agent_tasks (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('payment', 'deletion', 'send', 'public_post', 'form_submit')),
  summary text NOT NULL,
  details jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '15 minutes',
  decided_at timestamptz
);
CREATE INDEX IF NOT EXISTS agent_approvals_user_id_idx ON agent_approvals (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_approvals_task_id_idx ON agent_approvals (task_id);

-- One notification per finished task (exactly one row per terminal task).
CREATE TABLE IF NOT EXISTS agent_notifications (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES agent_tasks (id) ON DELETE CASCADE,
  title text NOT NULL,
  read boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_notifications_user_id_idx ON agent_notifications (user_id, created_at DESC);
