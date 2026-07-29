#!/usr/bin/env bash
# shellcheck disable=SC2317
#
# scan-git-history.test.sh — Deterministic test suite for scan-git-history.sh
#
# Creates isolated temporary synthetic Git repositories, seeds secrets
# (committed then removed in a later commit), and verifies the scanner
# catches them while passing clean repos.
#
# Tests
#   1. Seeded-secret detection  — commits a secret then removes it; scanner must find it
#   2. Clean-repo pass          — repo with no secrets; scanner must exit 0
#   3. Shallow-repo fail-closed — shallow repo; scanner must exit 3
#   4. Not-a-repo fail-closed   — temp dir with no .git; scanner must exit 3
#   5. Scanner-error fail-closed — corrupt gitleaks config; scanner must exit 4
#
# Every test also asserts redaction:
#   - The absolute temp dir path NEVER appears in stdout/stderr
#   - The repo basename (temp dir name) NEVER appears in stdout/stderr
#   - The author email (test@test.local) NEVER appears in stdout/stderr
#   - The seeded secret value NEVER appears in stdout/stderr
#
# Exits 0 if all tests pass, 1 otherwise.

set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCANNER="$SCRIPT_DIR/scan-git-history.sh"
PROJECT_GITLEAKS_CONFIG="$SCRIPT_DIR/../.gitleaks.toml"
PASS=0
FAIL=0
TOTAL=5

# Colours
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

pass() { PASS=$((PASS+1)); echo -e "  ${GREEN}PASS${NC}: $1"; }
fail() { FAIL=$((FAIL+1)); echo -e "  ${RED}FAIL${NC}: $1"; }

# ---- Redaction helpers ---------------------------------------------------
# Each test captures output and checks that these identifying tokens are
# never present.  We pass the output string, the temp-dir path, and the
# seeded secret (empty string if none).

check_redaction() {
  local label="$1"        # test label for error messages
  local output="$2"       # the full stdout+stderr from the scanner
  local tempdir="$3"      # the mktemp path (absolute)
  local secret="$4"       # the seeded secret (empty if none)
  local ok=0

  # 1. Absolute temp path must not appear
  if echo "$output" | grep -qF "$tempdir"; then
    fail "$label — absolute temp path leaked into output"
    ok=1
  fi

  # 2. Basename / "repository name" must not appear
  local basename
  basename="$(basename "$tempdir")"
  if echo "$output" | grep -qF "$basename"; then
    fail "$label — temp dir basename leaked into output"
    ok=1
  fi

  # 3. Author email must not appear
  if echo "$output" | grep -qF "test@test.local"; then
    fail "$label — author email leaked into output"
    ok=1
  fi

  # 4. Seeded secret must not appear
  if [ -n "$secret" ] && echo "$output" | grep -qF "$secret"; then
    fail "$label — secret value leaked into output"
    ok=1
  fi

  return "$ok"
}

# Build a Slack bot token dynamically so no raw secret value appears in source.
# The token follows the Slack pattern (xoxb-<digits>-<digits>-<hex>) which
# gitleaks detects via its slack-bot-token rule. We assemble it at runtime
# from parts to avoid triggering the scanner ourselves.
make_secret() {
  local g1 g2 suffix
  g1="$(dd if=/dev/zero bs=12 count=1 2>/dev/null | tr '\0' '1')"
  g2="$(dd if=/dev/zero bs=13 count=1 2>/dev/null | tr '\0' '2')"
  suffix="-ABCDEF12345678abcd"
  printf 'xoxb-%s-%s%s' "$g1" "$g2" "$suffix"
}

# ---- Prerequisites -------------------------------------------------------
echo "=== scan-git-history.test.sh ==="
echo ""

if [ ! -x "$SCANNER" ]; then
  echo "FAIL: scanner script not found or not executable: $SCANNER"
  exit 1
fi

if [ ! -f "$PROJECT_GITLEAKS_CONFIG" ]; then
  echo "FAIL: project .gitleaks.toml not found at $PROJECT_GITLEAKS_CONFIG"
  exit 1
fi

# Ensure gitleaks or docker is available
if command -v gitleaks >/dev/null 2>&1; then
  echo "[INFO] Using gitleaks binary"
elif command -v docker >/dev/null 2>&1; then
  echo "[INFO] Using Docker gitleaks"
  docker pull zricethezav/gitleaks:v8.30.1 >/dev/null 2>&1 || true
else
  echo "FAIL: neither gitleaks nor docker is available — cannot run tests"
  exit 1
fi

# ---- Test 1: Seeded-secret detection ------------------------------------
echo ""
echo "--- Test 1/$TOTAL: Seeded-secret detection ---"

TESTDIR_1="$(mktemp -d)"
SEEDED_SECRET_1="$(make_secret)"

(
  cd "$TESTDIR_1"
  git init --initial-branch=main >/dev/null 2>&1
  git config user.email "test@test.local"
  git config user.name "Test User"
  echo "README" > README.md
  git add README.md
  git commit -m "initial commit" >/dev/null 2>&1

  # Commit a secret
  printf '%s' "$SEEDED_SECRET_1" > slack_token.txt
  git add slack_token.txt
  git commit -m "add token" >/dev/null 2>&1

  # Remove the secret in a later commit
  git rm slack_token.txt >/dev/null 2>&1
  git commit -m "remove token" >/dev/null 2>&1

  cp "$PROJECT_GITLEAKS_CONFIG" "$TESTDIR_1/.gitleaks.toml"
) >/dev/null 2>&1

set +e
SCAN_OUTPUT_1="$(bash "$SCANNER" "$TESTDIR_1" 2>&1)"
SCAN_EXIT_1=$?
set -e

if [ "$SCAN_EXIT_1" -eq 1 ]; then
  pass "Scanner correctly detected seeded secret (exit $SCAN_EXIT_1)"
else
  fail "Scanner returned exit $SCAN_EXIT_1 (expected 1) — output: $(echo "$SCAN_OUTPUT_1" | tr '\n' '; ')"
fi

check_redaction "Test 1" "$SCAN_OUTPUT_1" "$TESTDIR_1" "$SEEDED_SECRET_1" || true

rm -rf "$TESTDIR_1"

# ---- Test 2: Clean-repo pass --------------------------------------------
echo ""
echo "--- Test 2/$TOTAL: Clean-repo pass ---"

TESTDIR_2="$(mktemp -d)"

(
  cd "$TESTDIR_2"
  git init --initial-branch=main >/dev/null 2>&1
  git config user.email "test@test.local"
  git config user.name "Test User"
  echo "# Clean repo" > README.md
  git add README.md
  git commit -m "initial" >/dev/null 2>&1
  cp "$PROJECT_GITLEAKS_CONFIG" "$TESTDIR_2/.gitleaks.toml"
  git add .gitleaks.toml
  git commit -m "add gitleaks config" >/dev/null 2>&1
) >/dev/null 2>&1

set +e
SCAN_OUTPUT_2="$(bash "$SCANNER" "$TESTDIR_2" 2>&1)"
SCAN_EXIT_2=$?
set -e

if [ "$SCAN_EXIT_2" -eq 0 ]; then
  pass "Clean repo passed (exit $SCAN_EXIT_2)"
else
  fail "Clean repo returned exit $SCAN_EXIT_2 (expected 0) — output: $(echo "$SCAN_OUTPUT_2" | tr '\n' '; ')"
fi

check_redaction "Test 2" "$SCAN_OUTPUT_2" "$TESTDIR_2" "" || true

rm -rf "$TESTDIR_2"

# ---- Test 3: Shallow-repo fail-closed -----------------------------------
echo ""
echo "--- Test 3/$TOTAL: Shallow-repo fail-closed ---"

TESTDIR_3="$(mktemp -d)"

(
  cd "$TESTDIR_3"
  git init --initial-branch=main >/dev/null 2>&1
  git config user.email "test@test.local"
  git config user.name "Test User"
  echo "data" > file.txt
  git add file.txt
  git commit -m "first" >/dev/null 2>&1

  # Artificially mark the repo as shallow
  touch "$(git rev-parse --git-dir)/shallow"
  cp "$PROJECT_GITLEAKS_CONFIG" "$TESTDIR_3/.gitleaks.toml"
) >/dev/null 2>&1

set +e
SCAN_OUTPUT_3="$(bash "$SCANNER" "$TESTDIR_3" 2>&1)"
SCAN_EXIT_3=$?
set -e

if [ "$SCAN_EXIT_3" -eq 3 ]; then
  pass "Shallow repo correctly rejected (exit $SCAN_EXIT_3)"
else
  fail "Shallow repo returned exit $SCAN_EXIT_3 (expected 3) — output: $(echo "$SCAN_OUTPUT_3" | tr '\n' '; ')"
fi

check_redaction "Test 3" "$SCAN_OUTPUT_3" "$TESTDIR_3" "" || true

rm -rf "$TESTDIR_3"

# ---- Test 4: Not-a-repo fail-closed -------------------------------------
echo ""
echo "--- Test 4/$TOTAL: Not-a-repo fail-closed ---"

TESTDIR_4="$(mktemp -d)"
cp "$PROJECT_GITLEAKS_CONFIG" "$TESTDIR_4/.gitleaks.toml" 2>/dev/null || true

set +e
SCAN_OUTPUT_4="$(bash "$SCANNER" "$TESTDIR_4" 2>&1)"
SCAN_EXIT_4=$?
set -e

if [ "$SCAN_EXIT_4" -eq 3 ]; then
  pass "Non-repo directory correctly rejected (exit $SCAN_EXIT_4)"
else
  fail "Non-repo returned exit $SCAN_EXIT_4 (expected 3) — output: $(echo "$SCAN_OUTPUT_4" | tr '\n' '; ')"
fi

check_redaction "Test 4" "$SCAN_OUTPUT_4" "$TESTDIR_4" "" || true

rm -rf "$TESTDIR_4"

# ---- Test 5: Scanner-error fail-closed ----------------------------------
echo ""
echo "--- Test 5/$TOTAL: Scanner-error fail-closed ---"

TESTDIR_5="$(mktemp -d)"

(
  cd "$TESTDIR_5"
  git init --initial-branch=main >/dev/null 2>&1
  git config user.email "test@test.local"
  git config user.name "Test User"
  echo "data" > file.txt
  git add file.txt
  git commit -m "first" >/dev/null 2>&1
  cp "$PROJECT_GITLEAKS_CONFIG" "$TESTDIR_5/.gitleaks.toml"
  git add .gitleaks.toml
  git commit -m "add config" >/dev/null 2>&1
) >/dev/null 2>&1

set +e
# Force a scanner error by pointing Docker at a non-existent image
# (works regardless of whether native gitleaks is available)
SCAN_OUTPUT_5="$(GITLEAKS_IMAGE='zricethezav/gitleaks:nonexistent' bash "$SCANNER" "$TESTDIR_5" 2>&1)"
SCAN_EXIT_5=$?
set -e

if [ "$SCAN_EXIT_5" -eq 4 ]; then
  pass "Scanner correctly reported error (exit $SCAN_EXIT_5)"
else
  fail "Scanner returned exit $SCAN_EXIT_5 (expected 4) — output: $(echo "$SCAN_OUTPUT_5" | tr '\n' '; ')"
fi

check_redaction "Test 5" "$SCAN_OUTPUT_5" "$TESTDIR_5" "" || true

rm -rf "$TESTDIR_5"

# ---- Summary -------------------------------------------------------------
echo ""
echo "=== Results: $PASS/$TOTAL passed, $FAIL failed ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
