# AI HR Voice Screening Application

This directory contains the current browser-first prototype described in the
root `PLAN.md`. It is not production-ready and must not process real candidate
data outside an approved development environment.

## Current runtime

- `api/`: Express/TypeScript API, Supabase access, resume parsing, LiveKit room
  creation, transcript/session APIs, and prototype assessment generation.
- `web/`: React/Vite recruiter dashboard and browser LiveKit client.
- `voice-livekit/`: LiveKit Agents worker using Sarvam STT/TTS, Anthropic Haiku,
  Silero VAD, and the multilingual turn detector.
- `supabase/`: prototype `screening_v2` schema and migrations.

`voice/` is the previous Pipecat implementation retained only as a local
rollback/reference path during migration. It is not the target production voice
runtime.

## Local development

Use each component's `.env.example` as a variable-name contract and populate a
local ignored `.env` with isolated development credentials. Never use staging or
production credentials in local files.

Run the API, web client, and LiveKit worker from their component directories as
documented in `voice-livekit/README.md`. The normal local ports are API `8787`
and web `5173`.

## Production status

`PLAN.md` is the sole roadmap and launch-gate source. Phase 0 Foundation is in
progress. Authentication, authorization, worker-only LiveKit context, durable
jobs, approved recording, observability, migration, governance, and launch tests
remain production blockers.
