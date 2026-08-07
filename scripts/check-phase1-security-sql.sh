#!/usr/bin/env bash
# Static adversarial negative tests for Phase 1 (migration 0007).
set -euo pipefail
cd "$(dirname "$0")/.."

PASS=0; FAIL=0
pass() { PASS=$((PASS+1)); echo "  PASS: $*"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL: $*"; }

M="app/supabase/migrations/0007_invites_audit_rbac.sql"
C="app/supabase/config.toml"
PT="app/supabase/tests/policy_tests.sql"

[ -f "$M" ] || { fail "Migration file missing"; exit 1; }
[ -f "$C" ] || { fail "Config file missing"; exit 1; }
[ -f "$PT" ] || { fail "Policy tests file missing"; exit 1; }

# Helper: count regex matches in file (grep -c returns 0 and exit 1 on no match)
cnt() { grep -cE "$1" "$2" 2>/dev/null || true; }
has_ge() { [ "$(cnt "$2" "$1")" -ge "${3:-1}" ]; }

# ============ 1. Token integrity ============
echo "=== 1. Token column integrity ==="

# No plaintext token column (token preceded by only whitespace)
BAD_TOKEN=$(grep -cE '^[[:space:]]+token[[:space:]]+' "$M" || true)
TOKEN_DIGEST_CT=$(grep -cE '^[[:space:]]+token_digest[[:space:]]+' "$M" || true)
BAD_TOKEN=$((BAD_TOKEN - TOKEN_DIGEST_CT))
[ "$BAD_TOKEN" -le 0 ] && pass "No plaintext token column" || fail "Found $BAD_TOKEN plaintext token column(s)"

# Bad column names
for col in token_plaintext secret auth_code password; do
  FOUND=$(grep -cE "^[[:space:]]+${col}[[:space:]]+" "$M" || true)
  [ "$FOUND" -eq 0 ] && pass "No column named '$col'" || fail "Column named '$col' found ($FOUND)"
done

# SHA-256 CHECK constraints
has_ge "$M" "chk_invite_token_digest" 1 \
  && pass "candidate_invites token_digest CHECK constraint" \
  || fail "candidate_invites token_digest CHECK constraint missing"
has_ge "$M" "chk_grant_token_digest" 1 \
  && pass "candidate_access_grants token_digest CHECK constraint" \
  || fail "candidate_access_grants token_digest CHECK constraint missing"

# UNIQUE on token_digest
has_ge "$M" "uq_candidate_invites_digest" 1 \
  && pass "UNIQUE on candidate_invites token_digest" \
  || fail "UNIQUE on candidate_invites token_digest missing"
has_ge "$M" "uq_candidate_grants_digest" 1 \
  && pass "UNIQUE on candidate_access_grants token_digest" \
  || fail "UNIQUE on candidate_access_grants token_digest missing"

# Invite constraints
has_ge "$M" "chk_invite_expires_after_created" 1 \
  && pass "expires_at > created_at constraint" \
  || fail "expires_at > created_at constraint missing"
has_ge "$M" "chk_invite_token_use" 1 \
  && pass "revoked/consumed mutual exclusion" \
  || fail "revoked/consumed mutual exclusion missing"

# ============ 2. Audit table ============
echo "=== 2. Audit append-only ==="

has_ge "$M" "trg_audit_prevent_update" 1 \
  && pass "UPDATE prevention trigger" \
  || fail "UPDATE prevention trigger missing"
has_ge "$M" "trg_audit_prevent_delete" 1 \
  && pass "DELETE prevention trigger" \
  || fail "DELETE prevention trigger missing"
has_ge "$M" "allow_audit_mutation" 1 \
  && pass "Escape hatch (allow_audit_mutation)" \
  || fail "Escape hatch missing"

for c in chk_audit_actor_type chk_audit_action chk_audit_result chk_audit_metadata_size; do
  has_ge "$M" "$c" 1 && pass "Constraint '$c'" || fail "Constraint '$c' missing"
done

# No PII columns — check for exact column-name pattern at start of line
for pii in transcript resume_text phone name address ssn; do
  F=$(grep -cE "^[[:space:]]+${pii}[[:space:]]+" "$M" || true)
  [ "$F" -eq 0 ] && pass "No '$pii' column" || fail "Column '$pii' found ($F matches)"
done

# ============ 3. Owner_id ============
echo "=== 3. Ownership scope ==="

OWNER_COUNT=$(grep -c "add column if not exists owner_id" "$M" || true)
[ "$OWNER_COUNT" -ge 3 ] \
  && pass "owner_id added to 3+ tables" \
  || fail "owner_id added to $OWNER_COUNT tables (expected 3)"

for idx in idx_v2_roles_owner idx_v2_candidates_owner idx_v2_sessions_owner; do
  has_ge "$M" "$idx" 1 && pass "Index '$idx'" || fail "Index '$idx' missing"
done

# No org_id — check the literal string "org_id" (not in variables or comments)
ORG_COUNT=$(grep -w 'org_id' "$M" | grep -v 'org_id' | wc -l || true)
# Simpler: just count explicit occurrences
ORG_COUNT=$(grep -c 'org_id' "$M" || true)
[ "$ORG_COUNT" -eq 0 ] \
  && pass "No org_id (single-tenant preserved)" \
  || fail "org_id found ($ORG_COUNT occurrences)"

# Role-aware helpers
for fn in _is_admin_or_viewer _is_interviewer recruiter_role; do
  has_ge "$M" "$fn" 1 && pass "Helper '$fn'" || fail "Helper '$fn' missing"
done

# Scoped policies
for pol in "scoped recruiter read roles" "scoped recruiter read candidates" "scoped recruiter read call_sessions"; do
  has_ge "$M" "$pol" 1 && pass "Policy '$pol'" || fail "Policy '$pol' missing"
done

# Transcript/assessments still have old active recruiter policies
has_ge "$M" "active recruiter read transcript_turns" 1 \
  && pass "transcript_turns retains active recruiter read policy" \
  || fail "transcript_turns policy missing"
has_ge "$M" "active recruiter read assessments" 1 \
  && pass "assessments retains active recruiter read policy" \
  || fail "assessments policy missing"

# ============ REC-05 recording_object_key ============
echo "=== REC-05 recording_object key ==="

has_ge "$M" "recording_object_key" 1 \
  && pass "recording_object_key column added" \
  || fail "recording_object_key column missing"

has_ge "$M" "chk_call_sessions_recording_obj_key" 1 \
  && pass "recording_object_key CHECK constraint defined" \
  || fail "recording_object_key CHECK constraint missing"

has_ge "$M" "idx_v2_sessions_recording_key" 1 \
  && pass "recording_object_key partial index defined" \
  || fail "recording_object_key partial index missing"

# No signed URL column persisted
for badcol in recording_signed_url recording_presigned_url recording_url_ttl; do
  FOUND=$(grep -c "$badcol" "$M" || true)
  [ "$FOUND" -eq 0 ] && pass "No column '$badcol'" || fail "Column '$badcol' found"
done


# ============ 4. RLS and grants ============
echo "=== 4. RLS and grants ==="

# RLS enabled on new tables
for tbl in candidate_invites candidate_access_grants audit_events; do
  has_ge "$M" "screening_v2.${tbl}" 1 && pass "Table '$tbl' exists with RLS" \
    || fail "Table '$tbl' not found"
done

# Invite/grant digest tables are server-only: no authenticated policy.
if tr '\n' ' ' < "$M" \
  | grep -Eq 'create policy[^;]+on screening_v2\.(candidate_invites|candidate_access_grants)[^;]+to authenticated'; then
  fail "Invite/grant tables contain an authenticated policy"
else
  pass "Invite/grant tables have no authenticated policy"
fi
has_ge "$M" "recruiter read audit_events" 1 \
  && pass "Policy 'recruiter read audit_events' in migration" \
  || fail "Audit read policy missing in migration"

for marker in "candidate_invites has no authenticated policy" \
              "candidate_access_grants has no authenticated policy" \
              "recruiter read audit_events"; do
  has_ge "$PT" "$marker" 1 && pass "Test coverage for '$marker'" \
    || fail "Test coverage for '$marker' missing"
done

# Grants table PostgREST isolation
has_ge "$M" "Never exposed through PostgREST" 1 \
  && pass "candidate_access_grants PostgREST isolation documented" \
  || fail "candidate_access_grants PostgREST isolation not documented"

# ============ 5. Config.toml ============
echo "=== 5. Config.toml ==="

# Public signup disabled
has_ge "$C" "^enable_signup = false" 1 \
  && pass "Public signup disabled" \
  || fail "Public signup not disabled"

# ── ADR-0011 invariant: no second factor of any kind ────────────────
#
# Extract a TOML section by header, from the header line up to (but not
# including) the next top-level/sub-table header. Unlike `grep -A<n>` this
# cannot silently truncate when a section grows, and it returns EMPTY when
# the section is absent — so a missing section can never satisfy a check.
section() {
  awk -v want="$1" '
    /^[[:space:]]*\[/ { inside = ($0 ~ "^[[:space:]]*\\[" want "\\][[:space:]]*$") ? 1 : 0; next }
    inside { print }
  ' "$2"
}

# Assert `key = false` inside a section that MUST exist. Fails closed on a
# missing section, a missing key, a malformed value, or `true`.
assert_key_false() {
  local sec="$1" key="$2" label="$3" body
  body=$(section "$sec" "$C")
  if [ -z "$(printf '%s' "$body" | tr -d '[:space:]')" ]; then
    fail "$label — [$sec] section missing or empty in $C"
    return
  fi
  local line
  line=$(printf '%s\n' "$body" | grep -E "^[[:space:]]*${key}[[:space:]]*=" | head -1 || true)
  if [ -z "$line" ]; then
    fail "$label — '$key' not declared in [$sec]"
  elif printf '%s' "$line" | grep -qE "^[[:space:]]*${key}[[:space:]]*=[[:space:]]*false[[:space:]]*$"; then
    pass "$label"
  else
    fail "$label — '$key' is not exactly false in [$sec] (got: $(printf '%s' "$line" | tr -s '[:space:]' ' '))"
  fi
}

# TOTP: enrollment AND verification disabled. Both must be off together —
# leaving verification on while enrollment is off (or vice versa) lets
# enrollment state diverge from enforcement.
assert_key_false "auth.mfa.totp" "enroll_enabled" "TOTP enroll disabled (ADR-0011)"
assert_key_false "auth.mfa.totp" "verify_enabled" "TOTP verify disabled (ADR-0011)"

# Phone/SMS: enrollment AND verification disabled.
assert_key_false "auth.mfa.phone" "enroll_enabled" "Phone MFA enroll disabled (ADR-0011)"
assert_key_false "auth.mfa.phone" "verify_enabled" "Phone MFA verify disabled (ADR-0011)"

# Guard against a factor type being re-enabled anywhere under [auth.mfa.*]
# (e.g. an uncommented [auth.mfa.web_authn] block).
ENABLED_FACTOR=$(awk '
  /^[[:space:]]*\[/ { inside = ($0 ~ /^[[:space:]]*\[auth\.mfa\./) ? 1 : 0; next }
  inside && /^[[:space:]]*(enroll_enabled|verify_enabled)[[:space:]]*=[[:space:]]*true[[:space:]]*$/ { print }
' "$C" || true)
[ -z "$ENABLED_FACTOR" ] \
  && pass "No MFA factor type enables enroll/verify (ADR-0011)" \
  || fail "An [auth.mfa.*] factor still enables enroll/verify: $(printf '%s' "$ENABLED_FACTOR" | tr -s '[:space:]' ' ')"

# Session timeouts — RETAINED. Shorter-lived sessions are load-bearing now
# that a single factor guards access (ADR-0011 § Controls retained).
SESS_SECTION=$(section "auth.sessions" "$C")
if [ -z "$(printf '%s' "$SESS_SECTION" | tr -d '[:space:]')" ]; then
  fail "[auth.sessions] section missing or empty in $C"
  fail "Session timebox not set"
  fail "Session inactivity_timeout not set"
else
  pass "[auth.sessions] section exists"
  printf '%s\n' "$SESS_SECTION" | grep -qE '^[[:space:]]*timebox[[:space:]]*=[[:space:]]*".+"' \
    && pass "Session timebox set" \
    || fail "Session timebox not set (or malformed)"
  printf '%s\n' "$SESS_SECTION" | grep -qE '^[[:space:]]*inactivity_timeout[[:space:]]*=[[:space:]]*".+"' \
    && pass "Session inactivity_timeout set" \
    || fail "Session inactivity_timeout not set (or malformed)"
fi

# ============ 5b. ADR-0011 server-side allowlist + RBAC ============
echo "=== 5b. Server-side allowlist / RBAC controls (ADR-0011) ==="

AL="app/supabase/migrations/0016_dashboard_access_allowlist.sql"
API_AUTH="app/api/src/lib/auth.ts"
API_RBAC="app/api/src/lib/rbac.ts"

for f in "$AL" "$API_AUTH" "$API_RBAC"; do
  [ -f "$f" ] || { fail "Required ADR-0011 file missing: $f"; }
done

if [ -f "$AL" ]; then
  has_ge "$AL" "create table if not exists screening_v2\.email_allowlist" 1 \
    && pass "email_allowlist table defined" \
    || fail "email_allowlist table missing"
  has_ge "$AL" "alter table screening_v2\.email_allowlist enable row level security" 1 \
    && pass "email_allowlist RLS enabled" \
    || fail "email_allowlist RLS not enabled"
  has_ge "$AL" "revoke all on screening_v2\.email_allowlist from anon, authenticated, public" 1 \
    && pass "email_allowlist revoked from anon/authenticated/public" \
    || fail "email_allowlist not revoked from anon/authenticated/public"
  has_ge "$AL" "create or replace function screening_v2\.resolve_allowlist_access" 1 \
    && pass "resolve_allowlist_access resolver defined" \
    || fail "resolve_allowlist_access resolver missing"
fi

if [ -f "$API_AUTH" ]; then
  # The API must resolve the allowlist on every request…
  has_ge "$API_AUTH" "resolve_allowlist_access" 1 \
    && pass "API calls resolve_allowlist_access" \
    || fail "API does not call resolve_allowlist_access"
  # …and must require a Supabase-verified email before doing so.
  has_ge "$API_AUTH" "emailVerified" 1 \
    && pass "API gates on verified email" \
    || fail "API does not gate on verified email"
  # Exact company domain, never the OAuth hd hint.
  has_ge "$API_AUTH" "ALLOWED_ACCESS_DOMAIN" 1 \
    && pass "API enforces an exact access domain" \
    || fail "API exact access domain constant missing"
fi

if [ -f "$API_RBAC" ]; then
  has_ge "$API_RBAC" "export function requireRole" 1 \
    && pass "RBAC requireRole present" \
    || fail "RBAC requireRole missing"
  # requireRole must fail closed when no server-set authUser exists.
  has_ge "$API_RBAC" "req\.authUser" 1 \
    && pass "RBAC reads server-set authUser" \
    || fail "RBAC does not read server-set authUser"
fi

# No AAL2 gate may be reintroduced without also restoring enrollment
# (see ADR-0011 § Consequences) — flag the inconsistent half-state.
if [ -f "$API_AUTH" ]; then
  AAL_GATE=$(grep -nE "aal[[:space:]]*!==[[:space:]]*'aal2'" "$API_AUTH" || true)
  if [ -z "$AAL_GATE" ]; then
    pass "No AAL2 authorization gate (consistent with disabled enrollment)"
  else
    fail "AAL2 gate present while MFA enrollment is disabled — new users would be stranded: $(printf '%s' "$AAL_GATE" | tr -s '[:space:]' ' ')"
  fi
fi

# ============ 6. Membership preservation ============
echo "=== 6. Membership table preservation ==="

# recruiter_memberships should NOT be DDL-altered (only read-only references)
DDL=$(grep -nE '(alter|drop|create)\s+.*recruiter_memberships' "$M" || true)
[ -z "$DDL" ] && pass "recruiter_memberships not altered by DDL" \
  || fail "recruiter_memberships DDL found: $DDL"

# ============ 7. Negative controls in policy_tests.sql ============
echo "=== 7. Negative controls ==="

for neg in \
  "anon has no privilege on candidate_invites" \
  "anon has no privilege on audit_events" \
  "audit UPDATE blocked"; \
do
  has_ge "$PT" "$neg" 1 && pass "Negative: '$neg'" || fail "Negative missing: '$neg'"
done

# Cross-owner denial
has_ge "$PT" "interviewer cannot see other owner" 1 \
  && pass "Negative: cross-owner interviewer denial" \
  || fail "Negative: cross-owner interviewer denial missing"

has_ge "$PT" "admin can see all owned" 1 \
  && pass "Positive: admin sees all owned" \
  || fail "Positive: admin sees all owned missing"

# Token digest format rejection
has_ge "$PT" "invalid token_digest format rejected" 1 \
  && pass "Negative: invalid token_digest rejected" \
  || fail "Negative: invalid token_digest rejected missing"

# No plaintext token column
has_ge "$PT" "no plaintext token column" 1 \
  && pass "Negative: no plaintext token column" \
  || fail "Negative: no plaintext token column missing"

# ============ Result ============
echo ""
echo "=========================================="
echo " Phase 1 Security Checks: ${PASS} passed, ${FAIL} failed"
echo "=========================================="

[ "$FAIL" -gt 0 ] && exit 1 || exit 0
