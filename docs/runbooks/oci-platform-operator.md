# OCI Platform Operator Runbook

**Last updated:** 2026-07-28 (r3: self-contained roots, IAM tags, logging, remote state)
**Updated:** 2026-07-29 (r4: terraform_data production gate, underscore tags, budget validations, project-name constraints)
**Scope:** OCI managed-services foundation (staging + production)
**Terraform root:** `infra/oracle/examples/{staging,production}`

---

## Critical: Plan-Only Default

**Every change starts with `terraform plan`.** Apply is never a default and
requires explicit manual approval, change-control authorization, and the
production operator role.

**Production plan AND apply are both BLOCKED** until `production_apply_enabled = true`
is explicitly set after encrypted remote state (OCI Object Storage + SSE)
is configured. See State Isolation below.

---

## Prerequisites

1. OCI CLI configured with user credentials (API key pair).
2. Terraform ≥ 1.5 installed.
3. GitHub repository cloned.
4. `terraform.tfvars` populated (copy from `.example`, never commit):
   ```bash
   cd infra/oracle/examples/staging   # or production
   cp terraform.tfvars.example terraform.tfvars
   # Edit terraform.tfvars with real tenancy OCID, region, alert_email
   ```

### Compute Instance Tagging (REQUIRED)

Every compute instance MUST carry a workload-role defined tag or IAM will grant
no queue/vault/metrics rights (fail-closed):

```hcl
# For API/web instances (tag key uses underscore, not hyphen):
defined_tags = {
  "hr_screening_staging_tags.workload_role" = "api"
}

# For worker/queue-consumer instances:
defined_tags = {
  "hr_screening_staging_tags.workload_role" = "worker"
}
```

Dynamic group matching rules are documented in `modules/foundation/iam.tf`.
Untagged instances have zero rights.

---

## State Isolation

### Staging
Local state is acceptable. Init uses `backend "local"` with no special config.

### Production (BLOCKED)

Production plan AND apply are both blocked by a `terraform_data` precondition.
To unblock:

1. Create an OCI Object Storage bucket with SSE enabled.
2. Replace the local backend in `examples/production/main.tf` with:
   ```hcl
   backend "s3" {
     bucket                      = "<prod-state-bucket>"
     key                         = "oci-platform/production/terraform.tfstate"
     region                      = "<region>"
     endpoint                    = "https://<ns>.compat.objectstorage.<region>.oraclecloud.com"
     skip_region_validation      = true
     skip_credentials_validation = true
     skip_metadata_api_check     = true
     force_path_style            = true
     encrypt                     = true
   }
   ```
3. Run `terraform init` against the remote backend.
4. Set `production_apply_enabled = true` in `terraform.tfvars`.
5. Never use local state for production — it can contain APM data keys.

---

## Log Source Onboarding (PENDING)

Application and audit logs are NOT provisioned by Terraform yet.
A log group exists (`<project>-<env>-logs`). When compute instances with the
OCI Logging agent are deployed:

1. Add a `CUSTOM` `oci_logging_log` resource per service in the observability
   module with `source_type = "OCISERVICE"` and the agent's resource OCID.
2. Configure PII/secret redaction at the application logging library level
   (structured JSON logging with sensitive-field stripping) and/or the OCI
   Logging agent configuration (`/etc/oci-logging/agent.conf`).
3. OCI Audit logs are automatic at the tenancy level — no Terraform action needed.

---

## Alarm Reference

| Alarm | Namespace | Metric | Condition | Severity | Action |
|-------|-----------|--------|-----------|----------|--------|
| Queue depth | `oci_queue` | `MessagesInQueueCount` (isVisible="true") | > 100 visible | CRITICAL | Check consumers, scale workers |
| Consumer lag | `oci_queue` | `ConsumerLag` | > 5 min | WARNING | Check consumer processing latency |
| Log ingestion | `oci_logging` | `BytesIngested` | ~1 MiB/min (17476 bytes/s rate) | WARNING | Check for log floods |
| Budget | `oci_budget_alert_rule` | actual spend | > threshold % | WARNING | Review spend |

**DLQ note:** OCI Queue uses a service-managed internal dead-letter sub-queue.
Dead-lettered messages are NOT surfaced as separate Monitoring metrics.
Operators must inspect the DLQ via OCI Console → Queue → Dead Letter Queue tab
or use the Queue API.

**REL-04 status:** Internal DLQ is configured (`dead_letter_queue_delivery_count`).
Automated DLQ detection/alert is PENDING a queue consumer or custom-metric integration.

### Dead-Letter Queue Inspection

```bash
oci queue queue list --compartment-id "${COMPARTMENT_ID}"
# GET https://{queue-messages-endpoint}/deadLetterQueue/messages
```

---

## Contacts & Escalation

- **Infrastructure owner:** [Engineering Lead — TBD]
- **OCI tenancy admin:** [TBD]
- **On-call rotation:** [TBD]
- **Emergency procedure:** See incident response runbook (OBS-09, pending)
