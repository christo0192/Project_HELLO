# Current State Manifest

**Evidence date:** 2026-07-30

This file documents the purpose, structure, and invariants of the
machine-readable current-state manifest at `config/current-state.json`.

The manifest is **not** a roadmap. `PLAN.md` remains the sole roadmap and
launch-gate authority. Phase 1 implementation and residual gates are recorded
in `docs/runbooks/phase1-security-core.md`. The manifest records current implementation and
deployment status so that automated drift checks can detect semantic
contradictions (production claims, gate-count changes, stale-provider
promotion, telephony-as-current) without fragile paragraph matching.

## Schema

`config/current-state.schema.json` (JSON Schema draft-07) defines the allowed
shape. Every manifest field is described there.

## Key invariants

| Invariant | Enforcement |
|---|---|
| `status.production` must be `"pre-production"` | Drift checker fails if any other value |
| `status.dataStage` must be `"synthetic-only"` | No real candidate PII in repo |
| `status.scope` must be `"browser-only"` | Telephony is future/separately gated |
| `gates.launchGatesComplete` must be `0` | No launch gates are complete (0/17) |
| `gates.launchGatesTotal` must match `PLAN.md` | Currently 17 launch gates; derived by the checker |
| `phases.acceptedPhasesComplete` must be `0` | 0/14 roadmap phases accepted |
| `phases.acceptedPhasesTotal` must match `PLAN.md` | Currently 14 contiguous phases (0–13); derived by the checker |
| Pipecat **must** be listed as stale | Not an active production fallback |
| Retell **must** be listed as stale | Archived; not active |
| No stale provider can have `"current"` or `"active"` status | Prevents backslide |
| No provider can appear in both `active` and `stale` | Structural integrity |
| Manifest and active-component paths remain inside the repository | Rejects absolute paths, traversal, missing paths, and non-directories |
| README, app runtime map, handover, and this document retain load-bearing state markers | Detects stale merged-PR, runtime, gate, phase, and scope claims |

## File inventory

| File | Purpose |
|------|---------|
| `config/current-state.json` | Machine-readable manifest |
| `config/current-state.schema.json` | JSON Schema for validation |
| `scripts/check-current-state.mjs` | Deterministic drift checker |
| `scripts/check-current-state.test.mjs` | Negative tests for the checker |

## CI integration

The `quality.yml` workflow runs:
```
node scripts/check-current-state.mjs
node scripts/check-current-state.test.mjs
```

Both must exit 0 for the workflow to pass.

## Updating

To update the manifest:

1. Edit `config/current-state.json` with the new evidence date and changed fields.
2. Run `node scripts/check-current-state.mjs` to verify.
3. Run `node scripts/check-current-state.test.mjs` to verify negative tests still pass.
4. Update `docs/current-state.md` if the schema or invariants change.
5. Commit all changes together.

Never change the manifest without also running the drift checker and tests.
