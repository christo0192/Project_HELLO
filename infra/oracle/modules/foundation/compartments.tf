# Compartment hierarchy: environment-specific isolation
resource "oci_identity_compartment" "this" {
  compartment_id = var.tenancy_ocid
  name           = "${var.project_name}-${var.environment}"
  description    = "${title(var.environment)} compartment for ${var.project_name} voice screening platform"

  freeform_tags = {
    environment = var.environment
    project     = var.project_name
    cost_center = var.cost_center
    managed_by  = "terraform"
  }
}

output "compartment_id" {
  description = "Compartment OCID for the environment"
  value       = oci_identity_compartment.this.id
}
