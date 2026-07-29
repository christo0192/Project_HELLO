# Tags and budgets for cost governance.
# Tag namespace is UNIQUE per environment (staging and production never collide).
# Names use underscores (not hyphens) for OCI dynamic-group grammar compatibility.
#
# ONS email subscription requires manual confirmation — the recipient MUST click
# the confirmation link in the OCI Notifications email before alarms will deliver.
# Budgets alert only; they do NOT cap or block spend.

locals {
  # Derive parser-safe names (underscores) from project_name (may contain hyphens)
  project_name_safe = replace(var.project_name, "-", "_")
}

# Tag namespace — one per environment, applied at tenancy level.
resource "oci_identity_tag_namespace" "this" {
  compartment_id = var.tenancy_ocid
  name           = "${local.project_name_safe}_${var.environment}_tags"
  description    = "Tag namespace for ${var.project_name} ${var.environment} (environment-scoped, underscore-safe)"
}

# Environment tag definition (informational)
resource "oci_identity_tag" "environment" {
  tag_namespace_id = oci_identity_tag_namespace.this.id
  name             = "environment"
  description      = "Deployment environment: staging or production"
  is_cost_tracking = true
}

# Workload-role tag — fail-closed IAM gating (see iam.tf).
# MUST use underscore-safe key name for dynamic-group compatibility.
resource "oci_identity_tag" "workload_role" {
  tag_namespace_id = oci_identity_tag_namespace.this.id
  name             = "workload_role"
  description      = "Compute workload role: api or worker. MUST be set on every instance for IAM to grant rights."

  validator {
    validator_type = "ENUM"
    values         = ["api", "worker"]
  }

  is_cost_tracking = false
}

# Monthly budget with alert rule.
# Budgets ALERT only — they do not cap or block spending in OCI.
# Amount should be deliberately set per environment, not hidden at default.
resource "oci_budget_budget" "this" {
  compartment_id = var.tenancy_ocid
  target_type    = "COMPARTMENT"
  targets        = [oci_identity_compartment.this.id]
  amount         = var.monthly_budget_amount
  reset_period   = "MONTHLY"
  display_name   = "${var.project_name}-${var.environment}-budget"

  description = "Monthly budget for ${var.environment} compartment (alerts only, does not cap spend)"

  freeform_tags = {
    environment = var.environment
    project     = var.project_name
    managed_by  = "terraform"
  }
}

# Budget alert rule — percentage-based threshold.
# ONS email subscription must be manually confirmed by the recipient.
resource "oci_budget_alert_rule" "this" {
  budget_id      = oci_budget_budget.this.id
  type           = "ACTUAL"
  threshold      = var.budget_alert_threshold
  threshold_type = "PERCENTAGE"
  display_name   = "${var.project_name}-${var.environment}-budget-alert-${var.budget_alert_threshold}pct"
  message        = "Budget alert: ${var.project_name} ${var.environment} has reached ${var.budget_alert_threshold}% of monthly budget.  Budgets alert only — spend is NOT capped."
  recipients     = var.budget_alert_email
}

variable "monthly_budget_amount" {
  description = "Monthly budget amount in USD (required — no default; set deliberately per environment)"
  type        = number
}

variable "budget_alert_threshold" {
  description = "Budget alert threshold percentage (1-100)"
  type        = number
  default     = 80
  validation {
    condition     = var.budget_alert_threshold > 0 && var.budget_alert_threshold <= 100
    error_message = "budget_alert_threshold must be between 1 and 100"
  }
}

variable "budget_alert_email" {
  description = "Email recipient for budget alerts (required — no default)"
  type        = string
}
