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

### Idempotency — read before changing the path again

The idempotency marker hashes the review path (`p:` in the marker input). That
derivation is **unchanged**, which has two consequences:

1. **Both builders must derive the path identically.** `enqueueScorecardWrite`
   (enqueue time, sets `operation_key = ashby:scorecard:<appId>:<marker>`) and
   `readScorecardSource` (execute time, builds the payload) both call
   `ashbyReviewPath(applicationLinkId)`. If one drifts, the executed payload's
   marker disagrees with the enqueued key. `ashby-scoped-review-path.test.ts`
   pins this agreement.
2. **An application whose scorecard was already written under the old
   `/sessions/<id>` path hashes to a different marker.** A *re-drive* of that
   link would therefore not dedupe against the old operation key. This is the
   pre-existing content-change semantics of this marker — a summary or score
   change behaves the same way — and it is asserted in the same test file so the
   consequence is recorded, not discovered. Steady-state writes are unaffected:
   each link is enqueued once on completion.

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
| `app/api/src/__tests__/ashby-scoped-review-route.test.ts` | ownership denial, indistinguishable 404s, malformed id rejected before any DB read, 401/403 boundary, no write surface |
| `app/api/src/__tests__/ashby-scoped-review-path.test.ts` | path shape, marker determinism, builder agreement, unchanged bound payload |
| `app/api/src/__tests__/contract-openapi.test.ts` | both routes documented **and** mounted; route/spec bijection |
| `app/web/src/pages/AshbyScopedReviewPage.test.tsx` | no nav/backlinks/actions, tab restriction, generic unavailable state |
| `app/web/src/pages/AshbyScopedReviewReturnTo.test.tsx` | logged-out redirect, return-to in state (never a query), hostile-value fallback |
| `app/web/src/lib/return-to.test.ts` | exact allowlist / open-redirect posture |
