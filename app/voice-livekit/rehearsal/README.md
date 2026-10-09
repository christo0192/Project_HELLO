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
  session), so the schedule, the 9:00 close window, the time cue and the 13:00 stall all happen.
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
  before 13:00).

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

## Not measured here

STT fragmentation and end-of-turn detection, TTS and first-audio latency, the interviewer phases (dead
air, double goodbye, the name fallback, the wrap-up wording: `metrics.interviewer_metrics` runs on real
exports and on a full-flow tier that does not exist yet), the scenario card and the live UI.

## Drift risks

`call.py` imports `Rig` from `tests/test_r1_integration.py`; if PR-B or PR-4c changes that rig, fix it
there first. The DeepSeek price constants in `llm.py` are estimates (S0-B), not the price list.
