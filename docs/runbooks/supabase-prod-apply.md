# Supabase Migration Apply Runbook

**Target**: Single-org production Supabase project (MIG-01)  
**Owner**: DB Admin + Security (review required)  
**Status**: Pending production project provisioning

---

## Preflight (local rehearsal — every apply)

- [ ] `docker info` — Docker is running
- [ ] `npx supabase --version` — CLI is available
- [ ] `scripts/supabase-local.sh test` — all policy tests pass on local
- [ ] `git diff --stat origin/main...HEAD -- app/supabase/` — changes scoped to supabase only
- [ ] No `.env` file modifications in the diff
- [ ] `scripts/supabase-local.sh reset` — clean reset succeeds
- [ ] Synthetic data only in local DB

## Preflight (production — before applying)

- [ ] Production Supabase project exists (MIG-01)
- [ ] At least 2 MFA-enabled administrators in the Supabase org (MIG-02)
- [ ] PITR backup enabled and verified
- [ ] Manual backup taken: `pg_dump` with `--schema=screening_v2` encrypted and stored
- [ ] `supabase db diff` against staging shows expected changes only
- [ ] Notification sent to #eng-deploy channel
- [ ] Approved reviewer sign-off on this PR

## Apply

```bash
# 1. Link to production project (one-time)
supabase link --project-ref <PROD_REF>

# 2. Push migrations
supabase db push

# 3. Verify schema
supabase db diff
```

## Verify (post-apply)

- [ ] `scripts/supabase-local.sh test` — policy tests pass locally (same migration state)
- [ ] Manual SQL check: `SELECT * FROM pg_policies WHERE schemaname = 'screening_v2' AND roles @> ARRAY['anon'::name];` — returns 0 rows
- [ ] Manual SQL check: `SELECT * FROM information_schema.role_table_grants WHERE grantee = 'anon' AND table_schema = 'screening_v2';` — returns 0 rows
- [ ] API smoke test: `curl https://<PROD>/rest/v1/candidates?limit=1` with anon key → HTTP 401/403
- [ ] Authenticated test: Login as recruiter → dashboard loads candidates, sessions, transcripts
- [ ] Realtime test: Subscribe to call_sessions channel → receives updates
- [ ] Storage test: Upload/download to resumes_v2 as authenticated user

## Rollback

```bash
# If hardening migration (0004) causes issues:
# 1. Link to production project
supabase link --project-ref <PROD_REF>

# 2. Repair migration table to mark 0004 as not applied
#    (manual SQL via Supabase Dashboard SQL Editor)
update supabase_migrations.schema_migrations
  set version = '0003'
  where version = '0004';
delete from supabase_migrations.schema_migrations where version = '0004';

# 3. Re-run 0001-0003 manually if needed
supabase db push  # will only push 0001-0003
```

## Notifications

- [ ] Post-apply report in #eng-deploy: migrations applied, verifications passed
- [ ] If rollback executed: incident report with timeline and root cause

---

**Note**: This runbook is for **manual execution by the repository owner** after PR review.
No automated production apply is configured. All production changes require explicit owner action.
