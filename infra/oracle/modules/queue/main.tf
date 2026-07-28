# OCI Queue resource: primary queue with service-managed dead-letter
# OCI Queue uses an internal dead-letter sub-queue — no separate queue resource exists.
# dead_letter_queue_delivery_count controls how many delivery attempts occur before
# messages are moved to the service-managed DLQ sub-queue.
# Producer/consumer IAM is handled by the foundation module's dynamic groups.

resource "oci_queue_queue" "primary" {
  compartment_id = var.compartment_id
  display_name   = var.primary_queue_name

  retention_in_seconds      = var.message_retention_seconds
  visibility_in_seconds     = var.visibility_timeout_seconds
  timeout_in_seconds        = var.visibility_timeout_seconds
  channel_consumption_limit = 0 # unlimited

  # Internal dead-letter: after N delivery attempts, messages move to the
  # service-managed dead-letter sub-queue (not a separately-provisioned queue).
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

output "dead_letter_delivery_count" {
  description = "Configured delivery count before messages move to the service-managed DLQ sub-queue"
  value       = var.dead_letter_delivery_count
}
