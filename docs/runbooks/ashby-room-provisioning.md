# Runbook — just-in-time LiveKit room provisioning for Ashby-materialized sessions

Scope: `POST /api/livekit/exchange`, `POST /api/livekit/start`, and the shared
provisioner `app/api/src/lib/room-provisioning.ts`.

## The defect this closes

`materializeCandidate` (Ashby runtime) creates exactly **one** `call_sessions`
row in `status = created` with `external_call_id = NULL`. Nothing then
provisioned a LiveKit room for that **existing** session:

* `POST /api/livekit/start` provisions a room, but only for a session it
  creates itself — using it would have produced a second, rebound session.
* `POST /api/livekit/exchange` accepted only `waiting`/`in_progress` **and** a
  non-null `external_call_id`.

Net effect on the live canary: Mission Control minted a valid manual invite, the
candidate opened it, and every exchange returned the stable
`invite_token_invalid_or_expired` 404. Every Ashby invite was unexchangeable.

## What now happens

`lib/room-provisioning.ts` is the single implementation of "give this
already-existing `created` session a room". Both routes call it:

| Caller | Mode | On provider failure | On lost `created → waiting` CAS |
| --- | --- | --- | --- |
| `POST /api/livekit/start` | `new_session` | delete room, transition row to `failed` / `room_create_error` | delete the orphan room, 409 / reconciliation error |
| `POST /api/livekit/exchange` | `existing_session` | leave the row in `created`, **never delete the room**, 503 | **adopt** the winner's identical room; never delete it |

Exchange gate order (unchanged gates, one new step):

1. invite exists / not expired / not consumed / not revoked
2. maintenance (fail-closed on DB read failure)
3. consent (latest record, active Legal template, all required types)
4. session joinability
5. **NEW — just-in-time provisioning when `status = created`**
6. one-time invite consume (atomic CAS)
7. candidate access grant + short-TTL LiveKit JWT

Provisioning sits **after** every gate and **before** the consume, so a
provisioning failure always leaves the invite reusable and mints no grant and no
JWT. A session already `waiting`/`in_progress` takes the old path and makes
**zero** provider calls.

### Why the room starts at join time, not at invite time

The invite link lives for 24 h; the LiveKit room's `emptyTimeout` is 10 minutes.
Provisioning at mint time would have burned the room long before the candidate
clicked. JIT provisioning means room + authoritative egress start seconds before
the candidate connects, which is also what makes `emptyTimeout` meaningful.

### Recording integrity

`startAuthoritativeRecording` runs **inside** the provisioner, before the
`created → waiting` CAS. If it throws — or reports `started` without an egress
id — provisioning fails and the exchange returns `503
screening_room_unavailable` without consuming the invite. **A grant token and a
LiveKit JWT are only ever minted for a session whose authoritative recording
started.** The enabled / required / browser-fallback policy itself is unchanged
and still owned by `lib/recording-egress.ts`: when egress is disabled and not
required, provisioning proceeds and the documented browser-fallback rules apply
exactly as on the `/start` path.

### Concurrency

The room name is deterministic (`screening-<session_id>`), so two concurrent
exchanges converge on the same room.

* Second `createRoom` fails (room exists) → `updateRoomMetadata` converges the
  metadata instead of failing.
* Second `startAuthoritativeRecording` short-circuits on the already-linked
  `recording_egress_id`, and links its own with an `is null` CAS — never two
  egresses for one session.
* The loser of the `created → waiting` CAS re-reads the row; if it is now
  `waiting`/`in_progress` **on the same room**, the loser adopts it.
* Exactly one request wins the invite-consume CAS; the other gets the stable
  404 with no grant and no JWT.
* **`existing_session` mode issues no `deleteRoom` call on any path.** This is
  the property that makes "a failing request never damages a succeeding one"
  true by construction — see below.

### Why a provider failure neither terminates the session nor deletes the room

Moving the row to `failed` would convert a transient LiveKit/storage blip into a
permanently dead screening — the invite would stay unconsumed but could never
succeed again, and the loud failure would become a silent one. `existing_session`
mode therefore leaves the row in `created`.

It also never deletes the room. An earlier revision tried to reap a room it
believed nobody owned, by reading `(status, recording_egress_id)` and then
deleting. **That proof is not atomic**: between the read and the delete, a
concurrent request can start its egress, win the `recording_egress_id is null`
link CAS, win the `created → waiting` CAS and return a grant + LiveKit JWT. The
reap would then delete a live room. With LiveKit's default `room.auto_create`
that candidate joins a fresh, **egress-free** room — an unrecorded screening
that the detection query below cannot see, because the row still carries the
now-orphaned egress id. (With `auto_create` disabled it is instead an
unexplained hard join failure.)

Ownership is not decidable from outside a transaction, so the mode simply does
not delete. The cost is at most one empty room living out its 10-minute
`emptyTimeout`; nobody can join a room for which no token was ever minted, and a
retry converges on the same room. Regression-pinned by the interleaving test in
`ashby-room-provisioning.test.ts` (`B-1 regression`), which fails if a
read-then-delete probe is ever reintroduced.

## Security

* Authorization for provisioning is the candidate's **valid invite + valid
  consent record**. There is no recruiter auth on this route, and none is
  introduced.
* Room metadata is `{session_id, room_name, correlation_id}` only — no candidate
  name/email/phone, resume facts, JD/role focus, screening template,
  transcript/scoring context, provider secrets, or tokens.
* The LiveKit JWT is unchanged: one room, `roomJoin` only, no admin/create
  rights, 5-minute TTL, identity derived from truncated ids.
* No token, grant, or signed URL is logged or cached anywhere on this path.
* Response-shape disclosure: reaching the 503 requires an invite that is
  already valid, unconsumed, unexpired **and** backed by a valid consent
  record — the same bar the pre-existing `409 consent_required` response
  already sits behind, and it only occurs during a genuine provider outage.
  Everything else (unknown / expired / revoked / consumed token, non-joinable
  session) stays on the single stable `invite_token_invalid_or_expired` 404.

## Quota / capacity — decision and residual

**Decision: exchange-time provisioning does NOT reserve a quota slot.**

* Quota is reserved at *session creation* on `POST /api/livekit/start`
  (`reserveQuota` before `createSession`, commit on success, release on
  failure). Exchange does not create a session.
* Reserving at exchange time would fail a candidate's click with `409
  quota_exceeded` **after** HR already promised and scheduled the interview, and
  would double-count once materialization starts reserving.
* Maintenance mode and the fail-closed backpressure it provides are **not**
  bypassed — the maintenance gate still runs before provisioning and still
  blocks new joins with a 503.

**Residual (documented, not silently bypassed):** Ashby materialization does not
reserve quota today, so Ashby-originated sessions are outside launch-capacity
accounting. The correct fix is to reserve at materialization time (where a
`quota_exceeded` verdict can be surfaced to HR in Mission Control before an
invite is sent), not at candidate join time. Until that lands, treat the Ashby
lane's volume as un-metered when sizing launch capacity.

## Operating

### Symptom → cause

| Symptom | Likely cause | Action |
| --- | --- | --- |
| Candidate sees "We could not open your screening room just now…" | 503 `screening_room_unavailable` — LiveKit or egress S3 unreachable | Check LiveKit reachability and `RECORDING_EGRESS_S3_*`. The invite is still valid; the candidate can retry. |
| Candidate sees the stable "invite is missing, expired, revoked, or already used" on a fresh Ashby invite | Session is terminal, or a concurrent actor moved it | Inspect `call_sessions.status` / `terminal_reason` for the invite's `session_id`. A terminal row needs a new session + invite, not a retry. |
| Room exists in LiveKit but session is still `created` | Provisioning aborted after room create, before/at egress | Expected and harmless: the room self-reaps at `emptyTimeout` (10 min) and no token was minted. A retry converges on the same room. This is the deliberate cost of never deleting — do not add a cleanup that deletes rooms on this path. |
| Two rooms for one session | Should be impossible — the room name is derived from the session id | Escalate; indicates the deterministic naming was bypassed. |

### Verification queries

```sql
-- Ashby-materialized sessions that are still unprovisioned.
select id, status, external_call_id, created_at
from screening_v2.call_sessions
where status = 'created' and external_call_id is null
order by created_at desc
limit 50;

-- Sessions published as joinable but with no authoritative egress linked.
select id, status, external_call_id, recording_egress_id, recording_egress_status
from screening_v2.call_sessions
where status in ('waiting','in_progress') and recording_egress_id is null
order by waiting_at desc
limit 50;
```

The second query should stay empty whenever egress is enabled. A row there means
a session became joinable without authoritative recording — investigate before
letting the candidate join.

### Rollback

The change is additive on the exchange path. Reverting the commit restores the
previous behavior (`created` sessions rejected with the stable 404) and removes
the JIT provisioning; `/start` behavior is byte-for-byte equivalent before and
after the refactor. No migration and no schema change is involved.
