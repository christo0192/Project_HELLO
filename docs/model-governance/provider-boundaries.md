# LLM-01 — Provider Boundary Inventory (PR-A Lane A1)

**Status:** PROPOSED
**Evidence state:** repository-only (no authentic external evidence)
**Baseline:** `b3f1f301`

## Purpose

This document catalogs **every current provider boundary path** in the
screening product. It is the reference for which concrete code reaches which
provider, through which mechanism, using which environment variable **names**
and which allowlists.

**No universal provider abstraction exists; these are the current contracts.**
Each workload reaches its provider through a workload-specific, concrete
boundary:

- **TypeScript / API:** `claude.ts` (CLI spawn), `prompts.ts` (prompt
  construction), `assessment.ts` (scoring), `model-provenance.ts`
  (provenance).
- **Python / voice-livekit:** `agent.py` (LiveKit plugin constructors),
  `prompting.py` (prompt assembly), `provenance.py` (provenance),
  `persistence.py` (Supabase + first-party API calls).

This inventory introduces **no adapters, no provider clients, no network
access, and no provider switch**. It is pure metadata describing the
boundaries as they exist today. The word "adapter" does not appear in the
deliverable code; there is no interface to wrap because the current boundaries
are concrete contracts (a CLI spawn and LiveKit SDK constructors).

## Policy states

Every entry below carries a repository-only policy state. Allowed states are:

| State | Meaning |
|---|---|
| `PROPOSED` | Contract documented in-repository; no owner or external acceptance |
| `PENDING` | Implementation exists but external behavior is owner-verification pending |
| `NOT_EVALUATED` | No evaluation performed (reserved for future compare-report slots) |

A positive approval claim (`APPROVED`/`DEPLOYED`/`ACCEPTED`/`winner`) is
rejected **unconditionally** by `scripts/check-model-governance-status.mjs`
and by the TS/Python boundary validators: repository-only Phase 10 work
carries no authentic external evidence, so no `EV-xxxx` reference, UUID, or
other identifier string can authorize a positive claim. No entry in this
inventory claims one.

## TypeScript boundary catalog (runtime: `api`)

| Boundary | Provider | Workload | Mechanism | Source path | Env var names |
|---|---|---|---|---|---|
| Claude CLI spawn | anthropic | screening, scoring, resume_extraction | `cli_spawn` (`claude -p --model <model> --max-turns 1`, `shell:false`) | `app/api/src/lib/claude.ts` | `CLAUDE_BIN`, `CLAUDE_MODEL`, `CLAUDE_TIMEOUT_MS`, `CLAUDE_MAX_OUTPUT_BYTES`, `BREAKER_FAILURE_THRESHOLD`, `BREAKER_COOLDOWN_MS`, `BREAKER_TIMEOUT_MS` |
| Prompt construction | anthropic | screening, scoring, resume_extraction | `prompt_construction` | `app/api/src/lib/prompts.ts` | *(none — pure text)* |
| Scoring | anthropic | scoring | `scoring` | `app/api/src/services/assessment.ts` | `CLAUDE_SCORING_MODEL` |
| Provenance | anthropic | screening, scoring | `provenance` | `app/api/src/lib/model-provenance.ts` | *(none)* |

### 1. `claude.ts` — Claude CLI spawn

- **Boundary kind:** child-process CLI spawn. The runner spawns the `claude`
  executable directly with `shell:false` and a fixed argument array
  (`-p`, `--model <model>`, `--max-turns 1`, optional
  `--append-system-prompt`).
- **Used by:** screening conversation (`routes/screening.ts`), scoring
  (`services/assessment.ts`), and resume extraction (`routes/resumes.ts`).
- **Resilience:** circuit breaker, per-call timeout, and bounded output via
  `provider-resilience.ts`. Errors map to stable categories; diagnostics never
  echo provider output.
- **Allowlists:** none enforced at the spawn itself (model is a bounded string);
  provenance allowlists apply at the provenance layer.
- **Status:** PROPOSED.

### 2. `prompts.ts` — prompt construction

- **Boundary kind:** deterministic prompt/context assembly.
- **Contents:** `SCREENING_SYSTEM`, `buildConversationPrompt()`,
  `buildAssessmentPrompt()`, `buildExtractionPrompt()`, `buildOpeningMessage()`.
- **Version constants:** `SCREENING_PROMPT_TEMPLATE_VERSION`,
  `SCORING_PROMPT_TEMPLATE_VERSION` — consumed by `model-provenance.ts`.
- **Boundary note:** pure text construction; no environment reads, no network.
- **Status:** PROPOSED.

### 3. `assessment.ts` — scoring

- **Boundary kind:** post-session scoring path.
- **Mechanism:** `buildAssessmentPrompt()` → `runClaudeJSONWithProvenance()` with
  the scoring model (`CLAUDE_SCORING_MODEL`); overall score and recommendation
  are recomputed in code from fixed weights (transparent, tunable).
- **Provenance:** persisted with `scoringProvenance()` (workload `scoring`).
- **Status:** PROPOSED.

### 4. `model-provenance.ts` — provenance

- **Boundary kind:** non-secret provenance tracking.
- **Allowlists:** provider `anthropic`; workloads `screening`, `scoring`.
- **Guarantees:** closed identifier grammar, `requestedModel` records design
  intent only (never a provider-resolved value), UTC RFC 3339 timestamps,
  diagnostics never echo rejected values.
- **Status:** PROPOSED.

## Python boundary catalog (runtime: `voice-livekit`)

| Boundary | Provider | Workload | Mechanism | Source path | Env var names |
|---|---|---|---|---|---|
| Worker connection | livekit | screening | `sdk_constructor` (worker bootstrap) | `app/voice-livekit/agent.py` | `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` |
| STT | sarvam | screening | `sdk_constructor` (`sarvam.STT`) | `app/voice-livekit/agent.py` | `SARVAM_STT_MODEL`, `SARVAM_LANGUAGE` |
| TTS | sarvam | screening | `sdk_constructor` (`sarvam.TTS`) | `app/voice-livekit/agent.py` | `SARVAM_TTS_MODEL`, `SARVAM_TTS_VOICE` |
| Conversation LLM | gemini | screening | direct streaming `sdk_constructor` (`openai.LLM`) | `app/voice-livekit/agent.py` | `GEMINI_MODEL`, `GEMINI_BASE_URL` |
| Turn handling | livekit | screening | `AgentSession` defaults | `app/voice-livekit/agent.py` | *(none)* |
| Prompt assembly | gemini | screening | `prompt_construction` | `app/voice-livekit/prompting.py` | `COMPANY_NAME` |
| Provenance | gemini | screening | `provenance` | `app/voice-livekit/provenance.py` | *(none)* |
| Persistence | supabase | screening | `persistence` | `app/voice-livekit/persistence.py` | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_SCHEMA`, `WORKER_CONTEXT_SECRET`, `WORKER_CONTEXT_TIMEOUT_SEC`, `API_BASE`, `SCORING_BREAKER_THRESHOLD`, `SCORING_BREAKER_COOLDOWN_SEC`, `SCORING_BREAKER_TIMEOUT_SEC`, `SCORING_HTTP_CONNECT_TIMEOUT`, `SCORING_HTTP_READ_TIMEOUT`, `SCORING_HTTP_WRITE_TIMEOUT`, `SCORING_HTTP_POOL_TIMEOUT`, `LIVEKIT_WORKER_DRAIN_SEC` |

### 5. `agent.py` — LiveKit plugin constructors

- **Boundary kind:** LiveKit Agents SDK constructors inside `AgentSession`:
  `sarvam.STT`, `sarvam.TTS`, and OpenAI-compatible `openai.LLM`. No custom VAD
  or local turn-detector constructor is provided; turn handling uses LiveKit
  Agents defaults.
- **Notes:**
  - STT/TTS/LLM network calls are **SDK-internal**; no constructor parameter
    exposes timeout, retry, or circuit-breaker configuration
    (see `docs/runbooks/provider-resilience.md`).
  - The Gemini model id is read from `GEMINI_MODEL`; the OpenAI-compatible
    adapter streams directly from Google's endpoint in `GEMINI_BASE_URL`, and
    provenance is claimed via `set_session_provenance()` before construction.
  - VAD and turn detection are local models, not network providers.
  - Silero VAD is NOT a provider API; it is a local ONNX model.
- **Status:** PENDING for SDK-internal and connection behavior (owner
  verification); see the catalog table.

### 6. `prompting.py` — prompt assembly

- **Boundary kind:** deterministic prompt/context assembly for the worker.
- **Contents:** `system_prompt`, `opening_line`, `build_prompt_context`,
  `collect_prompt_metadata`.
- **Boundary note:** context is env-only or server-verified (`WORKER_CONTEXT`
  resolution, SEC-13); client-visible room metadata is never used.
- **Status:** PROPOSED.

### 7. `provenance.py` — provenance

- **Boundary kind:** non-secret provenance tracking (mirrors the TS shape
  without cross-imports).
- **Allowlists:** provider `anthropic`; workloads `screening`, `scoring`.
- **Status:** PROPOSED.

### 8. `persistence.py` — Supabase + first-party API

- **Boundary kind:** durable state via the Supabase client, plus first-party
  HTTP calls against our own API (`API_BASE`): the scoring-trigger POST and
  the worker-context lookup. The scoring trigger is **our own API**, not a
  third-party provider.
- **Resilience:** breaker wrapping via `provider_resilience.py`.
- **Status:** PENDING.

## What this inventory is NOT

- **Not an abstraction layer.** There is no universal provider interface and
  no adapter for STT/TTS/LLM/scoring. Adding one would require modifying the
  existing production SDK constructors and would imply a provider-switch
  capability that does not exist and is not being built.
- **Not a provider switch.** No endpoint, region, quota, or entitlement is
  claimed or changed. All provider account, pricing, residency, and DPA facts
  remain owner-verification pending.
- **Not an approval.** No entry claims `APPROVED`, `DEPLOYED`, `ACCEPTED`, a
  winner, a positive SLSA level, or a signed artifact. Every external item is
  `PROPOSED` or `PENDING` here, consistent with the audited plan's C1/C4
  corrections.

## Enforcement

- `app/api/src/model-governance/provider-boundaries.ts` and
  `app/voice-livekit/model_governance/provider_boundaries.py` carry the same
  catalog as pure metadata and validate it at import time (fail fast on
  drift).
- Unit tests prove the mandatory negative controls: URL-lookalike values in
  optional fields are rejected, token-lookalike values are rejected, and a
  positive approval claim is rejected unconditionally (even with an `EV-FAKE`
  or random-UUID evidence reference).
- `scripts/check-model-governance-status.mjs` scans all PR-A model-governance
  artifact paths and rejects any status/policy/approval field whose value is
  `APPROVED`, `DEPLOYED`, or `ACCEPTED`, any `winner` claim, any
  `slsa_level` greater than zero, and any `signed` flag set to `true` —
  unconditionally, with no external-evidence bypass.

## Relationship to other artifacts

- `docs/runbooks/provider-resilience.md` — outbound boundary + resilience
  table (Phase 9); this inventory is the LLM-01 governance view of the same
  boundaries.
- `docs/runbooks/model-provenance.md` — provenance schema and lifecycle; the
  allowlists referenced here.
- `docs/adr/0002-current-voice-and-model-runtime.md` — records the current
  runtime decision this inventory describes.
