# ADR-0005: Launch tenancy model

**Status:** Proposed

**Direction confirmed (2026-07-28):** Single-organization launch selected as
technical direction. No multi-tenant `org_id` isolation required for launch;
does not permanently ban future multi-tenancy. The merged membership-gated RLS
baseline (PR #9) provides a production-safe local seam, but full app
authentication, API authorization, RBAC, storage authorization, and hosted role
configuration are still pending. Formal
owner approval and evidence pending. This is a selected direction, not
stakeholder sign-off, and does not constitute FND-08 acceptance.

**Decision owner:** Engineering Lead and Product Manager (unassigned)

**Plan references:** D-011, FND-08, SEC-03, MIG-03, MIG-04

## Context

Multi-tenant SaaS is a launch non-goal, but the production schema and RLS design
depend on whether launch is explicitly single-organization or must preserve
future organization isolation through `org_id`. The current schema has neither
authenticated ownership nor tenant isolation.

## Decision

Recommend a documented single-organization launch unless Product approves a
concrete multi-tenant requirement before schema hardening. A single-org decision
still requires authenticated roles, least-privilege API authorization, RLS, and
tests proving anonymous and unauthorized access fail. If multi-tenancy is
approved, add immutable organization ownership to every scoped row and enforce
it in API queries, RLS, Realtime, storage paths, jobs, and audit events before
production data migration.

## Consequences

Single-org launch reduces schema and operational complexity but can make a later
multi-tenant migration expensive. Adding `org_id` now increases every query and
test surface before a product requirement exists.

## Evidence

Required before acceptance: signed D-011 decision, ownership model, authorization
matrix, representative RLS/Realtime/storage tests, migration impact, and named
organization administration process.

## Supersession

None. Update this ADR to Accepted only when D-011 receives approval.
