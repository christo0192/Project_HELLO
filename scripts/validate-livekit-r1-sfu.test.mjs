#!/usr/bin/env node
// Non-vacuous tests for the isolated SFU validator: the real configuration
// passes and narrowly changed synthetic configurations each fail.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const validator = path.join(root, "scripts/validate-livekit-r1-sfu.mjs");
const source = path.join(root, "infra/livekit-r1");
const files = ["fly.toml", "Dockerfile", "livekit.yaml.tmpl", "entrypoint.sh"];
const failures = [];
const ok = (condition, message) => { if (!condition) failures.push(message); };
const run = (config) => {
  const result = spawnSync(process.execPath, [validator, config], { encoding: "utf8" });
  return { code: result.status, output: `${result.stdout || ""}${result.stderr || ""}` };
};
const fixture = (mutate = {}) => {
  const dir = mkdtempSync(path.join(tmpdir(), "livekit-r1-sfu-"));
  for (const file of files) writeFileSync(path.join(dir, file), mutate[file] ?? readFileSync(path.join(source, file), "utf8"));
  return dir;
};

{
  const result = run(path.join(source, "fly.toml"));
  ok(result.code === 0, `real SFU config must pass:\n${result.output}`);
  ok(/external_services=443,80,7881,7882 udp_mux=7882/.test(result.output), "pass result must surface the external port contract");
}

const goodToml = readFileSync(path.join(source, "fly.toml"), "utf8");
const goodDockerfile = readFileSync(path.join(source, "Dockerfile"), "utf8");
const goodTemplate = readFileSync(path.join(source, "livekit.yaml.tmpl"), "utf8");
const readme = readFileSync(path.join(source, "README.md"), "utf8");
const page = readFileSync(path.join(source, "spike/index.html"), "utf8");
const mint = readFileSync(path.join(source, "spike/mint-token.mjs"), "utf8");
const echo = readFileSync(path.join(source, "spike/echo_agent.py"), "utf8");
const results = readFileSync(path.join(source, "spike/results-template.md"), "utf8");
ok(/fly apps create/.test(readme) && /fly ips allocate-v4/.test(readme) && /openssl rand/.test(readme) && /fly deploy --ha=false --config infra\/livekit-r1\/fly\.toml/.test(readme), "runbook must cover spike app, dedicated IPv4, generated keys, and single-Machine deploy");
ok(/ss -ulpn/.test(readme) && /lk token create/.test(readme) && /fly ips release/.test(readme), "runbook must cover S0-F1 socket proof, lk tokens, and IPv4 teardown");
const entrypoint = readFileSync(path.join(source, "entrypoint.sh"), "utf8");
ok(/LIVEKIT_R1_FGS_IP_OVERRIDE/.test(entrypoint) && /set LIVEKIT_R1_FGS_IP_OVERRIDE only for a local smoke test/.test(entrypoint), "entrypoint must retain an explicit, local-only Fly-global-services override and otherwise fail closed");
ok(/Local Docker smoke test/.test(readme) && /LIVEKIT_R1_FGS_IP_OVERRIDE=127\.0\.0\.1/.test(readme), "runbook must document the local Docker smoke-test override");
ok(/cdn\.jsdelivr\.net\/npm\/livekit-client/.test(page) && /URLSearchParams/.test(page) && /createLocalAudioTrack/.test(page) && /createLocalVideoTrack/.test(page), "spike page must use CDN LiveKit client, query/form inputs, microphone, and camera");
ok(/width: 640, height: 360, frameRate: 15/.test(page) && /simulcast: false/.test(page) && /maxBitrate: 500_000/.test(page), "spike page must publish the prescribed 640x360/15fps, no-simulcast, 500k video");
ok(/getStats\(\)/.test(page) && /setInterval\(.*5_000/.test(page) && /currentRoundTripTime/.test(page) && /jitter/.test(page) && /packetsLost/.test(page) && /framesPerSecond/.test(page) && /qualityLimitation/.test(page), "spike page must sample the required selected-pair and media stats every five seconds");
ok(/RoomServiceClient/.test(mint) && /AgentDispatchClient/.test(mint) && /createRoom/.test(mint) && /createDispatch/.test(mint) && /candidate/.test(mint) && /agent/.test(mint), "mint helper must create a room, dispatch r1-spike, and mint both test identities");
ok(/agent_name="r1-spike"/.test(echo) && /AudioStream/.test(echo) && /capture_frame/.test(echo), "echo worker must use only r1-spike and return subscribed audio");
ok(!/(?:browser-screener|phone-screener)/.test(echo), "echo worker must never use a production agent name");
ok(/≥98%/.test(results) && /≥90%/.test(results) && /≤200ms/.test(results) && /≥12fps/.test(results) && /NO-GO/.test(results), "results template must preserve v2 S0-F pass thresholds and kill switch");
const cases = [
  ["wrong region", { "fly.toml": goodToml.replace('primary_region = "sin"', 'primary_region = "bom"') }, /DEPRECATED/],
  ["Cloud host", { "fly.toml": `${goodToml}\n# test-v87uzexo.livekit.cloud\n` }, /LiveKit Cloud/],
  ["baked secret", { "fly.toml": goodToml.replace("  # LIVEKIT_KEYS", '  LIVEKIT_KEYS = "not-a-secret"\n  # LIVEKIT_KEYS') }, /must not bake/],
  ["UDP port drift", { "fly.toml": goodToml.replace('port = 7882', 'port = 7883') }, /7882/],
  ["raw TCP handler drift", { "fly.toml": goodToml.replace('handlers = []', 'handlers = ["tls"]') }, /raw TCP/],
  ["memory drift", { "fly.toml": goodToml.replace("memory_mb = 2048", "memory_mb = 1024") }, /2 GB/],
  ["unpinned image", { Dockerfile: goodDockerfile.replace("@sha256:5d3dcc475d064536d9948ebe4eeab8e3b24d6f07a46f6d71a3415a2901bbdc52", "") }, /pin livekit/],
  ["missing FGS filter", { "livekit.yaml.tmpl": goodTemplate.replace("  ips:\n    includes:\n      - \"__FLY_GLOBAL_SERVICES__/32\"\n", "") }, /fly-global-services/],
];
for (const [label, mutation, expected] of cases) {
  const dir = fixture(mutation);
  const result = run(path.join(dir, "fly.toml"));
  ok(result.code !== 0, `${label} must fail, got:\n${result.output}`);
  ok(expected.test(result.output), `${label} must name its failed invariant, got:\n${result.output}`);
  rmSync(dir, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`validate-livekit-r1-sfu tests FAILED (${failures.length})`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`validate-livekit-r1-sfu tests OK (${cases.length + 1} controls)`);
}
