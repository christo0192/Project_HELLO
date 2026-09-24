-- 0100_roles_agent_name.sql
--
-- AN INTERNAL NAME FOR THE AGENT THAT SCREENS A ROLE.
--
-- `roles.title` is the JOB the candidate applied for, and it is spoken: the
-- phone opening reads it aloud, and a mismatch between the stored title and
-- what the worker renders fails an exact-match gate (a `" - "` in a title has
-- already cost a live call). So it cannot double as the operator's private
-- label for the screening agent.
--
-- Owner request 2026-09-22: recruiters want to call the agent something for
-- their own reference — "Gopu", "Sales screener" — independently of the job
-- title, and the Roles form now shows that as its first field.
--
-- ── WHY THIS IS A SEPARATE COLUMN AND NOT A RENAME ────────────────────
-- Nothing may change the meaning of `title`. It is read by the phone worker's
-- spoken opening, the Ashby mapping's role binding, the candidate list's Role
-- column, and the funnel's role filter. `agent_name` is additive, nullable,
-- and read by nothing but the Roles UI — a role with no agent name behaves
-- exactly as it does today.
--
-- NOT spoken, ever. This is an operator-facing label; the worker has no reason
-- to read it and no code path is given one. It is also NOT unique: two roles
-- may sensibly share an agent name, and a uniqueness constraint would turn a
-- cosmetic field into a save failure.
--
-- Bounded at 80 characters so a runaway paste cannot become a row that breaks
-- the form that renders it. Blank is stored as NULL rather than '' so "unset"
-- has one representation, matching how `jd` already behaves.

alter table screening_v2.roles
  add column if not exists agent_name text;

alter table screening_v2.roles
  drop constraint if exists chk_roles_agent_name;

alter table screening_v2.roles
  add constraint chk_roles_agent_name
  check (agent_name is null or (length(agent_name) between 1 and 80));

comment on column screening_v2.roles.agent_name is
  'Operator-facing internal label for the screening agent (e.g. "Gopu"). '
  'Never spoken by the phone worker and never used for routing — `title` is '
  'the job the candidate applied for and remains the only spoken name. '
  'Nullable, non-unique, max 80 chars.';
