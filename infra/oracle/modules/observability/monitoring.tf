# OCI Monitoring alarms: queue alarms are in modules/queue/alarms.tf.
# Cost alarms are the foundation module's oci_budget_alert_rule.
# This file contains only observability-platform guardrail alarms against
# documented OCI metrics.

# Alarm: Log ingestion rate
# Namespace: oci_logging, metric: BytesIngested.
# Rate in bytes/second. Threshold ~17 476 bytes/s ≈ 1 MiB/min.
# MQL .rate() returns per-second rate; body text uses the MiB/min label.
resource "oci_monitoring_alarm" "log_ingestion_rate" {
  compartment_id        = var.compartment_id
  display_name          = "${var.project_name}-${var.environment}-log-ingestion"
  metric_compartment_id = var.compartment_id
  namespace             = "oci_logging"
  query                 = "BytesIngested[5m].rate() > 17476"
  severity              = "WARNING"
  is_enabled            = true
  pending_duration      = "PT15M"
  destinations          = [oci_ons_notification_topic.this.id]

  body = "${var.project_name} ${var.environment} log ingestion rate exceeds ~1 MiB/min. Check for log floods. PII redaction is the application's responsibility."

  freeform_tags = {
    environment = var.environment
    project     = var.project_name
    managed_by  = "terraform"
  }
}

# Removed: oci_metrics/IngestionDatapoints alarm — not a documented metric.
# No oci_metrics alarm for it. See https://docs.oracle.com/en-us/iaas/Content/Monitoring/Reference/mql.htm
