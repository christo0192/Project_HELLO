# OCI Queue resources: primary queue + dead-letter queue
# Producer/consumer IAM is handled by the foundation module's dynamic groups.
# This module creates the queue infrastructure only.

# Dead-letter queue
resource "oci_queue_queue" "dead_letter" {
  compartment_id = var.compartment_id
  display_name   = var.dead_letter_queue_name

  retention_in_seconds      = var.dlq_message_retention_seconds
  visibility_in_seconds     = var.visibility_timeout_seconds
  timeout_in_seconds        = var.visibility_timeout_seconds
  channel_consumption_limit = 0 # unlimited

  freeform_tags = {
    environment = var.environment
    project     = var.project_name
    managed_by  = "terraform"
    queue_type  = "dead-letter"
  }
}

# Primary queue with dead-letter configuration
resource "oci_queue_queue" "primary" {
  compartment_id = var.compartment_id
  display_name   = var.primary_queue_name

  retention_in_seconds      = var.message_retention_seconds
  visibility_in_seconds     = var.visibility_timeout_seconds
  timeout_in_seconds        = var.visibility_timeout_seconds
  channel_consumption_limit = 0 # unlimited

  # Dead-letter policy: after N delivery attempts, move to DLQ
  dead_letter_queue_delivery_count = var.dead_letter_delivery_count

  freeform_tags = {
    environment = var.environment
    project     = var.project_name
    managed_by  = "terraform"
    queue_type  = "primary"
  }
}

output "primary_queue_id" {
  description = "Primary queue OCID"
  value       = oci_queue_queue.primary.id
}

output "primary_queue_url" {
  description = "Primary queue URL (messages endpoint)"
  value       = oci_queue_queue.primary.messages_endpoint
}

output "dead_letter_queue_id" {
  description = "Dead-letter queue OCID"
  value       = oci_queue_queue.dead_letter.id
}

output "dead_letter_queue_url" {
  description = "Dead-letter queue URL (messages endpoint)"
  value       = oci_queue_queue.dead_letter.messages_endpoint
}
