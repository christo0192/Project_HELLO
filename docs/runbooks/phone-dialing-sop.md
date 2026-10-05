# Phone screening — dialing SOP (as built)

> **Source of truth:** derived on 2026-10-05 from code on `main` (`eec54af`) and the
> **live production database** (migration 0114 applied; all 20 phone functions verified
> byte-identical to their latest migration). Not derived from older design docs, several
> of which are stale. Re-derive after any phone migration or dialer change.
>
> Every rule cites where it lives so it can be re-checked. "Verified live" means the
> behaviour was observed in production attempts on 2026-10-05.

## 1. When calls go out

| Rule | Value | Source |
|---|---|---|
| Calling window | A call may **start** 09:00–21:00 IST (end exclusive). A call in progress may run past 21:00. | `phone_ist_window_open_at/close_at`, `phone_ist_window_open` (0111); TS mirror `ist-window.ts` |
| Days | **Every day**, including Saturday/Sunday. There is **no weekend or holiday rule.** | none exists (`ist-window.ts`, `slots.ts`, 0042) |
| Temporary 24×7 window | Expired 2026-09-09 (owner test night 2026-09-30 also expired) | `phone_temporary_247_until()` (0092, 0111) |
| Operator halt | Stops all new dials. Reasons by severity: `operator_pause` < `cost_control` < `provider_incident` < `legal_hold` < `emergency_stop`; a halt can only be escalated, never downgraded. Clearing requires a named actor. | `set_phone_halt` / `clear_phone_halt` (0114) |
| Test call while halted | Only under `operator_pause`, one armed candidate, gate expires in ≤ 15 min | `arm_phone_test_gate` (0081), `admit_phone_test_attempt` (0063) |

## 2. Volume limits

| Limit | Value | Source |
|---|---|---|
| Concurrent calls (fleet) | **10** | `phone_max_concurrent()` |
| New dials per day (fleet) | **50** (first attempts + same-day retries; scheduled callbacks are counted but never refused; reconnects not counted) | `phone_max_daily_dials()`, `admit_phone_attempt` (0114) |
| Dials per candidate engagement per IST day | **2** (`ist_day_seq` 1–2, DB CHECK + unique index) | `admit_phone_attempt` (0114), 0095 |
| Gap between the 2 same-day dials | **5 hours** from the first dial's admission | `phone_same_day_retry_delay()` (0095). Verified live: 11:46 → 16:46 |
| Same phone number across two applications | One first/retry dial per number per day | Guard B in `admit_phone_attempt` (0114) |
| Dialer cadence | Due loop every ~7.5–15 s; candidates offered oldest-first (`updated_at`), one per candidate and per phone line per pass | `due-loop.ts`, `read.ts`, `phone-runtime/config.ts` |

## 3. Candidate does not pick up — the "lost" rule

**Counted as a miss** (`no_answer_attempts + 1`): **no answer, busy, voicemail**.

**When the count reaches the limit (default 3)** the engagement becomes terminal
**`abandoned_no_answer`** (shown on the dashboard as "Abandoned: no answer") and dialing stops.
Source: `apply_phone_event` (0114), `phone_engagements.no_answer_limit` default 3 (0057).

Typical timeline, first dial at 10:00:

| When | Dial | Result | Count |
|---|---|---|---|
| Day 1 10:00 | 1 | no answer | 1/3 → `awaiting_retry` |
| Day 1 15:00 | 2 (5 h later) | no answer | 2/3 → `awaiting_retry` |
| Day 2 09:00 | 3 (day roll) | no answer | 3/3 → **`abandoned_no_answer`** |

- A first dial after ~16:00 cannot get its 5-hour retry the same day (window closes), so day 1 gets
  one dial and day 2 gets 09:00 + 14:00. **Either way a non-responder is lost within 2 IST days and 3 counted dials.**
- Being marked lost changes **nothing in Ashby** (no stage move, no note). Only our UI label changes.
- **Restart:** HR rescreen (`request_phone_rescreen`) creates a new cycle with a limit of **1**; at most
  cycle 3 exists → lifetime maximum **5** counted misses. "Call now" cannot revive a terminal cycle.

**NOT counted** (the candidate's limit does not move):

| Event | Why | Next dial |
|---|---|---|
| Our infrastructure deferred the dial (`infra_deferred`) | Phone never rang | +5 min backoff |
| Lease reclaimed (attempt `abandoned`, no reason) | Treated as a system fault (phone did ring) | +5 h, or next day 09:00 |
| Provider/transport failure | Separate provider budget (5) | Next day 09:00 |
| **Picked up, then hung up before the disclosure** (`abandoned_pre_disclosure`) | By design, no cap | Next day 09:00 |
| "Not available / call later" at the identity question | Callback deferral | Next day 09:00 |

## 4. Candidate picks up

### Opening (`phone.py` gate)
1. Answer = SIP status becomes active (not merely "joined"); up to 60 s ring wait.
2. Identity: "Hi, this is Christy… Am I speaking to {first name}?" (does **not** say why it is calling).
   Unclear/silence → continue (fail-open). Wrong person twice → wrong-number line, next day, recording discarded, **number not blocked**.
3. Disclosure + consent: "This call is recorded so the hiring team can review it. Is it okay to continue?"
   Opening is capped at 116 s after answer.

| Candidate response at the consent question | Result |
|---|---|
| Yes / okay / sure / haan / theek hai … | Interview starts (`in_call`) |
| "No", "not interested", "don't record" | **Permanent opt-out**: `opted_out` + number suppressed for all future applications (no confirmation question) |
| Wrong number | `wrong_number` + number suppressed |
| "Call me back", "busy", "who is this" | Re-ask once; never treated as consent |
| Unclear / silent twice, or voicemail phrases | Treated as **voicemail** → counts as 1 miss |
| Hangs up | `abandoned_pre_disclosure` → next day, not counted |

### During the interview
| Event | Result |
|---|---|
| "Stop calling", "withdraw my application" | Ends call, `opted_out`, number suppressed, nothing scored |
| "I'm not interested in this role" | One stop-or-continue question; stop → opt-out |
| Call drops | Reconnect after 120 s, up to **3** reconnects; after 21:00 → system appointment at next 09:00 |
| Silence | "Are you still there?" at 30 s, second prompt at +20 s, ends at ~+8 s more; not scored |
| "Call me back" | Bot books a 15-min slot **tomorrow or later**, 09:00–21:00, ≤ 2 alternatives offered; 3rd failed deferral → `failed` |
| Callback slot unanswered | Counts as a miss (normal ladder) |
| Maximum call length | 60 min (`SESSION_MAX_RESIDENCY_SEC`) |

### Scoring and Ashby
- Complete call → scored. Partial call → scored only if **≥ 75 %** of planned questions were answered; otherwise human review.
- Recommendation: **≥ 65 advance, ≥ 45 hold, < 45 reject.**
- Only a **scorecard** is written to Ashby. No stage move, no auto-reject, no email.
- Recording starts at answer and is kept even without consent (0105), except wrong number / identity mismatch.

## 5. Known gaps (2026-10-05)

1. **"Don't call me again" said at the consent question is ignored**: the bot says it will pass it on, but no suppression is written and the candidate is redialed. Compliance risk.
2. **Pick-up-then-hang-up before disclosure is never counted** and has no cap: such a candidate can be called every day indefinitely.
3. **"Call me back" twice at the consent question is charged as voicemail.**
4. **The opening does not say why the bot is calling.** On 2026-10-05, 5/5 answered calls hung up during the opening (11–34 s).
5. **Mid-call reconnect has never succeeded live** (0/2); partial finalization (180 s) can race the reconnect (120 s backoff).
6. A non-responder is lost within **2** days, while code comments assume 3.
7. `next_eligible_at` on `awaiting_retry` rows can be stale; sweeps key off `last_attempt_at`. Do not report from it.
8. Lease-reclaimed attempts (the double-ring bug fixed in #326) rang the candidate but are not counted; several candidates have 3–6 real rings with 0–2 counted.

## 6. Reporting cautions

- "Answered" counts before 2026-10-04 are inflated (ringing was recorded as answered, fixed in #328).
- 2026-10-02 had zero dials (no_session bug, fixed in #326). 2026-10-04 had zero real dials (agent-join barrier outage, fixed in #332).
- Use **consent given** as the true pickup measure for 2026-10-01 to 2026-10-03.

## 7. Dashboard (from PR "dashboard dial status, call recordings, candidate search")

- **Status column:** a queued candidate who has been dialed reads **"Queued (dialed N)"**, where N counts
  every call that reached the phone across all cycles (lease-reclaimed legs and reconnects included;
  infra deferrals, provider errors and calls cancelled before ringing excluded). This is NOT the
  per-cycle no-answer counter in section 3. Finished phone outcomes show their own label instead,
  e.g. **"Abandoned: no answer"**, "Opted out", "Wrong number".
- **Call recordings:** every answered call with a ready recording can be played on the candidate page,
  including calls that ended before consent (tagged "Recorded before consent"). Each playback mints a
  short-lived link and is audited; quarantined or deleted recordings are never playable.
- **Search:** the Candidates page search matches name and email (and phone digits for users allowed
  to see phone numbers), and is kept in the URL as `?q=`.
