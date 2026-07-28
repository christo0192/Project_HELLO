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
  type    = string
  default = "engineering"
}

variable "alert_email" {
  description = "Email address for budget and alarm notifications (required — no default)"
  type        = string
}
