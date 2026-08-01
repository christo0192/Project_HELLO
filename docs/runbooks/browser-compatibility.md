# Browser Compatibility Runbook (Phase 8 Lane L2)

> **STATUS: PROPOSED**
>
> This document is a proposal. The support policy is **PENDING** product + SRE + legal sign-off.
>
> - No real-device execution has been performed.
> - No hardware test results are included or claimed.
> - No browser-version certification is claimed anywhere in this document.
> - Every browser support matrix row and expected gate result is labelled **PROPOSED**.

---

## 1. Purpose

The candidate voice-screening join flow must not let a candidate attempt to join when the browser cannot capture a microphone or establish a WebRTC peer connection.

The capability detection gates **only** on API presence. It does not attempt to measure audio quality, device availability, permissions, or network readiness. When a browser is detected as unsupported, the flow renders a truthful, generic unsupported message.

## 2. Detection Gate (Exact Technical Behavior)

Detection is synchronous, pure, and deterministic.

Checks performed, in this order:

1. `typeof navigator.mediaDevices.getUserMedia === "function"`
2. `typeof RTCPeerConnection === "function"`

If either check fails, the browser is reported as `missing` for that API. A browser is considered supported only when **both** required APIs are present.

Deliberately **not** performed during detection:

- No user-agent string parsing.
- No `navigator.mediaDevices.enumerateDevices()` call.
- No invocation of `getUserMedia` during detection (this would trigger a microphone permission prompt).
- No permission query.
- No async/race window: the Join button is never rendered until the synchronous check settles.

Unknown browsers that expose both required APIs **pass**. No allow/deny list is applied.

Actual microphone permission denial or device failure is **not** part of detection. It surfaces later at join time inside the existing `createLocalAudioTrack()` try/catch and shows the same truthful generic UI. No tokens or internal errors are ever exposed.

## 3. User Experience

| State | Behavior |
| --- | --- |
| **Checking** | No join affordance is rendered. This prevents the enable-before-check race. |
| **Supported** | Existing consent gates are unchanged: privacy notice review is shown; joining requires consent granted; the one-time invite fragment is consumed/removed on mount regardless. |
| **Unsupported** | Generic message is shown: `"browser does not support the microphone and WebRTC features this screening requires; use a current version of a supported browser"`. The message has `role=alert`. The Join button is not rendered. |

## 4. PROPOSED Browser Support Matrix

> **PROPOSED**: All rows below are pending support policy sign-off. They do **not** claim real-device execution or certification.

| Browser family | Version policy | Expected gate result | Status |
| --- | --- | --- | --- |
| Chromium-based (Chrome, Edge, Brave, Opera) | Current and previous major release; exact version policy is PENDING | PROPOSED: both APIs present | **PROPOSED** |
| Firefox | Current and previous major release; exact version policy is PENDING | PROPOSED: both APIs present | **PROPOSED** |
| Safari | Current and previous major release; exact version policy is PENDING | PROPOSED: both APIs present | **PROPOSED** |
| Unknown/other browsers | Not versioned; rule: passes iff both required APIs are present (no UA allow/deny list) | PROPOSED: pass if `getUserMedia` function AND `RTCPeerConnection` function; otherwise unsupported | **PROPOSED** |

## 5. Non-Goals / Out of Scope

- No browser allow/deny lists by user-agent string.
- No camera checks; audio only.
- No network/permission diagnostics.
- No telemetry collection of browser fingerprint.
- No changes to invite, consent, or API contracts.

## 6. Verification

Where implemented:

- Capability check: `app/web/src/lib/capability-check.ts`
- Wired in: `app/web/src/pages/CandidateJoinPage.tsx`

Vitest coverage includes:

- Both APIs present → check passes.
- `getUserMedia` missing → check blocks.
- `RTCPeerConnection` missing → check blocks.
- Both APIs missing → check blocks.
- Non-function `getUserMedia` → treated as missing.
- Negative controls proving no UA parsing is performed.
- Negative controls proving no `enumerateDevices()` behavior is invoked during detection.
- CandidateJoinPage tests for checking, supported, and unsupported states.

All test results are unit-test-only. No real-device execution, hardware validation, or browser-version certification is claimed.