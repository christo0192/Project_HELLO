# OCI Vault: KMS and secret references
# Only key infrastructure is provisioned. Secret values are NEVER committed.
# Secrets are created out-of-band and referenced by OCID.

resource "oci_kms_vault" "this" {
  compartment_id = oci_identity_compartment.this.id
  display_name   = "${var.project_name}-${var.environment}-vault"
  vault_type     = "DEFAULT"

  freeform_tags = {
    environment = var.environment
    project     = var.project_name
    managed_by  = "terraform"
  }
}

# Master encryption key for the vault
resource "oci_kms_key" "this" {
  compartment_id      = oci_identity_compartment.this.id
  display_name        = "${var.project_name}-${var.environment}-master-key"
  management_endpoint = oci_kms_vault.this.management_endpoint
  key_shape {
    algorithm = "AES"
    length    = 32
  }

  freeform_tags = {
    environment = var.environment
    project     = var.project_name
    managed_by  = "terraform"
  }
}

output "vault_id" {
  description = "Vault OCID for secret creation"
  value       = oci_kms_vault.this.id
}

output "vault_management_endpoint" {
  description = "Vault management endpoint URL"
  value       = oci_kms_vault.this.management_endpoint
}

output "master_key_id" {
  description = "Master encryption key OCID"
  value       = oci_kms_key.this.id
}
