#!/usr/bin/env bash
# shellcheck disable=SC2317
#
# scan-git-history.sh — Deterministic full-Git-history secret scanner
#
# Scans every reachable commit in the Git history using gitleaks detect
# (git mode), not just the working tree or committable files.  This
# catches secrets that were committed in an earlier commit and later
# removed.
#
# Usage: scan-git-history.sh [TARGET_DIR]
#   TARGET_DIR   — Git repository to scan (default: parent of script dir)
#
# Exit codes
#   0   — No secrets detected in full history
#   1   — Secrets detected (redacted output printed)
#   2   — Gitleaks unavailable or Docker unavailable
#   3   — Git repository shallow, malformed, or unreachable
#   4   — Scanner error (non-zero exit from gitleaks not due to findings)
#
# Diagnostics are REDACTED: no secret values, commit messages, author
# emails, remote URLs, full local paths, or raw patches are emitted.
#
# Environment
#   GITLEAKS_IMAGE    — Docker image (default: zricethezav/gitleaks:v8.30.1)
#   GITLEAKS_VERBOSE  — Set to 1 for verbose gitleaks output
#   GITLEAKS_CONFIG   — Path to gitleaks config (relative to TARGET_DIR)
#                       (default: .gitleaks.toml)

set -eu

# ---- Path setup ----------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# If an argument is provided, use it as the target repository
TARGET_DIR="${1:-$(cd "$SCRIPT_DIR/.." && pwd)}"
# Normalise to absolute path
TARGET_DIR="$(cd "$TARGET_DIR" 2>/dev/null && pwd)" || {
  echo "[FATAL] Cannot access target repository" >&2
  exit 3
}

cd "$TARGET_DIR"

GITLEAKS_IMAGE="${GITLEAKS_IMAGE:-zricethezav/gitleaks:v8.30.1}"
GITLEAKS_CONFIG="${GITLEAKS_CONFIG:-.gitleaks.toml}"
VERBOSE_FLAG=""
[ "${GITLEAKS_VERBOSE:-0}" = "1" ] && VERBOSE_FLAG="--verbose"

# ---- Diagnostics helpers (all redacted) ----------------------------------
die()  { echo "[FATAL] $*" >&2; exit "$2"; }
info() { echo "[INFO] $*"; }

# ---- Pre-flight checks ---------------------------------------------------
# 1.  Verify we are inside a Git repository.
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  die "Not a Git repository — cannot scan history" 3
fi

# 2.  Detect shallow repository (fail closed).
GIT_DIR="$(git rev-parse --git-dir)"
if [ -f "$GIT_DIR/shallow" ]; then
  die "Shallow clone detected — history is incomplete.  Re-clone with --unshallow or increase fetch-depth." 3
fi

# 3.  Verify the config file exists (relative to TARGET_DIR or absolute).
if ! [ -f "$GITLEAKS_CONFIG" ]; then
  # Try relative to TARGET_DIR
  if [ -f "$TARGET_DIR/$GITLEAKS_CONFIG" ]; then
    GITLEAKS_CONFIG="$TARGET_DIR/$GITLEAKS_CONFIG"
  else
    die "Gitleaks config not found" 3
  fi
fi

# 4.  Determine which gitleaks runner to use.
use_docker=0
if command -v gitleaks >/dev/null 2>&1; then
  GITLEAKS_CMD="gitleaks"
elif command -v docker >/dev/null 2>&1; then
  use_docker=1
else
  die "Neither gitleaks binary nor Docker is available.  Install one and retry." 2
fi

# ---- Run gitleaks detect (git mode) over full history --------------------
info "Scanning full Git history for secrets ..."

# We use a temp directory for the gitleaks report so we can inspect exit
# codes reliably even when gitleaks writes findings to stderr.
TMPDIR="$(mktemp -d)"
trap 'rm -rf -- "$TMPDIR"' EXIT HUP INT TERM
REPORT_FILE="$TMPDIR/gitleaks-report.json"

# Resolve config path for Docker mount
CONFIG_DIR="$(dirname "$GITLEAKS_CONFIG")"
CONFIG_FILE="$(basename "$GITLEAKS_CONFIG")"
# If config is outside TARGET_DIR, we need to mount it separately
# For simplicity, require config to be under TARGET_DIR or absolute
if [[ "$GITLEAKS_CONFIG" != /* ]]; then
  GITLEAKS_CONFIG_ABS="$TARGET_DIR/$GITLEAKS_CONFIG"
else
  GITLEAKS_CONFIG_ABS="$GITLEAKS_CONFIG"
fi

set +e

if [ "$use_docker" -eq 1 ]; then
  # Docker runner: mount the target directory read-only
  docker run --rm \
    -v "$TARGET_DIR:/repo:ro" \
    -v "$TMPDIR:/tmpout:rw" \
    -w /repo \
    "$GITLEAKS_IMAGE" \
    detect \
      --redact \
      $VERBOSE_FLAG \
      --source /repo \
      --config "/repo/$(basename "$GITLEAKS_CONFIG_ABS" 2>/dev/null || echo "$GITLEAKS_CONFIG")" \
      --report-path /tmpout/gitleaks-report.json \
      --report-format json \
      2>"$TMPDIR/gitleaks-stderr.txt"
  GITLEAKS_EXIT=$?
else
  # Resolve config path for native runner
  if [ -f "$GITLEAKS_CONFIG_ABS" ]; then
    NATIVE_CONFIG="$GITLEAKS_CONFIG_ABS"
  else
    NATIVE_CONFIG="$TARGET_DIR/$GITLEAKS_CONFIG"
  fi
  gitleaks detect \
    --redact \
    $VERBOSE_FLAG \
    --source "$TARGET_DIR" \
    --config "$NATIVE_CONFIG" \
    --report-path "$REPORT_FILE" \
    --report-format json \
    2>"$TMPDIR/gitleaks-stderr.txt"
  GITLEAKS_EXIT=$?
fi

set -e

# Check for scanner errors (exit 1 from gitleaks = findings, not error)
if [ "$GITLEAKS_EXIT" -ne 0 ] && [ "$GITLEAKS_EXIT" -ne 1 ]; then
  # Do not relay scanner stderr: third-party diagnostics may contain the
  # repository path, remote URL, commit metadata, or matched material. The
  # fixed category and exit code are sufficient for operator triage.
  echo "[ERROR] Gitleaks scanner failed (exit category: scanner-error)." >&2
  exit 4
fi

# If no secrets found
if [ "$GITLEAKS_EXIT" -eq 0 ]; then
  info "Full history scan complete — no secrets detected."
  exit 0
fi

# ---- Secrets detected — print redacted summary ---------------------------
echo "[SECURITY] Secrets detected in Git history!" >&2
echo "[SECURITY] See rotation readiness docs at docs/runbooks/credential-rotation-readiness.md" >&2
echo "[SECURITY] Redacted finding details (no values, messages, emails, or patches):" >&2

findings=0
if [ -f "$REPORT_FILE" ]; then
  findings="$(python3 -c "
import json, sys
try:
    with open('$REPORT_FILE') as f:
        data = json.load(f)
except Exception:
    sys.exit(1)
if isinstance(data, list):
    findings = data
elif isinstance(data, dict):
    findings = data.get('Findings', [])
else:
    findings = []
print(len(findings))
" 2>/dev/null || echo "0")"
fi

if [ -f "$REPORT_FILE" ] && [ "$findings" -gt 0 ]; then
  python3 -c "
import json, sys
try:
    with open('$REPORT_FILE') as f:
        data = json.load(f)
except Exception:
    sys.exit(0)
findings = data if isinstance(data, list) else data.get('Findings', data.get('findings', []))
for f in findings:
    desc = f.get('RuleID', f.get('rule_id', 'unknown'))
    sev  = f.get('Severity', f.get('severity', 'unknown'))
    print(f'  - Rule: {desc} | Severity: {sev}')
" 2>/dev/null || true
fi

echo "" >&2
echo "[SECURITY] Remediation steps:" >&2
echo "  1. Rotate exposed credentials immediately." >&2
echo "  2. Remove secret from Git history (git filter-repo / BFG)." >&2
echo "  3. Re-run this scanner to confirm removal." >&2
echo "  4. See docs/runbooks/credential-rotation-readiness.md." >&2

exit 1
