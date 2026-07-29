# env-example-values — Synthetic Environment Example Values

> **is_synthetic** — Deterministic ID: `demo-env-v1-2025-06-15`
> Generated: 2025-06-15T10:00:00Z

## Purpose

This directory documents the synthetic replacement for the original
`env-example-values` artifact group (FND-03). It contains a documented
description of what the environment example values should contain and how to
generate them safely.

## Constraints

- **Never** copy literal values from any `.env` file.
- All API keys, secrets, tokens, and passwords are placeholder values.
- No real credentials, candidate data, or PII are present.

## Artifacts

| File | Description |
|------|-------------|
| `README.md` | This manifest |
| `env-example-synthetic.json` | Description of the expected env var schema with placeholder indicators |

## Environment Variables Schema

The following environment variables are used across Project HELLO components.
All secret values shown are **placeholders** — replace with real values in
local `.env` files (which are gitignored).

| Variable | Purpose | Example Value |
|----------|---------|---------------|
| `SUPABASE_URL` | Supabase project URL | `https://placeholder-project-id.example.com` |
| `SUPABASE_SERVICE_KEY` | Supabase service role key | `placeholder-service-role-key` |
| `LIVEKIT_API_KEY` | LiveKit API key | `placeholder-livekit-api-key` |
| `LIVEKIT_API_SECRET` | LiveKit API secret | `placeholder-livekit-api-secret` |
| `ANTHROPIC_API_KEY` | Anthropic Claude API key | `placeholder-anthropic-api-key` |
| `SARVAM_API_KEY` | Sarvam AI API key | `placeholder-sarvam-api-key` |
| `DEEPGRAM_API_KEY` | Deepgram API key | `placeholder-deepgram-api-key` |
| `RETELL_API_KEY` | Retell AI API key | `placeholder-retell-api-key` |
| `ELEVENLABS_API_KEY` | ElevenLabs API key | `placeholder-elevenlabs-api-key` |
| `CARTESIA_API_KEY` | Cartesia AI API key | `placeholder-cartesia-api-key` |
| `NODE_ENV` | Runtime environment | `development` |

See `config/environment.schema.json` for the canonical environment schema.

## Disposition

- **Original:** Original env-example values are quarantined — never committed.
- **Replacement:** Documented placeholder schema
- **Evidence ref:** `restricted://FND03/env-example-values/v1`
