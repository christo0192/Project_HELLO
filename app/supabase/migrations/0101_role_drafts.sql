-- 0101_role_drafts.sql
--
-- "ASK HELLO" BECOMES A JOB, NOT A TEN-MINUTE HTTP CALL.
--
-- The first cut streamed NDJSON from a single request. Three independent
-- reviews rejected the shape, for reasons that are all consequences of one
-- fact: drafting runs DeepSeek v4-pro up to three times at 133-206s a call, so
-- a request can legitimately live for the better part of ten minutes.
--
--   * Nothing survived a refresh, a navigation, a closed laptop lid or a
--     discarded tab. Ten minutes of paid model work, gone, with nothing to
--     show and no way to get it back.
--   * The stream was SILENT between phases for one whole model call. Fly's
--     proxy and every corporate proxy in between idle out well inside that,
--     so the connection would be reaped mid-draft and the operator would see
--     "Hello stopped responding" every time — the feature would not have
--     worked in production at all.
--   * Cancel cancelled the UI, not the work: `res.on('close')` stopped the
--     writes while the generation carried on billing.
--
-- With the state in a row, the HTTP calls become short and ordinary, the work
-- outlives the connection, a refresh picks it back up, and cancellation is a
-- flag the generator can actually read.
--
-- ── WHY A TABLE AND NOT IN-PROCESS STATE ─────────────────────────────
-- The API runs several Fly machines. An in-memory job started on one is
-- invisible to a poll that lands on another, so the operator would see a job
-- that exists half the time. Postgres is the only state every machine shares.
--
-- Drafts are DISPOSABLE. Nothing downstream reads this table: the operator
-- reviews the draft in the form and presses Save, which writes `roles` through
-- the existing validated path. A lost draft costs a retry, never data.

create table if not exists screening_v2.role_drafts (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null,
  -- The input, kept so a poll can prove the draft matches the field the
  -- operator is looking at. The form's job role can change while this runs.
  job_role      text not null,
  status        text not null default 'running',
  -- Latest progress event, exactly as the generator reported it. jsonb rather
  -- than columns because the phase union carries different keys per phase and
  -- this table has no business knowing them.
  phase         jsonb,
  -- The finished draft: jd, required_skills, screening_template. Null until
  -- `status = 'succeeded'`.
  draft         jsonb,
  attempts      integer not null default 0,
  -- Which questions had to be rephrased past the phone gate, for the note the
  -- form shows. Never the reason for a failure — that is `error_message`.
  repaired      jsonb not null default '[]'::jsonb,
  error_reason  text,
  error_message text,
  -- Set by the operator pressing Cancel. The generator reads it between
  -- attempts and stops, so a cancel actually stops the spending.
  cancelled_at  timestamptz,
  created_at    timestamptz not null default now(),
  -- BUMPED ON EVERY PHASE CHANGE, and that is what makes a dead machine
  -- recoverable: a row still `running` with a stale heartbeat is a job whose
  -- process died, and the read treats it as failed rather than leaving the
  -- operator watching a spinner for a machine that is gone.
  updated_at    timestamptz not null default now(),
  constraint chk_role_drafts_status
    check (status in ('running', 'succeeded', 'failed', 'cancelled')),
  constraint chk_role_drafts_job_role check (length(job_role) between 1 and 200),
  constraint chk_role_drafts_error_reason
    check (error_reason is null or length(error_reason) <= 64),
  constraint chk_role_drafts_error_message
    check (error_message is null or length(error_message) <= 2000),
  constraint chk_role_drafts_attempts check (attempts between 0 and 100),
  -- A terminal row must carry its outcome, and a running one must not.
  constraint chk_role_drafts_terminal_shape check (
    (status = 'succeeded' and draft is not null)
    or (status = 'failed' and error_reason is not null)
    or status in ('running', 'cancelled')
  )
);

-- ONE INDEX, FOR THE ONE READ THAT EXISTS.
--
-- An `(owner_id, created_at desc)` index shipped here first, justified as
-- serving "my most recent draft". It served nothing: the only read that could
-- use it filters `status = 'running'` and orders by `updated_at desc`, and
-- nothing in the module orders by `created_at` at all. A dead index is write
-- amplification on every insert plus a comment that misleads the next reader
-- about which queries exist.
--
-- What remains is UNIQUE, not merely an index, and that is load-bearing. The
-- admission check in `startRoleDraft` is a SELECT followed by an INSERT, and
-- that pair does not exclude a concurrent one: two tabs both see no live row
-- and both insert, detaching two chains of up to six v4-pro calls into the
-- process that also serves live-call operations. The database is what stops
-- it. It also serves the ordered read, since a partial index on `owner_id`
-- covers a lookup filtered to `status = 'running'`.
--
-- Partial on `status = 'running'`, so a settled or cancelled row never blocks
-- the next draft. A STALE running row does block it — the index has no notion
-- of staleness — which is why `startRoleDraft` reads through its own
-- staleness filter on a 23505 and expires the dead row rather than failing.
create unique index if not exists uq_role_drafts_owner_running
  on screening_v2.role_drafts (owner_id) where status = 'running';

alter table screening_v2.role_drafts enable row level security;
revoke all on screening_v2.role_drafts from anon, authenticated, public;
-- The house grant. `0001` sets `alter default privileges ... grant all on
-- tables to service_role`, so this is belt-and-braces — but 0063, 0079, 0090
-- and 0098 all state it explicitly rather than rely on a default that only
-- applies to the role that happened to create the table, and the failure it
-- guards against (permission denied on every Ask Hello call) is silent until
-- someone presses the button.
grant all privileges on screening_v2.role_drafts to service_role;

comment on table screening_v2.role_drafts is
  'Ask Hello generation jobs. Disposable: the operator reviews a draft in the '
  'Roles form and Save writes `roles` through the normal validated path, so '
  'nothing downstream reads this table and a lost row costs only a retry. '
  'State lives here rather than in a process because the API runs several Fly '
  'machines and a poll may land on a different one than started the job.';
comment on column screening_v2.role_drafts.updated_at is
  'Heartbeat, bumped on every phase change. A `running` row whose heartbeat is '
  'stale belongs to a process that died; readers treat it as failed rather '
  'than spinning forever.';
comment on column screening_v2.role_drafts.cancelled_at is
  'Set by the operator. The generator reads it between attempts, so Cancel '
  'stops the v4-pro spending rather than only hiding the UI.';
