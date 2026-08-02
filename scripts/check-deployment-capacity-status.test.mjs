#!/usr/bin/env node

/**
 * check-deployment-capacity-status.test.mjs — Negative controls for the PR-B
 * status-field validator and the DEP-01/02/03 capacity CLI.
 *
 * Structure:
 *   A. Baseline real-repo gates (validator, CLI self-test, fixture, determinism).
 *   B. Status validator negative controls: seeded positive deployment/capacity
 *      claims inside the PR-B scan surface must be rejected; truthful
 *      PENDING/PROPOSED/synthetic text must pass.
 *   C. Capacity CLI negative controls: capacity_approved claims, secret-like
 *      targets, rto 0 + ACCEPTED HA acceptance, and scale triggers without a
 *      source must all be rejected offline.
 *
 * Usage: node scripts/check-deployment-capacity-status.test.mjs
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const validator = path.join(root, "scripts/check-deployment-capacity-status.mjs");
const cli = path.join(root, "scripts/capacity-benchmark-run");
const topologyManifest = path.join(root, "infra/capacity/managed-topology.manifest.json");
const haExample = path.join(root, "infra/capacity/ha-decision.example.json");

// Secret-like test values are reconstructed at runtime from innocuous
// fragments so the committed test source never contains a literal key,
// credential, or high-entropy secret-looking string.
const syntheticSkToken = "sk-" + ["syntheticbenchmark", "token", "notarealkey", "0123456789abcdefghij"].join("");
const userPassUrl = "https://" + "user:pass" + "@host.example/path";

const testErrors = [];
function record(failure) {
  testErrors.push(failure);
}

function run(cmd, args, cwd) {
  return spawnSync(cmd, args, { cwd: cwd || root, encoding: "utf8" });
}

function runNode(scriptPath, args, cwd) {
  return run(process.execPath, [scriptPath, ...args], cwd);
}

/** Write files into a fresh temp fixture dir, run the validator, expect rejection. */
async function expectValidatorRejection(files, messageFragment, label) {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "dep-status-neg-"));
  try {
    for (const [relative, content] of Object.entries(files)) {
      const target = path.join(fixture, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    const result = runNode(validator, [], fixture);
    if (result.status === 0) {
      record(`[${label}] validator unexpectedly PASSED on seeded negative control`);
      return;
    }
    if (messageFragment && !(result.stdout + result.stderr).includes(messageFragment)) {
      record(`[${label}] rejection message missing "${messageFragment}"; got: ${(result.stderr + result.stdout).slice(0, 400)}`);
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

/** Write one file into a fresh temp dir and run the CLI expecting non-zero exit. */
async function expectCliRejection(command, args, fileContent, messageFragment, label) {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "dep-cli-neg-"));
  const filePath = path.join(fixture, "input.json");
  try {
    await writeFile(filePath, fileContent);
    const result = runNode(cli, [command, filePath, ...args], root);
    if (result.status === 0) {
      record(`[${label}] CLI ${command} unexpectedly PASSED on seeded negative control`);
      return;
    }
    if (messageFragment && !(result.stdout + result.stderr).includes(messageFragment)) {
      record(`[${label}] CLI rejection message missing "${messageFragment}"; got: ${(result.stderr + result.stdout).slice(0, 400)}`);
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

// ── A. Baseline real-repo gates ─────────────────────────────────────────────

(function baselineValidator() {
  const result = runNode(validator, [], root);
  if (result.status !== 0) record(`[baseline] status validator failed on real repo: ${result.stderr}`);
})();

(function baselineSelfTest() {
  const result = runNode(cli, ["self-test"], root);
  if (result.status !== 0) record(`[baseline] capacity CLI self-test failed: ${result.stderr}`);
})();

(function baselineFixture() {
  const result = runNode(cli, ["fixture", "--scenario", "synthetic-local", "--output", "json"], root);
  if (result.status !== 0) {
    record(`[baseline] fixture failed: ${result.stderr}`);
    return;
  }
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    record("[baseline] fixture output is not valid JSON");
    return;
  }
  if (report.policy?.capacityApproved !== false) record("[baseline] fixture report must have capacityApproved false");
  if (!["PROPOSED", "PENDING"].includes(report.policy?.state)) record("[baseline] fixture report policy state must be PROPOSED/PENDING");
  if (report.evidence?.evidenceType !== "synthetic_local") record("[baseline] fixture evidence type must be synthetic_local");
  if (report.summary?.status !== "SYNTHETIC_LOCAL") record("[baseline] fixture summary status must be SYNTHETIC_LOCAL");
  if (!report.results?.sessionsAttempted || report.results.sessionsAttempted < 1) record("[baseline] fixture must be non-vacuous (sessions attempted)");

  // Determinism: same seed twice -> identical results (ignoring metadata).
  const second = runNode(cli, ["fixture", "--scenario", "synthetic-local", "--output", "json", "--seed", "42"], root);
  if (second.status !== 0) {
    record("[baseline] second fixture run failed");
  } else {
    const report2 = JSON.parse(second.stdout);
    const strip = (r) => JSON.stringify({ results: r.results, inputs: r.inputs });
    if (strip(report) !== strip(report2)) record("[baseline] fixture is not deterministic for the same seed");
  }
})();

(function baselineRealArtifacts() {
  const topo = runNode(cli, ["topology-validate", topologyManifest], root);
  if (topo.status !== 0) record(`[baseline] real topology manifest rejected: ${topo.stderr}`);
  const ha = runNode(cli, ["ha-validate", haExample], root);
  if (ha.status !== 0) record(`[baseline] real HA example rejected: ${ha.stderr}`);
})();

// ── B. Status validator negative controls ───────────────────────────────────

await expectValidatorRejection(
  { "infra/capacity/fake.json": JSON.stringify({ status: "APPROVED" }) },
  "APPROVED",
  "status APPROVED rejected"
);

await expectValidatorRejection(
  { "infra/capacity/fake2.json": JSON.stringify({ signed: true }) },
  "claim-sensitive field",
  "signed:true rejected"
);

await expectValidatorRejection(
  { "infra/capacity/fake3.json": JSON.stringify({ slsa_level: 2 }) },
  "slsa_level",
  "slsa_level 2 rejected"
);

await expectValidatorRejection(
  { "infra/capacity/fake4.json": JSON.stringify({ deployed: true }) },
  "claim-sensitive field",
  "deployed:true rejected"
);

await expectValidatorRejection(
  { "infra/capacity/fake5.json": JSON.stringify({ policy: { state: "DEPLOYED" } }) },
  "DEPLOYED",
  "policy.state DEPLOYED rejected"
);

await expectValidatorRejection(
  { "infra/capacity/fake6.json": JSON.stringify({ capacityApproved: true }) },
  "claim-sensitive field",
  "capacityApproved:true rejected"
);

await expectValidatorRejection(
  { "infra/capacity/fake7.json": JSON.stringify({ approval: { status: "ACCEPTED" } }) },
  "ACCEPTED",
  "approval ACCEPTED rejected"
);

await expectValidatorRejection(
  { "infra/capacity/fake8.json": JSON.stringify({ approvedBy: "christo0192" }) },
  "asserts a positive claim",
  "approvedBy:<name> rejected"
);

await expectValidatorRejection(
  { "infra/capacity/fake9.json": JSON.stringify({ status: "APPROVED_PENDING_OWNER" }) },
  "APPROVED",
  "APPROVED_PENDING_OWNER rejected"
);

await expectValidatorRejection(
  { "docs/deployment-capacity/claim.md": "The benchmark approved 50 concurrent sessions." },
  "approved",
  "md capacity approved rejected"
);

await expectValidatorRejection(
  { "docs/deployment-capacity/claim2.md": "Deployment accepted by owner." },
  "accepted",
  "md deployment accepted rejected"
);

await expectValidatorRejection(
  { "docs/deployment-capacity/claim3.md": "**Status:** APPROVED" },
  "approved",
  "md Status APPROVED rejected"
);

await expectValidatorRejection(
  { "docs/deployment-capacity/claim4.md": "Failover verified across zones." },
  "failover",
  "md failover verified rejected"
);

await expectValidatorRejection(
  { "docs/deployment-capacity/claim5.md": "Artifacts are signed; slsa_level 2 achieved." },
  "signed",
  "md signed + slsa_level rejected"
);

// HIGH-review regression: no external-evidence bypass — EV-xxxx references and
// random UUIDs near a positive claim must NOT authorize it.
await expectValidatorRejection(
  { "docs/deployment-capacity/claim6.md": "Deployment accepted. EV-FAKE" },
  "accepted",
  "md Deployment accepted. EV-FAKE rejected"
);

await expectValidatorRejection(
  { "docs/deployment-capacity/claim7.md": "Capacity approved (EV-FAKE)" },
  "approved",
  "md capacity approved with EV-FAKE rejected"
);

await expectValidatorRejection(
  { "docs/deployment-capacity/claim8.md": "Failover verified by audit 9b2e1a44-5c7d-4f6e-8a2b-1c3d4e5f6a7b" },
  "failover",
  "md failover verified with random UUID rejected"
);

await expectValidatorRejection(
  { "docs/deployment-capacity/claim9.md": "The environment is deployed; evidence_id 4c8e6f2a-1b3d-4e9f-8a7c-0d5e6f7a8b9c" },
  "deployed",
  "md deployed with random UUID rejected"
);

await expectValidatorRejection(
  { "docs/runbooks/canary-rollback-x.md": "Canary promotion accepted. EV-FAKE" },
  "accepted",
  "canary glob accepted with EV-FAKE rejected"
);

await expectValidatorRejection(
  { "config/deployment-capacity-x.schema.json": JSON.stringify({ description: "This benchmark result is APPROVED." }) },
  "approved",
  "config glob schema APPROVED rejected"
);

await expectValidatorRejection(
  { "docs/runbooks/deployment-capacity-x.md": "Capacity approved for launch." },
  "approved",
  "runbook glob capacity approved rejected"
);

await expectValidatorRejection(
  { "docs/runbooks/canary-rollback-x.md": "The winner configuration is selected." },
  "winner",
  "canary glob winner rejected"
);

// Truthful fixture: PENDING/PROPOSED/synthetic + negated phrasing must pass.
async function truthfulFixturePasses() {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "dep-status-ok-"));
  try {
    const okJsonPath = path.join(fixture, "infra/capacity/ok.json");
    const okMdPath = path.join(fixture, "docs/deployment-capacity/ok.md");
    await mkdir(path.dirname(okJsonPath), { recursive: true });
    await mkdir(path.dirname(okMdPath), { recursive: true });
    await writeFile(
      okJsonPath,
      JSON.stringify({
        status: "PENDING",
        policyState: "PROPOSED",
        approvalStatus: "PENDING",
        capacityApproved: false,
        deployed: false,
        provisioned: false,
        deploymentState: "NOT_DEPLOYED",
        approval: { status: "PENDING", owner: null, date: null },
        singleInstanceRisk: { exists: true, status: "PENDING", description: "synthetic placeholder", mitigation: "owner recovery" },
        rtoRpo: { rtoMinutes: { value: null, unit: "minutes", status: "PENDING" }, rpoMinutes: { value: null, unit: "minutes", status: "PENDING" } },
      })
    );
    await writeFile(
      okMdPath,
      [
        "# Truthful status notes",
        "",
        "No capacity is deployed. Approval remains PENDING owner verification.",
        "The harness is synthetic_local only. RTO/RPO values are not yet set.",
        "Single-instance risk acceptance is PENDING. Failover is not verified.",
      ].join("\n")
    );
    const result = runNode(validator, [], fixture);
    if (result.status !== 0) record(`[truthful] validator rejected truthful PENDING/PROPOSED fixture: ${result.stderr}`);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}
await truthfulFixturePasses();

// ── C. Capacity CLI negative controls ───────────────────────────────────────

async function cliReportNegative() {
  // A report claiming capacity_approved:true (or a positive policy state) must be rejected.
  const fixture = await mkdtemp(path.join(os.tmpdir(), "dep-cli-report-"));
  try {
    const base = runNode(cli, ["fixture", "--scenario", "synthetic-local", "--output", "json", "--seed", "42"], root);
    const report = JSON.parse(base.stdout);
    report.policy.capacityApproved = true;
    await writeFile(path.join(fixture, "approved.json"), JSON.stringify(report));
    const rejected = runNode(cli, ["schema-validate", path.join(fixture, "approved.json")], root);
    if (rejected.status === 0) record("[cli] capacityApproved:true report must be rejected by schema-validate");

    report.policy.capacityApproved = false;
    report.policy.state = "DEPLOYED";
    await writeFile(path.join(fixture, "deployed.json"), JSON.stringify(report));
    const rejected2 = runNode(cli, ["schema-validate", path.join(fixture, "deployed.json")], root);
    if (rejected2.status === 0) record("[cli] DEPLOYED policy state must be rejected by schema-validate");

    // A truthful fixture report must pass schema-validate.
    await writeFile(path.join(fixture, "ok.json"), JSON.stringify(JSON.parse(base.stdout)));
    const ok = runNode(cli, ["schema-validate", path.join(fixture, "ok.json")], root);
    if (ok.status !== 0) record(`[cli] truthful fixture report rejected by schema-validate: ${ok.stderr}`);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}
await cliReportNegative();

await expectCliRejection(
  "config-validate",
  [],
  JSON.stringify({
    schemaVersion: "1.0.0",
    scenario: "synthetic-local",
    concurrency: 10,
    durationSeconds: 30,
    warmupSeconds: 0,
    headroomPercent: 0,
    costUnit: { label: "per concurrent session-hour", currency: "USD", pricingStatus: "PENDING" },
    target: syntheticSkToken,
  }),
  "secret-like",
  "config with sk- token rejected"
);

await expectCliRejection(
  "config-validate",
  [],
  JSON.stringify({
    schemaVersion: "1.0.0",
    scenario: "synthetic-local",
    concurrency: 10,
    durationSeconds: 30,
    warmupSeconds: 0,
    headroomPercent: 0,
    costUnit: { label: "per concurrent session-hour", currency: "USD", pricingStatus: "PENDING" },
    endpoint: userPassUrl,
  }),
  "secret-like",
  "config with URL userinfo rejected"
);

// rto_minutes: 0 with approval ACCEPTED must be rejected (HA acceptance gate).
await expectCliRejection(
  "ha-validate",
  [],
  JSON.stringify({
    schemaVersion: "1.0.0",
    decisionId: "ha-decision-neg-001",
    component: "synthetic",
    created: "2026-08-02T00:00:00Z",
    decisionState: "PROPOSED",
    haDecision: { haRequiredProposal: false, rationale: "synthetic" },
    singleInstanceRisk: { exists: true, description: "synthetic", mitigation: "owner recovery", status: "PENDING" },
    rtoRpo: {
      rtoMinutes: { value: 0, unit: "minutes", status: "PENDING" },
      rpoMinutes: { value: 0, unit: "minutes", status: "PENDING" },
    },
    approval: { status: "ACCEPTED", owner: "christo0192", date: "2026-08-02T00:00:00Z" },
  }),
  "PENDING",
  "HA rto 0 + ACCEPTED rejected"
);

// Scale trigger without a metric/source must be rejected.
await expectCliRejection(
  "topology-validate",
  [],
  JSON.stringify({
    manifestVersion: "1.0.0",
    title: "negative",
    description: "negative control",
    adrReference: "docs/adr/0010-hosting-topology.md",
    status: "PROPOSED",
    approvalStatus: "PENDING",
    provisioned: false,
    deployed: false,
    components: [
      {
        componentId: "web-api",
        name: "Web / API",
        role: "synthetic",
        failureDomain: "application",
        scalesIndependently: true,
        scaleTriggers: [{ metric: "api_concurrent_requests", thresholdProposed: "x", status: "PROPOSED" }],
        ownerStatus: "PENDING",
        provisioning: "PENDING",
        notes: "negative control",
      },
      { componentId: "a", name: "a", role: "a", failureDomain: "application", scalesIndependently: false, scaleTriggers: [{ metric: "m", source: "s", thresholdProposed: "x", status: "PROPOSED" }], ownerStatus: "PENDING", provisioning: "PENDING", notes: "" },
      { componentId: "b", name: "b", role: "b", failureDomain: "application", scalesIndependently: false, scaleTriggers: [{ metric: "m", source: "s", thresholdProposed: "x", status: "PROPOSED" }], ownerStatus: "PENDING", provisioning: "PENDING", notes: "" },
      { componentId: "c", name: "c", role: "c", failureDomain: "application", scalesIndependently: false, scaleTriggers: [{ metric: "m", source: "s", thresholdProposed: "x", status: "PROPOSED" }], ownerStatus: "PENDING", provisioning: "PENDING", notes: "" },
      { componentId: "d", name: "d", role: "d", failureDomain: "application", scalesIndependently: false, scaleTriggers: [{ metric: "m", source: "s", thresholdProposed: "x", status: "PROPOSED" }], ownerStatus: "PENDING", provisioning: "PENDING", notes: "" },
      { componentId: "e", name: "e", role: "e", failureDomain: "application", scalesIndependently: false, scaleTriggers: [{ metric: "m", source: "s", thresholdProposed: "x", status: "PROPOSED" }], ownerStatus: "PENDING", provisioning: "PENDING", notes: "" },
      { componentId: "f", name: "f", role: "f", failureDomain: "application", scalesIndependently: false, scaleTriggers: [{ metric: "m", source: "s", thresholdProposed: "x", status: "PROPOSED" }], ownerStatus: "PENDING", provisioning: "PENDING", notes: "" },
    ],
    externalPending: ["negative control"],
  }),
  "source",
  "scale trigger without source rejected"
);

// ── Report ──────────────────────────────────────────────────────────────────

if (testErrors.length) {
  console.error(`deployment-capacity negative controls FAILED (${testErrors.length}):`);
  for (const error of testErrors) console.error(`- ${error}`);
  process.exit(1);
}
console.log("All deployment-capacity status/CLI negative controls passed (baseline + 22 validator negatives incl. EV-FAKE/UUID no-bypass + 6 CLI negatives).");
