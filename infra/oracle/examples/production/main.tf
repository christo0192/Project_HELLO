# Production example root — isolated, multi-AD ready, stricter controls.
# Usage:
#   cd infra/oracle/examples/production
#   cp terraform.tfvars.example terraform.tfvars   # edit with real OCIDs
#   terraform init
#   terraform plan   # always plan-only; apply needs change control
#
# ===========================================================================
# BLOCKED: Production plan & apply both FAIL until:
#   1. Remote encrypted state is configured (OCI Object Storage + SSE).
#      Replace the backend block below with a real S3-compat remote backend.
#   2. production_apply_enabled is explicitly set to true in terraform.tfvars.
#
# See comments on backend and production_apply_enabled below.
# ===========================================================================

terraform {
  required_version = ">= 1.5, < 2.0"

  required_providers {
    oci = {
      source  = "hashicorp/oci"
      version = "~> 8.23.0"
    }
  }

  # REMOTE STATE REQUIRED for production.  Replace this local backend with:
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

  backend "local" {}
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
  description = "Project name (lowercase letter start, then lowercase alnum/hyphens, 1-30 chars). Used as prefix for OCI resources and tag namespaces."
  type        = string
  default     = "hr-screening"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,29}$", var.project_name))
    error_message = "project_name must start with lowercase letter, contain only lowercase alphanumeric/hyphens, and be 1-30 chars."
  }
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
  validation {
    condition     = can(regex("^[a-zA-Z][a-zA-Z0-9]{0,14}$", var.vcn_dns_label))
    error_message = "vcn_dns_label must be 1-15 chars, start with letter, alphanumeric only."
  }
}

variable "monthly_budget_amount" {
  description = "Monthly budget for production in USD (required — owner must approve before provisioning). Conservative starting value: $100 for OCI free-tier services."
  type        = number
  validation {
    condition     = var.monthly_budget_amount > 0
    error_message = "monthly_budget_amount must be greater than 0."
  }
}

# ===========================================================================
# PRODUCTION APPLY GATE
# 
# This terraform_data resource BLOCKS both plan and apply until the operator
# explicitly sets production_apply_enabled = true in terraform.tfvars.
#
# To unblock production:
#   1. Replace backend "local" with a real encrypted remote backend (see above).
#   2. Run: terraform init  (to migrate state to remote backend).
#   3. Set production_apply_enabled = true in terraform.tfvars.
#   4. Re-run terraform plan.
# ===========================================================================

variable "production_apply_enabled" {
  description = "EXPLICITLY set to true after configuring remote encrypted state. Plan and apply will fail until this is true."
  type        = bool
  default     = false
}

resource "terraform_data" "production_apply_gate" {
  lifecycle {
    precondition {
      condition     = var.production_apply_enabled == true
      error_message = <<-EOT
PRODUCTION APPLY BLOCKED.

To unblock:
1. Replace backend "local" in this file with a real encrypted remote backend
   (OCI Object Storage + SSE).  See the commented example above.
2. Run:  terraform init   (to migrate state to the remote backend).
3. Set production_apply_enabled = true in terraform.tfvars.
4. Re-run terraform plan.

Local state must never hold production metadata (APM data keys, queue URLs,
compartment OCIDs).  See docs/runbooks/oci-platform-operator.md for details.
EOT
    }
  }
}

# --- modules ---

module "foundation" {
  source = "../../modules/foundation"

  region                = var.region
  tenancy_ocid          = var.tenancy_ocid
  environment           = "production"
  project_name          = var.project_name
  cost_center           = var.cost_center
  budget_alert_email    = var.alert_email
  vcn_dns_label         = var.vcn_dns_label
  monthly_budget_amount = var.monthly_budget_amount

  # Production: larger CIDRs, NAT gateway
  vcn_cidr            = "10.0.0.0/16"
  public_subnet_cidr  = "10.0.1.0/24"
  private_subnet_cidr = "10.0.2.0/24"
  create_nat_gateway  = true
}

module "queue" {
  source = "../../modules/queue"

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

  compartment_id     = module.foundation.compartment_id
  environment        = "production"
  project_name       = var.project_name
  notification_email = var.alert_email
}
