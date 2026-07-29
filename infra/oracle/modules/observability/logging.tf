# OCI Logging: log group only (foundation).
# Application and service logs are NOT provisioned here — there are no real OCI
# service sources or agents yet. CUSTOM log onboarding follows actual agent
# configuration when compute instances are deployed; no fake source_type guidance.
# OCI Audit logs are automatic at the tenancy level and do not need a service
# log resource.
#
# PII/secret redaction MUST be configured at the application layer (structured
# logging library) and/or the OCI Logging agent configuration.

resource "oci_logging_log_group" "this" {
  compartment_id = var.compartment_id
  display_name   = "${var.project_name}-${var.environment}-logs"
  description    = "Log group for ${var.environment} application and infrastructure logs"

  freeform_tags = {
    environment = var.environment
    project     = var.project_name
    managed_by  = "terraform"
  }
}

output "log_group_id" {
  description = "Log group OCID — attach agent-managed CUSTOM logs here when compute instances are deployed"
  value       = oci_logging_log_group.this.id
}
