# OCI Monitoring alarms: service-level, cost, and observability guardrails
# Uses the notification topic for all destinations.

# Alarm: Monitoring metric ingestion rate (free-allowance aware)
# OCI Monitoring free tier: 500M datapoints/month. Alarm at threshold.
resource "oci_monitoring_alarm" "ingestion_rate" {
  compartment_id        = var.compartment_id
  display_name          = "${var.project_name}-${var.environment}-monitoring-ingestion"
  metric_compartment_id = var.compartment_id
  namespace             = "oci_metrics"
  query                 = "IngestionDatapoints[5m].rate() > 1000"
  severity              = "WARNING"
  is_enabled            = true
  pending_duration      = "PT15M"
  destinations          = [oci_ons_notification_topic.this.id]

  body = "${var.project_name} ${var.environment} metric ingestion rate is elevated. Check for unbounded metric emission."

  freeform_tags = {
    environment = var.environment
    project     = var.project_name
    managed_by  = "terraform"
  }
}

# Alarm: Log ingestion rate
resource "oci_monitoring_alarm" "log_ingestion_rate" {
  compartment_id        = var.compartment_id
  display_name          = "${var.project_name}-${var.environment}-log-ingestion"
  metric_compartment_id = var.compartment_id
  namespace             = "oci_logging"
  query                 = "LogIngestionBytes[5m].rate() > 1048576"
  severity              = "WARNING"
  is_enabled            = true
  pending_duration      = "PT15M"
  destinations          = [oci_ons_notification_topic.this.id]

  body = "${var.project_name} ${var.environment} log ingestion rate exceeds 1 MB/minute. Check for log floods or PII leakage."

  freeform_tags = {
    environment = var.environment
    project     = var.project_name
    managed_by  = "terraform"
  }
}
