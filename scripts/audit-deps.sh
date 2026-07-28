#!/usr/bin/env bash
# audit-deps.sh — Lockfile-aware dependency audit for CI
#
# ALWAYS invokes the policy checker — even when npm audit exits 0 — so that
# stale/expired/unused exceptions are caught.
#
# Usage:
#   bash scripts/audit-deps.sh --dir app/web
#   bash scripts/audit-deps.sh --dir app/api
#
# Requires: Node.js >= 22 (npm >= 10), no jq dependency.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DEFAULT_EXCEPTIONS="$REPO_ROOT/.github/audit-exceptions.json"

# ── Parse arguments ────────────────────────────────────────────────

PROJECT_DIR=""
EXCEPTIONS_FILE="$DEFAULT_EXCEPTIONS"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)
      PROJECT_DIR="${2:-}"
      shift 2
      ;;
    --exceptions)
      EXCEPTIONS_FILE="${2:-}"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1"
      echo "Usage: $0 --dir <path> [--exceptions <path>]"
      exit 2
      ;;
  esac
done

if [ -z "$PROJECT_DIR" ]; then
  echo "ERROR: --dir is required"
  echo "Usage: $0 --dir <path> [--exceptions <path>]"
  exit 2
fi

# Save the original relative path for project name scoping
PROJECT_DIR_ARG="$PROJECT_DIR"

# Resolve to absolute path
PROJECT_DIR="$(cd "$REPO_ROOT/$PROJECT_DIR" 2>/dev/null && pwd)" || {
  echo "FAIL: Cannot access project directory: $PROJECT_DIR"
  exit 1
}

# ── Pre-flight checks ──────────────────────────────────────────────

if ! command -v node &>/dev/null; then
  echo "FAIL: node is required (Node.js >= 22)"
  exit 1
fi

if ! command -v npm &>/dev/null; then
  echo "FAIL: npm is required (npm >= 10)"
  exit 1
fi

# ── Run npm audit (always JSON) ────────────────────────────────────

echo "=== Dependency audit: $PROJECT_DIR ==="

cd "$PROJECT_DIR"

# Capture combined stdout+stderr.  We always produce JSON so the checker
# can detect stale exceptions even when no vulnerabilities are reported.
set +e
AUDIT_OUTPUT="$(npm audit --json 2>&1)"
AUDIT_EXIT=$?
set -e

# ── Extract JSON from npm output ───────────────────────────────────

# npm sometimes emits log lines before/after the JSON object.
# Extract the JSON portion and validate it is parseable.

AUDIT_JSON=""
if ! AUDIT_JSON=$(echo "$AUDIT_OUTPUT" | node -e "
  const chunks = [];
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', c => chunks.push(c));
  process.stdin.on('end', () => {
    const raw = chunks.join('');
    const idx = raw.indexOf('{');
    if (idx === -1) { console.log(''); process.exit(1); }
    const jsonStr = raw.slice(idx);
    try { JSON.parse(jsonStr); console.log(jsonStr); }
    catch(e) { console.log(''); process.exit(1); }
  });
" 2>/dev/null); then
  echo "FAIL: npm audit produced non-JSON output. Possible network or tool error."
  echo "Raw output (first 500 chars):"
  echo "$AUDIT_OUTPUT" | head -c 500
  exit 1
fi

if [ -z "$AUDIT_JSON" ]; then
  echo "FAIL: Empty audit JSON — npm audit may have failed unexpectedly."
  exit 1
fi

# ── Always invoke the policy checker ───────────────────────────────

# Build the checker args as a proper Bash array to handle paths with spaces.
CHECKER_ARGS=("$SCRIPT_DIR/check-audit-exceptions.mjs")
CHECKER_ARGS+=(--exceptions "$EXCEPTIONS_FILE")

# Only add --project-dir if we have a project directory (for invariant checks).
# Resolve relative to repo root as an absolute path.
if [ -n "${PROJECT_DIR:-}" ]; then
  CHECKER_ARGS+=(--project-dir "$PROJECT_DIR")
fi

# Pass the relative project name for exception scoping
CHECKER_ARGS+=(--project-name "$PROJECT_DIR_ARG")

echo "$AUDIT_JSON" | node "${CHECKER_ARGS[@]}"
CHECKER_EXIT=$?

exit $CHECKER_EXIT
