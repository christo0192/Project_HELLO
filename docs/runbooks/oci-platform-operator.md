# OCI Platform Operator Runbook

**Last updated:** 2026-07-28
**Scope:** OCI managed-services foundation (staging + production)
**Terraform root:** `infra/oracle/examples/{staging,production}`

---

## Critical: Plan-Only Default

**Every change starts with `terraform plan`.** Apply is never a default and
requires explicit manual approval, change-control authorization, and the
production operator role.

Apply is **impossible** in CI pull-request jobs. The `oci-infra-validate.yml`
workflow has no credentials. The `oci-infra-plan.yml` workflow is
`workflow_dispatch`-only and stops at plan output.

---

## Prerequisites

1. OCI CLI configured with user credentials (API key pair).
2. Terraform ≥ 1.5 installed.
3. GitHub repository cloned with `feat/oci-managed-services-foundation` branch.
4. `terraform.tfvars` populated (copy from `.example`, never commit):
   ```bash
   cd infra/oracle/examples/staging   # or production
   cp terraform.tfvars.example terraform.tfvars
   # Edit terraform.tfvars with real tenancy OCID and region
   ```

### Port 80 / Certificate Validation

Port 80 is gated behind `enable_http_ingress` (default `false`). To provision
TLS certificates via ACME HTTP-01 challenge:

```hcl
# In your terraform.tfvars, temporarily enable:
enable_http_ingress = true
```

After certificate provisioning, set `enable_http_ingress = false` and re-apply.
Never leave port 80 open permanently.

---

## Planning a Change

### Local plan (staging)

```bash
cd infra/oracle/examples/staging
terraform init
terraform plan -out=tfplan
```

### Local plan (production)

```bash
cd infra/oracle/examples/production
terraform init
terraform plan -out=tfplan
```

### CI plan (manual dispatch)

Go to **Actions → OCI Infra Plan → Run workflow**, select environment, enter
region, and submit. Download artifacts for review.

---

## Applying a Change

**⚠️ Apply requires:**
1. Plan reviewed and approved by a second operator.
2. Change-control ticket approved.
3. Production apply: explicit go-ahead from Engineering Lead.
4. Window with no active candidate screening sessions.

### Apply (staging)

```bash
cd infra/oracle/examples/staging
terraform apply tfplan
```

### Apply (production)

```bash
cd infra/oracle/examples/production
terraform apply tfplan
```

After apply, capture the output and verify:
```bash
terraform output
terraform state list
```

---

## Verification Commands

### Format check
```bash
terraform fmt -check -recursive -diff
```

### Validate (no credentials needed)
```bash
cd infra/oracle/examples/staging
terraform init -backend=false
terraform validate
```

### Validate all modules
```bash
for mod in infra/oracle/modules/{foundation,queue,observability}; do
  echo "=== $mod ==="
  terraform -chdir="$mod" init -backend=false
  terraform -chdir="$mod" validate
done
```

### Secret/diff check before commit
```bash
# From repository root
! grep -rn --include='*.tf' -E 'ocid1\.(tenancy|compartment|vault|secret)\.[a-z0-9]+' infra/oracle/ | grep -v '__CHANGE_ME__' | grep -v 'placeholder'
git diff --check
git diff --stat origin/main...HEAD
```

---

## State Isolation

Each environment has its own state file and `terraform.tfvars`. The
production and staging example roots are **independent** — they import
shared modules but manage separate state.

### Remote state (when configured)

Uncomment the `backend "s3"` block in `infra/oracle/terraform.tf` and
replace placeholders with real OCI Object Storage bucket details. Use
separate state keys per environment:
```
key = "oci-platform/staging/terraform.tfstate"
key = "oci-platform/production/terraform.tfstate"
```

---

## Rollback Procedure

### Terraform-managed rollback

1. Identify the last known-good state:
   ```bash
   terraform state list
   ```
2. If the change is simple (tag, alarm), revert the Terraform change and apply.
3. If infrastructure resources were created, use targeted destroy:
   ```bash
   terraform destroy -target=<resource_address>
   ```
4. Validate with `terraform plan` that drift is zero.

### Emergency rollback

1. **Do not manually delete resources in the OCI Console** — this causes state drift.
2. If Terraform state is corrupted, restore from backend version history (S3/Object
   Storage versioning must be enabled on the state bucket).
3. Contact the OCI administrator if resources need manual intervention.

---

## Destroy Limitations

**This Terraform defines network, IAM, and observability infrastructure.**
Destroying compartments or VCNs will delete all dependent resources including
compute instances, logs, and alarms.

### Before destroying any environment

1. Ensure no compute instances are running in the target compartment.
2. Ensure no candidate sessions are active.
3. Export audit logs and metrics for retention.
4. Take a manual backup of the Terraform state.

### Destroy (staging only — never production without change control)

```bash
cd infra/oracle/examples/staging
terraform plan -destroy -out=destroy-plan
# Review destroy plan carefully
terraform apply destroy-plan
```

**Production destroy requires:** Engineering Lead + Security approval, change
control, and a verified rollback window.

---

## Alarm Reference

| Alarm | Metric | Condition | Severity | Action |
|-------|--------|-----------|----------|--------|
| Queue depth | `MessagesInQueueCount` | Visible messages > 100 | CRITICAL | Check consumers, scale workers |
| Consumer lag | `ConsumerLag` | Lag > 5 minutes | WARNING | Check consumer processing latency |
| Monitoring ingestion rate | `IngestionDatapoints` | > 1000 dp/min | WARNING | Check for metric storm |
| Log ingestion rate | `LogIngestionBytes` | > 1 MB/min | WARNING | Check for log flood, PII leak |
| Budget > threshold % | `oci_budget_alert_rule` | Actual spend > threshold % | WARNING | Review spend, check for unused resources |

**DLQ note:** OCI Queue uses a service-managed internal dead-letter sub-queue.
Dead-lettered messages are NOT surfaced as separate Monitoring metrics.
Operators must inspect the DLQ via OCI Console → Queue → Dead Letter Queue tab or use the Queue API.

**REL-04 status:** Internal DLQ is configured (`dead_letter_queue_delivery_count`).
Automated DLQ detection/alert is PENDING a queue consumer or custom-metric integration.

### Dead-Letter Queue Inspection

```bash
# List queues to find the primary queue OCID
oci queue queue list --compartment-id "${COMPARTMENT_ID}"

# View dead-letter messages via Queue API
# GET https://{queue-messages-endpoint}/deadLetterQueue/messages
```

---

## Contacts & Escalation

- **Infrastructure owner:** [Engineering Lead — TBD]
- **OCI tenancy admin:** [TBD]
- **On-call rotation:** [TBD — PagerDuty/Opsgenie]
- **Emergency procedure:** See incident response runbook (OBS-09, pending)
