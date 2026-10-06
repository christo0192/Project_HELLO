# R1 operations runbook

**Status:** Planned R1 operations. Procedures are implemented only where
labelled with an implementation PR; do not treat this runbook as launch
authorization.**

## Merge and deploy gate

Applies to every merge that deploys `app/api/`, `app/voice-livekit/`, or
migrations. (implemented in PR-1 and deploy-guard follow-up)

1. Schedule the merge for 07:00–08:30 IST, with the latest merge at 08:00 and
   no Quality re-run or deploy dispatch after 08:15. Do not deploy outside this
   window while R1 or phone can be live.
2. Set `r1_settings.paused = true` at least 30 minutes before the merge. This
   blocks new R1 attempts but lets live R1 sessions finish. (implemented in PR-2)
3. Run read-only SQL and abort unless every result is zero:

   The live-R1-session check is available after PR-1 (implemented in PR-1:
   `interview_round_attempts` / `call_sessions.interview_round_id`).

   ```sql
   -- Available after PR-1: live R1 sessions.
   select id from screening_v2.call_sessions
   where interview_round_id is not null
     and status in ('waiting', 'in_progress');

   -- Live phone attempts.
   select id from screening_v2.phone_call_attempts
   where lease_expires_at > now();

   -- Active phone dials, or dial work scheduled in the next 30 minutes.
   select id from screening_v2.job_queue
   where name = 'phone.dial'
     and (
       status = 'active'
       or (status in ('pending', 'delayed')
           and scheduled_at <= now() + interval '30 minutes')
     );

   -- Phone appointments due in the next 30 minutes.
   select id from screening_v2.phone_appointments
   where starts_at <= now() + interval '30 minutes'
     and status in ('scheduled', 'confirmed');

   -- Active phone assessments.
   select id from screening_v2.job_queue
   where name = 'phone.assessment' and status = 'active';
   ```

   These queries use the `job_queue` and `phone_appointments` schema in the
   migrations; the deploy guard must fail closed. (implemented in PR-1)
4. Squash-merge only after applicable Quality, hosting, Supabase, secret-scan,
   and model-governance checks are green. (implemented in PR-x)
5. Verify after deployment: watermarked worker registration, unchanged phone
   role-row snapshot, a phone Canary-1 dry run at about 08:30 IST, and an R1
   worker-context-only dry call (not a 20-minute interview). (implemented in PR-4a)
6. Restore `r1_settings.paused` only after verification and the owner’s
   operating decision. (implemented in PR-2)

Web-only deployments may occur outside this slot only with zero live R1
sessions. (implemented in PR-6/PR-7)

## Budget, cap, and reconciliation

R1 permits one live interview. Reserve 55 participant-minutes per attempt;
typical use is about 45 and worst case about 60. Track candidate/agent time,
preflight, manual tests, Fly uptime/egress, DeepSeek, Sarvam, failures, and
active sessions. (implemented in PR-2)

For the self-hosted SFU, R1 consumes no LiveKit Cloud participant-minutes.
Pause at the owner-approved R1 operating cap or projected provider/operational
overload. Reconcile the R1 ledger with Fly and provider dashboards daily during
launch and weekly thereafter. (implemented in PR-2)

For Cloud fallback, calculate the permitted sessions as:

```
floor((pause line - 1.2 * measured trailing-30-day non-R1 minutes
       - planned Cloud test minutes) / 55)
```

Start with the 4,000-minute (80%) pause line; raise to 4,250 (85%) only after
two reconciliations agree within 5%. Apply a 1.15 reconciliation factor until
the ledger is demonstrated. Warn at 60/75/90%, pause at the line or projected
month-end ≥90%, and keep R1 paused through 12:00 UTC on the first until reset
behavior is evidenced. (implemented in PR-2)

## SFU operations and fallback

Self-hosted operation is allowed only after S0-F passes. The R1 SFU is one
Fly `sin` Machine, dedicated IPv4, LiveKit v1.13.7 digest, WSS 443, ICE/TCP
7881, and UDP 7882. It has no Redis, Egress, SIP, Ingress, webhook, or
embedded TURN. (implemented in PR-SFU-1)

Keep JSON/info logs and private metrics; do not enable debug logging containing
candidate network data. Deploys, upgrades, cert changes, and secret changes
are manual, require zero live R1 rooms, and are followed by health, UDP-pair,
worker-registration, and browser smoke checks. (implemented in PR-SFU-2)

Fallback flip procedure:

1. Pause R1 and drain all `waiting` and `in_progress` R1 sessions.
2. Confirm zero R1 rooms and worker jobs; do not make an API-only flip.
3. Put the worker `LIVEKIT_*` triple on the selected endpoint, deploy and
   verify worker registration there.
4. Set `BROWSER_LIVEKIT_TARGET` to the same target, deploy the API, and verify
   returned endpoint, candidate token, room creation, dispatch, and reaper.
5. Apply the Cloud cap before admitting new sessions when the target is Cloud.

(implemented in PR-LK-seam and PR-LK-liveness)

## Key rotation

Use distinct R1 server credentials (`LIVEKIT_KEYS`) and API credentials
(`R1_LIVEKIT_*`); never reuse the phone/Cloud key. Maintain two active R1 keys
during rotation. Add the new key, stage matching API/worker credentials, drain
to zero rooms, deploy in the merge window, verify a new R1 room and worker,
then remove the old key and record non-secret rotation evidence. (implemented
in PR-SFU-2)

## Incident handling and rollback

For any active R1 incident, set `r1_settings.paused = true` first. Preserve
session, ledger, administration-log, queue, and recording metadata for review;
do not expose recordings or presigned URLs in incident chat. (implemented in PR-2)

If the SFU has a media, reachability, or key failure, keep R1 paused, assess
S0-F evidence, and either repair/retest or execute the drained Cloud fallback
procedure. Do not route phone through the R1 SFU. (implemented in PR-SFU-2)

If an R1 deployment regresses the worker or API, pause R1, squash-revert in
the merge window, and follow the phone release rollback runbook if phone is
affected. Additive migrations are disabled rather than dropped; R2 objects are
kept for retention/DSAR handling. The restored worker must keep R1 routes on
the R1-only lane; it must not use the legacy session path. (implemented in PR-x)

For video/recording problems, switch `R1_VIDEO_RECORDING` off to continue
audio-only only when the approved R1 policy permits it; investigate multipart
and checkpoint state before retrying finalization. (implemented in PR-9a/PR-9b)
