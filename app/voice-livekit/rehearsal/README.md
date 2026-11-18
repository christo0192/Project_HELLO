# R1 rehearsal harness

Simulated advisor calls against the REAL R1 learner engine, so a change to the learner can be
proved before an owner test. Run from `app/voice-livekit`:

```
python -m rehearsal --offline --calls 20 --out <dir>                  # scripted, no key, no network
python -m rehearsal --matrix smoke                                     # live: 4 strong calls
python -m rehearsal --calls 20 --personas strong,average,weak,pushy,terse --out <dir>
python -m rehearsal.replay [--live]                                    # the owner's 4/10 call, replayed
```

## What runs

* ADVISOR simulator (`advisor.py`): DeepSeek plays the candidate in five behaviours (strong, average,
  weak, pushy-discounter, short-answers). It never sees the learner's card, its roles are swapped,
  and every turn is JSON `{intent, topic, text}`; the tags are the ground truth for probes, asks and
  farewells. Offline: `scripted_advisor.py`.
* LEARNER (`call.py`): a real `R1Interview` driven through the SDK seams by
  `tests.test_r1_integration.Rig` (plan, guard, intent tail, `record_spoken`), with the production
  client `r1_llm.build_r1_llm(env_dict)`. Offline: `scripted_learner.py`.
* CLOCK (`clock.py`): a modelled role-play clock R (about 35 s per exchange, calibrated on the owner's
  session), so the schedule, the 13:00 close window, the time cue and the 19:00 stall all happen.
* METRICS (`metrics.py`, pure, also run on real session exports), JUDGE (`judge.py`, LLM rubric),
  SCORECARD (`scorecard.py`, per advisor level against the pass thresholds).

## Reading a run

`calls/<call-id>.json` holds rows in the database export schema, one entry per exchange (advisor
tags, the learner's plan, the raw model text before the guard, latency, tokens), the engine's
administration log and the events the API would receive. `results.jsonl` has one summary line per
call, `scorecard.md` / `scorecard.json` the aggregate, `run.json` the settings, the ledger and why the
run stopped. Nothing written holds the API key.

Exit codes: 0 ok, 1 usage or unexpected error, 2 no key, 3 no balance (HTTP 402), 4 budget exceeded,
5 hard fails or failed gates with `--strict`.

Gates added or changed in R1-Q iteration 1 (owner decisions of 2026-10-08): the reply-length gates
(mean <= 22 words, p90 <= 35, short replies >= 30 %) are INFO only and never block (wordiness is
accepted; `length_low`, mean >= 8, still gates); the verbal-tic gates block: no first word of a
reply (any word: `okay`, `hmm`, `that's`, `i`, ...) opens more than 15 % of the learner's replies
(the metric counts the literal first word; a whitelist of reaction words missed "That's" in the third
sweep), "hmm" is in at most
20 % and "honestly" in at most 20 % (pooled over the group's replies, with the harness's own
regexes). Misfires now also count `time_cue_reversed`, `decider_alone`, `anchor_taken_as_offer`,
`gratitude_after_hedge` and `reopened_after_commit`. A deep need told within two exchanges of an
advisor QUESTION that uses the topic's own words is not an "unprompted dump" even when the
simulator did not tag the question as a probe (`unprompted_dump_excused` counts those).

Gates and metrics added or changed in R1-Q final review round 1:

* `decider_stall` / `decider_stall_window` (the learner stalling on its decision maker: at most 3
  replies per call on average and at most 2 in any 4 replies in the worst call) and `money_strain` /
  `money_strain_window` ("still more than I planned for": 3 per call, 2 in any 3 replies). The guard keeps
  a quota and a spacing window for each phrase (`PHRASE_QUOTA`, `PHRASE_WINDOW`); the metrics use the
  harness's own regexes and count what was spoken.
* The unprompted-dump metric counts the FIRST telling of a deep need only: saying it again later is
  repetition (the repeat metrics see it), not a new disclosure.
* The fact check allows the prices of the offer ledger (`admin_log.negotiation.offers[].net_usd`) and
  the advisor's spelled-out amounts: a net price the advisor reached in words ("thirty-five percent off,
  that's thirty-one fifty off" = $5,850) was a false `price_not_deck` hard fail.
* `tests/fixtures/r1_advisor_heldout.jsonl` scores the lexical detectors on advisor phrasings that were
  never used to tune them (`HeldOutCorpusTests`, recall floors in the test module).

Gates and metrics added or changed in R1-Q iteration 2 (the second live sweep):

* `commit_strong` is INFO. A call ask caps the grade at MEDIUM (`r1_commitment.grade`), and every
  persona names a decision maker, so a strong advisor correctly asks for a call: STRONG was 0 of 8 calls
  in two sweeps. `commit_medium` (MEDIUM or better >= 90 % for a strong advisor) is the blocking half.
* The pushy/terse/weak cap `commit_cap` (MEDIUM or better in at most 20 % of the calls) lets a group of
  fewer than 8 calls exceed it by ONE call (four calls: one booked call is 0.25); the markdown table says
  "small group: held to 0.25".
* New gates: `stretch_tic` (replies with "a stretch" per call, mean <= 1.5) and `template_tic` (replies
  asking "what would that call involve / cover / include" per call, mean <= 1.5). The guard keeps each
  phrase once per call; the metric counts what was spoken, with the harness's own regexes.
* A "dig" (the disclosure gate) is read from the advisor's own question (`metrics.dug_topics`): the
  simulator's `probe` / `followup` tag counts only when a question of the turn carries the topic's
  vocabulary (a generic "tell me more" keeps its tag), so "What's your current role?" digs at nothing and
  "Have you tried courses?" is an H2 question whatever it was tagged.
* An earned commitment (`unearned_commitment`) is read from the advisor's words too
  (`metrics.advisor_asked_next_step`): a sentence that names a call, a time, an enrolment or a seat and is a
  question or speaks in the offering voice counts, whatever the simulator tagged the turn.
* The rubric judge gets 3,600 tokens (was 1,200: the verdict was cut off, `bad_json`, on 10 of 20 calls)
  and the whole transcript (24,000 characters), is asked once more when its JSON is unreadable
  (`attempts` in the result), and sees the call's facts: the ANCHOR TURNS, the TIME CUE TURN and the OFFER
  LEDGER. Every misfire needs a quote that is really in the learner's line, and `anchor_as_offer`,
  `time_cue_reversed`, `reopened_after_commit` and `decider_inconsistent` count only when the rule
  detector agrees (`judge.validate_misfires`); the rest are listed as `misfires_rejected`.
* The advisor simulator is asked once more when it says goodbye before 10:00 (D23: six of 20 calls ended
  at 6:23 to 9:59). `--max-exchanges` defaults to 60 (the learner now speaks less, so 40 exchanges can end
  before 13:00). (Since the 20-minute role-play: before 14:00, and 86 exchanges.)

Harness fixes of R1-Q iteration 3 (H1-H6 of the analyst's second sweep):

* H1: a QUESTION is no claim. `metrics.fact_error_metrics` (the `claims_guarantee` family) skips
  sentences that start as a question ("Is the job guaranteed?"), so asking about a guarantee is not
  stating one.
* H2: the judge's misfires are held to the rule detectors. `unwarranted_gratitude`, `no_one_leaving`
  and `ignored_offer` count only when the rule agrees (`judge.RULE_CONFIRMED_KINDS`), and a `repeat`
  is rejected as `simulator_filler` (the advisor turn before it was a hollow "Sure.") or
  `no_earlier_line` (nothing like it was said before). Rejections are listed as `misfires_rejected`.
* H3: the probe vocabulary (`metrics._PROBE_VOCAB`) covers ordinary probes ("what's prompting you",
  "what got you interested", "what held you back", "does your employer cover part of it"); a question
  about WHEN to talk again is not an H3 dig (`_SCHEDULING_QUESTION`); the FIRST question a call asks
  about a topic is its probe whatever the simulator tagged, and any later one is a dig.
* H4: the terse advisor used to answer a goodbye with "Sure." / "Okay." / "Mm-hmm." for twelve turns
  and the learner said goodbye nine times: a loop the simulator made. Its behaviour text now asks for
  one short thing with content when the learner wraps up, and when its last two turns were hollow
  (four words or fewer, no question) while the learner was closing, the simulator is asked once more
  with `HOLLOW_LOOP_NUDGE` (terse level only, `LLMAdvisor._in_hollow_loop`).
* H5: a price cut is read from the advisor's WORDS (this turn or the one before, `_cut_nearby`), not
  from the simulator's intent tag: `unwarranted_surprise` no longer fires after a cut tagged
  `answer_objection`, and `gratitude_unwarranted` is a new misfire kind (thanks for a price cut nobody
  made).
* H6: the ledger is an estimate. A live run with a preflight now records the DeepSeek balance before
  and after (`run.json` -> `balance`: `before`, `after`, `spent`, `ledger_estimate`, `gap`), and the
  "Done" line prints it, so the budget gate is checked against what the account was really charged.

Harness fixes of M032 diagnosis 2 (each behind a switch, see below):

* D2-SC1 (`REHEARSAL_COMMIT_WINDOW`): the commitment gates (`commit_medium`, `commit_strong`,
  `commit_cap`, `no_strong`) count only the calls that had a commitment window. A call with NO commitment
  whose role-play ended on an end request, on the abuse hang-up (D-M032-3, `admin_log.endings.abuse_hangups`)
  or before 13:00 is excluded, and the gate shows the counts and the reasons beside its value ("4/6, 3
  excluded (abuse_hangup 1, end_request 2)"); the all-calls rate stays in the table. A call that reached a
  level always counts, and so does a full call that reached none, even when it then ended on an end
  request or the abuse hang-up after 13:00 (the learner had its window). The small-group cap slack counts
  the calls with a window.
* D2-HF2 (`REHEARSAL_SPOKEN_LEAKS`): `guard_flagged` hard-fails on the guard's own flag or on a commitment
  that was still in the SPOKEN line of the trip's exchange (`commitment_spoken_leaks`: the engine's
  classifier and the harness's own regexes, above the cap on record; a trip that cannot be matched to a
  spoken line counts, fail closed). The own regexes also read day and seat bookings ("let's do Thursday",
  "book me in", "hold the seat for me", "I wouldn't mind a call on Monday"), and a negation voids a match
  only in the same clause and within four words before it ("Never mind, let's book a call" agrees). A commitment the guard blocked is the info gate `commit_blocked`
  (blocked attempts per call <= 1). `post_commit` still gates.
* D2-ND1 (`REHEARSAL_PROBE_VOCAB_V2`): the H1 vocabulary no longer takes "motivated", "looking into" or a
  bare "interested" (they matched H2/H3 questions), "what's driving / prompting / behind / making you"
  match, "how did you get interested" does, a bare "got you" / "bring you" does not ("while I've got
  you"), "what's driving that number" is about money, "before I / you / deciding ..." is no H2 word, a
  worry of his or hers is no H2 dig, and "first/last time" is no H3 word;
  a question sentence is read per coordinated question ("What's your timeline, and what worries you
  most?" digs H1 and H2), and one question with two topics' words counts for the one named first; "a
  quick follow-up", "a day or time this week" to talk or call and "the best way to reach you" are the
  calendar, whoever is named ("what time do you have free this week for studying?" is an H3 dig). The
  engine's needs ledger (`admin_log.needs[].followup_turn`) is reported beside the harness's digs
  (`harness_only_digs`, `engine_only_digs`, `disclosure_rate_engine_confirmed`, info gates); the
  disclosure gate keeps scoring every harness dig, because a dig the engine missed is a product failure
  its own detector cannot report.
* D2-HM1 (`REHEARSAL_CITED_MISFIRES`): a judged misfire of kind `other` must cite the ADVISOR turn it fails
  to follow (`advisor_turn`, not after its own turn) and a `reason`, or it is rejected as `uncited` (a
  verdict stored before the judge was asked to cite keeps the old rule on a re-score). With the switch OFF
  the live judge is sent the previous rubric and schema byte for byte and its verdict carries no citation
  keys. The scorecard shows
  judge, rejected and rule misfires as separate rows, and one call adds at most 5 to the misfire gate's
  mean (`misfires_uncapped` is the info row). Manual replays stay in the gate.

An OFFLINE scorecard checks the plumbing and the engine's decisions (schedule, negotiation, guard,
repetition, disclosure layers), never the model: it can never be "ready for an owner test". Ready
means a live sweep of 20 or more calls with every applicable gate measured and met.

## Live checklist

1. `GET /user/balance` must say `is_available: true` (the preflight checks it and stops with exit 3).
2. Does the Fly worker share this account? If it does, the owner's next live R1 test fails with 402 too.
3. First live job after a top-up: validate the judge on `tests/fixtures/r1_owner_b58c7d9c.json`
   (it must flag turns 52 and 57 out of context, 35/41 as duplicates, style <= 2.5) and compare two
   shuffled runs (>= 85 % agreement) before any judge gate is trusted; confirm `deepseek-v4-pro` works
   with JSON mode (the preflight probes it and falls back to `deepseek-flash`).
4. `--matrix smoke`, then `sweep` (20 calls), then `confirm` (60 calls) with `--baseline <earlier run>`
   to attach a before/after diff to the PR.
5. Guard LEAK hits per call (replies the guard blocked: invented_fact, concession, volunteered_need)
   are a gate (mean <= 1); hygiene hits (the repetition guard dropping a sentence) are reported with
   them and never block. `scorecard.md` lists every call ("Guard hits per call", plus the
   invented-fact share). The reworded reaction prompts of R1-Q
   round 1 (react to how it lands, never repeat a course detail) are proved ONLY by a live sweep: the
   offline harness has a scripted model, so its guard hits say nothing about them. Gate the merge on
   this table.
6. `final_price_asked_twice` is a hard fail: the learner asking "is that the final price?" twice
   within three exchanges (the pleased anchor and the met counter used to).

## Whole interviews (`--full`, M032 S8)

```
python -m rehearsal --full --offline --out <dir>                                  # every default scenario, scripted
python -m rehearsal --full --scenarios manual-replay --out <dir> --budget-usd 2   # live: the 10 manual replays
python -m rehearsal --full --scenarios manual-M01 --out <dir> --budget-usd 0.50   # one live smoke call
```

One call runs the WHOLE interview, OPENING to CLOSING, through the production phase driver
(`R1Interview.run`): L-OPEN, the icebreaker and its exit, the brief, "ready" or the button, the
role-play, the exit, the wrap-up and L-CLOSE.

* CLOCK (`vloop.py`): a virtual-time event loop. The driver's silence windows and caps take no real
  time (a 25-minute interview runs in about a second offline); a production model call (Christy, the
  learner, the shadow judge, the end-intent classifier) takes its real seconds on the clock; a harness
  call (the simulated candidate, the rubric judge) stands the clock still; its retry backoff sleeps
  in real time (`vloop.real_sleep`), and each call's header records how its clock moved (`clock`:
  watchdog trips, real and jumped seconds). S is the interview clock, R the role-play clock, both read
  from the session's own phase machine.
* SDK SIDE (`sim.py`): scripted lines play for their words at the voice's pace; a candidate turn is
  `user_state_changed`, the STT finals, the endpoint, `on_user_turn_completed`, the reply through
  `llm_node`; the "I'm ready" button is the server-sent `data_received` packet the API relays
  (`TestReadyButton`), pressed only while the page shows it (`awaiting` is `ready`; else a
  `button_not_shown` event). Speech is scheduled as livekit-agents 1.6.4 does: one speech at a time in
  creation order (a `say` made while a reply plays waits behind it), `interrupt()` cuts the playing
  line (the transcript keeps the words played), and a turn that ends over an uninterruptible line gets
  no reply. Live, the learner and Christy client uses the session's connection options (one retry
  after 0.5 s) and its SDK `error` events reach the session as in production. Not emulated: barge-in,
  VAD fragments, the acknowledgement hold, TTS audio.
* SEAMS (`seams.py`): every `*_runner` of `R1Interview` runs as in production, where each is on by
  default. Live, on its production client (`SEAM_CLIENTS`: the judge client for the shadow judge,
  the end-intent classifier and the turn reader; Christy's client for the transition bridge); an
  unmapped seam stops the sweep. Offline, a scripted stand-in (the end-intent classifier answers from
  the turn's ground truth). The header's `seams` says which ran `live`, `scripted` or `absent`.
* CANDIDATE (`candidate.py`): one person through the whole interview, phase-aware: a job candidate to
  Christy (icebreaker answers, brief questions, "ready", wrap-up questions), the Program Advisor to the
  learner (`advisor.py` behaviours), and out of role when Christy steps in (an end question, the offer
  to wrap up). It decides from what it HEARD: a sound check ("Can you hear me okay?") gets a short
  yes, Christy's in-role questions are recognised from the line said, the offer to wrap up is taken
  only on spoken cues, and a nervous silence lasts until Christy speaks again. A failed live advisor
  turn is played by the scripted advisor of that level. Live, DeepSeek plays it; offline, scripted
  banks.
* SCENARIOS (`scenarios.py`, `manual.py`): the synthetic edge scenarios (strong, average,
  terse-nervous, brief-repair, button-mid-brief, roleplay-question, icebreaker-skip, early-end,
  early-end-late, abuse-once, price-dodge, price-never, pushy-discounter, wrapup-question, wrapup-none,
  silent) and the owner's manual tests (`scenarios/manual_tests.json`, paraphrased, the candidate is
  "Alex"): `manual-M01`..`manual-M10` replay a session's moves in order (live, DeepSeek rewords each
  move to fit what was said, except a move whose act a check scores, such as an end request, an
  insult, "ready" or a brief request, which is said as written; offline, the paraphrase; a transition
  request to hear an icebreaker question again is a `repeat_request`, not a brief request, and
  "repeats the request" is the move before it again; moves that shared one bot turn are one turn, and a
  role-play move waits until R is within 15 s of when it was made), `manual-mix` samples the catalogue
  (its call id says `mix`; the header has the level it drew). Groups:
  `default` (all of them), `manual-replay`, `manual`, `synthetic`, `early`, `price`, `wrapup`.
* CHECKS (`full_metrics.py`): phase order, the close, the icebreaker exit window, the role-play start
  the way the scenario started it (no fallback to the button, the button only when shown), the
  transition ceiling, no in-role exit before R 14:00 without agreement, every end request heard
  (asked, or an at-once exit the design allows; an ignored request also fails a time-cap end), the
  abuse path (feature-detected), brief repair (Christy's scripted brief line again, or a shorter
  one under 60 % of the brief), an icebreaker question asked again when the candidate asks for it,
  the wrap-up answered, the hiring team named once,
  Christy's repeats, one goodbye, no learner after the exit, dead air, no two bot lines at once. Optional M032 behaviours are feature-detected (`session_facts.start_by`, an abuse path, any
  extra `*_runner` seam of `R1Interview`), so the same harness runs on main and on the M032 branch.

Files: `calls/<id>.json` (rows in the export schema with `phase`, `speaker`, `voice`, `ai_voice`,
`text`, the timing columns, S and R, the candidate's ground-truth `act` and the library `intent`; the
role-play exchanges; the events; the phase trace; the administration log and rows; `session_facts`;
the per-phase checks), `transcripts/<id>.txt` (one line per turn: S, R, phase, speaker, text),
`results.jsonl`, `scorecard.md` / `scorecard.json` (the per-phase checks and the role-play gates) and
`run.json`. Offline is never "ready for an owner test".

Each role-play exchange records `learner.r_sec`, the R at which the engine decided the learner's line;
the window checks (no commitment before 13:00, no time cue before 14:00) use it, since an advisor turn
can start before 13:00 and end after it.

Harness switches (`rehearsal/flags.py`, default ON; `0` restores the previous behaviour):
`REHEARSAL_KEEP_CONTROL_ACTS` (scored acts are never reworded), `REHEARSAL_TRANSITION_ACTS_V2` (the
transition labels, the brief-line rule and the `icebreaker_repeat` check), `REHEARSAL_LEARNER_CLOCK`
(window checks time the learner's line by its decision), `REHEARSAL_COMMIT_WINDOW`,
`REHEARSAL_SPOKEN_LEAKS`, `REHEARSAL_PROBE_VOCAB_V2` and `REHEARSAL_CITED_MISFIRES` (diagnosis 2, above),
`REHEARSAL_IB_REPEAT_INSISTED` (a repeat request that turns down, "no, I mean ...", the right question it
just got also passes with the question before that one, as Christy's insisted-repeat line offers it,
D2-IB1) and `REHEARSAL_SAME_TURN_FRAGMENTS` (a candidate row the session saved with no span while the
candidate's turn was still being said is part of that turn, not the next one, when a check looks for
the reply to it).

Diagnosis 4 switches (all default ON; `0` restores the previous behaviour):
`REHEARSAL_FLOW_DESIGN_RULES` (the flow judge reads the design rules fixed by policy and judges only
their wording and timing, the call facts say who ended the role-play and which graded families came
before the end, and evidence is asked only for axes below 5), `REHEARSAL_FLOW_NA_AXES` (a call with no
learner line scores learner_flow and objective_kept as null, left out of the means, minimums and the
axis floor), `REHEARSAL_ADVISOR_FAREWELL_LOOP` (after two mutual goodbyes in a row the simulated advisor
goes quiet; `advisor_farewell_loop` counts the advisor's goodbyes after the first mutual one),
`REHEARSAL_DIG_RELEASED` (a dig is engine-confirmed only when the gate had released that need by the
dig; `probe_unreleased` lists the rest), `REHEARSAL_OPEN_INVITE` (a deep reveal that answers "what's on
your mind?" is prompted), `REHEARSAL_REPEAT_IF_UNANSWERED` (a replayed repeat request is said only when
its question went unanswered), `REHEARSAL_CONTINUED_ROWS` (a candidate row saved without a span takes
the timing of its spoken turn, and a tail said over the brief joins that turn's row) and
`REHEARSAL_BACKCHANNEL_GAP` (after a replayed icebreaker backchannel the answer comes within 10 s).

Diagnosis 5 switches (all default ON; `0` restores the previous behaviour):
`REHEARSAL_FLOW_AGENDA_RULES` (the design rules also say the agenda's "about thirty minutes" for the
interview and "up to twenty" for the role-play are both right, and that Christy's one confirming ask on
an end request, her wrap-up offer and her early-end note are policy; OFF sends the round-5 rubric),
`REHEARSAL_FLOW_MIN_REPS` (the flow summary counts judged calls per scenario, and a live scenario judged
on one call is a readiness reason: run `--calls` at twice the scenario count or more) and
`REHEARSAL_NEXT_STEP_V2` ("pencil you in", "a weekend call", "a Tuesday or Friday call", "a quick
evening session with a mentor" and "catch up over the phone" are next-step asks that earn a commitment;
the qualifier is a closed list, so "a smart call", "another sales call", "your Monday meeting" and
"every morning session is recorded" are not).
`REHEARSAL_NEXT_STEP_PROCEED` (questions or offers to proceed count as next-step asks; OFF restores the previous vocabulary).

Two rounds scored by different rubrics are not comparable.  Judge saved records again, flow judge
only (no candidate, Christy or learner call; the records are not written), under the current rubric:

```
python -m rehearsal.rejudge C:\tmp\m032-sim-runs\int-live-4b C:\tmp\m032-sim-runs\int-live-5 --out <dir> --budget-usd 1
```

As in the run, only calls with rows and no error are judged (the others are carried over unjudged, so
before and after cover the same calls), a failed judge call or a tripped budget becomes an error verdict
and the rest go on, and `rejudge.json` / `rejudge.md` are rewritten after every record (`"partial":
true` until the last one), so a stop never loses the verdicts already paid for.

## Adaptability scenarios and the flow judge (`--scenarios adapt`, D-M032-10)

```
python -m rehearsal --full --offline --scenarios adapt --out <dir>                  # every adapt scenario, scripted
python -m rehearsal --full --scenarios tangent --out <dir> --budget-usd 0.30         # one live call, judged
python -m rehearsal --full --scenarios default+adapt --out <dir> --budget-usd 6      # default + adapt, live (41 calls)
```

The owner's goal is a bot with excellent conversational flow that adapts to every kind of
conversation while sticking to its objective. `rehearsal/adapt.py` adds fourteen named candidates
(group `adapt`; `default+adapt` is `default` plus `adapt`, the same as `--scenarios default,adapt`;
`default` and `all`, the 16 synthetic scenarios, are unchanged): `tangent`, `confused`,
`rambler`, `one-worder`, `hinglish`, `rude-not-abusive`, `interrupter`, `off-script-advisor`,
`manipulative-advisor`, `over-discounter`, `gives-up-midway`, `mid-roleplay-glitch`,
`argues-with-christy` and `late-ready`. Each is phase-aware: offline the talk is scripted (answer
banks, transforms of the scripted advisor's turns, word-for-word beats); live, DeepSeek plays the
candidate with the behaviour in its system prompt to Christy and as an overlay on the advisor, and
the beats are said word for word, so the behaviour always happens. Every candidate turn carries its
ground-truth `act` (new: `tangent`, `confused_question`, `interrupt`, `off_script`, `pressure`,
`discount_drop`, `glitch_check`, `glitch_lost`, `argue`) and `traits` (how it was said: `tangent`,
`ramble`, `one_word`, `hinglish`, `rude`, `interrupt` ...); the header's `ground_truth.adapt` names
the behaviour.

The interrupter cuts in while a generated bot reply is still playing (every third long learner
reply, Christy's second icebreaker reply), and its voice cuts that reply as R1's voice barge-in
does: once the voice has lasted the interruption `min_duration` (0.8 s, `r1_latency`; read at use)
the line stops, keeping the words played until then (`SdkDriver.speak(barge_in=True)`). A line
with less than that plus 0.4 s left is not cut in on (it would play to its end), and the advisor is
fed the part of the learner line played before the cut. At the `R1_INTERRUPT_MIN_WORDS` rollback
the voice cuts nothing and the committed turn does, as in production.

New per-phase check `ready_taken`: every spoken "ready" in the transition starts the role-play (the
learner picks up before the candidate speaks again). A "ready" Christy answers as a question, or
ignores, fails.

The flow judge (`rehearsal/flow_judge.py`, live only; offline it records `status: n/a`) reads the
whole transcript, the scenario's behaviour and the call's facts, and scores the BOT on six axes,
1 to 5: `christy_flow`, `learner_flow`, `adaptability`, `objective_kept`, `repetition`,
`naturalness`, with evidence quotes that must be in a CHRISTY or LEARNER line (a quote from a
candidate line or from no line is rejected, listed under `evidence_rejected`) and the worst moments
(turn, speaker, why). Per-call scores go to `results.jsonl` (`flow`), the means, minimums, gates and
worst moments to `scorecard.md` / `scorecard.json` (`flow`). Gates: naturalness mean >= 4.3,
adaptability mean >= 4.3, objective_kept minimum >= 4, and no call below 3 on any axis. A failed
gate or a call without a verdict keeps a live run from being ready, and `--strict` exits 5 on a
failed flow gate and on a live judged run where a call has no verdict (a judge error) or no call was
judged (`strict_failures`; offline `n/a` and `--no-judge` are not failures). The judge uses `--judge-model` (as the rubric judge); `--no-judge` turns both off.

## Not measured here

STT fragmentation and end-of-turn detection, barge-in, TTS and first-audio latency, the scenario card
and the live UI.

## Drift risks

`call.py` imports `Rig` from `tests/test_r1_integration.py`; if PR-B or PR-4c changes that rig, fix it
there first. The DeepSeek price constants in `llm.py` are estimates (S0-B), not the price list.

The `skilled-closer` scenario uses the explicit `closer` advisor level with discovery,
concern handling and an enrolment ask. Calibration to real move rates and scorecard
enrolment metrics are follow-up work.

`REHEARSAL_CLOSER_REASSURANCE=0` restores the previous closer guidance.
