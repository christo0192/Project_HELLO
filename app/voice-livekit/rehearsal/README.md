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
5. Guard hits per call are a gate (mean <= 1, every category) and `scorecard.md` lists them for every
   call ("Guard hits per call", plus the invented-fact share). The reworded reaction prompts of R1-Q
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
