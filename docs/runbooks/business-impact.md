# Business impact read model (M031 S5)

What happens in Ashby to the applications Christy screened: the read model behind the
`/impact` page. Migration `0140_ashby_business_impact.sql`; API `app/api/src/routes/impact.ts`
and `app/api/src/lib/impact.ts`. The wire shapes are fixed by
`.gsd/milestones/M031/API-CONTRACT.md`.

## Routes

| Route | Who | What |
|---|---|---|
| `GET /api/impact/summary?from&to&job` | interviewer and up | The page's aggregates: nested pipeline, verdict against outcome, where candidates leave, timings, IST weekly cohorts, by job, and `meta` (progress flag, last pass, coverage, stale rows, labels). Counts only. |
| `GET /api/impact/candidates?step \| verdict+outcome \| leaveStageId&from&to&job&page&pageSize` | interviewer and up | The applications behind one figure, scoped exactly like the candidate page (an interviewer is listed only the candidates they own; an admin all). `hidden` counts the rest, so `total + hidden` is the figure. Name and role only; no email, phone or Ashby id. |
| `GET /api/impact/exclusions` | admin | Every Ashby mapping and whether the page counts it. |
| `PUT /api/impact/exclusions/:mappingId` `{ "excluded": true \| false \| null }` | admin | Leave a mapping out (staff or test applications), keep an archived one in, or go back to the default (archived = left out). |

Errors are `{ "ok": false, "error": "<code>" }`: 400 `invalid_filter`, 403 `forbidden`,
404 `not_found` (the switch only), 503 `impact_unavailable`. Every call writes one audit row
with the filter and counts (`resource_read` / `resource_list`, resource `impact_summary`,
`impact_candidates` or `ashby_impact_exclusions`); the list's row is fail-closed, so if it
cannot be written no name is sent. A switch writes its own `config_changed` row (target
`ashby_impact_exclusion`) in the same transaction as the change.

## How the numbers are counted

- One row per Ashby application HELLO imported (`ashby_application_links`) on a mapping that
  counts. Erased subjects and candidates with a pending, in-progress or fulfilled restriction
  or erasure request are never counted or listed (see "Erased subjects" below).
- **Came in**: the first entry into the Christy stage in Ashby's history, else the import
  time. The cohort is that IST day; weeks start on Monday.
- **Called / answered / connected**: per application through `phone_engagements.application_link_id`.
  Connected is consent given (a session plan). A `browser_primary` mapping uses its browser
  session starting and the consent bound to that session.
- **Verdict**: the newest non-R1 assessment on that application's own sessions (never the same
  person's other applications). Held = evidence graded insufficient. Scored = Select,
  Borderline or Reject, provisional included. While an appeal blocks decision use the verdict is
  suppressed everywhere: the application is left out of the verdict table and its lists, and a
  list row shows no verdict or score, but it still counts in the pipeline.
- **Decided** = left the Christy stage. **Moved forward** = reached a later stage of the plan.
  **R1 / R2 / Offer or later** = reached a stage labelled that milestone or a later labelled
  one (labels: Mission Control, Stages). Archived-type and Lead-type stages never count.
- Steps nest: each counts only applications that reached the step before. A share over 100%
  is refused by the API (503) rather than drawn.
- While `ASHBY_PROGRESS_ENABLED` is not `true`, or none of the window's applications has been
  read from Ashby yet (`meta.coverage.checked` 0), every Ashby-side figure is `null` (the page
  shows a dash). The same rule holds for each weekly cohort, job row and verdict row on its
  own. If a group has applications and none of them has been read, its Ashby-side shares or
  cells are `null`, not 0, so a week or job reads the same chosen alone as in the full view.
  An empty verdict row has nothing unread and follows the window. A group that is partly
  read counts the applications that have been read; `meta.coverage` says how much of the
  window that is. Timings show a median and p90 only from n 5.

## Erased subjects

A DSAR delete (`lib/dsar.ts`) terminates the person's live Ashby links. It then calls
`screening_v2.mark_ashby_application_links_erased(candidate_id)`, which lists every link of
the person, live or already terminal, in `ashby_erased_application_links`. Only then is the
candidate deleted. The list is needed because a link that was already terminal (withdrawn,
cancelled) keeps its own `terminal_reason`, and the request row is deleted with the
candidate. Without the list, nothing would mark that application as an erased person's. The
function lists only while the person has a deletion request. If it fails or refuses, the
erasure stops before the candidate delete: the request stays `in_progress` with a failure
audit (`stage: ashby_erasure_list`), and a retry completes it.

The read model leaves out a listed link, a link the erasure terminated
(`terminal_reason = 'subject_erasure'`), and a link whose candidate has a pending,
in-progress or fulfilled restriction or erasure request. An erasure fulfilled before 0140,
of a link that was already terminal, left no mark and cannot be recognised. The 0139
progress worker does not read the list, but it never reads such an application from Ashby
again: besides the last two kinds it skips every link already ended with no candidate left,
which is what an erasure leaves on a link that was already terminal, before 0140 too
(`docs/runbooks/ashby-progress-worker.md`).

## Read the numbers yourself (Supabase SQL, aggregates only)

```sql
-- The page's summary for the last 12 IST weeks, as the API would read it with the flag on.
select screening_v2.impact_summary(null, null, null, true) -> 'summary' -> 'pipeline';

-- How much of Ashby has been read, per mapping (counts only).
select job_mapping_id, count(*) as applications, count(*) filter (where ashby_known) as read
  from screening_v2.v_ashby_application_impact
 where in_impact
 group by 1;
```

Never select candidate ids or names into a report; the view has candidate ids, so keep to
aggregates.

## Troubleshooting

| Symptom | Likely cause | What to do |
|---|---|---|
| 503 `impact_unavailable` on every call | 0140 not applied (no `impact_summary` function) | `select to_regprocedure('screening_v2.impact_summary(date,date,uuid,boolean,timestamptz)');` returns null: apply the migration. |
| Every step from "A person decided in Ashby" on is a dash | Flag off, or nothing in the window read yet | Check `meta.progressEnabled` and `meta.coverage`. Turn the worker on (S3) and run the backfill. |
| `meta.unlabelledStages` above 0 | Stages after the Christy stage have no milestone label | Label them in Mission Control, Stages (`other` if they are not a milestone). Counts do not change; R1+ only counts labelled stages. |
| `meta.staleRows` above 0 | Applications due a fresh Ashby read for more than a day | See the progress worker's status in Mission Control (S3). |
| A test or staff job inflates the figures | Its mapping is counted | `PUT /api/impact/exclusions/<mapping id>` with `{ "excluded": true }` (admin). |
| An interviewer sees "N more belong to other recruiters" | By design (D-M031-5) | The list follows the candidate page's owner rule; aggregates stay visible to all staff. |
| The verdict table adds up to fewer than Christy connected | An appeal blocks decision use for some candidates | Their verdict is suppressed everywhere (as on the candidate list): left out of the verdict table and its lists, still counted in the pipeline. |
| One job, week or verdict row shows dashes from "Moved forward" on while others have numbers | Ashby has not been read yet for any of that group's applications (a new mapping, the backfill still running, or reads failing for that job) | Check the progress worker's status in Mission Control. The figures appear once one of the group's applications has been read. |
| A DSAR delete stays `in_progress` with notes "Ashby erasure list incomplete" | `mark_ashby_application_links_erased` failed or refused (0140 not applied, or the request is no longer a pending or in-progress delete) | Apply 0140 if `to_regprocedure('screening_v2.mark_ashby_application_links_erased(uuid)')` is null, then retry the delete. Every step is idempotent. |

## Tests

- `scripts/test-ashby-impact.sh` runs `app/supabase/tests/ashby_impact_assert.sql` on the
  complete chain inside `scripts/supabase-test.sh` (CI job `supabase-check`), in one
  rolled-back transaction. `policy_tests.sql` section "0140" pins the security posture.
- `app/api/src/__tests__/impact-route.test.ts` and `ashby-business-impact-migration.test.ts`
  pin the API, the visibility rule, the audit rows and the migration's shape. The route suite
  replays `fixtures/impact-postgres.json`, what Postgres answered on the SQL suite's fixture;
  regenerate it whenever 0140's output changes.
