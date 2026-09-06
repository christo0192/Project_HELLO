# Phone worker orchestration — activation runbook (Plan B)

On-demand Fly worker orchestration ("Plan B") scales the phone (and browser)
LiveKit-Agents worker pools **to zero** and brings a machine up **just-in-time**
for one session, then releases it when the call ends. This runbook is the
end-to-end sequence to activate it **safely** on the phone lane.

> **State when this runbook was written.** All machinery is merged and
> **flag-gated OFF** (`WORKER_ORCHESTRATION=false`). Deploying the code changes
> nothing. Activation is the ops sequence below. Nothing here is auto-applied;
> flipping the flag is a deliberate operator step (this PR does **not** flip any
> flag — `fly.phone.toml` is untouched).

---

## 0. The three flags, and the partial-activation hazards

Three independent switches gate the feature. Getting them **out of step** is the
main hazard, so understand the matrix before touching anything.

| Flag | Where | Effect |
|---|---|---|
| `WORKER_ORCHESTRATION` | **API** app secret (`project-hello-api`) | Arms the API side: the dial gate (`ensureReadyWorker` before dispatch), the terminal-release + reaper loops, and all Fly calls. Default `false`. |
| `WORKER_ORCHESTRATION` | **worker** fly-config (`fly.phone.toml`) | Tells the deploy-gate the worker app runs scale-to-zero, and flips the worker's deploy posture (`start→verify→deploy→stop`). |
| pool + `FLY_API_TOKEN` | Fly + API secret | The pre-created STOPPED machines and the token to start/stop them. |

**Partial-activation failure modes — do NOT leave the system in these:**

- **API on + worker off (always-on worker):** the API claims/starts/stops
  machines that are *already running*, so every dial churns Fly start/stop
  against a machine that never needed it — a **refusal storm with Fly churn** and
  no benefit. The deploy-gate posture check
  (`validate-voice-worker-apps.mjs`) rejects ALWAYS_ON + orchestration-on, but do
  not rely on it as your only guard.
- **API on + empty pool:** `claim_voice_worker` returns `no_capacity` for every
  session, so the dial gate defers every call with `worker_not_ready`. Because a
  `worker_not_ready` defer is now **same-IST-day retryable** (see §4), the
  engagement is not wedged — but every candidate silently fails to be called.
  This is **silent outage**. Provision the pool *before* flipping the API flag.
- **API off + worker scale-to-zero:** the worker pool is at zero but nothing ever
  starts a machine, so no call is ever answered. Keep the worker **always-on**
  until the same moment you flip the API flag on. The posture check rejects
  scale-to-zero + orchestration-off.

**Rule:** provision the pool and set the token first; flip the API flag and the
worker fly-config flag together (worker deploy first, then API secret); verify;
keep them in step.

---

## 1. Secrets

On `project-hello-api` (the API app):

```bash
# App/org-scoped Fly deploy token — the Machines API bearer. Never commit it.
fly secrets set FLY_API_TOKEN="$(fly tokens create deploy -a project-hello-phone-voice)" -a project-hello-api
# (FLY_API_BASE_URL defaults to https://api.fly.io/v1 — leave unset.)
```

The API already has `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (the
provision script reuses them; see §2). Optionally tune the ready budget:

```bash
# Wall-clock budget the dial gate gives a machine to boot + register + post
# ready before deferring. Default 75s; clamp 30..300. Raise if cold boots are
# consistently slower than 75s.
fly secrets set PHONE_WORKER_READY_TIMEOUT_SEC=75 -a project-hello-api
```

`FLY_API_TOKEN` blank ⇒ every Fly call fails **closed** (`auth`), so a
half-configured API defers rather than crashes — but it also means **no calls
go out**. Set it before flipping the flag.

---

## 2. Provision the warm pool

The runtime never *creates* pool machines — it only starts/stops/reaps rows that
already exist. Provision the pool once (and re-run any time you change the size,
or after a `fly deploy` replaces the release image):

```bash
# Run WHERE the secrets exist — e.g. `fly ssh console -a project-hello-api`,
# or a CI job with FLY_API_TOKEN + SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY set.
node scripts/provision-voice-worker-pool.mjs \
  --app project-hello-phone-voice --pipeline phone --size 3

# Dry-run first to see the plan without creating/registering anything:
node scripts/provision-voice-worker-pool.mjs \
  --app project-hello-phone-voice --pipeline phone --size 3 --dry-run
```

The script is **idempotent**: it never creates above `--size`, never starts a
machine, and `register_voice_worker` is a no-op for an already-registered row. It
clones the release image + config from an existing machine and creates the
shortfall as **STOPPED** machines (`skip_launch:true`, `restart.policy:no`). It
prints a verification table (machine id, Fly state, lease state).

> **First run needs a template.** If the app has **zero** machines the script
> refuses (it will not guess an image): `fly deploy` the worker once so a release
> image exists, then re-run.

Repeat for the browser pool if activating that lane too:
`--app project-hello-voice --pipeline browser --size <N>` (and set
`BROWSER_AGENT_NAME` per the design doc).

---

## 3. Deploy order

The worker deploy-gate (`deploy-fly.yml` + `scripts/deploy-voice-orchestration.sh`)
is gated on the **worker** fly-config `WORKER_ORCHESTRATION`. Sequence:

1. **Worker first.** Set `WORKER_ORCHESTRATION="worker"` in `fly.phone.toml`
   and deploy. The gate runs `start → verify registration → deploy → stop`, and
   the posture check confirms the app is **not** ALWAYS_ON. After this the pool
   is STOPPED-scale-to-zero and registered.
2. **API second.** `fly secrets set WORKER_ORCHESTRATION=true -a project-hello-api`
   (this restarts the API). On boot the API constructs the dial gate, the
   prompt terminal-release loop and the reaper (all no-ops until now).
3. **Live cold-start validation.** Place one owner-test call (see the owner-test
   re-prime recipe) and watch a machine go
   `stopped → starting → ready → busy → (call) → draining → stopped`.

Keep the two `WORKER_ORCHESTRATION` flags **in step** thereafter.

---

## 4. What the runtime does once on (so you know what "healthy" looks like)

- **Admit gate (per dial):** `ensureReadyWorker` claims a STOPPED machine,
  starts it, and polls the lease until `ready` (budget
  `PHONE_WORKER_READY_TIMEOUT_SEC`, default 75s). Only then is the room
  provisioned + dispatched + dialled. A non-ready verdict **defers** the dial
  (`worker_not_ready`) — no room, no carrier.
- **Busy mark (per dial):** on a successful dial the API marks the lease `busy`
  — a second liveness signal for the reaper beyond LiveKit room-liveness.
- **Prompt terminal-release loop (every ~15s):** releases every machine whose
  bound `call_session` is already **terminal** (completed/failed/cancelled/
  expired). This is the universal terminal catch — every terminal path drives
  the session terminal — so it recovers **completed / failed / no-answer /
  abandoned / reconnect-exhausted / crash** without per-terminal wiring. Release
  is addressed **by session** (restart-safe: it needs no machineId, which a
  crashed dial process never persisted).
- **Reaper loop (every ~90s):** the correctness **backstop** for invariant I2.
  Stops any non-stopped machine whose LiveKit room is **not live** past the grace
  window (`WORKER_REAPER_GRACE_SEC`, default 180s). It **spares** a machine whose
  room is live, and **spares on unknown** (a LiveKit error is never treated as
  "dead").
- **`worker_not_ready` is same-IST-day retryable:** the committed attempt is
  abandoned immediately (`abandon_phone_attempt_infra`, charges no budget) and
  the per-IST-day index (migration 0083) excludes `abandoned`, so the **same
  engagement can redial the same IST day** rather than being wedged at
  `daily_attempt_exists` until IST midnight.

---

## 5. Verification queries (run against the DB as service_role)

```sql
-- Pool inventory: every registered machine + its lease state.
select app, machine_id, pipeline, state, claimed_session_id,
       started_at, ready_at, last_heartbeat_at
  from screening_v2.voice_worker_leases
 where app = 'project-hello-phone-voice'
 order by state, machine_id;

-- Healthy idle: all rows 'stopped', no claimed_session_id.
-- Healthy live: exactly the in-flight sessions are 'busy'/'ready', rest 'stopped'.

-- LEAK CHECK — a machine started with no session past grace is a defect the
-- reaper should be clearing. If this returns rows that persist across two
-- reaper windows (>3 min), investigate (Fly stop failing? reaper not running?).
select machine_id, state, claimed_session_id,
       coalesce(last_heartbeat_at, started_at, updated_at) as last_signal
  from screening_v2.voice_worker_leases
 where app = 'project-hello-phone-voice'
   and state <> 'stopped'
   and coalesce(last_heartbeat_at, started_at, updated_at) < now() - interval '3 minutes'
 order by last_signal;

-- No terminal-session lease should linger (the prompt-release loop clears these
-- within ~15s). Rows here that persist mean the terminal-release loop is not
-- running or Fly stop is failing.
select l.machine_id, l.state, s.status as session_status
  from screening_v2.voice_worker_leases l
  join screening_v2.call_sessions s on s.id = l.claimed_session_id
 where l.app = 'project-hello-phone-voice'
   and l.state in ('starting','ready','busy','draining')
   and s.status in ('completed','failed','cancelled','expired');

-- CAPACITY: count free (stopped) machines. If this is 0 during business hours,
-- the pool is exhausted → grow --size and re-run the provision script.
select count(*) filter (where state = 'stopped')  as free,
       count(*) filter (where state <> 'stopped')  as in_use,
       count(*)                                    as total
  from screening_v2.voice_worker_leases
 where app = 'project-hello-phone-voice';
```

Also watch the API logs for the metadata-only orchestration events
(`error_category` values): `worker_orchestration_ready`,
`worker_orchestration_no_capacity`, `worker_orchestration_terminal_release_swept`,
`worker_orchestration_reap_swept`. A steady stream of `no_capacity` means the
pool is too small.

---

## 6. Rollback

Rollback is a **flag flip**, not a git revert — the machinery stays deployed and
inert.

> **⚠ ORDER MATTERS — there is an OUTAGE WINDOW if you flip the API flag first.**
> Between "API flag off" and "worker scaled back to always-on" the worker pool is
> still scale-to-zero AND nothing starts machines on demand any more, so **every
> NEW call in that window gets no worker and is never answered** — a silent
> outage exactly like the "API off + worker scale-to-zero" failure mode in §0.
> So **scale the worker up to always-on FIRST**, and flip the API flag off only
> after the pool is confirmed running. The transient this creates —
> **worker always-on + API orchestration ON** — is the BENIGN combo: it is the
> "API on + always-on worker" churn case from §0, where the API pointlessly
> start/stops machines that are already running. That wastes a few Fly calls but
> **answers every call**; it never drops one. Trading a hard outage for benign
> churn is the whole point of this order.
>
> Note the posture check (`validate-voice-worker-apps.mjs`) does NOT block this
> transient: it is a **deploy-gate static check on the worker `fly.phone.toml`**
> (orchestration value vs scale config), not a check on the API secret or on a
> live `fly scale count`. Step 1 below is a scale operation, not a worker deploy,
> so it does not trip the check; the worker fly-config flip (which the posture
> check DOES gate) happens last, in step 3, when always-on + orchestration-off is
> already consistent.

1. **Worker up to always-on FIRST:** scale the pool machines back up so they stay
   running (`fly scale count …` per the always-on posture) and confirm they are
   `started`. The API is still orchestration-on here, so it will churn Fly
   start/stop against already-running machines (benign — see the warning above),
   but every call is answered. Do NOT proceed until the pool is confirmed up.
2. **API off:** `fly secrets set WORKER_ORCHESTRATION=false -a project-hello-api`
   (restarts the API). The dial gate, terminal-release and reaper loops stop
   constructing; the dial path reverts to byte-identical-to-today. The churn from
   step 1 stops; the always-on worker keeps answering calls.
3. **Worker fly-config back to always-on:** set `WORKER_ORCHESTRATION` back off in
   `fly.phone.toml` and deploy. NOW the posture check sees always-on +
   orchestration-off and passes (min_machines_running >= 1, auto_stop off).
4. **Drain in-flight:** any machine that was `busy` finishes its call; the
   reaper (still running until the API flag flips in step 2) or the next always-on
   deploy reconciles the rest. No call in progress is dropped by the rollback.
5. **Leave the pool rows:** the `voice_worker_leases` rows are harmless when the
   flag is off (`claim_voice_worker` is never called). No cleanup needed.

---

## 7. Future item — T-60 pre-start (NOT implemented here)

The cost/scale plan §2.3 sketches a **T-60 pre-start**: for a *scheduled*
appointment, start (and confirm ready) the worker ~60s before the slot so the
candidate never waits on a cold boot. This PR deliberately does **not** implement
it — the just-in-time gate + the 75s ready budget cover the common case, and
pre-start adds a scheduling dependency and a new leak surface (a machine started
for a slot the candidate then misses). Track it as a follow-up; if added, it must
reuse the same claim/lease/release path and the reaper must treat a pre-started
machine with no session exactly as it treats any other (spare while its room is
live / the slot is imminent, reap past grace otherwise).
```

## 8. Browser lane activation (2026-09-06)

The browser WebRTC worker (`project-hello-voice`) uses the SAME substrate as the
phone lane — the generic reconciliation deploy script, the shared reaper, the
`voice_worker_leases` table (`pipeline='browser'`), and the exchange-path gate
(`invites.ts` Step 2c: `ensureReadyWorker` → `dispatch` → 202-preparing on any
non-ready verdict, ordered BEFORE the one-time invite is consumed). The only
lane-specific facts:

- **Agent name.** Worker registers as `BROWSER_AGENT_NAME="browser-screener"`
  (`app/voice-livekit/fly.toml`) ONLY when its `WORKER_ORCHESTRATION="worker"`.
  The API dispatches to that exact name via `BROWSER_AGENT_NAME` in
  `app/api/fly.toml` (the API's `WORKER_ORCHESTRATION` is already `true`). The
  two names MUST be identical (runtime-only check — a mismatch leaves the room
  agent-less).
- **The hazard is the SAME three-flag matrix as §0, and worse here because
  browser screening is the PRIMARY live path.** Naming the worker stops its
  auto-dispatch, so a NAMED worker with the API gate OFF = agent-less rooms; a
  gate ON with no `pipeline='browser'` leases = `no_capacity` → 202-preparing
  forever. Both are outages. So the browser pool MUST exist before the flip.

**Activation order (zero-downtime):**
1. **Provision the browser pool FIRST** (service_role; §2 with `--pipeline
   browser --app project-hello-voice --size 2`). Nothing serves off these yet.
2. Merge the activation PR (this flips `fly.toml`→`worker`, adds the API
   `BROWSER_AGENT_NAME`, updates the posture pin). The deploy names the worker
   and activates the gate. The pre-existing always-on machine (`89122ec…`)
   redeploys as a NAMED `browser-screener` and keeps serving as a warm backstop —
   dispatch to the name routes to it OR a started pool machine, so no cold-boot
   outage during cutover.
3. Verify a browser exchange starts/claims a pool machine and dispatches (§5
   queries, `pipeline='browser'`).
4. **Only after that proof**, stop the always-on `89122ec…` machine
   (`flyctl machine stop 89122ec60edd28 -a project-hello-voice`;
   `restart.policy=on-failure` so it stays down) to reach true scale-to-zero.

**Rollback** (per §6): scale the browser app UP first
(`flyctl machine start` the pool / the always-on machine), THEN revert the
`fly.toml` flip and unset the API `BROWSER_AGENT_NAME`. Never flip the flag off
while the app is at zero — that strands in-flight browser candidates.
