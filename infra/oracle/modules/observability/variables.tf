# Observability module: OCI Logging, Monitoring, APM, Notifications, budget guardrails
# Region is always an input.

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

variable "monthly_budget_amount" {
  description = "Monthly budget in USD"
  type        = number
  default     = 500
}

variable "budget_alert_threshold" {
  description = "Budget alert threshold percentage (1-100)"
  type        = number
  default     = 80
}

variable "notification_email" {
  description = "Email address for budget and alarm notifications"
  type        = string
  default     = "alerts@example.com"
}

variable "log_retention_days" {
  description = "Log retention in days"
  type        = number
  default     = 30
}

variable "apm_trace_sampling_percent" {
  description = "APM trace sampling percentage (1-100)"
  type        = number
  default     = 10
  validation {
    condition     = var.apm_trace_sampling_percent > 0 && var.apm_trace_sampling_percent <= 100
    error_message = "apm_trace_sampling_percent must be between 1 and 100"
  }
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
