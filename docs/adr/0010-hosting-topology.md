# ADR-0010: Managed-hosting topology for the voice-agent pilot

**Status:** Accepted

**Decision owner:** christo0192 (repository owner / sole Product/Engineering owner)

**Plan references:** D-003, D-005, FND-05, FND-08, GOV-07, DEP-01, DEP-02, DEP-03

## Context

The system runs locally and depends on Supabase, LiveKit, and a Python voice
worker (`app/voice-livekit`). ADR-0007 selected Oracle Cloud Always-Free Mumbai
as the compute provider/region with self-hosted LiveKit Mumbai. D-005 (LiveKit
Cloud vs self-host) remained open. FND-05 selected Infisical as the secret
manager direction with self-hosting on Oracle Mumbai, but no secret manager is
deployed yet.

The owner has confirmed a revised **managed-hosting pilot topology** for the
internal synthetic engineering architecture (alignment record 2026-08-01):
managed LiveKit Cloud Build plus Cloud Agents first, managed Infisical for
runtime secret injection, the existing OCI E2 Micro Mumbai instance retained
only as a lightweight gateway/fallback, and a persistent near-India VPS as the
bounded fallback if Cloud Agents proves unsuitable.

This ADR is accepted for internal synthetic engineering architecture based on
owner confirmation. It is not production acceptance: no provider account,
entitlement, free-tier, pricing, residency, DPA, or card fact is claimed here,
and every external item remains PENDING owner verification.

## Decision

1. **LiveKit Cloud Build plus LiveKit Cloud Agents first.** The SFU (Build) and
   the Python voice worker (Cloud Agents, managed deployment) are the primary
   target for the managed pilot, chosen to minimise self-managed infrastructure
   and to move the existing spike worker to a managed runtime with minimal
   changes. Account/entitlement/pricing verification is PENDING owner.
2. **Managed Infisical for runtime secret injection.** Worker/API secrets are
   injected at runtime from a managed Infisical project via a machine identity;
   secrets are never baked into images or repositories. Project creation,
   machine identity, and scope are PENDING owner. This supersedes the
   self-hosted-Infisical direction for the managed-pilot implementation portion
   of FND-05 only; the underlying FND-05 gate (secrets not in local prod
   files/images/CI output) remains in force.
3. **Existing OCI E2 Micro Mumbai is a lightweight gateway/fallback only.** It
   is not the primary worker host for the managed pilot. No Oracle Terraform
   changes accompany this ADR.
4. **Bounded near-India VPS fallback.** If Cloud Agents is unsuitable, a
   persistent near-India VPS with an initial monthly ceiling of USD 12 (provider
   and region are PENDING owner verification) runs the containerised worker.
   The ceiling is an internal engineering budget bound, not a provider quote.
5. **No provider mutation.** This ADR authorises repository deployment
   contracts, validation scripts, ADRs, CI, and owner runbooks only. Account
   creation, cards, secret entry, paid purchases, cloud applies, and production
   deployment require interactive owner action.

## Consequences

Positive: a truthful, provider-safe deployment contract (multi-stage non-root
image, no baked secrets, bounded static CI validation, owner runbooks) lands in
the repository without any provider account or mutation; the pilot can be
operated by the owner through a documented path once accounts are provisioned.

Negative: nothing is deployed by this ADR; the managed topology remains
unverified until the owner completes the external-pending items (LiveKit Cloud
project/agents deployment, Infisical project and machine identity, VPS
provisioning, provider pricing/DPA/residency evidence).

Operational: images expose no readiness endpoint and declare no probe;
signal/drain behavior is SDK-provided and runtime proof is owner evidence, not
claimed here.

Migration: the self-hosted-LiveKit direction of ADR-0007 is not discarded; it
remains the historical record and a possible future fallback.

Security: runtime-only secret injection from managed Infisical, non-root
container identity, minimal copy context, and a secret-bake validator with a
synthetic negative control (non-vacuous) are introduced.

## Evidence

- Owner confirmation in the primary repository's alignment record
  (`.pi/state/alignment.md`, 2026-08-01) and in
  `docs/decisions/fnd-08-owner-approval.md`.
- Command surface verified from the public `livekit/agents` repository at tag
  `livekit-agents@1.6.4` (2026-08-02, no login): `python agent.py start` is the
  production worker command; `download-files` exists as a legacy script command
  and as `python -m livekit.agents download-files`; the `download-files`
  build/runtime strategy is OWNER_VERIFY and is not executed in CI.
- Dependency versions verified from public PyPI metadata (2026-08-02, no login)
  for the pinned direct set; Python 3.12 is within every direct dependency's
  declared requires-python range.
- All provider account/entitlement/free-tier/pricing/residency/DPA/card facts:
  **PENDING owner verification.**

## Supersession

None (this record is currently binding for its stated scope).

This record narrowly supersedes the LiveKit hosting decision portions of
ADR-0007 (D-003/D-005 pilot implementation) and the self-hosted-Infisical
implementation portion of FND-05 for the managed-hosting pilot, preserving
history in those records rather than rewriting them. Production acceptance
remains a separate gate.
