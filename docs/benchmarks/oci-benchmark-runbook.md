# OCI Region Benchmark — Operator Runbook

**Version:** 1.0.0
**Date:** 2026-07-28
**Status:** Ready for operator use — no cloud change is made by default

## ⚠️  Safety Rules

1. **No cloud change is made by default.** Every OCI provisioning or probe command
   requires an explicit `--yes` flag or operator-confirmed endpoint.
2. **No credentials, API keys, or project endpoints are hardcoded.** All targets are
   operator-supplied via CLI arguments or environment variables.
3. **Destroy temporary probes after every run.** This runbook includes teardown
   commands that must be executed before the benchmark is considered complete.
4. **All evidence is synthetic until real probes run.** The benchmark schema and
   CLI enforce a `NOT-YET-MEASURED` state until real data is collected.

## Prerequisites

- OCI account with access to Mumbai (`ap-mumbai-1`) and Hyderabad (`ap-hyderabad-1`) regions
- OCI CLI installed and configured (`oci setup config`)
- Python 3.9+ with the benchmark CLI at `scripts/oci-benchmark-run`
- Operator-supplied endpoints for:
  - Supabase project (REST endpoint in `ap-south-1`)
  - Synthetic candidate endpoint (Bangalore)
  - Any external API endpoints to test (Sarvam, Anthropic)

## Quick Start (Synthetic Test)

Verify the CLI works without any cloud resources:

```bash
# Run self-tests
python3 scripts/oci-benchmark-run self-test

# Generate synthetic fixture data (no network calls)
python3 scripts/oci-benchmark-run fixture --scenario mumbai-low-latency -o json
python3 scripts/oci-benchmark-run fixture --scenario mumbai-low-latency -o markdown
```

## Phase 1: Verify Compute Availability

Check whether Ampere A1 shapes are available in each region. **This does NOT
provision anything.** It only checks shape availability via OCI CLI.

```bash
# Check Mumbai availability (requires OCI CLI configured)
oci compute shape list \
  --compartment-id "${OCI_COMPARTMENT_ID}" \
  --availability-domain "$(oci iam availability-domain list --compartment-id "${OCI_COMPARTMENT_ID}" --query 'data[0].name' --raw-output)" \
  --query "data[?shape=='VM.Standard.A1.Flex']" \
  --region ap-mumbai-1

# Check Hyderabad availability
oci compute shape list \
  --compartment-id "${OCI_COMPARTMENT_ID}" \
  --availability-domain "$(oci iam availability-domain list --compartment-id "${OCI_COMPARTMENT_ID}" --query 'data[0].name' --raw-output)" \
  --query "data[?shape=='VM.Standard.A1.Flex']" \
  --region ap-hyderabad-1
```

**Record:** Note whether A1.Flex is available in each region. If "out of host
capacity" errors appear, document the error and date.

## Phase 2: Provision Temporary Probe Instances

> **⚠️  THIS PROVISIONS REAL OCI RESOURCES.** Only run when you are ready to incur
> usage (even within Always Free limits). Always destroy probes when done.

### 2a. Provision in Mumbai

```bash
# Set variables — operator must supply these
export MUMBAI_COMPARTMENT_ID="ocid1.compartment.oc1..__CHANGE_ME__"
export MUMBAI_SUBNET_ID="ocid1.subnet.oc1.ap-mumbai-1.__CHANGE_ME__"
export MUMBAI_AD="$(oci iam availability-domain list --compartment-id "${MUMBAI_COMPARTMENT_ID}" --query 'data[0].name' --raw-output --region ap-mumbai-1)"
export MUMBAI_IMAGE_ID="ocid1.image.oc1.ap-mumbai-1.__CHANGE_ME__"  # Oracle Linux 8

# Create probe instance
oci compute instance launch \
  --compartment-id "${MUMBAI_COMPARTMENT_ID}" \
  --availability-domain "${MUMBAI_AD}" \
  --subnet-id "${MUMBAI_SUBNET_ID}" \
  --shape "VM.Standard.A1.Flex" \
  --shape-config '{"ocpus":1,"memoryInGBs":6}' \
  --image-id "${MUMBAI_IMAGE_ID}" \
  --display-name "oci-benchmark-probe-mumbai-$(date +%Y%m%d-%H%M)" \
  --assign-public-ip true \
  --wait-for-state RUNNING \
  --region ap-mumbai-1
```

### 2b. Provision in Hyderabad

```bash
export HYDERABAD_COMPARTMENT_ID="ocid1.compartment.oc1..__CHANGE_ME__"
export HYDERABAD_SUBNET_ID="ocid1.subnet.oc1.ap-hyderabad-1.__CHANGE_ME__"
export HYDERABAD_AD="$(oci iam availability-domain list --compartment-id "${HYDERABAD_COMPARTMENT_ID}" --query 'data[0].name' --raw-output --region ap-hyderabad-1)"
export HYDERABAD_IMAGE_ID="ocid1.image.oc1.ap-hyderabad-1.__CHANGE_ME__"

oci compute instance launch \
  --compartment-id "${HYDERABAD_COMPARTMENT_ID}" \
  --availability-domain "${HYDERABAD_AD}" \
  --subnet-id "${HYDERABAD_SUBNET_ID}" \
  --shape "VM.Standard.A1.Flex" \
  --shape-config '{"ocpus":1,"memoryInGBs":6}' \
  --image-id "${HYDERABAD_IMAGE_ID}" \
  --display-name "oci-benchmark-probe-hyderabad-$(date +%Y%m%d-%H%M)" \
  --assign-public-ip true \
  --wait-for-state RUNNING \
  --region ap-hyderabad-1
```

### 2c. Record Instance IDs

```bash
# Save instance IDs for teardown — critical
echo "MUMBAI_INSTANCE_ID=${MUMBAI_INSTANCE_ID}" >> benchmark-probes.env
echo "HYDERABAD_INSTANCE_ID=${HYDERABAD_INSTANCE_ID}" >> benchmark-probes.env
```

## Phase 3: Run Network Probes

Once instances are RUNNING and you have SSH access, run probes from each instance.

> **All target endpoints must be operator-supplied.** No Supabase project URL,
> candidate endpoint, or credential is hardcoded in the CLI.

### 3a. From Mumbai Probe → Supabase Mumbai

```bash
# SSH into Mumbai probe instance, then:
python3 scripts/oci-benchmark-run probe \
  --target-host "${SUPABASE_REST_HOST}" \
  --target-port 443 \
  --probes 100 \
  --timeout-ms 5000 \
  --interval-ms 200 \
  --verbose \
  > mumbai-to-supabase.json
```

### 3b. From Mumbai Probe → Candidate Bangalore

```bash
python3 scripts/oci-benchmark-run probe \
  --target-host "${CANDIDATE_ENDPOINT_HOST}" \
  --target-port 443 \
  --probes 100 \
  --timeout-ms 5000 \
  --interval-ms 200 \
  > mumbai-to-candidate.json
```

### 3c. From Hyderabad Probe → Same Targets

Repeat probes 3a and 3b from the Hyderabad probe instance.

### 3d. Combine and Reduce Results

```bash
# Reduce individual probe files into aggregated statistics
python3 scripts/oci-benchmark-run reduce \
  mumbai-to-supabase.json mumbai-to-candidate.json \
  hyderabad-to-supabase.json hyderabad-to-candidate.json \
  -o json > combined-results.json

# Generate Markdown report
python3 scripts/oci-benchmark-run reduce \
  mumbai-to-supabase.json mumbai-to-candidate.json \
  hyderabad-to-supabase.json hyderabad-to-candidate.json \
  -o markdown > combined-results.md
```

## Phase 4: Build Complete Benchmark Document

Use the `schema-validate` command to assemble and validate a complete benchmark
document that conforms to `infra/benchmarks/oci/benchmark-result-schema.json`.

```bash
# After manually constructing the full document:
python3 scripts/oci-benchmark-run schema-validate benchmark-result.json
```

> The schema **rejects** documents that contain API keys, tokens, passwords, or
> credentials in any field. If validation fails with a secret-pattern violation,
> redact the sensitive data and re-validate.

## Phase 5: Destroy Temporary Probes

> **⚠️  MANDATORY.** Every provisioning run must end with teardown. Temporary
> probes should not remain running after benchmark data is collected.

```bash
# Terminate Mumbai probe
oci compute instance terminate \
  --instance-id "${MUMBAI_INSTANCE_ID}" \
  --force \
  --region ap-mumbai-1

# Terminate Hyderabad probe
oci compute instance terminate \
  --instance-id "${HYDERABAD_INSTANCE_ID}" \
  --force \
  --region ap-hyderabad-1

# Verify termination
oci compute instance list \
  --compartment-id "${COMPARTMENT_ID}" \
  --display-name "oci-benchmark-probe-*" \
  --query "data[?\"lifecycle-state\"!='TERMINATED'].displayName"

# Clean up
rm -f benchmark-probes.env
```

## Phase 6: Collect Evidence

After probes are destroyed, record:

1. **Benchmark result JSON** — validate with `schema-validate`
2. **OCI console screenshots** showing:
   - Instance lifecycle states (RUNNING during test, TERMINATED after)
   - Region availability report
   - Billing/cost explorer (even at $0 for Always Free)
3. **Operator notes:**
   - Date and time of test
   - OCI regions tested
   - Any provisioning errors (e.g., "out of host capacity")
   - Any probe errors or anomalies

## Emergency Teardown

If something goes wrong and you need to destroy everything immediately:

```bash
# Find all benchmark probe instances
oci compute instance list \
  --compartment-id "${COMPARTMENT_ID}" \
  --query "data[?contains(\"display-name\",'oci-benchmark-probe')].id" \
  --all

# Terminate each instance by ID
for id in $(oci compute instance list \
  --compartment-id "${COMPARTMENT_ID}" \
  --query "data[?contains(\"display-name\",'oci-benchmark-probe')].id" \
  --all --raw-output); do
  echo "Terminating $id"
  oci compute instance terminate --instance-id "$id" --force
done
```

## Default Behavior Summary

| Command | Makes cloud change? | Requires credentials? |
|---|---|---|
| `self-test` | **No** | **No** |
| `fixture --scenario X` | **No** | **No** |
| `schema-validate FILE` | **No** | **No** |
| `reduce FILES...` | **No** | **No** |
| `probe --target-host HOST` | **No cloud change** (only network probes) | **No** (needs outbound network) |
| `oci compute instance launch` | **YES** | OCI CLI configured |
| `oci compute instance terminate` | **YES** | OCI CLI configured |

**All provisioning commands require explicit OCI CLI invocation with
operator-supplied compartment/subnet/image IDs.** No `scripts/oci-benchmark-run`
subcommand provisions or destroys cloud resources.
