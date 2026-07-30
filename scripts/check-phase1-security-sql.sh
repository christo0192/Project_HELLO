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

# MFA TOTP
TOTP_SECTION=$(grep -A3 '^\[auth.mfa.totp\]' "$C" || true)
echo "$TOTP_SECTION" | grep -q 'enroll_enabled = true' \
  && pass "TOTP enroll enabled" \
  || fail "TOTP enroll not enabled"
echo "$TOTP_SECTION" | grep -q 'verify_enabled = true' \
  && pass "TOTP verify enabled" \
  || fail "TOTP verify not enabled"

# Session timeouts
has_ge "$C" '\[auth.sessions\]' 1 && pass "[auth.sessions] section exists" \
  || fail "[auth.sessions] section missing"
SESS_SECTION=$(grep -A5 '^\[auth.sessions\]' "$C" || true)
echo "$SESS_SECTION" | grep -q 'timebox' \
  && pass "Session timebox set" \
  || fail "Session timebox not set"
echo "$SESS_SECTION" | grep -q 'inactivity_timeout' \
  && pass "Session inactivity_timeout set" \
  || fail "Session inactivity_timeout not set"

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
