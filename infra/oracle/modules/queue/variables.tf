# Queue module: OCI Queue service with service-managed dead-letter, IAM, and alarms
# Region is always an input.
# OCI Queue is NOT an Always Free service. Pricing is pay-per-request.
# A first-1M-requests/month no-charge tier was documented as of 2026-07-28 but is
# not an Always Free guarantee and may change. See https://www.oracle.com/cloud/queue/pricing/

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
}

variable "message_retention_seconds" {
  description = "How long messages are retained in the primary queue (seconds)"
  type        = number
  default     = 1209600 # 14 days
}

variable "visibility_timeout_seconds" {
  description = "How long a consumed message is invisible before retry (seconds)"
  type        = number
  default     = 600 # 10 minutes
}

variable "queue_monthly_cost_threshold" {
  description = "Monthly cost threshold in USD for queue cost alarm (OCI Queue is pay-per-request, NOT Always Free)"
  type        = number
  default     = 5
}

variable "notification_topic_id" {
  description = "Notification topic OCID for alarm destinations"
  type        = string
  default     = ""
}
