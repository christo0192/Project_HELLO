# OCI Region Benchmark — Operator Runbook

**Version:** 1.1.0
**Date:** 2026-07-28
**Status:** Ready for operator use — no cloud change is made by default

## ⚠️ Safety Rules

1. **No cloud change is made by default.** Every OCI provisioning command requires
   operator-supplied compartment/subnet/image IDs. There is no `--yes` flag on OCI
   CLI instance launch — provisioning is opt-in by supplying valid resource OCIDs.
2. **No credentials, API keys, or project endpoints are hardcoded.** All targets are
   operator-supplied via environment variables.
3. **Destroy temporary probes after every run.** Teardown must explicitly cover both
   Mumbai and Hyderabad regions, wait for TERMINATED state, and verify no non-terminated
   tagged probe remains before benchmark evidence is considered valid.
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
# Run self-tests (includes teardown-path coverage tests)
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

> **⚠️ THIS PROVISIONS REAL OCI RESOURCES.** Only run when you are ready to incur
> usage. Always Free compute (Ampere A1) applies only in your **tenancy home
> region**; the non-home comparison region **may be billable** even if both are
> Always Free shapes. Check your tenancy home region in the OCI Console before
> provisioning.
>
> Provisioning does not require a `--yes` flag — it runs immediately once valid
> resource OCIDs are supplied.
>
> **⚠️ Do not blindly retry launch** after an ambiguous CLI or network failure.
> The `oci compute instance launch` command does not support idempotency tokens
> (no `--opc-retry-token`; `--opc-client-request-id` is a tracing header, not
> idempotency — ref: `oci compute instance launch --help`, retrieved 2026-07-29).
> A failed launch may still have provisioned a billable instance. Before retrying,
> run a display-name-targeted cleanup: list instances matching your unique
> `DISPLAY_NAME` in that compartment/region, and terminate any matches.  Each
> launch block below includes this cleanup on failure.
>
> **Network prerequisite:** The subnet must allow inbound TCP/22 (SSH) from the
> operator's trusted CIDR **temporarily**. Remove this ingress rule after teardown.
> Never expose SSH to 0.0.0.0/0.

### 2a. Provision in Mumbai

```bash
set -euo pipefail

# REQUIRED: Operator must supply these values
export MUMBAI_COMPARTMENT_ID="ocid1.compartment.oc1..__CHANGE_ME__"
export MUMBAI_SUBNET_ID="ocid1.subnet.oc1.ap-mumbai-1.__CHANGE_ME__"
export MUMBAI_IMAGE_ID="ocid1.image.oc1.ap-mumbai-1.__CHANGE_ME__"
export SSH_PUBLIC_KEY_FILE="${HOME}/.ssh/id_rsa.pub"   # operator-supplied path

# Validate SSH public key file exists and is non-empty
if [ ! -s "${SSH_PUBLIC_KEY_FILE}" ]; then
  echo "FATAL: SSH_PUBLIC_KEY_FILE '${SSH_PUBLIC_KEY_FILE}' does not exist or is empty" >&2
  echo "Generate one with: ssh-keygen -t rsa -b 4096 -f ~/.ssh/id_rsa -N ''" >&2
  exit 1
fi

export MUMBAI_AD="$(oci iam availability-domain list \
  --compartment-id "${MUMBAI_COMPARTMENT_ID}" \
  --query 'data[0].name' --raw-output \
  --region ap-mumbai-1)"

export TAG_TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
DISPLAY_NAME="oci-benchmark-probe-mumbai-${TAG_TIMESTAMP}"

# ── Step 1: Launch (do NOT wait here) ──
# Use 'if !' so that a nonzero exit enters the cleanup branch
# (plain assignment with set -e would exit before the blank-ID check)
if ! MUMBAI_INSTANCE_ID="$(oci compute instance launch \
    --compartment-id "${MUMBAI_COMPARTMENT_ID}" \
    --availability-domain "${MUMBAI_AD}" \
    --subnet-id "${MUMBAI_SUBNET_ID}" \
    --shape "VM.Standard.A1.Flex" \
    --shape-config '{"ocpus":1,"memoryInGBs":6}' \
    --image-id "${MUMBAI_IMAGE_ID}" \
    --display-name "${DISPLAY_NAME}" \
    --assign-public-ip true \
    --ssh-authorized-keys-file "${SSH_PUBLIC_KEY_FILE}" \
    --freeform-tags '{"purpose":"oci-region-benchmark","ttl":"4h","region":"ap-mumbai-1"}' \
    --region ap-mumbai-1 \
    --query 'data.id' --raw-output 2>&1)"; then
  echo "FATAL: Mumbai launch command failed for ${DISPLAY_NAME}" >&2
  echo "Output: ${MUMBAI_INSTANCE_ID}" >&2
  # Clean up any instance provisioned with this display-name
  ORPHAN_IDS="$(oci compute instance list \
    --compartment-id "${MUMBAI_COMPARTMENT_ID}" \
    --display-name "${DISPLAY_NAME}" \
    --region ap-mumbai-1 \
    --all \
    --query 'join(`"\\n"`, data[?"lifecycle-state" != `"TERMINATED"`].id)' \
    --raw-output)"
  if [ -n "${ORPHAN_IDS}" ]; then
    for id in ${ORPHAN_IDS}; do
      echo "Terminating orphan: ${id}"
      oci compute instance terminate --instance-id "${id}" --force \
        --region ap-mumbai-1 --wait-for-state TERMINATED
    done
  fi
  exit 1
fi

# ── Step 2: Validate OCID immediately (before waiting) ──
if [ -z "${MUMBAI_INSTANCE_ID}" ]; then
  echo "FATAL: MUMBAI_INSTANCE_ID is blank for ${DISPLAY_NAME}" >&2
  # Same display-name cleanup for blank-ID case
  ORPHAN_IDS="$(oci compute instance list \
    --compartment-id "${MUMBAI_COMPARTMENT_ID}" \
    --display-name "${DISPLAY_NAME}" \
    --region ap-mumbai-1 \
    --all \
    --query 'join(`"\\n"`, data[?"lifecycle-state" != `"TERMINATED"`].id)' \
    --raw-output)"
  if [ -n "${ORPHAN_IDS}" ]; then
    for id in ${ORPHAN_IDS}; do
      echo "Terminating orphan: ${id}"
      oci compute instance terminate --instance-id "${id}" --force \
        --region ap-mumbai-1 --wait-for-state TERMINATED
    done
  fi
  exit 1
fi
echo "Mumbai probe OCID captured: ${MUMBAI_INSTANCE_ID}"

# ── Step 3: Wait for RUNNING (separate call — if it fails, terminate the known ID) ──
if ! oci compute instance get \
    --instance-id "${MUMBAI_INSTANCE_ID}" \
    --region ap-mumbai-1 \
    --wait-for-state RUNNING \
    --query 'data."lifecycle-state"' --raw-output > /dev/null 2>&1; then
  echo "FATAL: Mumbai probe ${MUMBAI_INSTANCE_ID} did not reach RUNNING state" >&2
  echo "Terminating the instance to avoid an orphaned billable resource..." >&2
  oci compute instance terminate \
    --instance-id "${MUMBAI_INSTANCE_ID}" \
    --force \
    --region ap-mumbai-1 \
    --wait-for-state TERMINATED
  echo "Mumbai probe terminated." >&2
  exit 1
fi
echo "Mumbai probe RUNNING: ${MUMBAI_INSTANCE_ID}"
```

### 2b. Provision in Hyderabad

```bash
set -euo pipefail

# REQUIRED: Operator must supply these values
export HYDERABAD_COMPARTMENT_ID="ocid1.compartment.oc1..__CHANGE_ME__"
export HYDERABAD_SUBNET_ID="ocid1.subnet.oc1.ap-hyderabad-1.__CHANGE_ME__"
export HYDERABAD_IMAGE_ID="ocid1.image.oc1.ap-hyderabad-1.__CHANGE_ME__"
export SSH_PUBLIC_KEY_FILE="${HOME}/.ssh/id_rsa.pub"   # same key as Mumbai

# Validate SSH public key file exists and is non-empty
if [ ! -s "${SSH_PUBLIC_KEY_FILE}" ]; then
  echo "FATAL: SSH_PUBLIC_KEY_FILE '${SSH_PUBLIC_KEY_FILE}' does not exist or is empty" >&2
  exit 1
fi

export HYDERABAD_AD="$(oci iam availability-domain list \
  --compartment-id "${HYDERABAD_COMPARTMENT_ID}" \
  --query 'data[0].name' --raw-output \
  --region ap-hyderabad-1)"

export TAG_TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
DISPLAY_NAME="oci-benchmark-probe-hyderabad-${TAG_TIMESTAMP}"

# ── Step 1: Launch (do NOT wait here) ──
# Use 'if !' so that a nonzero exit enters the cleanup branch
if ! HYDERABAD_INSTANCE_ID="$(oci compute instance launch \
    --compartment-id "${HYDERABAD_COMPARTMENT_ID}" \
    --availability-domain "${HYDERABAD_AD}" \
    --subnet-id "${HYDERABAD_SUBNET_ID}" \
    --shape "VM.Standard.A1.Flex" \
    --shape-config '{"ocpus":1,"memoryInGBs":6}' \
    --image-id "${HYDERABAD_IMAGE_ID}" \
    --display-name "${DISPLAY_NAME}" \
    --assign-public-ip true \
    --ssh-authorized-keys-file "${SSH_PUBLIC_KEY_FILE}" \
    --freeform-tags '{"purpose":"oci-region-benchmark","ttl":"4h","region":"ap-hyderabad-1"}' \
    --region ap-hyderabad-1 \
    --query 'data.id' --raw-output 2>&1)"; then
  echo "FATAL: Hyderabad launch command failed for ${DISPLAY_NAME}" >&2
  echo "Output: ${HYDERABAD_INSTANCE_ID}" >&2
  # Clean up any instance provisioned with this display-name
  ORPHAN_IDS="$(oci compute instance list \
    --compartment-id "${HYDERABAD_COMPARTMENT_ID}" \
    --display-name "${DISPLAY_NAME}" \
    --region ap-hyderabad-1 \
    --all \
    --query 'join(`"\n"`, data[?"lifecycle-state" != `"TERMINATED"`].id)' \
    --raw-output)"
  if [ -n "${ORPHAN_IDS}" ]; then
    for id in ${ORPHAN_IDS}; do
      echo "Terminating orphan: ${id}"
      oci compute instance terminate --instance-id "${id}" --force \
        --region ap-hyderabad-1 --wait-for-state TERMINATED
    done
  fi
  # Also roll back Mumbai if it was provisioned
  if [ -n "${MUMBAI_INSTANCE_ID:-}" ]; then
    echo "Terminating Mumbai probe due to Hyderabad launch failure..." >&2
    oci compute instance terminate \
      --instance-id "${MUMBAI_INSTANCE_ID}" \
      --force \
      --region ap-mumbai-1 \
      --wait-for-state TERMINATED
    echo "Mumbai probe terminated." >&2
  fi
  exit 1
fi

# ── Step 2: Validate OCID immediately (before waiting) ──
if [ -z "${HYDERABAD_INSTANCE_ID}" ]; then
  echo "FATAL: HYDERABAD_INSTANCE_ID is blank for ${DISPLAY_NAME}" >&2
  # Same display-name cleanup for blank-ID case
  ORPHAN_IDS="$(oci compute instance list \
    --compartment-id "${HYDERABAD_COMPARTMENT_ID}" \
    --display-name "${DISPLAY_NAME}" \
    --region ap-hyderabad-1 \
    --all \
    --query 'join(`"\n"`, data[?"lifecycle-state" != `"TERMINATED"`].id)' \
    --raw-output)"
  if [ -n "${ORPHAN_IDS}" ]; then
    for id in ${ORPHAN_IDS}; do
      echo "Terminating orphan: ${id}"
      oci compute instance terminate --instance-id "${id}" --force \
        --region ap-hyderabad-1 --wait-for-state TERMINATED
    done
  fi
  # Also roll back Mumbai
  if [ -n "${MUMBAI_INSTANCE_ID:-}" ]; then
    echo "Terminating Mumbai probe due to Hyderabad launch failure..." >&2
    oci compute instance terminate \
      --instance-id "${MUMBAI_INSTANCE_ID}" \
      --force \
      --region ap-mumbai-1 \
      --wait-for-state TERMINATED
    echo "Mumbai probe terminated." >&2
  fi
  exit 1
fi
echo "Hyderabad probe OCID captured: ${HYDERABAD_INSTANCE_ID}"

# ── Step 3: Wait for RUNNING (separate call — if it fails, terminate BOTH regions) ──
if ! oci compute instance get \
    --instance-id "${HYDERABAD_INSTANCE_ID}" \
    --region ap-hyderabad-1 \
    --wait-for-state RUNNING \
    --query 'data."lifecycle-state"' --raw-output > /dev/null 2>&1; then
  echo "FATAL: Hyderabad probe ${HYDERABAD_INSTANCE_ID} did not reach RUNNING state" >&2
  echo "Terminating the Hyderabad instance..." >&2
  oci compute instance terminate \
    --instance-id "${HYDERABAD_INSTANCE_ID}" \
    --force \
    --region ap-hyderabad-1 \
    --wait-for-state TERMINATED
  echo "Hyderabad probe terminated." >&2
  # Also terminate Mumbai
  if [ -n "${MUMBAI_INSTANCE_ID:-}" ]; then
    echo "Terminating Mumbai probe due to Hyderabad wait failure..." >&2
    oci compute instance terminate \
      --instance-id "${MUMBAI_INSTANCE_ID}" \
      --force \
      --region ap-mumbai-1 \
      --wait-for-state TERMINATED
    echo "Mumbai probe terminated." >&2
  fi
  exit 1
fi
echo "Hyderabad probe RUNNING: ${HYDERABAD_INSTANCE_ID}"
```

> **Note:** Each launch uses `if ! ID="$(oci compute instance launch ...)"` so
> a nonzero CLI exit triggers display-name-targeted cleanup before exiting
> (plain assignment with `set -e` would exit before the blank-ID check).
> Instance OCIDs are captured from the launch output **without**
> `--wait-for-state RUNNING`.  The OCID is validated immediately, then a
> separate `oci compute instance get --wait-for-state RUNNING` call waits.
> If the waiter fails, the known OCID is terminated before exit — this
> prevents orphaned billable instances.  There is no idempotency token
> (`--opc-retry-token` is not accepted by `oci compute instance launch`;
> ref: `oci compute instance launch --help`, 2026-07-29).
>
> No `benchmark-probes.env` file is written.  OCIDs must be exported as
> environment variables and verified non-blank before proceeding.

## Phase 3: Run Network Probes

> **Prerequisites:** Both instances must be RUNNING (from Phase 2).  SSH access
> requires the public key passed via `--ssh-authorized-keys-file` in Phases 2a/2b.
> The subnet must have a temporary ingress rule for TCP/22 from the operator's
> trusted CIDR — **remove this ingress rule after teardown**.
>
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

> **⚠️ MANDATORY.** Every provisioning run must end with teardown covering both
> Mumbai and Hyderabad regions. Evidence collection (Phase 6) fails unless
> teardown verification passes.

### 5a. Terminate Mumbai Probe and Wait

```bash
set -euo pipefail

if [ -n "${MUMBAI_INSTANCE_ID:-}" ]; then
  echo "Terminating Mumbai probe: ${MUMBAI_INSTANCE_ID}"
  oci compute instance terminate \
    --instance-id "${MUMBAI_INSTANCE_ID}" \
    --force \
    --region ap-mumbai-1 \
    --wait-for-state TERMINATED

  echo "Mumbai probe terminated."
else
  echo "WARNING: MUMBAI_INSTANCE_ID not set — cannot terminate Mumbai probe"
fi
```

### 5b. Terminate Hyderabad Probe and Wait

```bash
set -euo pipefail

if [ -n "${HYDERABAD_INSTANCE_ID:-}" ]; then
  echo "Terminating Hyderabad probe: ${HYDERABAD_INSTANCE_ID}"
  oci compute instance terminate \
    --instance-id "${HYDERABAD_INSTANCE_ID}" \
    --force \
    --region ap-hyderabad-1 \
    --wait-for-state TERMINATED

  echo "Hyderabad probe terminated."
else
  echo "WARNING: HYDERABAD_INSTANCE_ID not set — cannot terminate Hyderabad probe"
fi
```

### 5c. Verify No Tagged Probes Remain (Both Regions)

```bash
set -euo pipefail

echo "Verifying no benchmark probes remain in Mumbai..."
MUMBAI_REMAINING="$(oci compute instance list \
  --compartment-id "${MUMBAI_COMPARTMENT_ID}" \
  --region ap-mumbai-1 \
  --query 'join(`"\n"`, data[?"lifecycle-state" != `"TERMINATED"` && "freeform-tags".purpose == `"oci-region-benchmark"`].id)' \
  --all --raw-output)"

if [ -n "${MUMBAI_REMAINING}" ]; then
  echo "FATAL: Non-terminated benchmark probes remain in Mumbai:" >&2
  echo "${MUMBAI_REMAINING}" >&2
  echo "Run emergency teardown before collecting evidence." >&2
  exit 1
fi
echo "Mumbai: clean — no benchmark probes remain."

echo "Verifying no benchmark probes remain in Hyderabad..."
HYDERABAD_REMAINING="$(oci compute instance list \
  --compartment-id "${HYDERABAD_COMPARTMENT_ID}" \
  --region ap-hyderabad-1 \
  --query 'join(`"\n"`, data[?"lifecycle-state" != `"TERMINATED"` && "freeform-tags".purpose == `"oci-region-benchmark"`].id)' \
  --all --raw-output)"

if [ -n "${HYDERABAD_REMAINING}" ]; then
  echo "FATAL: Non-terminated benchmark probes remain in Hyderabad:" >&2
  echo "${HYDERABAD_REMAINING}" >&2
  echo "Run emergency teardown before collecting evidence." >&2
  exit 1
fi
echo "Hyderabad: clean — no benchmark probes remain."
```

> **Evidence gate:** Do not proceed to Phase 6 unless both region verifications
> return clean. The benchmark evidence is invalid if any tagged probe remains
> running after teardown.

## Phase 6: Collect Evidence

**Only after Phase 5 teardown verification passes for both regions:**

1. **Benchmark result JSON** — validate with `schema-validate`
2. **OCI console screenshots** showing:
   - Instance lifecycle states (RUNNING during test, TERMINATED after)
   - Region availability report
   - Billing/cost explorer (even at $0 for Always Free)
3. **Teardown verification output** — terminal output from Phase 5c proving both
   regions are clean
4. **Operator notes:**
   - Date and time of test
   - OCI regions tested
   - Any provisioning errors (e.g., "out of host capacity")
   - Any probe errors or anomalies

## Emergency Teardown

If something goes wrong and you need to destroy everything immediately across
both regions:

```bash
set -euo pipefail

# ── Mumbai ──
echo "=== Emergency teardown: Mumbai ==="
MUMBAI_IDS="$(oci compute instance list \
  --compartment-id "${MUMBAI_COMPARTMENT_ID}" \
  --region ap-mumbai-1 \
  --query 'join(`"\n"`, data[?"freeform-tags".purpose == `"oci-region-benchmark"` && "lifecycle-state" != `"TERMINATED"`].id)' \
  --all --raw-output)"

if [ -n "${MUMBAI_IDS}" ]; then
  for id in ${MUMBAI_IDS}; do
    echo "Terminating Mumbai: ${id}"
    oci compute instance terminate --instance-id "${id}" --force --region ap-mumbai-1
  done
  # Wait for all Mumbai probes to terminate
  for id in ${MUMBAI_IDS}; do
    oci compute instance get --instance-id "${id}" --region ap-mumbai-1 \
      --wait-for-state TERMINATED --query 'data."lifecycle-state"' --raw-output
  done
  echo "Mumbai emergency teardown complete."
else
  echo "No benchmark probes found in Mumbai."
fi

# ── Hyderabad ──
echo "=== Emergency teardown: Hyderabad ==="
HYDERABAD_IDS="$(oci compute instance list \
  --compartment-id "${HYDERABAD_COMPARTMENT_ID}" \
  --region ap-hyderabad-1 \
  --query 'join(`"\n"`, data[?"freeform-tags".purpose == `"oci-region-benchmark"` && "lifecycle-state" != `"TERMINATED"`].id)' \
  --all --raw-output)"

if [ -n "${HYDERABAD_IDS}" ]; then
  for id in ${HYDERABAD_IDS}; do
    echo "Terminating Hyderabad: ${id}"
    oci compute instance terminate --instance-id "${id}" --force --region ap-hyderabad-1
  done
  # Wait for all Hyderabad probes to terminate
  for id in ${HYDERABAD_IDS}; do
    oci compute instance get --instance-id "${id}" --region ap-hyderabad-1 \
      --wait-for-state TERMINATED --query 'data."lifecycle-state"' --raw-output
  done
  echo "Hyderabad emergency teardown complete."
else
  echo "No benchmark probes found in Hyderabad."
fi

# Verify both regions clean — queries freeform-tags, no error suppression
echo ""
echo "Final verification across both regions..."
MUMBAI_LEFT="$(oci compute instance list \
  --compartment-id "${MUMBAI_COMPARTMENT_ID}" --region ap-mumbai-1 \
  --query 'join(`"\n"`, data[?"freeform-tags".purpose == `"oci-region-benchmark"` && "lifecycle-state" != `"TERMINATED"`].id)' \
  --all --raw-output)"
HYDERABAD_LEFT="$(oci compute instance list \
  --compartment-id "${HYDERABAD_COMPARTMENT_ID}" --region ap-hyderabad-1 \
  --query 'join(`"\n"`, data[?"freeform-tags".purpose == `"oci-region-benchmark"` && "lifecycle-state" != `"TERMINATED"`].id)' \
  --all --raw-output)"

if [ -z "${MUMBAI_LEFT}" ] && [ -z "${HYDERABAD_LEFT}" ]; then
  echo "All regions clean — emergency teardown complete."
else
  echo "WARNING: Some probes may still be running!"
  [ -n "${MUMBAI_LEFT}" ] && echo "  Mumbai: ${MUMBAI_LEFT}"
  [ -n "${HYDERABAD_LEFT}" ] && echo "  Hyderabad: ${HYDERABAD_LEFT}"
  exit 1
fi
```

## Default Behavior Summary

| Command | Makes cloud change? | Requires credentials? |
|---|---|---|
| `self-test` | **No** | **No** |
| `fixture --scenario X` | **No** | **No** |
| `schema-validate FILE` | **No** | **No** |
| `reduce FILES...` | **No** | **No** |
| `calculator` | **No** | **No** |
| `probe --target-host HOST` | **No cloud change** (only outbound network probes) | **No** (needs outbound network) |
| `oci compute instance launch` | **YES** | OCI CLI configured |
| `oci compute instance terminate` | **YES** | OCI CLI configured |

**All provisioning commands require explicit OCI CLI invocation with
operator-supplied compartment/subnet/image IDs.** There is no `--yes` flag —
provisioning is opt-in by supplying valid resource OCIDs. No `scripts/oci-benchmark-run`
subcommand provisions or destroys cloud resources.
