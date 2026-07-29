# Staging example root — isolated, scaled-down, non-production data only.
# Usage:
#   cd infra/oracle/examples/staging
#   cp terraform.tfvars.example terraform.tfvars   # edit with real OCIDs
#   terraform init
#   terraform plan   # always plan-only; apply needs manual approval

terraform {
  required_version = ">= 1.5, < 2.0"

  required_providers {
    oci = {
      source  = "hashicorp/oci"
      version = "~> 6.0"
    }
  }

  # Local state acceptable for staging.
  # Production MUST use remote encrypted state — see production root for details.
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
  type    = string
  default = "hr-screening"
}

variable "cost_center" {
  description = "Cost center tag value"
  type        = string
  default     = "engineering"
}

variable "alert_email" {
  description = "Email address for budget and alarm notifications (required — no default)"
  type        = string
}

variable "vcn_dns_label" {
  description = "VCN DNS label (max 15 alphanumeric, no hyphen at start/end)"
  type        = string
  default     = "hstaging"
}

# --- modules ---

module "foundation" {
  source = "../../modules/foundation"

  region             = var.region
  tenancy_ocid       = var.tenancy_ocid
  environment        = "staging"
  project_name       = var.project_name
  cost_center        = var.cost_center
  budget_alert_email = var.alert_email
  vcn_dns_label      = var.vcn_dns_label

  # Staging: single AD, smaller CIDRs
  vcn_cidr            = "10.1.0.0/16"
  public_subnet_cidr  = "10.1.1.0/24"
  private_subnet_cidr = "10.1.2.0/24"
  create_nat_gateway  = true
}

module "queue" {
  source = "../../modules/queue"

  region                = var.region
  tenancy_ocid          = var.tenancy_ocid
  compartment_id        = module.foundation.compartment_id
  environment           = "staging"
  project_name          = var.project_name
  notification_topic_id = module.observability.notification_topic_id

  primary_queue_name         = "session-jobs-staging"
  dead_letter_delivery_count = 3
  message_retention_seconds  = 86400 # 1 day
  visibility_timeout_seconds = 300   # 5 min
  polling_timeout_seconds    = 30
}

module "observability" {
  source = "../../modules/observability"

  region             = var.region
  tenancy_ocid       = var.tenancy_ocid
  compartment_id     = module.foundation.compartment_id
  environment        = "staging"
  project_name       = var.project_name
  notification_email = var.alert_email
  log_retention_days = 30
}
