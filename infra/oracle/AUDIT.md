# OCI Terraform Module Audit

**Date:** 2026-07-28
**Updated:** 2026-07-28 (repair r3: self-contained roots, IAM, metrics, logging, state, CI assertions)
**Plan references:** FND-05/06, REL-01/04, OBS-01..06, DEP-02..07

## PLAN cross-reference

| Plan ID | Requirement | Status | Terraform mapping |
|---------|-------------|--------|-------------------|
| FND-05 | Secret manager/KMS | OK | `modules/foundation/vault.tf` — OCI Vault + key references |
| FND-06 | Least-privilege service accounts | OK | `modules/foundation/iam.tf` — distinct workload-role defined-tag dynamic groups with official queue-push/queue-pull verbs |
| REL-01 | Durable job queue | OK | `modules/queue/` — OCI Queue with MessagesInQueueCount + ConsumerLag alarms |
| REL-04 | Retry/DLQ | PARTIAL | Internal DLQ configured via `dead_letter_queue_delivery_count`; automated DLQ detection/alert is PENDING a queue consumer or custom-metric integration |
| OBS-01..02 | Structured logging + correlation | PARTIAL | Log group provisioned; app logs and correlation IDs require agent-managed CUSTOM logs from deployed compute instances — NOT provisioned yet |
| OBS-03..04 | Metrics + distributed tracing | PARTIAL | APM domain + BytesIngested rate alarm provisioned; application metrics require app-side instrumentation — NOT provisoned yet |
| OBS-05..06 | SLI/SLO + alerting | PARTIAL | Queue alarms + log ingestion alarm active; SLI/SLO definitions are pending app metrics |
| DEP-02 | Provisioned capacity with headroom | PENDING | Compute shapes are parameterized in example roots but no compute instances exist |
| DEP-03 | HA decision | PENDING | Subnet/VCN design supports multi-AD; single-AD default has no HA |
| DEP-04..05 | IaC + environment parity | OK | Staging/production example roots, shared modules, distinct tag namespaces |
| DEP-06 | Canary/blue-green | PENDING | CI runbook documents plan-only default; no deployment pipeline exists |
| DEP-07 | Artifact provenance | PENDING | Not in Terraform scope; CI path is defined but no build pipeline exists |

## OCI Terraform provider resource verification

### Foundation — Confirmed
- `oci_identity_compartment`, `oci_identity_dynamic_group`, `oci_identity_policy`
- `oci_identity_tag_namespace`, `oci_identity_tag` — unique per environment
- `oci_core_vcn` (dns_label explicit, validated), `oci_core_subnet`, `oci_core_internet_gateway`, `oci_core_nat_gateway`
- `oci_core_route_table`, `oci_core_security_list`
- `oci_kms_vault`, `oci_kms_key`
- `oci_budget_budget`, `oci_budget_alert_rule`

### IAM key decisions
- Dynamic groups use fail-closed workload-role defined-tag matching (not compartment-only)
- Every compute instance MUST carry workload-role = "api" or "worker"
- Untagged instances match NEITHER group → no rights
- Official OCI Queue verbs: `use queue-push` (publishers), `use queue-pull` (consumers)
- Metrics: `use metrics` without invented conditions
- Tag namespace is `${project_name}-${environment}-tags` → unique per environment

### Queue — Confirmed
- `oci_queue_queue` — `channel_consumption_limit = 100` (OCI default/unlimited)
- `timeout_in_seconds` = long-poll timeout (separate from visibility_in_seconds)
- Alarms: `MessagesInQueueCount` (isVisible="true"), `ConsumerLag` (minutes)
- MQL dimensions use escaped double-quoted values per OCI syntax
- Dead-letter: service-managed internal sub-queue, no separate Monitoring metric
- `notification_topic_id` required (no default)

### Observability — Confirmed
- `oci_logging_log_group` — log group only; app/service CUSTOM logs are agent-managed, not provisioned
- `oci_monitoring_alarm` — `BytesIngested` (oci_logging namespace, not LogIngestionBytes)
- `oci_apm_apm_domain`, `oci_ons_notification_topic`, `oci_ons_subscription`
- OCI Audit is automatic at tenancy level — no Terraform resource needed
- PII/secret redaction is application/agent responsibility — no Terraform redaction patterns

### Removed (unsupported or dead code)
- `IngestionDatapoints` alarm — not a documented oci_metrics metric
- `LogIngestionBytes` → replaced with `BytesIngested`
- Fake OCISERVICE application/audit logs with non-OCID resource values
- `log_redaction_patterns` variable — no source to attach redaction to
- METRIC_PUSH condition → use `use metrics` without conditions
- `alerts@example.com` defaults — all email variables are required
- Parent-level `terraform.tf` / `variables.tf` — roots are self-contained

## Example roots — pinned provider, lockfiles

Both staging and production example roots are self-contained:
- `required_providers` pinned to `hashicorp/oci` `~> 6.0`
- `provider "oci"` block with `region = var.region`
- Committed `.terraform.lock.hcl` files for reproducible init
- Production root blocks apply until remote encrypted state is configured

## State isolation

- Staging: local state acceptable (non-production data)
- Production: apply BLOCKED until remote encrypted state (S3 + SSE) is configured
- Each environment has its own `terraform.tfvars` (gitignored)
- `.terraform.lock.hcl` is committed; `.terraform/` provider caches are NOT

## Region parameterization

Every module accepts `region` as a variable. No region is hardcoded.
Example roots default to `placeholder-region` — must be overridden.
