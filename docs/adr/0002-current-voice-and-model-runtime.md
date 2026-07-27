# ADR-0002: Current voice and model runtime

**Status:** Accepted

**Decision owner:** Engineering Lead (unassigned)

**Plan references:** D-004, D-005, FND-07, LLM-01

## Context

The browser prototype uses a LiveKit Agents worker with Sarvam STT/TTS, Silero
VAD, the local multilingual turn detector, and Anthropic Haiku for conversation.
Post-session scoring runs synchronously through `claude -p`. Historical Pipecat
and Retell implementations are not the target runtime.

## Decision

Record LiveKit Agents plus Sarvam and Anthropic as the current MVP runtime only.
Keep `app/voice/` as a local rollback/reference implementation during migration.
Do not treat current provider use as production approval or change STT, TTS,
conversation LLM, scoring provider, or LiveKit hosting without the evaluation,
contract, region, and capacity evidence required by `PLAN.md`.

## Consequences

Engineering has one unambiguous current path while provider and hosting choices
remain gated. The worker still carries prototype risks: client-visible context,
direct persistence, synchronous scoring trigger, and unapproved recording flow.

## Evidence

- `app/voice-livekit/agent.py` defines the active conversation pipeline.
- `app/voice-livekit/persistence.py` shows current persistence/scoring behavior.
- `app/api/src/services/assessment.ts` shows the current scoring implementation.
- Provider production decisions remain open under D-004 and D-005.

## Supersession

None. A production provider or hosting selection must supersede this record.
