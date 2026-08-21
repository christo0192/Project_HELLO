# Runbook — candidate-scoped Ashby review experience

Scope: the web route `/ashby/review/:applicationLinkId`, the read APIs
`GET /api/integrations/ashby/review/{applicationLinkId}[/notes]`
(`app/api/src/routes/ashby-review.ts`), and the scorecard deep link produced by
`ashbyReviewPath()` in `app/api/src/integrations/ashby/scorecard.ts`.

## What it is

An Ashby scorecard's summary carries a deep link back into HELLO. That link used
to point at `/sessions/<sessionId>` — the full, unscoped app. It now points at a
dedicated, candidate-scoped review page addressed **only** by the opaque
application link id.

A reviewer following the link sees exactly one candidate's existing **Overview**
and **Review** content, in a shell with no global navigation.

## Security model (the important part)

The link is **not a capability**. It carries no token and grants nothing.

| Property | How it is enforced |
| --- | --- |
| Authentication required | The route sits behind the normal `ProtectedRoute`; the APIs sit behind the global recruiter-auth middleware (401 contract). |
| Authorization unchanged | `requireRole('viewer')` plus the same interviewer `owner_id` scope used by `GET /api/candidates/:id`. An interviewer who does not own the candidate is refused. |
| No enumeration | Malformed id, unknown link, link with no resolved candidate, and unowned link **all** return the identical `404 {"error":"application_link_not_found"}`. |
| No PII in the URL | The address is the application link UUID only — never a candidate id, email, phone, or session id. |
| No PII in logs/audit | These handlers log nothing and write no audit row. |
| No open redirect | The post-login return-to travels in React Router **state**, never a `?next=` query, and is re-validated on both ends against an exact path allowlist (`app/web/src/lib/return-to.ts`). |
| Read-only | Only two `GET` routes exist under the prefix. Nothing here mutates, mints a token, or contacts Ashby. |

Normal app entry (`/candidates`, `/sessions/:id`, Mission Control) and its RBAC
are unchanged.

## Shell rules

The page renders **outside** `<Layout>`. That is deliberate and asserted by
tests: no sidebar, no global nav, no "back to candidates", no cross-candidate
links, and no actions (no start-a-call, add-a-note, appeal grant, or CSV
export). Those remain on the unchanged full workspace page.

The Overview and Review content is the *same code* as the candidate page —
`CandidateProfileCard`, `SessionsSummary`, `NotesList` (shared in
`components/talent/CandidateOverviewSections.tsx`) and
`TranscriptionSyncWorkspace`. The Review tab still loads transcript/recording
through the existing admin-gated `GET /api/screening/:id`, so a non-admin
reviewer degrades exactly as they do today.

## Scorecard write behaviour

Only the deep link changed. The Ashby feedback **value type**, field set, scale
mapping, provenance and summary bounds are untouched; no field was added; Red
Flags are not written; no email is sent and no stage is moved.

### Idempotency — one scorecard per application link, ever

An Ashby scorecard **cannot be retracted**, so the invariant is hard: at most
one `scorecard_write` operation per `application_link_id`, across every
historical marker version. Two guards enforce it, and neither depends on how the
deep link is rendered:

1. **Link-scoped admission.** `enqueueScorecardWrite` first looks for ANY
   existing `scorecard_write` row on the link (any state, any marker — including
   rows written when the marker still hashed `/sessions/<id>`) and returns
   `duplicate` without touching the mapping, the assessment or the RPC. A lookup
   error throws rather than falling through, so a database blip can never be
   read as "no scorecard yet".
2. **A link-derived `operation_key`.** The enqueued key is
   `ashby:scorecard:link:<applicationLinkId>` — marker-independent — so the
   pre-existing `uq_ashby_operations_key` unique constraint is itself the
   durable, concurrency-safe guard: two racing enqueues collapse to `duplicate`
   in Postgres even if their content markers differ.

The marker now hashes the **assessment content only** (score, recommendation,
dimensions, summary, model) and NOT the review path: presentation changes must
never look like new content. Changing the path shape again is therefore safe by
construction — but both builders must still derive it identically
(`enqueueScorecardWrite` at enqueue time, `readScorecardSource` at execute time,
both via `ashbyReviewPath(applicationLinkId)`), and
`ashby-scoped-review-path.test.ts` pins that agreement.

Consequence to know: a link whose scorecard genuinely needs re-writing (e.g. a
re-score after a corrected assessment) is **not** re-enqueued automatically.
That is deliberate — the second write would be unretractable. Recovery is a
deliberate operator action against the existing operation row, not a re-drive.

### The deep link in the summary

The summary field reserves the full `\n\nDetailed Project_HELLO scorecard: <url>`
suffix before truncating to the 2000-character cap, so a maximum-length summary
loses its own tail rather than a character of the URL.

### Signing in through SSO

The Google Workspace path is a full-page redirect to the identity provider, so
React Router state does not survive it. The validated destination therefore
travels two ways: as the provider `redirectTo` (`origin + <allowlisted path>`,
which must be registered in Supabase's allowed redirect URLs for the direct
landing to work) and parked in `sessionStorage` under `ashby.returnTo`, consumed
once by the `/` landing route when Supabase falls back to the site URL.
`sanitizeReturnTo` runs on the write and on the read, so storage is not a trust
boundary and no open redirect is possible; the entry is single-use and expires
after 10 minutes.

### Outage vs denial

A failed database lookup on the review routes returns the sanitized
`500 {"error":{"type":"internal_error",…}}` — never the 404 — so an outage does
not present to every recruiter as "this link was removed or you don't have
access", and the page keeps its retry affordance. The 500 is returned
identically for links that exist, do not exist, and are owned by someone else,
so it leaks nothing.

## Verifying in an incident

```bash
# 404 for a stranger / unknown link (no body difference to compare)
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $JWT" \
  "$API/api/integrations/ashby/review/00000000-0000-4000-8000-000000000000"

# 200 for an owner; sanity-check the envelope shape only
curl -s -H "Authorization: Bearer $JWT" \
  "$API/api/integrations/ashby/review/$LINK_ID" | head -c 200
```

If a reviewer reports "link not available": confirm (a) they are signed in with
an allowlisted account, (b) for an interviewer, that they own the candidate, and
(c) that `ashby_application_links.candidate_id` is populated for that link — a
workflow that has not materialized a candidate yet legitimately 404s.

## Tests

| File | Covers |
| --- | --- |
| `app/api/src/__tests__/ashby-scoped-review-route.test.ts` | ownership denial, indistinguishable 404s, malformed id rejected before any DB read, 401/403 boundary, no write surface, sanitized 500 on DB failure |
| `app/api/src/__tests__/ashby-scoped-review-path.test.ts` | path shape, marker is content-only, builder agreement, unchanged bound payload, link never truncated out of a max-length summary |
| `app/api/src/__tests__/ashby-scorecard-link-idempotency.test.ts` | one scorecard per link across legacy markers, fail-closed lookup, link-derived `operation_key` |
| `app/api/src/__tests__/contract-openapi.test.ts` | both routes documented **and** mounted; route/spec bijection |
| `app/web/src/pages/AshbyScopedReviewPage.test.tsx` | no nav/backlinks/actions, tab restriction, generic unavailable state |
| `app/web/src/pages/AshbyScopedReviewReturnTo.test.tsx` | logged-out redirect, return-to in state (never a query), hostile-value fallback, SSO redirect round trip + post-SSO landing |
| `app/web/src/lib/return-to.test.ts` | exact allowlist / open-redirect posture, single-use expiring SSO parking, re-validation on read |
