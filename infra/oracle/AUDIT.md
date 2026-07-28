# OCI Terraform Module Audit

**Date:** 2026-07-28
**Plan references:** FND-05/06, REL-01/04, OBS-01..06, DEP-02..07

## PLAN cross-reference

| Plan ID | Requirement | Terraform mapping |
|---------|-------------|-------------------|
| FND-05 | Secret manager/KMS | `modules/foundation/vault.tf` — OCI Vault + key references |
| FND-06 | Least-privilege service accounts | `modules/foundation/iam.tf` — dynamic groups + policies |
| REL-01 | Durable job queue | `modules/queue/` — OCI Queue + dead-letter |
| REL-04 | Retry/DLQ | `modules/queue/` — DLQ + visibility/retention inputs |
| OBS-01..02 | Structured logging + correlation | `modules/observability/logging.tf` — OCI Logging |
| OBS-03..04 | Metrics + distributed tracing | `modules/observability/monitoring.tf` + `apm.tf` |
| OBS-05..06 | SLI/SLO + alerting | `modules/observability/alarms.tf` + notifications |
| DEP-02 | Provisioned capacity with headroom | example roots parameterize compute shapes/scale |
| DEP-03 | HA decision | subnet/VCN design supports multi-AD; single-AD default |
| DEP-04..05 | IaC + environment parity | staging/production example roots, shared modules |
| DEP-06 | Canary/blue-green | CI runbook documents plan-only default + manual approval |
| DEP-07 | Artifact provenance | Not in Terraform scope; documented in CI runbook |

## OCI Terraform provider resource verification

All resources below are from `hashicorp/oci` provider ≥ 5.x and are stable.

### Foundation — Confirmed
- `oci_identity_compartment` — compartment hierarchy
- `oci_core_vcn`, `oci_core_subnet`, `oci_core_internet_gateway`, `oci_core_nat_gateway`
- `oci_core_route_table`, `oci_core_route_table_attachment`
- `oci_core_security_list`, `oci_core_network_security_group`, `oci_core_network_security_group_security_rule`
- `oci_identity_dynamic_group`, `oci_identity_policy`
- `oci_kms_vault`, `oci_kms_key`
- `oci_budget_budget`, `oci_budget_alert_rule`
- `oci_identity_tag_namespace`, `oci_identity_tag`

### Queue — Confirmed
- `oci_queue_queue` — OCI Queue service (GA)
- Dead-letter configured via queue `dead_letter_queue_delivery_count` attribute
- No separate DLQ resource; DLQ is a second queue referenced by the primary

### Observability — Confirmed
- `oci_logging_log_group`, `oci_logging_log`
- `oci_monitoring_alarm`
- `oci_apm_apm_domain`
- `oci_ons_notification_topic`, `oci_ons_subscription`
- Service Connector Hub not implemented — OCI Logging captures service logs natively

### Unsupported or avoided
- No `oci_secrets_secret` resource creation (credentials must not be committed)
- No `oci_containerengine_cluster` (OKE) — out of scope for this PR
- No `oci_core_instance` / compute provisioning — infrastructure foundation only
- No Service Connector Hub — log groups capture directly
- No direct credential values — Vault references are placeholder ARNs only

## App boundary validation

Current app components and their OCI infrastructure needs:

| App component | Path | OCI dependency |
|---------------|------|----------------|
| API server | `app/api/` | Compute subnet, Vault secret refs, queue publish IAM |
| Web dashboard | `app/web/` | CDN/object storage (out of scope) |
| Voice agent | `app/voice-livekit/` | Compute subnet, STT/TTS/LLM API egress, queue publish IAM |
| Scoring worker | queue consumer | Compute subnet, queue consume IAM, Vault secret refs |

All boundaries respected. No app code modified.

## Region parameterization

Every module accepts `region` as a variable. No region is hardcoded.
Example roots default to `placeholder-region` — must be overridden.
