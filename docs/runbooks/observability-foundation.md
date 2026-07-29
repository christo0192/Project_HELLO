# Observability Foundation Runbook (OBS-01 / OBS-02)

## Scope

This runbook covers the structured logging schema, stable event catalogue, correlation
ID format, and query examples for the HR Screening Bot API (Node.js/Express) and
the LiveKit voice worker (Python).

**Status:** Foundation only.  Managed log export, complete queue tracing, and
dashboards are **pending** (see Pending Boundaries below).  All items below
reflect unit-test-proven behaviour only — no production deployment verification
has been performed.

---

## Log Schema

Every log line is a single JSON object (no multi-line events).  All timestamps are
UTC ISO-8601 with the **Z suffix** (not `+00:00`) and are calendar-validated
(impossible month/day/hour/minute/second combinations are rejected and replaced
with the deterministic fallback `1970-01-01T00:00:00.000Z`).

### Required fields (every line)

| Field           | Type            | Notes                                       |
|-----------------|-----------------|---------------------------------------------|
| `timestamp`     | `string`        | UTC ISO-8601 with Z suffix, e.g. `2026-01-15T10:30:00.000Z`  |
| `level`         | `string`        | `debug` / `info` / `warn` / `error`         |
| `component`     | `string`        | Allowlisted identifier (see below)          |
| `event`         | `string`        | Stable event name (see catalogue below)     |
| `correlationId` | `string\|null`  | UUID v4 or `null` outside request context   |

### Optional allowlisted metadata fields

Non-allowlisted keys are silently dropped at emission time.
Non-scalar values (objects, arrays) are silently dropped.

**String values containing control characters (≤ U+001F or U+007F) cause the
entire field to be dropped** — not a truncated fragment.  A control character
anywhere in the value means the field is omitted to avoid leaking payload
appended after the control char.  Valid strings are then capped at 512
characters.

| Field                 | Type      | Used by          | Notes                              |
|-----------------------|-----------|------------------|------------------------------------|
| `shape`               | `string`  | csp              | `"legacy"` or `"reporting-api"`    |
| `document_origin`     | `string`  | csp              | URL origin only, no path/query     |
| `violated_directive`  | `string`  | csp              | Sanitised, max 512 chars           |
| `effective_directive` | `string`  | csp              | Sanitised, max 512 chars           |
| `blocked_origin`      | `string`  | csp              | URL origin only                    |
| `error_category`      | `string`  | validation       | Error class name, never message    |
| `error_type`          | `string`  | validation       | Reserved                           |
| `method`              | `string`  | api              | HTTP method identifier             |
| `status`              | `number`  | api              | HTTP status code                   |
| `http_status`         | `number`  | persistence      | Outbound HTTP status code          |
| `port`                | `number`  | startup          | Listen port                        |
| `model`               | `string`  | startup          | Model identifier                   |
| `schema`              | `string`  | startup          | DB schema identifier               |
| `turn_index`          | `number`  | persistence      | Transcript turn ordinal            |
| `speaker`             | `string`  | persistence      | `"bot"` or `"candidate"`           |
| `duration_sec`        | `number`  | persistence      | Session duration in seconds        |

### Allowlisted components

`api`, `csp`, `correlation`, `validation`, `startup`, `persistence`

---

## Stable Event Catalogue

| Event name         | Component(s)       | Level  | Description                              |
|--------------------|--------------------|--------|------------------------------------------|
| `startup_listen`   | `startup`          | `info` | API server started; logs port/model/schema |
| `csp_violation`    | `csp`              | `warn` | CSP report received; origin-only fields  |
| `error_unhandled`  | `validation`       | `error`| Unhandled Express error; category only   |
| `scoring_trigger`  | `persistence`      | `info` | Scoring API call succeeded               |
| `scoring_failed`   | `persistence`      | `warn` | Scoring API call failed; category only   |
| `session_complete` | `persistence`      | `info` | Session marked completed                 |
| `session_fail`     | `persistence`      | `info` | Session marked failed                    |
| `db_turn_saved`    | `persistence`      | `info` | Transcript turn saved to DB              |
| `db_error`         | `persistence`      | `warn` | DB or dependency error; category only    |
| `unknown_event`    | *any*              | *any* | Catch-all for unregistered event names   |

> **Extending the catalogue:** add a row here and add the event name to `EventName`
> in `app/api/src/lib/logger.ts` (TypeScript) and `_ALLOWED_EVENTS` in
> `app/voice-livekit/observability.py` before use.

---

## Correlation ID Format and Rules

- **Format:** UUID v4 canonical lowercase, e.g. `550e8400-e29b-41d4-a716-446655440000`
- **Header name:** `X-Correlation-ID` (request and response)
- **Acceptance criteria:**
  - Must match `/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i`
  - Must not exceed 128 characters
  - Must not contain control characters (U+0000–U+001F, U+007F)
  - Must not contain commas (comma signals Node.js-joined duplicate headers)
- **Generation:** `node:crypto.randomUUID()` (TypeScript) / `uuid.uuid4()` (Python)
- **Propagation:** LiveKit worker → API scoring trigger via `X-Correlation-ID` header
- **Response coverage:** header returned on every response including 400, 413, 500,
  CORS-blocked, and OPTIONS preflight paths
- **Browser exposure:** Not exposed via `Access-Control-Expose-Headers`.  The
  `X-Correlation-ID` response header is intended for server-side log correlation
  and debugging, not for browser-JavaScript consumption.  If browser clients
  require read access, add `Access-Control-Expose-Headers: X-Correlation-ID` to
  the CORS configuration and test both allowed-origin response and preflight
  exposure.

---

## Query Examples

All examples use synthetic IDs only.  Replace `SYNTHETIC-ID` with a real
correlation ID from a log line.

## API Request vs. Worker Session Correlation

The system intentionally inherits the API request's correlation ID into the
LiveKit room via room metadata (`correlation_id` in `meta`), set by the API
at `/api/livekit/start`.  This means:

1. **API Request correlation:** assigned by the API middleware for every
   inbound HTTP request.  Generated via `crypto.randomUUID()` when absent;
   validated against UUID v4 rules when supplied by the caller.  Returned in
   `X-Correlation-ID` on every response.

2. **Worker session correlation:** the LiveKit worker entrypoint reads the
   room creator's correlation ID from `meta.correlation_id` and **validates**
   it.  If absent, invalid, or malformed, a fresh UUID v4 is generated.
   The worker propagates this correlation ID to the API when triggering the
   scoring endpoint.

**Linkage:** The API request that creates a LiveKit room writes its own
correlation ID into the room metadata.  The worker then inherits that ID
(validated), creating a traceable chain from the API request through the
voice session to the scoring POST.  However, the ID in room metadata is
visible to LiveKit room participants and cannot be considered
server-authoritative.

**Trust model:** Room metadata is set by the API server but is visible to
all room participants.  A malicious participant could read or overwrite the
metadata, so the server independently validates the value and generates a
new UUID v4 when it fails format checks.  This provides authenticity of the
correlation format but not proof of origin — a participant who knows the
expected format can supply any valid UUID v4.  The API request correlation
and worker session correlation are **not interchangeable** as authoritative
request identifiers; they form a related but independently-validated chain.

**SDK callback propagation:** This implementation proves deterministic
correlation ID propagation only within the unit-test scope (direct
`get_correlation_id()` in the same asyncio task).  Actual end-to-end
propagation through LiveKit Agent session callbacks has **not** been
verified in deployment — those callbacks run in LiveKit SDK-internal
contexts that may not inherit the Python ContextVar chain.

### Grep — find all lines for one request

```sh
# Filter by correlationId (replace with actual ID from a real log line)
grep '"correlationId":"550e8400-e29b-41d4-a716-446655440000"' /var/log/app/api.log
```

### jq — extract timing for a request

```sh
cat /var/log/app/api.log \
  | jq 'select(.correlationId == "550e8400-e29b-41d4-a716-446655440000") | {timestamp, event, level}'
```

### jq — find all CSP violations in the last hour

```sh
cat /var/log/app/api.log \
  | jq 'select(.event == "csp_violation") | {timestamp, document_origin, violated_directive}'
```

### jq — find scoring trigger failures

```sh
cat /var/log/app/api.log \
  | jq 'select(.event == "scoring_failed") | {timestamp, correlationId, error_category}'
```

### jq — count unhandled errors by category

```sh
cat /var/log/app/api.log \
  | jq 'select(.event == "error_unhandled") | .error_category' \
  | sort | uniq -c | sort -rn
```

> **Note:** Managed log export (e.g. Cloud Logging, Loki, Datadog) is pending.
> The above examples assume local files.  Adapt filter syntax per the chosen platform.

---

## Pending Boundaries

The following boundaries exist in the system but **do not yet carry structured
log correlation**.  They are documented here to prevent fabricated propagation
claims.

| Boundary                      | Status   | Notes                                                      |
|-------------------------------|----------|------------------------------------------------------------|
| Supabase SDK calls            | Pending  | SDK emits its own logs; no structured passthrough          |
| LiveKit internals             | Pending  | LiveKit SDK does not accept a correlation header           |
| Post-session scoring queue    | Pending  | ADR-0004 queue not yet implemented                         |
| Managed log export            | Pending  | Platform not chosen; no dashboard or alert rules           |
| Sarvam STT/TTS provider       | Pending  | External provider; correlation not propagated              |
| Anthropic LLM via LiveKit     | Pending  | External provider; correlation not propagated              |

---

## Redaction Model

The following data categories are **never written to logs** by this implementation:

- Bearer tokens, API keys, credentials, private keys
- Email addresses, phone numbers, names
- Transcript text or conversation content
- Session IDs (raw UUIDs identifying individual sessions)
- File system paths
- Full URLs (only origins — `scheme://host:port` — are permitted)
- URL query strings or fragments
- HTTP request or response bodies
- Raw exception messages or stack traces
- Any data seeded through non-allowlisted metadata keys
- Component values containing high-entropy secrets or sensitive patterns

Enforcement is at emission time in `createLogger()` (TypeScript) and
`StructuredLogger._emit()` (Python): keys not in the allowlist are dropped
before `JSON.stringify` / `json.dumps` is called.  The `component` field is
also defense-scanned: if it matches any sensitive pattern, it is replaced
with `"unknown"`.

## Scoring Outcome Taxonomy

The `scoring_failed` event uses a deterministic error_category based on the
HTTP status code received from the scoring endpoint:

| HTTP Status Range   | `error_category`       |
|---------------------|------------------------|
| 1xx                 | `http_informational`   |
| 2xx                 | *(not an error)*       |
| 3xx                 | `http_redirect`        |
| 4xx                 | `http_client_error`    |
| 5xx                 | `http_server_error`    |
| non-integer / <100 / >599 | `invalid_status` |
| network/connection error   | `http_error`      |

## Level Handling Parity

Both JS and Python rewrite invalid levels to `info` (matched behavior).
JS previously silently dropped invalid levels; this was changed for parity.
