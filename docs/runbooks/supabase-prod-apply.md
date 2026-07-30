# Supabase Production Migration Apply Runbook

**Target:** New single-org production Supabase project (region TBD per Legal/Security; production location is not yet selected)

**Owner:** Repository owner with DB Admin and Security review

**Status:** ✅ Local-only Phase 2 implementation rehearsed in CI and local Supabase.
❌ Production application is **not yet approved** and remains **BLOCKED** until
MIG-01 through MIG-11 are complete and the production project is provisioned
under change control.

## Phase 2 implementation context

This runbook covers the **local-only Phase 2 implementation** as delivered in
PR25 (63f8ba1). The following migrations and tooling are implemented and
rehearsable locally:

| Area | Status | Notes |
|------|--------|-------|
| `0001`–`0008` migrations | ✅ Rehearsed locally | Full schema, RLS, Realtime, policies |
| `recording_object_key` storage | ✅ LiveKit route stores object key | Short-TTL signed URL minted on download (MIG-06) |
| `recording_url` column | 🟡 DEPRECATED — present in schema, null by default | Legacy; no write path sets it |
| LiveKit provider | ✅ Active | Room token, recording upload, session lifecycle |
| Pipecat provider | 🗄️ Stale | Referenced in legacy schema; not an active production fallback |
| Local Supabase CI | ✅ `supabase-ci.yml` | Migrations, RLS tests, security checks |
| Production apply | ❌ BLOCKED | Gated on MIG-01 through MIG-11 completion |

**No production Supabase project credentials, project refs, or hosted actions
are placed in this repository.**

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

### Recording storage note

The Phase 2 implementation stores `recording_object_key` (object key only, not
a signed URL) in `call_sessions`. The legacy `recording_url` column remains in
the schema (nullable, deprecated) and is **not written** by any active code path.
Short-TTL signed URLs are minted at download time. This applies to **LiveKit**
(active provider); **Pipecat** (stale) is not a production fallback.

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
