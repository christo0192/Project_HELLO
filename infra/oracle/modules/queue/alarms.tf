# Queue alarms: backlog depth and consumer lag using official OCI Queue metrics.
# Namespace: oci_queue
# Dimensions: resourceId (queue OCID) uses double-quoted values per OCI MQL syntax.
# MessagesInQueueCount also uses isVisible="true" for visible-message count.
# Dead-letter messages are in the service-managed internal DLQ sub-queue and are not
# surfaced as separate Monitoring metrics. DLQ inspection requires OCI Console or Queue API.

# Alarm: visible messages in queue exceed threshold
# Metric: MessagesInQueueCount with isVisible="true"
resource "oci_monitoring_alarm" "queue_depth" {
  compartment_id        = var.compartment_id
  display_name          = "${var.project_name}-${var.environment}-queue-depth"
  metric_compartment_id = var.compartment_id
  namespace             = "oci_queue"
  query                 = "MessagesInQueueCount[1m]{resourceId = \"${oci_queue_queue.primary.id}\", isVisible = \"true\"}.mean() > 100"
  severity              = "CRITICAL"
  is_enabled            = true
  pending_duration      = "PT5M"
  destinations          = [var.notification_topic_id]

  body = "${var.project_name} ${var.environment} queue has more than 100 visible messages. Check consumer health and scale workers."

  freeform_tags = {
    environment = var.environment
    project     = var.project_name
    managed_by  = "terraform"
  }
}

# Alarm: consumer lag exceeds threshold (minutes)
# Metric: ConsumerLag is the time delta in minutes between oldest message and now.
resource "oci_monitoring_alarm" "consumer_lag" {
  compartment_id        = var.compartment_id
  display_name          = "${var.project_name}-${var.environment}-consumer-lag"
  metric_compartment_id = var.compartment_id
  namespace             = "oci_queue"
  query                 = "ConsumerLag[1m]{resourceId = \"${oci_queue_queue.primary.id}\"}.mean() > 5"
  severity              = "WARNING"
  is_enabled            = true
  pending_duration      = "PT10M"
  destinations          = [var.notification_topic_id]

  body = "${var.project_name} ${var.environment} consumer lag exceeds 5 minutes. Check consumer processing latency."

  freeform_tags = {
    environment = var.environment
    project     = var.project_name
    managed_by  = "terraform"
  }
}

# Pricing note: OCI Queue is NOT an Always Free service.
# A first-1M-requests/month no-charge tier was documented as of 2026-07-28
# but is not an Always Free guarantee and may change.
# Source: https://www.oracle.com/cloud/queue/pricing/ (retrieved 2026-07-28)
# No per-request cost alarm is provisioned here — the compartment budget alert
# rule (foundation module) is the authoritative cost guardrail.
