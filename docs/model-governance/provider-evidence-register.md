# LLM-05 — Provider Evidence Register (PR-A Lane A2)

**Status:** PENDING (all external evidence slots)
**Evidence state:** repository-only (no authentic external evidence)
**Baseline:** `b3f1f301`

## Purpose

This register tracks the **external evidence status** for every provider at
the product's provider boundaries: region, data retention, subprocessors,
endpoints, DPA, residency, and approval. It covers the current providers
(anthropic, sarvam, silero, livekit, supabase) and the optional-comparison
providers (gemini, deepseek).

Every evidence slot in this register is **PENDING** or **OWNER_VERIFY**.
Repository-only work contains no authentic endpoint, residency, or DPA
approval, and this register never invents one.

## Status legend

| Token | Meaning |
|---|---|
| `PENDING` | Evidence not yet provided by the provider/owner; not verified |
| `OWNER_VERIFY` | Behavior exists but must be verified by the repository owner against the provider |
| `NOT_APPLICABLE` | Slot does not apply (e.g., a local model has no external region) |

A positive approval claim (`APPROVED`/`DEPLOYED`/`ACCEPTED`/`winner`) is
rejected by `validateEvidenceRegisterEntries()` and by
`scripts/check-model-governance-status.mjs` **unconditionally**: no `EV-xxxx`
reference, UUID, or other identifier string can authorize a positive claim,
because repository-only work carries no authentic external evidence.

**Latency is not residency.** Region/residency slots accept only the closed
status tokens above; latency-like values (for example `35ms`) are rejected.

## Register (current providers)

| Provider | Category | Region | Retention | Subprocessors | Endpoint | DPA | Residency | Approval |
|---|---|---|---|---|---|---|---|---|
| anthropic | current | OWNER_VERIFY | PENDING | PENDING | OWNER_VERIFY | PENDING | PENDING | PENDING |
| sarvam | current | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING |
| silero | current | PENDING | PENDING | PENDING | PENDING (local model) | PENDING | PENDING | PENDING |
| livekit | current | OWNER_VERIFY | PENDING | PENDING | OWNER_VERIFY | PENDING | PENDING | PENDING |
| supabase | current | PENDING | PENDING | PENDING | OWNER_VERIFY | PENDING | PENDING | PENDING |

Notes:

- **anthropic** — Claude CLI (API) and Anthropic LLM plugin (voice-livekit).
  No endpoint or account evidence exists in-repository; region and endpoint
  behavior are owner-verification pending.
- **sarvam** — LiveKit Sarvam STT/TTS plugins. All external slots pending
  owner verification.
- **silero** — local ONNX VAD model, not a network provider; its endpoint slot
  is documented as NOT_APPLICABLE while external evidence slots remain pending.
- **livekit** — LiveKit Cloud pilot topology per ADR-0010 (managed LiveKit
  Cloud + Cloud Agents). Region/endpoint behavior is owner-verification
  pending; no deployment or quota evidence exists in-repository.
- **supabase** — persistence via the Supabase client (voice-livekit). Region,
  retention, and DPA pending owner verification; no endpoint values recorded
  here.

## Register (optional-comparison providers)

| Provider | Category | Region | Retention | Subprocessors | Endpoint | DPA | Residency | Approval |
|---|---|---|---|---|---|---|---|---|
| gemini | optional_comparison | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING |
| deepseek | optional_comparison | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING |

Gemini (LLM-03) and DeepSeek (LLM-04) are **optional comparison slots only**.
They are `NOT_EVALUATED`: no evaluation was performed, no endpoint is recorded,
no account evidence exists, and there is no winner between any providers. These
lanes are gated on the LLM-02 evaluation framework completing AND authentic
human-annotated data existing. Optional providers are not part of any current
production boundary.

## What this register is NOT

- **Not an approval record.** No entry claims an approved endpoint, residency,
  DPA, or account. All slots are PENDING or OWNER_VERIFY.
- **Not a secrets store.** Real endpoints, tokens, and credentials are never
  recorded. Endpoint placeholders are closed uppercase tokens
  (`PENDING_OWNER`, `NOT_APPLICABLE`); URL-lookalike and credential-lookalike
  values are rejected by the validator.
- **Not a provider switch.** Optional providers are placeholders; nothing in
  the register changes which provider any boundary uses.

## Enforcement

- `app/api/src/model-governance/evidence-register.ts` — shipped register
  metadata plus `validateEvidenceRegisterEntries()` (import-time self-check;
  fail fast on drift).
- `config/model-governance-evidence.schema.json` — machine-checkable contract
  for the register document and entries (draft-07).
- `app/api/src/__tests__/model-governance-evidence-register.test.ts` —
  mandatory negative controls.
- `scripts/check-model-governance-status.mjs` — rejects any approval/winner
  status claim in Phase 10 artifacts unconditionally; no `EV-xxxx`/UUID
  reference can bypass it.

### Negative controls proven by tests

1. Entry carrying an approval status (with or without an `EV-FAKE`/UUID owner
   evidence reference) → rejected unconditionally.
2. Latency-as-residency values in region/residency slots → rejected.
3. Secret-like endpoint placeholder (URL or credential lookalike) → rejected.
4. URL/token-lookalike notes and evidence refs → rejected.
5. Unknown fields, unallowlisted providers/categories, malformed ids → rejected.

## External PENDING (non-blocking for repository work)

Legal/vendor residency, retention, DPA, subprocessors, and endpoint evidence
for all current and optional providers remain **owner-verification pending**.
This register will be updated only when the owner provides authentic external
evidence; the status validator and register validator reject any earlier
approval claim unconditionally, regardless of any identifier string.
