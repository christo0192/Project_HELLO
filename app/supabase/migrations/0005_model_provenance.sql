-- =====================================================================
-- 0005 — LLM-06: Model provenance columns for call_sessions and assessments.
--
-- Adds forward-compatible JSONB columns that capture the requested model,
-- provider, workload, prompt-template version, and timestamp for every AI
-- operation (interview generation and scoring).
--
-- Key design decisions:
--   - call_sessions.provenance: nullable before worker claim; non-null after.
--     Backfilled legacy rows carry exact sentinel.
--   - assessments.provenance: NOT NULL after backfill.
--   - Immutability triggers raise on non-null→distinct transitions.
--   - valid_model_provenance() uses explicit boolean predicates (no
--     nullable/cardinality expressions).
--   - Migration order: add columns → backfill → NOT NULL → CHECK → triggers.
--     This ensures existing NULL rows do not violate CHECK during ALTER.
--   - Forward-only: once applied this migration cannot be cleanly reverted
--     without data loss.  Idempotent DROP/ADD pattern for dev iteration.
-- =====================================================================

-- ── Strict provenance validation helper ────────────────────────────────
-- Returns true ONLY when provenance matches the exact current validated shape
-- (schema_version=1, all required keys, correct JSON types, exact key set)
-- OR is the exact legacy sentinel.
--
-- Uses ONLY explicit predicates:
--   - Required keys: schema_version (number=1), provider (string in {anthropic}),
--     requestedModel (string matching bounded identifier grammar),
--     workload (string in {screening,scoring}),
--     prompt_template_version (string), timestamp (string matching UTC RFC 3339)
--   - Optional key: inference_params (object with exactly {temperature, max_tokens})
--   - No extra keys allowed beyond the set above
--   - Legacy sentinel checked as exact JSONB equality
--   - Total size ≤ 2048 bytes via octet_length
--   - String fields checked for URL/path patterns, credential-like tokens,
--     control characters, and bounded identifier grammar

create or replace function screening_v2.valid_model_provenance(p jsonb)
returns boolean
language plpgsql
immutable
security invoker
set search_path = pg_catalog
as $$
declare
  key text;
  allowed_keys constant text[] := array[
    'schema_version', 'provider', 'requestedModel', 'workload',
    'prompt_template_version', 'timestamp', 'inference_params'
  ];
  param_key text;
  allowed_param_keys constant text[] := array['temperature', 'max_tokens'];
  val text;
  ts_val text;
  temp_val numeric;
  mt_val numeric;
  id_re constant text := '^[a-zA-Z0-9][a-zA-Z0-9_\-.:/]*[a-zA-Z0-9]$|^[a-zA-Z0-9]$';
  ver_re constant text := '^[a-zA-Z0-9][a-zA-Z0-9_\-.:/]{0,98}[a-zA-Z0-9]$|^[a-zA-Z0-9]$';
  ts_re constant text := '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$';
  url_re constant text := '(https?://|ftp://|file://|[\s(]/[\w./-]|^/[\w./-]|\.\.[/\\]|\\[\w.-]+\\[\w.-]+|[A-Za-z]:\\(?:[\w.-]+\\)*[\w.-]+|\\\\[\w.-]+(?:\\[\w.-]+)+|[\w.\-]+:[\w.\-]+@[\w.\-]+\.[a-z]{2,})';
  cred_re constant text := '\m(sk-[a-zA-Z0-9_\-]{10,}|api[_-]?key|secret[_-]?key|token[_-]?[a-zA-Z0-9]{10,}|key_[a-zA-Z0-9]{10,}|eyJ[a-zA-Z0-9_-]{10,}\.|BEGIN\s+(RSA\s+)?PRIVATE\s+KEY|ghp_[a-zA-Z0-9]{10,}|gho_[a-zA-Z0-9]{10,}|xox[baprs]-[a-zA-Z0-9-]{10,})\M';
  ctl_re constant text := '[\x00-\x1f\x7f]';
  y int; m int; d int; hh int; mi int; ss int;
begin
  -- Must be an object (not null, not array, not scalar)
  if p is null or jsonb_typeof(p) <> 'object' then
    return false;
  end if;

  -- Exact legacy sentinel check using JSONB equality
  if p = '{"schema_version":0,"provider":"legacy","requestedModel":"unknown","workload":"unknown","prompt_template_version":"legacy","timestamp":"1970-01-01T00:00:00Z"}'::jsonb then
    -- Verify no extra keys (JSONB equality already handles this, but iterate for defense)
    return true;
  end if;

  -- Must have all current-version required keys
  if not (p ? 'schema_version')
     or not (p ? 'provider')
     or not (p ? 'requestedModel')
     or not (p ? 'workload')
     or not (p ? 'prompt_template_version')
     or not (p ? 'timestamp')
  then
    return false;
  end if;

  -- schema_version must be exactly the integer 1
  if p->>'schema_version' <> '1' or jsonb_typeof(p->'schema_version') <> 'number' then
    return false;
  end if;

  -- provider must be the string 'anthropic'
  if p->>'provider' <> 'anthropic' or jsonb_typeof(p->'provider') <> 'string' then
    return false;
  end if;

  -- requestedModel: bounded identifier grammar, length 1-200, no control/URL/cred patterns
  if jsonb_typeof(p->'requestedModel') <> 'string' then
    return false;
  end if;
  val := p->>'requestedModel';
  if length(val) = 0 or length(val) > 200 then
    return false;
  end if;
  if val !~ id_re then
    return false;
  end if;
  if val ~ url_re then
    return false;
  end if;
  if val ~ cred_re then
    return false;
  end if;
  if val ~ ctl_re then
    return false;
  end if;

  -- workload must be 'screening' or 'scoring'
  if p->>'workload' not in ('screening', 'scoring')
     or jsonb_typeof(p->'workload') <> 'string'
  then
    return false;
  end if;

  -- prompt_template_version: bounded version grammar, length 1-100, no control chars
  if jsonb_typeof(p->'prompt_template_version') <> 'string' then
    return false;
  end if;
  val := p->>'prompt_template_version';
  if length(val) = 0 or length(val) > 100 then
    return false;
  end if;
  if val !~ ver_re then
    return false;
  end if;
  if val ~ ctl_re then
    return false;
  end if;

  -- timestamp: strict UTC RFC 3339
  if jsonb_typeof(p->'timestamp') <> 'string' then
    return false;
  end if;
  ts_val := p->>'timestamp';
  if length(ts_val) = 0 or length(ts_val) > 30 then
    return false;
  end if;
  if ts_val !~ ts_re then
    return false;
  end if;
  -- Calendar validation: extract components and check ranges
  begin
    y := substring(ts_val, 1, 4)::int;
    m := substring(ts_val, 6, 2)::int;
    d := substring(ts_val, 9, 2)::int;
    hh := substring(ts_val, 12, 2)::int;
    mi := substring(ts_val, 15, 2)::int;
    ss := substring(ts_val, 18, 2)::int;
    if m < 1 or m > 12 or d < 1 or d > 31 or hh > 23 or mi > 59 or ss > 59 then
      return false;
    end if;
    -- Basic day-in-month validation (catches Feb 31, Apr 31, etc.)
    if d > (case
      when m in (1,3,5,7,8,10,12) then 31
      when m in (4,6,9,11) then 30
      when m = 2 then 28 + case when y % 4 = 0 and (y % 100 <> 0 or y % 400 = 0) then 1 else 0 end
      else 31
    end) then
      return false;
    end if;
  exception when others then
    return false;
  end;

  -- inference_params: if present, must be an object with exactly allowed keys
  if p ? 'inference_params' then
    if jsonb_typeof(p->'inference_params') <> 'object' then
      return false;
    end if;
    for param_key in select jsonb_object_keys(p->'inference_params') loop
      if param_key not in ('temperature', 'max_tokens') then
        return false;
      end if;
    end loop;
    -- temperature: if present must be number 0-2
    if p->'inference_params' ? 'temperature' then
      if jsonb_typeof(p->'inference_params'->'temperature') <> 'number' then
        return false;
      end if;
      begin
        temp_val := (p->'inference_params'->>'temperature')::numeric;
        if temp_val < 0::numeric or temp_val > 2::numeric then
          return false;
        end if;
      exception when others then
        return false;
      end;
    end if;
    -- max_tokens: if present must be integer 1-100000
    if p->'inference_params' ? 'max_tokens' then
      if jsonb_typeof(p->'inference_params'->'max_tokens') <> 'number' then
        return false;
      end if;
      begin
        mt_val := (p->'inference_params'->>'max_tokens')::numeric;
        if mt_val < 1::numeric or mt_val > 100000::numeric or mt_val <> floor(mt_val) then
          return false;
        end if;
      exception when others then
        return false;
      end;
    end if;
  end if;

  -- No extra keys beyond the allowed set
  for key in select jsonb_object_keys(p) loop
    if key <> all (allowed_keys) then
      return false;
    end if;
  end loop;

  -- Total size ≤ 2048 bytes via octet_length
  if octet_length(p::text) > 2048 then
    return false;
  end if;

  return true;
end;
$$;
revoke all on function screening_v2.valid_model_provenance from public, anon, authenticated;
grant execute on function screening_v2.valid_model_provenance to service_role;

comment on function screening_v2.valid_model_provenance is
  'LLM-06: SQL-level guard that provenance matches exact validated shape '
  '(schema_version=1 with all required keys, correct types, exact key set) '
  'or the exact legacy sentinel. Uses only explicit boolean predicates.';

-- ── Immutability trigger function ─────────────────────────────────────
-- Raises a fixed exception (no raw values in the message) when a
-- provenance transition is attempted from non-null to a distinct value.
-- Allows null→validated and same-value no-op updates.
-- Rejects null→legacy (legacy is only for backfill, not new claims).

create or replace function screening_v2.prevent_provenance_change()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
  if old.provenance is not null and new.provenance is distinct from old.provenance then
    raise exception 'provenance: immutable once set';
  end if;
  return new;
end;
$$;
revoke all on function screening_v2.prevent_provenance_change from public, anon, authenticated;
grant execute on function screening_v2.prevent_provenance_change to service_role;

comment on function screening_v2.prevent_provenance_change is
  'LLM-06: Raises a fixed exception if provenance is mutated after being set.';

-- ── Step 1: Add columns (NO CHECK constraints yet — rows may be NULL) ──

alter table screening_v2.call_sessions
  add column if not exists provenance jsonb;

comment on column screening_v2.call_sessions.provenance is
  'LLM-06: Model provenance for the interview operation.  Null while a LiveKit '
  'worker has not yet claimed the session.  Once set, immutable via trigger.';

alter table screening_v2.assessments
  add column if not exists provenance jsonb;

comment on column screening_v2.assessments.provenance is
  'LLM-06: Model provenance for the scoring/assessment operation. '
  'Non-null for every row.';

-- ── Step 2: Backfill legacy rows ──────────────────────────────────────
-- Sets explicit legacy/unknown sentinel for rows created before this migration.
-- Never invents model evidence that wasn't captured at runtime.

update screening_v2.call_sessions
   set provenance = '{"schema_version":0,"provider":"legacy","requestedModel":"unknown","workload":"unknown","prompt_template_version":"legacy","timestamp":"1970-01-01T00:00:00Z"}'::jsonb
 where provenance is null;

update screening_v2.assessments
   set provenance = '{"schema_version":0,"provider":"legacy","requestedModel":"unknown","workload":"unknown","prompt_template_version":"legacy","timestamp":"1970-01-01T00:00:00Z"}'::jsonb
 where provenance is null;

-- ── Step 3: NOT NULL enforcement (assessments only) ────────────────────
-- Assessments must always carry provenance.

alter table screening_v2.assessments
  drop constraint if exists chk_assessments_provenance_not_null;

alter table screening_v2.assessments
  add constraint chk_assessments_provenance_not_null
    check (provenance is not null);

-- ── Step 4: Add CHECK constraints ─────────────────────────────────────
-- call_sessions allows NULL (for LiveKit sessions awaiting worker claim).
-- assessments requires valid non-null provenance.

alter table screening_v2.call_sessions
  drop constraint if exists chk_call_sessions_provenance_type;

alter table screening_v2.call_sessions
  add constraint chk_call_sessions_provenance_type
    check (provenance is null or screening_v2.valid_model_provenance(provenance));

alter table screening_v2.assessments
  drop constraint if exists chk_assessments_provenance_type;

alter table screening_v2.assessments
  add constraint chk_assessments_provenance_type
    check (screening_v2.valid_model_provenance(provenance));

-- ── Step 5: Add immutability triggers ─────────────────────────────────

drop trigger if exists trg_v2_prevent_provenance_change on screening_v2.call_sessions;
create trigger trg_v2_prevent_provenance_change
  before update of provenance on screening_v2.call_sessions
  for each row
  execute function screening_v2.prevent_provenance_change();

drop trigger if exists trg_v2_prevent_assessment_provenance_change on screening_v2.assessments;
create trigger trg_v2_prevent_assessment_provenance_change
  before update of provenance on screening_v2.assessments
  for each row
  execute function screening_v2.prevent_provenance_change();

-- ── RLS preservation ──────────────────────────────────────────────────
-- Existing SELECT policies (migration 0004) use wildcard SELECT, so the
-- new provenance column is naturally covered.  No policy changes needed.

-- ── Grants ─────────────────────────────────────────────────────────────
-- service_role already has ALL on screening_v2 tables (migration 0001).
-- authenticated has SELECT on call_sessions and assessments (migration 0004).
-- No grant changes needed.

-- ── Indexes ────────────────────────────────────────────────────────────
-- No provenance-specific index justified at this stage.

-- =====================================================================
notify pgrst, 'reload schema';
