# OCI APM: Application Performance Monitoring domain
# Trace sampling is configurable per environment.

resource "oci_apm_apm_domain" "this" {
  compartment_id = var.compartment_id
  display_name   = "${var.project_name}-${var.environment}-apm"
  description    = "APM domain for ${var.environment} voice screening"

  freeform_tags = {
    environment = var.environment
    project     = var.project_name
    managed_by  = "terraform"
  }
}

output "apm_domain_id" {
  description = "APM domain OCID"
  value       = oci_apm_apm_domain.this.id
}

output "apm_data_upload_endpoint" {
  description = "APM data upload endpoint URL"
  value       = oci_apm_apm_domain.this.data_upload_endpoint
}
