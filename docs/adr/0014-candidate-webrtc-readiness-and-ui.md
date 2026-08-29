# ADR-0014: Candidate WebRTC readiness and audio-first invite UI

**Status:** Proposed

**Decision owner:** Owner (product/engineering) with Legal for consent copy

**Plan references:** Candidate WebRTC invite implementation plan — Steps 1–20; TST-07; GOV-08; GOV-10

## Context

The candidate invite currently combines consent, microphone acquisition, room exchange, interview rendering, and finalization in one page. It does not provide a real network readiness gate, and its transcript handler treats every non-local participant as the interviewer. The candidate experience needs a clearer, audio-only journey without weakening invite, consent, recording, or privacy boundaries.

## Decision

The candidate link uses four explicit stages:

1. Invite overview with the role title
2. Concise server-authoritative consent
3. Audio and network readiness
4. Audio-only LiveKit interview

The candidate invite remains an opaque fragment token held only in memory. Consent is recorded by the existing append-only candidate-consent endpoints. The actual invite exchange remains the only operation that consumes the one-time invite and provisions the screening room.

The readiness stage uses a separate disposable LiveKit room. Its token is short-lived, microphone-publish-only, cannot subscribe or publish data, and carries only `{channel:"preflight",schema:1}` metadata. It cannot create a grant, start egress, or modify the screening session. Both voice workers reject this marker before connecting or resolving context.

The `voice-v1` readiness policy requires a selected live microphone with measurable activity, a connected diagnostic room, outbound audio packets, a six-second uninterrupted stability window, and no reconnect. Explicitly available RTT, jitter, or packet-loss metrics must meet their limits; unavailable metrics use the documented connected/packet fallback. There is no continue-anyway path.

The route uses an IK-branded light-first glass surface with approved palette derivatives, system typography, static translucent depth, and a central logo aura driven by actual interviewer speaker levels. The aura settles to a calm state at silence and collapses to a static state under reduced-motion preferences.

## Consequences

- Candidates receive a role-first, concise, audio-only flow and a deterministic explanation when readiness fails.
- Microphone switching and preflight retry are safe because the invite is not consumed until readiness passes.
- Diagnostic rooms add short-lived provider work and require strict rate limiting and worker exclusion.
- Candidate captions are privacy-minimized: only positively identified agent speech is rendered; candidate speech is discarded before UI state.
- The separate preflight stage increases implementation and browser-test surface, but makes connection failures observable before actual room exchange.

## Evidence

- `app/supabase/migrations/0069_candidate_consent_presentation.sql` adds bounded presentation metadata without changing the required consent set or consent history.
- `app/api/src/routes/invites.ts` implements non-consuming preflight credentials with no-store responses and microphone-only grants.
- `app/voice-livekit/agent.py` and `app/voice-livekit/phone.py` reject exact preflight metadata before worker connection.
- `app/web/src/pages/CandidateJoinPage.tsx`, `app/web/src/components/candidate-join/AudioReadinessStep.tsx`, and `InterviewerAura.tsx` implement the candidate stages, readiness UI, interviewer-only captions, and measured aura.
- `docs/runbooks/candidate-webrtc-screening.md` and `docs/design/candidate-webrtc-visual-acceptance.md` define operations and acceptance checks.
- Automated API, web, and worker suites use fake media/provider boundaries; no real call is part of this decision.

## Supersession

None. This record supplements ADR-0002 (voice and model runtime), ADR-0006 (recording capture and storage), and ADR-0013 (phone screening runtime) for the browser candidate lane; it replaces none of them. Production enablement, real candidate rollout, and real calls require the protected rollout procedure and owner authorization.
