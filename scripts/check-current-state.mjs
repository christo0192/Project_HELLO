#!/usr/bin/env node

/**
 * Deterministic FND-09 current-state drift checker.
 * PLAN.md remains the roadmap authority; config/current-state.json records the
 * evidenced implementation/deployment state and is validated without network
 * access or third-party packages.
 */

import { readFile, lstat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const errors = [];
const fail = (message) => errors.push(message);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const hasKeys = (value, keys, label) => {
  if (!isObject(value)) { fail(`${label} must be an object`); return false; }
  for (const key of keys) if (!(key in value)) fail(`${label}.${key} is required`);
  return true;
};
const validDate = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
};
const safeRelativePath = (value) => {
  if (typeof value !== "string" || value.length === 0 || path.isAbsolute(value)) return null;
  const resolved = path.resolve(root, value);
  const relative = path.relative(root, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return resolved;
};

async function loadJson(relativePath, label) {
  try { return JSON.parse(await readFile(path.join(root, relativePath), "utf8")); }
  catch { fail(`Cannot parse ${label}`); return null; }
}

const manifest = await loadJson("config/current-state.json", "config/current-state.json");
const schema = await loadJson("config/current-state.schema.json", "config/current-state.schema.json");
if (!manifest || !schema) report();

hasKeys(manifest, ["manifestVersion", "evidenceDate", "status", "runtime", "gates", "phases", "providers", "docsStatus", "constraints"], "manifest");
if (manifest.manifestVersion !== schema.version) fail(`manifestVersion ${manifest.manifestVersion} does not match schema version ${schema.version}`);

if (!validDate(manifest.evidenceDate)) {
  fail("evidenceDate must be a real YYYY-MM-DD UTC date");
} else {
  const evidence = new Date(`${manifest.evidenceDate}T00:00:00Z`);
  const now = new Date();
  const ageDays = (now - evidence) / 86_400_000;
  if (ageDays < -1) fail(`evidenceDate ${manifest.evidenceDate} is in the future`);
  if (ageDays > 90) fail(`evidenceDate ${manifest.evidenceDate} is more than 90 days old`);
}

if (hasKeys(manifest.status, ["production", "dataStage", "scope"], "status")) {
  if (manifest.status.production !== "pre-production") fail(`status.production is "${manifest.status.production}", expected "pre-production"`);
  if (manifest.status.dataStage !== "synthetic-only") fail(`status.dataStage is "${manifest.status.dataStage}", expected "synthetic-only"`);
  if (manifest.status.scope !== "browser-only") fail(`status.scope is "${manifest.status.scope}", expected "browser-only"`);
}

const activeComponents = manifest.runtime?.activeComponents;
const staleComponents = manifest.runtime?.staleComponents;
if (!isObject(activeComponents) || Object.keys(activeComponents).length === 0) fail("runtime.activeComponents must be a non-empty object");
if (!isObject(staleComponents)) fail("runtime.staleComponents must be an object");
for (const [name, component] of Object.entries(activeComponents ?? {})) {
  if (!hasKeys(component, ["path", "purpose", "language", "productionStatus"], `runtime.activeComponents.${name}`)) continue;
  if (component.productionStatus !== "pre-production") fail(`Active component "${name}" must be pre-production`);
  const componentPath = safeRelativePath(component.path);
  if (!componentPath) { fail(`Active component "${name}" has unsafe path`); continue; }
  try { if (!(await lstat(componentPath)).isDirectory()) fail(`Active component "${name}" path is not a directory`); }
  catch { fail(`Active component "${name}" path is missing`); }
}

for (const [label, expectedComplete, expectedTotal] of [
  ["gates", "launchGatesComplete", "launchGatesTotal"],
  ["phases", "acceptedPhasesComplete", "acceptedPhasesTotal"],
]) {
  const value = manifest[label];
  if (!hasKeys(value, [expectedComplete, expectedTotal], label)) continue;
  if (!Number.isInteger(value[expectedComplete]) || value[expectedComplete] !== 0) fail(`${expectedComplete} is ${value[expectedComplete]}, expected 0`);
  if (!Number.isInteger(value[expectedTotal]) || value[expectedTotal] < 1) fail(`${expectedTotal} must be a positive integer`);
}

const active = manifest.providers?.active;
const stale = manifest.providers?.stale;
if (!Array.isArray(active)) fail("providers.active must be an array");
if (!Array.isArray(stale)) fail("providers.stale must be an array");
const activeNames = new Set();
for (const provider of active ?? []) {
  if (!hasKeys(provider, ["name", "status", "evidenceDate"], "active provider")) continue;
  if (provider.status !== "current") fail(`Active provider "${provider.name}" must have status "current"`);
  if (!validDate(provider.evidenceDate)) fail(`Active provider "${provider.name}" has invalid evidenceDate`);
  if (activeNames.has(provider.name)) fail(`Duplicate active provider "${provider.name}"`);
  activeNames.add(provider.name);
}
const staleNames = new Set();
for (const provider of stale ?? []) {
  if (!hasKeys(provider, ["name", "status"], "stale provider")) continue;
  if (!["stale/reference", "archived"].includes(provider.status)) fail(`Stale provider "${provider.name}" has status "${provider.status}"`);
  if (staleNames.has(provider.name)) fail(`Duplicate stale provider "${provider.name}"`);
  staleNames.add(provider.name);
  if (activeNames.has(provider.name)) fail(`Provider "${provider.name}" appears in both active and stale lists`);
}
for (const required of ["LiveKit", "Sarvam AI", "Anthropic (Claude/Haiku)", "Supabase"]) if (!activeNames.has(required)) fail(`Active provider list must include "${required}"`);
for (const required of ["Pipecat", "Retell AI"]) if (!staleNames.has(required)) fail(`Stale provider list must include "${required}"`);

const mandatoryDocs = manifest.docsStatus?.mandatoryDocsPresent;
if (!Array.isArray(mandatoryDocs) || mandatoryDocs.length === 0) fail("docsStatus.mandatoryDocsPresent must be a non-empty array");
for (const doc of mandatoryDocs ?? []) {
  const docPath = safeRelativePath(doc);
  if (!docPath) { fail(`Mandatory doc path is unsafe: ${String(doc)}`); continue; }
  try {
    const stat = await lstat(docPath);
    if (!stat.isFile() || stat.isSymbolicLink()) fail(`Mandatory doc is not a regular file: ${doc}`);
  } catch { fail(`Mandatory doc missing: ${doc}`); }
}

const requiredConstraints = ["noProductionClaim", "noTelephonyCurrent", "noGateCountDrift", "noProviderBackslide"];
if (hasKeys(manifest.constraints, requiredConstraints, "constraints")) {
  for (const key of requiredConstraints) if (manifest.constraints[key] !== true) fail(`Constraint "${key}" must be true`);
}

// Derive totals from PLAN.md rather than trusting duplicated constants.
let plan = "";
try { plan = await readFile(path.join(root, "PLAN.md"), "utf8"); }
catch { fail("Cannot read PLAN.md"); }
if (plan) {
  const gateCount = (plan.match(/^- \[[ x]\] \*\*[A-Z0-9-]+-GATE:/gm) ?? []).length;
  const phaseNumbers = [...plan.matchAll(/^### Phase (\d+):/gm)].map((match) => Number(match[1]));
  if (manifest.gates?.launchGatesTotal !== gateCount) fail(`launchGatesTotal is ${manifest.gates?.launchGatesTotal}, PLAN.md defines ${gateCount}`);
  if (manifest.phases?.acceptedPhasesTotal !== phaseNumbers.length) fail(`acceptedPhasesTotal is ${manifest.phases?.acceptedPhasesTotal}, PLAN.md defines ${phaseNumbers.length}`);
  if (phaseNumbers.some((value, index) => value !== index)) fail("PLAN.md phase numbering must be contiguous from 0");
}

// Load-bearing entry points use small semantic markers, not full paragraphs.
const docRequirements = new Map([
  ["README.md", [/browser-first/i, /pre-production/i, /PLAN\.md/]],
  ["app/README.md", [/voice-livekit/i, /Pipecat/i, /not production-ready/i]],
  ["docs/HANDOVER.md", [/0\/17/, /0\/14/, /PR #19.*merged/i]],
  ["docs/current-state.md", [/browser-only/i, /Pipecat/i, /Retell/i]],
]);
for (const [doc, patterns] of docRequirements) {
  try {
    const text = await readFile(path.join(root, doc), "utf8");
    for (const pattern of patterns) if (!pattern.test(text)) fail(`${doc} missing current-state marker ${pattern}`);
  } catch { fail(`Cannot read load-bearing doc: ${doc}`); }
}

report();

function report() {
  if (errors.length) {
    console.error(`Current-state drift check FAILED (${errors.length}):`);
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }
  console.log(`Current-state manifest valid (evidence ${manifest.evidenceDate}):\n` +
    `  Status: ${manifest.status.production}, ${manifest.status.dataStage}, ${manifest.status.scope}\n` +
    `  Launch gates: ${manifest.gates.launchGatesComplete}/${manifest.gates.launchGatesTotal}\n` +
    `  Phases: ${manifest.phases.acceptedPhasesComplete}/${manifest.phases.acceptedPhasesTotal}\n` +
    `  Active providers: ${manifest.providers.active.map((p) => p.name).join(", ")}\n` +
    `  Stale providers: ${manifest.providers.stale.map((p) => p.name).join(", ")}\n` +
    `  Mandatory docs: ${manifest.docsStatus.mandatoryDocsPresent.length}`);
}
