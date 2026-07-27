# ADR-0001: Decision record process

**Status:** Accepted

**Decision owner:** Engineering Lead (unassigned)

**Plan references:** FND-07

## Context

Production decisions are currently split between `PLAN.md`, historical local
notes, and implementation details. Reviewers need a durable record that clearly
separates current facts, proposals, approved decisions, and superseded choices.

## Decision

Store architecture decisions as numbered Markdown records under `docs/adr/`.
Every record must identify its status, accountable owner, plan references,
consequences, verification evidence, and supersession path. `PLAN.md` owns work
and launch gates; ADRs own decision rationale.

Accepted ADR outcomes are immutable. A changed decision receives a new number
and the prior record is marked superseded with a link to its replacement.

## Consequences

Architecture changes gain a small documentation and review cost. In return,
security, legal, operations, and engineering can identify what is binding and
why without relying on stale handover notes.

## Evidence

CI runs `scripts/check-adrs.mjs` to validate naming, required sections, statuses,
unique IDs, and index coverage.

## Supersession

None.
