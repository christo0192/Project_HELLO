#!/usr/bin/env node
// The explicit, reviewed region contract for this project's Fly WORKER apps.
//
// Why this file exists (PR104 / the first dedicated phone-app release failure):
// the first safe deploy of `project-hello-phone-voice` failed BEFORE any machine
// was created, because `app/voice-livekit/fly.phone.toml` still named
// `primary_region = "bom"`. Fly no longer accepts `bom` for NEW resource
// creation and explicitly recommended `sin` instead. The browser worker and the
// API were unaffected only because their machines already existed in `sin` —
// `primary_region` is consulted when a resource is CREATED, so a deprecated
// value in VCS is a latent trap that fires on the next app/machine creation,
// not on the next deploy of an existing machine. That is exactly why a config
// value nobody reads day to day still has to be validated in CI.
//
// The contract is an ALLOWLIST, not a denylist: a region is usable only if it is
// named here. A denylist would silently accept the next region Fly deprecates.
//
// Changing this list is a reviewed edit. Two structural rules keep the list
// from being "fixed" by weakening it, and `assertPolicyConsistent()` enforces
// both wherever the policy is loaded:
//   * a region may not appear in both APPROVED and DEPRECATED, so the failure
//     "bom is rejected" cannot be resolved by allowlisting bom; and
//   * DEPRECATED must keep naming `bom`, so the specific regression this
//     contract exists to prevent cannot be dropped from the record.

/** Regions approved for NEW Fly resource creation by this project's workers.
 *  `sin` (Singapore) is where every existing app in this project actually runs
 *  and is the region Fly recommended when it refused `bom`. */
export const APPROVED_WORKER_REGIONS = Object.freeze(["sin"]);

/** Regions that must never appear in a worker config again, each with the
 *  region that supersedes it, so a failure message can tell an operator what to
 *  write instead of only what not to write. */
export const DEPRECATED_REGIONS = Object.freeze({
  bom: Object.freeze({
    superseded_by: "sin",
    reason:
      "Fly no longer accepts bom for new resource creation and recommends sin; "
      + "it failed the first project-hello-phone-voice release before machine creation",
  }),
});

/** Structural self-checks on the policy itself. Returns a list of failures
 *  (empty when the policy is well formed). A policy that contradicts itself is
 *  worse than none: it would let a future edit launder a deprecated region into
 *  the allowlist and still report green. */
export function assertPolicyConsistent() {
  const problems = [];
  if (APPROVED_WORKER_REGIONS.length === 0) {
    problems.push("fly region policy: APPROVED_WORKER_REGIONS is empty — every region would be rejected and the contract would be unusable");
  }
  for (const r of APPROVED_WORKER_REGIONS) {
    if (!/^[a-z]{3}$/.test(r)) {
      problems.push(`fly region policy: approved region ${JSON.stringify(r)} is not a Fly region code (three lowercase letters)`);
    }
    if (Object.prototype.hasOwnProperty.call(DEPRECATED_REGIONS, r)) {
      problems.push(`fly region policy: ${r} is both APPROVED and DEPRECATED — a deprecated region must never be allowlisted`);
    }
  }
  if (!Object.prototype.hasOwnProperty.call(DEPRECATED_REGIONS, "bom")) {
    problems.push("fly region policy: bom must stay recorded as DEPRECATED — it is the regression this contract exists to prevent");
  }
  for (const [region, meta] of Object.entries(DEPRECATED_REGIONS)) {
    if (!meta || !APPROVED_WORKER_REGIONS.includes(meta.superseded_by)) {
      problems.push(`fly region policy: deprecated region ${region} must name an APPROVED superseded_by region`);
    }
  }
  return problems;
}

/**
 * Check one config's declared `primary_region` against the contract.
 *
 * `region` is the raw value read from the TOML (null when the key is absent).
 * Returns a list of failure messages; empty means the region is approved.
 *
 * Absence is a failure, not a pass: without `primary_region` Fly picks a region
 * by deploy-host proximity, which is a non-deterministic placement for a worker
 * that must sit next to the API. "Not stated" and "stated correctly" must not
 * be the same result.
 */
export function checkPrimaryRegion(label, region) {
  const problems = [];
  if (region === null || region === undefined) {
    problems.push(`${label} must declare primary_region (approved: ${APPROVED_WORKER_REGIONS.join(", ")}) — an absent region lets Fly place new machines by deploy-host proximity`);
    return problems;
  }
  const raw = String(region);
  const normalized = raw.trim().toLowerCase();
  if (raw !== normalized) {
    problems.push(`${label} primary_region ${JSON.stringify(raw)} must be written exactly as the lowercase region code (no padding, no case variation) — Fly matches it literally`);
  }
  const deprecated = DEPRECATED_REGIONS[normalized];
  if (deprecated) {
    problems.push(`${label} primary_region "${normalized}" is DEPRECATED (${deprecated.reason}); use "${deprecated.superseded_by}"`);
    return problems;
  }
  if (!APPROVED_WORKER_REGIONS.includes(normalized)) {
    problems.push(`${label} primary_region "${normalized}" is not an approved worker region (approved: ${APPROVED_WORKER_REGIONS.join(", ")}); adding one is a reviewed edit to scripts/fly-region-policy.mjs`);
  }
  return problems;
}
