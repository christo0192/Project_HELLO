# Runbook: DEP-05 Staging/Prod Structural Parity

Status: **PENDING / PROPOSED.** This runbook is repository architecture only.
Parity here is a repository contract assertion about the DEP-04 manifest —
it is not a claim that any staging or production environment exists or matches.

## 1. Rule

Staging and prod must be structurally identical in the repository contract:

- the same service set (all 7 ADR-0010 components);
- the same env var NAMES per service — secret names only, never values;
- the same artifact inputs and the same runtimes;
- scale-only differences allowed: replica counts and instance sizes may
  differ between staging and prod.

`infra/deployment-contracts/parity-manifest.json` records this rule with
`secretNamesOnly: true`, `scaleDifferencesAllowed: true`,
`parityStatus: PENDING` and `parityAchieved: false`. `parityAchieved: true`
is rejected: nothing is deployed, so no parity is achieved.

## 2. How the check works

The validator loads the parity manifest and the deployment contract manifest
it references (`infra/deployment-contracts/manifest.json`), then verifies per
service:

- `staging.envVarNames` and `prod.envVarNames` are the same set — a name
  present in only one stage is a **stage mismatch** and is rejected;
- every parity name is declared in the source manifest's env contract;
- every contract service has a staging and a prod parity entry — a missing
  entry (or an unlisted service) is rejected;
- structural-equivalence assertions (`sameService`, `sameEnvVarNames`,
  `sameSecretNames`, `sameArtifactInput`, `sameRuntime`) are all true;
- every name matches `^[A-Z][A-Z0-9_]*$` — values are rejected.

## 3. Commands

```bash
node scripts/validate-deployment-contracts            # repo parity check
node scripts/validate-deployment-contracts --fixtures # seeded negatives
```

## 4. Truth boundary

The manifests are aligned by contract; no staging or prod environment exists
in repository-only work. Scale numbers are proposals PENDING owner/SRE input
and are not capacity conclusions (see the DEP-01 runbook for the
`synthetic_local` boundary).

## 5. Boundaries

No environment creation, no promotion, no provider action. If the owner later
provisions staging and prod, this manifest is the structural checklist they
verify against — it is not evidence that the environments exist.
