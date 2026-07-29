# VCN and subnet layout with isolated public/private tiers
# Region is parameterized via the provider alias or default provider config.

resource "oci_core_vcn" "this" {
  compartment_id = oci_identity_compartment.this.id
  cidr_blocks    = [var.vcn_cidr]
  display_name   = "${var.project_name}-${var.environment}-vcn"
  dns_label      = var.vcn_dns_label

  freeform_tags = {
    environment = var.environment
    project     = var.project_name
    managed_by  = "terraform"
  }
}

# Internet Gateway — for public subnet
resource "oci_core_internet_gateway" "this" {
  compartment_id = oci_identity_compartment.this.id
  vcn_id         = oci_core_vcn.this.id
  display_name   = "${var.project_name}-${var.environment}-ig"
  enabled        = true

  freeform_tags = {
    environment = var.environment
    project     = var.project_name
    managed_by  = "terraform"
  }
}

# NAT Gateway — for private subnet egress
resource "oci_core_nat_gateway" "this" {
  count = var.create_nat_gateway ? 1 : 0

  compartment_id = oci_identity_compartment.this.id
  vcn_id         = oci_core_vcn.this.id
  display_name   = "${var.project_name}-${var.environment}-nat"
  block_traffic  = false

  freeform_tags = {
    environment = var.environment
    project     = var.project_name
    managed_by  = "terraform"
  }
}

# Route table — public subnet
resource "oci_core_route_table" "public" {
  compartment_id = oci_identity_compartment.this.id
  vcn_id         = oci_core_vcn.this.id
  display_name   = "${var.project_name}-${var.environment}-public-rt"

  route_rules {
    destination       = "0.0.0.0/0"
    network_entity_id = oci_core_internet_gateway.this.id
    description       = "Default route to internet gateway"
  }

  freeform_tags = {
    environment = var.environment
    project     = var.project_name
    managed_by  = "terraform"
  }
}

# Route table — private subnet
resource "oci_core_route_table" "private" {
  compartment_id = oci_identity_compartment.this.id
  vcn_id         = oci_core_vcn.this.id
  display_name   = "${var.project_name}-${var.environment}-private-rt"

  dynamic "route_rules" {
    for_each = var.create_nat_gateway ? [1] : []
    content {
      destination       = "0.0.0.0/0"
      network_entity_id = oci_core_nat_gateway.this[0].id
      description       = "Default route to NAT gateway"
    }
  }

  freeform_tags = {
    environment = var.environment
    project     = var.project_name
    managed_by  = "terraform"
  }
}

# Security list — public subnet (API/web tier)
resource "oci_core_security_list" "public" {
  compartment_id = oci_identity_compartment.this.id
  vcn_id         = oci_core_vcn.this.id
  display_name   = "${var.project_name}-${var.environment}-public-sl"

  # Ingress: HTTPS from internet
  ingress_security_rules {
    protocol    = "6" # TCP
    source      = "0.0.0.0/0"
    source_type = "CIDR_BLOCK"
    stateless   = false

    tcp_options {
      min = 443
      max = 443
    }
    description = "Allow HTTPS from internet"
  }

  # Ingress: HTTP (certificate validation — gated behind enable_http_ingress)
  dynamic "ingress_security_rules" {
    for_each = var.enable_http_ingress ? [1] : []
    content {
      protocol    = "6"
      source      = "0.0.0.0/0"
      source_type = "CIDR_BLOCK"
      stateless   = false

      tcp_options {
        min = 80
        max = 80
      }
      description = "Allow HTTP for certificate validation (ACME HTTP-01)"
    }
  }

  # Egress: all outbound
  egress_security_rules {
    protocol         = "all"
    destination      = "0.0.0.0/0"
    destination_type = "CIDR_BLOCK"
    stateless        = false
    description      = "Allow all outbound"
  }

  freeform_tags = {
    environment = var.environment
    project     = var.project_name
    managed_by  = "terraform"
  }
}

# Security list — private subnet (worker/queue tier)
resource "oci_core_security_list" "private" {
  compartment_id = oci_identity_compartment.this.id
  vcn_id         = oci_core_vcn.this.id
  display_name   = "${var.project_name}-${var.environment}-private-sl"

  # Ingress: from public subnet only
  ingress_security_rules {
    protocol    = "6"
    source      = var.public_subnet_cidr
    source_type = "CIDR_BLOCK"
    stateless   = false

    tcp_options {
      min = 8080
      max = 8080
    }
    description = "Allow internal API from public tier"
  }

  # Ingress: internal health checks
  ingress_security_rules {
    protocol    = "6"
    source      = var.public_subnet_cidr
    source_type = "CIDR_BLOCK"
    stateless   = false

    tcp_options {
      min = 9090
      max = 9090
    }
    description = "Allow health checks"
  }

  # Egress: to internet via NAT (for STT/TTS/LLM API calls, OCI services)
  egress_security_rules {
    protocol         = "6"
    destination      = "0.0.0.0/0"
    destination_type = "CIDR_BLOCK"
    stateless        = false

    tcp_options {
      min = 443
      max = 443
    }
    description = "Allow HTTPS outbound for external APIs"
  }

  # Egress: DNS
  egress_security_rules {
    protocol         = "17" # UDP
    destination      = "0.0.0.0/0"
    destination_type = "CIDR_BLOCK"
    stateless        = false

    udp_options {
      min = 53
      max = 53
    }
    description = "Allow DNS"
  }

  freeform_tags = {
    environment = var.environment
    project     = var.project_name
    managed_by  = "terraform"
  }
}

# Public subnet
resource "oci_core_subnet" "public" {
  compartment_id             = oci_identity_compartment.this.id
  vcn_id                     = oci_core_vcn.this.id
  cidr_block                 = var.public_subnet_cidr
  display_name               = "${var.project_name}-${var.environment}-public-subnet"
  dns_label                  = "public"
  security_list_ids          = [oci_core_security_list.public.id]
  route_table_id             = oci_core_route_table.public.id
  prohibit_public_ip_on_vnic = false

  freeform_tags = {
    environment = var.environment
    project     = var.project_name
    managed_by  = "terraform"
  }
}

# Private subnet
resource "oci_core_subnet" "private" {
  compartment_id             = oci_identity_compartment.this.id
  vcn_id                     = oci_core_vcn.this.id
  cidr_block                 = var.private_subnet_cidr
  display_name               = "${var.project_name}-${var.environment}-private-subnet"
  dns_label                  = "private"
  security_list_ids          = [oci_core_security_list.private.id]
  route_table_id             = oci_core_route_table.private.id
  prohibit_public_ip_on_vnic = true

  freeform_tags = {
    environment = var.environment
    project     = var.project_name
    managed_by  = "terraform"
  }
}

output "vcn_id" {
  description = "VCN OCID"
  value       = oci_core_vcn.this.id
}

output "public_subnet_id" {
  description = "Public subnet OCID"
  value       = oci_core_subnet.public.id
}

output "private_subnet_id" {
  description = "Private subnet OCID"
  value       = oci_core_subnet.private.id
}
