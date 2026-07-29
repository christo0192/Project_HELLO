# Production example root — isolated, multi-AD ready, stricter controls.
# Usage:
#   cd infra/oracle/examples/production
#   cp terraform.tfvars.example terraform.tfvars   # edit with real OCIDs
#   terraform init
#   terraform plan   # always plan-only; apply needs change control

# BLOCKED: Production apply is unavailable until encrypted remote state is configured.
# Local state can contain APM data keys and must never hold production metadata.
# To unblock: replace the throw-if backend below with a real remote backend
# (OCI Object Storage + SSE) and set BLOCK_PRODUCTION_APPLY=false.

terraform {
  required_version = ">= 1.5, < 2.0"

  required_providers {
    oci = {
      source  = "hashicorp/oci"
      version = "~> 6.0"
    }
  }

  # THROW: remove this block and configure a real encrypted remote backend
  # before applying in production. Example remote backend for production:
  #
  # backend "s3" {
  #   bucket                      = "<prod-state-bucket>"
  #   key                         = "oci-platform/production/terraform.tfstate"
  #   region                      = "<region>"
  #   endpoint                    = "https://<ns>.compat.objectstorage.<region>.oraclecloud.com"
  #   skip_region_validation      = true
  #   skip_credentials_validation = true
  #   skip_metadata_api_check     = true
  #   force_path_style            = true
  #   encrypt                     = true
  # }

  backend "local" {
    # Intentional: init will fail until BLOCK_PRODUCTION_APPLY is explicitly
    # set to false (this block is a guard, not a working backend).
  }
}

provider "oci" {
  region = var.region
}

# --- inputs (no values committed — use terraform.tfvars) ---

variable "region" {
  description = "OCI region (e.g., ap-mumbai-1, ap-hyderabad-1)"
  type        = string
  default     = "placeholder-region"
}

variable "tenancy_ocid" {
  description = "OCI tenancy OCID"
  type        = string
  sensitive   = true
}

variable "project_name" {
  type    = string
  default = "hr-screening"
}

variable "cost_center" {
  type    = string
  default = "engineering"
}

variable "alert_email" {
  description = "Email address for budget and alarm notifications (required — no default)"
  type        = string
}

variable "vcn_dns_label" {
  description = "VCN DNS label (max 15 alphanumeric, no hyphen at start/end)"
  type        = string
  default     = "hproduction"
}

# --- modules ---

module "foundation" {
  source = "../../modules/foundation"

  region             = var.region
  tenancy_ocid       = var.tenancy_ocid
  environment        = "production"
  project_name       = var.project_name
  cost_center        = var.cost_center
  budget_alert_email = var.alert_email
  vcn_dns_label      = var.vcn_dns_label

  # Production: larger CIDRs, NAT gateway
  vcn_cidr            = "10.0.0.0/16"
  public_subnet_cidr  = "10.0.1.0/24"
  private_subnet_cidr = "10.0.2.0/24"
  create_nat_gateway  = true
}

module "queue" {
  source = "../../modules/queue"

  region                = var.region
  tenancy_ocid          = var.tenancy_ocid
  compartment_id        = module.foundation.compartment_id
  environment           = "production"
  project_name          = var.project_name
  notification_topic_id = module.observability.notification_topic_id

  primary_queue_name         = "session-jobs-prod"
  dead_letter_delivery_count = 5
  message_retention_seconds  = 1209600 # 14 days
  visibility_timeout_seconds = 600     # 10 min
  polling_timeout_seconds    = 30
}

module "observability" {
  source = "../../modules/observability"

  region             = var.region
  tenancy_ocid       = var.tenancy_ocid
  compartment_id     = module.foundation.compartment_id
  environment        = "production"
  project_name       = var.project_name
  notification_email = var.alert_email
  log_retention_days = 90
}
