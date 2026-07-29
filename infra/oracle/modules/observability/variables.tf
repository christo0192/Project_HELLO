# Observability module: OCI Logging, Monitoring, APM, Notifications.
# Region is always an input.
# The foundation module owns the single authoritative compartment budget and alert rule.
# Log group is the only logging resource — agent-managed CUSTOM logs are onboarded
# when compute instances are deployed.

variable "region" {
  description = "OCI region"
  type        = string
}

variable "tenancy_ocid" {
  description = "OCI tenancy OCID"
  type        = string
  sensitive   = true
}

variable "compartment_id" {
  description = "Compartment OCID for observability resources"
  type        = string
}

variable "environment" {
  description = "staging or production"
  type        = string
}

variable "project_name" {
  description = "Project name prefix"
  type        = string
  default     = "hr-screening"
}

variable "notification_email" {
  description = "Email address for alarm notifications (required — no default)"
  type        = string
}

variable "log_retention_days" {
  description = "Log retention in days"
  type        = number
  default     = 30
}

# PII/secret redaction is NOT applied by Terraform — there is no OCISERVICE
# source to attach redaction patterns to. Redaction MUST be implemented at the
# application logging library level and/or the OCI Logging agent configuration.
# See: docs/runbooks/oci-platform-operator.md for onboarding steps.
