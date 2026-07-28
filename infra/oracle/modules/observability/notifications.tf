# OCI Notifications: topic + email subscription
# Used as alarm destination for all monitoring alarms.

resource "oci_ons_notification_topic" "this" {
  compartment_id = var.compartment_id
  name           = "${var.project_name}-${var.environment}-alerts"
  description    = "Alert notification topic for ${var.environment}"

  freeform_tags = {
    environment = var.environment
    project     = var.project_name
    managed_by  = "terraform"
  }
}

resource "oci_ons_subscription" "email" {
  compartment_id = var.compartment_id
  topic_id       = oci_ons_notification_topic.this.id
  protocol       = "EMAIL"
  endpoint       = var.notification_email

  freeform_tags = {
    environment = var.environment
    project     = var.project_name
    managed_by  = "terraform"
  }
}

output "notification_topic_id" {
  description = "Notification topic OCID for alarm destinations"
  value       = oci_ons_notification_topic.this.id
}
