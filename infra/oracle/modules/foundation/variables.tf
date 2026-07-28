# Foundation module: compartments, networking, IAM, Vault, tags, budgets
# Region is always an input. No tenancy/compartment/credential is hardcoded.

variable "region" {
  description = "OCI region"
  type        = string
}

variable "tenancy_ocid" {
  description = "OCI tenancy OCID"
  type        = string
  sensitive   = true
}

variable "environment" {
  description = "staging or production"
  type        = string
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

# Networking
variable "vcn_cidr" {
  description = "VCN CIDR block"
  type        = string
}

variable "public_subnet_cidr" {
  description = "Public subnet CIDR (within VCN CIDR)"
  type        = string
}

variable "private_subnet_cidr" {
  description = "Private subnet CIDR (within VCN CIDR)"
  type        = string
}

variable "create_nat_gateway" {
  description = "Whether to create a NAT gateway for private subnet egress"
  type        = bool
  default     = true
}

variable "enable_http_ingress" {
  description = "Temporarily open port 80 for certificate validation (ACME HTTP-01). Set to false after provisioning."
  type        = bool
  default     = false
}
