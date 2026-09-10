# Runbook — Ashby scorecard fields (v2 metrics by name; `Detailed report` + `Red flags`)

Scope: `app/api/src/integrations/ashby/scorecard.ts` (binding + normalization),
`scorecard-autobind.ts` (metric → Score field matching, #275),
`scorecard-v2-adapter.ts` (v2 assessment → `ScorecardSource`),
`workflow-stores.ts` (the `ScorecardSource` build site), the scorecard branch
of `operation-worker.ts`, and the Mission Control preview route
`GET /mappings/:id/scorecard-binding`.

## v2 metrics bind to the form BY NAME (issue #275)

**The rule for the Ashby form is one sentence:** for every metric a role's
active scorecard can score, the form carries an **optional `Score` field whose
title equals the metric's name** (`Profile relevance`, `Communication`,
`Night-shift fit`, `Compensation fit`, `Stability`, …). Adding a metric in the
dashboard then needs a form field and **no code change**.

How a v2 `scorecard_write` runs (`operation-worker.ts`):

1. `readScorecardSource` maps the v2 assessment row (`schema_version = 2`,
   `metric_results`, `weighted_score_5`) through `scorecard-v2-adapter.ts`:
   one dimension per metric, keyed by `metric.key`, carrying the metric `name`
   and its 1–5 `metricScore`; the Summary becomes a per-metric report
   (`"<Name> — <score>/5: <rationale>"`, unscored metrics say so); red flags
   come from `role_fit.red_flags` as before. Evidence refs never leave the DB.
   **Role fit rides along** (owner request): the v2 integrity pass (#282)
   writes a v1-shaped `role_fit.score` (0–10); the adapter appends one extra
   dimension named `Role fit` so the kept v1 `Role fit` Score field on the form
   is filled by title, bucketed onto that field's scale exactly as v1 did.
   Absent/non-numeric → omitted; a dashboard metric keyed `role_fit` wins.
2. The worker reads the verified form's definition
   (`feedbackFormDefinition.info`, cached 5 min in `runtime-workers.ts`,
   misses never cached). Unreadable → `form_schema_unavailable`, **retryable**,
   nothing submitted. A card with metrics silently dropped is never sent.
3. `autobindScorecardDimensions` matches each metric name to exactly one
   `Score` field by normalised title (NFKC, case-insensitive, punctuation and
   separators collapsed — `Night-shift fit` = `night shift fit`). No field,
   two fields with the title, a non-Score field, or a field without a path →
   the metric is **unmatched and omitted**; the reason is emitted as a count
   (`scorecard_autobind: matched_N_unmatched_M`), never as a name.
4. `composeAutoboundBinding` keeps the four FIXED fields from the verified
   static binding (they are never auto-bound) and replaces the dimension table
   with the matched paths + each field's own scale. A definition for another
   form id, or an archived form → `form_definition_mismatch`, **not**
   retryable, nothing submitted.
5. `bindFeedbackForm` writes each dimension on ITS field's scale
   (`dimensionValueOnScale`): 1:1 when the field is five-point and a
   `metricScore` exists, otherwise the pre-existing bucketing (on a four-point
   field 5 → 4).

v1 rows (`schema_version = 1`) are untouched: static binding, five fixed
dimensions, no form read.

**Before a candidate is scored**, an admin clicks `Preview scorecard binding`
on the mapping in Ashby Mission Control. It performs the same read and shows,
per metric, `bound → [path] · scale` or the exact fix (`add an optional Score
field titled exactly like the metric`, `more than one field carries this
title`, `not a Score field`), plus whether the four fixed fields are still
present with their verified types. It writes and binds nothing; the audit row
carries counts only. `scoringPath` is `v2_autobind`, `v1_legacy` (role has no
active scorecard), or `no_role`.

Unused v1 Score fields (`English`, `Tone`, `Motivation`, `Role fit`) may stay
on the form; they are simply left empty on v2 cards.

## What changed (Detailed report + Red flags)

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
