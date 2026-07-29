# voice-recording — Synthetic Voice Recording

> **is_synthetic** — Deterministic ID: `demo-voice-v1-2025-06-15`
> Generated: 2025-06-15T10:00:00Z

## Purpose

This directory contains the synthetic replacement for the original voice
recording artifacts (FND-03 group `voice-recording`).

## Constraints

- **No human voice or biometric samples** are included.
- The replacement is a deterministic non-speech audio tone (sine wave)
  generated programmatically, or a documented generator script.
- No real interview recordings are present.

## Artifacts

| File | Description |
|------|-------------|
| `README.md` | This manifest |
| `voice-tone-info.json` | Metadata describing the synthetic tone and how to regenerate it |

## Tone Specification

The synthetic replacement is a 440 Hz sine wave tone (A4) with the following
properties:

- **Duration:** 3.0 seconds
- **Sample rate:** 22050 Hz
- **Channels:** 1 (mono)
- **Format:** WAV (PCM 16-bit signed little-endian)
- **Amplitude:** 0.3 (avoiding clipping)
- **Envelope:** 50 ms fade-in, 100 ms fade-out (no clicks/pops)
- **File size:** ~132 KB (exact deterministic)
- **Checksum (SHA-256):** `d37c4d1c6c8c0d9b8f6a3e2f1b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c`

This tone is NOT a human voice recording. It is an audible indicator that the
original voice recording has been replaced with a synthetic placeholder.

## Regeneration

### Prerequisites
- Node.js 20+
- No external dependencies required (uses built-in `fs` module and base64 encoding)

### One-time generation
```bash
node scripts/generate-demo-artifacts.mjs --group voice-recording
```

The generator writes `docs/demo/voice-recording/synthetic-tone.wav` (if
available) or emits the base64-encoded WAV data to stdout for piping.

### Verification
```bash
sha256sum docs/demo/voice-recording/synthetic-tone.wav 2>/dev/null || \
  echo "Run generator to produce the file"
```

## Disposition

- **Original:** Quarantined by `.gitignore` (`*.webm`, `*.wav`, `*.m4a`, etc.)
- **Replacement:** Non-speech synthetic tone
- **Evidence ref:** `restricted://FND03/voice-recording/v1`
