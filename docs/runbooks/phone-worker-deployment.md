# Phone worker deployment (isolated named worker + deploy safety)

Status: **pre-canary**. The dedicated phone worker is deployed **stopped
(min-0)** and places no calls. Do not scale it up for a real candidate until the
phone assessment lane is enabled end-to-end (see the P4/P4b closure notes). This
runbook covers how the phone worker is deployed, verified, rolled back, and
flipped to always-on at the canary — with **no cloud access required to read or
review it**.

Related config and code:
- Browser worker config: `app/voice-livekit/fly.toml` (`project-hello-voice`).
- Phone worker config: `app/voice-livekit/fly.phone.toml`
  (`project-hello-phone-voice`).
- Deploy workflow: `.github/workflows/deploy-fly.yml`.
- Contract tests: `scripts/deploy-fly-workflow.test.mjs`,
  `scripts/validate-voice-worker-apps.mjs` (+ `.test.mjs`).
- Worker isolation code + tests: `app/voice-livekit/agent.py`
  (`build_worker_options`, `_worker_handles_room`) and
  `app/voice-livekit/tests/test_phone_gate.py`.

---

## 1. Why two Fly apps for one image

Both apps run the **same** `app/voice-livekit` image. They differ only in run
posture, and the postures are mutually exclusive within one app:

| | Browser worker | Phone worker |
|---|---|---|
| Fly app | `project-hello-voice` | `project-hello-phone-voice` |
| Config | `fly.toml` | `fly.phone.toml` |
| `PHONE_AGENT_NAME` | **unset** (unnamed) | **`phone-screener`** (named) |
| LiveKit dispatch | auto-dispatch into every room | named → only rooms dispatched to it |
| Run policy | **always-on / min-1** | **stopped / min-0** until canary |
| Deploy token | `FLY_API_TOKEN_VOICE` | `FLY_API_TOKEN_PHONE_VOICE` |

A LiveKit Agents worker auto-dispatches **iff** it is unnamed. Naming the
browser worker would silently stop browser screening; leaving the phone worker
unnamed would make it a second auto-dispatching browser worker that grabs
browser rooms. So the two postures cannot share one app — hence two apps off one
image. `scripts/validate-voice-worker-apps.mjs` locks this: the browser config
must **not** set `PHONE_AGENT_NAME`, the phone config **must** set a non-empty
one, and neither may declare a public service or bake a secret/trunk value.

Cross-worker isolation is enforced twice and tested in `test_phone_gate.py`:
- The **named** phone worker does not auto-dispatch, and `_worker_handles_room`
  makes it return without connecting on any non-phone room.
- The **unnamed** browser worker skips phone rooms (by room name **and** by the
  `channel:phone` metadata marker) before `ctx.connect()` — no connect, no
  speaking, not one DB write.

Neither marker alone is a single point of failure.

---

## 2. The prior failed main deploy — structural diagnosis

**Evidence:** a main deploy in which the migration job and the API deploy
**passed**, but voice verification **failed** because the current worker
registration was absent (the worker was not registered/running after the
release).

**Root cause (structural, not incidental):** the workflow demanded a fresh
post-deploy `registered worker` log unconditionally, with no way to express an
app's intended run posture, and it did so against a single hardcoded voice app.
An app that is intentionally not running can therefore never satisfy the check,
and an always-on app that is genuinely down looks identical to one that is
intentionally stopped.

**Fix (this change):** run policy is now **explicit and per-app**, and
verification is policy-aware and app-correct:

- **Browser worker — `ALWAYS_ON`.** It is production and must stay min-1. The
  deploy still requires a **current** `registered worker` line whose ISO-8601
  timestamp is at/after a watermark captured immediately before the release, on
  **`project-hello-voice`**. A stale historical line cannot satisfy it, and an
  absent current registration **fails closed** — a true worker-down incident is
  surfaced, not hidden. (For this deploy the prior failure would still fail,
  correctly: the remedy is to bring the always-on worker back up, see §5.)
- **Phone worker — `STOPPED`.** Deployed but scaled to zero until the canary, so
  it runs no machine and registers no worker **by design**. This is **enforced by
  the deploy job**, not left to a manual precondition: immediately after the
  release the job runs `flyctl scale count 0 -a project-hello-phone-voice`, so a
  first-ever (or any) auto-deploy can never leave the named worker live. (A fresh
  `flyctl deploy` of a Machines app can otherwise create+start one machine.)
  Verification proves a clean release on **`project-hello-phone-voice`** and does
  **not** demand — or accept — a live registration line. Not requesting the phone
  app never fails the pipeline.

The fix is **not** "accept any `registered worker` line" — that would let a
stale log launder a down always-on worker into a green deploy. Zero stale-log
acceptance is preserved.

---

## 3. Service matrix and path detection

Manual `workflow_dispatch` exposes: `api`, `browser-voice`, `phone-voice`,
`both`, `all`.
- `both` = `api` + `browser-voice` (the legacy meaning; **never** phone).
- `all` = `api` + `browser-voice` + `phone-voice`.

Automatic (post-`Quality`-success on `main`) path detection:
- `app/api/**` → deploy **api**.
- `app/voice-livekit/**` → deploy **both** voice apps (browser **and** phone),
  because they share that source. Each runs on its **own** app-scoped token; the
  tokens are never conflated (`scripts/deploy-fly-workflow.test.mjs` asserts each
  job references only its own token and no other).
- `app/supabase/migrations/**`, or any application change → run the migration
  job first.

## 4. Migration ordering and tokens

`migrate-production` is a dependency (`needs: [detect, migrate-production]`) of
**every** app job, is globally serialized (`supabase-production-migrations`,
never cancelled in flight), and fails closed without `SUPABASE_DB_URL`. No
application job receives the database credential. Schema converges before any
app — including the phone app — deploys.

**One-time owner secret setup** (values never enter VCS):
```
fly tokens create deploy -a project-hello-api          # → FLY_API_TOKEN_API
fly tokens create deploy -a project-hello-voice        # → FLY_API_TOKEN_VOICE
fly tokens create deploy -a project-hello-phone-voice  # → FLY_API_TOKEN_PHONE_VOICE
# SUPABASE_DB_URL  → production Postgres URL (migration job only)
```
Provider/LiveKit/Supabase keys and the **SIP trunk value** are Fly **app**
secrets set with `fly secrets set -a project-hello-phone-voice ...`; they are
untouched by this workflow and must never appear in `fly.phone.toml`.

---

## 5. Rollback — phone only, browser untouched

Rolling the phone worker back is **not deploying it**: scale it to zero.
```
fly scale count 0 -a project-hello-phone-voice
# or, to also stop accepting a release:
fly apps suspend project-hello-phone-voice
```
This touches **only** `project-hello-phone-voice`. The browser worker
(`project-hello-voice`) is a different app with a different token and is never
referenced by the phone job (asserted by the contract test). Its always-on
posture and cost are unaffected.

Bringing the **browser** worker back after a genuine down-incident (the prior
failure) is the opposite operation on the other app:
```
fly scale count 1 -a project-hello-voice   # restore min-1
fly deploy -a project-hello-voice          # or re-run Deploy (Fly) → browser-voice
```

**Cost, truthfully:** while the phone app sits at count 0 it accrues **no
VM-hours** — only image/storage cost for the built release. The browser worker
is always-on (min-1) and bills for its single shared VM continuously; that is
its intended production posture, unchanged by this work.

---

## 6. Canary flip (deferred, reviewed)

When the phone lane is ready for a controlled canary, in a single reviewed PR:
1. **Remove** the `flyctl scale count 0 -a project-hello-phone-voice` enforcement
   line from `deploy-phone-voice` (otherwise the next deploy would scale the
   canary back to zero), and **add** the **same** watermarked `registered worker`
   proof the browser job uses, against `project-hello-phone-voice`. Both are
   reviewed edits, not operational toggles, so an always-on phone worker is never
   left unverified. Update `scripts/deploy-fly-workflow.test.mjs` to match
   (assert the registration proof; drop the scale-to-0 assertion).
2. `fly scale count 1 -a project-hello-phone-voice`.
3. Confirm a **current** registration after the next release.
4. Dispatch a single synthetic phone room to it and verify end-to-end before any
   real candidate. Do **not** enable real candidates until the assessment lane
   is complete.

Rollback at any step is §5.
