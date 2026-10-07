#!/usr/bin/env bash
# Read-only production function-drift check (M009 / 0114 C6).
#
# WHY. PR #145 edited migration 0057 AFTER production had applied it, adding
# an ensure_ashby_phone_engagement call to request_phone_rescreen. Supabase
# never re-runs an applied migration, so prod silently kept the old body for
# weeks while every local and CI database (which apply the edited repo text)
# looked correct. 0114 §7 redeclares the function; this script proves, against
# the LIVE database, that the body production actually runs contains the
# token it must contain. It runs after every production migration in
# .github/workflows/deploy-fly.yml and in the PR-C post-deploy runbook.
#
# 0118 (R1 PR-LK-liveness) re-declares two PHONE-SHARED RPCs, claim_voice_worker
# and reset_voice_worker, each as 0112 verbatim plus one `livekit_host = null`
# assignment. Neither pre-0118 body contains the identifier `livekit_host` (the
# column is added by 0118), so its presence in the live body proves production
# runs the 0118 definitions and not the 0112 ones.
#
# It issues SELECTs only (pg_get_functiondef). No PII is queried or printed.
#
# Target:
#   SUPABASE_DB_URL set  -> `supabase db query --db-url "$SUPABASE_DB_URL"` (CI)
#   otherwise            -> `supabase db query --linked` (an operator shell that
#                           has run `supabase link`; run from app/ or set
#                           SUPABASE_WORKDIR)
# Exit 0 when every check finds its token (position > 0); exit 1 on any
# position 0 (drift) or any unreadable answer (fail closed).
set -euo pipefail

CLI_VERSION="${SUPABASE_CLI_VERSION_DRIFT:-2.118.0}"

# One line per check: <regprocedure>|<token the live body must contain>.
CHECKS=(
  "screening_v2.request_phone_rescreen(uuid,text,text,text,uuid,timestamptz)|ensure_ashby_phone_engagement"
  "screening_v2.claim_voice_worker(text,text,uuid,bigint,timestamptz)|livekit_host"
  "screening_v2.reset_voice_worker(text,text,timestamptz)|livekit_host"
)

if [ -n "${SUPABASE_DB_URL:-}" ]; then
  target=(--db-url "$SUPABASE_DB_URL")
  target_label="db-url"
else
  target=(--linked)
  target_label="linked"
fi
workdir=()
if [ -n "${SUPABASE_WORKDIR:-}" ]; then
  workdir=(--workdir "$SUPABASE_WORKDIR")
fi

failures=0
for check in "${CHECKS[@]}"; do
  fn="${check%%|*}"
  token="${check#*|}"
  sql="select position('${token}' in pg_get_functiondef('${fn}'::regprocedure)) as drift_position"
  if ! out=$(npx --yes "supabase@${CLI_VERSION}" db query "${target[@]}" "${workdir[@]}" \
               --output-format json "$sql" 2>/dev/null); then
    echo "::error::drift check could not query ${fn} (${target_label})" >&2
    failures=$((failures + 1))
    continue
  fi
  pos=$(printf '%s\n' "$out" | grep -oE '"drift_position"[[:space:]]*:[[:space:]]*[0-9]+' \
          | grep -oE '[0-9]+$' | head -n 1 || true)
  if [ -z "$pos" ]; then
    echo "::error::drift check got no readable position for ${fn} (${target_label})" >&2
    failures=$((failures + 1))
  elif [ "$pos" -eq 0 ]; then
    echo "::error::PROD FUNCTION DRIFT: ${fn} does not contain ${token} (position 0)" >&2
    failures=$((failures + 1))
  else
    echo "ok ${fn} contains ${token} (position ${pos})"
  fi
done

if [ "$failures" -gt 0 ]; then
  echo "verify-prod-function-drift: ${failures} check(s) failed" >&2
  exit 1
fi
echo "verify-prod-function-drift: all ${#CHECKS[@]} check(s) passed"
