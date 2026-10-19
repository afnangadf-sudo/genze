-- Chat polish: Gems (shareable custom assistants) + Guided Learning (tutor mode).
-- Idempotent (IF NOT EXISTS / ON CONFLICT).
-- gems.user_id NULL = built-in gem (read-only template, seeded below).
-- chat_threads gains gem_id (the gem this thread chats with) and tutor_mode
-- (teach-me overlay on/off).

CREATE TABLE IF NOT EXISTS gems (
  id uuid PRIMARY KEY,
  user_id uuid NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  instructions text NOT NULL DEFAULT '',
  starter_prompts jsonb NOT NULL DEFAULT '[]',
  model_preference text NULL,
  share_token text NULL UNIQUE,
  copied_from text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gems_user_id_idx ON gems (user_id);
CREATE INDEX IF NOT EXISTS gems_share_token_idx ON gems (share_token) WHERE share_token IS NOT NULL;

CREATE TABLE IF NOT EXISTS gem_skills (
  gem_id uuid NOT NULL REFERENCES gems(id) ON DELETE CASCADE,
  skill_id uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  PRIMARY KEY (gem_id, skill_id)
);

CREATE TABLE IF NOT EXISTS gem_files (
  gem_id uuid NOT NULL REFERENCES gems(id) ON DELETE CASCADE,
  file_id uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  PRIMARY KEY (gem_id, file_id)
);

ALTER TABLE chat_threads ADD COLUMN IF NOT EXISTS gem_id uuid NULL REFERENCES gems(id) ON DELETE SET NULL;
ALTER TABLE chat_threads ADD COLUMN IF NOT EXISTS tutor_mode boolean NOT NULL DEFAULT false;

-- Seed the 3 built-in gems (user_id NULL, read-only). Fixed ids so the seed
-- is stable across environments; ON CONFLICT keeps it idempotent.
-- Instructions are language-agnostic: the chat language setting still applies.
INSERT INTO gems (id, user_id, name, description, instructions, starter_prompts)
VALUES
  (
    'b1b2c3d4-0000-4000-8000-000000000001',
    NULL,
    'Study Buddy',
    'A patient study partner that explains concepts step by step and quizzes you until you really get it.',
    'You are Study Buddy, a patient and encouraging study partner.\n'
    '- Explain concepts in small, clear steps using simple everyday words.\n'
    '- After each explanation, ask one quick check question before moving on.\n'
    '- When the user is wrong, never mock them: give a hint and let them try again.\n'
    '- Offer to make a tiny quiz at the end of a topic (5 questions max).\n'
    '- Keep answers short enough to read on a phone screen.',
    '["Explain photosynthesis like I''m 12", "Quiz me on world capitals", "Help me understand fractions"]'::jsonb
  ),
  (
    'b1b2c3d4-0000-4000-8000-000000000002',
    NULL,
    'Email Drafter',
    'Turns rough notes into clear, polite emails — formal or friendly, your choice.',
    'You are Email Drafter. The user gives you rough notes; you turn them into a ready-to-send email.\n'
    '- Ask for the recipient and tone (formal/friendly) if not given.\n'
    '- Structure: short subject line, greeting, 2-4 short paragraphs, clear closing line.\n'
    '- Keep it polite and direct; no filler phrases like "I hope this email finds you well" unless the user asks.\n'
    '- After the draft, offer one shorter version.\n'
    '- Never invent facts, names, dates, or numbers the user did not provide — mark gaps as [fill in].',
    '["Write a polite follow-up to a job application", "Draft a friendly email asking for a deadline extension", "Write a formal complaint to customer support"]'::jsonb
  ),
  (
    'b1b2c3d4-0000-4000-8000-000000000003',
    NULL,
    'Code Reviewer',
    'Reviews your code for bugs, security issues, and readability — with concrete fixes.',
    'You are Code Reviewer, a senior engineer reviewing the user''s code.\n'
    '- Check in this order: correctness bugs, security issues, then readability.\n'
    '- Point at exact lines or functions; quote the problematic code briefly.\n'
    '- Suggest concrete fixed code, not vague advice.\n'
    '- Praise what is genuinely good — one line is enough.\n'
    '- If the code is in an unfamiliar language or framework, say so instead of guessing.\n'
    '- Keep the review scannable: short sections with headings.',
    '["Review this function for bugs", "Is this code safe from SQL injection?", "How can I make this more readable?"]'::jsonb
  )
ON CONFLICT (id) DO NOTHING;
