# syntax=docker/dockerfile:1

# Multi-stage build for the LiveKit Agents voice worker.
#
# Truthful boundaries:
#  - Non-root runtime (uid/gid 1000), writable bounded HOME/cache, minimal copy
#    context (worker sources only; no .env, VCS, venv, caches, tests, docs).
#  - Production entrypoint is `python agent.py start` (not `dev`).
#  - No HEALTHCHECK and no fake readiness server: the SDK worker does not
#    expose an HTTP readiness endpoint, and provider-connected behavior (job
#    drain on SIGTERM) is owner-verified at runtime, not claimed here.
#  - No custom VAD or local turn-detector model is bundled; turn handling uses
#    LiveKit Agents defaults to stay within the low-memory worker budget.
#  - Direct pins only (requirements.txt); this is not a full lock.

# Stage 1: resolve and install pinned direct dependencies in an isolated venv.
FROM python:3.12-slim AS builder

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_ROOT_USER_ACTION=ignore

WORKDIR /build

COPY requirements.txt ./
RUN python -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt

# Stage 2: minimal runtime image with the venv and worker sources only.
FROM python:3.12-slim AS runtime

ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPYCACHEPREFIX=/tmp/pycache \
    HOME=/home/agent \
    XDG_CACHE_HOME=/home/agent/.cache

WORKDIR /app

# Non-root application user (uid/gid 1000) with a writable bounded home/cache.
RUN groupadd --gid 1000 agent \
    && useradd --uid 1000 --gid 1000 --create-home --home-dir /home/agent agent \
    && mkdir -p /home/agent/.cache \
    && chown -R 1000:1000 /home/agent

COPY --from=builder /opt/venv /opt/venv

# Worker sources only — the build context excludes everything else
# (see .dockerignore). No .env is ever copied into the image.
#
# This list is the EXACT first-party import closure of the entrypoint
# (transitively via `import phone`, `import persistence`, etc.), and nothing
# more. It is enforced statically, not by convention:
# scripts/docker_import_closure.py — run by scripts/validate-container.sh in
# CI — derives the closure ROOT from this final stage's JSON ENTRYPOINT below
# (never hardcoded; FROM resets ENTRYPOINT, so an earlier stage's does not
# count), AST-walks the transitive closure from it, and fails the build
# contract if any transitively-imported local module is not COPY'd here in the
# final stage, if a secret/env file is, if the destination does not resolve to
# /app, or if the EFFECTIVE final WORKDIR is not where the entrypoint script
# resolves. The last two are the same outage in different disguises: modules
# outside the interpreter search path, and modules in /app with the
# interpreter started somewhere else
# (`python: can't open file '/srv/agent.py'`). phone.py was added in P4a
# (`import phone` in agent.py) and MUST ship, or the worker dies at startup
# with `ModuleNotFoundError: No module named 'phone'`.
# phone_canary.py was added the same way (`import phone_canary` in agent.py,
# for the Canary-1 branch) and ships for the same reason: an armed worker that
# cannot import it crash-loops at startup instead of refusing a dispatch.
# Deliberately excluded (not on the runtime import path): voice_quality_harness.py,
# model_governance/, tests/ — see .dockerignore.
# Limitation: the static closure resolves absolute, relative, and literal-string
# dynamic imports (importlib.import_module("x")/__import__("x")); a first-party
# module pulled in only via a computed/non-literal import name cannot be seen
# statically and must be added here by hand.
COPY agent.py observability.py persistence.py phone.py phone_canary.py prompting.py provenance.py provider_resilience.py ./

USER 1000:1000

# Production worker command. `dev`/`console` are development modes and are not
# exposed as the container default.
ENTRYPOINT ["python", "agent.py", "start"]
