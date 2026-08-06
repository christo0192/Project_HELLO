# ADR-0011: Recruiter single-factor authentication with server-side allowlist authorization

**Status:** Accepted

**Decision owner:** Sole Product/Engineering owner

**Plan references:** D-001, SEC-01, SEC-02, SEC-03, ADR-0003, ADR-0008

**Supersedes:** ADR-0008 § Decision bullet 3 (`aal=aal2` requirement for admin and interviewer requests). All other ADR-0008 decisions — bearer transport, Supabase token validation, server-held role resolution, narrow public endpoints, no second token copy, no cookies/CSRF — remain in force.

## Context

ADR-0008 required a verified top-level `aal=aal2` claim for admin and interviewer requests, satisfied in practice by TOTP enrollment through Supabase Auth. Operating the dashboard surfaced that requirement as an enrollment step every user must complete on a mobile authenticator app before any first use.

The owner elected to remove second-factor authentication entirely.

An intermediate proposal — delegating the second factor to Google Workspace 2-Step Verification while keeping the `aal2` gate — was investigated and **rejected as unsound**. Supabase Auth implements MFA via exactly two methods, TOTP and phone messaging, and the `aal` claim reflects only Supabase-managed enrolled factors. Identity-provider-level MFA performed during Google OAuth is not represented in the Supabase session's `aal` claim, and Google OIDC does not reliably return `amr` for 2-Step Verification. Retaining an `aal2` gate while disabling enrollment would additionally strand every new user: sign-in at `aal1`, redirect to enrollment, enrollment disabled, permanent 403.

There is therefore no verifiable token-level assurance signal available for an identity-provider second factor. The choice is between keeping a Supabase-managed factor and accepting single-factor authentication. The owner accepts single-factor authentication.

## Decision

Recruiter and admin access to the dashboard requires:

1. A valid Supabase Auth session, verified server-side via `getUser()` (never merely decoded).
2. A Supabase-**verified** email address (`email_confirmed_at` set).
3. An **active** entry in the server-held allowlist `screening_v2.email_allowlist`, resolved on every request by the `resolve_allowlist_access` SECURITY DEFINER RPC.
4. A role (`admin` / `interviewer` / `viewer`) taken from that server-held allowlist entry.

No second authentication factor is required. `aal` is no longer an authorization input at any gate.

Sign-in may be ordinary email/password or Google OAuth. Both are single-factor for the purposes of this decision.

Authorization is **never** derived from: client-supplied claims, `app_metadata`/`user_metadata`, the OAuth `hd` hint, or email domain alone. Email-domain matching is a necessary but insufficient precondition — an exact-domain match with no active allowlist entry is denied.

TOTP and phone enrollment are disabled in local Supabase configuration so that enrollment state cannot diverge from enforcement.

## Explicit owner risk acceptance

The owner explicitly accepts that dashboard access to candidate personal data, interview recordings and transcripts is protected by **a single authentication factor**. Specifically accepted:

- A compromised password or Google account grants full access at the compromised account's role, with no second factor to interrupt the attacker.
- Credential phishing, password reuse and infostealer malware become materially more effective.
- This is a reduction in assurance relative to ADR-0008 as previously accepted, taken deliberately for usability.

**Not claimed:** this ADR does not claim Google Workspace 2SV as a compensating control. Enabling 2SV at the identity provider is recommended operationally as defence in depth, but it is not verifiable by the application and must not be recorded as an implemented control.

## Controls retained

Authorization remains fail-closed and server-enforced:

- Bearer token validated through Supabase Auth on every request; 401 on malformed/missing/expired/revoked tokens.
- Unverified email → denied.
- Allowlist resolution on **every** request, not at login only, so disabling an entry revokes access immediately even with a valid unexpired JWT and a stale membership row.
- Uniform generic 403 across all denial paths (wrong domain, not allowlisted, inactive, disabled, relink) — no user enumeration.
- Role gates on privileged routes; role read server-side from the allowlist, never the client.
- Allowlist mutations remain audited (`admin_allowlist_add`, `admin_allowlist_update`) with SHA-256 email digests, never full emails.
- Admin cannot self-demote/self-disable, nor remove the last linked active admin.
- The allowlist table is service-role only: RLS enabled with no `anon`/`authenticated` grants or policies; PostgREST cannot read it.
- Short-lived access tokens with refresh-token rotation; web state cleared on logout and on API 401.
- CSP, exact CORS allowlist and rate limiting remain as recorded in ADR-0008 and SEC-07.

## Consequences

- Onboarding no longer requires authenticator-app enrollment; the allowlist is the sole access-management surface.
- Account compromise is now a single-credential event. Offboarding and incident response depend entirely on prompt allowlist disablement — which is immediate, since resolution happens per request.
- The MFA enrollment and challenge routes are retired; the underlying pages are retained unrouted so restoring a Supabase-managed factor is a localized change.
- Reinstating MFA later requires re-enabling enrollment in Supabase configuration **and** restoring both gates together (see ADR-0008 § Decision bullet 3).

## Evidence

- Supabase MFA factor types and `aal2` semantics: `https://supabase.com/docs/guides/auth/auth-mfa`
- Deterministic API and web regression tests covering: unlisted user denied; inactive/revoked user denied; allowlisted ordinary sign-in admitted with correct role; role gates enforced; token/JWT validation retained; no data rendered before role resolution; stale session fails closed.
- Security review of the rejected identity-provider-assurance proposal: `/tmp/totp-security-review.md`.

## Residual gates

Unchanged from ADR-0008 and not addressed here: FND-05/FND-06, deployed CSP evidence, account recovery/lifecycle controls, independent Security review, and production Supabase ownership/access evidence. Production acceptance additionally requires a second organization owner and a tested break-glass procedure (MIG-01/MIG-02), which remain outstanding.

## Supersession

None. Supersede this ADR if a second factor is reinstated, or if a verifiable identity-provider assurance signal (custom access token hook backed by a trustworthy source, or SAML `AuthnContextClassRef`) is designed, evidenced and approved.
