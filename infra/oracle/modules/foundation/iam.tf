# IAM: Dynamic groups and least-privilege policies for service identity
# Policies grant access only to resources within the environment compartment.
# No static user credentials or API keys are provisioned.

# Dynamic group for the API/web tier (public subnet compute instances)
# Matches instances in the environment compartment.
resource "oci_identity_dynamic_group" "api_tier" {
  compartment_id = var.tenancy_ocid
  name           = "${var.project_name}-${var.environment}-api-dg"
  description    = "Dynamic group for ${var.environment} API/web compute instances"
  matching_rule  = "ALL {instance.compartment.id = '${oci_identity_compartment.this.id}'}"
}

# Dynamic group for the worker tier (private subnet compute instances)
resource "oci_identity_dynamic_group" "worker_tier" {
  compartment_id = var.tenancy_ocid
  name           = "${var.project_name}-${var.environment}-worker-dg"
  description    = "Dynamic group for ${var.environment} worker/queue consumer instances"
  matching_rule  = "ALL {instance.compartment.id = '${oci_identity_compartment.this.id}'}"
}

# Policy: API tier permissions — least privilege
resource "oci_identity_policy" "api_tier" {
  compartment_id = var.tenancy_ocid
  name           = "${var.project_name}-${var.environment}-api-policy"
  description    = "Least-privilege policy for ${var.environment} API/web tier"

  statements = [
    # Queue: publish messages (scoring, notifications)
    "Allow dynamic-group ${oci_identity_dynamic_group.api_tier.name} to use queues in compartment ${oci_identity_compartment.this.name} where request.permission = 'QUEUE_PUSH_MESSAGES'",
    # Vault: read secrets
    "Allow dynamic-group ${oci_identity_dynamic_group.api_tier.name} to read secret-bundles in compartment ${oci_identity_compartment.this.name}",
    # Logging: emit logs
    "Allow dynamic-group ${oci_identity_dynamic_group.api_tier.name} to use log-content in compartment ${oci_identity_compartment.this.name}",
    # Metrics: emit custom metrics
    "Allow dynamic-group ${oci_identity_dynamic_group.api_tier.name} to use metrics in compartment ${oci_identity_compartment.this.name} where request.permission = 'METRIC_PUSH'",
  ]
}

# Policy: Worker tier permissions — least privilege
resource "oci_identity_policy" "worker_tier" {
  compartment_id = var.tenancy_ocid
  name           = "${var.project_name}-${var.environment}-worker-policy"
  description    = "Least-privilege policy for ${var.environment} worker tier"

  statements = [
    # Queue: consume and delete messages
    "Allow dynamic-group ${oci_identity_dynamic_group.worker_tier.name} to use queues in compartment ${oci_identity_compartment.this.name} where request.permission = 'QUEUE_CONSUME_MESSAGES'",
    "Allow dynamic-group ${oci_identity_dynamic_group.worker_tier.name} to use queues in compartment ${oci_identity_compartment.this.name} where request.permission = 'QUEUE_DELETE_MESSAGES'",
    # Vault: read secrets (for STT/TTS/LLM API keys)
    "Allow dynamic-group ${oci_identity_dynamic_group.worker_tier.name} to read secret-bundles in compartment ${oci_identity_compartment.this.name}",
    # Logging: emit logs
    "Allow dynamic-group ${oci_identity_dynamic_group.worker_tier.name} to use log-content in compartment ${oci_identity_compartment.this.name}",
    # Metrics: emit custom metrics
    "Allow dynamic-group ${oci_identity_dynamic_group.worker_tier.name} to use metrics in compartment ${oci_identity_compartment.this.name} where request.permission = 'METRIC_PUSH'",
  ]
}
