-- =====================================================================
-- 0009 → 0010 — Transactional outbox and durable ordered transcript events
--               (REL-02/03: outbox/ingestion).
--
-- Adds two tables:
--   1. transcript_events — Durable ordered store for transcript turns with
--      idempotent dedup via UNIQUE(session_id, turn_index). Out-of-order
--      delivery results in a single ordered record per turn index.
--   2. outbox — Transactional outbox pattern. Each transcript event write
--      also creates a pending outbox row. A background consumer (future)
--      publishes pending rows and transitions them to 'published'. Rows
--      that exhaust retries land in 'failed' (DLQ semantics).
--
-- Kill-after-commit is simulated by the outbox row staying 'pending' until
-- the publisher processes it. This ensures no event is lost on worker crash.
-- =====================================================================

-- ═══════════════════════════════════════════════════════════════════════
-- 1. transcript_events — durable ordered transcript event store
-- ═══════════════════════════════════════════════════════════════════════

create table if not exists screening_v2.transcript_events (
  id            uuid primary key default gen_random_uuid(),
  session_id    uuid not null references screening_v2.call_sessions(id) on delete cascade,
  turn_index    int not null,
  speaker       text not null,
  text          text not null,
  sequence      int not null,
  created_at    timestamptz not null default now(),

  -- Dedup: same session + turn_index is the same event.
  -- Duplicate inserts are silently ignored (ON CONFLICT DO NOTHING).
  -- Out-of-order events still insert cleanly because the specific
  -- (session_id, turn_index) pair does not yet exist.
  unique (session_id, turn_index)
);

comment on table screening_v2.transcript_events is
  'Durable ordered transcript event store. Dedup key is (session_id, turn_index).';

comment on column screening_v2.transcript_events.sequence is
  'Per-session monotonic counter. Not guaranteed gapless, but guaranteed increasing.';

-- Index for ordered retrieval per session
create index if not exists idx_v2_transcript_events_session_seq
  on screening_v2.transcript_events(session_id, sequence);

-- ═══════════════════════════════════════════════════════════════════════
-- 2. outbox — transactional outbox for async delivery
-- ═══════════════════════════════════════════════════════════════════════

create table if not exists screening_v2.outbox (
  id              uuid primary key default gen_random_uuid(),
  aggregate_type  text not null,              -- e.g. 'transcript_event'
  aggregate_id    uuid not null,              -- FK to the domain event row
  event_type      text not null,              -- e.g. 'transcript_turn.created'
  payload         jsonb not null default '{}'::jsonb,
  status          text not null default 'pending'
                    check (status in ('pending', 'published', 'failed')),
  retry_count     int not null default 0,
  max_retries     int not null default 3,
  created_at      timestamptz not null default now(),
  published_at    timestamptz,
  last_error      text
);

comment on table screening_v2.outbox is
  'Transactional outbox. Rows start pending; publisher transitions to published or failed.';

comment on column screening_v2.outbox.status is
  'pending=awaiting delivery, published=delivered, failed=retries exhausted (DLQ).';

-- Index for efficient pending-entry polling
create index if not exists idx_v2_outbox_pending
  on screening_v2.outbox(status, created_at)
  where status = 'pending';

-- Index for failed-entries (DLQ inspection)
create index if not exists idx_v2_outbox_failed
  on screening_v2.outbox(status, retry_count)
  where status = 'failed';

-- ═══════════════════════════════════════════════════════════════════════
-- 3. RLS: all access is service_role only (internal tool)
-- ═══════════════════════════════════════════════════════════════════════

-- Revoke all on both tables from anon/public
revoke all on screening_v2.transcript_events from anon, public;
revoke all on screening_v2.outbox from anon, public;

-- Grant service_role full access
grant all on screening_v2.transcript_events to service_role;
grant all on screening_v2.outbox to service_role;

-- Grant authenticated SELECT only for dashboard visibility
grant select on screening_v2.transcript_events to authenticated;
grant select on screening_v2.outbox to authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- 4. Notify PostgREST to reload schema cache
-- ═══════════════════════════════════════════════════════════════════════

notify pgrst, 'reload schema';
