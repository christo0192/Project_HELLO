#!/usr/bin/env node
// Render the startup template without an image or a LiveKit binary. This makes
// the two reviewed rtc.ips modes regression-testable on every platform.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const directory = path.dirname(fileURLToPath(import.meta.url));
// Low-entropy generated fixture, so secret scanners don't flag it as a key.
const secret = "a".repeat(40);
const failures = [];
const ok = (condition, message) => { if (!condition) failures.push(message); };

function render(config) {
  // WSL's bash.exe does not inherit arbitrary Windows environment variables.
  // Put these fixed, non-secret fixture values in the Bash command so this
  // remains a real entrypoint invocation on Windows and Linux alike.
  const variables = [
    "NODE_IP=203.0.113.10",
    `LIVEKIT_KEYS=r1-test:${secret}`,
    "LIVEKIT_R1_RENDER_ONLY=1",
    `LIVEKIT_R1_CONFIG=${config}`,
    `LIVEKIT_R1_FGS_IP_OVERRIDE=${config === "B" ? "127.0.0.1" : ""}`,
    "FLY_APP_NAME=",
    "FLY_MACHINE_ID=",
  ];
  const result = spawnSync("bash", ["-c", `${variables.join(" ")} bash entrypoint.sh`], {
    cwd: directory,
    encoding: "utf8",
  });
  return { code: result.status, output: result.stdout, error: result.stderr };
}

function assertCommonYaml(output, label) {
  const lines = output.split(/\r?\n/);
  const keyIndex = lines.indexOf("keys:");
  ok(!output.includes("__"), `${label}: all template markers must be rendered`);
  ok(!output.includes(secret), `${label}: render-only output must redact the key secret`);
  ok(lines[keyIndex + 1] === "  r1-test: REDACTED", `${label}: keys must remain a mapping under keys`);
  ok(lines.includes('  node_ip: "203.0.113.10"'), `${label}: node IP must remain nested under rtc`);
}

{
  const result = render("A");
  ok(result.code === 0, `Config A render must exit 0:\n${result.error}`);
  assertCommonYaml(result.output, "Config A");
  ok(!/^\s+ips:/m.test(result.output), "Config A must omit the rtc.ips block entirely");
}

{
  const result = render("B");
  ok(result.code === 0, `Config B render must exit 0:\n${result.error}`);
  assertCommonYaml(result.output, "Config B");
  const lines = result.output.split(/\r?\n/);
  const ipsIndex = lines.indexOf("  ips:");
  ok(
    lines.indexOf("rtc:") < ipsIndex
      && lines[ipsIndex + 1] === "    includes:"
      && lines[ipsIndex + 2] === '      - "127.0.0.1/32"',
    "Config B must render rtc.ips.includes at valid nested YAML indentation",
  );
  ok(!/^ips:/m.test(result.output), "Config B ips must not escape the rtc mapping");
}

// Render-only mode exits before the runtime tail, so check the runtime contract
// by source order: LIVEKIT_KEYS must be unset before livekit-server starts.
// Otherwise livekit-server re-reads it in its own "key: secret" format and refuses to start.
{
  const source = readFileSync(path.join(directory, "entrypoint.sh"), "utf8");
  const unsetAt = source.search(/^\s*unset LIVEKIT_KEYS\s*$/m);
  const execAt = source.search(/^\s*exec \/livekit-server\b/m);
  ok(unsetAt !== -1, "entrypoint.sh must unset LIVEKIT_KEYS before starting livekit-server");
  ok(execAt !== -1, "entrypoint.sh must exec /livekit-server");
  ok(unsetAt !== -1 && execAt !== -1 && unsetAt < execAt,
    "unset LIVEKIT_KEYS must occur before exec /livekit-server");
}

if (failures.length) {
  console.error(`livekit-r1 entrypoint render tests FAILED (${failures.length})`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("livekit-r1 entrypoint render tests OK (Config A and Config B)");
}
