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

**Persistent staging and production plan/apply are BLOCKED** until each environment uses protected encrypted remote state and `remote_state_configured = true` is explicitly set after migration verification. Local backends are validation-only placeholders.

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

## State Isolation (Both Environments Blocked)

Persistent Oracle staging is shared infrastructure, and both environments can place APM data keys and infrastructure metadata in Terraform state. Therefore, neither environment may be planned/applied persistently with the committed local backend.

For **each** environment:

1. Create a separate protected OCI Object Storage state bucket/key with encryption, versioning, restricted IAM, and recovery controls.
2. Replace that environment's `backend "local"` with its reviewed remote backend configuration. Never share staging and production state keys.
3. Configure backend credentials outside Git and run `terraform init` to migrate/verify state.
4. Confirm state access and recovery, then set `remote_state_configured = true` through the environment's protected input.
5. Run a reviewed plan. The committed `terraform_data.remote_state_gate` fails closed while the acknowledgement remains false.

The commented S3-compatible OCI Object Storage example in `examples/production/main.tf` is a template only; operators must verify current Terraform/OCI backend arguments before enabling it.

---

## Log Source Onboarding (PENDING)

Application and audit logs are NOT provisioned by Terraform yet.
A log group exists (`<project>-<env>-logs`). When compute instances with the
OCI Logging agent are deployed:

1. Follow the current OCI custom-log and Unified Monitoring Agent documentation when compute exists; create each `CUSTOM` log and agent configuration from real resource identifiers rather than placeholder service sources.
2. Set retention on each real `oci_logging_log`; log groups themselves do not enforce retention.
3. Configure PII/secret redaction at the application logging library level (structured JSON logging with sensitive-field stripping) and/or the OCI Logging agent configuration.
4. OCI Audit logs are automatic at the tenancy level — no fabricated service-log resource is needed.

---

## Alarm Reference

| Alarm | Namespace | Metric | Condition | Severity | Action |
|-------|-----------|--------|-----------|----------|--------|
| Queue depth | `oci_queue` | `MessagesInQueueCount` (isVisible="true") | > 100 visible | CRITICAL | Check consumers, scale workers |
| Consumer lag | `oci_queue` | `ConsumerLag` | > 5 min | WARNING | Check consumer processing latency |
| Log ingestion | `oci_logging` | `BytesIngested` | ~1 MiB/min (17476 bytes/s rate) | WARNING | Check for log floods |
| Budget | `oci_budget_alert_rule` | actual spend | > threshold % | WARNING | Review spend |

After apply, the observability ONS email recipient must accept OCI's subscription-confirmation email before queue/log alarms can deliver. Verify the subscription is `ACTIVE`. Budget alert recipients are configured directly; budgets alert but do **not** cap or block spend.

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
