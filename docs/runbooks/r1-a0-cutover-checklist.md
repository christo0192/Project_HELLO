# R1 Stage A0 cutover checklist (owner-run)

**Status:** prepared for the owner, not run. Claude has no production access
(no Fly, no Supabase, no SQL against production), so nothing below has been
executed. Every command is for the owner to run.

**Authority.** `docs/runbooks/r1-operations.md` is the procedure of record. This
checklist puts its sections in order for the A0 cutover onto the reused spike
SFU: "Merge and deploy gate", "Room-routing contract", "Browser worker drain
budget", "Browser readiness contract", "Fallback flip procedure" (forward flip
and rollback), "Key rotation" and "Legacy browser screening retirement". It also
closes five gaps the runbook leaves open (see the last section). If the
checklist and the runbook disagree, stop and reconcile before running anything.

Every step that changes production is marked **PRODUCTION CHANGE**: 0.5, 2.3,
3.2, 4.1, 4.3, 6.1 (only if the seed is needed), 6.2 to 6.5, the smoke in step 7
(it creates real sessions, ledger rows and assessments), 7.5 and 8.2 to 8.4.
Every other step only reads.

## What is being cut over

| Item | Value |
|---|---|
| R1 SFU (reused spike app) | `project-hello-r1-rtc-spike`, Fly `sin`, one Machine, dedicated IPv4 `37.16.23.137`, Config B (or Config C once rolled out: `infra/livekit-r1/README.md`), the setup the S0-F spike proved (its settings are the SFU's Fly secrets `LIVEKIT_R1_CONFIG` and `NODE_IP`; this checklist never touches either) |
| R1 SFU URL | `wss://project-hello-r1-rtc-spike.fly.dev` |
| API | `project-hello-api` (target flips to `r1`; Cloud `LIVEKIT_*` stay for phone) |
| Browser worker | `project-hello-voice` (agent name `browser-screener`) |
| Phone worker | `project-hello-phone-voice`: **never touched by this procedure** |
| Join link | `<WEB_ORIGIN>/candidate/r1#<token>` (`WEB_ORIGIN` is `https://ib-ik-project-hello.vercel.app` in `app/api/fly.toml`) |

The change that ships in this PR is only `app/voice-livekit/fly.toml`:
`R1_LANE_MODE = "r1_only"`, a top-level `kill_timeout = 300`, and the two drain
settings `R1_DRAIN_TIMEOUT_SEC = "60"` and
`R1_SHUTDOWN_PROCESS_TIMEOUT_SEC = "90"` (60 + 2 x 90 + 30 = 270 <= 300, checked
by `scripts/validate-voice-worker-apps.mjs`). `BROWSER_WORKER_ONE_JOB` and
`R1_READINESS_HOST` stay out of the file: they are per-cutover Fly secrets.
Everything else is Fly secrets and database settings, set in the order below.

## Order at a glance

```text
0  Preconditions (read-only), then PAUSE R1                  (30+ min before the merge)
1  Zero-live and zero-browser-session checks (read-only)
2  Rotate the spike SFU key, verify the SFU
3  API FIRST: target r1 + R1 triple                          (no browser exchange from here on)
4  THEN workers: secrets, final zero-live check, MERGE the draft PR (deploys both voice apps)
5  Verify (deploy proof, registration, leases, phone checks, API health)
6  Enable for the smoke (role seed, allocation, target, R1_ENABLED, staff round)
7  A0 smoke: at least 2 sessions
8  Rollback (WORKERS FIRST, then the API)
```

The window from the end of step 3 to the end of step 4 is the dangerous one: the
API is on `r1`, the workers are not yet. It is fail-closed (every browser
exchange answers `preparing`), so no candidate may be using the system then.

## Conventions

- Use ONE PowerShell window from step 2 to step 4. The new SFU secret exists
  only in that window's memory (Fly never shows a secret value again).
- Placeholders are in angle brackets: `<REPO_ROOT>`, `<T0>`, `<ROUND_ID>`. The
  key and secret are the PowerShell variables `$NewKey` and `$NewSecret`; they
  are never typed, printed or pasted anywhere (no chat, no PR, no issue).
- SQL: each statement is one `Invoke-R1Sql` call. If the CLI refuses a write,
  paste the same statement into the Supabase SQL editor of the production
  project.
- Abort rule: any non-empty result in a "must be empty" check means STOP. Do
  not continue to a later step; follow the runbook (pause R1, find out why).
- Merge window (runbook "Merge and deploy gate"): merge between 07:00 and 08:30
  IST, latest merge 08:00, no Quality re-run or deploy dispatch after 08:15.
  Steps 3 and 4 belong in that window. If you have waived the time window for
  deploys, the zero-live checks and the 30 minute pause still apply.

Setup, once, at the start:

```powershell
# One window for the whole cutover.
$Repo = "<REPO_ROOT>"                 # the MAIN checkout, on an up-to-date main
Set-Location $Repo

# Runs ONE SQL statement against production (the Supabase project is linked from app\).
function Invoke-R1Sql([string]$Sql) {
  Push-Location (Join-Path $Repo "app")
  try { npx supabase db query --linked $Sql } finally { Pop-Location }
}

# Identity checks. A wrong login once made every query fail with 403.
fly auth whoami                       # the owner's Fly account
Push-Location (Join-Path $Repo "app"); npx supabase projects list; Pop-Location   # production project listed
```

Equivalent raw form of one query, for reference:
`cd app; npx supabase db query --linked "select 1;"`.

---

## Step 0. Preconditions (read-only, then one pause)

### 0.1 Every R1 PR is merged

- [ ] These R1 PRs are merged (all were merged to `main` on 2026-10-06/07):
      #339 PR-1 schema, #340 endpoint seam, #341 PR-2 API, #343 PR-4a worker,
      #345 PR-LK-liveness (0118), #348 PR-3 routes (0120), #349 PR-6 join page,
      #350 PR-5 scorer (0122), #351 PR-7 HR web, #352 PR-L legacy retirement,
      #353 PR-4b content, #354 PR-CT consent (0123), #355 PR-2b capacity (0119).
- [ ] **The PR-4b integration is merged: `<PR-4b integration PR #>`** (branch
      `r1/pr4b-integration`) **and so is the smoke-readiness worker fix** (it
      renames the admin-log payload keys to the API parser's and posts
      `session_facts`; #358 alone did neither). Until both are, every A0 session
      fails the scoring gate (`fidelity_facts_missing`) and the scorer is told
      false facts (`NOT PROBED`, `slip not reported`).
- [ ] The owner has decided whether PR-4c (latency) and PR-dep (freeze worker
      dependencies) must land before A0. This checklist assumes they do not.

```powershell
Set-Location $Repo
foreach ($n in 339,340,341,343,345,348,349,350,351,352,353,354,355) {
  gh pr view $n --json number,state | ConvertFrom-Json | ForEach-Object { "#$($_.number) $($_.state)" }
}
gh pr view "<PR-4b integration PR #>" --json number,state | ConvertFrom-Json | ForEach-Object { "#$($_.number) $($_.state)" }
gh pr list --state open --search "r1 in:title"        # only the A0 cutover draft may be open
git fetch origin; git log origin/main --oneline -5     # main is what you expect
```

Every line must say `MERGED`.

### 0.2 Production schema and data are ready

```powershell
Push-Location (Join-Path $Repo "app"); npx supabase migration list --linked; Pop-Location
```

- [ ] 0118, 0119, 0120, 0122, 0123 and 0125 show a Remote value (numbers 0121
      and 0124 were reserved for PR-L and PR-7, which shipped without a
      migration, so they do not exist).

```powershell
# Expect 4 rows: livekit_host, consent_locale, status_write, allocation_set_at.
Invoke-R1Sql "select table_name, column_name from information_schema.columns where table_schema = 'screening_v2' and ((table_name = 'voice_worker_leases' and column_name = 'livekit_host') or (table_name = 'interview_rounds' and column_name in ('consent_locale', 'status_write')) or (table_name = 'r1_settings' and column_name = 'allocation_set_at')) order by 1, 2;"

# Expect 2 rows: en-IN and en-IN-x-staff, same version, both active.
Invoke-R1Sql "select locale, version, is_active from screening_v2.interview_round_consent_templates where is_active order by locale;"

# R1 has never been enabled: expect 0.
Invoke-R1Sql "select count(*) as interview_rounds from screening_v2.interview_rounds;"
```

### 0.3 R1 is disabled, and the legacy retirement is closed out

```powershell
# Expect enabled = false (never switched on). Note paused, livekit_target (cloud),
# monthly_cap_minutes, allocation_set_at (null).
Invoke-R1Sql "select enabled, paused, auto_status_enabled, livekit_target, monthly_cap_minutes, pause_line_minutes, allocation_set_at from screening_v2.r1_settings;"
```

- [ ] `enabled = false`, `auto_status_enabled = false`.

The runbook allows `R1_LANE_MODE=r1_only` only after the legacy drain is closed
out (Q3 empty, Q4 zero, Q6 zero). `<T0>` is the time the PR-L API deploy was
serving, for example `2026-10-07 19:00:00+05:30`.

```powershell
# Q3 (must be EMPTY). The usage check found one stale legacy session: if it is
# still here, run the owner-run cancel statement from the runbook ("Drain
# procedure", step 6) first.
Invoke-R1Sql "select s.id, s.status, s.created_at from screening_v2.call_sessions s where s.mode = 'browser' and s.interview_round_id is null and s.status in ('created', 'waiting', 'in_progress') order by s.created_at;"

# Q4 (unconsumed_unexpired must be 0).
Invoke-R1Sql "select count(*) filter (where i.consumed_at is null and i.revoked_at is null and i.expires_at > now()) as unconsumed_unexpired, max(i.expires_at) as latest_expiry from screening_v2.candidate_invites i join screening_v2.call_sessions s on s.id = i.session_id where s.mode = 'browser' and s.interview_round_id is null;"

# Q6 (created_since_t0 must be 0).
Invoke-R1Sql "select count(*) as created_since_t0 from screening_v2.call_sessions where mode = 'browser' and interview_round_id is null and created_at >= '<T0>'::timestamptz;"
```

### 0.4 Credentials in hand

- [ ] The **LiveKit Cloud** URL, API key and secret for the browser worker are
      saved somewhere you can read them (password manager). Step 4 overwrites the
      worker's Cloud values, and Fly cannot show a secret again, so the rollback
      in step 8 needs them. If you only have the dashboard, create a new key in
      the same LiveKit Cloud project; it works for the worker.
- [ ] `fly auth whoami` and `npx supabase projects list` (above) are the owner's
      accounts.
- [ ] Tell whoever is working on the phone lane that a voice deploy is coming
      (the merge redeploys the phone worker), and confirm no other voice deploy
      is queued:

```powershell
gh run list --workflow "Deploy (Fly)" --limit 5       # nothing queued or in_progress
gh pr list --state open --search "phone in:title"      # a phone PR touching app/voice-livekit must not merge in this window
```

### 0.5 PRODUCTION CHANGE: pause R1 (at least 30 minutes before the merge)

Pausing blocks new R1 attempts and lets live ones finish. R1 is disabled, so
this is belt and braces, and the runbook requires it for any merge that deploys
`app/voice-livekit/`.

HR UI: `/admin/r1` (admin) -> switch **Paused** on -> Save -> confirm.
Or SQL:

```powershell
Invoke-R1Sql "update screening_v2.r1_settings set paused = true where singleton returning enabled, paused;"
```

- [ ] Paused since (IST): __:__ (merge no earlier than 30 minutes after this)

---

## Step 1. Zero-live and zero-browser-session checks (read-only)

Run every query. **Each must return no rows.** Any row: STOP (runbook "Merge and
deploy gate", step 3).

```powershell
# 1a. Live R1 sessions (runbook gate query 1).
Invoke-R1Sql "select id from screening_v2.call_sessions where interview_round_id is not null and status in ('waiting', 'in_progress');"

# 1b. Live browser sessions, WITHOUT the interview_round_id filter. Over-inclusive on purpose.
Invoke-R1Sql "select id, mode, status from screening_v2.call_sessions where status in ('waiting', 'in_progress');"

# 1c. Browser sessions not yet joined (created) as well.
Invoke-R1Sql "select id, status from screening_v2.call_sessions where mode = 'browser' and status in ('created', 'waiting', 'in_progress');"

# 1d. Live phone attempts.
Invoke-R1Sql "select id from screening_v2.phone_call_attempts where lease_expires_at > now();"

# 1e. Active phone dials, or dial work scheduled in the next 30 minutes.
Invoke-R1Sql "select id from screening_v2.job_queue where name = 'phone.dial' and (status = 'active' or (status in ('pending', 'delayed') and scheduled_at <= now() + interval '30 minutes'));"

# 1f. Phone appointments due in the next 30 minutes.
Invoke-R1Sql "select id from screening_v2.phone_appointments where starts_at <= now() + interval '30 minutes' and status in ('scheduled', 'confirmed');"

# 1g. Active phone assessments.
Invoke-R1Sql "select id from screening_v2.job_queue where name = 'phone.assessment' and status = 'active';"

# 1h. No worker holds a job: no pool machine is claimed.
Invoke-R1Sql "select app, machine_id, pipeline, state, claimed_session_id from screening_v2.voice_worker_leases where state <> 'stopped';"
```

```powershell
# 1i. Both voice apps are idle: no Machine is "started".
(fly machines list -a project-hello-voice --json | ConvertFrom-Json) | Select-Object id, state, region
(fly machines list -a project-hello-phone-voice --json | ConvertFrom-Json) | Select-Object id, state, region
```

- [ ] 1a-1h are empty. [ ] 1i shows no `started` machine (a phone machine that is
      started and idle is acceptable only if 1d-1g are empty).

---

## Step 2. Rotate the spike SFU to a fresh key and secret

The SFU takes exactly ONE `key:secret` mapping in `LIVEKIT_KEYS`
(`infra/livekit-r1/entrypoint.sh` rejects anything else, and the secret must be
at least 32 characters from `A-Za-z0-9_./+-`). The runbook's two-key rotation
therefore cannot be done on this image. That is acceptable for this first
rotation because nothing uses the spike key yet except spike tools: the API and
the worker are pointed at the SFU only in steps 3 and 4. Rotating restarts the
SFU Machine, so it needs zero live rooms (R1 has never been enabled).

### 2.1 Pre-check the SFU (read-only)

```powershell
fly status -a project-hello-r1-rtc-spike
fly ips list -a project-hello-r1-rtc-spike          # the dedicated v4 is 37.16.23.137
fly secrets list -a project-hello-r1-rtc-spike      # names only: LIVEKIT_KEYS, NODE_IP, LIVEKIT_R1_CONFIG must all exist
fly machines list -a project-hello-r1-rtc-spike --json | node (Join-Path $Repo "infra/livekit-r1/preflight.mjs")
```

- [ ] One Machine in `sin`; the three secret names exist. If `LIVEKIT_R1_CONFIG`
      is missing the SFU is running Config A, not the proven Config B (or C): STOP and
      ask before changing anything.
- [ ] Stop any spike echo agent or browser spike page still using the old key.

### 2.2 Generate the new key and secret (local, no output)

```powershell
$NewKey = "r1-a0-" + (Get-Date -Format yyyyMMdd)     # the key NAME; not secret
$b = New-Object byte[] 32; [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
$NewSecret = -join ($b | ForEach-Object { $_.ToString('x2') })    # 64 hex characters; never print it
```

Optional, so a closed window does not lose the secret (Windows-user-encrypted
file outside the repo):

```powershell
$NewSecret | ConvertTo-SecureString -AsPlainText -Force | ConvertFrom-SecureString | Set-Content "$env:USERPROFILE\.r1-a0-secret.dpapi"
# Restore in a new window:
# $NewSecret = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR((Get-Content "$env:USERPROFILE\.r1-a0-secret.dpapi" | ConvertTo-SecureString)))
```

If the secret is lost before step 4, repeat step 2 with a fresh one: until step 3
nothing else depends on it.

### 2.3 PRODUCTION CHANGE: set the new key on the SFU

The format the SFU expects is `<key>:<secret>`: one colon, no spaces, no quotes.
`NODE_IP` and `LIVEKIT_R1_CONFIG` are not touched.

```powershell
fly secrets set "LIVEKIT_KEYS=${NewKey}:${NewSecret}" -a project-hello-r1-rtc-spike
```

### 2.4 Verify the SFU (health, entrypoint, key)

```powershell
curl.exe -sS -o NUL -w "%{http_code}`n" https://project-hello-r1-rtc-spike.fly.dev/      # 200 (this also wakes a stopped Machine)
fly status -a project-hello-r1-rtc-spike                                                  # one Machine started, check passing
fly logs -a project-hello-r1-rtc-spike --no-tail | Select-String "livekit-r1-entrypoint"  # "Config B; advertising 37.16.23.137:7882" (Config C: "Config C; advertising 37.16.23.137:7882 and 6PN fdaa:..."), and no "must be" error
fly machines list -a project-hello-r1-rtc-spike --json | node (Join-Path $Repo "infra/livekit-r1/preflight.mjs")   # still one Machine in sin
```

Check the new key authenticates (read-only `listRooms`; needs `npm ci` once in
`app/api`, run from the repo root):

```powershell
$js = "const { createRequire } = require('node:module'); const req = createRequire(process.cwd() + '/app/api/package.json'); const { RoomServiceClient } = req('livekit-server-sdk'); new RoomServiceClient(process.env.R1_SPIKE_URL, process.env.R1_SPIKE_API_KEY, process.env.R1_SPIKE_API_SECRET).listRooms().then(r => console.log('new key ACCEPTED; rooms listed: ' + r.length)).catch(e => { console.error('REJECTED or unreachable: ' + e.message); process.exit(1); })"
$env:R1_SPIKE_URL = "https://project-hello-r1-rtc-spike.fly.dev"; $env:R1_SPIKE_API_KEY = $NewKey; $env:R1_SPIKE_API_SECRET = $NewSecret
Set-Location $Repo; node -e $js
Remove-Item Env:R1_SPIKE_URL, Env:R1_SPIKE_API_KEY, Env:R1_SPIKE_API_SECRET
```

Expect `new key ACCEPTED; rooms listed: 0` (a restart clears rooms).

- [ ] Health 200, entrypoint line present, key accepted.
- [ ] Record, non-secret: the key NAME `<NEW_KEY>`, the rotation time, and the
      new `LIVEKIT_KEYS` digest and date from `fly secrets list -a project-hello-r1-rtc-spike`.
- [ ] The old spike secret is dead. Delete any local copy of it.

The runbook also asks for a UDP-pair check, a worker-registration check and a
browser smoke after any SFU secret change. Those are step 5 (registration) and
step 7 (UDP pair and smoke); do not enable R1 for candidates before them.

---

## Step 3. API FIRST: target `r1` with the R1 triple

Runbook "Fallback flip procedure", forward flip, steps 2 and 4. The invariant:
**the API target is never Cloud while a browser worker is on the R1 SFU.** The
host check runs only when the API target is `r1`, so the API flips first.

### 3.1 Pre-checks (read-only)

```powershell
fly secrets list -a project-hello-api | Select-String "WORKER_ORCHESTRATION|BROWSER_LIVEKIT_TARGET|R1_LIVEKIT|LIVEKIT_URL|LIVEKIT_API"
```

- [ ] `WORKER_ORCHESTRATION` is listed. It is not in `app/api/fly.toml`, so it is
      a Fly secret, and it must stay as it is: with target `r1`, orchestration off
      means no candidate token ("fence 7"). Do not unset or change it.
- [ ] The Cloud `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` are listed
      and stay untouched (phone and the Cloud fallback use them).
- [ ] No `BROWSER_LIVEKIT_TARGET` or `R1_LIVEKIT_*` exists yet.
- [ ] `BROWSER_AGENT_NAME` is `browser-screener` in `app/api/fly.toml` and in
      `app/voice-livekit/fly.toml` (already true).
- [ ] Re-run step 1 (all empty). Then wait out the invite re-exchange grace
      window before changing the API target: 5 minutes with no browser
      exchange (a re-exchange inside it re-issues a token against the CURRENT
      endpoint without re-entering the worker gate).

```powershell
Start-Sleep -Seconds 300
```

### 3.2 PRODUCTION CHANGE: set target and triple in ONE command

One command, so the API restarts once and never has the target without the
triple (that would answer `503 r1_unavailable`). This restarts the API.

```powershell
fly secrets set "BROWSER_LIVEKIT_TARGET=r1" "R1_LIVEKIT_URL=wss://project-hello-r1-rtc-spike.fly.dev" "R1_LIVEKIT_API_KEY=$NewKey" "R1_LIVEKIT_API_SECRET=$NewSecret" -a project-hello-api
```

### 3.3 Verify the API

```powershell
fly status -a project-hello-api                                   # all Machines started, checks passing
fly releases -a project-hello-api                                 # newest release complete
curl.exe -sS https://project-hello-api.fly.dev/api/health         # {"ok":true}
fly secrets list -a project-hello-api | Select-String "WORKER_ORCHESTRATION|BROWSER_LIVEKIT_TARGET|R1_LIVEKIT"
```

- [ ] Health ok; the four new names and `WORKER_ORCHESTRATION` are listed.
- [ ] From here until step 5 verifies, NO browser exchange may run (R1 is
      disabled and paused, and the legacy lane is retired, so none should).

The endpoint the API hands out is observable only in an R1 preflight or exchange
response (step 7); with R1 disabled there is nothing to read yet.

---

## Step 4. THEN the workers, then merge the draft PR

### 4.1 PRODUCTION CHANGE: worker secrets on the browser app ONLY

The worker `LIVEKIT_*` triple moves to the SFU, and the two exact-`on` switches
are set. `R1_LANE_MODE`, `kill_timeout` and the drain settings come from
`fly.toml` through the merge in 4.3. **Do not run this against
`project-hello-phone-voice`.**

```powershell
fly secrets set "LIVEKIT_URL=wss://project-hello-r1-rtc-spike.fly.dev" "LIVEKIT_API_KEY=$NewKey" "LIVEKIT_API_SECRET=$NewSecret" "BROWSER_WORKER_ONE_JOB=on" "R1_READINESS_HOST=on" -a project-hello-voice
fly secrets list -a project-hello-voice | Select-String "LIVEKIT|BROWSER_WORKER_ONE_JOB|R1_READINESS_HOST"
```

Why not `--stage`: unstaged secrets apply to the pool now, so the merge deploy's
own PRE-deploy proof starts a pool Machine that registers on the SFU. A wrong
URL or key then fails the deploy before it ships the lane flip. (Pool Machines
are stopped; nothing restarts a live job.) Between this command and the merge the
workers are on the SFU in mode `off` and the API is on `r1`; with R1 disabled and
paused nothing can reach them, which is why the merge must follow without delay.

The host the API compares is the hostname of `R1_LIVEKIT_URL`. It must equal the
hostname of the worker `LIVEKIT_URL`: both are
`project-hello-r1-rtc-spike.fly.dev` above. A different or IP-literal host fails
the match closed (`preparing`).

### 4.2 Final gate, immediately before merging

- [ ] Paused for at least 30 minutes (step 0.5) and inside the merge window.
- [ ] Re-run all of step 1: every query empty.
- [ ] The draft PR's checks are green on the exact commit that will be squashed
      (Quality, `supabase-check`, secret scan), rebased on the current `main`.
      A new push re-runs them.

```powershell
gh pr checks r1/a0-cutover
git fetch origin; git log origin/main --oneline -3        # main has not moved since the PR was last rebased
gh run list --workflow "Deploy (Fly)" --limit 3           # no deploy in progress
```

- [ ] The PR body's three points are understood: it merges ONLY now (after step
      3), it deploys BOTH voice apps, and `fly.phone.toml` is unchanged.
- [ ] Phone role-row snapshot BEFORE (a stand-in fingerprint: the runbook names
      the snapshot but does not give its query). Record it:

```powershell
Invoke-R1Sql "select count(*) as roles, md5(coalesce(string_agg(r::text, '|' order by r.id), '')) as fingerprint from screening_v2.roles r where r.interview_kind is null;"
```

### 4.3 PRODUCTION CHANGE: merge the draft PR (this deploys)

```powershell
gh pr ready r1/a0-cutover
gh pr merge r1/a0-cutover --squash
```

The merge changes `app/voice-livekit/fly.toml`, and anything under
`app/voice-livekit/` makes `Deploy (Fly)` redeploy **both** voice apps, browser
and phone, from `main` HEAD. The API is not redeployed (no `app/api/` change),
and `migrate-production` runs first with no pending migration expected.
The phone image also ships any phone change merged to `main` and not yet
deployed, so confirm what else is pending (`fly releases -a project-hello-phone-voice`
against `git log` for `app/voice-livekit/`). A live phone call would be cut after
the 90 s drain; the zero-live checks above are what protect it.

Watch the deploy:

```powershell
gh run list --workflow "Deploy (Fly)" --limit 3
gh run watch "<RUN_ID>"
```

- [ ] `browser-voice` and `phone-voice` both succeed, each with its
      current-registration proof (a missing registration is a failed deploy).
- [ ] Merge commit SHA (non-secret): ________  Merge time (IST): __:__

---

## Step 5. Verification

### 5.1 Deploy and registration

```powershell
fly releases -a project-hello-voice                       # a new release
fly releases -a project-hello-phone-voice                 # a new release (same source image; expected)
fly logs -a project-hello-voice --no-tail | Select-String "registered worker" | Select-Object -Last 3
fly logs -a project-hello-voice --no-tail | Select-String "livekit_host_missing|registration_post_failed|r1_room_routing_refused"
```

- [ ] The last `registered worker` line names the SFU host
      (`project-hello-r1-rtc-spike.fly.dev`), not a `livekit.cloud` host. (If the
      log is empty the pool Machine has been stopped for a while: the deploy job's
      own current-registration proof and the lease in step 7 carry the evidence.)
- [ ] The second command returns nothing: `livekit_host_missing` means the worker
      posted no host (R1 would never admit it); `registration_post_failed` means
      the readiness post failed twice.
- [ ] The merged commit did not touch `fly.phone.toml`, and changed only
      `app/voice-livekit/fly.toml` and the checklist:

```powershell
$sha = (gh pr view r1/a0-cutover --json mergeCommit | ConvertFrom-Json).mergeCommit.oid
git fetch origin
git diff --stat "$sha^" $sha -- app/voice-livekit/fly.phone.toml      # empty
git diff --stat "$sha^" $sha                                          # fly.toml and docs/runbooks/r1-a0-cutover-checklist.md only
```

### 5.2 Leases and the `livekit_host` match

```powershell
Invoke-R1Sql "select app, machine_id, pipeline, state, livekit_host, registered_agent_name, ready_at, last_heartbeat_at from screening_v2.voice_worker_leases order by app, machine_id;"
```

Idle pool Machines are `stopped` with `livekit_host` null (0118 clears the host
on every reset). The host is visible only while a lease is claimed, so the first
proof is the registration line above and, during the smoke (step 7), a `ready` or
`busy` browser lease whose `livekit_host` is exactly
`project-hello-r1-rtc-spike.fly.dev`. A phone lease never carries a host.

### 5.3 Phone checks (the merge redeployed the phone worker)

- [ ] Phone role-row snapshot AFTER equals the one from step 4.2:

```powershell
Invoke-R1Sql "select count(*) as roles, md5(coalesce(string_agg(r::text, '|' order by r.id), '')) as fingerprint from screening_v2.roles r where r.interview_kind is null;"
```

- [ ] A phone Canary-1 dry run passes (`docs/runbooks/phone-canary1.md`), about
      08:30 IST: `worker_present_before_originate|PASS`. If it fails, keep R1
      paused and roll the phone worker back
      (`docs/runbooks/phone-worker-deployment.md` section 5) before touching R1.

### 5.4 API

```powershell
curl.exe -sS https://project-hello-api.fly.dev/api/health         # {"ok":true}
fly status -a project-hello-api
```

- [ ] Do not resume or enable anything until 5.1-5.4 pass (runbook step 6).

---

## Step 6. Enable for the smoke

R1 needs four things in place, in this order, and stays PAUSED until the last:
the seeded role, the database settings, `R1_ENABLED` on the API, and the staff
round. `r1_settings.livekit_target` is its own setting and must be `r1`:
the API compares it with its endpoint and answers `503 r1_endpoint_mismatch`
otherwise. The HR page `/admin/r1` shows it but cannot edit it ("changed by
deployment, not here"), and no deploy changes it, so it is set by SQL.

### 6.1 The Sales R1 role and scorecard exist

```powershell
Invoke-R1Sql "select id, title, interview_kind from screening_v2.roles where interview_kind = 'sales_r1';"
```

One row: go to 6.2. No row: seed it. **PRODUCTION CHANGE** (run from `app\api`,
in a shell whose Supabase URL and service-role key point at production; never
paste those values anywhere). Dry run first:

```powershell
Set-Location (Join-Path $Repo "app\api")
npx tsx scripts/seed-r1-role.ts             # dry run: prints the role and rubric version
npx tsx scripts/seed-r1-role.ts --apply     # PRODUCTION CHANGE
Set-Location $Repo
```

Then re-run the select above: one row.

### 6.2 PRODUCTION CHANGE: allocation, target, enabled (still paused)

Set the allocation yourself: `monthly_cap_minutes` is sessions x 55 (for example
20 x 55 = 1100). While it is still the default 4000 and never saved, enabling is
refused (`r1_allocation_not_set`), and in Mode A nothing else would cap R1.
Naming `monthly_cap_minutes` in the statement is what stamps `allocation_set_at`.
In Mode A (target `r1`) `pause_line_minutes` does not gate R1; leave it.
`auto_status_enabled` stays false for A0.

```powershell
Invoke-R1Sql "update screening_v2.r1_settings set monthly_cap_minutes = <ALLOCATION_MINUTES>, livekit_target = 'r1', paused = true, enabled = true where singleton returning enabled, paused, livekit_target, monthly_cap_minutes, allocation_set_at;"
```

The same can be done in the HR UI at `/admin/r1` for the cap, **R1 enabled** and
**Paused**; `livekit_target` can only be set by SQL (or an admin
`PUT /api/admin/r1/settings` with `{"livekit_target":"r1"}`).

The runbook's launch checklist also records the first dashboard reading before
enabling (HR page `/admin/r1`, "Record reading": the LiveKit Cloud month-to-date
minutes). It does not gate Mode A but anchors the Cloud-pool figure for the
fallback; do it now if you have the number.

### 6.3 PRODUCTION CHANGE: `R1_ENABLED=true` on the API

The API builds the R1 runtime (assessment queue, status loop) and answers R1
routes only when `R1_ENABLED` is exactly `true`. Unset, every R1 route answers
`409 r1_disabled` and Send R1 shows `not_deployed`. This restarts the API; do it
while no session is live (still true).

```powershell
fly secrets set "R1_ENABLED=true" -a project-hello-api
fly status -a project-hello-api
curl.exe -sS https://project-hello-api.fly.dev/api/health         # {"ok":true}
```

### 6.4 Create the staff dry-run round

The Send R1 route has no locale option, and the staff consent notice
(`en-IN-x-staff`, "no hiring decision is made about you") is chosen by the round
alone, never by the client. So the round is created as a normal one and marked
`en-IN-x-staff` by SQL BEFORE the staff member opens the link. After a consent
record exists, or once the round leaves `invited`, a trigger refuses the change;
the repair then is to cancel the round and send a new one.

1. A candidate record exists for the staff tester (a staff member's own details),
   with no active phone engagement.
2. **PRODUCTION CHANGE**: HR UI: candidate page -> R1 card -> **Send R1** -> tick
   the India-location attestation. **Copy the join link now**: it is shown once
   (`<WEB_ORIGIN>/candidate/r1#<token>`). Do not open it yet. Sending books a
   55-minute hold against the allocation.
3. **PRODUCTION CHANGE**: find the round, then mark it staff.

```powershell
Invoke-R1Sql "select id, candidate_id, status, consent_locale, starts_used, created_at from screening_v2.interview_rounds order by created_at desc limit 3;"
Invoke-R1Sql "update screening_v2.interview_rounds set consent_locale = 'en-IN-x-staff' where id = '<ROUND_ID>' and status = 'invited' and consent_locale = 'en-IN' returning id, status, consent_locale;"
```

- [ ] The update returned exactly one row with `en-IN-x-staff`.
- [ ] (One round per candidate at a time: a second round needs the first to be
      completed, expired or cancelled.)

### 6.5 PRODUCTION CHANGE: un-pause (the last switch)

HR UI `/admin/r1`: switch **Paused** off. Or:

```powershell
Invoke-R1Sql "update screening_v2.r1_settings set paused = false where singleton returning enabled, paused, livekit_target;"
```

- [ ] `enabled = true`, `paused = false`, `livekit_target = r1`.
- [ ] Mark the time. Pause again after the smoke (step 7.5).

---

## Step 7. The A0 smoke (at least 2 sessions)

One live R1 session at a time (admission refuses a second one). Use a real
device and a network typical of candidates. Each session is about 20 minutes (the
worker caps residency at 1800 s). Keep these open: the join page with browser
devtools, `chrome://webrtc-internals`, and three log tails.

```powershell
fly logs -a project-hello-voice          # worker: registered worker, job, teardown
fly logs -a project-hello-api            # API: r1_* errors
fly logs -a project-hello-r1-rtc-spike   # SFU
```

### 7.1 Session 1: the normal path

1. Open the join link as the staff tester, read the staff notice, consent, run
   the audio/video check, start.
2. While it runs, look at:
   - **Join page network tab**: the `/api/r1/preflight` and `/api/r1/exchange`
     responses carry `url`; it must be `wss://project-hello-r1-rtc-spike.fly.dev`.
     This is the first place the API's returned endpoint can be read. The same
     responses carry a `livekit_token`: do not copy or paste it anywhere.
   - **`chrome://webrtc-internals`**: the selected candidate pair is `udp` to
     `37.16.23.137:7882`, not `tcp` and not `relay`.
   - **Lease**: while the session runs, the browser lease is `ready` then `busy`
     with `livekit_host = project-hello-r1-rtc-spike.fly.dev`.
   - **Logs**: the worker shows a job; no `r1_room_routing_refused`, no
     `livekit_host_missing`; the API shows none of `r1_endpoint_target_mismatch`,
     `r1_worker_gate_missing`, `r1_endpoint_not_configured`,
     `r1_cloud_fallback_legacy_browser_enabled`.
   - The candidate hears the agent, the agent hears the candidate, and the call
     reaches its phases; note first-audio delay and any gap.

```powershell
Invoke-R1Sql "select app, machine_id, pipeline, state, livekit_host, claimed_session_id from screening_v2.voice_worker_leases where pipeline = 'browser' order by app, machine_id;"
Invoke-R1Sql "select id, status, terminal_reason, started_at, ended_at, duration_sec from screening_v2.call_sessions where interview_round_id is not null order by created_at desc limit 3;"
```

### 7.2 After session 1 ends

```powershell
Invoke-R1Sql "select id, status, consent_locale, starts_used, attempts_counted, recommendation, overall, status_write, assessment_id is not null as assessed from screening_v2.interview_rounds order by created_at desc limit 3;"
Invoke-R1Sql "select a.round_id, a.attempt_number, a.persona_id, a.counted, a.outcome, s.id as session_id, s.status, s.terminal_reason from screening_v2.interview_round_attempts a join screening_v2.call_sessions s on s.id = a.session_id order by a.created_at desc limit 3;"
Invoke-R1Sql "select participant_kind, event, count(*) as rows, sum(seconds) as seconds from screening_v2.r1_usage_ledger where session_id = '<SESSION_ID>' group by 1, 2 order by 1, 2;"
Invoke-R1Sql "select event_type, count(*) as rows from screening_v2.r1_admin_log where session_id = '<SESSION_ID>' group by 1 order by 1;"
Invoke-R1Sql "select * from screening_v2.v_r1_budget_month;"
Invoke-R1Sql "select app, machine_id, state, livekit_host from screening_v2.voice_worker_leases where pipeline = 'browser' order by app, machine_id;"
(fly machines list -a project-hello-voice --json | ConvertFrom-Json) | Select-Object id, state
```

Look for:

- The session ends normally: `completed` with an ordinary terminal reason, not
  `worker_crash`, `residency_timeout`, `shutdown_forced` or an infra failure.
- The attempt is `counted = true` and the round `attempts_counted = 1`.
- Ledger rows for `candidate` and `agent` (and the preflight), with plausible
  seconds; `v_r1_budget_month` moved by about one session (the 55-minute hold
  converted to booked minutes).
- `r1_admin_log` contains `session_facts` (the worker posts it before the terminal
  transition, with every key the API parser reads; `first_audio_p95_ms` is an
  explicit null until PR-4c measures first-audio latency). Without the row the
  gate fails closed with `fidelity_facts_missing`.
- The `r1.assessment` job ran: `assessed = true`, a `recommendation` and
  `overall`, `status_write = flag_off` (auto-status is off) or `human_review`
  with the reason in the assessment. `human_review` on every session is
  expected for now: the gate still lists `latency_unknown` (PR-4c) and, until the
  API stops requiring an F1 push line (F1 is anchor + counter), `push_missing:f1`.
  `fidelity_facts_missing`, `family_slip_unknown`, `unprobed_reveal` or
  `roleplay_duration_unknown` mean the worker's rows no longer match the parser
  (wrong order, or key drift: `tests/test_r1_admin_contract.py` pins the names).
- The browser lease is back to `stopped` with a null host, and the Machine is
  stopped (the reaper released it). A Machine left `started` is a reaper fault.

### 7.3 Session 2: the second path

The first round must be finished (completed). Send a second round (HR **Send
R1**, or **Grant retake** on the first round if its attempt allowed one), mark it
staff as in 6.4, and run it. Use the second run for what session 1 did not cover:

- Close the tab mid-session and rejoin within the 90 s grace; the session must
  continue, not restart or fail.
- Let it run to its natural end, or end it early on purpose to see the early-exit
  path.
- Re-check everything in 7.1 and 7.2. A different persona is expected.

A third session is worthwhile if either of the first two showed a problem.

### 7.4 A0 pass criteria (S09)

- [ ] At least two sessions ran end to end on the R1 SFU.
- [ ] Both returned the SFU URL, selected a UDP pair, and registered with the
      matching `livekit_host`.
- [ ] Both ended normally, counted, and left ledger rows and a scored (or
      deliberately `human_review`) assessment.
- [ ] The reaper stopped the worker Machine after each session.
- [ ] No refused or deleted room, no stuck lease, no phone regression.

### 7.5 Record, then pause

**PRODUCTION CHANGE**: pause R1 after the smoke. Resuming is the owner's
operating decision, not part of this checklist.

```powershell
Invoke-R1Sql "update screening_v2.r1_settings set paused = true where singleton returning enabled, paused;"
```

---

## Step 8. Rollback (WORKERS FIRST, then the API)

Runbook "Fallback flip procedure", rollback R1 to Cloud. The invariant holds in
reverse: the API never points at Cloud while a worker is still on the R1 SFU. If
anything fails, in any step, the first action is always: **pause R1** (step 7.5
SQL or the HR page), then stop and decide.

Roll back for: the SFU unreachable or a candidate unable to join for more than 10
minutes, no UDP pair, the worker not registering on the SFU, refused or deleted
rooms, or a media failure. A suspected leaked key is a rotation (step 2 again,
then the new key through steps 3 and 4), not this rollback.

### 8.1 Drain (read-only)

Pause R1, then repeat step 1 (all empty): zero R1 rooms, zero live browser
sessions, no claimed lease.

### 8.2 PRODUCTION CHANGE: workers first, back to the Cloud triple

Use the Cloud URL, key and secret saved in step 0.4. Remove the two switches.
`R1_LANE_MODE` stays `r1_only` (see below).

```powershell
fly secrets set "LIVEKIT_URL=<CLOUD_LIVEKIT_URL>" "LIVEKIT_API_KEY=<CLOUD_API_KEY>" "LIVEKIT_API_SECRET=<CLOUD_API_SECRET>" -a project-hello-voice
fly secrets unset BROWSER_WORKER_ONE_JOB R1_READINESS_HOST -a project-hello-voice
fly secrets list -a project-hello-voice | Select-String "LIVEKIT|BROWSER_WORKER_ONE_JOB|R1_READINESS_HOST"
```

While the API is still on `r1`, a Cloud worker's host-less report fails the host
match closed: `preparing`, no token. That is the intended safe interim.

### 8.3 PRODUCTION CHANGE: then the API

```powershell
fly secrets unset BROWSER_LIVEKIT_TARGET -a project-hello-api
fly status -a project-hello-api
curl.exe -sS https://project-hello-api.fly.dev/api/health         # {"ok":true}
```

`R1_LIVEKIT_*` may stay (they are inert without the target) or be unset; do not
touch the Cloud `LIVEKIT_*` or `WORKER_ORCHESTRATION`.

### 8.4 PRODUCTION CHANGE: the database target

Set the settings target back, or R1 answers `503 r1_endpoint_mismatch`:

```powershell
Invoke-R1Sql "update screening_v2.r1_settings set livekit_target = 'cloud', paused = true where singleton returning enabled, paused, livekit_target;"
```

### 8.5 Afterwards

- Wait out the 5 minute re-exchange grace window.
- Apply the Cloud cap before admitting any session: with target `cloud`, both the
  allocation and the pool pause line apply. Permitted sessions are
  `floor((pause line - 1.2 * measured trailing-30-day non-R1 minutes - planned
  Cloud test minutes) / 55)`, starting at the 4,000-minute line.
- Re-verify: worker registration on Cloud, health, step 1 queries.
- Resume only on the owner's decision.

### Do not roll back by reverting this PR

A squash-revert of the A0 cutover PR would put `R1_LANE_MODE = "off"` back and
drop `kill_timeout` while the legacy lane is retired. A worker in mode `off`
refuses and deletes every marked R1 room, so a revert makes things worse. The
runbook's rule is that a restored worker keeps R1 rooms on the R1-only lane
(`r1_only`), so the rollback is the secrets and settings above, not a code
revert. Revert the PR only as a deliberate follow-up, together with the plan to
re-enable the legacy lane.

---

## Record sheet (non-secret; fill in as you go)

```text
Paused since (IST):                 __:__
SFU key name (NOT the secret):      <NEW_KEY>
SFU LIVEKIT_KEYS digest / date:     ________ / ________
API release after step 3:           v___   healthy: yes/no
Worker secrets set (IST):           __:__
Merge SHA / time (IST):             ________ / __:__
Deploy (Fly) run:                   ________   browser-voice ok / phone-voice ok
Phone role-row fingerprint before / after:  ________ / ________
Phone Canary-1 result:              ________
R1 enabled / un-paused (IST):       __:__ / __:__
Smoke session 1 round / session:    ________ / ________   result ________
Smoke session 2 round / session:    ________ / ________   result ________
Paused after the smoke (IST):       __:__
```

## Gaps in the runbook this checklist closes, and open points

Fold the closed gaps into `docs/runbooks/r1-operations.md` after the cutover:

1. **`r1_settings.livekit_target`.** The flip procedure never sets it. It defaults
   to `cloud`, the HR page cannot edit it, and the API refuses R1 work with
   `503 r1_endpoint_mismatch` unless it equals the endpoint target. Steps 6.2 and
   8.4.
2. **`R1_ENABLED=true` on the API.** Needed for every R1 route and the R1 runtime;
   the flip procedure does not mention it, and it is not in
   `config/environment.schema.json`. Step 6.3.
3. **Staff dry-run locale.** Send R1 creates `en-IN` rounds; a staff round is
   marked by SQL before the link is opened. Step 6.4.
4. **Cloud credentials for the rollback.** Fly cannot show secrets, so the Cloud
   triple must be saved before step 4. Step 0.4.
5. **One key, not two.** The SFU image takes a single `LIVEKIT_KEYS` mapping, so
   the runbook's two-key rotation is not available; step 2 is safe only because
   nothing uses the key before steps 3 and 4.

Open points the checklist only works around:

6. Flip step 4 says "verify the API's returned endpoint is the R1 SFU". The API
   exposes it only in an R1 preflight or exchange response, so there is nothing
   to read until R1 is enabled; this checklist moves the check to step 7.1.
7. The "unchanged phone role-row snapshot" has no query in the runbook or the
   plan. Steps 4.2 and 5.3 use a whole-table fingerprint of the non-R1 role rows
   as a stand-in. Replace it with the real query when it exists.
8. Seeding the R1 role (`seed-r1-role.ts`) needs production Supabase credentials
   in the local shell, and no document says how the owner supplies them safely.
   Step 6.1 only says to keep them out of chat and out of the PR.
