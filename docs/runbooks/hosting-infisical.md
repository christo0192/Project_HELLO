# Runbook: Managed Infisical runtime secret injection

Status: **OWNER-OPERATED / PENDING verification.** This runbook is repository
architecture only. The Infisical project, machine identity, environment scope,
and secret values are PENDING owner verification (see
[ADR-0010](../adr/0010-hosting-topology.md) — managed Infisical supersedes the
self-hosted-Infisical direction for the managed-pilot implementation portion of
FND-05 only).

## 1. Why runtime injection

FND-05 requires that no persistent production `.env`, image, client bundle, or
CI output contains secrets. The managed-hosting topology injects all secret
values at runtime from a managed Infisical project through a machine identity,
so the repository and the container image contain variable names and
placeholders only.

## 2. Repository contract (already enforced)

- `app/voice-livekit/.env.example` documents variable NAMES with `replace_me`
  placeholders — never values.
- The Docker build context excludes `.env` and `.env.*` (`app/voice-livekit/.dockerignore`);
  the Dockerfile copies no `.env`.
- `scripts/validate-no-secrets-baked.sh` rejects `.env` files, private-key
  material, secret-looking values, and the synthetic sentinel
  `SYNTHETIC_FORBIDDEN_SECRET_VALUE` (negative control fixture in
  `scripts/__fixtures__/`). It distinguishes variable names/placeholders from
  values and must fail on the sentinel — proving it is non-vacuous.
- Gitleaks scans (pre-commit, reachable history, working tree) remain the
  repository-wide secret boundary.

## 3. OWNER-OPERATED steps (all PENDING owner verification)

1. Create the managed Infisical project (provider/tenant selection and
   entitlement verification are PENDING owner).
2. Create an environment scope for the voice worker (e.g. staging/pilot) and
   populate the variable names from §4 with real values.
3. Provision a machine identity (token/service identity) with the narrowest
   scope that can read that environment only.
4. Configure the orchestrator (LiveKit Cloud Agents deployment, container
   platform, or VPS systemd unit) to materialise the environment from Infisical
   at runtime — never commit the machine identity or any secret.
5. Rotate the machine identity on a schedule and after any suspected exposure.

The exact Infisical CLI/sdk syntax and identity model depend on the provider
version in use — verify against current official Infisical documentation at
execution time (**OWNER_VERIFY**). No Infisical command is run from this
repository or CI.

## 4. Environment variable names injected at runtime

From `app/voice-livekit/.env.example` (names only; values are never stored in
this repository):

- LiveKit: `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`
- Supabase worker persistence: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
  `SUPABASE_SCHEMA`, `API_BASE`
- Worker auth: `WORKER_CONTEXT_SECRET`, `WORKER_CONTEXT_TIMEOUT_SEC`
- Providers: `ANTHROPIC_API_KEY`, `SARVAM_API_KEY` and the model/voice knobs
- Runtime tuning: `LIVEKIT_WORKER_DRAIN_SEC`, VAD/interruption knobs

## 5. Boundaries

No account creation, card entry, paid purchase, machine-identity creation, or
secret entry without interactive owner action. No secret values are stored in
this repository. Production acceptance remains a separate gate.
