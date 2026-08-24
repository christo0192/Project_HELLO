#!/usr/bin/env bash
# Bounded container-contract validator for the LiveKit Agents voice worker.
#
# Static checks (always run, offline, no network, no third-party tools):
#  1. requirements.txt is present and every dependency is exactly `==` pinned.
#  2. Dockerfile is multi-stage on python:3.12-slim, non-root (USER 1000:1000),
#     production ENTRYPOINT (`python agent.py start`, not `dev`), no
#     HEALTHCHECK and no fake readiness/health server, no blanket `COPY . .`,
#     no .env copy, pip install with --no-cache-dir.
#  3. .dockerignore excludes .env/.git/venv/caches/tests.
#  4. No .env file exists in the build context.
#  5. docker-compose.yml runs the same non-root user and has no healthcheck.
#  6. The Dockerfile COPY list covers the EXACT first-party import closure of
#     the Python script named by the JSON ENTRYPOINT (AST-parsed, transitive;
#     the root is derived, never hardcoded), every worker-source COPY resolves
#     to /app under the WORKDIR in force, and no secret/env file is copied.
#     This is what prevents a re-run of PR102 (agent.py imported `phone` but
#     the image omitted phone.py → ModuleNotFoundError at startup) and the
#     adjacent shape where the modules ship but land outside /app.
#
# Optional bounded Docker execution (NOT run in CI; run locally by the owner
# or verifier) — `--docker` requires Docker and a bounded build:
#   - docker build app/voice-livekit
#   - non-root identity check (uid != 0)
#   - import/entrypoint shape check
# No provider commands, model downloads, auth, or network egress are ever run.
set -euo pipefail
cd "$(dirname "$0")/.."

root=$(pwd)
ctx="$root/app/voice-livekit"
docker_flag=0
for arg in "$@"; do
  case "$arg" in
    --docker) docker_flag=1 ;;
    *) ctx="$arg" ;;
  esac
done
failures=0
fail() { echo "FAIL  $1" >&2; failures=$((failures + 1)); }
pass() { echo "PASS  $1"; }

[ -f "$ctx/requirements.txt" ] || fail "requirements.txt missing in $ctx"
[ -f "$ctx/Dockerfile" ] || fail "Dockerfile missing in $ctx"
[ -f "$ctx/.dockerignore" ] || fail ".dockerignore missing in $ctx"
[ -f "$ctx/docker-compose.yml" ] || fail "docker-compose.yml missing in $ctx"

# ── 1. requirements.txt: exact pins only ─────────────────────────────────
if [ -f "$ctx/requirements.txt" ]; then
  bad_pins=0
  while IFS= read -r line; do
    case "$line" in
      "" | \#*) continue ;;
    esac
    case "$line" in
      *==*) : ;;
      *) echo "  $line"; bad_pins=$((bad_pins + 1)) ;;
    esac
  done < "$ctx/requirements.txt"
  [ "$bad_pins" -eq 0 ] || fail "requirements.txt has $bad_pins non-== pin(s)"
  [ -s "$ctx/requirements.txt" ] || fail "requirements.txt is empty"
  pass "requirements.txt: exact == pins only"
fi

# ── 2. Dockerfile contract ────────────────────────────────────────────────
dockerfile=$(cat "$ctx/Dockerfile" 2>/dev/null || true)
if [ -n "$dockerfile" ]; then
  echo "$dockerfile" | grep -q "FROM python:3.12-slim" || fail "Dockerfile must be FROM python:3.12-slim"
  echo "$dockerfile" | grep -q "AS builder" || fail "Dockerfile must be multi-stage (builder)"
  echo "$dockerfile" | grep -q "AS runtime" || fail "Dockerfile must be multi-stage (runtime)"
  echo "$dockerfile" | grep -qE '^[[:space:]]*HEALTHCHECK' && fail "Dockerfile must not declare HEALTHCHECK"
  echo "$dockerfile" | grep -q "USER 1000:1000" || fail "Dockerfile must run as USER 1000:1000"
  echo "$dockerfile" | grep -q '"start"' || fail "Dockerfile ENTRYPOINT must be production start (not dev)"
  echo "$dockerfile" | grep -q '"dev"' && fail "Dockerfile ENTRYPOINT must not use dev mode"
  echo "$dockerfile" | grep -q 'COPY \. \.' && fail "Dockerfile must not blanket COPY the whole context"
  echo "$dockerfile" | grep -qE 'COPY .*\.env' && fail "Dockerfile must not COPY .env"
  echo "$dockerfile" | grep -q -- '--no-cache-dir' || fail "Dockerfile pip install must use --no-cache-dir"
  pass "Dockerfile: multi-stage python:3.12-slim, non-root, prod entrypoint, no healthcheck"
fi

# ── 3. .dockerignore exclusions ───────────────────────────────────────────
dockerignore=$(cat "$ctx/.dockerignore" 2>/dev/null || true)
if [ -n "$dockerignore" ]; then
  for pat in '^.env$' '^.env\.' '^.git$' '^tests$' '^.venv$' '__pycache__' '^Dockerfile$'; do
    echo "$dockerignore" | grep -qE "$pat" || fail ".dockerignore must exclude: $pat"
  done
  pass ".dockerignore: excludes .env/.git/venv/caches/tests/container files"
fi

# ── 4. No .env baked in the context ──────────────────────────────────────
if [ -f "$ctx/.env" ]; then
  fail ".env present in build context (would be baked)"
else
  pass "no .env in build context"
fi

# ── 5. docker-compose.yml contract ────────────────────────────────────────
compose=$(cat "$ctx/docker-compose.yml" 2>/dev/null || true)
if [ -n "$compose" ]; then
  echo "$compose" | grep -qiE "healthcheck|HEALTHCHECK" && fail "docker-compose.yml must not declare a probe"
  echo "$compose" | grep -q 'user: "1000:1000"' || fail "docker-compose.yml must run as user 1000:1000"
  pass "docker-compose.yml: non-root user, no healthcheck"
fi

# ── 6. First-party import closure ⊆ Dockerfile COPY (non-vacuous) ─────────
# The defect this catches (PR102): agent.py grew `import phone` but the image
# COPY list did not, so `python agent.py start` died with ModuleNotFoundError.
# scripts/docker_import_closure.py is the single implementation (shared with
# app/voice-livekit/tests/test_docker_packaging.py, so the unit mutation
# controls exercise exactly the code CI runs here). It:
#   - derives the closure ROOT from the Dockerfile's JSON ENTRYPOINT rather
#     than hardcoding `agent.py`, and fails closed if the entrypoint is
#     absent, shell-form, malformed, non-Python, ambiguous, or names a file
#     outside the first-party source set;
#   - AST-walks the transitive first-party import closure from that root and
#     fails on any un-COPY'd module (MISSING_COPY);
#   - resolves each worker-source COPY destination against the WORKDIR in
#     force and fails unless it lands in /app (BAD_COPY_DEST) — a destination
#     outside the interpreter search path reproduces the very same startup
#     ModuleNotFoundError while every other rule stays green;
#   - fails on any secret/env file in a COPY (FORBIDDEN_COPY).
# It is never skipped: a context whose Dockerfile cannot be rooted is a
# failure, not a pass.
if [ -n "$dockerfile" ]; then
  if ! command -v python3 >/dev/null 2>&1; then
    fail "python3 required to validate the import→COPY closure (refusing to skip)"
  else
    closure_out=$(python3 "$root/scripts/docker_import_closure.py" "$ctx") && closure_rc=0 || closure_rc=$?
    echo "$closure_out" | sed 's/^/  /'
    if [ "${closure_rc:-0}" -ne 0 ]; then
      fail "Dockerfile packaging contract (entrypoint-rooted import closure -> COPY -> /app) violated"
    else
      pass "Dockerfile COPY covers the exact first-party import closure of the ENTRYPOINT script, lands in /app, and copies no secret/env file"
    fi
  fi
fi

# ── Optional bounded Docker execution (local only, never CI) ─────────────
if [ "$docker_flag" = "1" ]; then
  if ! command -v docker >/dev/null 2>&1; then
    fail "--docker requested but docker is unavailable"
  else
    image="hello-voice-test"
    echo "INFO  docker build -t $image $ctx"
    docker build -t "$image" "$ctx" >/dev/null
    uid=$(docker run --rm --entrypoint id "$image" -u 2>/dev/null || docker run --rm --entrypoint id "$image")
    echo "INFO  container uid: $uid"
    case "$uid" in
      0 | "0"*) fail "container runs as root (uid=$uid)" ;;
      *) pass "container runs as non-root (uid=$uid)" ;;
    esac
    # Prove the runtime import path resolves inside the image with NO network:
    # phone (the PR102 regression) and agent must both import from /app, and
    # phone.__file__ must be under /app (the intended path, not a stray copy).
    if docker run --rm --network none --entrypoint python "$image" -c "from livekit.agents import WorkerOptions; import phone, agent; assert phone.__file__.startswith('/app/'), phone.__file__; assert agent.__file__.startswith('/app/'), agent.__file__; print('ok', phone.__file__, agent.__file__)"; then
      pass "in-container import OK (network none): phone + agent import from /app"
    else
      fail "in-container import check failed (phone/agent did not import from /app)"
    fi
  fi
fi

if [ "$failures" -ne 0 ]; then
  echo "validate-container: FAILED ($failures)"
  exit 1
fi
echo "validate-container: PASS"
