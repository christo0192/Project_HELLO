# Supabase Migration Strategy

**Date:** 2026-07-28

**Target:** Newly created, unused production project

**Decision:** Fresh safe history plus a forward hardening migration

## Strategy

The production project applies migrations `0001` through `0004` only after a local reset and review. Historical migrations `0001` and `0002` are corrected in source because the new project has never applied them: they no longer grant browser roles broad privileges or create anonymous read policies. This prevents an unsafe intermediate production state.

Migration `0004` is also a forward hardening path for prototype development databases that previously applied the old history. Such databases are non-production and must be reset or reconciled explicitly; this PR does not migrate old candidate data.

## Final database boundary

- `anon` has no schema/table policy or privilege in `screening_v2`.
- A valid Supabase Auth account alone has no data access.
- `screening_v2.recruiter_memberships` is a server-provisioned single-org allowlist with `admin`, `interviewer`, and `viewer` role values.
- An active member receives read-only access to the five dashboard tables: roles, candidates, sessions, transcript turns, and assessments.
- Browser roles receive no direct database writes and no direct resume/recording storage access.
- Server-only `service_role` performs writes until authenticated API authorization and short-TTL storage access are implemented.
- Realtime publishes only sessions, transcript turns, and assessments; existing RLS policies still apply.
- Public recruiter signup is disabled in local parity configuration.

## Why this is intentionally limited

This is a production-safe database seam, not completion of SEC-01 through SEC-04 or MIG-04 through MIG-06. The application still needs MFA, RBAC middleware, authorized candidate invitations, role-sensitive API behavior, storage URL minting, and production Supabase configuration evidence before launch.

## Compatibility and stop conditions

Before any non-empty database receives `0004`, check for invalid status values and duplicate `(session_id, turn_index)` rows. Stop rather than deleting or transforming unexplained data. The new production project should be empty, so any pre-existing application row is a no-go signal.

Supabase migrations are forward-only. Do not edit `supabase_migrations.schema_migrations` to simulate rollback. Before traffic, a failed apply is recovered by correcting the migration and recreating/resetting the unused project under owner approval. After traffic or data exists, recovery requires the approved backup/restore and roll-forward process.
