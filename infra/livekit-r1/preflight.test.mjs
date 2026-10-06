#!/usr/bin/env node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const preflight = path.join(root, "infra/livekit-r1/preflight.mjs");
const temp = mkdtempSync(path.join(tmpdir(), "livekit-r1-preflight-"));
const failures = [];
const ok = (condition, message) => { if (!condition) failures.push(message); };
const run = (value) => spawnSync(process.execPath, [preflight], { input: value, encoding: "utf8" });

const valid = run(JSON.stringify([{ id: "machine-1", region: "sin" }]));
ok(valid.status === 0 && /preflight OK/.test(valid.stdout), "one sin Machine must pass from stdin");
for (const [label, body] of [
  ["zero", "[]"],
  ["two", JSON.stringify([{ region: "sin" }, { region: "sin" }])],
  ["wrong region", JSON.stringify([{ region: "bom" }])],
  ["invalid JSON", "not-json"],
]) {
  const result = run(body);
  ok(result.status !== 0 && /preflight FAILED/.test(result.stderr), `${label} must fail closed`);
}

const file = path.join(temp, "machines.json");
writeFileSync(file, JSON.stringify([{ id: "from-file", region: "sin" }]));
const fromFile = spawnSync(process.execPath, [preflight, file], { encoding: "utf8" });
ok(fromFile.status === 0 && /from-file/.test(fromFile.stdout), "saved JSON input must pass");
rmSync(temp, { recursive: true, force: true });

if (failures.length) {
  console.error(`livekit-r1 preflight tests FAILED (${failures.length})`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("livekit-r1 preflight tests OK (6 controls)");
}
