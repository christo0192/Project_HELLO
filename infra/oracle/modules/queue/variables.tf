# Queue module: OCI Queue service with service-managed dead-letter, IAM, and alarms.
# Region is inherited from the root provider block — no separate region variable.
# OCI Queue is NOT an Always Free service. Pricing is pay-per-request.
# A first-1M-requests/month no-charge tier was documented as of 2026-07-28 but is
# not an Always Free guarantee and may change. See https://www.oracle.com/cloud/queue/pricing/

variable "compartment_id" {
  description = "Compartment OCID for queue resources"
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

variable "primary_queue_name" {
  description = "Display name for the primary queue"
  type        = string
  default     = "session-jobs"
}

variable "dead_letter_delivery_count" {
  description = "Number of delivery attempts before the OCI service moves the message to its internal dead-letter sub-queue"
  type        = number
  default     = 3
  validation {
    condition     = var.dead_letter_delivery_count >= 1 && var.dead_letter_delivery_count <= 10
    error_message = "dead_letter_delivery_count must be between 1 and 10"
  }
}

variable "message_retention_seconds" {
  description = "How long messages are retained in the primary queue (seconds)"
  type        = number
  default     = 1209600 # 14 days
  validation {
    condition     = var.message_retention_seconds >= 60 && var.message_retention_seconds <= 1209600
    error_message = "message_retention_seconds must be between 60 (1 min) and 1209600 (14 days)"
  }
}

variable "visibility_timeout_seconds" {
  description = "How long a consumed message is invisible before retry (seconds)"
  type        = number
  default     = 600 # 10 minutes
  validation {
    condition     = var.visibility_timeout_seconds >= 30 && var.visibility_timeout_seconds <= 43200
    error_message = "visibility_timeout_seconds must be between 30 and 43200 (12 hours)"
  }
}

variable "polling_timeout_seconds" {
  description = "Long-poll timeout for consume requests — distinct from visibility (seconds)"
  type        = number
  default     = 30
  validation {
    condition     = var.polling_timeout_seconds >= 1 && var.polling_timeout_seconds <= 30
    error_message = "polling_timeout_seconds must be between 1 and 30"
  }
}

# No per-request cost alarm is provisioned — the compartment budget alert rule
# in the foundation module is the authoritative cost guardrail.

variable "notification_topic_id" {
  description = "Notification topic OCID for alarm destinations (required — no default)"
  type        = string
}
