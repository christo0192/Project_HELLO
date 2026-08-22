# Phone webhook ingress + reconciliation (P3)

Inbound **LiveKit** webhook ingress and dropped-webhook reconciliation for
outbound phone screening, over the 0042 substrate (P1) and the provider-neutral
domain core (P2).

This phase is **disabled by default** and performs **no dial, no SIP
origination, no provider mutation, no stage/scorecard/email write, and no
migration**. It adds the hardened ingress boundary, the translation from a
LiveKit event to a 0042 event, and a bounded recovery sweep. No scheduler is
armed — arming the sweep is P5's decision, exactly as the dial loop is.

## Components

| Concern | Module |
|---|---|
| Enablement gate (flag + credentials) | `integrations/livekit-phone/config.ts` |
| JWT / body-hash verification | `integrations/livekit-phone/verify.ts` |
| LiveKit event → 0042 event, subject resolution | `integrations/livekit-phone/events.ts` |
| Ingress choke point + R-4 counter | `integrations/livekit-phone/ingress.ts` |
| Dropped-webhook recovery sweep | `integrations/livekit-phone/reconciliation.ts` |
| Read-only ports + adapters | `integrations/livekit-phone/ports.ts`, `stores.ts` |
| HTTP route | `routes/phone-webhook.ts` → `POST /api/integrations/livekit-phone/webhook` |
| Substrate | `app/supabase/migrations/0042_phone_screening.sql` (unchanged) |

## Enablement (fail-closed, twice)

The route returns **503** and does nothing unless BOTH hold:

- `PHONE_SCREENING_ENABLED=true` — the P2 **master** switch
- `LIVEKIT_API_KEY` **and** `LIVEKIT_API_SECRET` are provisioned (non-empty,
  not a placeholder)

**No new environment variable and no new provider credential is introduced.**
The LiveKit pair already backs `AccessToken`, `RoomServiceClient` and
`EgressClient`, and is the same pair LiveKit signs webhooks with. The byte cap
and clock tolerance are P2's existing `PHONE_WEBHOOK_MAX_BYTES` (default 65536)
and `PHONE_WEBHOOK_TOLERANCE_SECONDS` (default 300).

The gate deliberately does **not** consult `PHONE_RUNTIME_ENABLED`. That flag
arms the dialer; a webhook is inbound. An operator who disarms the dialer
mid-incident must still be able to record terminating events for calls already
up, or those attempts hold fleet slots until their leases lapse.

Disabled ⇒ no verification, no database call, no network call, and no LiveKit
receiver is constructed. (The SDK itself is still present in the process —
`routes/invites.ts`, `lib/room-provisioning.ts` and `lib/recording-egress.ts`
import it statically. The lazy import in `verify.ts` exists so a static value
import there would not break the existing suites that partially mock the SDK.)

## Verification — this is NOT the Ashby algorithm

Ashby signs a bare `HMAC-SHA256(secret, rawBody)` in `Ashby-Signature`. LiveKit
does something different, and the two must not be conflated:

- header is **`Authorize`** (not `Authorization`)
- the value is a **JWT** signed with the api key/secret pair
- its **`sha256` claim** is the base64 digest of the request body
- issuer must equal the api key; expiry **and** not-before are checked with an
  **explicit clock tolerance**

> **The tolerance is a deliberate widening of the vendor default.** The SDK's
> own `TokenVerifier` default is **10 s**; `PHONE_WEBHOOK_TOLERANCE_SECONDS`
> defaults to **300 s** (bounded 30..3600). That accepts a webhook up to five
> minutes past its expiry, which is the trade for surviving ordinary clock skew
> and provider retry delay. Lower it if that window is not wanted; it is
> enforced in both directions and the issuer/signature checks are unaffected.

All three parts are performed by the SDK's `WebhookReceiver` behind an
injectable port. `skipAuth` is passed `false` literally at the single call
site, and a structural test fails if `true` ever appears.

Failure vocabulary, in check order — each fail-closed:

| Reason | HTTP |
|---|---|
| `not_configured` | 503 |
| `empty_body` | 400 |
| `body_too_large` | 413 |
| `body_not_utf8` | 400 |
| `missing_signature` | 401 |
| `invalid_signature` | 403 |

`body_not_utf8` exists because `receive()` takes a string. A lossy decode would
change the digest and surface as `invalid_signature` — indistinguishable from
an attack. The decode is proven to round-trip back to the identical bytes
first, so **raw-byte fidelity is asserted, not assumed**.

The raw body, the JWT and the credentials are never logged, stored, returned or
embedded in an error.

## Subject resolution — identity only, never a phone number

`admit_phone_attempt` writes `participant_identity = 'phone-' || <attempt
uuid>`, and 0042 constrains the column. The attempt is therefore recovered by
**parsing the identity**, never by a lookup keyed on anything a carrier chose.

> **Hazard:** LiveKit populates SIP participants with `sip.phoneNumber`,
> `sip.trunkPhoneNumber` and `sip.callID` **automatically**. A pass-through of
> `participant.attributes` would carry the subscriber's number into every log
> line, error and ledger row it touched.

So the attribute map is reduced to a **closed allowlist of exactly one key** —
`phone_epoch`, the fencing token — **at the trust boundary itself**, inside
`verify.ts`, before the envelope exists. The raw map does not survive
verification, so nothing downstream can read an unapproved attribute even by
reaching for `participantAttributes` directly. `events.ts` gates reads through
the same allowlist as a second layer. Both index the allowlist by exact key and
never enumerate the map, so an attribute a future SDK release adds is dropped
by default rather than admitted by it. The room-reader port likewise projects
each participant to its identity alone.

## Event mapping

Three LiveKit events carry a phone transition:

| LiveKit event | 0042 `event_type` |
|---|---|
| `participant_joined` | `sip.participant_joined` (0042 #14 — **join is not answer**) |
| `participant_left` | `sip.participant_left` |
| `participant_connection_aborted` | `sip.connection_aborted` |

Classification, disclosure and assessment events come from the in-room agent,
not from a webhook, and are deliberately absent.

This API receives the **same webhook stream as the browser interview rooms**. A
`track_published` in a candidate's browser session is a valid LiveKit event
that is accepted and ignored with **zero database work** — recording it would
fill the phone ledger with another feature's traffic.

## Response semantics

| Situation | HTTP | `status` / `error` |
|---|---|---|
| Applied | 200 | `applied` |
| Redelivery the RPC recognised | 200 | `duplicate` (no second row, no state change) |
| Stale / unknown / terminal / unexpected | 200 | `ignored_<reason>` (recorded) |
| LiveKit event for another feature | 200 | `ignored_not_phone` (no DB work) |
| Malformed ingress (no ledger row) | 200 | the refusal status, **counted** |
| Signed body, unknown event name | 400 | `unrecognized_event` (non-retryable) |
| Verdict unknown / store threw | 500 | `apply_unexpected_status` / `internal_error` |

**200 means the database reached a verdict** and any durable row it implies is
committed. **500 means we cannot say what happened**, so LiveKit should
redeliver — which is safe because the provider event id is deterministic.

A redelivery reports `duplicate` under **one rule, whatever the first verdict
was** — a re-applied event and a re-ignored event both say `duplicate`. The
original verdict is not lost: it is on the ledger row, which is the durable
place for it, rather than in an HTTP body sent to a provider that does not read
it. Reporting `duplicate` for one case and `ignored_<reason>` for the other
would be two rules where one will do.

### Durability before 2xx, and no second receipt layer

The Ashby ingress writes its own receipt row because 0029/0030 gave it one. The
phone lane gets **no second receipt table**: `phone_call_events` already *is*
the receipt — insert-once, `unique (source, provider_event_id)`, protected by
BEFORE UPDATE/DELETE triggers, and `apply_phone_event` writes the verdict and
the row in one transaction. A receipt layer in front of it could only disagree
with it.

`provider_event_id` prefers LiveKit's own event uuid (a redelivery repeats it).
When absent or outside 0042's character class, a deterministic synthetic id
`lk:<attempt>:<event_type>` is minted — nothing time-derived participates, so a
redelivery of the same transition collides rather than writing a second row.

## Mount and auth boundary

Mounted at `/api/integrations/livekit-phone` **before** the recruiter-auth
middleware and **before** the global `express.json` parser, and **after** the
global per-IP rate limiter — which still covers it. Rate-limit and CSP
behaviour are unchanged; no phone-specific exemption exists.

Only `POST /webhook` is declared on the router, so **the public surface is one
exact method-and-path pair, not the prefix**. Any other method or path under
the mount falls through to auth and is rejected. All other phone-related routes
remain authenticated.

## Reconciliation — dropped-webhook recovery

The failure: a call ends and the `participant_left` webhook never arrives, so
the attempt stays live holding one of the ten fleet slots for the rest of its
lease.

This is **not** an "engagement stranded forever" failure —
`reclaim_phone_attempt_leases` already restores the engagement from
`dialing`/`in_call` back to `prior_engagement_state` once the lease lapses, and
0042 says so in its own comment. What reclaim **cannot** do is decide the
**outcome**: it abandons the attempt with `outcome_class = null`, because a
lapsed lease means our worker died and it has no idea what happened on the
call. This sweep exists for the other case — the worker is **alive and holding
its lease**, and only the webhook was lost. LiveKit still knows, so we ask.

### The two sweepers must not overlap

Reclaim **charges no budget** ("a dead worker is our failure, not the
candidate's attempt"). The outcomes this sweep posts **do** charge
(`no_answer`, `reconnect`). If the sweep touched an attempt whose lease had
already expired, a crash of ours would spend a candidate's anti-harassment
budget — three would reach `abandoned_no_answer` for our own downtime.

So the due-attempt reader requires `lease_expires_at > now`. Expired and NULL
leases belong entirely to the reclaimer.

Bounds, all enforced rather than advertised:

- **age floor** derived from `PHONE_RING_TIMEOUT_SECONDS × 2`, clamped to
  60..900 s. Concluding "the leg never came up" before the ring timeout elapsed
  would manufacture a no-answer for a call that is still ringing. Derived, not
  configured, so it cannot drift below the thing it depends on.
- **lookback** default 6 h, clamped 900 s..24 h. Older attempts are the
  reclaimer's.
- **limit** default 25, clamped 1..50, and re-sliced after the read so a reader
  that ignores the limit cannot widen the sweep.

Conclusions — decided from the engagement state **and the attempt state**:

| Engagement state | Attempt state | Missing participant ⇒ |
|---|---|---|
| `in_call` | any live | `sip.participant_left` |
| `dialing` | `admitted`, `ringing` | `sip.originate_timeout` |
| `dialing` | `answered_unclassified`, `human`, `machine` | **nothing** — see below |
| anything else | any | nothing is posted |

**Why the attempt state is load-bearing.** `dialing` is an *engagement* state
and it outlives the answer: 0042 #14 ("join is not answer") moves the *attempt*
to `answered_unclassified` and the engagement nowhere, and `classify.human`
moves the attempt to `human`, again with no engagement change. Deciding from
the engagement state alone would report a call the candidate demonstrably
picked up as `sip.originate_timeout` → `outcome_class = 'no_answer'`, charge
the anti-harassment budget for it, and re-dial them the next IST day on the
strength of it.

Safety properties:

- **Unknown is not absent.** A failed room read is skipped and counted, never
  read as "the participant left". One unreachable room cannot abort the sweep.
- **Idempotent.** Each post carries `recon:<attempt>:<event_type>:<epoch>`, so a
  repeat sweep collides on `uq_phone_call_events_provider` and reads back the
  first verdict.
- **Epoch-fenced.** The epoch is in the id *and* passed as the fencing token, so
  a sweep racing a new conversation is recorded `stale_epoch`, not applied to
  the wrong call.
- **Cannot dial.** Neither port exposes an originate, transfer, remove, delete
  or room-mutation method. The only write is `apply_phone_event`.
- **Disabled ⇒ zero work.** No read, no post, no network call.

## P1 residuals carried by this phase

### R-4 — refusals that write no ledger row (**handled**)

`apply_phone_event` answers five statuses **before** its INSERT:
`attempt_required`, `invalid_source`, `invalid_event_type`,
`provider_event_id_required`, `invalid_provider_event_id`. That is deliberate —
a malformed call is not an event that happened, and recording it would let an
engagement-scoped post drive an attempt-scoped edge, the exact half-applied
transition 0042's guard prevents.

The consequence is that **`phone_backlog` cannot see them**: it counts ledger
rows, and there is no row. A persistently malformed poster would be invisible.

So the count lives at the shared ingress choke point that both the route and
the reconciliation sweep pass through:

- each occurrence emits one `warn` with
  `error_category: "phone_ingress_unrecorded"` and `error_type: <status>` —
  **this is the countable surface today**
- `phoneIngressHealth.snapshot()` exposes the in-process totals for a health
  route to read later

It is deliberately **not** a second database write: R-4's whole point is that
no partial engagement write may happen.

> Nothing the *route* can send produces `attempt_required` — a resolved
> participant identity always yields an attempt id. The counter is scoped to
> the choke point, not to the route, so every future poster is covered.

**Operator action on a non-zero count:** the poster is malformed, not the
transport. Do not retry — a redelivery would be malformed again. Identify the
caller from the correlation id and fix the call shape.

### R-3 — `hr.cancelled` with no attempt id (**documented; unchanged**)

`hr.cancelled`, `emergency.stop`, `ashby.stage_left` and `prereq.lost` apply
from any non-terminal state. Their attempt-side edge is guarded by
`v_att.id is not null`, so a post carrying **only** an engagement id moves the
engagement to `cancelled` and leaves a **live attempt running**. It does not
trip `attempt_required`, because no attempt-scoped edge was selected.

This is **not reachable from this route**: these are HR actions, not LiveKit
events, and none of them appears in the event map. It is recorded here because
P3 owns the route contract and this is where the rule belongs:

> **Any caller posting a cancel-family event MUST pass the live attempt id when
> one exists.**

Current blast radius if that rule is broken: the engagement is correctly
terminal throughout, and the reclaimer abandons the orphaned attempt and
completes its job when the lease lapses (≤ 900 s). It self-heals; it is not
silent. Narrowing this properly needs a guarded RPC and belongs with the
HR-cancel path, not here.

### New residual — the pre-disclosure hangup window (P3-1)

A candidate who answers and hangs up **before `disclosure.delivered`** leaves
the engagement in `dialing` with the attempt in `answered_unclassified` or
`human`. 0042 has **no legal edge** for that:

- via the webhook, `participant_left` maps to `sip.participant_left`, which is
  legal only from `in_call`; posted from `dialing` it is recorded as
  `unexpected_event` (200, ledger row written, no state change)
- via the sweep, nothing is posted, because the only `dialing` edge available
  (`sip.originate_timeout`) would be a false `no_answer` — see above

**Current behaviour:** the attempt is abandoned by the reclaimer when its lease
lapses (≤ 900 s), `outcome_class` stays null, and **nobody is charged**. The
engagement returns to `prior_engagement_state` and is re-dialable the next IST
day under the per-day index.

That is safe and self-healing, but the outcome is *unrecorded* rather than
*classified*. Closing it properly needs a new
"answered-then-dropped-before-disclosure" edge in a later migration, which this
phase is not allowed to add. Until then the window shows up as
`unexpected_event` counts in `phone_backlog` for engagements in `dialing`.

### R-2 (provider-error deferral breadth) and R-5 (digest asymmetry)

Untouched. R-2 remains P5's; R-5 belongs to the resume-number lane and this
phase computes no digest and reads no number.

## What this phase does NOT do

- No migration. 0042 is unchanged.
- No dialer, no SIP originate, no outbound call of any kind.
- No scheduler, worker, loop or timer — the reconciliation sweep has no caller.
- No voice or web change.
- No stage move, scorecard, email or Ashby mutation.
- No new environment variable, credential or provider.
