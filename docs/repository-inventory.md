# Repository Inventory

**Evidence date:** 2026-07-27

**Plan task:** FND-01

**State:** Bootstrap pushed to private GitHub `main`; PR workflow active by convention.

## Maintained product areas

| Path | Purpose | Runtime |
|------|---------|---------|
| `app/api/` | Express/TypeScript API and assessment services | Node.js |
| `app/web/` | Recruiter dashboard and browser LiveKit client | React/Vite |
| `app/voice-livekit/` | Current LiveKit voice agent | Python |
| `app/supabase/` | Current database migrations | PostgreSQL |
| `app/voice/` | Previous Pipecat voice implementation retained during migration | Python |
| `docs/` | Architecture, handover, and prototype evidence | Documentation/media |
| `_archive/v1-retell/` | Archived Retell implementation; quarantined from Git pending review | Mixed |
| `.gsd/` | Historical planning state; quarantined and superseded by `PLAN.md` | Documentation |

## Local-only and generated paths

The root `.gitignore` excludes nested `.env` files, virtual environments,
`node_modules`, build output, caches, logs, uploads, exports, recordings, and
common key/container formats. Existing nested ignore files remain in place.

The following known artifacts are quarantined from Git pending FND-02/FND-03
review and must not be committed in their current form:

- Local environment files under current and archived services.
- `docs/HELLO.html`, `docs/HELLO.md`, and `docs/hello-assets/`.
- Generated PDFs and audio/video files, including voice samples.
- Archived implementations, stale `.gsd` state, the superseded rebuild plan,
  and candidate-specific handover notes.
- Python bytecode, virtual environments, Node dependencies, and web build output.

## External completion required

The private remote and bootstrap CODEOWNER are configured. GitHub returned HTTP
403 when branch protection was applied because the private repository's current
plan does not include that feature. FND-01 remains incomplete until the plan is
upgraded (or an approved equivalent control is selected), company teams are
added, the rules in `.github/BRANCH_PROTECTION.md` are enforced, and evidence is
captured.
