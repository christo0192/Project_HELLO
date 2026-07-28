# Budget cost alarm for observability services — references the single authoritative
# compartment budget created by the foundation module.
# No separate budget is created here to avoid duplication.
# The foundation module owns the single authoritative compartment budget.

resource "oci_monitoring_alarm" "daily_spend" {
  compartment_id        = var.compartment_id
  display_name          = "${var.project_name}-${var.environment}-daily-spend"
  metric_compartment_id = var.compartment_id
  namespace             = "oci_budgets"
  query                 = "BudgetActualSpend[1d]{budgetId = '${var.foundation_budget_id}'}.sum() > 1"
  severity              = "WARNING"
  is_enabled            = true
  pending_duration      = "PT1H"
  destinations          = [oci_ons_notification_topic.this.id]

  body = "${var.project_name} ${var.environment} daily spend has exceeded $1. Check the compartment budget in OCI Console for service-level details."

  freeform_tags = {
    environment = var.environment
    project     = var.project_name
    managed_by  = "terraform"
  }
}
