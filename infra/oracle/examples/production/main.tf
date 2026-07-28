# Production example root — isolated, multi-AD ready, stricter controls
# Usage:
#   cd infra/oracle/examples/production
#   cp terraform.tfvars.example terraform.tfvars   # edit with real OCIDs
#   terraform init
#   terraform plan   # always plan-only; apply needs manual approval + change control

module "foundation" {
  source = "../../modules/foundation"

  region             = var.region
  tenancy_ocid       = var.tenancy_ocid
  environment        = "production"
  project_name       = var.project_name
  cost_center        = var.cost_center
  budget_alert_email = var.alert_email

  # Production: larger CIDR blocks, NAT gateway
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
  visibility_timeout_seconds = 600
}

module "observability" {
  source = "../../modules/observability"

  region         = var.region
  tenancy_ocid   = var.tenancy_ocid
  compartment_id = module.foundation.compartment_id
  environment    = "production"
  project_name   = var.project_name

  notification_email = var.alert_email

  # Log retention (production: longer)
  log_retention_days = 90

  # Trace sampling is configured at the APM agent/collector level, not here.
}
