# ADR-0003: Recruiter authentication provider

**Status:** Accepted

**Decision owner:** christo0192 (repository owner / sole Product/Engineering owner)

**Plan references:** D-001, SEC-01, SEC-02, SEC-08

**Owner-approval update (2026-07-30):** The sole Product/Engineering owner has
accepted Supabase Auth (email/password + SSO + MFA) as the architecture for
recruiter authentication. ADR-0003 is accepted as architecture/owner direction.
This does NOT constitute production/go-live acceptance. Production additionally
requires named Security Lead, DPA/subprocessor evidence, MFA/SSO/audit
enforcement, account lifecycle, session revocation, and operational ownership.
See [`docs/decisions/fnd-08-owner-approval.md`](../decisions/fnd-08-owner-approval.md).

## Context

The prototype has no recruiter authentication or authorization. Production
requires MFA, lifecycle management, short-lived sessions, RBAC integration, and
a documented cookie-versus-bearer transport decision. WorkOS, Supabase Auth, and
Clerk are listed candidates.

**Owner direction (2026-07-30):** Supabase Auth selected: email/password + SSO +
MFA. ADR-0003 accepted as architecture. See
`docs/decisions/fnd-08-inputs.md` and `docs/decisions/fnd-08-owner-approval.md`.

## Decision

Supabase Auth with email/password, SSO, and MFA enforcement is the selected
architecture for recruiter authentication. This decision accepts the
architectural direction but does not authorize production implementation.
Production go-live additionally requires: scored provider matrix, threat-model
update, proof that issued sessions validate correctly, MFA and revocation tests,
DPA/subprocessor review, and a named operational owner.

## Consequences

SEC-01 through SEC-04 remain blocked for production acceptance, and every
current privileged endpoint is a production P0. The architectural decision is
now recorded; production implementation and evidence remain pending.

## Evidence

Owner direction recorded in `docs/decisions/fnd-08-owner-approval.md`. ADR-0003
accepted as architecture. Production go-live additionally requires: scored
provider matrix, threat-model update, proof that issued sessions validate
correctly, MFA and revocation tests, DPA/subprocessor review, and a named
operational owner.

## Supersession

None. Production acceptance is a separate gate.
