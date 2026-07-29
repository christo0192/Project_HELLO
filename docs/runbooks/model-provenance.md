# LLM-06 Model Provenance — Runbook

## Overview

LLM-06 adds immutable, non-secret provenance tracking for every AI operation
(interview generation and scoring).  Each `call_sessions` and `assessments` row
carries a `provenance` JSONB column that records the requested/configured model,
provider, workload type, and prompt-template version that was used.

Key design decisions:
- **requestedModel, not provider-resolved model**: Provenance records the *design
  intent* model identifier — what the application was *configured* to use. It does
  NOT attempt to authenticate or verify which model the provider actually served.
- **LiveKit null → claim**: LiveKit sessions are created with `provenance = NULL`.
  The worker atomically claims provenance via compare-and-set before any LLM
  inference. This is the only allowed null→non-null transition.
- **Assessments NOT NULL**: Every assessment row carries provenance enforced at
  the DB level.
- **Immutability**: Once set (non-null), a DB trigger raises on any attempt to
  change provenance to a distinct value. Same-value no-op updates are allowed.

## Schema

### `call_sessions.provenance` (JSONB, nullable after backfill)

- **Simulation mode**: Set at session creation with the *requested* Anthropic
  model identifier (`CLAUDE_MODEL`).  Immutable once set (trigger raises on change).
- **LiveKit mode**: Intentionally `NULL` at session creation.  The LiveKit
  worker atomically claims provenance via `set_session_provenance()` before
  any LLM inference (compare-and-set: `WHERE id=? AND provenance IS NULL`).
  Never overwrites an existing value.  Claims with mismatched existing value
  return CONFLICT and the worker aborts.
- Backfilled legacy rows carry the explicit sentinel.

### `assessments.provenance` (JSONB, NOT NULL)

Set when `runAssessment()` inserts a new assessment row.  Records the
*requested* model identifier — returned by `runClaudeJSONWithProvenance()`
as `requestedModel`.  Immutable from insert (trigger raises on change).

### Provenance shape (schema_version = 1)

```json
{
  "schema_version": 1,
  "provider": "anthropic",
  "requestedModel": "claude-haiku-4-5-20251001",
  "workload": "screening|scoring",
  "prompt_template_version": "2026-07-28.1",
  "inference_params": {
    "temperature": 0.7,
    "max_tokens": 4096
  },
  "timestamp": "2026-07-28T12:00:00.000Z"
}
```

- `schema_version`: exactly `1` (positive integer) for validated rows; `0` for
  legacy sentinel.
- `provider`: allowlisted — only `anthropic`.  Rejected otherwise.
- `requestedModel`: The model identifier the application was configured to use.
  Must match the closed identifier grammar: `[a-zA-Z0-9][a-zA-Z0-9_\-.:/]*[a-zA-Z0-9]`
  (alphanumeric start/end; hyphens, dots, underscores, colons, slashes allowed
  in body).  Max 200 characters.  NOT a provider-resolved value — the provider
  may have served a different model.
- `workload`: allowlisted — `screening` or `scoring`.
- `prompt_template_version`: version identifier from `prompts.ts` constants.
- `inference_params`: optional object; only `temperature` (0–2, finite) and
  `max_tokens` (1–100000, integer) accepted.  Unknown keys rejected.
- `timestamp`: strict UTC RFC 3339 (`YYYY-MM-DDTHH:mm:ss(.sss)?Z`).  Rejects
  future timestamps beyond a 5-second clock-skew tolerance, impossible dates
  (Feb 31), and pre-epoch timestamps.
- No extra keys allowed.  Object byte size ≤ 2048 bytes.

### Legacy rows (schema_version = 0)

Rows created before migration 0005 carry an exact sentinel:

```json
{
  "schema_version": 0,
  "provider": "legacy",
  "requestedModel": "unknown",
  "workload": "unknown",
  "prompt_template_version": "legacy",
  "timestamp": "1970-01-01T00:00:00Z"
}
```

This is an exact frozen literal — the SQL constraint checks it key-for-key.
The legacy sentinel has exactly 6 keys with those exact values.
Never invents model evidence that wasn't captured at runtime.

## Query & audit semantics

### List sessions with their requested model

```sql
select id, status, provenance->>'requestedModel' as model,
       provenance->>'workload' as workload,
       provenance->>'prompt_template_version' as template_version
  from screening_v2.call_sessions
  where provenance is not null and provenance->>'schema_version' = '1'
  order by started_at desc;
```

### Find LiveKit sessions still awaiting worker claim

```sql
select id, status, started_at
  from screening_v2.call_sessions
 where provider = 'livekit' and provenance is null;
```

### Find assessments scored by a specific requested model

```sql
select a.id, a.overall_score, a.recommendation,
       a.provenance->>'requestedModel' as scoring_model
  from screening_v2.assessments a
 where a.provenance->>'requestedModel' = 'claude-sonnet-4-20250514'
   and a.provenance->>'workload' = 'scoring'
 order by a.created_at desc;
```

### Find legacy rows (pre-provenance)

```sql
select id, 'call_session' as entity
  from screening_v2.call_sessions
 where provenance->>'provider' = 'legacy'
union all
select id, 'assessment'
  from screening_v2.assessments
 where provenance->>'provider' = 'legacy'
 order by entity;
```

## Prompt template versions

Defined in `app/api/src/lib/prompts.ts` and used by
`app/api/src/lib/model-provenance.ts` (single source of truth for TS):

| Constant | Template | Current Version |
|---|---|---|
| `SCREENING_PROMPT_TEMPLATE_VERSION` | `buildConversationPrompt()` + `SCREENING_SYSTEM` | `2026-07-28.1` |
| `SCORING_PROMPT_TEMPLATE_VERSION` | `buildAssessmentPrompt()` | `2026-07-28.1` |

**Bump these** whenever the corresponding template function changes in a
semantically meaningful way (structure, scoring rubric, behavior).

### Workload-specific enforcement

Provenance factory functions enforce the correct version for each workload:
- `screeningProvenance()` uses `SCREENING_PROMPT_TEMPLATE_VERSION`
- `scoringProvenance()` uses `SCORING_PROMPT_TEMPLATE_VERSION`

This prevents a screening session from claiming an arbitrary safe version.

### Python parity

The Python worker (`provenance.py`) has a documented version constant
`SCREENING_PROVENANCE_VERSION` that must be manually kept in sync with
`SCREENING_PROMPT_TEMPLATE_VERSION` in `prompts.ts`.  A CI parity test
verifies alignment.

## Immutability guarantees

- **call_sessions.provenance**: may transition `null → validated value` once
  (LiveKit worker claim or backfill).  After non-null, the DB trigger
  `prevent_provenance_change()` raises a fixed exception (`'provenance:
  immutable once set'`) on any UPDATE that changes provenance to a distinct
  value.  Same-value no-op updates are permitted.  Null→null updates are
  permitted (for interim states before a session is claimed).
- **assessments.provenance**: inserted once with every `runAssessment()` call.
  The same trigger enforces immutability.  NOT NULL enforced via CHECK
  constraint `chk_assessments_provenance_not_null`.

### JSONB semantic equality, not byte-for-byte

All equality checks in the trigger and SQL function use PostgreSQL's JSONB
`distinct from` and `=` operators, which perform **semantic** comparison:
key order does not matter, and numeric values are compared semantically
(e.g., integer `1` equals float `1.0` in JSONB).  This is **not** a
byte-for-byte or character-for-character comparison.  Two JSONB values
that differ only in key ordering or number representation are considered
identical.  This is expected and safe — provenance values are validated
at the application layer before persistence, so only canonical shapes
reach the database.

## Non-acceptance boundaries

The provenance feature does **not**:

- Store raw prompt text, transcript content, candidate data, or provider
  API responses.
- Validate reproducibility or evaluation correctness.
- Approve a specific provider, model, or endpoint.
- Expose credentials, endpoint URLs, CLI paths, or provider exception bodies.
- Claim to know which model the provider actually served — it only records
  the *requested* model.
- Replace proper audit logging for candidate PII.
- Include `livekit` as a provider — it is an orchestrator, not the LLM.

## Application-layer validation

All provenance values pass through `validateProvenance()` in
`model-provenance.ts`.  Validation uses:

1. **Plain-object check**: Rejects null, arrays, class instances, objects with
   accessor descriptors, and objects with symbol keys.  Returns a deep-frozen
   copy that cannot be mutated by the caller.
2. **Closed identifier grammar**: model and version must match strict identifier
   patterns (`[a-zA-Z0-9][a-zA-Z0-9_\-.:/]*[a-zA-Z0-9]`).  This rejects
   whitespace, control characters, URLs, filesystem paths, credentials, email
   addresses, phone numbers, and high-entropy payloads.
3. **Allowlisted values**: provider must be `anthropic`; workload must be
   `screening` or `scoring`.
4. **Schema version**: must be exactly the integer `1`.
5. **Timestamp**: strict UTC RFC 3339 format; round-trip calendar validation
   (rejects Feb 31); pre-epoch rejection; future tolerance of 5 seconds.
6. **Size limits**: model ≤ 200 chars, version ≤ 100 chars, timestamp ≤ 30 chars,
   payload ≤ 2048 bytes.
7. **Inference params**: only `temperature` (0–2) and `max_tokens` (1–100000,
   integer).  Unknown keys/values rejected.
8. **Injectible clock**: `validateProvenance()` and factory functions accept
   an optional `ProvenanceClock` for deterministic testing.
9. **Diagnostics never echo values**: error messages use fixed category labels.

## SQL-level guardrails

The `valid_model_provenance()` PL/pgSQL function enforces the exact current
shape or the exact legacy sentinel.  It uses ONLY explicit boolean predicates
(no nullable `coalesce()` or `cardinality()` expressions).  Called by CHECK
constraints on both columns.

Key behaviors:
- `null` input → `false` (rejected).
- Current shape with `schema_version=1`, all 7 allowed keys, no extras,
  correct types and values → `true`.
- Legacy exact sentinel → `true`.
- Wrong `schema_version`, missing keys, extra keys, wrong types, wrong
  provider/workload, oversized values → `false`.
- Inference params: only `temperature` (0–2) and `max_tokens` (1–100000,
  integer).  Unknown keys/out-of-range → `false`.
- Timestamp format checked but NOT full calendar validation (that's at the
  application layer).
- Payload byte size ≤ 2048 bytes.

## Deployment order

1. **Apply migration 0005** to the Supabase project.
   - Adds columns, constraints, trigger functions, and backfills legacy rows.
   - Assessments become NOT NULL after backfill.
2. **Deploy the API** with provenance integration.
   - Simulation sessions are created with provenance inline.
   - LiveKit sessions leave provenance null (worker claims it).
   - Assessments fail closed if provenance column is missing.
3. **Deploy the LiveKit worker** with provenance support.
   - Worker calls `set_session_provenance()` before any LLM/STT/TTS
     construction.  Aborts on CONFLICT/MISSING/ERROR.
   - Provenance is set via compare-and-update (`null→value only`).
   - Model identifier is read from `ANTHROPIC_MODEL` env var (single source,
     same var used to construct the Anthropic LLM).

## Migration 0006 reserved

Migration 0006 is reserved for the separate lifecycle branch.  Do not use
0005 for anything other than model provenance.

## Development

### Run all typechecks and tests

```bash
cd app/api
npm run typecheck
npm test
```

### Run Python provenance tests

```bash
cd app/voice-livekit
python -m pytest tests/ -v
```

### Run policy tests against local Supabase

```bash
# Adjust host/port for your local Supabase instance
psql -h localhost -U postgres -d postgres \
  -f app/supabase/migrations/0005_model_provenance.sql \
  -f app/supabase/tests/policy_tests.sql
```
