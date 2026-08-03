# HELLO Dashboard Access Runbook

Scope: HELLO dashboard access control — the normalized-email allowlist
(`email_allowlist`) and the per-request Google Workspace / company-email
access gate. This runbook is **truthful**: it documents what the system
actually does, the exact server/DB enforcement, and the intentional
boundaries.

---

## 1. Access model (server + DB enforced, never client)

- **Source of truth**: the verified Supabase Auth `user.email` — the email
  Supabase itself confirmed (`email_confirmed_at` set). OAuth `hd` (Google
  hosted-domain hint) is **never** used for authorization; it is a hint only.
- **Normalization** (strict, identical in the API and the DB RPC):
  trim whitespace → reject any non-ASCII printable character (unicode
  lookalikes) → lowercase → strip a `Display Name <email>` wrapper →
  require **exactly one `@`** → require the **exact** domain
  `interviewkickstart.com` (no subdomains, no suffix tricks). Anything else
  is a denial.
- **Denials are uniform**: every failure path (wrong domain, not allowlisted,
  disabled entry, missing entry, relink attempt, unverified email) returns
  the identical generic 403
  `{"error":{"type":"authorization_error","message":"Insufficient permissions"}}`.
  Nothing distinguishes the reason.
- **Never trusted from the client**: role, email, and user id are always
  resolved from the server allowlist / verified token. `app_metadata` is a
  legacy vestige; the per-request RPC is authoritative.

## 2. The allowlist table (`screening_v2.email_allowlist`)

| Column | Meaning |
|--------|---------|
| `id` | opaque uuid |
| `email` | canonical ASCII display form (normalized) |
| `email_normalized` | canonical key — lowercase ASCII, exactly one `@`, exact company domain; **UNIQUE** |
| `role` | `admin` / `interviewer` / `viewer` (CHECK) |
| `active` | entry enabled; default `true` |
| `linked_user_id` | nullable **UNIQUE** auth.users id — set atomically on first verified login |
| `linked_at` | first-login timestamp (nullable, consistent with `linked_user_id`) |
| `created_at` / `updated_at` | timestamps |

- **Independent of `auth.users`**: entries can be provisioned before the
  person ever logs in. Bootstrap seeds exactly the three confirmed launch
  admins (`gopu.nair@`, `christo.b@`, `jerin@` — all `@interviewkickstart.com`,
  role `admin`, active) with **no** auth.users dependency.
- **RLS**: enabled, with **zero** anon/authenticated grants or policies —
  PostgREST/browser roles can never read or write it directly. Only
  `service_role` (the API's server client) can.

## 3. Per-request access resolution (`resolve_allowlist_access`)

The API auth middleware calls `resolve_allowlist_access(user_id, email)` on
**every** authenticated request (SECURITY DEFINER, fixed `search_path =
pg_catalog, screening_v2`, service-role-only). The RPC:

1. Normalizes + domain-checks the email (identical rules to §1).
2. Locks the matched entry (`FOR UPDATE`) — serialises concurrent
   first-logins and admin mutations.
3. Denies (`denied`) when the entry is **missing**, **inactive** (a disabled
   allowlist denies **even with a valid old JWT and/or a stale active
   membership row**), or **already linked to a different user** (relink
   protection — one email, one user, forever).
4. **Links on first login** (idempotent for the same user).
5. **Creates/updates `recruiter_memberships`** from the server-held allowlist
   role/active — role changes propagate on the user's next request; a stale
   membership row never grants access.
6. Audits the link **once** (`allowlist_linked`) with an email **SHA-256
   digest** in metadata — the full email never reaches audit metadata.

Consequences:

- A non-allowlisted `@interviewkickstart.com` account → 403 (identical to
  `@gmail.com`).
- An admin demotes/removes a user in the allowlist → that user's **next
  request** is denied, regardless of their existing JWT or membership row.
- Email/password sign-in and OAuth both obey the same rule — the resolver is
  in the shared auth middleware.
- The livekit **recruiter recording-upload** path uses the SAME shared
  `resolveFullAuth` seam (token → verified email → allowlist resolver →
  server-held role → AAL gate) — a revoked/disabled/non-allowlisted
  recruiter cannot upload even with a valid old JWT and an active
  membership row. There is no weaker duplicate auth implementation. The
  candidate **grant-token** upload path (public, `x-grant-token`) is
  intentionally independent of the allowlist.

## 4. Admin management APIs (all admin-only, audited, atomic)

| Endpoint | Purpose | Stable statuses |
|----------|---------|-----------------|
| `GET /api/admin/allowlist` | list entries (id, email, role, active, linked_user_id, linked_at) | 200, 403 |
| `POST /api/admin/allowlist` | add email + role (server-side normalization; new entries **active**) | 201, 400 `invalid_email`/`invalid_role`, 409 `duplicate` |
| `PATCH /api/admin/allowlist/:id` | change role/active (disable/demote) | 200, 400 `invalid_role`/`no_changes`, 404 `not_found`, 409 `self_modification_denied`/`last_linked_active_admin` |

- **Add**: `add_allowlist_entry` normalizes identically to the resolver.
  Duplicate case/whitespace variants conflict via the unique normalized
  index → 409 `duplicate`. Audit `admin_allowlist_add` (email digest only) in
  the **same transaction** (fail-closed — a failed audit aborts the add).
- **Update/disable**: `update_allowlist_entry` locks the row, then:
  - **self-modification guard** — an admin cannot disable or demote their own
    linked entry (409 `self_modification_denied`);
  - **last-linked-admin guard** — the last **linked** active admin can never
    be removed; **pending (unlinked) admin entries do NOT satisfy the
    safety check** (409 `last_linked_active_admin`);
  - changes propagate atomically to the linked `recruiter_memberships` row;
  - audit `admin_allowlist_update` (role/active + email digest) in the same
    transaction.
- No delete endpoint exists (disable is the supported operation).
- Actor id is always derived from `req.authUser` — never accepted from the
  request body (schemas are `.strict()`).

## 5. Runbook: common operations

### Add a new allowed email

```
POST /api/admin/allowlist
{ "email": "alice@interviewkickstart.com", "role": "interviewer" }
→ 201 { "ok": true, "id": "<uuid>" }
```

The person signs in with their Google Workspace account; the first request
links the entry and creates their membership automatically.

### Disable a person (immediate)

```
PATCH /api/admin/allowlist/:id
{ "active": false }
→ 200 { "ok": true }
```

Their next API request is denied (the per-request resolver checks `active`)
even if their JWT is still valid.

### Demote an admin (with safety)

Demoting an admin is allowed only while at least one **linked** active admin
remains. Pending admins (emails added but never signed in) do **not** count.

### Cannot self-disable

An admin cannot disable or demote their own linked entry (409
`self_modification_denied`). A second active linked admin must perform the
change.

## 6. Failure modes

- **DB read failure** in the resolver → uniform 403 (fail closed). A stale
  membership row or valid JWT never silently grants access.
- **Audit sink failure** in an admin mutation → the mutation is aborted
  (fail-closed RPC: audit row is in the same transaction).
- **Unverified email** (`email_confirmed_at` missing) → 403, never proceeds
  to the allowlist lookup.
- **Duplicate add** (any case/whitespace variant of an existing normalized
  email) → 409 `duplicate`.
- **Relink attempt** (same allowlisted email, different auth.users id) →
  denied by the resolver (entry stays linked to the original user).

## 7. Verification

- `app/api/src/__tests__/auth-rbac-rate-audit.test.ts` — normalization and
  per-request gate matrix (wrong domain, gmail, subdomain/suffix/unicode
  tricks, display-name, unverified, disabled-allowlist-vs-valid-JWT).
- `app/api/src/__tests__/admin.test.ts` — allowlist list/add/update, RPC
  delegation, stable statuses, self/last-linked-admin guards, minimization.
- `app/api/src/__tests__/validation.test.ts` — schema boundary (strict,
  bounded, uuid param).
- `app/api/src/__tests__/recordings.test.ts` — the livekit recruiter upload
  path uses the shared `resolveFullAuth` seam: valid-old-JWT-but-allowlist-
  missing/inactive → 403, wrong-domain → 403, allowlisted recruiter → 200,
  and the grant-token path is unchanged (200 without any allowlist).
- `app/supabase/tests/policy_tests.sql` — RLS/grants/bootstrap/constraint/
  RPC-service-role-only static assertions (run against local synthetic
  Supabase; `supabase db reset` applies migrations + seed).
- `app/web/src/pages/LoginPage.test.tsx` and
  `app/web/src/lib/__tests__/auth.test.tsx` — login UX, company-only
  messaging, generic errors, and the UX-only `isCompanyEmail` helper.

## 8. Residuals / boundaries (truthful)

- No production OAuth setup is faked: the Google Workspace button renders
  only when `VITE_SSO_PROVIDERS` includes `google`; the server is the
  enforcer regardless.
- `recruiter_memberships` role/active are now synced from the allowlist on
  every request — the members page remains for visibility; the allowlist is
  the source of truth for access.
- The candidate grant-token upload path is deliberately allowlist-
  independent (it authenticates the candidate grant, not a recruiter).
