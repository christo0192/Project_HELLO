#!/usr/bin/env bash
# Self-tests for scripts/check-phase1-security-sql.sh
#
# Mutation-based, zero-network. Proves the static security contract FAILS
# CLOSED: the checker must reject a missing, malformed, or weakened Auth
# configuration rather than silently passing.
#
# Guards the ADR-0011 invariant specifically:
#   public signup disabled · TOTP enroll+verify disabled · phone enroll+verify
#   disabled · session timebox retained · server-side allowlist/RBAC present
#
# Each case copies the real inputs into a scratch tree, applies ONE mutation,
# and asserts the checker exits non-zero. A positive control asserts the
# unmutated tree still passes — so the suite cannot trivially "succeed" by
# the checker being broken and always failing.

set -uo pipefail
cd "$(dirname "$0")/.."
REPO="$PWD"

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $*"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $*"; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Inputs the checker reads. Kept in one place so a new dependency surfaces
# here rather than silently weakening the tests.
INPUTS=(
  "scripts/check-phase1-security-sql.sh"
  "app/supabase/config.toml"
  "app/supabase/migrations/0007_invites_audit_rbac.sql"
  "app/supabase/migrations/0016_dashboard_access_allowlist.sql"
  "app/supabase/tests/policy_tests.sql"
  "app/api/src/lib/auth.ts"
  "app/api/src/lib/rbac.ts"
)

# Build a pristine scratch copy of the tree the checker needs.
make_tree() {
  local dest="$1"
  rm -rf "$dest"
  local f
  for f in "${INPUTS[@]}"; do
    mkdir -p "$dest/$(dirname "$f")"
    cp "$REPO/$f" "$dest/$f"
  done
}

run_checker() {
  ( cd "$1" && bash scripts/check-phase1-security-sql.sh >/dev/null 2>&1 )
}

# Set `key = value` inside a specific TOML section (section must exist).
set_key_in_section() {
  local file="$1" sec="$2" key="$3" val="$4" tmp
  tmp="$(mktemp)"
  awk -v want="$sec" -v key="$key" -v val="$val" '
    /^[[:space:]]*\[/ { inside = ($0 ~ "^[[:space:]]*\\[" want "\\][[:space:]]*$") ? 1 : 0; print; next }
    inside && $0 ~ "^[[:space:]]*" key "[[:space:]]*=" { print key " = " val; next }
    { print }
  ' "$file" > "$tmp"
  mv "$tmp" "$file"
}

# Delete `key` from a specific TOML section.
delete_key_in_section() {
  local file="$1" sec="$2" key="$3" tmp
  tmp="$(mktemp)"
  awk -v want="$sec" -v key="$key" '
    /^[[:space:]]*\[/ { inside = ($0 ~ "^[[:space:]]*\\[" want "\\][[:space:]]*$") ? 1 : 0; print; next }
    inside && $0 ~ "^[[:space:]]*" key "[[:space:]]*=" { next }
    { print }
  ' "$file" > "$tmp"
  mv "$tmp" "$file"
}

# Delete an entire TOML section (header + body).
delete_section() {
  local file="$1" sec="$2" tmp
  tmp="$(mktemp)"
  awk -v want="$sec" '
    /^[[:space:]]*\[/ { inside = ($0 ~ "^[[:space:]]*\\[" want "\\][[:space:]]*$") ? 1 : 0; if (inside) next; print; next }
    inside { next }
    { print }
  ' "$file" > "$tmp"
  mv "$tmp" "$file"
}

# Mutation helpers run inside `bash -c` subshells, so they must be exported.
export -f set_key_in_section delete_key_in_section delete_section

# Assert the checker REJECTS a mutated tree.
expect_reject() {
  local label="$1"; shift
  local tree="$WORK/case"
  make_tree "$tree"
  # shellcheck disable=SC2317
  "$@" "$tree"
  if run_checker "$tree"; then
    fail "$label — checker PASSED on a tree it must reject"
  else
    pass "$label — rejected"
  fi
}

echo "=== check-phase1-security-sql.sh self-tests ==="
echo ""
echo "--- Positive control ---"

make_tree "$WORK/clean"
if run_checker "$WORK/clean"; then
  pass "Unmutated tree passes (checker is not vacuously failing)"
else
  fail "Unmutated tree FAILED — checker or repo contract is broken"
fi

echo ""
echo "--- ADR-0011: MFA must stay fully disabled ---"

expect_reject "TOTP enroll_enabled = true" \
  bash -c 'set_key_in_section "$1/app/supabase/config.toml" "auth.mfa.totp" "enroll_enabled" "true"' _
expect_reject "TOTP verify_enabled = true" \
  bash -c 'set_key_in_section "$1/app/supabase/config.toml" "auth.mfa.totp" "verify_enabled" "true"' _
expect_reject "Phone enroll_enabled = true" \
  bash -c 'set_key_in_section "$1/app/supabase/config.toml" "auth.mfa.phone" "enroll_enabled" "true"' _
expect_reject "Phone verify_enabled = true" \
  bash -c 'set_key_in_section "$1/app/supabase/config.toml" "auth.mfa.phone" "verify_enabled" "true"' _

echo ""
echo "--- Missing config must not pass ---"

expect_reject "[auth.mfa.totp] section deleted" \
  bash -c 'delete_section "$1/app/supabase/config.toml" "auth.mfa.totp"' _
expect_reject "[auth.mfa.phone] section deleted" \
  bash -c 'delete_section "$1/app/supabase/config.toml" "auth.mfa.phone"' _
expect_reject "TOTP enroll_enabled key deleted" \
  bash -c 'delete_key_in_section "$1/app/supabase/config.toml" "auth.mfa.totp" "enroll_enabled"' _
expect_reject "[auth.sessions] section deleted" \
  bash -c 'delete_section "$1/app/supabase/config.toml" "auth.sessions"' _
expect_reject "session timebox deleted" \
  bash -c 'delete_key_in_section "$1/app/supabase/config.toml" "auth.sessions" "timebox"' _
expect_reject "session inactivity_timeout deleted" \
  bash -c 'delete_key_in_section "$1/app/supabase/config.toml" "auth.sessions" "inactivity_timeout"' _
expect_reject "config.toml deleted entirely" \
  bash -c 'rm -f "$1/app/supabase/config.toml"' _

echo ""
echo "--- Malformed values must not pass ---"

expect_reject "TOTP enroll_enabled = \"false\" (quoted string, not boolean)" \
  bash -c 'set_key_in_section "$1/app/supabase/config.toml" "auth.mfa.totp" "enroll_enabled" "\"false\""' _
expect_reject "TOTP enroll_enabled = FALSE (wrong case)" \
  bash -c 'set_key_in_section "$1/app/supabase/config.toml" "auth.mfa.totp" "enroll_enabled" "FALSE"' _
expect_reject "TOTP enroll_enabled = 0" \
  bash -c 'set_key_in_section "$1/app/supabase/config.toml" "auth.mfa.totp" "enroll_enabled" "0"' _
expect_reject "session timebox with empty value" \
  bash -c 'set_key_in_section "$1/app/supabase/config.toml" "auth.sessions" "timebox" "\"\""' _

echo ""
echo "--- Signup must stay disabled ---"

expect_reject "enable_signup = true" \
  bash -c 'sed -i "s/^enable_signup = false/enable_signup = true/" "$1/app/supabase/config.toml"' _

echo ""
echo "--- A re-enabled factor type anywhere under [auth.mfa.*] ---"

expect_reject "web_authn factor enabled" \
  bash -c 'printf "\n[auth.mfa.web_authn]\nenroll_enabled = true\nverify_enabled = true\n" >> "$1/app/supabase/config.toml"' _

echo ""
echo "--- Server-side allowlist / RBAC controls must be present ---"

expect_reject "allowlist migration deleted" \
  bash -c 'rm -f "$1/app/supabase/migrations/0016_dashboard_access_allowlist.sql"' _
expect_reject "email_allowlist RLS disabled" \
  bash -c 'sed -i "s/^alter table screening_v2\.email_allowlist enable row level security;//" "$1/app/supabase/migrations/0016_dashboard_access_allowlist.sql"' _
expect_reject "allowlist grants to anon/authenticated not revoked" \
  bash -c 'sed -i "s/^revoke all on screening_v2\.email_allowlist from anon, authenticated, public;//" "$1/app/supabase/migrations/0016_dashboard_access_allowlist.sql"' _
expect_reject "API no longer calls resolve_allowlist_access" \
  bash -c 'sed -i "s/resolve_allowlist_access/DISABLED_resolver/g" "$1/app/api/src/lib/auth.ts" "$1/app/supabase/migrations/0016_dashboard_access_allowlist.sql"' _
expect_reject "RBAC requireRole removed" \
  bash -c 'sed -i "s/export function requireRole/function __removed_requireRole/" "$1/app/api/src/lib/rbac.ts"' _
expect_reject "rbac.ts deleted" \
  bash -c 'rm -f "$1/app/api/src/lib/rbac.ts"' _

echo ""
echo "--- Inconsistent half-state: AAL2 gate with enrollment disabled ---"

expect_reject "AAL2 gate reintroduced while enrollment is off (would strand new users)" \
  bash -c 'printf "\nconst __x = (u: any) => u.aal !== '\''aal2'\'';\n" >> "$1/app/api/src/lib/auth.ts"' _

echo ""
echo "=========================================="
echo " Self-tests: ${PASS} passed, ${FAIL} failed"
echo "=========================================="

[ "$FAIL" -gt 0 ] && exit 1 || exit 0
