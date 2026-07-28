# Root-level variables — shared across staging and production.
# Each example root overrides as needed.

variable "region" {
  description = "OCI region identifier (e.g., ap-mumbai-1, ap-hyderabad-1). Must be overridden."
  type        = string
  default     = "placeholder-region"
}

variable "tenancy_ocid" {
  description = "OCI tenancy OCID. Injected via TF_VAR_tenancy_ocid; never committed."
  type        = string
  sensitive   = true
  default     = ""
}

variable "environment" {
  description = "Deployment environment: staging or production"
  type        = string
  default     = "staging"

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production"
  }
}

variable "project_name" {
  description = "Project name prefix for resource naming"
  type        = string
  default     = "hr-screening"
}

variable "cost_center" {
  description = "Cost center tag value"
  type        = string
  default     = "engineering"
}
