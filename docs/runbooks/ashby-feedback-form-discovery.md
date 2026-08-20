# Runbook — read-only Ashby feedback-form schema discovery

Scope: `GET /api/integrations/ashby/mission-control/jobs/{externalJobId}/feedback-form`,
the extractor in `app/api/src/integrations/ashby/probe.ts`, and the
`Discover feedback form` control on the Ashby Mission Control page.

## The gap this closes

HR builds a feedback form in the Ashby UI and attaches it to a job's interview
plan. That UI never shows the **internal form, section, and field ids**, and
those ids are exactly what a scorecard binding needs:
`bindFeedbackForm` (`integrations/ashby/scorecard.ts`) returns
`binding_unverified` unless a tenant-verified binding supplies them, and
`docs/runbooks/ashby-runtime-activation.md` §7 makes that one of the four locks
holding write-back closed. Until now the only way to see those ids was direct
provider access.

This is the **discovery half** of that gap and nothing more: an admin reads a
sanitized schema on screen and copies the ids by hand into the approved
configuration process.

## What it is not

* **`applicationFeedback.list` is not used.** It is a real operation in the
  registry (`integrations/ashby/types.ts`) and it is excluded on purpose.
* **No feedback CONTENT is read anywhere.** No submitted answer, score,
  recommendation, comment, or interviewer note. Only form STRUCTURE crosses the
  boundary.
* **Nothing is written, persisted, or bound.** No mapping upsert, no
  `feedback_form_id` write, no `applicationFeedback.submit`, no request
  creation, no stage move, no mapping enable, no runtime activation. Viewing
  this screen leaves write-back exactly as fail-closed as it was before.
* **It is not a verification.** The screen is labelled *unverified* because a
  form that the interview plan merely NAMES may carry fields this read cannot
  see (below).

## How it works

One allowlisted READ — the **same** operation the stage probe already uses:

```
GET /jobs/{externalJobId}/feedback-form   (admin)
  └── probeJobFeedbackForms()
        └── assertReadOnly('jobInterviewPlan.info')   ← fails closed otherwise
        └── reader.jobInterviewPlanInfo(jobId)        ← exactly one call
        └── extractFeedbackForms(results)             ← pure, no I/O
```

`PROBE_READ_OPERATIONS` stays `['jobInterviewPlan.info']`. `assertReadOnly`
rejects every mutating registry entry and every non-allowlisted read, so the
module has no write seam to misuse.

### What the extractor returns

Per discovered form: the opaque `formDefinitionId`, a bounded title, the stage
and interview it hangs off (when the plan says so), and — when the payload
carries it — sections and fields with:

| Field | Source | Notes |
| --- | --- | --- |
| `id` | `field.id` | the opaque id a binding needs |
| `title` | `field.title` | bounded to 120 chars |
| `path` | `field.path` | e.g. `overall_recommendation`, bounded to 160 |
| `type` | `field.type` | e.g. `ValueSelect`, `String`; fails closed to `null` if it is not an identifier |
| `required` | `isRequired` **only** | `null` when the payload did not say — `isNullable` is deliberately NOT inverted into a guess |
| `options` | `selectableValues[].label` / `.value` | the scale, bounded to 40 per field |

### Why it cannot leak

The walk is a **fixed-shape descent through an explicit container-key
allowlist** and it never enumerates a provider object's own keys; each field is
then copied key-by-key from a second allowlist. A sibling the provider adds
later — `candidateEmail`, `answers`, `submittedValue` — is therefore
*unreachable*, not merely filtered. `descriptionHtml` is read by nobody: it is
unbounded tenant HTML, and understanding a scale never needs it.

Bounds: 50 forms, 50 sections/form, 200 fields/form, 40 options/field, 200 items
per list, 120/160/64/120-char strings, control characters stripped, ids must
match `^[A-Za-z0-9_.:-]{1,256}$`, objects visited once (cycle-safe), results
deduped by opaque id in deterministic traversal order. When any bound bites the
response sets `truncated: true` and the UI says the view is partial.

## Reading the result

* **`schemaAvailable: true`** — the plan payload carried the field-level schema
  and the ids on screen are real.
* **`schemaAvailable: false`** — the plan **named** the form (its id is real)
  but carried no fields. Ashby's published `jobInterviewPlan.info` response is
  `results.stages[].activities[].interviews[]` and does **not** include the form
  definition body; reading fields needs `feedbackFormDefinition.info`
  (`hiringProcessMetadataRead`), which is **not** in this integration's
  operation registry. An empty `sections` here means *not readable here*, never
  *this form has no fields*. Treat it as a request for the additional
  read scope, not as a defect.
* **`empty: true`** — the plan names no feedback form at all.

## Responses

| Situation | Status | Body |
| --- | --- | --- |
| Success | 200 | `{ ok, forms, empty, truncated }` |
| Malformed `externalJobId` | 400 | `invalid_external_job_id` — no provider call is made |
| Integration/API-key gate closed | 503 | `integration_disabled` — no client is constructed, no network call |
| Tenant 401/403/404, or an unusable body | 502 | `probe_unavailable` — the provider body is never echoed |
| interviewer / viewer / unauthenticated | 403 | admin-only |

## Audit and logging

The audit row carries **bounded counts only**:
`{ resource: 'ashby_job_feedback_forms', count, field_count, truncated }`.
Form, section, field, stage, and interview ids are tenant configuration and are
**never** written to an audit row, a log line, or analytics — they exist only in
the single authenticated HTTPS response that asked for them, and in React
component state on the admin's screen.

## Operating it

1. Ashby Mission Control → Job mappings → **Discover feedback form** on the row
   for the job.
2. Read the panel. It is labelled *read-only, unverified*.
3. Copy the ids by hand into the approved configuration process. Nothing on this
   screen creates a binding.

If the button returns `integration_disabled`, the read-only integration/API-key gate is closed — that is configuration, not an outage. The full Ashby workflow runtime may remain disabled while this probe is used. If it returns `probe_unavailable`, the tenant read failed (most often a scope the API key lacks); nothing was enabled and nothing changed.

## Tests

* `app/api/src/__tests__/ashby-form-discovery.test.ts` — payload variants,
  hostile payloads (PII-like siblings, submitted answers, comments, unbounded
  strings, control characters, cycles, huge lists), bounds, determinism, dedup,
  and a Proxy reader proving no member beyond `jobInterviewPlanInfo` is touched.
* `app/api/src/__tests__/ashby-probe.test.ts` — the module's export surface and
  the read-only allowlist (unchanged guarantees, widened for the two new
  read-only exports).
* `app/api/src/__tests__/ashby-mission-control-route.test.ts` — RBAC, config
  gate, single read, GET-only mounting, sanitized 400/502/503, and the
  counts-only audit row.
* `app/web/src/pages/AshbyMissionControlPage.test.tsx` — rendering, the
  `schemaAvailable: false` wording, empty/truncated/error states, no PII or URL
  in the rendered surface, and axe.
