# Queue module: OCI Queue service with dead-letter, IAM, and alarms
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

variable "dead_letter_queue_name" {
  description = "Display name for the dead-letter queue"
  type        = string
  default     = "session-jobs-dlq"
}

variable "dead_letter_delivery_count" {
  description = "Number of delivery attempts before moving to DLQ"
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

variable "dlq_message_retention_seconds" {
  description = "How long messages are retained in the DLQ (seconds)"
  type        = number
  default     = 2592000 # 30 days
}
