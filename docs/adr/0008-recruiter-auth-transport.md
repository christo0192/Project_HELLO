# ADR-0008: Recruiter authentication transport

**Status:** Accepted

**Partial supersession:** § Decision bullet 3 (the `aal=aal2` requirement) is superseded by ADR-0011. All other decisions in this record remain binding.

**Decision owner:** Sole Product/Engineering owner

**Plan references:** D-001, D-011, SEC-01, SEC-02, SEC-03, SEC-08, FND-05, FND-06

**Scope note (2026-07-30):** Accepted for internal synthetic engineering only; production acceptance remains pending.

## Context

The browser recruiter dashboard and Express API require a transport that works with Supabase Auth, supports MFA, and does not introduce another session-signing secret. The project remains pre-production, zero-incremental-cost and browser-only. FND-05 secret management, FND-06 deployed service identities, hosted SSO/MFA configuration and independent Security review remain pending.

## Decision

Use the Supabase access token as an `Authorization: Bearer` token for recruiter API calls.

- The API validates the token through Supabase Auth before reading its bounded JWT claims.
- Recruiter role and active state come from `screening_v2.recruiter_memberships` in the production/default path, not browser-controlled metadata.
- ~~Admin and interviewer requests require a verified top-level `aal=aal2` claim.~~ **Superseded by ADR-0011:** no second factor is required. Authorization is an active entry in the server-held `screening_v2.email_allowlist` plus the role held there, resolved on every request. `aal` is no longer an authorization input.
- Public endpoints are narrowly enumerated and authenticate with their own one-time candidate grant or worker credential.
- The application does not add a second token copy. Supabase JS still persists its session as plaintext JSON in browser local storage by default.
- Cookies and a custom CSRF token are not introduced. Cross-site forms cannot attach the bearer header, while CORS restricts browser response access. XSS remains the principal browser token-theft risk.

## Controls

- Enforced CSP without `unsafe-inline`/`unsafe-eval` remains the target; report-only/deployed clean-window evidence is pending SEC-07.
- Access tokens are short-lived and refresh-token rotation is enabled in local Supabase configuration.
- The web app clears state on logout and API 401.
- Tokens are prohibited from URLs, DOM output, logs, audit metadata and application-managed storage. Candidate invite secrets use URL fragments and are removed from browser history before exchange.
- Authentication, authorization and rate-limit failures return stable redacted responses.

## Rejected alternatives

- **Custom API session JWT:** adds signing-key lifecycle and duplicates Supabase Auth.
- **HttpOnly application cookie now:** requires a server-side token-exchange/session layer and CSRF implementation that is not needed for the chosen browser-first architecture.
- **Treating local storage as encrypted:** false; Supabase JS persistence is plaintext and must be documented as an XSS residual.

## Consequences

The dashboard and API share the Supabase Auth lifecycle and avoid a second signing-key system. Browser XSS can still steal the SDK's plaintext-persisted session, so CSP and dependency controls remain load-bearing. API clients must attach bearer tokens and candidate/worker routes must use separate narrow credentials.

## Evidence

Local deterministic API/web authorization, AAL, token-storage and cross-site-header tests are required for implementation. Hosted SSO/MFA, account recovery, deployed CSP and independent Security evidence are required before production acceptance.

## Residual gates

Production acceptance requires FND-05/FND-06, authentic hosted MFA and SSO configuration/evidence, deployed CSP evidence, account recovery/lifecycle controls, independent Security review and production Supabase ownership/access evidence.

## Supersession

Partially superseded by **ADR-0011** (recruiter single-factor authentication with server-side allowlist authorization), which removes the `aal=aal2` requirement in § Decision bullet 3 and records explicit owner risk acceptance of single-factor authentication. All other decisions in this ADR remain in force.

Supersede the remainder of this ADR if the application adopts server-managed HttpOnly sessions or another identity provider.
