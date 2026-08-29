# ADR-0014 — Candidate WebRTC readiness and audio-first invite UI

- **Status:** Implemented behind the existing candidate invite route
- **Date:** 2026-08-29
- **Scope:** `/candidate/join`

## Decision

The candidate link uses four explicit stages:

1. Invite overview with the role title
2. Concise server-authoritative consent
3. Audio and network readiness
4. Audio-only LiveKit interview

The candidate invite remains an opaque fragment token held only in memory. Consent is recorded by the existing append-only candidate-consent endpoints. The actual invite exchange remains the only operation that consumes the one-time invite and provisions the screening room.

The readiness stage uses a separate disposable LiveKit room. Its token is short-lived, microphone-publish-only, cannot subscribe or publish data, and carries only `{channel:"preflight",schema:1}` metadata. It cannot create a grant, start egress, or modify the screening session. Both voice workers reject this marker before connecting or resolving context.

## Privacy decisions

- The public context response may contain only a bounded role title; it never returns candidate PII, opaque IDs, invite material, resume data, or transcript data.
- Select-all consent is a UI convenience. The server receives every required consent type individually.
- Candidate speech transcription is discarded before React state changes. Candidate controls do not expose transcript copy, editing, export, or download.
- Device labels, device IDs, raw audio, audio levels, ICE candidates, and exact RTC metrics are not persisted or logged.

## Readiness policy

`voice-v1` requires a selected live microphone with measurable activity, a connected diagnostic room, outbound audio packets, a six-second uninterrupted stability window, and no reconnect. Explicitly available RTT, jitter, or packet-loss metrics must meet their limits; unavailable metrics use the documented connected/packet fallback. There is no continue-anyway path.

## Visual decision

The candidate route uses an IK-branded light-first glass surface with approved palette derivatives, system typography, static translucent depth, and a central logo aura driven by actual interviewer speaker levels. It contains no camera/video affordance. The aura settles to a calm state at silence and collapses to a static state under reduced-motion preferences.

## Preserved invariants

- Fragment removal and no token persistence
- Invite validation and stable invalid-invite behavior
- Consent-before-exchange and decline terminality
- Microphone-before-exchange
- One-time exchange CAS and existing maintenance gate
- Existing authoritative recording/fallback finalization and pagehide/bfcache behavior
- Browser/phone worker isolation
- No production calls or live candidate data during automated tests
