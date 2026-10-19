-- Step 7b (backend-extra): scheduled agent tasks.
-- Idempotent: every statement uses IF NOT EXISTS.
--
-- Note: 014_agent.sql (the agent core, sibling worker) sorts before this
-- file, so when it exists its agent_tasks extensions win and the ADD COLUMN
-- statements below are no-ops. When 014 has not landed yet, the columns
-- added here keep the scheduler tick working.

CREATE TABLE IF NOT EXISTS agent_schedules (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title text NOT NULL,
  task text NOT NULL,
  schedule jsonb NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  auto_approve boolean NOT NULL DEFAULT false,
  approved_once boolean NOT NULL DEFAULT false,
  next_run_at timestamptz NULL,
  last_run_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_schedules_user_id_idx ON agent_schedules (user_id);

-- The scheduler tick creates agent_tasks rows. `schedule_id` is this step's
-- only new column: the tick stores the user's request text in the `task`
-- column and the run kind in `kind`, both defined by 014_agent.sql
-- (no-ops below when 014 defined them first; kept for the case 014 is
-- absent, so the tick still works standalone).
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS schedule_id uuid NULL
  REFERENCES agent_schedules (id) ON DELETE SET NULL;
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS kind text NULL;
-- Standalone fallback: when 014 is absent the tick still needs a column for
-- the request text. No-op when 014 defined `task` first.
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS task text NULL;
