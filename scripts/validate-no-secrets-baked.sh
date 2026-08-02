#!/usr/bin/env sh
# Secret-bake validator for the voice-agent container build context.
#
# Distinguishes variable NAMES and documented placeholders (allowed) from
# secret VALUES (rejected). Normal run passes the real tree; the dedicated
# negative control (scripts/__fixtures__/hosting-synthetic-forbidden-secret.txt)
# must FAIL, proving the value-detection rule is non-vacuous.
#
# Usage:
#   bash scripts/validate-no-secrets-baked.sh                # scan Docker context
#   bash scripts/validate-no-secrets-baked.sh <path>         # scan dir or file
#
# Exit codes: 0 = clean, 1 = a baked secret/value pattern was found,
#             2 = usage error.
set -eu

repo_root=$(git rev-parse --show-toplevel)
cd "$repo_root"

target="${1:-app/voice-livekit}"
if [ ! -e "$target" ]; then
  echo "validate-no-secrets-baked: target not found: $target" >&2
  exit 2
fi

SENTINEL="SYNTHETIC_FORBIDDEN_SECRET_VALUE"

failures=0

# ── Rule 1: no .env file (exact name) anywhere under the target ──────────
find_env() {
  if [ -f "$target" ]; then
    [ "$(basename "$target")" = ".env" ] && echo "$target"
    return 0
  fi
  find "$target" -type f -name '.env' -print
}
if env_file=$(find_env) && [ -n "$env_file" ]; then
  printf 'FAIL  .env file is baked into the build context: %s\n' "$env_file" >&2
  failures=$((failures + 1))
fi

# ── Rule 2: synthetic sentinel must never appear in a scan target ─────────
# The negative control file intentionally contains it and must fail here.
scan_files() {
  if [ -f "$target" ]; then
    echo "$target"
    return 0
  fi
  find "$target" -type f -print
}
if matches=$(scan_files | while read -r f; do
  grep -Hn "$SENTINEL" "$f" 2>/dev/null && echo "found"
done); then
  case "$matches" in
    *found*)
      printf 'FAIL  synthetic sentinel present in target: %s\n' "$matches" >&2
      failures=$((failures + 1))
      ;;
  esac
fi

# ── Rule 3: value-shaped secret patterns (names/placeholders are allowed) ─
# Values that are empty, replace_me, <...> placeholders, or YOUR_* names are
# allowed; anything else that looks like a credential value fails.
value_patterns='\(API_KEY\|API_SECRET\|SERVICE_ROLE_KEY\|TOKEN\|PASSWORD\|PRIVATE_KEY\|ACCESS_KEY\)='
if matches=$(scan_files | while read -r f; do
  grep -Hn "$value_patterns" "$f" 2>/dev/null
done); then
  for line in $matches; do
    file=${line%%:*}
    rest=${line#*:}
    lineno=${rest%%:*}
    value=${rest#*:}
    value=${value#*=}
    value=$(printf '%s' "$value" | sed 's/[[:space:]]*$//')
    case "$value" in
      "" | "replace_me" | "<"*">" | "YOUR_"* | "your-"*)
        : # documented placeholder — allowed
        ;;
      *)
        printf 'FAIL  secret-looking value assigned in %s:%s\n' "$file" "$lineno" >&2
        failures=$((failures + 1))
        ;;
    esac
  done
fi

# ── Rule 4: hard private-key material must never appear anywhere ──────────
if matches=$(scan_files | while read -r f; do
  grep -HnE -- '-----BEGIN [A-Z ]*PRIVATE KEY-----' "$f" 2>/dev/null
done); then
  case "$matches" in
    *"PRIVATE KEY"*)
      printf 'FAIL  private key material present in target\n' >&2
      failures=$((failures + 1))
      ;;
  esac
fi

if [ "$failures" -ne 0 ]; then
  printf 'validate-no-secrets-baked: FAILED (%s rule violation(s))\n' "$failures" >&2
  exit 1
fi

printf 'validate-no-secrets-baked: PASS (%s)\n' "$target"
