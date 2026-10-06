# S0-F laptop spike results — 2026-10-06

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

| Check | Attempts | Measurements | Result |
|---|---:|---|---|
| S0-F1 UDP pair | 1 x 90 s / 18 samples | **17/18 samples on a selected UDP pair** (1 sample had no selected pair yet; 0 TCP/relay). Every selected publisher pair was **UDP** `37.16.23.137:7882`. RTT 45-87 ms (mean 56.8 ms over 17 selected pairs); fake-camera output 14-16 fps (mean 14.6); calculated outbound video bitrate 139.4-171.6 kbps (mean 150.7 kbps); `qualityLimitationReason=none`, bandwidth-limited seconds 0. Browser stats again exposed neither outbound `packetsLost` nor an inbound-audio RTP stream, so packet loss and jitter are unavailable. | **PASS** |
| S0-F2-lite reconnect | 10 join/leave | 10/10 first joins succeeded. Time-to-connected (ms): 1160, 792, 751, 865, 904, 844, 906, 744, 890, 788 (mean 864.4; range 744-1160). Every cycle selected UDP `37.16.23.137:7882`. | **PASS** |
| S0-F3 dispatch, worker continuously running | 10 dispatch cycles | `dispatchCreated` and `workerRegisteredBeforeDispatch` were true in 10/10 cycles. Cycles 1-7 had `workerReceivedJob`, `agentJoinedByParticipantList`, and `audioReceived` false (max participant count 1). Cycles 8-10 received the job at 1541/1502/1323 ms, joined at 1600/1577/1379 ms, and received audio at 6701/6702/6516 ms (max 38,727/34,525/31,886 bytes). | **FAIL** - 3/10 complete dispatch-to-audio cycles. |
| S0-F3 cold-start race | 1 dispatch | Dispatch was created 517 ms after worker start before registration; `workerReceivedJob`, `agentJoinedByParticipantList`, and `audioReceived` were false, with max participant count 1. | **FAIL** - supports the dispatch-before-registration race. |

### S0-F3 diagnosis (evidence-based)

In the continuous-worker artifact, all 10 dispatches were created after registration; 3/10 then completed worker receipt, agent join, and audio receipt, while 7/10 did not reach worker receipt. The separate cold artifact records a dispatch before registration that was not delivered. These artifacts support the required post-registration readiness control; they do not identify a cause for the seven warm-path non-deliveries.

Sanitized Config B evidence (no credentials, JWTs, participant IDs, or raw media):

- [S0-F1 Config B stats](s0-f1-sanitized.json)
- [S0-F2 Config B cycles](s0-f2-sanitized.json)
- [S0-F3 continuous-worker dispatch diagnosis](s0-f3-config-b-sanitized.json)
- [S0-F3 true cold-start diagnosis](s0-f3-cold-config-b-sanitized.json)

Config B is now covered; the field matrix, 4G/mobile and corporate networks, Safari, soak, Cloud baseline, forced-TCP attempt, and larger 20+20 dispatch matrix remain out of scope.

## Dispatch root cause

### Committed structured evidence

- The committed `s0e-connect-sanitized.json` records one default-threshold worker becoming unavailable at load 1.0 over threshold 0.7, then available at load 0.6616. Its single dispatch was not delivered. This is a possible contributor, not a demonstrated load gate: the artifact does not correlate worker availability to a set of dispatches.
- The committed cold artifacts support the dispatch-before-registration race: all 3/3 dispatches occurred before registration and were undelivered. Registration lag after dispatch was 3.157-4.386 s. A dispatch is therefore not a readiness signal.

### Conclusion and required production controls

Load gating is **not proven** by the committed artifacts: the default configuration completed 5/5 recorded cycles and the diagnostic override completed 10/10. The cold dispatch race is supported, so readiness only after worker registration remains the required fix. PR-LK-liveness mitigates possible one-job availability pressure with an opt-in one-job `load_fnc` (`BROWSER_WORKER_ONE_JOB`, default off); it is not a substitute for post-registration readiness.

### Controlled rerun

The committed override artifact records all **10/10** sequential cycles completing every browser-visible boundary: job receipt, availability acceptance, agent join, and audio receipt. Acceptance was 1.133-1.500 s and dispatch-to-audio was 6.262-6.778 s.

With the default threshold, 5/5 cycles completed the same recorded boundaries and echoed audio (acceptance 1.190-1.624 s; dispatch-to-audio 6.364-6.911 s). Together with the 10/10 override result, this does not reproduce or prove load gating. A separate single-cycle S0-E artifact records the default worker unavailable at load 1.0 over threshold 0.7, but does not establish causation.

The three cold starts dispatched 1.329-1.668 s after launch, before registration at 4.498-6.054 s. All 3/3 were undelivered: no job receipt, acceptance, agent join, or audio. Therefore cold dispatch requires a registration-based readiness signal.

Production must not use the `inf` override; it is only the diagnostic control. Use the opt-in one-job `load_fnc` in PR-LK-liveness (`BROWSER_WORKER_ONE_JOB`, default off) only as a mitigation for the possible contributor. Publish a machine readiness signal only after the worker has registered and dispatch only after that signal; this is the required fix. Re-run the 10/5/3 matrix with the added markers before treating the dispatch path as accepted.

Committed controlled-rerun artifacts: [override 10-cycle](s0-f3-override-20261006.json), [default 5-cycle](s0-f3-default-20261006.json), [cold 1](s0-f3-cold-1-20261006.json), [cold 2](s0-f3-cold-2-20261006.json), [cold 3](s0-f3-cold-3-20261006.json), and [single default-threshold load observation](s0e-connect-sanitized.json).
