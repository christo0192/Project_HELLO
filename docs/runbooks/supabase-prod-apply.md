# Supabase Production Migration Apply Runbook

**Target:** New single-org production Supabase project in Mumbai

**Owner:** Repository owner with DB Admin and Security review

**Status:** Code rehearsal only; production application is not yet approved

## Mandatory prerequisites

- [ ] Project belongs to the company-controlled Supabase organization.
- [ ] Two named administrators have MFA enabled and break-glass ownership is documented.
- [ ] Region, plan, PITR/backup capability, RPO/RTO, and billing alerts have written evidence.
- [ ] The project contains no application/candidate rows and is not serving traffic.
- [ ] Supabase Auth is configured for administrator-provisioned recruiters; public signup is disabled.
- [ ] A production secret manager/runtime-injection path exists. No credential is placed in this repository or chat.
- [ ] PR is merged and the exact commit is approved for application.

## Local rehearsal

```bash
SUPABASE_CLI_VERSION=2.110.0 scripts/supabase-local.sh start
SUPABASE_CLI_VERSION=2.110.0 scripts/supabase-local.sh reset
SUPABASE_CLI_VERSION=2.110.0 scripts/supabase-local.sh test
SUPABASE_CLI_VERSION=2.110.0 scripts/supabase-local.sh stop
```

Required results:

- Fresh migrations complete without warnings/errors.
- Effective RLS tests prove account-without-membership denial, active-member read access, immediate inactive-member revocation, and no browser writes/storage access.
- `git diff --check` and the committable secret scan pass.

## Non-empty database preflight

The new project is expected to be empty. If it is not, stop and investigate. Before `0004`, queries for invalid domain values and duplicate transcript positions must return zero rows. Never silently delete or rewrite unexplained records.

## Controlled apply

The repository owner authenticates the Supabase CLI directly in an approved shell. Do not paste tokens or database passwords into chat, command history, files, or CI logs.

```bash
supabase link --project-ref <PROJECT_REF>
supabase db push --dry-run
# Review the complete dry-run output and obtain the apply approval.
supabase db push
```

Hosted project settings must also be checked explicitly because local `config.toml` is not a production control:

- Exposed schemas include `screening_v2` only as required by the dashboard.
- Public email/phone signup and anonymous sign-in are disabled.
- Password/MFA/session policies match SEC-01 approval.
- Storage buckets `resumes_v2` and `recordings_v2` are private.
- Network restrictions, backups/PITR, Auth redirect URLs, and Realtime limits match the approved environment record.

## Post-apply verification

- [ ] No policy in `screening_v2` targets `anon` or `PUBLIC`.
- [ ] `anon` has no effective privilege on any `screening_v2` table.
- [ ] `authenticated` has no INSERT/UPDATE/DELETE privilege.
- [ ] An authenticated synthetic account without membership reads zero dashboard rows.
- [ ] An owner-provisioned active synthetic membership can read dashboard rows and only its own membership record.
- [ ] Deactivating that membership removes access immediately.
- [ ] Realtime sends only authorized session/transcript/assessment rows.
- [ ] Direct browser access to both private storage buckets fails.
- [ ] No production candidate data is introduced during verification.

Application login/MFA, RBAC, invite exchange, and authorized storage-download smoke tests remain blocked on SEC-01 through SEC-04 and MIG-06; this database PR must not claim those gates complete.

## Failure and recovery

Do **not** modify `supabase_migrations.schema_migrations` and do not attempt to undo a migration by rerunning older files.

Before traffic/data:

1. Stop the apply and preserve logs.
2. If the transaction rolled back, fix forward in a reviewed PR and rehearse locally.
3. If partial external configuration exists, reconcile it explicitly.
4. Recreate/reset the unused project only with DB Admin/Security approval.

After any data or traffic exists, stop processing and use the approved backup/restore or forward-repair runbook. Production cutover is out of scope for this PR.
