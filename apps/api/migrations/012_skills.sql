-- Step 6: skills + skill attachments. Idempotent (IF NOT EXISTS / ON CONFLICT).
-- user_id NULL = built-in skill (read-only template, seeded below).
-- NOTE: connector tables live in 011_connectors.sql (worker A) — this file
-- must not create or reference them.

CREATE TABLE IF NOT EXISTS skills (
  id uuid PRIMARY KEY,
  user_id uuid NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  instructions text NOT NULL DEFAULT '',
  scripts jsonb NOT NULL DEFAULT '[]',
  is_builtin boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS skills_user_id_idx ON skills (user_id);

CREATE TABLE IF NOT EXISTS project_skills (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  skill_id uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, skill_id)
);

CREATE TABLE IF NOT EXISTS thread_skills (
  thread_id uuid NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  skill_id uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  PRIMARY KEY (thread_id, skill_id)
);

-- Seed the 3 built-in skills (user_id NULL, read-only). Fixed ids so the
-- seed is stable across environments; ON CONFLICT keeps it idempotent.
INSERT INTO skills (id, user_id, name, description, instructions, scripts, is_builtin)
VALUES
  (
    'a1b2c3d4-0000-4000-8000-000000000001',
    NULL,
    'Brand voice',
    'Keep every reply in a consistent, recognizable tone with the same terminology.',
    'Write everything in one consistent brand voice:\n'
    '- Tone: warm, plain-spoken, confident. Short sentences. No hype, no jargon, no buzzwords.\n'
    '- Talk to the reader directly ("you"), never about them in the third person.\n'
    '- Terminology: pick ONE name for each concept or product and reuse it everywhere. Never invent synonyms mid-reply. If the user names something, adopt their term.\n'
    '- Never apologize for being an AI, never mention policies or limitations unless asked.\n'
    '- Match the user''s language and level of formality. If they are casual, be casual; if they are formal, be formal.\n'
    '- Prefer concrete specifics over vague praise ("saves about 20 minutes a day" beats "super efficient").',
    '[]',
    true
  ),
  (
    'a1b2c3d4-0000-4000-8000-000000000002',
    NULL,
    'Meeting notes',
    'Turn messy meeting talk into crisp notes: decisions, owners, due dates.',
    'Turn the conversation into meeting notes with exactly this structure:\n'
    '- Title + date at the top.\n'
    '- Attendees: who was there (only names actually mentioned).\n'
    '- TL;DR: at most 3 bullets summarizing what happened.\n'
    '- Decisions: numbered list. Each decision names WHO decided and WHEN. No decision without an owner.\n'
    '- Action items: task, owner, due date. Never leave an action item ownerless — if no owner was named, write "owner: unassigned" and flag it.\n'
    '- Open questions: things raised but not resolved, each with who should answer.\n'
    '- Keep it scannable: bullets over paragraphs. Quote people sparingly, only when the exact wording matters.\n'
    '- Never invent attendees, dates, or commitments that were not stated.',
    '[]',
    true
  ),
  (
    'a1b2c3d4-0000-4000-8000-000000000003',
    NULL,
    'Spreadsheet cleanup',
    'Tidy messy tables: dedupe, normalize formats, flag problems instead of deleting.',
    'Clean the table using these conventions:\n'
    '- Structure: exactly one header row, no merged cells, no blank rows inside the data.\n'
    '- Normalize: trim whitespace; one consistent casing per column; dates as YYYY-MM-DD; numbers plain (no currency symbols or thousand separators in data cells); one value per cell.\n'
    '- Dedupe: remove exact duplicate rows silently; flag near-duplicates for the user to review instead of deleting them.\n'
    '- Validate: every row must have the required columns filled; numbers must be in a sane range; flag violations in a "needs review" section.\n'
    '- NEVER delete ambiguous or suspicious rows — move them to "needs review" with the reason.\n'
    '- Report: end with a short changelog — how many rows deduped, normalized, and flagged.',
    '[]',
    true
  )
ON CONFLICT (id) DO NOTHING;
