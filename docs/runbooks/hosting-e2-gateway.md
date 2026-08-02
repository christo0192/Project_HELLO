# Runbook: Existing OCI E2 Micro Mumbai — lightweight gateway/fallback only

Status: **OWNER-OPERATED / PENDING verification.** The existing Oracle Cloud
Infrastructure E2 Micro instance (`company-mumbai-e2-01`, VM.Standard.E2.1.Micro,
1 OCPU / 1 GB, Mumbai) is retained **only** as a lightweight gateway/fallback
in the managed-hosting topology. It is not the primary voice-worker host and no
Oracle Terraform changes accompany this ADR (see
[ADR-0010](../adr/0010-hosting-topology.md)).

## 1. Role in the topology

| Component | Primary target | E2 Micro role |
| --- | --- | --- |
| SFU / rooms | LiveKit Cloud Build | — |
| Voice worker | LiveKit Cloud Agents (fallback: near-India VPS) | Not the worker host |
| Secret injection | Managed Infisical | — |
| Gateway/supervision | — | Lightweight gateway/supervisor; A1 retry host candidate |

The E2 Micro instance is deliberately NOT a durable compute target for the
worker: 1 OCPU / 1 GB is a bounded footprint, and the managed topology exists
specifically to avoid depending on it. Historical context: A1 (ARM) capacity
attempts in `ap-mumbai-1` failed with `Out of host capacity` (2026-07-31, owner
run); E2 Micro remains the only running compute in that tenancy.

## 2. What the E2 Micro may run (lightweight only)

- A reverse proxy / gateway in front of the API if needed for the pilot.
- Supervision/monitoring jobs (bounded, no real candidate data).
- Periodic retry attempts for A1 capacity — never a worker dependency.
- Anything heavier requires a separate owner decision (paid compute, VPS
  fallback, or Cloud Agents).

## 3. Guardrails

- No Oracle Terraform changes are introduced by this hosting lane; the existing
  OCI infrastructure definition (`infra/oracle/`) is untouched.
- No production apply, no instance mutation, and no secret entry without
  interactive owner action.
- The instance must not receive secrets that the managed Infisical topology is
  meant to protect; any gateway use stays synthetic/local only.
- Real project/instance identifiers never appear in repository artifacts;
  `company-mumbai-e2-01` is referenced here only as historical owner context.

## 4. OWNER-OPERATED verification (PENDING)

- Gateway/fallback behavior against the managed topology, if and when the owner
  provisions it.
- OCI tenancy entitlements, residency, and DPA evidence remain PENDING owner
  verification.

## 5. Boundaries

No cloud applies, no account changes, no paid purchases without interactive
owner action. Production acceptance remains a separate gate.
