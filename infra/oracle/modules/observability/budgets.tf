# Budget and cost guardrails specific to observability services
# Separate from foundation module's compartment budget.

# Budget alert for overall observability cost
resource "oci_budget_budget" "this" {
  compartment_id = var.tenancy_ocid
  target_type    = "COMPARTMENT"
  targets        = [var.compartment_id]
  amount         = var.monthly_budget_amount
  reset_period   = "MONTHLY"
  display_name   = "${var.project_name}-${var.environment}-obs-budget"

  description = "Monthly budget for ${var.environment} observability services"

  freeform_tags = {
    environment = var.environment
    project     = var.project_name
    managed_by  = "terraform"
  }
}

resource "oci_budget_alert_rule" "this" {
  budget_id      = oci_budget_budget.this.id
  type           = "ACTUAL"
  threshold      = var.budget_alert_threshold
  threshold_type = "PERCENTAGE"
  display_name   = "${var.project_name}-${var.environment}-obs-budget-alert"
  message        = "Observability budget: ${var.project_name} ${var.environment} at ${var.budget_alert_threshold}% of monthly allowance"
  recipients     = var.notification_email
}

# Free-allowance alarm: combined OCI Observability services
# Covers Logging (10GB/month free), Monitoring (500M datapoints), APM (varies)
resource "oci_monitoring_alarm" "free_allowance_cost" {
  compartment_id        = var.compartment_id
  display_name          = "${var.project_name}-${var.environment}-free-tier-cost"
  metric_compartment_id = var.compartment_id
  namespace             = "oci_budgets"
  query                 = "BudgetActualSpend[1d]{budgetId = '${oci_budget_budget.this.id}'}.sum() > 1"
  severity              = "WARNING"
  is_enabled            = true
  pending_duration      = "PT1H"
  destinations          = [oci_ons_notification_topic.this.id]

  body = "${var.project_name} ${var.environment} observability spending has exceeded $1/day. Check for free-tier overage."

  freeform_tags = {
    environment = var.environment
    project     = var.project_name
    managed_by  = "terraform"
  }
}
