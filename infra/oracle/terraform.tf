# Provider and version pinning
# No tenancy, compartment, or credential values are committed.
# Configure these via environment variables or terraform.tfvars (gitignored):
#   TF_VAR_tenancy_ocid, TF_VAR_user_ocid, TF_VAR_fingerprint, TF_VAR_private_key_path
#   TF_VAR_region

terraform {
  required_version = ">= 0.14, < 2.0"

  required_providers {
    oci = {
      source  = "hashicorp/oci"
      version = ">= 5.0, < 7.0"
    }
  }

  # Remote-state guidance (replace placeholders before use):
  # backend "s3" {
  #   bucket   = "<oci-object-storage-bucket>"
  #   key      = "oci-platform/terraform.tfstate"
  #   region   = "<region>"
  #   endpoint = "https://<namespace>.compat.objectstorage.<region>.oraclecloud.com"
  #   skip_region_validation      = true
  #   skip_credentials_validation = true
  #   skip_metadata_api_check     = true
  #   force_path_style            = true
  # }
  #
  # For local-only development (no remote state):
  backend "local" {}
}
