-- Free-plan daily caps (small Step 1 defaults; tuned in Step 5).
-- Units per feature:
--   chat     = messages per day
--   research = research runs per day
--   agent    = agent minutes per day
--   video    = generated video seconds per day

INSERT INTO plan_limits (plan, feature, daily_cap) VALUES
  ('free', 'chat', 50),
  ('free', 'research', 5),
  ('free', 'agent', 30),
  ('free', 'video', 60)
ON CONFLICT (plan, feature) DO NOTHING;
