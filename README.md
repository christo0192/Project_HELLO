# Project HELLO

Project HELLO is a browser-first AI voice-screening prototype for structured HR
interviews. The current implementation connects a React dashboard, a Node API,
a LiveKit voice worker, and Supabase persistence.

The system is pre-production. Do not use it with real candidate data until all
P0 gates in `PLAN.md` are complete.

## Source of truth

- `PLAN.md`: production-readiness roadmap, architecture, decisions, and launch
  gates.
- `config/current-state.json`: machine-readable current implementation and
  deployment status (not a second roadmap).
- `app/README.md`: current runtime map and local development entry points.
- `docs/configuration.md`: environment separation and validation contract.
- `docs/adr/`: current and proposed architecture decision records.
- `docs/current-state.md`: documentation of the current-state manifest schema
  and invariants.
- `docs/repository-inventory.md`: Foundation inventory and quarantine state.
- `docs/HANDOVER.md`: current delivery state, production blockers, and exact
  next-step resume instructions.

Phase 0 Foundation is active. Historical implementation notes and candidate
evidence remain local and quarantined from Git pending security review.
