# ADR-0003: Recruiter authentication provider

**Status:** Proposed

**Decision owner:** Engineering Lead and Product Manager (unassigned)

**Plan references:** D-001, SEC-01, SEC-02, SEC-08

## Context

The prototype has no recruiter authentication or authorization. Production
requires MFA, lifecycle management, short-lived sessions, RBAC integration, and
a documented cookie-versus-bearer transport decision. WorkOS, Supabase Auth, and
Clerk are listed candidates; none is approved.

## Decision

Do not implement a provider-specific production login until D-001 is approved.
Evaluate candidates against MFA enforcement, SSO needs, account lifecycle,
session revocation, audit events, regional/contractual evidence, integration with
API authorization, operational ownership, and total cost. The selected provider
must be the token authority; do not create an unrelated application signing key
when standards-based verification is sufficient.

## Consequences

SEC-01 through SEC-04 remain blocked, and every current privileged endpoint is a
production P0. Deferring avoids embedding an auth model that conflicts with the
tenancy or transport decision.

## Direction

**Direction confirmed (2026-07-28):** Supabase Auth selected as technical direction
for email/password + SSO + MFA. This is a selected direction, not stakeholder
sign-off, and does not constitute FND-08 acceptance. See
`docs/decisions/fnd-08-inputs.md`.

## Evidence

Required before acceptance: scored provider matrix, threat-model update, proof
that issued sessions validate correctly, MFA and revocation tests,
DPA/subprocessor review, and a named operational owner.

## Supersession

None. Update this ADR to Accepted only when D-001 receives approval.
