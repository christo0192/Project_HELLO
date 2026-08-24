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
#     the entrypoint agent.py (AST-parsed, transitive) and copies no secret/env
#     file. This is what prevents a re-run of PR102 (agent.py imported `phone`
#     but the image omitted phone.py → ModuleNotFoundError at startup).
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
# We parse the entrypoint's transitive first-party import closure with a real
# AST walk and assert every local module file it needs is COPY'd — and that no
# secret/env file is COPY'd. Skipped only when agent.py is absent (mini
# negative-control fixtures that exercise other rules); the real context always
# has it, so this is not a vacuity hole.
if [ -f "$ctx/agent.py" ] && [ -n "$dockerfile" ]; then
  if ! command -v python3 >/dev/null 2>&1; then
    fail "python3 required to validate the import→COPY closure (refusing to skip)"
  else
    closure_out=$(python3 - "$ctx" <<'PY'
import ast, os, re, sys

ctx = sys.argv[1]
entry = "agent"

# Local (first-party) importable names: top-level .py modules and packages
# (directories with __init__.py) that live in the build context.
local = {}
for e in sorted(os.listdir(ctx)):
    p = os.path.join(ctx, e)
    if e.endswith(".py"):
        local[e[:-3]] = e
    elif os.path.isdir(p) and os.path.isfile(os.path.join(p, "__init__.py")):
        local[e] = e  # package directory

def top_imports(pyfile):
    try:
        tree = ast.parse(open(pyfile, encoding="utf-8").read(), filename=pyfile)
    except (OSError, SyntaxError) as exc:
        print("PARSE_ERROR %s: %s" % (pyfile, exc))
        sys.exit(3)
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                names.add(a.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            if node.module:
                # `from pkg[.sub] import x` — top segment may be a local pkg.
                names.add(node.module.split(".")[0])
            elif node.level:
                # `from . import sibling` (module is None): each imported name
                # is a sibling module/package in the same package.
                for a in node.names:
                    names.add(a.name.split(".")[0])
        elif isinstance(node, ast.Call):
            # Literal-string dynamic imports: importlib.import_module("phone")
            # or __import__("phone"). Non-literal args are unresolvable and are
            # a documented limitation (see the Dockerfile COPY comment).
            fn = node.func
            is_dyn = (isinstance(fn, ast.Attribute) and fn.attr == "import_module") or \
                     (isinstance(fn, ast.Name) and fn.id == "__import__")
            if is_dyn and node.args:
                arg = node.args[0]
                if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                    names.add(arg.value.split(".")[0])
    return names

# BFS the closure from the entrypoint through first-party modules only.
closure, stack = set(), [entry]
while stack:
    m = stack.pop()
    if m in closure or m not in local:
        continue
    closure.add(m)
    src = os.path.join(ctx, local[m])
    files = [src]
    if os.path.isdir(src):
        files = [os.path.join(r, f) for r, _, fs in os.walk(src)
                 for f in fs if f.endswith(".py")]
    for f in files:
        for n in top_imports(f):
            if n in local and n not in closure:
                stack.append(n)

# COPY sources in the Dockerfile. Robust to real Dockerfile shapes:
#  - backslash line-continuations are joined first;
#  - the COPY keyword is matched case-insensitively (Docker is);
#  - `--from=` stage copies (the venv) are ignored;
#  - leading `--chown=`/`--chmod=`/`--link` flag tokens are dropped, not
#    mistaken for source paths.
def copy_sources(text):
    text = re.sub(r"\\\s*\n", " ", text)  # join line-continuations
    srcs = []
    for raw in text.splitlines():
        s = raw.strip()
        if not s or s.startswith("#"):
            continue
        toks = s.split()
        if toks[0].lower() != "copy":
            continue
        toks = toks[1:]
        if any(t.startswith("--from=") for t in toks):
            continue
        toks = [t for t in toks if not t.startswith("--")]  # drop flags
        if len(toks) >= 2:
            srcs.extend(toks[:-1])  # drop the destination token
    return srcs

copy_srcs = copy_sources(open(os.path.join(ctx, "Dockerfile"), encoding="utf-8").read())
copy_set = {t.rstrip("/") for t in copy_srcs}

# Every closure module's file/dir must be COPY'd.
missing = sorted(local[m].rstrip("/") for m in closure if local[m].rstrip("/") not in copy_set)

# No secret/env file may be COPY'd (basename-based; defense-in-depth behind
# .dockerignore + the "no .env in context" check). Not exhaustive, but covers
# the common credential shapes.
SECRET_NAMES = {"id_rsa", "id_ed25519", "id_ecdsa", "credentials", "secrets",
                ".netrc", ".pgpass", ".htpasswd", "kubeconfig", ".dockercfg",
                ".dockerconfigjson", ".npmrc", "service-account.json"}
SECRET_SUBSTR = ("secret", "credential", "password", "passwd", "apikey", "api_key", "token")
forbidden = []
for src in copy_srcs:
    base = os.path.basename(src.rstrip("/"))
    low = base.lower()
    is_env = base == ".env" or (base.startswith(".env.") and base != ".env.example")
    is_secret = (low.endswith((".pem", ".key", ".p12", ".pfx", ".pkcs12"))
                 or low in SECRET_NAMES
                 or any(sub in low for sub in SECRET_SUBSTR))
    if is_env or is_secret:
        forbidden.append(src)

print("CLOSURE " + ",".join(sorted(closure)))
if missing:
    print("MISSING_COPY " + ",".join(missing))
if forbidden:
    print("FORBIDDEN_COPY " + ",".join(sorted(set(forbidden))))
sys.exit(1 if (missing or forbidden) else 0)
PY
    ) && closure_rc=0 || closure_rc=$?
    echo "$closure_out" | sed 's/^/  /'
    if [ "${closure_rc:-0}" -ne 0 ]; then
      fail "Dockerfile COPY does not cover the first-party import closure of agent.py"
    else
      pass "Dockerfile COPY covers the exact first-party import closure of agent.py (no secret/env files)"
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
