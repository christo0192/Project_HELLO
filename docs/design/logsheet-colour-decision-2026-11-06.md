# Decision record: colour that carries meaning

**Date:** 2026-11-06
**Decided by:** the owner
**Milestone:** M026
**Follows:** [logsheet-decision-2026-11-05.md](logsheet-decision-2026-11-05.md), which stands except where this record says otherwise.
**Contains no candidate data.**

## The request

"i like the current ui/ux build but it has more black and grey shades for important metrics and numbers and visualised areas. that makes the user find very hard to differentiate things as they are ideally all the same colour."

The grey was a rule, not an accident: the 2026-11-05 foundation pointed `--success`, `--warning` and their `-text` and `-soft` names at ink and the shaded field, charts cycled ink steps, and an outcome was not coloured good or bad.

A later request the same day: "i want more colours in the candidates review page. especially in the AI recommendataion area where select borderline and reject is there and yes the single candidate's verdict and ratings should also get the colour."

## Decision

Keep Logsheet as it is: paper, ink, ruled sections, type, layout, no motion. Change what colour means. Four families, each meaning one thing on every screen. Colour is never the only signal: the printed word stays, and shapes and dashes stay.

| Family | Means | Mark | Light step | Text | Soft wash |
|---|---|---|---|---|---|
| `moving` | Underway, the process has it | `#2f8bc3` | `#72baeb` | `#015e8c` (also the deep mark) | `#ddf0fe` |
| `ready` | A good or ready result | `#0a693c` | `#349d62` | `#0a693c` | `#dff3e5` |
| `unresolved` | Unfinished, or needs a second look | `#958d0f` | `#b7af47` | `#6b6620` | `#efeed9` |
| `closed` | Ended, no judgement implied | `#5d408a` | `#ae96da` | `#5d408a` | `#efe9fd` |

Plain totals stay ink. If everything is coloured, nothing is. A count with nobody in it stays ink too, whatever its family: an olive "Needs review 0" would say something wants a second look when nothing does.

**The Dashboard rewrite is cancelled** (the owner, 2026-11-06, 13:20 IST). Today's Dashboard is the Dashboard, so its colour mapping is final work and every tile on it is finished. The queue strips that rewrite would have kept grey never ship.

## What changed from 2026-11-05

- **The status names got their hue back.** `--success` is `ready` and `--warning` is `unresolved`. `--info` stays ink, because `bg-info` is the primary fill; `info` means `moving` only in the tone maps of `StatusBadge`, `BarList` and `MetricStrip`.
- **An aggregate takes verdict colour.** Select is `ready`, Borderline `unresolved`, Reject `closed`, on the Dashboard and Candidates bars. Reject is still never crimson.
- **Charts cycle the families,** then a quiet ink step. A series that means an outcome passes its family, never its place in the cycle, and keeps its dash and marker.
- **The on-a-call stage lost the orange.** The pipeline borrowed the voice hue for it. It is now the deep `moving` step, so orange means the candidate's voice and nothing else, which is stricter than the 2026-11-05 encoding table.
- **Abandoned and wrong-number cycles lost their crimson.** They are `unresolved`, and only `phone_failed` stays crimson. In `abandoned_no_answer` and `wrong_number` nobody on our side failed. `screening_abandoned` can go either way: the candidate may have dropped, or its reason code `infra_interrupted` says the call was cut off on our side, and the detail line prints which. The status has one colour, so that reason prints olive beside a sentence admitting the fault. The first question below puts this to the owner.

## The owner's later decision: one candidate's verdict and ratings take colour

The first version of this record kept one candidate's verdict in ink, because the 2026-11-05 decision held that a hue on an AI judgement about one person would anchor the reviewer. The owner reversed that the same day, knowing why ink had been chosen. This section is the decision as it stands.

- **Verdict:** Select (`advance`) is `ready`, Borderline (`hold`) is `unresolved`, Reject (`reject`) is `closed`. No recommendation has no hue. Crimson stays faults only, so a Reject is violet and never red. Orange stays the candidate's voice only. This reaches `VerdictMark` everywhere: circle, word and figure, the full, half and empty circles all kept.
- **Rating, by position on the metric's own scale:** at or above 0.75 is `ready`, at or above 0.5 is `unresolved`, below 0.5 is `closed`. On the 4-point scale that is 4 and 3, then 2, then 1 and 0.
- **The AI recommendation panel on Review:** the verdict block takes its family's wash and a full 1px edge in its mark, dashed only while Provisional. The figure takes the text shade, and `/100` clears 4.5:1 on all three washes (lowest 5.18), so it stays `--ink-3`. The ruler paints all three zones, the stored verdict's own in its mark and the others in their light step, each label in its family and the current one semibold, the score mark in ink. "Provisional", on the stamp, in the paragraph and as the notice under a verdict on the Session scorecard and the R1 review, and the leading words and icon of "Check before deciding" are `unresolved`. Pips, the rating word and the figure take the rating's family, and Insufficient evidence is `unresolved` with a dashed edge. Metric names and weights stay as they were, and so does a pressed seek chip, because ink is selection.
- **Evidence numbers across Review** take the family of the rating of the metric they cite, so the strip shows at a glance where the weak and the strong evidence sit. A metric with no score stays ink. The `--wash` highlight, the orange voice segments, the grey AI segments and the consent hatching do not change.
- **The In Ashby cell:** the state takes the same family as the workflow card, so "Writing results back to Ashby" is `moving`, and "AI scorecard sent" is `ready`. No consent line and no "Consent given at" row takes colour.
- **R1 and the older cards follow the same mapping:** `r1-review/VerdictBlock`, R1 metric rows, `HeaderScore`, `ScoreVerdict` and `CandidateScorecard`. So do the two lines that print a verdict without `VerdictMark`: "AI recommendation: Select · Overall 72 of 100" on the candidate's R1 tab, and "Phone screening: Select 71 (AI)." on the R1 page. Only the result takes the family. A withheld sentence, a held phone score and a phone figure with no verdict have no hue. An R1 figure with no verdict does not print: the R1 tab says "AI result: not scored" instead.
- **The R1 queue, `/interviews`, reads from the same maps, so a fact matches the candidate's R1 tab and the review.** A status word prints in the text shade of the family its chip takes, by the word shown, so a lapsed link reads Expired in `closed`. The recording tag takes the family of the attempt it names, and No recording stays neutral. Circle, word and figure take the verdict's family. "Not scored", "Not scored yet", "No result" and a withheld result have no hue. The figure at the head of a view follows the Dashboard tiles: To review `ready`, as Awaiting decision is, In progress `moving`, Reviewed `closed`, because a settled outcome has ended with no judgement implied. All is a plain total in ink, and a zero stays ink in every view.
- **The line "R1 role-play: Select 72 (AI)" in the candidate header takes the verdict's family,** so it cannot disagree with the R1 tab beneath it.

Two calls the brief left open:

- **A `Meter` colours by the band it prints, not by position.** Its bands cut at 0.5 and 0.7, so by position a 7 of 10 would read "Strong" in the needs-a-second-look olive. The colour must not contradict the word beside it. Impact stays ink, because a filler or native-language impact is not better when high. The Session and Screening card's bars print no band word, but read the same map, so one candidate's one number keeps one colour on both legacy cards.
- **A chip stays ink.** A skill, a gap, a signal level, a resume conflict and the legacy card's red flag chip are neither a verdict nor a rating. "Stays ink" also means unchanged: the `ink` and `ink-2` tones print these chips exactly as they were on 2026-11-05, so a gap, a red flag, a high signal or an unresolved conflict keeps its heavier ink.

Where colour would have said more than the words beside it, it steps back. The words do not change anywhere.

- **The stored verdict decides the ruler, not the score.** This departs from the brief's "the zone the score falls in" only when the two disagree, and today that is R1's integrity floor: a level 1 on objection handling or negotiation caps an overall at or above the Select cut-off at Borderline, so a 72 can be Borderline. The Borderline zone and label then take the emphasis, and the ink score mark stays at 72, in Select's pale zone. In every agreeing case it is still the zone the score falls in, and a score on a cut-off is the verdict that cut-off starts.
- **No verdict, no hue, in the ruler too.** "Not scored", "Needs human review" and an unknown value paint all three zones in `--rule-2` and their labels in `--ink-3`, with nothing emphasised. A score mark, if there is a score, stays where the score is.
- **A scorecard held for thin evidence has no hue.** `ready` means a good or ready result, and a held row (`evidence_grade` `insufficient`) was not sent to Ashby and changed no status. It has no wash, a `--rule-2` edge, an ink figure, an ink circle and a grey ruler, and its ratings and evidence numbers stay ink. This holds wherever the hold notice is printed: the phone Review, the header, the fallback cards on Review, and the Session and Screening scorecards. The word, the shape and the figures stay.
- **Known gap: the Candidates row.** Its API select carries no `evidence_grade`, so the web cannot tell that a row is held, and it still prints that row's verdict in its family. This needs an API follow-up, and this work is web only.
- **Ratings the page has disowned have no hue.** With an R1 gate failed the page says "These AI ratings gave no usable result", so on that stage the word, the figure and the pips print in ink. The same row prints in ink in the one other place it can open, the scorecard on `/screening/:sessionId` (`isResultDisowned`, the R1 page's own rule: `raw.r1` with a NULL recommendation, or `raw.recommendation` `human_review`). The Session page sends an R1 session to the R1 page, and the candidate's Phone screening tab opens phone sessions only. A phone `human_review` row keeps its rating colours, because no page disowns them.
- **The legacy card's Overall score bar takes the verdict's family, not its band's.** Its word cuts at 50 and 75 and the verdict at 45 and 65, so by band a 70 was a green Select over an olive bar, and a 47 an olive Borderline over a violet one. The word stays, so a 70 reads Select over a green "Fair". With no verdict, or on a held row, the bar is ink.
- **A missing legacy score has no hue.** An absent Communication or Motivation score still prints "0/10 · Low", as it always did, and is no longer painted as a violet rating.
- **The hold notice's heading is ink.** "Not enough interview evidence to decide" sits on a card that has no hue, so it has none either.
- **A pending rejection on the R1 review header is neutral.** It only follows from the verdict, which carries the family.

## The rating summary in the candidate page header

The owner's request, 2026-11-06: move the rubric ratings into the empty space beside the status chips, because "this will help the users to quickly see where they scored and where they lacked". The owner saw this on a real page in the comparison sheets and liked it.

**Legal has not seen the header ratings.** AI ratings now stay on screen away from "Not a hiring decision", and this record does not say Legal approved that. The Provisional words beside them are the one mitigation so far, and they reuse an existing string, so no wording changed.

**The verdict stamps are parked.** The owner: "the reject stamp is parked for now. dont work on the stamp part but work on the other things." There are no stamp images, no generator and no `VerdictStamp` component in the app, the verdict box is unchanged, and the Provisional note stays open. The artwork is kept outside the repo. The owner's earlier approval of the artwork stands if this comes back, and Legal has not seen the stamps either.

What it is:

- **Provisional first, whenever the verdict box says it:** the box's own words, "Provisional · 5 of 6 metrics", with "Provisional" in `unresolved` and the count from the same helper the box uses. AI ratings would otherwise read as firm away from the box. Stacked in the name row, the line break parts the two where the dot does. The words name a group around the items, so someone tabbing through with a screen reader hears them on the way in, and that adds no wording.
- **One item per metric, in rubric order:** the name in ink, the same `Pips` as the rubric row in the rating's family, and the figure ("3/4"). The rating word does not fit, so it is in `title` and the accessible name, "Communication, Good, 3 of 4". A long name truncates first, and the pips and figure stay.
- **A metric with no score:** the dashed `unresolved` mark and a dash, and "Insufficient evidence" in the accessible name, which is the rubric row's own wording.
- **A press** opens that row, brings it into view and moves focus to it. Below `lg` that means clear of the app bar, which sticks over the top of the page. It plays no audio, mints no recording link and cues no moment. A second press leaves the row open.
- **A scorecard held for thin evidence** has no hue here either, as its rows have none.
- **The rubric rows keep their ratings.** The header is the glance, and each row is the detail beside its rationale.

Where it sits, measured on the 6-metric fixture at true 1440x900, 1440x768 and 1366x768:

| In the name row | Fit | Summary | Header |
|---|---|---|---|
| No email, no summary | | | 123 px |
| No email | Three columns by two rows, in the row | 675 x 48 px at 1440, 601 x 48 px at 1366 | 123 px, no change |
| Email or a long name | Its own line under the name, across the full width | 1150 x 24 px at 1440, 1076 x 24 px at 1366 | 143 px, 20 more |
| The same, Provisional, below 1350 wide | Its own line, on two rows | 990 x 48 px at 1280, 890 x 48 px at 1180 | 167 px with an email, 44 more |

- **It chooses by measuring the room left beside the name,** never by testing for an email, so a long name behaves the same way. At 500 px or more it takes the row. The prototype's 534 px and 607 px fit there, and the 392 px left beside an email did not.
- **Its height is kept before the scorecard arrives,** blank, while the panel holds its skeleton, because the panes are measured from the header and must not jump. It is kept only when the candidate's own row says a scored card is coming, so a page that will show nothing keeps no box. `--review-top` now observes it too. The Provisional words and the blank that holds their place take one fixed width, 176 px on their own line and 92 px stacked, sized for the widest count, "20 of 20 metrics" with room to spare: it measures 160 px on Windows and a little more on Linux. The list takes what is left, so the two get the same columns at every width.
- **Six across needs 1350 wide beside the Provisional words.** A column is at least 136 px. Below 1350 a provisional card's own line wraps to two rows, 44 px and not 20: with an email the pane goes from 393 px to 349 at 1280x720, and from 473 px to 413 at 1180x800. A firm card has no such words, so its six stay on one row down to 1180.
- **The page still does not scroll.** What the summary adds to the header comes out of the panes' floor, which is 34rem with no summary, 31rem for up to six metrics, whose two rows are 48 px, and 26.5rem past six, because 20 add 120 px at most. So a window that held the page with no summary still holds it with one. At 1180x720, where the page scrolled 13 px with a long name and 45 px with a long name and email, it no longer does, and the pane is 320 px and 288 px. The panes pay for it: in a short window they now get less height, where before the page scrolled.
- **It never overlaps Export report.** Each has its own grid track, and below `sm` it stacks under the actions.
- **The own line costs the pane its height.** The owner's sheet says the panes lose 18 px, and here it is 20. On the 5-metric mock at 1440x900, the fifth row then ends 13 px below the fold, where all five fitted before. On the 6-metric fixture with 5 flags no row is whole on arrival either way: the rubric starts 487 px down a pane of 577 px with no email and 557 px with one, and at 768 tall it starts below the fold. The header carries what those rows would have said.

Two places this differs from the picture, on purpose:

- **Each item is 24 px tall, where the prototype's was 20.** 24 px is this app's smallest target, as the compact picker and the back link are, so two rows are the whole 48 px name row. On its own line the header grows by 20 px, not the prototype's 18.
- **The dash is "—",** the app's own mark for a figure with no value, where the prototype typed a hyphen.

It renders nothing wherever the panel hides scores: decision use blocked, a legacy row, no scorecard, no metric scored, or "Not scored" in the verdict box. A candidate with only an R1 interview has no phone workspace, so nothing fills it and the header stays plain. It is built from the panel's own gated card, so a new rule there reaches it. The brief lists consent withdrawn among the panel's rules, but Review has none: `consent_withdrawn` is a stage of one call, used for its recording. A session with a scorecard prints it in the panel and here alike. That is a question for the owner below. It never shows another call's figures: when the panel reads "Latest scorecard" for another call the header is empty, because it has nowhere to say so. It follows the session picker, clears on a change of candidate, and makes no API call of its own. It is on the Phone screening tab alone, reached by `?tab=phone` or the old `?tab=review`: Profile has `HeaderScore`, the R1 interview tab has its own result, and neither has a compact header. The scoped Ashby page offers it no place, and the R1 review page has its own header.

## What did not change

- **Reserved colours:** `--voice` and `--voice-mark`, `--danger`, `--go`, the primary button, focus ring and selection.
- **All wording.** Consent, recording, opt-out, appeal and jurisdiction text stays with Legal.
- **Candidate-facing pages and the exported report.** The `--c-*` names stay on ink and read no family. `/appeal` and `/status`, the two public pages that use the status names, hold them on ink with `.keep-ink`.
- **The stock `emerald` and `amber` scales** stay on ink. They carry no meaning of their own, and meaning is written with a family.

## Validated, not eyeballed

The dataviz validator, on `--paper`. `logsheet-tokens.test.ts` ports its Machado CVD and OKLab calculation, so these fail CI if a token moves.

- **Chart cycle, all pairs:** worst colour-blind delta E 14.5 (target 8), worst normal-vision 20.0 (floor 15), all at least 3:1.
- **Select, Borderline and Reject, all pairs:** the same worst figures.
- **The Candidates status bar, adjacent, with every one of these buckets holding someone:** New, Queued, Screening, Screened, Advanced, Rejected, Consent declined, Abandoned: no answer, Phone screen failed, Abandoned: dropped before screening, Opted out. Worst normal-vision 15.0. The light steps sit under 3:1 and rely on the relief rule: every segment has a printed, labelled chip with its count.
- **Ramps, ordinal:** `moving` three steps, the others two. All pass, lightest step at least 2:1.
- **Text on paper, field, desk and its own wash:** at least 4.5:1 for all four families. The lowest is `#6b6620` on desk at 4.79.
- **Paper on a fill:** only `#015e8c` (6.74), `#0a693c` (6.49) and `#5d408a` (7.84). Paper on `#2f8bc3` is 3.59 and on `#958d0f` is 3.30, so no text goes on those two marks, and a test scans the source for it.
- **A dot under 3:1, with the word beside it:** the olive mark on its own wash (2.94) and on the desk (2.78, the sidebar's Maintenance dot). The dot is `aria-hidden`, and the printed word carries the status.
- **Rejected, do not retry by eye:** teal `#12857a` with plum `#9c4a8f` collapses for colour-blind readers (delta E 4.2), and that pair would be Select against Reject. Amber `#b98500` sits 10.6 from the voice orange (floor 15).
- **The verdict ruler, adjacent, on the verdict's own wash:** the Reject state passes (worst normal-vision 16.1, colour-blind 9.9), and so does the Select state (22.4, 20.6).
- **An evidence tag's resting edge is the family's mark, not its text shade.** A tag is a bare number, so colour alone says its family. The text shades `#6b6620` and `#0a693c` fail the validator (colour-blind delta E 3.7, normal-vision 9.5, and `#6b6620` reads grey at chroma 0.09). Everywhere else a word relieves them, and a tag has none. The marks `#958d0f` and `#0a693c` pass (normal-vision 20.0, colour-blind 15.5), and `--unresolved` clears 3:1 on paper (3.30) and on the tag's hover field (3.02). The digit and the pressed fill keep the text shade, because paper on `#958d0f` is only 3.30.
- **A tick that steps back gives that edge up.** The Review congestion work (2026-11-06) leaves only the weakest metric's ticks, an open metric's and the pressed one at full weight. The others keep their digit, which still clears 4.5:1 on paper and on the field it hovers onto, and take the `--rule` edge and a `--control` stem, 3:1 or better on paper. The edge is decorative, so nothing depends on it, but on those ticks the family rests on the digit alone, and Select and Borderline read alike there to a colour-blind reader. The rating stays a word in its rubric row, and the tick takes its mark edge back when its metric opens or it is pressed. The `--control` stem reads on paper only: across the voice mark it is 1.00:1 and across the `--ai` bar 1.15:1, and no grey short of ink reaches 3:1 there (`--ink-2` is 2.36:1, `--ink-3` 1.50:1). Where it crosses a turn, the 4px stub above the strip carries the moment, and when two quiet ticks share a moment and one box is set to the side, that stub is all that marks it. Each tick's name still gives its turn and time.
- **One recorded exception: the Borderline state of the ruler.** The mark `#958d0f` beside the light step `#349d62` on `#efeed9` is normal-vision 11.0 (floor 15) and colour-blind 6.7, in the band the validator allows only with secondary encoding. It is the pair a reader has to read on a Borderline verdict. Each zone therefore sits behind a real 2px gap with the wash showing through, and each has its word printed under it, so the ruler does not depend on telling the two apart. The tokens stay, because they pass everywhere else, and all three states are pinned in `logsheet-tokens.test.ts`.

### What the figures do not cover

The tests name every pair below, so a new one fails CI.

**Green against crimson, and olive against orange, for colour-blind readers.** The 15 floor against `--danger` and `--voice-mark` is under full colour vision, as the brief asked. Under simulation three pairs sit below the colour-blind target of 8, and the first two fail the real validator:

| Pair | Colour-blind delta E | Where it shows |
|---|---|---|
| `--ready` `#0a693c`, `--danger` `#a01c3c` | 2.1 (deutan) | Completed and Failed on Mission Control's Session status mix read as one colour, each on its own labelled row. Advanced can touch Phone screen failed on the status bar. |
| `--unresolved` `#958d0f`, `--voice-mark` `#cf5a12` | 1.7 (deutan) | Orange marks a voice on a call strip, never a neighbouring status category. |
| `--ready`, `--voice-mark` | 7.0 (protan) | The same. Inside the validator's 6 to 8 band, which needs a second signal. |

The tokens stay, because they are the validated ones. Colour is not the only signal: the printed word carries the state in all three, plus a crimson edge on a fault's badge.

**Neighbours the validated order does not have.** The bar has thirteen keys, and the validated order is the eleven above with every bucket holding someone. `wrong_number` and `phone_cancelled` were not in it, and a bar draws no segment for an empty bucket, so real data forms other neighbours: any two statuses can touch. `logsheet-tokens.test.ts` derives them from `CANDIDATE_STATUS_ORDER` and `candidateStatusMark`. Every pair below keeps its 2px gap and its labelled chip with a count.

- **The same step, delta E 0.0:** Consent declined, Opted out and Phone screen cancelled with one another, and Abandoned: no answer with Wrong number. Thirteen keys cannot all differ. Opted out and Phone screen cancelled sit side by side on a full bar.
- **Two steps of one family, 11.0:** Abandoned: dropped before screening with Wrong number, side by side on a full bar, and with Abandoned: no answer as soon as no phone screen has failed.
- **Two families, only when every bucket between them is empty:**
  - New with Consent declined, Opted out or Phone screen cancelled: 10.9, and 3.9 colour-blind.
  - Queued with the same three: 7.1 colour-blind.
  - Screening with Advanced: 14.4. With Rejected: 11.4, and 1.9 colour-blind.
  - Screened with Abandoned: no answer or Wrong number: 11.0, and 6.7 colour-blind.
  - Advanced with Phone screen failed: 2.1 colour-blind.

## What the audit decided

Everything rendered as ink before this, so some uses would have turned green or yellow by accident. Each was read.

- **Went back to ink, because they never meant a state:** the access list's "protected" note, the "re-screening is unavailable because the candidate opted out" line, the legacy `Scorecard`'s skill, gap and conflict chips and its signal levels, and the resume chips. `recommendationMeta`'s tones and "Insufficient evidence" where a rating would be were here too, until the owner's later decision above gave them their families.
- **Became `moving`:** a live call on the phone calendar, a resume being processed, a write-back in progress, a recording being prepared, and the "a call attempt is in progress" note. They had been warnings only to catch the eye.
- **A confirmed appointment is `moving`,** with its callback note. The call is still to come, and beside Fulfilled in the same green it looked done. This corrects the brief's Dashboard line, which listed it as `ready`.
- **Stopped being crimson:** a low funnel conversion (`unresolved`), Parse failed (`unresolved`, since it counts a resume with no readable text as well as a parser fault, so it is not shown to be ours), the shared pool at 90% (`unresolved`, since a rate never says a fault), an invalid phone number (`unresolved`, as Wrong number is), and a cancelled or expired session, a cancelled Ashby workflow and an Ashby terminal state such as "Application withdrawn" (`closed`, on the candidate's card and on Ashby Live Jobs alike). A missed appointment is `unresolved`: the slot passed without a call, and that is not known to be our fault.
- **The sidebar's service dot** takes the family Mission Control prints the same state in: green when online, olive in maintenance. Checking stays muted and an offline API stays crimson.
- **"Recompute failed" is crimson at last.** It was written `text-danger`, which compiles to nothing because Tailwind's colour map has `error`, so a real fault printed in inherited ink. The design gate now refuses any `-danger` utility.
- **The audit result maps what production writes:** `success`, `failure` or `pending` (`chk_audit_result`, 0007). A failure is `unresolved` because it covers every request an audited route refused, so it is not always our fault. It used to be grey, because the map keyed on a `denied` value nothing can store. Pending is `moving`.
- **The R1 allowance:** Used `moving`, Held `unresolved`, Free neutral, because free capacity is not a verdict. The three lanes of the pool (R1 interviews, Phone, Legacy browser) have no state, so they take the chart cycle's first three slots and imply nothing.
- **The pool's middle band says nothing.** From 60% to 74% its dot is neutral, not `moving`: using the pool is not "underway".
- **"Pending" is the one word with two families, on purpose.** A pending access entry waits on a person who has not signed in, so it is `unresolved`. A pending Ashby operation or audit row is queued work the process has, so it is `moving`. Forcing one family would say something untrue on one screen. `state-word-family.test.ts` fails on any other word that splits.
- **`GaugeChart` and `RadarChart`** indexed into the cycle. The gauge now says `moving`, then `unresolved` at 85%. The radar is one shape spanning several ratings, so no one family fits it, and it is ink.
- **A bar with no meaning of its own is ink,** where it used to default to the accent.
- **A "—" that could not be read is ink,** whatever its figure's family.

## Questions for the owner

1. "Abandoned: dropped before screening" prints olive even when its reason says the call was cut off on our side, so that one reason shows an olive badge beside a sentence admitting a fault of ours. The brief maps the status as one colour, so it stays. Should that reason turn crimson?
2. For a red-green colour-blind reader, green and crimson read as one colour, so Completed and Failed look alike on Mission Control's Session status mix. The word carries it, and a fault's badge also has a crimson edge. Is that enough, or should the tokens be revisited?
3. Answered: `VerdictMark` and the ratings take colour. See the owner's later decision above.
4. The header's rating summary still prints a scorecard held for thin evidence, in ink, because the panel still prints its rows under the hold notice. The notice is not in the header. Should a held scorecard print nothing there?
5. Review has no rule that hides a scorecard after a candidate withdraws consent on a call, though the brief assumed one. If there should be one, it belongs in the panel, and the header will follow it.
6. A role can have up to 20 metrics, and real roles have 6. Past 6 the name row adds a row for every three metrics, where the brief's fit is at most two rows and no growth, and the panes pay for each one. The page does not scroll at any of these, because the floor gives way, and that is the minimum fix. What should the header do past 6: keep growing, take its own line past about 12, cap its height, or leave the extra metrics to the rubric? Measured on the fixture, the reasoning pane's height:

   | Metrics | 1440x900, no email | 1366x768, no email | 1366x768, email | 1280x720, no email | 1280x720, email |
   |---|---|---|---|---|---|
   | 6 | 577 px | 441 px | 421 px | 393 px | 349 px |
   | 7 | 553 px | 417 px | 397 px | 369 px | 349 px |
   | 12 | 529 px | 393 px | 397 px | 345 px | 325 px |
   | 20 | 457 px | 321 px | 349 px | 273 px | 301 px |

   With no email the header is 0, 24, 48 and 120 px taller at 6, 7, 12 and 20 metrics. So the name row is the better place at 7, about level at 12, and worse at 20. The tightest case measured is 20 metrics with a long name and a long email at 1180x720: a 216 px pane.
7. On its own line and on a phone, Tab reaches the ratings before Export report, though they sit below it. This is deliberate: the reading order is the same whichever way the summary fits, so a change of fit moves no focus, and everything stays reachable. Is that acceptable, or should the order follow the layout, so that a resize across the fit changes it?
