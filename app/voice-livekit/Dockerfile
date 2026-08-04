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
#  - Model weights are downloaded at build time via the LiveKit Agents SDK so
#    the runtime worker does not fail lazy turn-detector initialization.
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
COPY agent.py observability.py persistence.py prompting.py provenance.py provider_resilience.py ./

# Download local VAD/turn-detector model assets into the runtime cache before
# dropping privileges. The worker has no HTTP probe, so missing model files must
# fail during image build rather than first production job startup.
RUN python agent.py download-files \
    && chown -R 1000:1000 /home/agent

USER 1000:1000

# Production worker command. `dev`/`console` are development modes and are not
# exposed as the container default.
ENTRYPOINT ["python", "agent.py", "start"]
