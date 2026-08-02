# Runbook: DEP-04 Provider-Neutral Deployment Contracts

Status: **PENDING / PROPOSED.** This runbook is repository architecture only.
No service is deployed, no provider is contacted, and every approval is PENDING
owner verification.

## 1. Purpose

DEP-04 lands a provider-neutral deployment contract for the ADR-0010
managed-hosting pilot: service names, env var NAMES only, image/artifact
inputs, and the runtime secret source. The repository is the contract;
providers, regions, entitlements, and prices are PENDING owner verification
and are never claimed here.

## 2. Manifest shape

`infra/deployment-contracts/manifest.json`:

- Top level: `status: PROPOSED`, `approvalStatus: PENDING`,
  `deployed: false`, `provisioned: false`, and a `secretModel` whose
  `runtimeSource` is `managed-infisical-runtime` (ADR-0010 decision 2).
- `services`: one entry per ADR-0010 component — `web-api`,
  `livekit-cloud`, `livekit-agents`, `supabase`, `infisical-managed`,
  `oci-e2-gateway`, `vps-fallback`. A missing service is rejected.
- Each service: `runtime`, `artifactType` (`docker-image`,
  `managed-service`, `instance`), `artifactInput` (a repository-relative
  path or a managed-service marker — never a registry URL), `envVars`, and
  `stages` (`staging` + `prod`, each `NOT_DEPLOYED` with scale proposals).
- Each env var: `name` (uppercase NAME only), `secret` boolean, and
  `secretSource` (`managed-infisical-runtime` for runtime injection,
  `build-time-config` for public VITE_* client build vars, and
  `owner-managed-environment` for synthetic demo context).
- `migrations`: the repository migrations registry used by the DEP-06
  rollback compatibility checker (additive/breaking classes, all
  `applied: false`).

## 3. Commands

```bash
node scripts/validate-deployment-contracts          # repo files
node scripts/validate-deployment-contracts --fixtures   # seeded negatives
```

The validator rejects, offline and deterministically:

- env VALUES (a `value` field, or a name containing `=`) — negative control:
  `SUPABASE_SERVICE_ROLE_KEY=value` is rejected;
- missing services (any of the 7 ADR-0010 components absent);
- secret-like tokens, JWTs, URL userinfo, and provider/cloud URLs;
- `deployed: true` / `provisioned: true` / `approvalStatus` other than PENDING;
- duplicate migration ids and undeclared env var names;
- any `.tf` file under `infra/deployment-contracts/`.

## 4. Truth boundary

This contract describes what a deployment WOULD look like. Nothing is live:
the staging and prod stages are `NOT_DEPLOYED`, the image/artifact inputs are
repository paths, and no provider console, account, or endpoint is referenced.
The owner performs any real provisioning interactively and outside CI.

## 5. Boundaries

No cloud apply, no provider login, no card, no Terraform, no registry push,
no secret entry, no production change. `infra/oracle/**` is not modified and
is not the Phase 11 deployment path.
