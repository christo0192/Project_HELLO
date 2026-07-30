# ADR-0005: Launch tenancy model

**Status:** Accepted

**Decision owner:** christo0192 (repository owner / sole Product/Engineering owner)

**Owner direction (2026-07-30):** The sole Product/Engineering owner has accepted
the single-org tenancy model for Interview Kickstart India, with
admin/interviewer/viewer roles and no org_id field. ADR-0005 is accepted as
architecture. See
[`docs/decisions/fnd-08-owner-approval.md`](../decisions/fnd-08-owner-approval.md).

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

Single-org IK India, admin/interviewer/viewer roles, no org_id. This decision
accepts the architectural direction but does not authorize production
implementation. Production go-live additionally requires: complete authorization
matrix, representative RLS/Realtime/storage tests, migration impact assessment,
and named organization administration process.

## Consequences

Single-org launch reduces schema and operational complexity but can make a later
multi-tenant migration expensive. Adding `org_id` now increases every query and
test surface before a product requirement exists.

## Evidence

Owner direction recorded in `docs/decisions/fnd-08-owner-approval.md`. ADR-0005
accepted as architecture. Production go-live additionally requires: signed D-011
decision, ownership model, authorization matrix, representative
RLS/Realtime/storage tests, migration impact, and named organization
administration process.

## Supersession

None. Production acceptance is a separate gate.
