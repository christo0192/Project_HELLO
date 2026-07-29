# OCI Logging: log group only (foundation).
# Application and service logs are NOT provisioned here — there are no real OCI
# service sources or agents yet. Once compute instances with the OCI Logging
# agent exist, configure CUSTOM logs with the agent-managed source.
# OCI Audit logs are automatic at the tenancy level and do not need a service
# log resource.
#
# PII/secret redaction MUST be configured at the application layer (structured
# logging library) and/or the OCI Logging agent configuration. No Terraform
# redaction patterns are applied because there is no OCISERVICE source to
# attach them to.

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
  description = "Log group OCID — attach agent-managed CUSTOM logs here"
  value       = oci_logging_log_group.this.id
}

# Log-source onboarding (PENDING):
# When compute instances with the OCI Logging agent are deployed, add one
# CUSTOM log per service using "source_type = OCISERVICE" with the agent's
# resource OCID. Example skeleton:
#
# resource "oci_logging_log" "application" {
#   log_group_id = oci_logging_log_group.this.id
#   log_type     = "CUSTOM"
#   display_name = "${var.project_name}-${var.environment}-app-log"
#   configuration {
#     source {
#       source_type = "OCISERVICE"
#       resource    = "<agent-resource-ocid>"  # from the compute agent
#       category    = "application"
#     }
#   }
# }
#
# OCI Audit log service is automatic at tenancy level — no Terraform resource needed.
