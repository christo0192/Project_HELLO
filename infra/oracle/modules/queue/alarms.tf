# Queue alarms: backlog depth, message age, and cost-threshold monitoring
# DLQ depth cannot be monitored directly via OCI Monitoring — the dead-letter
# queue is a service-managed internal sub-queue that does not expose separate metrics.
# Operator must inspect dead-lettered messages via OCI Console or Queue API.

# Alarm: primary queue depth exceeds threshold
resource "oci_monitoring_alarm" "queue_depth" {
  compartment_id        = var.compartment_id
  display_name          = "${var.project_name}-${var.environment}-queue-depth"
  metric_compartment_id = var.compartment_id
  namespace             = "oci_queue"
  query                 = "QueueDepth[1m]{queueId = '${oci_queue_queue.primary.id}'}.mean() > 100"
  severity              = "CRITICAL"
  is_enabled            = true
  pending_duration      = "PT5M"
  destinations          = [var.notification_topic_id]

  body = "${var.project_name} ${var.environment} queue depth exceeds 100 messages. Check consumer health and scale workers."

  freeform_tags = {
    environment = var.environment
    project     = var.project_name
    managed_by  = "terraform"
  }
}

# Alarm: primary queue oldest message age (backlog indicator)
resource "oci_monitoring_alarm" "queue_age" {
  compartment_id        = var.compartment_id
  display_name          = "${var.project_name}-${var.environment}-queue-message-age"
  metric_compartment_id = var.compartment_id
  namespace             = "oci_queue"
  query                 = "QueueOldestMessageAge[1m]{queueId = '${oci_queue_queue.primary.id}'}.mean() > 300"
  severity              = "WARNING"
  is_enabled            = true
  pending_duration      = "PT10M"
  destinations          = [var.notification_topic_id]

  body = "${var.project_name} ${var.environment} oldest queue message exceeds 5 minutes. Check consumer processing latency."

  freeform_tags = {
    environment = var.environment
    project     = var.project_name
    managed_by  = "terraform"
  }
}

# Cost-threshold alarm: queue request rate may incur charges
# OCI Queue is NOT an Always Free service. A first-1M-requests/month no-charge tier
# was documented as of 2026-07-28 but is not guaranteed. This alarm uses a
# configurable monthly cost estimate derived from the pay-per-request pricing model.
# Source: https://www.oracle.com/cloud/queue/pricing/ (retrieved 2026-07-28)
resource "oci_monitoring_alarm" "queue_cost_threshold" {
  compartment_id        = var.compartment_id
  display_name          = "${var.project_name}-${var.environment}-queue-cost-threshold"
  metric_compartment_id = var.compartment_id
  namespace             = "oci_queue"
  query                 = "QueueRequestCount[1m]{queueId = '${oci_queue_queue.primary.id}'}.rate() > ${var.queue_monthly_cost_threshold}"
  severity              = "WARNING"
  is_enabled            = true
  pending_duration      = "PT1H"
  destinations          = [var.notification_topic_id]

  body = "${var.project_name} ${var.environment} OCI Queue request rate may cause charges exceeding the configured monthly cost threshold of $${var.queue_monthly_cost_threshold}. Review usage and verify current pricing at https://www.oracle.com/cloud/queue/pricing/"

  freeform_tags = {
    environment = var.environment
    project     = var.project_name
    managed_by  = "terraform"
  }
}
