# Runbook — Ashby scorecard `Detailed report` + `Red flags` fields

Scope: `app/api/src/integrations/ashby/scorecard.ts` (binding + normalization),
`app/api/src/integrations/ashby/workflow-stores.ts` (the two `ScorecardSource`
build sites), and the scorecard branch of
`app/api/src/integrations/ashby/operation-worker.ts`.

## What changed

The approved Hello Christy feedback form binding now populates two further
fields that already existed on the tenant's form and were previously left empty:

| Ashby field | Type | Verified submission path | Value we submit |
| --- | --- | --- | --- |
| `Detailed report` | `Url` | `81b04084-d7a0-40f1-9d30-7eccaa62798d` | a bare absolute HTTPS URL to `/ashby/review/<applicationLinkId>` |
| `Red flags` | `String` | `a9127af9-fc4d-474d-b3ce-95c57052e840` | normalized `role_fit.red_flags`, or exactly `None identified` |

Both paths and both types were read on 2026-08-21 from the tenant's official
`feedbackFormDefinition.info` for form `1c9a92c0-c18f-4bf1-898f-c29e71d7d303`.
No submitted values were read or retained. Both fields are optional on the form.

Two consequences for the existing payload:

- **The Summary no longer carries the dashboard URL.** It is now the approved
  PlainText summary and nothing else; the clickable destination lives only in
  `Detailed report`. That also means a maximum-length summary can no longer
  crowd out the link — they are separate fields with separate budgets.
- **The submission is exactly nine `fieldSubmissions`**, in a fixed order:
  overall recommendation, Summary, Red flags, Detailed report, then the five
  dimensions. `ashby-scorecard-fields.test.ts` pins that list.

Nothing else moved: the verified form id, the overall/dimension paths, the 1–4
scales, the `{ fieldSubmissions: [...] }` request shape, and the informational
(never auto-acting) recommendation are unchanged.

## Value shapes — the part that is easy to get wrong

The Ashby `applicationFeedback.submit` contract is type-specific:

- a `RichText` field takes `{ "type": "PlainText", "value": "..." }`;
- a `String` field takes a **bare string**;
- a `Url` field takes a **bare, valid absolute URL string**.

`Red flags` and `Detailed report` therefore carry bare strings. Wrapping either
in a PlainText envelope is a submission error, not a stylistic choice.
`bindFeedbackForm` also refuses to bind at all if the binding's declared
`fieldTypes` stop matching (`binding_field_type_mismatch`), so a form edit that
retypes a field breaks loudly rather than shipping a wrong shape.

## Security model

| Property | How it is enforced |
| --- | --- |
| No PII in the deep link | The URL is `<validated origin>/ashby/review/<application-link UUID>`. `isScopedReviewPath()` accepts *only* that exact shape — not a legacy `/sessions/<id>` path, not a non-UUID id, not an external Ashby id. |
| No token / query / fragment / userinfo | `dashboardOriginOf()` rejects anything that is not a bare `https://host[:port]` origin, and `detailedReportUrl()` re-parses the composed URL and requires a byte-identical round trip. |
| No open redirect input | The origin comes only from the server's validated `WEB_ORIGIN`; nothing candidate- or provider-supplied reaches URL composition. |
| No HTTP downgrade | `http:` origins — including `http://localhost:5173` — are refused. |
| Fail closed, never degrade | If a trustworthy HTTPS origin or a canonical review path is unavailable, `bindFeedbackForm` returns `{ ok: false }` and the worker submits **no Ashby feedback at all**. A relative path is never placed in a `Url` field. |
| Bounded red flags | Read only from the persisted `role_fit.red_flags` array — never an arbitrary provider or user payload key. Control characters are stripped, order preserved, and item length / item count / rendered total are bounded (see the `MAX_RED_FLAG_*` constants). Truncation drops whole items. |
| Unambiguous empty state | An empty or unusable list submits exactly `None identified`, so "screened, nothing found" is distinguishable from "never screened". |
| Sanitized failures | A thrown provider error is still recorded as `operation_error` and stays bounded by `max_attempts`. No raw provider response is persisted. |

## Idempotency — read this before changing red flags

At most **one** `scorecard_write` operation may ever exist per application link:
an Ashby scorecard cannot be retracted. That guarantee is unchanged and does not
depend on the content marker. It rests on two marker-independent locks:

1. a link-scoped admission read (`findScorecardWriteOperation`) that runs first
   and fails closed if it cannot complete; and
2. the link-derived `operation_key` `ashby:scorecard:link:<applicationLinkId>`
   plus the `uq_ashby_operations_key` constraint.

Normalized red flags **are** hashed into the content marker (key `f`), because
they are assessment content and the marker is meant to describe what was scored.
That is safe precisely because the marker gates nothing: a link that already has
a scorecard operation returns `duplicate` no matter how the marker moved.

Both `ScorecardSource` build sites — `readScorecardSource` (execute time) and
`enqueueScorecardWrite` (enqueue time) — read `role_fit.red_flags` identically
and normalize through the same helper, so the two markers agree.

## Operating notes

- Setting `WEB_ORIGIN` to a non-HTTPS value silently stops scorecard writes (by
  design). The symptom is `dashboard_origin_invalid` on the operation row; the
  fix is the environment, not the code.
- Adding or editing an assessment's red flags after a scorecard has been written
  changes nothing in Ashby. There is no re-write path and there must not be one.
- Verification: `cd app/api && npm run typecheck && npm test`. The pinned
  contracts live in `src/__tests__/ashby-scorecard-fields.test.ts`,
  `ashby-scorecard.test.ts`, `ashby-scoped-review-path.test.ts`,
  `ashby-scorecard-link-idempotency.test.ts`, and
  `ashby-writeback-fail-closed.test.ts`.

## Out of scope (unchanged, and deliberately so)

No `application.changeStage`, no stage-move enqueue or execution, no auto
reject, no email automation, no change to how red flags are generated, no role
filters, no form mutation, and no migration.
