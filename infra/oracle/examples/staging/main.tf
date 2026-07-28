# Staging example root — isolated, scaled-down, non-production data only
# Usage:
#   cd infra/oracle/examples/staging
#   cp terraform.tfvars.example terraform.tfvars   # edit with real OCIDs
#   terraform init
#   terraform plan   # always plan-only; apply needs manual approval

module "foundation" {
  source = "../../modules/foundation"

  region             = var.region
  tenancy_ocid       = var.tenancy_ocid
  environment        = "staging"
  project_name       = var.project_name
  cost_center        = var.cost_center
  budget_alert_email = var.alert_email

  # Staging: single availability domain, smaller CIDR blocks
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
  visibility_timeout_seconds = 300
}

module "observability" {
  source = "../../modules/observability"

  region         = var.region
  tenancy_ocid   = var.tenancy_ocid
  compartment_id = module.foundation.compartment_id
  environment    = "staging"
  project_name   = var.project_name

  notification_email = var.alert_email

  # Log retention (staging: shorter)
  log_retention_days = 30

  # Trace sampling is configured at the APM agent/collector level, not here.
}
