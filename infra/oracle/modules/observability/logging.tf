# OCI Logging: log group + service logs with retention and redaction

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

# Application log — structured JSON, redacted
resource "oci_logging_log" "application" {
  display_name = "${var.project_name}-${var.environment}-app-log"
  log_group_id = oci_logging_log_group.this.id
  log_type     = "CUSTOM"

  configuration {
    source {
      category    = "application"
      resource    = "${var.project_name}-${var.environment}"
      service     = "application"
      source_type = "OCISERVICE"
    }

    compartment_id = var.compartment_id
  }

  retention_duration = var.log_retention_days

  freeform_tags = {
    environment = var.environment
    project     = var.project_name
    managed_by  = "terraform"
  }
}

# Audit/security log
resource "oci_logging_log" "audit" {
  display_name = "${var.project_name}-${var.environment}-audit-log"
  log_group_id = oci_logging_log_group.this.id
  log_type     = "SERVICE"

  configuration {
    source {
      category    = "audit"
      resource    = "${var.project_name}-${var.environment}"
      service     = "audit"
      source_type = "OCISERVICE"
    }

    compartment_id = var.compartment_id
  }

  retention_duration = max(var.log_retention_days, 90)

  freeform_tags = {
    environment = var.environment
    project     = var.project_name
    managed_by  = "terraform"
  }
}

output "log_group_id" {
  description = "Log group OCID"
  value       = oci_logging_log_group.this.id
}
