# Queue alarms: backlog depth and DLQ delivery monitoring

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

  freeform_tags = {
    environment = var.environment
    project     = var.project_name
    managed_by  = "terraform"
  }
}

# Alarm: messages sent to dead-letter queue
resource "oci_monitoring_alarm" "dlq_depth" {
  compartment_id        = var.compartment_id
  display_name          = "${var.project_name}-${var.environment}-dlq-depth"
  metric_compartment_id = var.compartment_id
  namespace             = "oci_queue"
  query                 = "QueueDepth[1m]{queueId = '${oci_queue_queue.dead_letter.id}'}.mean() > 1"
  severity              = "CRITICAL"
  is_enabled            = true
  pending_duration      = "PT1M"
  destinations          = [var.notification_topic_id]

  freeform_tags = {
    environment = var.environment
    project     = var.project_name
    managed_by  = "terraform"
  }
}

# Free-allowance warning: queue request count approaches free tier limit
# OCI Queue free tier: 1M requests/month. Alarm at 80% of allowance.
resource "oci_monitoring_alarm" "free_allowance_requests" {
  compartment_id        = var.compartment_id
  display_name          = "${var.project_name}-${var.environment}-queue-free-allowance"
  metric_compartment_id = var.compartment_id
  namespace             = "oci_queue"
  query                 = "QueueRequestCount[1m]{queueId = '${oci_queue_queue.primary.id}'}.rate() > 0.031"
  severity              = "WARNING"
  is_enabled            = true
  pending_duration      = "PT15M"
  destinations          = [var.notification_topic_id]

  # 0.031 req/second ≈ 80k/month per queue ≈ 80% of 1M free allowance with headroom

  body = "${var.project_name} ${var.environment} OCI Queue is approaching the monthly free-allowance limit. Review usage."

  freeform_tags = {
    environment = var.environment
    project     = var.project_name
    managed_by  = "terraform"
  }
}

variable "notification_topic_id" {
  description = "Notification topic OCID for alarm destinations"
  type        = string
  default     = ""
}
