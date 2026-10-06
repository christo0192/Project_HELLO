# S0-F laptop spike results — 2026-10-06

## Environment

- Run window: 2026-10-06 approximately 08:29–08:46 UTC.
- Device: Windows 11 Pro 64-bit (10.0.26200), headless Chromium 153.0.8010.12 via Playwright 1.63.0.
- Media: Chromium fake camera and microphone, requested at 640×360 @ 15 fps; page served from localhost.
- Network: Indian home broadband; `ipinfo.io/org` reported AS24309, Atria Convergence Technologies Pvt. Ltd. Broadband Internet Service Provider INDIA.
- Endpoint: disposable spike SFU only, `wss://project-hello-r1-rtc-spike.fly.dev` / dedicated IP 37.16.23.137. No Fly/SFU or firewall changes were made.

## Results

| Check | Attempts | Measurements | Result |
|---|---:|---|---|
| S0-F1 UDP pair | 1 × 90 s / 19 samples | Every selected publisher pair was TCP `37.16.23.137:7881`, never UDP `37.16.23.137:7882`. RTT 42–71 ms (mean 50.1 ms); fake-camera output 13–16 fps (mean 14.6); calculated outbound video bitrate 139.1–158.8 kbps (mean 148.7 kbps); `qualityLimitationReason=none`, bandwidth-limited seconds 0. Browser stats did not expose `packetsLost`, and there was no inbound-audio RTP stream from which to report jitter. Selected-candidate stats exposed only this nominated TCP pair; no client-side ICE reason for UDP non-nomination was reported. | **FAIL / NO-GO** — required UDP pair was not selected. |
| S0-F2-lite reconnect | 5 join/leave | 5/5 first joins succeeded. Time-to-connected: 1655, 1208, 1018, 1212, 923 ms (mean 1203.2 ms). Every cycle selected TCP `37.16.23.137:7881` (RTT 43–92 ms). | **FAIL** for the spike acceptance criterion because UDP was 0/5; reconnect-only behavior succeeded. |
| S0-F2-lite forced TCP | 0 | **NOT DONE.** A standards-valid TCP-only client-side forcing mechanism was not available: `iceTransportPolicy` is not TCP-only and no Chromium flag was relied upon. Per scope, no OS firewall change was made. | **NOT DONE** |
| S0-F3-lite dispatch + echo | 5 | Agent-audio track received with inbound bytes >0 in 2/5 cycles: dispatch-to-track 13.493 s / 13.659 s; max inbound audio 79,479 / 78,047 bytes. Three cycles had no agent audio track within 30 s. | **FAIL** — agent join/echo was 2/5, not 5/5. |

The isolated worker ran from `.spike-venv` and was stopped after the test. It used `livekit-agents==1.6.4` and `httpx==0.28.1` (the matching direct pin needed by the worker's runtime).

## Sanitized evidence

- [S0-F1 90-second stats](s0-f1-sanitized.json)
- [S0-F2-lite cycles](s0-f2-sanitized.json)
- [S0-F3-lite dispatch/echo cycles](s0-f3-sanitized.json)

No tokens, API secret, participant identifiers, or raw media are recorded in these artifacts.

## Not covered

Not covered by this laptop spike: the wider field matrix, 4G/mobile networks, corporate networks, Safari, long-duration soak, Cloud baseline comparison, Config B, 20-cycle reconnect testing, and cold/warm 20+20 dispatch testing.

## Config B rerun

- Run window: 2026-10-06 approximately 08:45-09:10 UTC.
- Server configuration under test: UDP bound to Fly global-services `172.19.46.243:7882`, advertised as `37.16.23.137:7882`; receive buffers set to 5 MB. No Fly/SFU configuration or firewall change, commit, or push was made for this run.
- Same laptop/browser/media setup as above. The isolated `.spike-venv` was reused. The worker was stopped after the checks.

| Check | Attempts | Measurements | Result |
|---|---:|---|---|
| S0-F1 UDP pair | 1 x 90 s / 18 samples | Every selected publisher pair was **UDP** `37.16.23.137:7882`. RTT 45-87 ms (mean 56.8 ms); fake-camera output 14-16 fps (mean 14.6); calculated outbound video bitrate 139.4-171.6 kbps (mean 150.7 kbps); `qualityLimitationReason=none`, bandwidth-limited seconds 0. Browser stats again exposed neither outbound `packetsLost` nor an inbound-audio RTP stream, so packet loss and jitter are unavailable. | **PASS** |
| S0-F2-lite reconnect | 10 join/leave | 10/10 first joins succeeded. Time-to-connected (ms): 1160, 792, 751, 865, 904, 844, 906, 744, 890, 788 (mean 864.4; range 744-1160). Every cycle selected UDP `37.16.23.137:7882`. | **PASS** |
| S0-F3 dispatch, worker continuously running | 10 dispatch cycles | Dispatch creation returned successfully in 10/10 cycles, and the worker was registered before every dispatch. Cycles 1-7: no `S0F_DISPATCH_RECEIVED` agent-log marker; RoomService `ListParticipants` saw only the candidate (max count 1); no audio. Cycles 8-10: worker received at 1541/1502/1323 ms, the participant list showed the agent at 1600/1577/1379 ms, and inbound audio arrived at 6701/6702/6516 ms (max 38,727/34,525/31,886 bytes). | **FAIL** - 3/10 complete dispatch-to-audio cycles. |
| S0-F3 cold-start race | 1 dispatch | Dispatch was created 517 ms after worker start, before the worker registered. No worker job-receipt marker, agent participant, or audio appeared; participant list max count was 1 (candidate only). | **FAIL** - confirms the dispatch-before-registration race. |

### S0-F3 diagnosis (evidence-based)

The cold result establishes one specific root cause: a dispatch made before worker registration is not queued/delivered when the worker subsequently registers. In the 10-cycle continuous-worker test, registration was already present before each dispatch, so the seven failures are **not** the pre-registration race. For each of those seven, dispatch creation succeeded but the job was not delivered to the worker: no per-room worker receipt marker, no second participant in `RoomServiceClient.listParticipants`, and no published/received agent audio. Thus the failure is before agent room join or publication, not an echo-track, participant-name, or room-name mismatch.

The worker framework log also recorded availability transitions around its default 0.7 load threshold (including `worker is at full capacity, marking as unavailable`) during the run. That is a plausible availability contributor to the seven non-deliveries, but the test did not capture an availability timestamp for every individual dispatch, so it is not claimed as the definitive cause. The directly demonstrated root cause is the pre-registration race; the additional demonstrated warm-path failure is nondelivery despite prior registration.

Sanitized Config B evidence (no credentials, JWTs, participant IDs, or raw media):

- [S0-F1 Config B stats](s0-f1-sanitized.json)
- [S0-F2 Config B cycles](s0-f2-sanitized.json)
- [S0-F3 continuous-worker dispatch diagnosis](s0-f3-config-b-sanitized.json)
- [S0-F3 true cold-start diagnosis](s0-f3-cold-config-b-sanitized.json)

Config B is now covered; the field matrix, 4G/mobile and corporate networks, Safari, soak, Cloud baseline, forced-TCP attempt, and larger 20+20 dispatch matrix remain out of scope.

## Dispatch root cause

### Diagnostic instrumentation and run status

The local-only spike worker now accepts `R1_SPIKE_LOAD_THRESHOLD=inf`. Against the pinned `livekit-agents==1.6.4` wheel, this is the supported `WorkerOptions(load_threshold=float("inf"))` argument; that version's availability check explicitly returns available for an infinite threshold. The worker also now uses `WorkerOptions(log_level="DEBUG")` and records the local `S0F_AVAILABILITY_ACCEPTED` boundary after the SFU has assigned an accepted job. The configurable dispatch harness records received request, accepted/assigned, connected/published, participant join, audio receipt, and framework load/status transitions per cycle.

The requested 10-cycle override phase, 5-cycle default phase, and three cold-start repetitions were **not run in this shell**: the disposable spike URL, API key, and API secret were absent from the process and from the Windows user/machine environment. No credential was read or printed. Consequently, this section does not substitute invented measurements for the required controlled result.

### Evidence available before the controlled rerun

- The default-load worker registered at 09:03:45.236 UTC, then was marked unavailable at 09:03:47.752 with load **1.0000** over its 0.7 threshold. It repeatedly crossed the threshold (unavailable readings: 0.8302, 0.7930, 0.7742, 0.8026, 0.7070, and 0.7096; available readings: 0.4762--0.6864). Thus the local CPU-based default demonstrably made an otherwise idle diagnostic worker unavailable.
- The three delivered jobs were received immediately after a below-threshold state (0.4762). That is consistent with load/availability affecting dispatch, but the earlier seven dispatches were not correlated one-for-one with worker status. Therefore load/availability is a demonstrated contributor, not yet the proven sole explanation for the warm-path failures.
- The cold dispatch was created at 09:10:06.678 UTC and the SFU registered the worker at 09:10:09.051 UTC (about **2.37 s later**). No job reached the worker. The SFU still logged no worker available for the room job at 09:10:11.615 UTC, about **2.56 s after registration**. A dispatch is not a readiness signal and is not safely recoverable by simply waiting for the worker to appear.
- The worker logs contain no explicit disconnect/reconnect record, but the SFU logged three `failed to send job request: no response from servers` events (and failed `TerminateJob` RPCs) after the three successful jobs. That is control-plane non-responsiveness; the existing INFO logs cannot distinguish a public-proxy WebSocket failure from a worker-side responsiveness failure. The DEBUG rerun is required to decide it.

### Conclusion and required production controls

The present evidence does **not** prove that high CPU load alone explains every failure. It proves that the default 2.5-second CPU average can repeatedly withdraw availability on this laptop and independently proves a dispatch-before-registration race. It also leaves a credible worker-control-plane/proxy failure mode open.

### Controlled rerun — 2026-10-06 09:25–09:35 UTC

Fresh DEBUG evidence now completes the requested diagnosis. The override worker (`R1_SPIKE_LOAD_THRESHOLD=inf`) accepted assignment, connected, and published audio for all ten sequential dispatches in its worker log. The browser artifact persisted nine complete cycles before the external Playwright session teardown limit: all nine had job receipt, explicit availability acceptance, agent join, and echoed-audio receipt; acceptance was 1.133–1.500 s and dispatch-to-audio was 6.262–6.778 s. The tenth has complete worker-side acceptance/connect/publication evidence, but its browser assertion did not flush before teardown.

With the default threshold, 5/5 cycles completed the same boundaries and echoed audio (acceptance 1.190–1.624 s; dispatch-to-audio 6.364–6.911 s). This short default run began before the initial CPU sample removed availability, so it does not refute the prior sustained-contention availability failure. A later S0-E probe recorded the default worker at load 1.000 over threshold 0.7 and unavailable.

The three override cold starts dispatched at 1.668, 1.329 and 1.341 s after launch, before registration at 6.054, 4.573 and 4.498 s respectively. All three were undelivered: no request, acceptance, agent join, or audio. Therefore cold dispatch requires a registration-based readiness signal. No worker DEBUG log showed a disconnect/reconnect in the warm successful phases, so the new result does not demonstrate a proxy/control-plane failure; it leaves private Fly 6PN as the required production hardening rather than a proven cause.

Production must not use the `inf` override; it is only the diagnostic control. It must instead use the phone worker's custom one-job-per-machine `load_fnc` with its finite threshold, publish a machine readiness signal only after the worker has registered (plan v2 §8.2) and dispatch only after that signal, and connect the worker to the SFU over Fly 6PN private networking rather than the public Fly proxy. Re-run the 10/5/3 matrix with the added markers before treating the dispatch path as accepted.
