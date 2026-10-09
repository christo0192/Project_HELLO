# Runbook: phone STT shadow (M015 PR-1)

**Status: OFF by default (`PHONE_STT_SHADOW = "off"` in `fly.phone.toml`).** Nothing changes for a
call until an operator sets the switch to `on`.

Companion: `.gsd/milestones/M015/STREAMING-STT-RESEARCH.md` (why), `.gsd/milestones/M015/slices/S01/S01-PLAN.md` (how).

---

## 1. What it is, and what it never does

Today the phone bot hears only complete sentences: the main Sarvam STT (`saaras:v3`) is finals-only, so
barge-in fires about 1 s after the candidate stops. Sarvam now offers a Realtime API with live partial
words. Before changing anything, PR-1 measures it **next to** the main STT.

With the switch on, **after consent only**, the candidate's inbound audio frames (the same frames the main
STT gets, after RNNoise) are also sent to a second Sarvam socket (`wss://api.sarvam.ai/speech-to-text-realtime/ws`,
model `saaras:v3-realtime` by default). The worker logs **numbers only**, as `phone_stt_shadow` lines.

It never:

- logs, stores or forwards transcript text (text becomes a word count the moment it is parsed; no Sarvam
  `message`, close reason or `request_id` is logged either);
- feeds anything to the agent, the LLM, turn detection, interruption, the transcripts DB, scoring or the
  recording; the bot behaves byte-identically on or off (pinned by tests);
- blocks or delays the call: the audio path is synchronous, the frame queue is bounded (256) and drops when
  full, every shadow error is swallowed and logged once, and the socket is closed at call end.

One connection per call, no reconnect. A socket death ends the shadow for that call and counts as an
"unrecovered socket death" (gate G6).

## 2. Cost

About **INR 0.50 per post-consent minute** while on (Sarvam: INR 30/hour for all STT modes). It is zero
when off, zero for calls that never reach consent, and zero for calls sampled out
(`PHONE_STT_SHADOW_SAMPLE`).

## 3. Owner pre-checks (before the first call)

1. **Realtime is enabled for the Sarvam account.** A `close_4000` on the first call means it is not
   (4000 = application rejection: beta/account not enabled, invalid model/language/parameter).
2. **The account's concurrency and rate limit.** The shadow uses the **same `SARVAM_API_KEY`** as the live
   STT and TTS (no new secret). If the account has a concurrency or rate cap, the shadow socket can push the
   *live* STT into `1003` / 429. Check the limit first, keep the shadow on only for the 5-10 test calls (or use
   `PHONE_STT_SHADOW_SAMPLE`), and turn it off at the first sign of a main-STT provider error (section 9).

## 4. Turn on

```
fly secrets set PHONE_STT_SHADOW=on -a project-hello-phone-voice
```

Optional: `PHONE_STT_SHADOW_SAMPLE=0.5` (fraction of calls, 0-1; an invalid value fails closed to 0),
`PHONE_STT_SHADOW_MODEL=saaras:v4`. Tuning defaults (pinned in `fly.phone.toml`): sample rate 16000,
stream type `fast`, VAD threshold 0.5, silence 700 ms (keeps today's segment length).

**`fly secrets set` restarts the machines.** Do it only when no call is live: voice changes after
21:00 IST, and ping the phone session first. Alternatively `fly secrets set ... --stage` and let the next
deploy apply it. A Fly secret of the same name shadows the `[env]` line in `fly.phone.toml`.

## 5. First-call check, in order

Search the call's logs for `error_type=phone_stt_shadow` (the `correlationId` ties the lines to one call):

1. `config` (at build), then `armed` (first frame after consent), then `socket_open` and `session_begin`.
2. `seg_*` lines while the candidate talks (about 5 per segment).
3. `call_summary` at the end (one line per counter).

| Red flag | Meaning | Action |
|---|---|---|
| `connect_failed` (`schema` timeout / handshake / connector; `http_status`) | cannot reach or authenticate | check key, network; leave off |
| `socket_closed` `close_4000` | Realtime not enabled / bad model, language or parameter | owner check with Sarvam |
| `socket_closed` `close_1003` | quota or invalid key | **turn off now**, check main STT |
| `socket_closed` `close_1008` | inactivity / max duration | note the session length; report |
| `socket_closed` `close_1011` | Sarvam server error | report; retry once |
| `send_stalled` | a send took over 2 s; the shadow stopped | report |
| `frames_dropped` | the queue overflowed (socket too slow) | report; check CPU |
| `session_begin` present, `chunks_sent` > 0 in `call_summary`, but `rt_partials` = 0 | the audio wire format is probably wrong (we send JSON base64 `audio_input` per the docs; upstream LiveKit sends raw binary frames) | stop; tell the dev (one constant, `_AUDIO_WIRE`) |
| `shadow_failed` | an internal error (class name only, per phase) | report |

## 6. Log lines (all `error_type=phone_stt_shadow`, key `error_category`)

Only allowlisted keys appear: `schema`, `phase`, `model`, `duration_sec`, `option_count`, `turn_index`,
`http_status`. Times are offsets (seconds) from the segment's local VAD start. Counts are word counts or counters.

| `error_category` | Fields | Meaning |
|---|---|---|
| `disabled` | `schema` = `no_key` / `sample_invalid` / `build_failed` | not created (off is silent) |
| `sampled_out` | `duration_sec` = sample | this call is not shadowed |
| `config` | `model`, `schema` stream type, `option_count` sample rate, `duration_sec` VAD threshold, `turn_index` silence ms | settings in force |
| `armed` | | first post-consent frame |
| `socket_open` / `session_begin` | `duration_sec` | connect time / time to `session.begin` |
| `socket_error` | `schema` code, `phase` fatal/nonfatal, `http_status` | a Sarvam `error` event (first 5 non-fatal) |
| `socket_closed` | `schema` `close_<code>`, `phase` expected/unexpected, `duration_sec` session length | |
| `session_end` | `duration_sec` | billed audio seconds |
| `seg_partial_lead` | `turn_index`, `duration_sec` | first partial word after VAD start |
| `seg_three_word` | `turn_index`, `duration_sec` | 3rd partial word after VAD start |
| `seg_legacy_final` | `turn_index`, `duration_sec`, `option_count` | main STT final time / words |
| `seg_rt_final` | `turn_index`, `duration_sec`, `option_count` | realtime final time / words |
| `seg_summary` | `turn_index`, `schema` class, `option_count` max partial words, `phase`, `duration_sec` | one per segment; class is `both`, `noise_partial`, `rt_missed` or `silent` |
| `call_summary` | `schema` counter, `option_count` | counters: segments, silence_partials, rt_partials, rt_finals, main_finals, orphan_*, frames_*, chunks_sent, errors_nonfatal, unrecovered_death |

## 7. Analyse

Run 5-10 owner test calls (include deliberate fan, TV and second-speaker noise), then, promptly (Fly's log
buffer is short):

```
fly logs -a project-hello-phone-voice --no-tail > shadow-YYYYMMDD.log
python app/voice-livekit/tools/stt_shadow_report.py shadow-YYYYMMDD.log
```

(`--json` for machine output; also accepts `fly logs --json` files; `--min-calls` / `--min-segments` change
the sample floor.) The report prints a per-call table, the G1-G6 values with PASS/FAIL, and a verdict.

**Go criteria for PR-2** (research section 5):

| # | Criterion | Pass |
|---|---|---|
| G1 | median first-partial lead after VAD start | <= 0.6 s |
| G2 | median 3rd-word saving (legacy final time minus 3rd-word time) | >= 0.8 s |
| G3 | noise partials / non-silent segments | <= 5 % |
| G4 | false 3-word (a 3rd partial word but the legacy final has < 3 words) / non-silent | <= 5 % |
| G5 | final word counts agree (+-1 word or +-20 %) | >= 90 % |
| G6 | unrecovered socket deaths | 0 |

**GO** needs G1-G6 all passing **and** at least 5 calls with at least 100 non-silent segments; otherwise
NO-GO (failing criteria named) or INSUFFICIENT DATA. The owner decides PR-2 on these numbers. Record the log
file name, the report output and the verdict in `.gsd/milestones/M015/` as evidence (numbers only; the logs hold
no text).

## 8. Turn off (rollback)

```
fly secrets unset PHONE_STT_SHADOW -a project-hello-phone-voice
```

The pinned `off` in `fly.phone.toml` applies again. Same restart warning as section 4. Unset any other
`PHONE_STT_SHADOW_*` secret you set.

## 9. Kill criteria: turn off at once

- any main-STT provider error, or `1003` / 429 on the live STT while the shadow is on;
- worker CPU alarms;
- any reported difference in bot behaviour.
