# Observability module: OCI Logging, Monitoring, APM, Notifications
# Region is always an input.
# The foundation module owns the single authoritative compartment budget and alert rule.

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

# PII/secret redaction patterns — configurable per environment
variable "log_redaction_patterns" {
  description = "List of regex patterns to redact from logs"
  type        = list(string)
  default = [
    "\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Z|a-z]{2,}\\b", # email
    "\\b(?:\\+?91[\\-\\s]?)?[6-9]\\d{9}\\b",                  # Indian phone
    "\\b\\d{4}[- ]?\\d{4}[- ]?\\d{4}[- ]?\\d{4}\\b",          # PAN-like
    "\\b[A-Z]{5}[0-9]{4}[A-Z]{1}\\b",                         # PAN card
    "\\b\\d{12}\\b",                                          # Aadhaar-like
    "\\bsk-[a-zA-Z0-9]{32,}\\b",                              # API keys
    "\\bBearer\\s+[A-Za-z0-9._\\-]+\\b",                      # Bearer tokens
    "\\bocid1\\.vaultsecret\\.[a-z0-9]+\\b",                  # OCI secret OCIDs (redact value, keep ref)
  ]
}
