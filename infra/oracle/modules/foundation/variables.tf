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
  description = "Project name prefix for resource naming (lowercase letter start, then lowercase alnum/hyphens, 1-30 chars)"
  type        = string
  default     = "hr-screening"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,29}$", var.project_name))
    error_message = "project_name must start with lowercase letter, contain only lowercase alphanumeric/hyphens, and be 1-30 chars."
  }
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

variable "vcn_dns_label" {
  description = "VCN DNS label (max 15 chars, alphanumeric, must start with letter)"
  type        = string
  default     = "hrplatform"
  validation {
    condition     = can(regex("^[a-zA-Z][a-zA-Z0-9]{0,14}$", var.vcn_dns_label))
    error_message = "vcn_dns_label must be 1-15 chars, start with letter, alphanumeric only."
  }
}
