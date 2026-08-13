# Runbook — Typed Ashby client foundation

Scope: the injectable Ashby API client under `app/api/src/integrations/ashby/`.
This is **foundation only** (Ashby Phase 1). It is **not** wired to any route,
queue, worker, webhook, or Mission Control, configures **no** credentials, and
makes **no** claim of tenant validation or live Ashby connectivity.

## What it provides

- **Fixed, allowlisted origin.** Production requests always go to
  `https://api.ashbyhq.com`; request paths come from a fixed operation registry
  (`ASHBY_OPERATIONS`). There is no caller-controlled arbitrary URL. A
  non-allowlisted `baseUrl` is rejected at construction unless a test
  `transport` is injected (the injected transport replaces the network entirely
  and is non-production by design).
- **HTTP Basic auth**: the API key is the username with an empty password. The
  key is encoded once into an `Authorization` header and is never stored as a
  field, logged, returned in errors, serialized, or placed in the URL/query.
- **Envelope parsing**: every response is parsed. `HTTP 200 + success:false` is
  a typed `logical_failure`, never treated as success. HTTP errors, malformed
  JSON/envelopes, timeouts, network errors, throttling, and retry exhaustion map
  to stable sanitized categories (`AshbyErrorCategory`).
- **Bounded retry**: bounded timeout, bounded attempts, exponential backoff with
  full jitter, and a bounded `Retry-After` (delta-seconds only; HTTP-dates are
  ignored and fall back to backoff). Only safe/transient classes retry (429,
  5xx, network, timeout). **Mutations fail closed** under ambiguous failures
  (timeout/network after send) unless the caller passes `{ idempotent: true }`,
  which asserts a read-before-write/idempotency strategy supplied by later code.
- **Pagination**: `listAllApplications` iterates cursors with page and item caps
  and repeated-cursor loop detection, all failing closed. The opaque sync token
  from the final page is surfaced to the caller and never logged.
- **Metadata-only logging**: `AshbyLogRecord` carries only operation name,
  attempt, outcome, sanitized category, HTTP status, and a duration. The default
  logger is a silent no-op; `createMetadataLogger()` bridges onto the repo's
  allowlist logger. No bodies, ids, tokens, file URLs, feedback content, or
  credentials can reach a log line.

## Endpoints (for tenant probing only)

`application.info`, `application.list`, `candidate.info`, `file.info`,
`jobInterviewPlan.info`, `applicationFeedback.list`,
`applicationFeedbackRequest.create`, `applicationFeedback.submit`, and
`application.changeStage`.

Only officially verified generic envelope/pagination primitives are locked.
Tenant-uncertain payload details (feedback form field paths, score scales, exact
per-endpoint request field names, `file.info` URL host/TTL) are **not** locked:
they ride in typed `extra` / `OpaqueRecord` extension points and must be pinned
from a tenant probe before any saga is coded around them. `file.info` returns
metadata/URL only — this client never fetches the presigned URL, so SSRF
boundaries are untouched here.

## Usage sketch (not yet wired)

```ts
import { createAshbyClient, createMetadataLogger } from '../integrations/ashby/index.js';

// apiKey is supplied by a later secret-loading step — NOT read from env here.
const client = createAshbyClient({ apiKey, logger: createMetadataLogger() });
const app = await client.applicationInfo(applicationId); // throws AshbyError on failure
```

## Error categories

`invalid_request`, `logical_failure`, `http_client_error`, `rate_limited`,
`http_server_error`, `malformed_response`, `timeout`, `network`, `output_limit`,
`retry_exhausted`. Errors expose only `category`, `code`, `httpStatus`,
`operation`, `attempt`, `retriable`, and bounded sanitized `endpointCodes`.

## Verification

- Unit + negative controls: `app/api/src/__tests__/ashby-client.test.ts`
  (200 success:false not success; malformed JSON/envelope fail closed; 4xx no
  retry; 429/5xx retry within caps honoring bounded Retry-After; mutation not
  silently retried; timeout/network sanitized; pagination loop/cap failures;
  base-URL allowlist; and a secret/contact/resume-URL/sync-token canary control).

## Non-goals / residual gates

No webhook route/signature endpoint, tenant-probe execution, real key, queue
wiring, DB schema, resume download, invitation/email, scorecard publication, or
stage-movement saga. Production readiness, configured credentials, and live
connectivity remain later, separately gated steps.
