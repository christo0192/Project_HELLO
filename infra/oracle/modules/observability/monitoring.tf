# OCI Monitoring alarms: queue alarms are in modules/queue/alarms.tf.
# Cost alarms are the foundation module's oci_budget_alert_rule.
# This file contains only observability-platform guardrail alarms against
# documented OCI metrics.

# Alarm: Log ingestion rate (namespace: oci_logging, metric: BytesIngested)
resource "oci_monitoring_alarm" "log_ingestion_rate" {
  compartment_id        = var.compartment_id
  display_name          = "${var.project_name}-${var.environment}-log-ingestion"
  metric_compartment_id = var.compartment_id
  namespace             = "oci_logging"
  query                 = "BytesIngested[5m].rate() > 1048576"
  severity              = "WARNING"
  is_enabled            = true
  pending_duration      = "PT15M"
  destinations          = [oci_ons_notification_topic.this.id]

  body = "${var.project_name} ${var.environment} log ingestion rate exceeds 1 MB/min. Check for log floods. PII redaction is the application's responsibility."

  freeform_tags = {
    environment = var.environment
    project     = var.project_name
    managed_by  = "terraform"
  }
}

# Removed: oci_metrics/IngestionDatapoints alarm.
# IngestionDatapoints — not a documented metric; removed. No oci_metrics alarm for it.
# oci_metrics. Metric-ingestion rate is covered by the OCI free-tier limits
# dashboard; custom monitoring of it requires a service metric that is not
# publicly documented. See: https://docs.oracle.com/en-us/iaas/Content/Monitoring/Reference/mql.htm
