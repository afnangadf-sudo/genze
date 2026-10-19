-- Genze quick wins: lockdown mode + thread compaction.
-- Idempotent: safe to re-run (IF NOT EXISTS everywhere).

ALTER TABLE chat_threads ADD COLUMN IF NOT EXISTS lockdown boolean NOT NULL DEFAULT false;
ALTER TABLE chat_threads ADD COLUMN IF NOT EXISTS compaction_summary text;
ALTER TABLE chat_threads ADD COLUMN IF NOT EXISTS compacted_through_message_id uuid;
