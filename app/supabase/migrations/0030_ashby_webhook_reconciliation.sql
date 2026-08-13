-- =====================================================================
-- 0030 — Ashby Wave 2 PR B: webhook ingress + reconciliation controls.
--
-- Adds the two atomic primitives the inbound webhook and the incremental
-- reconciliation loop need on top of the 0029 schema:
--   1. record_ashby_event_receipt  — dedup-safe (insert-or-noop) durable
--      ingress for a sanitized webhook receipt, reporting whether the row
--      was newly inserted so the caller enqueues signal work AT MOST ONCE.
--   2. ashby_sync_checkpoints      — one durable cursor per reconciliation
--      stream: an opaque sync token, its issue time (14-day expiry), and a
--      forced-full-resync flag — advanced ONLY after a fully successful run.
--   3. advance_ashby_sync_checkpoint / mark_ashby_sync_full_resync — the
--      atomic checkpoint mutators.
--
-- Forward-only and additive (C-1): guarded CREATE IF NOT EXISTS table +
-- indexes and CREATE OR REPLACE functions only. No destructive DDL, no
-- reverse SQL, no changes to 0029 objects.
--
-- Security posture (mirrors 0015/0029): the new table has RLS enabled and no
-- anon/authenticated/public policy or grant — the browser never reaches it;
-- the API uses the service-role client. Every SECURITY DEFINER RPC pins
-- search_path and is revoked from public/anon/authenticated, granted to
-- service_role only.
--
-- Privacy: the receipt carries ONLY a sanitized (webhook_action_id, action)
-- identity plus bounded non-PII metadata (bounded by the 0029 CHECK). The raw
-- webhook body, signature, secret, contact/resume data, and opaque sync tokens
-- are never stored here. Sync tokens live in ashby_sync_checkpoints as opaque
-- black-box strings, never logged.
-- =====================================================================

-- ═══════════════════════════════════════════════════════════════════════
-- 1. record_ashby_event_receipt — dedup-safe durable webhook ingress
-- ═══════════════════════════════════════════════════════════════════════
-- Inserts one sanitized receipt keyed by the 0029 unique constraint
-- (provider, webhook_action_id, action). On a duplicate delivery the insert
-- is a no-op and the function reports status='duplicate' with the existing
-- row id, so the caller acknowledges 2xx WITHOUT scheduling duplicate queue
-- work. A newly inserted row reports status='inserted'. Metadata is bounded
-- defensively (the table CHECK also bounds it) and defaults to null.

create or replace function screening_v2.record_ashby_event_receipt(
  p_webhook_action_id text,
  p_action            text,
  p_metadata          jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_id uuid;
begin
  if p_webhook_action_id is null
     or length(p_webhook_action_id) < 1 or length(p_webhook_action_id) > 256 then
    return jsonb_build_object('status', 'invalid_action_id');
  end if;
  if p_action is null or length(p_action) < 1 or length(p_action) > 128 then
    return jsonb_build_object('status', 'invalid_action');
  end if;
  if p_metadata is not null and octet_length(p_metadata::text) > 2048 then
    return jsonb_build_object('status', 'metadata_too_large');
  end if;

  -- Race-safe insert-or-noop on the (provider, webhook_action_id, action)
  -- unique key. Concurrent duplicate deliveries converge to a single row.
  insert into screening_v2.ashby_event_receipts
    (provider, webhook_action_id, action, metadata)
  values
    ('ashby', p_webhook_action_id, p_action, p_metadata)
  on conflict (provider, webhook_action_id, action) do nothing
  returning id into v_id;

  if v_id is not null then
    return jsonb_build_object('status', 'inserted', 'id', v_id);
  end if;

  -- Lost the race (or a prior delivery already stored it): fetch the winner.
  select id into v_id
    from screening_v2.ashby_event_receipts
   where provider = 'ashby'
     and webhook_action_id = p_webhook_action_id
     and action = p_action;

  return jsonb_build_object('status', 'duplicate', 'id', v_id);
end;
$$;

revoke all on function screening_v2.record_ashby_event_receipt(text, text, jsonb)
  from public, anon, authenticated;
grant execute on function screening_v2.record_ashby_event_receipt(text, text, jsonb)
  to service_role;

comment on function screening_v2.record_ashby_event_receipt is
  'Dedup-safe durable ingress for a sanitized Ashby webhook receipt. '
  'Insert-or-noop on the (provider, webhook_action_id, action) unique key; '
  'returns status=inserted (new) or status=duplicate (already present) with '
  'the row id, so the caller schedules signal work at most once. Stores only '
  'the sanitized identity + bounded non-PII metadata — never the raw body, '
  'signature, secret, or contact data. Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 2. ashby_sync_checkpoints — one durable reconciliation cursor per stream
-- ═══════════════════════════════════════════════════════════════════════
-- Holds the opaque incremental sync token for a reconciliation stream (unique
-- checkpoint_key, e.g. 'application.list'). The token is advanced ONLY after a
-- fully successful reconciliation run. token_issued_at anchors the 14-day
-- provider expiry: a token older than the expiry (or a null token, or an
-- explicit full_resync_required status) forces a safe full resync. The token
-- is an opaque black box — never logged or exposed to the browser.

create table if not exists screening_v2.ashby_sync_checkpoints (
  id                  uuid primary key default gen_random_uuid(),
  provider            text not null default 'ashby',
  checkpoint_key      text not null,
  sync_token          text,               -- opaque incremental token; null forces full sync
  status              text not null default 'idle',
  token_issued_at     timestamptz,        -- anchors the 14-day expiry
  last_success_at     timestamptz,
  last_full_sync_at   timestamptz,
  pages_last_run      integer not null default 0,
  items_last_run      integer not null default 0,
  full_resync_reason  text,               -- sanitized code (why a full resync was forced)
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint uq_ashby_sync_checkpoints_key unique (provider, checkpoint_key),
  constraint chk_ashby_sync_checkpoints_provider check (provider = 'ashby'),
  constraint chk_ashby_sync_checkpoints_key check (length(checkpoint_key) between 1 and 128),
  constraint chk_ashby_sync_checkpoints_status check (status in ('idle','running','full_resync_required')),
  constraint chk_ashby_sync_checkpoints_token check (sync_token is null or length(sync_token) between 1 and 4096),
  constraint chk_ashby_sync_checkpoints_pages check (pages_last_run >= 0),
  constraint chk_ashby_sync_checkpoints_items check (items_last_run >= 0),
  constraint chk_ashby_sync_checkpoints_reason check (full_resync_reason is null or length(full_resync_reason) <= 200)
);

comment on table screening_v2.ashby_sync_checkpoints is
  'One durable reconciliation cursor per stream (unique provider+checkpoint_key). '
  'sync_token is an opaque incremental token advanced ONLY after a fully '
  'successful run; token_issued_at anchors the 14-day provider expiry that '
  'forces a safe full resync. The token is a black box — never logged or '
  'exposed to browser roles.';
comment on column screening_v2.ashby_sync_checkpoints.sync_token is
  'Opaque provider incremental sync token — never logged or returned to the browser.';

create index if not exists idx_ashby_sync_checkpoints_status
  on screening_v2.ashby_sync_checkpoints (status, updated_at);

alter table screening_v2.ashby_sync_checkpoints enable row level security;
revoke all on screening_v2.ashby_sync_checkpoints from anon, authenticated, public;
grant all privileges on screening_v2.ashby_sync_checkpoints to service_role;

-- ═══════════════════════════════════════════════════════════════════════
-- 3. advance_ashby_sync_checkpoint — persist a cursor after a SUCCESSFUL run
-- ═══════════════════════════════════════════════════════════════════════
-- Upserts the checkpoint row for a stream, setting the new opaque sync token,
-- stamping token_issued_at (expiry anchor) and last_success_at, and clearing
-- the forced-resync state. Callers invoke this ONLY after a run drained (or
-- cleanly checkpointed) its pages — a partial/failed run never calls it, so
-- the cursor never advances past unprocessed work. p_full marks a full-sync
-- completion (also stamps last_full_sync_at).

create or replace function screening_v2.advance_ashby_sync_checkpoint(
  p_checkpoint_key text,
  p_sync_token     text,
  p_pages          integer,
  p_items          integer,
  p_full           boolean default false,
  p_now            timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_id uuid;
begin
  if p_checkpoint_key is null or length(p_checkpoint_key) < 1 or length(p_checkpoint_key) > 128 then
    return jsonb_build_object('status', 'invalid_checkpoint_key');
  end if;
  if p_sync_token is not null and (length(p_sync_token) < 1 or length(p_sync_token) > 4096) then
    return jsonb_build_object('status', 'invalid_sync_token');
  end if;

  insert into screening_v2.ashby_sync_checkpoints
    (provider, checkpoint_key, sync_token, status, token_issued_at,
     last_success_at, last_full_sync_at, pages_last_run, items_last_run,
     full_resync_reason, updated_at)
  values
    ('ashby', p_checkpoint_key, p_sync_token, 'idle',
     case when p_sync_token is null then null else p_now end,
     p_now,
     case when p_full then p_now else null end,
     greatest(0, coalesce(p_pages, 0)), greatest(0, coalesce(p_items, 0)),
     null, p_now)
  on conflict (provider, checkpoint_key) do update set
     sync_token         = excluded.sync_token,
     status             = 'idle',
     token_issued_at    = case when excluded.sync_token is null then null else p_now end,
     last_success_at    = p_now,
     last_full_sync_at  = case when p_full then p_now
                               else screening_v2.ashby_sync_checkpoints.last_full_sync_at end,
     pages_last_run     = greatest(0, coalesce(p_pages, 0)),
     items_last_run     = greatest(0, coalesce(p_items, 0)),
     full_resync_reason = null,
     updated_at         = p_now
  returning id into v_id;

  return jsonb_build_object('status', 'ok', 'id', v_id);
end;
$$;

revoke all on function screening_v2.advance_ashby_sync_checkpoint(text, text, integer, integer, boolean, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.advance_ashby_sync_checkpoint(text, text, integer, integer, boolean, timestamptz)
  to service_role;

comment on function screening_v2.advance_ashby_sync_checkpoint is
  'Persists a reconciliation cursor after a SUCCESSFUL run: sets the opaque '
  'sync token, stamps the 14-day expiry anchor + last_success_at, and clears '
  'the forced-resync state. A partial/failed run never calls this, so the '
  'cursor never advances past unprocessed pages. Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 4. mark_ashby_sync_full_resync — force a safe full resync
-- ═══════════════════════════════════════════════════════════════════════
-- Nulls the opaque sync token and flags the stream so the next run performs a
-- full (non-incremental) resync. Used when the provider token expires (>14
-- days), is rejected, or a dropped-signal audit demands a full pass. Idempotent.

create or replace function screening_v2.mark_ashby_sync_full_resync(
  p_checkpoint_key text,
  p_reason         text,
  p_now            timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_id uuid;
begin
  if p_checkpoint_key is null or length(p_checkpoint_key) < 1 or length(p_checkpoint_key) > 128 then
    return jsonb_build_object('status', 'invalid_checkpoint_key');
  end if;
  if p_reason is not null and length(p_reason) > 200 then
    return jsonb_build_object('status', 'invalid_reason');
  end if;

  insert into screening_v2.ashby_sync_checkpoints
    (provider, checkpoint_key, sync_token, status, token_issued_at,
     full_resync_reason, updated_at)
  values
    ('ashby', p_checkpoint_key, null, 'full_resync_required', null, p_reason, p_now)
  on conflict (provider, checkpoint_key) do update set
     sync_token         = null,
     status             = 'full_resync_required',
     token_issued_at    = null,
     full_resync_reason = p_reason,
     updated_at         = p_now
  returning id into v_id;

  return jsonb_build_object('status', 'ok', 'id', v_id);
end;
$$;

revoke all on function screening_v2.mark_ashby_sync_full_resync(text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function screening_v2.mark_ashby_sync_full_resync(text, text, timestamptz)
  to service_role;

comment on function screening_v2.mark_ashby_sync_full_resync is
  'Forces a safe full resync by nulling the opaque sync token and flagging the '
  'stream (status=full_resync_required). Used on 14-day token expiry, token '
  'rejection, or a dropped-signal audit. Idempotent. Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- Verifier: schema reload notification
-- ═══════════════════════════════════════════════════════════════════════

notify pgrst, 'reload schema';
