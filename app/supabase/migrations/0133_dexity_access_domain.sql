-- =====================================================================
-- 0133 — Company domain switch: accept @dexity.com alongside
--        @interviewkickstart.com, keep people's access when their login's
--        email changes, and let an admin hand a person's records over to
--        a new login.
--
-- WHY. The company is moving staff email from interviewkickstart.com to
-- dexity.com. 0016 pinned the dashboard access gate to the single domain
-- interviewkickstart.com in three places (the CHECK on
-- email_allowlist.email_normalized, resolve_allowlist_access, and
-- add_allowlist_entry), so the day staff emails change every recruiter and
-- admin would be denied. IT has not decided HOW accounts move, so this
-- migration supports both outcomes:
--
--   A. SAME LOGIN, RENAMED. The Google Workspace account is renamed. The
--      Supabase user (same id) now presents name@dexity.com, which has no
--      allowlist entry, while its old entry is still linked to that same
--      user id. The resolver now carries the person through: it moves the
--      linked entry to the new address (email_updated). If an admin had
--      already added the new address as a pending entry, the link moves to
--      that entry and the old entry is retired (link_moved).
--   B. BRAND-NEW LOGIN. A different Supabase user signs in with
--      name@dexity.com. An admin adds that address (now accepted) and the
--      first login links it, exactly as before. Interviewers see only rows
--      they own, so handover_allowlist_records moves the OWNERSHIP columns
--      (owner_id on roles, ashby_job_mappings, role_drafts, candidates,
--      call_sessions; created_by on interview_rounds, which R1 uses as its
--      owner) from the old login to the new one. Pure history columns
--      (actor_id, placed_by, reviewer_id, ...) and audit_events are NOT
--      rewritten: they record who did what, and that stays true.
--
-- WHAT IS UNCHANGED. Every 0016 denial still holds: unverified or malformed
-- email, a domain outside the accepted set, a missing or disabled entry,
-- and an address already linked to a DIFFERENT login (relink protection).
-- Continuity never creates access: it only follows a login that an admin
-- already granted and has NOT disabled.
--
-- PROOF OF THE NEW ADDRESS. A Supabase user can change their own
-- auth.users email through the public Auth API, so the presented email
-- alone never proves a rename. Both continuity paths therefore also require
-- the new address to be the verified email of a GOOGLE identity of this same
-- login (auth.identities, provider 'google'). That record is written by
-- Supabase from Google's own sign-in, and its email is set by the Workspace
-- admin, never by the user. A login without that proof gets 0016's answer:
-- denied (0016 failed the same case on the linked_user_id UNIQUE).
-- Operational assumptions, stated in the runbook: Supabase "manual identity
-- linking" stays OFF (config.toml enable_manual_linking = false), and email
-- confirmation / secure email change stay ON in production.
--
-- DROPPING THE OLD DOMAIN LATER is a follow-up migration: narrow
-- is_access_email_domain and the CHECK once nobody signs in with it.
--
-- AUDIT. No new audit action. chk_audit_action is pinned to 0114 as its last
-- re-creation, so the resolver writes the existing 'allowlist_linked' (with
-- a `change` key for the two continuity cases) and the handover writes the
-- existing 'admin_member_update' (change = 'records_handover'). Metadata
-- never contains a full email, only SHA-256 digests (0016 rule).
--
-- LOCKING. The CHECK re-creation takes ACCESS EXCLUSIVE on email_allowlist
-- (a handful of rows) until COMMIT; the per-request resolver waits for it.
-- The resolver now locks the address's entry AND the login's current entry
-- in one statement ordered by id, so two concurrent requests for the same
-- person lock in the same order.
--
-- Forward-only. CHECK re-created NOT VALID then VALIDATE'd (0014/0015/0016
-- pattern). No reverse SQL.
-- =====================================================================

-- ═══════════════════════════════════════════════════════════════════════
-- 1. is_access_email_domain — the accepted company domains, in one place
--    for the two RPCs below. (The CHECK in §2 states the same set inline:
--    a CHECK runs with the inserting role's privileges, and this helper is
--    service-role only.)
-- ═══════════════════════════════════════════════════════════════════════

create or replace function screening_v2.is_access_email_domain(p_domain text)
returns boolean
language sql
immutable
set search_path = pg_catalog
as $$
  select coalesce(p_domain in ('interviewkickstart.com', 'dexity.com'), false);
$$;

revoke all on function screening_v2.is_access_email_domain(text)
  from public, anon, authenticated;
grant execute on function screening_v2.is_access_email_domain(text)
  to service_role;

comment on function screening_v2.is_access_email_domain is
  'Accepted company email domains for dashboard access: exact match on '
  'interviewkickstart.com or dexity.com (no subdomains, no suffixes). Used '
  'by resolve_allowlist_access and add_allowlist_entry. Narrow it (and '
  'chk_email_allowlist_normalized) in a new migration to drop a domain.';

-- ═══════════════════════════════════════════════════════════════════════
-- 2. chk_email_allowlist_normalized — both domains, still exact
-- ═══════════════════════════════════════════════════════════════════════

alter table screening_v2.email_allowlist
  drop constraint if exists chk_email_allowlist_normalized;
alter table screening_v2.email_allowlist
  add constraint chk_email_allowlist_normalized check (
    email_normalized ~ '^[a-z0-9._%+\-]+@(interviewkickstart|dexity)\.com$'
  ) not valid;
alter table screening_v2.email_allowlist
  validate constraint chk_email_allowlist_normalized;

comment on column screening_v2.email_allowlist.email_normalized is
  'Canonical lowercase ASCII email (trimmed, display-name stripped, exactly '
  'one @, exact domain interviewkickstart.com or dexity.com since 0133). '
  'UNIQUE — duplicate case/whitespace variants conflict on insert. The '
  'resolver may move it to the same login''s new verified address (0133).';

-- ═══════════════════════════════════════════════════════════════════════
-- 3. resolve_allowlist_access — both domains + same-login continuity
--
-- Normalization is 0016's, unchanged. Decision table, where E is the entry
-- for the presented address, P is the entry already linked to this login
-- under a different address, and G means "the presented address is the
-- verified email of a Google identity of this login":
--
--   E disabled                              -> denied
--   E linked to another login               -> denied (relink protection)
--   E linked to this login                  -> ok
--   E pending, no P                         -> link E (first login, 0016)
--   E pending, P active, G                  -> move the link to E, retire P
--   E pending, P disabled or not G          -> denied
--   no E, P active, G                       -> move P to the new address
--   no E, otherwise                         -> denied
--
-- Retiring P: unlinked, disabled AND demoted to viewer, so re-enabling it by
-- mistake can never hand a recycled old address its former role. A move
-- never leaves zero linked active admins: if P is the last one and E's role
-- is lower, E keeps admin (recorded in the audit row as role_kept_admin).
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
  v_prior screening_v2.email_allowlist%rowtype;
  v_has_entry boolean;
  v_has_prior boolean;
  v_google_proof boolean;
  v_role_kept_admin boolean := false;
  v_change text := null;  -- null | 'linked' | 'link_moved' | 'email_updated'
  v_metadata jsonb;
begin
  -- Defensive: never trust the caller for internal state.
  if p_user_id is null or p_email is null or length(btrim(p_email)) = 0 then
    return jsonb_build_object('status', 'denied');
  end if;

  -- Normalize identically to the admin add path (0016): strict ASCII
  -- trim+lower, display-name wrapper stripped, exactly one '@', accepted
  -- company domain.
  v_email := lower(regexp_replace(btrim(p_email), '^.*<([^<>]+)>$', '\1'));
  if v_email ~ E'[^\\x20-\\x7E]' then
    return jsonb_build_object('status', 'denied');
  end if;
  if v_email !~ '^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$' then
    return jsonb_build_object('status', 'denied');
  end if;
  v_domain := split_part(v_email, '@', 2);
  if not screening_v2.is_access_email_domain(v_domain) then
    return jsonb_build_object('status', 'denied');
  end if;

  -- Lock both candidate rows in ONE statement, ordered by id, so concurrent
  -- requests for the same person (and concurrent admin mutations) always
  -- take the locks in the same order.
  perform 1
     from screening_v2.email_allowlist
    where email_normalized = v_email
       or linked_user_id = p_user_id
    order by id
      for update;

  -- Re-read WITH the lock: a row committed between the PERFORM above and
  -- these reads is locked here too, so its `active` cannot change under us.
  select * into v_entry
    from screening_v2.email_allowlist
   where email_normalized = v_email
     for update;
  v_has_entry := found;

  select * into v_prior
    from screening_v2.email_allowlist
   where linked_user_id = p_user_id
     and email_normalized <> v_email
     for update;
  v_has_prior := found;

  if v_has_entry then
    if not v_entry.active then
      -- Disabled allowlist denies even with a valid old JWT / stale membership.
      return jsonb_build_object('status', 'denied');
    end if;
    if v_entry.linked_user_id is not null and v_entry.linked_user_id <> p_user_id then
      -- Relink protection: one address, one login, forever.
      return jsonb_build_object('status', 'denied');
    end if;
  end if;

  -- Continuity (P exists and the presented address is not P's) needs P
  -- still active AND Google's proof that the new address is this login's.
  if v_has_prior and (not v_has_entry or v_entry.linked_user_id is null) then
    if not v_prior.active then
      return jsonb_build_object('status', 'denied');
    end if;
    -- The identity must be a verified, ASCII address equal to the presented
    -- one, AND belong to a company Google Workspace: GoTrue copies Google's
    -- server-side `hd` (hosted domain) claim into custom_claims, and a
    -- personal ("unmanaged") Google account carrying a company address has
    -- none. hd may be the Workspace's primary domain rather than the
    -- address's, so it must be an accepted domain, not equal to v_domain.
    select exists (
      select 1
        from auth.identities i
       where i.user_id = p_user_id
         and i.provider = 'google'
         and (i.identity_data->>'email') !~ E'[^\\x20-\\x7E]'
         and lower(btrim(i.identity_data->>'email')) = v_email
         and (i.identity_data->>'email_verified') = 'true'
         and screening_v2.is_access_email_domain(
               lower(btrim(i.identity_data->'custom_claims'->>'hd')))
    ) into v_google_proof;
    if not v_google_proof then
      return jsonb_build_object('status', 'denied');
    end if;
  end if;

  if v_has_entry then
    if v_entry.linked_user_id is null then
      if v_has_prior then
        -- Same login, Google-verified new address an admin pre-provisioned.
        -- Never leave zero linked active admins: if P is the last one and
        -- E's role is lower, E keeps admin. The advisory lock serialises two
        -- last admins moving at the same moment (each would otherwise count
        -- the other and both be demoted); it is taken only on this rare path.
        if v_prior.role = 'admin' and v_entry.role <> 'admin' then
          perform pg_advisory_xact_lock(hashtext('screening_v2.allowlist_last_admin_guard'));
        end if;
        if v_prior.role = 'admin' and v_entry.role <> 'admin'
           and not exists (
             select 1
               from screening_v2.email_allowlist
              where role = 'admin' and active and linked_user_id is not null
                and id <> v_prior.id
           ) then
          v_entry.role := 'admin';
          v_role_kept_admin := true;
        end if;

        -- Retire the old entry first (linked_user_id is UNIQUE), then link.
        -- DISABLED and demoted to viewer, not left pending: a recycled old
        -- address must never inherit this person's access or role.
        update screening_v2.email_allowlist
           set linked_user_id = null,
               linked_at = null,
               active = false,
               role = 'viewer',
               updated_at = now()
         where id = v_prior.id;
        v_change := 'link_moved';
      else
        v_change := 'linked';
      end if;

      update screening_v2.email_allowlist
         set linked_user_id = p_user_id,
             linked_at = now(),
             role = v_entry.role,
             updated_at = now()
       where id = v_entry.id;
    end if;
  else
    -- No entry for this address. Continue only for a login an admin already
    -- granted (P active and Google proof, both checked above).
    if not v_has_prior then
      return jsonb_build_object('status', 'denied');
    end if;

    update screening_v2.email_allowlist
       set email = v_email,
           email_normalized = v_email,
           updated_at = now()
     where id = v_prior.id;

    v_entry := v_prior;
    v_entry.email_normalized := v_email;
    v_change := 'email_updated';
  end if;

  -- Create/refresh membership from the SERVER-HELD allowlist role (0016).
  insert into screening_v2.recruiter_memberships (user_id, role, active)
  values (p_user_id, v_entry.role, v_entry.active)
  on conflict (user_id) do update
    set role = excluded.role,
        active = excluded.active,
        updated_at = now()
    where screening_v2.recruiter_memberships.role is distinct from excluded.role
       or screening_v2.recruiter_memberships.active is distinct from excluded.active;

  -- Audit every link change ONCE (append-only). A plain first login keeps
  -- 0016's exact metadata; the continuity cases add `change` and the prior
  -- address's digest. Never a full email.
  if v_change is not null then
    v_metadata := jsonb_build_object(
      'email_digest', screening_v2.sha256_hex(v_email),
      'role', v_entry.role
    );
    if v_change <> 'linked' then
      v_metadata := v_metadata || jsonb_build_object(
        'change', v_change,
        'previous_email_digest', screening_v2.sha256_hex(v_prior.email_normalized)
      );
      if v_change = 'link_moved' then
        v_metadata := v_metadata || jsonb_build_object('previous_entry_id', v_prior.id::text);
        if v_role_kept_admin then
          v_metadata := v_metadata || jsonb_build_object('role_kept_admin', true);
        end if;
      end if;
    end if;

    insert into screening_v2.audit_events
      (actor_id, actor_type, action, target_type, target_id, result, metadata)
    values
      (p_user_id, 'recruiter', 'allowlist_linked', 'allowlist_entry',
       v_entry.id::text, 'success', v_metadata);
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
  'accepts interviewkickstart.com or dexity.com (0133), locks the address''s '
  'entry and the login''s current entry, denies missing/inactive/domain-'
  'mismatch/relink, links on first login, and (0133) carries an already-'
  'granted login to its new verified address. Creates/updates '
  'recruiter_memberships from the server-held allowlist role. Audit '
  'metadata never contains a full email.';

-- ═══════════════════════════════════════════════════════════════════════
-- 4. add_allowlist_entry — 0016 verbatim except the domain test
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
  if not screening_v2.is_access_email_domain(v_domain) then
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
  'rejects invalid emails and domains other than interviewkickstart.com / '
  'dexity.com (invalid_email) and duplicate normalized variants '
  '(duplicate). Audit row in the same transaction with an email SHA-256 '
  'digest — never the full email. New entries are active.';

-- ═══════════════════════════════════════════════════════════════════════
-- 5. handover_allowlist_records — move one login's OWNED rows to another
--
-- For outcome B (brand-new login). Both entries must be linked (the new
-- person has signed in once, so their login id is known) and the target
-- must be active. Moves exactly the ownership columns the API scopes
-- interviewers by: owner_id on roles, ashby_job_mappings, role_drafts,
-- candidates and call_sessions, and interview_rounds.created_by — which is
-- ownership too: r1.ts roundAccess lets an interviewer manage a round only
-- when created_by is them, and 0131 stamps new R1 sessions' owner_id from
-- it. Running Ask-Hello drafts stay put: at most one running draft per owner
-- is a unique index (0101) and they settle in minutes. Who-did-what history
-- lives in audit_events and is not rewritten.
--
-- LOCKS. Tables are updated in the system's pinned order (an R1 round
-- before its candidate, as the 0122 scorer does; call_sessions LAST, as in
-- 0114), and lock_timeout makes the function fail fast instead of queueing
-- behind live traffic; run it when no call or interview is live (runbook).
-- Idempotent: a second call moves nothing and reports zeros. The admin
-- check is the API's requireAdmin; the actor is recorded in the audit row.
-- ═══════════════════════════════════════════════════════════════════════

create or replace function screening_v2.handover_allowlist_records(
  p_from_entry_id uuid,
  p_to_entry_id uuid,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, screening_v2
set lock_timeout = '5s'
as $$
declare
  v_from screening_v2.email_allowlist%rowtype;
  v_to screening_v2.email_allowlist%rowtype;
  v_roles integer := 0;
  v_candidates integer := 0;
  v_sessions integer := 0;
  v_mappings integer := 0;
  v_drafts integer := 0;
  v_rounds integer := 0;
  v_moved jsonb;
begin
  if p_actor_id is null then
    return jsonb_build_object('status', 'actor_required');
  end if;
  if p_from_entry_id is null or p_to_entry_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  if p_from_entry_id = p_to_entry_id then
    return jsonb_build_object('status', 'same_entry');
  end if;

  -- Lock both entries in id order: a concurrent disable/relink of either
  -- waits for this handover to commit.
  perform 1
     from screening_v2.email_allowlist
    where id in (p_from_entry_id, p_to_entry_id)
    order by id
      for update;

  select * into v_from from screening_v2.email_allowlist where id = p_from_entry_id;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  select * into v_to from screening_v2.email_allowlist where id = p_to_entry_id;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_from.linked_user_id is null then
    return jsonb_build_object('status', 'from_not_linked');
  end if;
  if v_to.linked_user_id is null then
    return jsonb_build_object('status', 'to_not_linked');
  end if;
  if not v_to.active then
    return jsonb_build_object('status', 'to_inactive');
  end if;

  update screening_v2.roles
     set owner_id = v_to.linked_user_id
   where owner_id = v_from.linked_user_id;
  get diagnostics v_roles = row_count;

  update screening_v2.ashby_job_mappings
     set owner_id = v_to.linked_user_id
   where owner_id = v_from.linked_user_id;
  get diagnostics v_mappings = row_count;

  update screening_v2.role_drafts
     set owner_id = v_to.linked_user_id
   where owner_id = v_from.linked_user_id
     and status <> 'running';
  get diagnostics v_drafts = row_count;

  update screening_v2.interview_rounds
     set created_by = v_to.linked_user_id
   where created_by = v_from.linked_user_id;
  get diagnostics v_rounds = row_count;

  update screening_v2.candidates
     set owner_id = v_to.linked_user_id
   where owner_id = v_from.linked_user_id;
  get diagnostics v_candidates = row_count;

  update screening_v2.call_sessions
     set owner_id = v_to.linked_user_id
   where owner_id = v_from.linked_user_id;
  get diagnostics v_sessions = row_count;

  v_moved := jsonb_build_object(
    'roles', v_roles,
    'candidates', v_candidates,
    'call_sessions', v_sessions,
    'ashby_job_mappings', v_mappings,
    'role_drafts', v_drafts,
    'interview_rounds', v_rounds
  );

  insert into screening_v2.audit_events
    (actor_id, actor_type, action, target_type, target_id, result, metadata)
  values
    (p_actor_id, 'recruiter', 'admin_member_update', 'allowlist_entry',
     v_from.id::text, 'success',
     jsonb_build_object(
       'change', 'records_handover',
       'to_entry_id', v_to.id::text,
       'from_email_digest', screening_v2.sha256_hex(v_from.email_normalized),
       'to_email_digest', screening_v2.sha256_hex(v_to.email_normalized),
       'moved', v_moved
     ));

  return jsonb_build_object('status', 'ok', 'moved', v_moved);
end;
$$;

revoke all on function screening_v2.handover_allowlist_records(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function screening_v2.handover_allowlist_records(uuid, uuid, uuid)
  to service_role;

comment on function screening_v2.handover_allowlist_records is
  'Admin handover (0133, SECURITY DEFINER, fixed search_path, lock_timeout '
  '5s, service-role-only): moves owner_id on roles, ashby_job_mappings, '
  'non-running role_drafts, candidates and call_sessions, and '
  'interview_rounds.created_by, from one linked allowlist login to another '
  'active linked login. audit_events history is untouched. '
  'Statuses: ok (+moved counts), not_found, same_entry, from_not_linked, '
  'to_not_linked, to_inactive, actor_required. Audited as '
  'admin_member_update with change=records_handover and email digests only.';

notify pgrst, 'reload schema';
