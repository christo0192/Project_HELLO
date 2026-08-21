# Runbook — read-only Ashby pipeline card on Candidate Detail

Scope: the Overview status card `AshbyWorkflowCard`
(`app/web/src/components/talent/AshbyWorkflowCard.tsx`), its two read APIs

- `GET /api/candidates/{id}/ashby-workflow`
  (`app/api/src/routes/ashby-candidate-workflow.ts`)
- `GET /api/integrations/ashby/review/{applicationLinkId}/workflow`
  (`app/api/src/routes/ashby-review.ts`)

and the shared projection
(`app/api/src/integrations/ashby/candidate-workflow.ts`).

## What it is

Recruiters looking at an Ashby-sourced candidate could see the candidate but not
where that candidate sat in the Ashby screening pipeline — resume ingestion,
invite delivery, scorecard writeback. That answer only existed in Mission
Control, which is admin-gated.

This adds a **read-only status card** to the ordinary Candidate Detail Overview,
and the same card to the authenticated scoped-review Overview. It reports state.
It does not change any.

A candidate with no Ashby application link renders **nothing** — no card, no
empty state, no error.

## Security model (the important part)

The card grants **no new access**. It re-applies the rules that already govern
candidate reads.

| Property | How it is enforced |
| --- | --- |
| Authentication required | Both routes sit behind the global recruiter-auth middleware (401 contract). Neither is reachable anonymously. |
| Authorization unchanged | `requireRole('viewer')` plus the same interviewer `owner_id` scope used by `GET /api/candidates/:id`. An interviewer who does not own the candidate is refused. |
| No enumeration | Malformed id, unknown candidate and unowned candidate all return the identical `404 {"error":"Candidate not found"}` — the same body `GET /api/candidates/{id}` returns on a miss. (That route answers a *malformed* id with a `400 validation_error` instead; collapsing all four outcomes into one 404 here is deliberate and is the stronger contract.) The link-scoped twin returns the identical `404 {"error":"application_link_not_found"}` its sibling routes already use. |
| Absence is not an error | A candidate with no Ashby link is `200 {"ok":true,"workflow":null}`. This is only reachable **after** the caller has been proven able to read that candidate, so it reveals only Ashby-linkedness of a candidate they already see. |
| Outages are not absence | A failed lookup is a sanitized `500`, never a `404` and never a false `workflow: null`. The 500 body is identical whether or not the candidate exists, so it leaks nothing. |
| Read-only | Only `GET` exists. Nothing mutates, mints a token, moves an Ashby stage, or contacts Ashby. |
| No PII in logs/audit | These handlers log nothing and write no audit row. |

### The response allowlist

The projection is deliberately narrower than Mission Control's, because this
surface is wider (viewer role, every owning interviewer). Only these keys may
ever appear, and a test asserts it by walking the whole response body:

`ok`, `workflow`, `lifecycle`, `terminalState`, `ingestionState`, `operations`,
`sessionStatus`, `updatedAt`, `type`, `state`, `errorCode`.

Never emitted, even when the underlying row carries them:

- external Ashby identifiers (`external_application_id`, `external_candidate_id`,
  `external_job_id`, `external_stage_id`, `external_resume_file_handle`);
- internal row ids of any kind — application link, operation, ingestion, session;
- operation keys, markers, leases, attempt counters;
- invite tokens or digests, presigned URLs, provider payloads, provenance;
- candidate PII;
- free-text error columns (`error_detail`, ingestion `failed_reason`,
  `terminal_reason`) — those are sanitized only by convention.

`errorCode` **is** emitted: migration 0029 constrains it to
`^[a-z0-9_.:-]{1,64}$`, so it is a stable sanitized code by construction. The
web card re-validates it against the same shape before display.

`stage_move` operations are filtered out entirely. This lane reports the invite
and scorecard legs only.

## State vocabulary

Not a second state model — every value is the raw column Mission Control already
reads:

| Field | Source | Values |
| --- | --- | --- |
| `lifecycle` | `ashby_application_links.lifecycle` (0029 + 0032) | `imported`, `processing`, `ready`, `completed`, `writeback_pending`, `cancelled` |
| `terminalState` | `ashby_application_links.terminal_state` | `withdrawn`, `deleted`, `manual_stage_cancel`, or null |
| `ingestionState` | `ashby_resume_ingestions.state` | `queued`, `fetching`, `scanning`, `extracting`, `structuring`, `ready`, `failed_review`, `cancelled` |
| operation `state` | `ashby_operations.state` | `pending`, `running`, `succeeded`, `failed`, `blocked`, `cancelled` |
| `sessionStatus` | `call_sessions.status` | existing session vocabulary |

Which link is reported depends on how the surface is addressed:

- the **candidate**-addressed route reports the candidate's most recently
  updated link — one deterministic "current workflow", not a list the card
  would have to disambiguate with external job ids it may not show;
- the **link**-addressed route reports that link and no other. A candidate may
  hold several Ashby applications; reporting the newest on a link-scoped page
  would silently describe a different application than the page around it, and
  since the card shows no job id the mismatch would be invisible.

`stage_move` rows are excluded by the query itself, not discarded afterwards,
so their error codes never cross the database boundary. Both embeds are
explicitly bounded.

`sessionStatus` is an additive diagnostic read separately: if that read fails it
degrades to `null` rather than failing the card. A failure of the *link* read
does not degrade — it raises, and the route answers 500.

## UI rules

- **No controls.** No retry, cancel, resend, stage move, or delivery action —
  not even a "Try again" on the error path, which would be the only interactive
  element on the card and would read like a workflow action. A test asserts the
  card region contains zero `button`/`a`/`input`/`select`/`textarea`.
- **Never colour alone.** Every state is a text label; the badge tone is
  reinforcement. Unknown future values fall through to their raw text with a
  neutral tone rather than an invented label.
- **Accessible.** The card is a `section` labelled by its heading. One polite
  `role="status"` live region is mounted for every phase and never replaced —
  loading, error and ready swap its *children*, because a region inserted at
  the moment its content arrives is announced inconsistently. The timestamp is
  a real `<time>` element, omitted entirely when there is no usable timestamp
  rather than rendered as `<time datetime="">`. Axe-clean in the card test and
  in both page tests.
- **Silent on denial.** A 404/403 renders nothing, exactly like "no workflow" —
  so the card cannot be used to tell a missing candidate from an unowned one.
  Any other failure shows one detail-free sentence.
- A synchronous throw from the API layer degrades to the card's own error state.
  A status card must never be able to take down the Overview it sits in.

## Mission Control is unchanged

Mission Control keeps every action and its admin gate. Nothing in this change
touches its routes, its projection, or its page.

## Operating notes

- **Nothing to enable.** No feature flag, no migration, no new dependency, no
  provider call. The card appears wherever an Ashby application link already
  exists and is invisible everywhere else.
- **Rate limit.** Both routes sit under existing limiter prefixes
  (`candidates:` and `ashby-review:`, default config). The card adds a *second*
  request per Overview render against the caller's own `candidates:` bucket, so
  effective page-view headroom for a recruiter is halved. Watch for 429s during
  bulk review sessions; the fix is the limiter config, not the card.
- **New to the viewer role.** Sanitized integration error codes (for example
  `provider_5xx`, `invite_deferred`) were previously visible only in
  admin-gated Mission Control and are now visible to any viewer on the
  candidate Overview. This is the one genuinely new category of information on
  a wider surface. The codes are constrained by the 0029 CHECK and carry no
  provider text, so they are safe by construction — but it is a deliberate
  disclosure, not an accident.
- **"The card shows nothing for an Ashby candidate."** Either the candidate has
  no row in `ashby_application_links`, or the caller is an interviewer who does
  not own the candidate (denial is deliberately indistinguishable from absence
  on this surface). Confirm ownership on the candidate record first; the linkage
  itself is visible in Mission Control to an admin.
- **"The card shows the unavailable message."** That is a genuine 5xx from the
  workflow read — a database lookup failed. It is retryable and is *not* an
  authorization outcome. Check API health; the sanitized code never carries the
  underlying error.
- **An unfamiliar state string appears verbatim.** A new lifecycle/ingestion/
  operation value reached the database without a label here. Add the label to
  `AshbyWorkflowCard.tsx` and the enum to the OpenAPI schema; the raw value is
  the deliberate, truthful fallback until then.

## Tests

- `app/api/src/__tests__/ashby-candidate-workflow-route.test.ts` — access
  control, indistinguishable denial, malformed-id rejection before DB work,
  truthful absence vs sanitized failure, the response key allowlist, projection
  semantics, and the link-scoped twin.
- `app/api/src/__tests__/contract-openapi.test.ts` — route↔spec bijection plus
  live-handler shape validation for both routes.
- `app/web/src/components/talent/__tests__/ashby-workflow-card.test.tsx` — card
  states, accessibility, no-controls, sanitized-code suppression, both scopes.
- `app/web/src/pages/CandidateDetailPage.test.tsx` and
  `AshbyScopedReviewPage.test.tsx` — the card in place on both Overviews.
