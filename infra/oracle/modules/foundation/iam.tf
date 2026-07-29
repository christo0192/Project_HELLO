# IAM: Dynamic groups and least-privilege policies for service identity.
# Policies grant access only to resources within the environment compartment.
# No static user credentials or API keys are provisioned.
#
# Fail-closed matching: the api_tier and worker_tier dynamic groups use distinct
# defined-tag matching rules. Every compute instance MUST be tagged with
# workload-role = "api" or workload-role = "worker" at launch time.
# An untagged instance matches NEITHER group and has no rights.

# Defined tag: workload-role (fail-closed)
# Assumes a tag namespace unique to this environment (see tags_budgets.tf).
# The workload-role tag MUST be set on every compute instance at launch:
#   defined_tags = { "${var.project_name}-${var.environment}-tags.workload-role" = "api"  }
#   defined_tags = { "${var.project_name}-${var.environment}-tags.workload-role" = "worker" }

# Dynamic group for the API/web tier — matches only instances tagged workload-role=api
resource "oci_identity_dynamic_group" "api_tier" {
  compartment_id = var.tenancy_ocid
  name           = "${var.project_name}-${var.environment}-api-dg"
  description    = "Dynamic group for ${var.environment} API/web compute instances (tag: workload-role=api)"
  matching_rule  = "ALL {instance.compartment.id = '${oci_identity_compartment.this.id}'} AND ALL {instance.tags.namespace = '${var.project_name}-${var.environment}-tags', instance.tags.key = 'workload-role', instance.tags.value = 'api'}"
}

# Dynamic group for the worker tier — matches only instances tagged workload-role=worker
resource "oci_identity_dynamic_group" "worker_tier" {
  compartment_id = var.tenancy_ocid
  name           = "${var.project_name}-${var.environment}-worker-dg"
  description    = "Dynamic group for ${var.environment} worker/queue-consumer instances (tag: workload-role=worker)"
  matching_rule  = "ALL {instance.compartment.id = '${oci_identity_compartment.this.id}'} AND ALL {instance.tags.namespace = '${var.project_name}-${var.environment}-tags', instance.tags.key = 'workload-role', instance.tags.value = 'worker'}"
}

# Policy: API tier — least privilege
# Official OCI Queue verbs: 'use queue-push' (QUEUE_PRODUCE) for publishers.
resource "oci_identity_policy" "api_tier" {
  compartment_id = var.tenancy_ocid
  name           = "${var.project_name}-${var.environment}-api-policy"
  description    = "Least-privilege policy for ${var.environment} API/web tier"

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

# Policy: Worker tier — least privilege
# Official OCI Queue verbs: 'use queue-pull' (QUEUE_CONSUME + QUEUE_DELETE) for consumers.
resource "oci_identity_policy" "worker_tier" {
  compartment_id = var.tenancy_ocid
  name           = "${var.project_name}-${var.environment}-worker-policy"
  description    = "Least-privilege policy for ${var.environment} worker tier"

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
  description = "API tier dynamic group name — reference in compute provisioning"
  value       = oci_identity_dynamic_group.api_tier.name
}

output "worker_dynamic_group_name" {
  description = "Worker tier dynamic group name — reference in compute provisioning"
  value       = oci_identity_dynamic_group.worker_tier.name
}

output "required_compute_tag_key" {
  description = "workload-role defined-tag key that every compute instance MUST set in defined_tags"
  value       = "workload-role"
}

output "required_compute_tag_namespace" {
  description = "Tag namespace that every compute instance MUST reference in defined_tags"
  value       = "${var.project_name}-${var.environment}-tags"
}

output "required_compute_tag_values" {
  description = "Valid workload-role values: api or worker"
  value       = "api | worker"
}
