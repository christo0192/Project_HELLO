# R1 WebRTC interview bot design

**Status:** Approved by owner 2026-10-06; implementation in progress.

R1 is the Sales Program Advisor browser role-play. It is a separate lane: the
phone interview remains on LiveKit Cloud and is out of scope.

## Reading order

1. [R1-PLAN-v2.md](R1-PLAN-v2.md) — owner summary and the controlling
   self-hosted-LiveKit changes. Where it differs from the final plan, v2 wins.
2. [R1-PLAN-final.md](R1-PLAN-final.md) — full conversation, scoring,
   recording, data-model, isolation, and delivery design.
3. [R1-SELFHOST-LIVEKIT-FLY.md](R1-SELFHOST-LIVEKIT-FLY.md) — the Fly `sin`
   self-hosted SFU feasibility memo and S0-F go/no-go criteria.
4. [R1-SCOUT-isolation-map.md](R1-SCOUT-isolation-map.md) — browser-lane code
   map and the boundary that protects the phone lane.

## PR roadmap

The following combines v2 §10.2's self-host additions with final §10.2's
delivery sequence. The linked plans remain the normative detail and acceptance
criteria.

| Order | PR / work | Scope |
|---|---|---|
| 0 | PR-pre | CI-expiry remediation, evidence refresh, and expiry calendar. |
| 1 | PR-dep | Pin the running worker dependency closure and freeze-diff it. |
| 2 | PR-0 | Design records, runbooks, credential inventory, and data classification. |
| 3 | PR-SFU-1 | R1-only Fly SFU configuration, pinned image/configuration, validator, and region scope. |
| 4 | PR-SFU-2 | Manual SFU deployment procedure, zero-room precheck, health probe, and validator tests. |
| 5 | PR-1 / M1 + M1b | R1 data foundation, admission, isolation fences, and migration tests. |
| 6 | PR-2 / M2 | R1 lifecycle/admin routes, settings, ledger, configuration, and legacy guards. |
| 7 | PR-L | Retire and drain the legacy browser lane before Stage A. |
| 8 | PR-LK-seam | Per-lane LiveKit endpoint selection, browser call sites, no-egress branch, Cloud fallback tests. |
| 9 | PR-LK-liveness | Endpoint-aware reaper/terminal release and post-registration host-bound worker readiness. |
| 10 | PR-3 | Candidate R1 consent, preflight, attempts/exchange, and rate limiting. |
| 11 | PR-4a / 4b / 4c | Worker core, deterministic role-play content, and latency/TTS work. |
| 12 | PR-5 / M3 | Isolated R1 assessment queue/scorer, audited pending reject, and dashboard views. |
| 13 | PR-6 / PR-7 / PR-CT | Candidate join/notice UI, HR controls, then Legal-approved consent templates. |
| 14 | PR-8 / M4 | R2 recording API, finalization, playback, retention sweep, and DSAR support. |
| 15 | PR-9a / PR-9b / PR-10 / PR-V | In-worker encoder/streaming, player, and gated video enablement. |
| 16 | Owner step / PR-C2 | Provision the initial worker after recording work; post-launch per-machine scaling only after Stage C. |

The selected production transport is self-hosted only if S0-F passes. Otherwise
R1 uses the documented LiveKit Cloud fallback cap; no LiveKit upgrade is
authorized.
