# Runbook: LiveKit Cloud Build + Cloud Agents (managed pilot)

Status: **OWNER-OPERATED / PENDING verification.** This runbook is repository
architecture only. No LiveKit Cloud account, project, card, entitlement,
free-tier, pricing, residency, or DPA fact is claimed here; every external item
is PENDING owner verification (see [ADR-0010](../adr/0010-hosting-topology.md)).

## 1. What this runbook covers

- How the containerised worker (`app/voice-livekit`) is meant to run against a
  managed LiveKit Cloud project (Build tier SFU + Cloud Agents deployment).
- What is verified (command surface, container contract) versus what is
  OWNER_VERIFY (account, deployment, provider behavior, model strategy).

## 2. Verified command surface (2026-08-02)

Verified from the public `livekit/agents` repository at tag
`livekit-agents@1.6.4` (no login):

| Command | Purpose | Verification |
| --- | --- | --- |
| `python agent.py start` | Production worker: connects to the LiveKit server/Cloud project using `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`; supports `--drain-timeout` for job drain on shutdown. | Syntax verified from 1.6.4 source; container ENTRYPOINT. Provider-connected drain behavior = OWNER_VERIFY. |
| `python agent.py dev` | Development worker mode (watch/reload). | Syntax verified from 1.6.4 source. Not the container default. |
| `python agent.py console` | Local mic/speaker console; no LiveKit room needed. | Syntax verified from 1.6.4 source. Development only. |
| `python agent.py download-files` | Legacy per-script command that invokes each plugin's `download_files()`. The 1.6.4 source prints a deprecation note pointing to the module command. | Existence verified from 1.6.4 source. Strategy = OWNER_VERIFY (see §4). |
| `python -m livekit.agents download-files` | Official module command: discovers `livekit.plugins.*` packages and runs each registered plugin's `download_files()` (silero VAD ONNX weights, turn-detector multilingual model). | Source verified from 1.6.4. Not executed in CI (heavyweight model download). |

The `lk` CLI (LiveKit CLI, Go binary) and Cloud Agents deployment commands
(e.g. agent deployment via the Cloud dashboard/CLI) are **OWNER_VERIFY**:
verify the exact current command surface with `lk --help` and the official
LiveKit Cloud Agents documentation at deployment time. None are CI-executed and
none are claimed successful here.

## 3. Container contract (repository-owned, validated)

- Multi-stage `python:3.12-slim` image; non-root `USER 1000:1000`; writable
  bounded HOME/cache; minimal copy context (worker sources only).
- No `.env`, VCS, venv, caches, tests, or docs are copied into the image.
- Production entrypoint: `python agent.py start`.
- No HEALTHCHECK and no fake readiness server: the SDK worker exposes no HTTP
  readiness endpoint.
- Local validation (owner or verifier, requires Docker):

```bash
docker build -t hello-voice-test app/voice-livekit/
docker run --rm --entrypoint id hello-voice-test          # uid must be non-root
docker run --rm --entrypoint python hello-voice-test \
  -c "from livekit.agents import WorkerOptions; import agent; print('ok')"
bash scripts/validate-container.sh
bash scripts/validate-no-secrets-baked.sh
```

CI runs the bounded static subset only
(`.github/workflows/hosting-validate.yml`); Docker builds are not run in CI.

## 4. Model weights strategy — OWNER_VERIFY

The worker imports `silero.VAD` (ONNX weights) and
`livekit.plugins.turn_detector.multilingual.MultilingualModel` (transformers
multilingual turn-detector). These weights are pulled by
`python -m livekit.agents download-files` (or the legacy
`python agent.py download-files`) and are NOT bundled in the image build.

The decision of where/how to materialise the weights for Cloud Agents
(build-time download, startup download with retry, or an agents-deployment
artifact/volume) depends on the current official LiveKit Cloud Agents guidance
and the deployed project's storage rules — **OWNER_VERIFY**. We do not execute
heavyweight provider/model downloads in CI and we make no claim that any
download or model command has run successfully.

## 5. Environment variables (names only — no values)

`LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_SCHEMA`, `API_BASE`,
`WORKER_CONTEXT_SECRET`, `ANTHROPIC_API_KEY`, `SARVAM_API_KEY`,
`LIVEKIT_WORKER_DRAIN_SEC` and the tuning knobs documented in
`app/voice-livekit/.env.example`.

Values are injected at runtime from managed Infisical
([hosting-infisical.md](hosting-infisical.md)) — never baked into the image.

## 6. PENDING owner verification (external register)

- LiveKit Cloud account/project creation, Build + Cloud Agents entitlements.
- Pricing, free-tier limits, session-minute/concurrency entitlements.
- Agent deployment via the Cloud dashboard or CLI (`lk --help` surface).
- Data residency/region and DPA evidence.
- Runtime drain/graceful-stop proof against a live project.
- `download-files` build/runtime strategy per current official guidance.

## 7. Boundaries

No account creation, card entry, paid purchase, cloud apply, or production
deployment without interactive owner action. No secret values are stored in
this repository. Production acceptance remains a separate gate.
