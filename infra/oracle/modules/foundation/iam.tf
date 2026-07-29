# IAM baseline: role-separated, fail-closed dynamic groups scoped to the environment compartment.
# Queue permissions are producer/consumer-specific. Secret-bundle access remains compartment-wide until real secret OCIDs exist and must be narrowed before deployment acceptance.
# No static user credentials or API keys are provisioned.
#
# Fail-closed matching: the api_tier and worker_tier dynamic groups use distinct
# defined-tag matching rules per the official OCI grammar:
#   All {condition1, condition2, ...}
# The tag namespace and key use underscore-safe names for parser compatibility.
#
# Every compute instance MUST be tagged with workload_role = "api" or "worker":
#   defined_tags = { "${local.project_name_safe}_${var.environment}_tags.workload_role" = "api" }

# Dynamic group for the API/web tier
resource "oci_identity_dynamic_group" "api_tier" {
  compartment_id = var.tenancy_ocid
  name           = "${var.project_name}-${var.environment}-api-dg"
  description    = "Dynamic group for ${var.environment} API/web compute instances (tag: workload_role=api)"

  matching_rule = "All {instance.compartment.id = '${oci_identity_compartment.this.id}', tag.${oci_identity_tag_namespace.this.name}.${oci_identity_tag.workload_role.name}.value = 'api'}"
}

# Dynamic group for the worker tier
resource "oci_identity_dynamic_group" "worker_tier" {
  compartment_id = var.tenancy_ocid
  name           = "${var.project_name}-${var.environment}-worker-dg"
  description    = "Dynamic group for ${var.environment} worker/queue-consumer instances (tag: workload_role=worker)"

  matching_rule = "All {instance.compartment.id = '${oci_identity_compartment.this.id}', tag.${oci_identity_tag_namespace.this.name}.${oci_identity_tag.workload_role.name}.value = 'worker'}"
}

# Policy: API tier — role-separated baseline
# Official OCI Queue verbs: 'use queue-push' (QUEUE_PRODUCE) for publishers.
resource "oci_identity_policy" "api_tier" {
  compartment_id = var.tenancy_ocid
  name           = "${var.project_name}-${var.environment}-api-policy"
  description    = "Role-separated baseline policy for ${var.environment} API/web tier"

  statements = [
    # Queue: publish messages (scoring, notifications)
    "Allow dynamic-group ${oci_identity_dynamic_group.api_tier.name} to use queue-push in compartment ${oci_identity_compartment.this.name}",
    # Vault: read secrets
    "Allow dynamic-group ${oci_identity_dynamic_group.api_tier.name} to read secret-bundles in compartment ${oci_identity_compartment.this.name}",
    # Logging: emit logs
    "Allow dynamic-group ${oci_identity_dynamic_group.api_tier.name} to use log-content in compartment ${oci_identity_compartment.this.name}",
    # Metrics: emit custom metrics
    "Allow dynamic-group ${oci_identity_dynamic_group.api_tier.name} to use metrics in compartment ${oci_identity_compartment.this.name}",
  ]
}

# Policy: Worker tier — role-separated baseline
# Official OCI Queue verbs: 'use queue-pull' (QUEUE_CONSUME + QUEUE_DELETE) for consumers.
resource "oci_identity_policy" "worker_tier" {
  compartment_id = var.tenancy_ocid
  name           = "${var.project_name}-${var.environment}-worker-policy"
  description    = "Role-separated baseline policy for ${var.environment} worker tier"

  statements = [
    # Queue: consume and delete messages
    "Allow dynamic-group ${oci_identity_dynamic_group.worker_tier.name} to use queue-pull in compartment ${oci_identity_compartment.this.name}",
    # Vault: read secrets (for STT/TTS/LLM API keys)
    "Allow dynamic-group ${oci_identity_dynamic_group.worker_tier.name} to read secret-bundles in compartment ${oci_identity_compartment.this.name}",
    # Logging: emit logs
    "Allow dynamic-group ${oci_identity_dynamic_group.worker_tier.name} to use log-content in compartment ${oci_identity_compartment.this.name}",
    # Metrics: emit custom metrics
    "Allow dynamic-group ${oci_identity_dynamic_group.worker_tier.name} to use metrics in compartment ${oci_identity_compartment.this.name}",
  ]
}

output "api_dynamic_group_name" {
  description = "API tier dynamic group name"
  value       = oci_identity_dynamic_group.api_tier.name
}

output "worker_dynamic_group_name" {
  description = "Worker tier dynamic group name"
  value       = oci_identity_dynamic_group.worker_tier.name
}

output "tag_namespace_name" {
  description = "Tag namespace name for defined_tags on compute instances"
  value       = oci_identity_tag_namespace.this.name
}

output "workload_role_tag_key" {
  description = "workload_role defined-tag key — MUST be set on every compute instance"
  value       = oci_identity_tag.workload_role.name
}

output "required_compute_tag" {
  description = "Example defined_tags entry for compute instances"
  value       = "${oci_identity_tag_namespace.this.name}.${oci_identity_tag.workload_role.name} = api | worker"
}
