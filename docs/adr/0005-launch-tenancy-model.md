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
future organization isolation through `org_id`. The original prototype had
neither authenticated ownership nor tenant isolation. The merged membership-gated
RLS baseline (PR #9) gates limited read-only dashboard access by active recruiter
membership, but full application Auth, API RBAC, and hosted role authorization
remain pending (SEC-01 through SEC-04, MIG-05, MIG-06).

## Decision

Proceed with the single-organization launch technical direction. No multi-tenant
`org_id` isolation is required for launch; this does not permanently ban future
multi-tenancy. Formal acceptance still requires signed owner approval, a
complete authorization matrix, representative RLS/Realtime/storage tests,
migration impact assessment, and a named organization administration process.

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
