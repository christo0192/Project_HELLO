-- =====================================================================
-- 0016 — HELLO dashboard access allowlist (normalized-email access gate)
--        (email_allowlist / resolve_allowlist_access /
--         add_allowlist_entry / update_allowlist_entry +
--         audit action CHECK widening).
--
-- Forward-only and additive (C-1): every column is ADD COLUMN IF NOT EXISTS
-- (none needed here — the table is new) and every CHECK is added NOT VALID
-- then VALIDATE'd; the only DROP ... IF EXISTS statements target constraints
-- THIS migration re-creates in the same chain (the sanctioned replaceable
-- data-guard evolution pattern from 0014/0015). There is NO reverse SQL /
-- down-migration.
--
-- DESIGN:
--   1. email_allowlist — a dedicated, normalized-email allowlist that is
--      INDEPENDENT of auth.users (no user_id required to provision). An
--      admin can add an email before that person ever signs in. Row shape:
--      unique normalized email, role admin/interviewer/viewer, active,
--      nullable UNIQUE linked_user_id + linked_at (set on first verified
--      Google/company login). Only service_role can read/write it — the
--      browser (PostgREST anon/authenticated) has ZERO grants/policies.
--   2. Bootstrap: exactly the three confirmed launch admin emails are
--      seeded as active admins WITHOUT requiring auth.users rows.
--   3. resolve_allowlist_access(p_user_id, p_email) — the atomic
--      SECURITY DEFINER (fixed search_path) resolver/link RPC called by the
--      API auth middleware on EVERY request. Locks the matched entry,
--      rejects missing/inactive/domain-mismatch/relink-to-another-user,
--      links the entry on first login, creates/updates recruiter_memberships
--      from the SERVER-HELD allowlist role (never the client), and audits the
--      link once. A disabled entry denies access even with a valid old JWT
--      and/or stale active membership row.
--   4. add_allowlist_entry / update_allowlist_entry — audited, atomic admin
--      mutations. Normalization is identical to the resolver. Duplicate
--      case/whitespace variants conflict via the unique normalized index.
--      Admin cannot self-disable/demote and cannot remove the last LINKED
--      active admin; pending (unlinked) admins do NOT satisfy the
--      last-linked-admin safety check. Mutations are audit fail-closed
--      (audit row inserted in the SAME transaction).
--   5. Audit metadata NEVER contains the full email — only a SHA-256 hex
--      digest (pgcrypto, created by 0001) plus role/active and the opaque
--      entry id as target_id.
--   6. audit_events action CHECK widened additively (0014/0015 pattern)
--      with the underscored actions: allowlist_linked / admin_allowlist_add
--      / admin_allowlist_update.
--
-- RLS posture: the allowlist table has RLS enabled and NO authenticated/
-- anon/public policy or grant — the web reaches it exclusively through the
-- RBAC-protected API using the service-role client. PostgREST cannot read it.
-- =====================================================================

-- ═══════════════════════════════════════════════════════════════════════
-- 1. email_allowlist — normalized-email access gate
-- ═══════════════════════════════════════════════════════════════════════

create table if not exists screening_v2.email_allowlist (
  id               uuid primary key default gen_random_uuid(),
  email            text not null,  -- canonical ASCII display form (normalized)
  email_normalized text not null,  -- lowercase ASCII canonical key, NO display-name wrapper
  role             text not null default 'viewer',
  active           boolean not null default true,
  linked_user_id   uuid unique references auth.users(id) on delete set null,
  linked_at        timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint chk_email_allowlist_role check (
    role in ('admin', 'interviewer', 'viewer')
  ),
  -- Strict canonical shape: exactly one '@', RFC-lite local part, and the
  -- EXACT company domain (no subdomains, no suffix/unicode tricks).
  constraint chk_email_allowlist_normalized check (
    email_normalized ~ '^[a-z0-9._%+\-]+@interviewkickstart\.com$'
  ),
  constraint uq_email_allowlist_normalized unique (email_normalized),
  constraint chk_email_allowlist_linked_at_consistent check (
    (linked_user_id is null and linked_at is null)
    or (linked_user_id is not null and linked_at is not null)
  )
);

comment on table screening_v2.email_allowlist is
  'HELLO dashboard access allowlist — normalized company email gate. '
  'Independent of auth.users: entries can be provisioned before first login. '
  'Only service_role can touch it (RLS with no anon/authenticated grants). '
  'The API auth middleware calls resolve_allowlist_access on every request; '
  'a disabled/missing entry denies access even with a valid JWT or stale '
  'active membership.';

comment on column screening_v2.email_allowlist.email_normalized is
  'Canonical lowercase ASCII email (trimmed, display-name stripped, exactly '
  'one @, exact domain interviewkickstart.com). UNIQUE — duplicate case/'
  'whitespace variants conflict on insert.';

comment on column screening_v2.email_allowlist.linked_user_id is
  'Supabase auth.users id set atomically on first verified login. UNIQUE — '
  'an entry can never be relinked to a second user. NULL until first login '
  '(pending entry).';

drop trigger if exists trg_v2_allowlist_updated on screening_v2.email_allowlist;
create trigger trg_v2_allowlist_updated before update on screening_v2.email_allowlist
  for each row execute function screening_v2.set_updated_at();

-- Fast canonical lookup for the per-request resolver (unique index already
-- exists via the constraint; this partial index accelerates the admin
-- last-linked-active-admin count and relink checks).
create index if not exists idx_email_allowlist_linked_active_admin
  on screening_v2.email_allowlist (linked_user_id)
  where role = 'admin' and active and linked_user_id is not null;

-- RLS: service-role only. No anon/authenticated policies or grants.
alter table screening_v2.email_allowlist enable row level security;
revoke all on screening_v2.email_allowlist from anon, authenticated, public;
grant all privileges on screening_v2.email_allowlist to service_role;

-- ═══════════════════════════════════════════════════════════════════════
-- 2. Bootstrap — exactly the three confirmed launch admins (active),
--    independent of auth.users
-- ═══════════════════════════════════════════════════════════════════════

insert into screening_v2.email_allowlist (email, email_normalized, role, active)
values
  ('gopu.nair@interviewkickstart.com', 'gopu.nair@interviewkickstart.com', 'admin', true),
  ('christo.b@interviewkickstart.com',  'christo.b@interviewkickstart.com',  'admin', true),
  ('jerin@interviewkickstart.com',      'jerin@interviewkickstart.com',      'admin', true)
on conflict (email_normalized) do nothing;

-- ═══════════════════════════════════════════════════════════════════════
-- 2b. sha256_hex — schema-qualified SHA-256 digest helper
--
-- pgcrypto installs into the `extensions` schema on Supabase (and `public`
-- on plain Postgres). SECURITY DEFINER functions pin search_path to
-- pg_catalog + screening_v2, so a bare `digest()` call is NOT resolvable.
-- This helper pins a search_path that includes BOTH candidates and is
-- called schema-qualified (screening_v2.sha256_hex) from the RPCs — safe
-- on Supabase and on plain Postgres, with no search-path hijack surface
-- (pgcrypto is a trusted extension installed by 0001).
-- ═══════════════════════════════════════════════════════════════════════

create or replace function screening_v2.sha256_hex(p_value text)
returns text
language sql
immutable
security definer
set search_path = pg_catalog, public, extensions
as $$
  select encode(digest(p_value, 'sha256'), 'hex')
$$;

revoke all on function screening_v2.sha256_hex(text) from public, anon, authenticated;
grant execute on function screening_v2.sha256_hex(text) to service_role;

comment on function screening_v2.sha256_hex is
  'Schema-qualified SHA-256 hex digest used for audit correlation. Never '
  'used for passwords or tokens; resolves pgcrypto from public or '
  'extensions regardless of deployment. Service-role-only.';

-- ═══════════════════════════════════════════════════════════════════════
-- 3. resolve_allowlist_access — atomic per-request access resolver/link
--
-- SECURITY DEFINER, fixed search_path (pg_catalog, screening_v2), service-
-- role-only. Called by the API auth middleware on EVERY authenticated
-- request. Normalizes the verified Supabase user email identically to the
-- admin add path, locks the matched entry (FOR UPDATE) to serialize races,
-- and:
--    - denies (status 'denied') when the entry is missing, inactive,
--      domain-mismatched, or already linked to a DIFFERENT user (relink
--      protection);
--    - links on first login (idempotent for the same user);
--    - creates/updates recruiter_memberships from the SERVER-HELD allowlist
--      role/active — never from the client;
--    - audits the link once with an email SHA-256 digest (never the full
--      email).
-- A disabled allowlist entry denies even with a valid old JWT and/or a
-- stale active membership row.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function screening_v2.resolve_allowlist_access(
  p_user_id uuid,
  p_email text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_email text;
  v_domain text;
  v_entry screening_v2.email_allowlist%rowtype;
  v_digest text;
  v_linked boolean := false;
begin
  -- Defensive: never trust the caller for internal state.
  if p_user_id is null or p_email is null or length(btrim(p_email)) = 0 then
    return jsonb_build_object('status', 'denied');
  end if;

  -- Normalize identically to the admin add path (strict ASCII trim+lower,
  -- display-name wrapper stripped, exactly one '@', exact company domain).
  v_email := lower(regexp_replace(btrim(p_email), '^.*<([^<>]+)>$', '\1'));
  if v_email ~ E'[^\\x20-\\x7E]' then
    return jsonb_build_object('status', 'denied');
  end if;
  if v_email !~ '^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$' then
    return jsonb_build_object('status', 'denied');
  end if;
  v_domain := split_part(v_email, '@', 2);
  if v_domain <> 'interviewkickstart.com' then
    return jsonb_build_object('status', 'denied');
  end if;

  -- Lock the matched entry: serializes concurrent first-logins for the same
  -- email and concurrent admin mutations.
  select * into v_entry
    from screening_v2.email_allowlist
   where email_normalized = v_email
   for update;

  if not found then
    return jsonb_build_object('status', 'denied');
  end if;
  if not v_entry.active then
    -- Disabled allowlist denies even with a valid old JWT / stale membership.
    return jsonb_build_object('status', 'denied');
  end if;
  if v_entry.linked_user_id is not null and v_entry.linked_user_id <> p_user_id then
    -- Relink protection: one email, one user, forever.
    return jsonb_build_object('status', 'denied');
  end if;

  -- First-login link (idempotent for the same user).
  if v_entry.linked_user_id is null then
    update screening_v2.email_allowlist
       set linked_user_id = p_user_id,
           linked_at = now(),
           updated_at = now()
     where id = v_entry.id;
    v_linked := true;
  end if;

  -- Create/refresh membership from the SERVER-HELD allowlist role. An admin
  -- role change propagates on the user's next request; a stale membership
  -- row never grants access (the allowlist is the source of truth).
  insert into screening_v2.recruiter_memberships (user_id, role, active)
  values (p_user_id, v_entry.role, v_entry.active)
  on conflict (user_id) do update
    set role = excluded.role,
        active = excluded.active,
        updated_at = now()
    where screening_v2.recruiter_memberships.role is distinct from excluded.role
       or screening_v2.recruiter_memberships.active is distinct from excluded.active;

  -- Audit the link ONCE (append-only). Metadata never contains the full
  -- email — only a SHA-256 hex digest + role.
  if v_linked then
    v_digest := screening_v2.sha256_hex(v_email);
    insert into screening_v2.audit_events
      (actor_id, actor_type, action, target_type, target_id, result, metadata)
    values
      (p_user_id, 'recruiter', 'allowlist_linked', 'allowlist_entry',
       v_entry.id::text, 'success',
       jsonb_build_object('email_digest', v_digest, 'role', v_entry.role));
  end if;

  return jsonb_build_object('status', 'ok', 'role', v_entry.role, 'active', v_entry.active);
end;
$$;

revoke all on function screening_v2.resolve_allowlist_access(uuid, text)
  from public, anon, authenticated;
grant execute on function screening_v2.resolve_allowlist_access(uuid, text)
  to service_role;

comment on function screening_v2.resolve_allowlist_access is
  'Atomic per-request access resolver/link RPC (SECURITY DEFINER, fixed '
  'search_path, service-role-only). Normalizes the verified Supabase email, '
  'locks the allowlist entry, denies missing/inactive/domain-mismatch/'
  'relink, links on first login, and creates/updates recruiter_memberships '
  'from the server-held allowlist role. Audit metadata never contains the '
  'full email. Disabled allowlist denies even with a valid old JWT.';

-- ═══════════════════════════════════════════════════════════════════════
-- 4a. add_allowlist_entry — audited atomic admin add
--     Normalizes identically to the resolver; duplicate case/whitespace
--     variants conflict via the unique normalized index. Audit fail-closed
--     (same transaction). New entries are created ACTIVE.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function screening_v2.add_allowlist_entry(
  p_email text,
  p_role text,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_email text;
  v_domain text;
  v_id uuid;
  v_digest text;
begin
  if p_role is null or p_role not in ('admin', 'interviewer', 'viewer') then
    return jsonb_build_object('status', 'invalid_role');
  end if;
  if p_actor_id is null then
    return jsonb_build_object('status', 'actor_required');
  end if;

  v_email := lower(regexp_replace(btrim(coalesce(p_email, '')), '^.*<([^<>]+)>$', '\1'));
  if v_email ~ E'[^\\x20-\\x7E]' then
    return jsonb_build_object('status', 'invalid_email');
  end if;
  if v_email !~ '^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$' then
    return jsonb_build_object('status', 'invalid_email');
  end if;
  v_domain := split_part(v_email, '@', 2);
  if v_domain <> 'interviewkickstart.com' then
    return jsonb_build_object('status', 'invalid_email');
  end if;

  if exists (
    select 1 from screening_v2.email_allowlist where email_normalized = v_email
  ) then
    return jsonb_build_object('status', 'duplicate');
  end if;

  insert into screening_v2.email_allowlist (email, email_normalized, role, active)
  values (v_email, v_email, p_role, true)
  returning id into v_id;

  v_digest := screening_v2.sha256_hex(v_email);
  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values
    (p_actor_id, 'recruiter', 'admin_allowlist_add', 'allowlist_entry',
     v_id::text, 'success',
     jsonb_build_object('email_digest', v_digest, 'role', p_role));

  return jsonb_build_object('status', 'ok', 'id', v_id);
end;
$$;

revoke all on function screening_v2.add_allowlist_entry(text, text, uuid)
  from public, anon, authenticated;
grant execute on function screening_v2.add_allowlist_entry(text, text, uuid)
  to service_role;

comment on function screening_v2.add_allowlist_entry is
  'Atomic audited admin add (SECURITY DEFINER, fixed search_path, service-'
  'role-only). Normalizes the email identically to resolve_allowlist_access; '
  'rejects non-company/invalid emails (invalid_email) and duplicate '
  'normalized variants (duplicate). Audit row in the same transaction with '
  'an email SHA-256 digest — never the full email. New entries are active.';

-- ═══════════════════════════════════════════════════════════════════════
-- 4b. update_allowlist_entry — audited atomic admin update/disable/demote
--     Guards: an admin cannot self-disable/demote their own linked entry,
--     and cannot remove the last LINKED active admin (pending/unlinked admin
--     entries do not satisfy the safety check). Role/active changes are
--     propagated to the linked membership row atomically. Audit fail-closed
--     (same transaction).
-- ═══════════════════════════════════════════════════════════════════════

create or replace function screening_v2.update_allowlist_entry(
  p_entry_id uuid,
  p_role text,
  p_active boolean,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
as $$
declare
  v_entry screening_v2.email_allowlist%rowtype;
  v_new_role text;
  v_new_active boolean;
  v_linked_active_admins integer;
  v_digest text;
begin
  if p_role is not null and p_role not in ('admin', 'interviewer', 'viewer') then
    return jsonb_build_object('status', 'invalid_role');
  end if;
  if p_role is null and p_active is null then
    return jsonb_build_object('status', 'no_changes');
  end if;

  select * into v_entry
    from screening_v2.email_allowlist
   where id = p_entry_id
   for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  v_new_role := coalesce(p_role, v_entry.role);
  v_new_active := coalesce(p_active, v_entry.active);

  -- Self-modification guard: an admin cannot disable or demote their own
  -- linked entry through this RPC.
  if v_entry.linked_user_id is not null and v_entry.linked_user_id = p_actor_id
     and (v_new_role <> v_entry.role or v_new_active = false) then
    return jsonb_build_object('status', 'self_modification_denied');
  end if;

  -- Last-linked-active-admin guard: ONLY LINKED active admins count.
  -- Pending (unlinked) admin entries do NOT satisfy the safety check.
  if v_entry.role = 'admin' and v_entry.active
     and (v_new_role <> 'admin' or v_new_active = false) then
    select count(*) into v_linked_active_admins
      from screening_v2.email_allowlist
     where role = 'admin' and active and linked_user_id is not null;
    -- The target row is included in the count; subtract it.
    if (v_linked_active_admins - 1) <= 0 then
      return jsonb_build_object('status', 'last_linked_active_admin');
    end if;
  end if;

  update screening_v2.email_allowlist
     set role = v_new_role, active = v_new_active, updated_at = now()
   where id = p_entry_id;

  -- Defense in depth: propagate the change to the linked membership row so a
  -- disabled/demoted entry is reflected immediately (the per-request
  -- resolver denies regardless, but the row should not lie).
  if v_entry.linked_user_id is not null then
    update screening_v2.recruiter_memberships
       set role = v_new_role, active = v_new_active, updated_at = now()
     where user_id = v_entry.linked_user_id;
  end if;

  v_digest := screening_v2.sha256_hex(v_entry.email_normalized);
  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values
    (p_actor_id, 'recruiter', 'admin_allowlist_update', 'allowlist_entry',
     p_entry_id::text, 'success',
     jsonb_build_object('email_digest', v_digest, 'role', v_new_role,
                        'active', v_new_active));

  return jsonb_build_object('status', 'ok');
end;
$$;

revoke all on function screening_v2.update_allowlist_entry(uuid, text, boolean, uuid)
  from public, anon, authenticated;
grant execute on function screening_v2.update_allowlist_entry(uuid, text, boolean, uuid)
  to service_role;

comment on function screening_v2.update_allowlist_entry is
  'Atomic audited admin update/disable/demote (SECURITY DEFINER, fixed '
  'search_path, service-role-only). Advisory FOR UPDATE row lock serialises '
  'concurrent mutations. Cannot self-disable/demote (linked_user_id = '
  'p_actor_id) and cannot remove the last LINKED active admin (pending '
  'unlinked admins do not satisfy the safety check). Changes propagate to '
  'the linked membership row; audit row in the same transaction with an '
  'email SHA-256 digest — never the full email.';

-- ═══════════════════════════════════════════════════════════════════════
-- 5. audit_events action-CHECK evolution (additive, 0016)
--
-- HELLO access-allowlist introduces three underscored audit actions
-- persisted by the DB sink / RPCs: allowlist_linked / admin_allowlist_add /
-- admin_allowlist_update. The CHECK is re-created with the SAME name and
-- the exact 0015 list PLUS the three new actions (sanctioned replaceable
-- data-guard evolution — drop-guarded IF EXISTS + re-create in the same
-- chain; existing rows all satisfy the widened list).
-- ═══════════════════════════════════════════════════════════════════════

alter table screening_v2.audit_events
  drop constraint if exists chk_audit_action;
alter table screening_v2.audit_events
  add constraint chk_audit_action check (
    action in (
      'invite_sent', 'invite_revoked', 'invite_consumed',
      'grant_issued', 'grant_revoked', 'grant_consumed',
      'screening_started', 'screening_completed', 'screening_failed',
      'assessment_recorded',
      'candidate_status_changed', 'candidate_consent_updated',
      'session_created', 'session_updated', 'session_terminated',
      'membership_created', 'membership_updated', 'membership_deactivated',
      'role_created', 'role_updated', 'role_deactivated',
      'export_requested', 'export_completed',
      'login_success', 'login_failure', 'logout',
      'config_changed',
      'auth_login_success', 'auth_login_failure', 'auth_token_refresh', 'auth_logout',
      'rbac_access_denied', 'rbac_ownership_denied',
      'resource_create', 'resource_read', 'resource_update',
      'resource_delete', 'resource_list', 'rate_limit_exceeded',
      'audit_sink_failure', 'audit_configuration_error',
      -- Phase 7 (REC-03/04/05, additive): recording lifecycle audits.
      'recording_download', 'recording_upload', 'recording_integrity_verified',
      'recording_quarantined', 'recording_revoked', 'recording_deleted',
      -- Phase 9 (L2, additive): product-operations audits (underscored —
      -- matches the DB sink's replaceAll('.','_') output).
      'admin_session_override', 'admin_maintenance_toggle', 'admin_member_update',
      'quota_override', 'notification_create', 'appeal_create', 'appeal_review',
      -- HELLO access allowlist (0016, additive): resolver link + admin
      -- allowlist mutations. Metadata never contains the full email —
      -- only a SHA-256 hex digest.
      'allowlist_linked', 'admin_allowlist_add', 'admin_allowlist_update'
    )
  )
  not valid;
alter table screening_v2.audit_events
  validate constraint chk_audit_action;

comment on constraint chk_audit_action on screening_v2.audit_events is
  'Audit action allowlist — extended additively by 0016 with the HELLO '
  'access-allowlist actions (allowlist_linked, admin_allowlist_add, '
  'admin_allowlist_update). Metadata for these actions carries only an '
  'email SHA-256 digest, role, and active — never the full email.';

-- ═══════════════════════════════════════════════════════════════════════
-- Verifier: schema reload notification
-- ═══════════════════════════════════════════════════════════════════════

notify pgrst, 'reload schema';
