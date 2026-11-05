# Decision record: the Logsheet look

**Date:** 2026-11-05
**Decided by:** the owner and the stakeholder
**Milestone:** M026
**Contains no candidate data.** The mocks behind this decision use invented names and figures; none are reproduced here.

## Decision

Build **Logsheet with Readout's scorecard panel**. Three directions were mocked for the two screens recruiters use most, Review and the Dashboard. The owner and the stakeholder reviewed them and approved this one.

They reviewed static mocks, not real data, so acceptance of the built screens on real data is still theirs after deploy.

## What was approved

- **Logsheet's world:** a taped interview and its log sheet. One opaque sheet on a desk, printed rules, carbon ink.
- **One hue:** an orange that means the candidate's voice and nothing else, defined in exactly one pair of tokens so it can change in one place.
- **From Readout:** all five rubric rows open with seek chips, a clearer verdict mark (full, half or empty circle plus the word, in ink), and cited turns that name their metric.
- **Verdicts stay in ink.** Every status carries a word. No entrance, reveal or count-up motion.

## Standing limits

- The voice hue stays the orange they saw. Two alternatives are to be rendered on the real screens for their pick, because the palette sits close to Claude's own look.
- Consent, recording, opt-out, appeal and jurisdiction wording does not change without Legal. Legal approved two new pieces of wording on 2026-11-05, for the phone Review screen only: the collapsed consent line and the what-if line in "Check before deciding". Logsheet PR 2 builds them. Nothing in this foundation changes any wording.
- The recruiter test of the queue strips was skipped by the owner. Strips ship in grey, so the verdict column leads, and their timing is fetched only for the rows on screen.

## How it reaches the app

Four pull requests. This record ships with the first.

1. **Foundation, across the whole app:** tokens, surfaces, motion, shell, type, charts, dark-mode retirement, candidate-facing pages, docs and the CI gate.
2. **The phone Review screen,** with the two Legal-approved wordings.
3. **The Dashboard queue and its strips.**
4. **The remaining screens.**

## What the foundation decided on the way

- **Dark mode is retired.** `main.tsx` forced the light theme in production, so no user could reach a dark app. The exported report is the exception: a reader opens it in their own browser, so its `prefers-color-scheme` block stays, mapped to warm counterparts and checked for AA.
- **The calling state is not in the sidebar yet.** Its only read, `GET /api/phone/health`, is limited to interviewers and above, and `GET /api/status` does not carry it. Showing it would mean a 403 on every route for a viewer, or a new read. A safe read needs its own change.
- **The "Resume calling" green stays.** It is the owner's request of 2026-09-29, it paints exactly one button, and no later decision reversed it.
- **`GlassPanel` and `.glass*` keep their names.** They are opaque now. Renaming them would touch nearly every page in a PR whose point is that pages re-skin without edits.
- **Reject and the Rejected status lost their crimson.** Crimson means a fault on our side, and a verdict is not a fault. Red flags and a high signal lost it for the same reason: they are AI judgements about a candidate, and on Review the hue would anchor the reviewer.
- **The pipeline bar follows the mock.** Mapping every tone straight onto ink collapsed its stages, so it is an outlined bar with the lightest bucket first, and the on-a-call stage takes the voice mark the encoding table allows.
- **Two lines on one chart differ by a dash as well as a grey.** The opposite outcomes on the Dashboard overlap for 30 days, and markers are hidden past 20 points.

## What PR 4 decided on the way

- **Sections are ruled, not boxed.** `GlassPanel level="ruled"` is the default for a block on these pages. The week grid keeps its frame: a timetable is a printed grid.
- **"Waiting" is time since a candidate was added,** for a candidate still in progress. The list payload carries no screened time, and the Candidates read is the one that broke at scale.
- **Shells being read sort after named candidates,** with one summary line above the table. None is left out, so a stuck one stays in the list and in the counts.
- **The booking picker searches name and email, not phone.** The phone calendar keeps every phone number out of the DOM.
- **A calling halt is in the shell, for the roles that can read it.** The foundation's note above held for a line shown to everyone. The RCA asks for admins and interviewers, whom `GET /api/phone/health` answers, so "Calling halted" needed no new read and a viewer's shell asks nothing. The direction's fuller line (window, on a call, queued) still waits for a read that is safe for every role.
- **"Closed", not "finished", for sessions that can't be changed.** Those are failed, cancelled, expired and deleted. A Completed session is finished in plain words and can still be overridden, so the RCA's example, "Finished sessions can't be changed", read false beside it.

## Sources

The directions, the comparison and the judges' scores live in the project's planning folder under `M026/directions/`. The root-cause analysis behind the redesign is `M026/M026-RCA.md`. The owner's decisions are dated in `DECISIONS.md`.
