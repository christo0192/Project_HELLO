-- Adds optional scorecard dimensions introduced after the initial v2 schema.
-- Safe to run more than once.

alter table screening_v2.assessments
  add column if not exists communication jsonb,
  add column if not exists motivation jsonb,
  add column if not exists resume_conflicts jsonb;

notify pgrst, 'reload schema';
