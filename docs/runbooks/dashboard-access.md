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
  require **exactly one `@`** → require one of the **exact** domains
  `interviewkickstart.com` or `dexity.com` (no subdomains, no suffix tricks;
  `dexity.com` added by migration 0133 for the company domain switch).
  Anything else is a denial.
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
| `email_normalized` | canonical key — lowercase ASCII, exactly one `@`, exact company domain (`interviewkickstart.com` or `dexity.com`); **UNIQUE** |
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
7. **Same-login continuity (0133).** If this login is already linked to an
   **active** entry under another accepted address AND the presented address
   is the verified email of this login's **Google identity**
   (`auth.identities`, provider `google`), the person is carried over:
   - no entry for the new address: the entry moves to it (`allowlist_linked`,
     `change: email_updated`);
   - an admin had pre-added the new address: the link moves to that entry,
     the new entry's role applies, and the old entry is **disabled, unlinked
     and demoted to viewer** so a recycled old address can never inherit
     access (`change: link_moved`). A move never leaves zero linked active
     admins: if the old entry was the last one, the new entry keeps admin
     (`role_kept_admin`).

   The Google-identity proof matters: a user can change their own Supabase
   email through the public Auth API, but not the email Google reports for
   their Workspace account. Without the proof, a disabled old entry, or a
   non-company address, the answer is the same uniform 403.

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
| `POST /api/admin/allowlist/:id/handover` | move the records owned by entry `:id`'s login to `to_entry_id`'s login (0133) | 200 (+ per-table counts), 400 `same_entry`, 404 `not_found`, 409 `from_not_linked`/`to_not_linked`/`to_inactive` |

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

### Company domain switch to `@dexity.com` (0133)

Both domains are accepted until the old one is dropped in a follow-up
migration. What to do depends on how IT moves each person:

- **Same Google account, renamed** (the Workspace primary domain changes).
  Nothing to do: they keep their role and everything they own. Two cases:
  - Supabase keeps reporting the OLD address for the login (it may only
    refresh the Google identity's data, not `auth.users.email`): the old
    entry keeps matching, access is unchanged, and the Access list keeps
    showing the old address.
  - Supabase reports the NEW address: the resolver moves the entry to it,
    because the login's Google identity now carries that verified address.

  Do **not** pre-add the new address "just in case": it works (the link
  moves and the old entry is retired), but the role then comes from the new
  entry.
- **Brand-new account** (fresh `@dexity.com` login). Add the new address in
  Mission Control → Access with the right role, ask the person to sign in
  once, then use **Hand over a person's records** (old login → new login).
  That moves `owner_id` on roles, candidates, call sessions, Ashby job
  mappings and settled Ask-Hello drafts, plus `created_by` on the R1 rounds
  they sent (R1 uses it as the round's owner). The audit log is not
  rewritten. Then disable the old entry. Notes:
  - Run it when no call or interview is live. It updates the candidate and
    call-session rows the workers also lock, and gives up after 5 s of lock
    waiting rather than stall live traffic (retry when quiet).
  - Repeating it is harmless (it reports zeros). Re-run it once in-flight
    Ashby imports have drained: an import already running when you hand
    over still lands on the old login.
  - A running Ask-Hello draft stays with the old login; it settles in
    minutes, and a re-run moves it.
  - **Do not delete the old login's Supabase user before the handover.**
    `owner_id` is `on delete set null`: the records would be orphaned and
    the handover would have nothing to move from.
- **Before IT deletes the old Workspace accounts**, make sure at least one
  admin has signed in on `@dexity.com` and shows as linked; the
  last-linked-admin guard counts only linked admins.
- **Ops outside this repo (verify before the cutover):**
  - if the new accounts live in a different Google Workspace, the Google
    OAuth client used by Supabase must allow them (an "Internal" consent
    screen admits only its own Workspace);
  - production must keep allowing first-time Google sign-in, or brand-new
    logins can never link;
  - production Supabase Auth must keep **Confirm email** and **Secure email
    change** ON and **manual identity linking** OFF. Continuity trusts the
    Google identity (a company Workspace account: Google's `hd` claim must
    be an accepted domain); the plain first-login link (unchanged since
    0016) trusts that Supabase only accepts an email change its owner
    confirmed;
  - the resolver is the first code to read `auth.identities`. Confirm once
    in the production SQL editor that
    `select has_table_privilege('postgres', 'auth.identities', 'select');`
    returns `true`. If it does not, continuity fails closed (renamed people
    keep working only while their old address is accepted);
  - IT must **never recycle** an old `@interviewkickstart.com` address to a
    different person: a login that kept the old address would hand that
    person its access.
- **Dropping `interviewkickstart.com` later** needs a new migration (narrow
  `is_access_email_domain` and `chk_email_allowlist_normalized` after the old
  rows are disabled or renamed) plus the API `ALLOWED_ACCESS_DOMAINS` and web
  `ALLOWED_EMAIL_DOMAINS` lists; `access-domain-0133-migration.test.ts` pins
  the four lists equal. Before it, check the Access list for renamed people
  still showing an old address (the first case above): dropping the domain
  would lock them out until their login's email is updated (Supabase admin
  API) or the resolver is taught to use the Google identity's address.

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
