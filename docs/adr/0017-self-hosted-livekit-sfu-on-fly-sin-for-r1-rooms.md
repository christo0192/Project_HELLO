# ADR-0017: Self-hosted LiveKit SFU on Fly (sin) for R1 rooms; phone stays on LiveKit Cloud

**Status:** Accepted

**Owner decision date:** 2026-10-06

**Decision owner:** Owner (product/engineering), subject to S0-F evidence

**Plan references:** `docs/design/r1/R1-PLAN-v2.md` §§2.1, 3, 4, 8, 10–11; `docs/design/r1/R1-SELFHOST-LIVEKIT-FLY.md` §§1–8

## Context

R1 could exhaust the shared LiveKit Cloud Build participant-minute pool used
by phone. A self-hosted R1-only SFU removes that coupling, but Fly UDP and
network reachability must be demonstrated. New Fly Machines cannot be placed
in Mumbai, so the approved candidate region is Singapore (`sin`).

## Decision

The preferred R1 room transport is one self-hosted LiveKit SFU on Fly `sin`,
with a dedicated IPv4, LiveKit server v1.13.7 digest pin, one Machine, WSS on
443, ICE/TCP on 7881, and ICE/UDP mux on 7882. It is R1/browser-only. Phone
continues using its existing LiveKit Cloud project, credentials, webhook, and
runtime without changes.

This decision is gated by the S0-F spike: no production self-hosted switch is
permitted until its platform, lifecycle, agent, field-matrix, and soak/drill
criteria pass. The endpoint seam is retained regardless of the outcome.

If S0-F fails, R1 uses the LiveKit Cloud Build fallback with the v2 §3.3
measured cap and pause controls. If only an always-on performance-1x SFU
passes, the owner chooses Cloud Ship or capped Build, as specified by plan v2
D16 and section 3.2. No LiveKit upgrade is authorized by this ADR.

## Consequences

- R1 self-hosting has zero LiveKit Cloud participant-minute consumption and
  cannot starve phone, but it adds single-server, UDP, certificate, key, and
  fallback operations.
- The API and worker need a per-lane endpoint seam, endpoint-aware liveness,
  host-bound worker readiness, and a coordinated drained switch.
- SFU deploys, upgrades, key rotations, and secret changes are manual and
  require zero live R1 rooms.

## Approval and evidence

The owner accepted this architecture decision on 2026-10-06. The switch to the
self-hosted SFU happens only after S0-F passes; otherwise R1 uses capped Build.
Where only always-on performance-1x passes, the owner chooses Cloud Ship or
capped Build. S0-F evidence is appended here as it lands.

## Evidence

- The Fly feasibility memo §§1–3 records the topology, UDP uncertainty,
  dedicated-IP requirement, network ports, and Cloud fallback rationale.
- R1 plan v2 §10.1 defines S0-F pass/fail thresholds and §10.2 assigns
  PR-SFU-1, PR-SFU-2, PR-LK-seam, and PR-LK-liveness.
- R1 plan v2 §3.3 defines the Cloud Build capacity formula and pause lines.

## Supersession

This supplements the existing hosting records for R1 only. It does not
supersede the phone lane's LiveKit Cloud topology or credentials. A failed
S0-F result selects the capped Cloud fallback, not a change to phone.
