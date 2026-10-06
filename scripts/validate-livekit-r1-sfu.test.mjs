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
const coldDispatch = readFileSync(path.join(source, "spike/cold-dispatch-diagnosis.mjs"), "utf8");
const dispatchDiagnosis = readFileSync(path.join(source, "spike/dispatch-diagnosis.spec.mjs"), "utf8");
const laptopCheck = readFileSync(path.join(source, "spike/laptop-check.spec.mjs"), "utf8");
const echo = readFileSync(path.join(source, "spike/echo_agent.py"), "utf8");
const s0eAgent = readFileSync(path.join(source, "spike/s0e_agent.py"), "utf8");
const spikeHost = readFileSync(path.join(source, "spike/spike-host.mjs"), "utf8");
const results = readFileSync(path.join(source, "spike/results-template.md"), "utf8");
ok(/fly apps create/.test(readme) && /fly ips allocate-v4/.test(readme) && /openssl rand/.test(readme) && /fly deploy infra\/livekit-r1 --ha=false --remote-only -a project-hello-r1-rtc-spike/.test(readme), "runbook must cover spike app, dedicated IPv4, generated keys, and the scoped remote single-Machine deploy");
ok(/ss -ulpn/.test(readme) && /lk token create/.test(readme) && /fly ips release/.test(readme), "runbook must cover S0-F1 socket proof, lk tokens, and IPv4 teardown");
const entrypoint = readFileSync(path.join(source, "entrypoint.sh"), "utf8");
ok(/LIVEKIT_R1_CONFIG:-A/.test(entrypoint) && /LIVEKIT_R1_FGS_IP_OVERRIDE/.test(entrypoint) && /forbidden on Fly/.test(entrypoint), "entrypoint must default to Config A and fail closed when a local FGS override appears on Fly");
ok(/LIVEKIT_R1_RENDER_ONLY/.test(entrypoint) && /REDACTED/.test(entrypoint) && /awk -v node_ip/.test(entrypoint) && /unset LIVEKIT_KEYS/.test(entrypoint), "entrypoint must support secret-redacted render-only tests, avoid fragile multiline sed rendering, and clear the colliding LIVEKIT_KEYS environment");
ok(/sysctl -w net\.core\.rmem_max=5000000 net\.core\.rmem_default=5000000/.test(entrypoint), "entrypoint must make the reviewed UDP receive-buffer best-effort");
ok(/sed -i 's\/\\r\$\/\/' \/etc\/livekit\/livekit\.yaml\.tmpl \/usr\/local\/bin\/livekit-r1-entrypoint/.test(goodDockerfile), "Dockerfile must defensively normalize CRLF on the template and entrypoint");
ok(/Local Docker smoke test/.test(readme) && /LIVEKIT_R1_FGS_IP_OVERRIDE=127\.0\.0\.1/.test(readme), "runbook must document the local Docker smoke-test override");
ok(/Config A first/.test(readme) && /Config B only if Config A fails/.test(readme) && /forced-TCP/.test(readme), "runbook must require Config A before opt-in Config B, including forced TCP");
ok(/CRLF/.test(readme) && /LIVEKIT_KEYS/.test(readme) && /collide/.test(readme), "runbook must document the CRLF and LIVEKIT_KEYS parser-collision fixes");
ok(/cdn\.jsdelivr\.net\/npm\/livekit-client/.test(page) && /URLSearchParams/.test(page) && /createLocalAudioTrack/.test(page) && /createLocalVideoTrack/.test(page), "spike page must use CDN LiveKit client, query/form inputs, microphone, and camera");
ok(/width: 640, height: 360, frameRate: 15/.test(page) && /simulcast: false/.test(page) && /maxBitrate: 500_000/.test(page), "spike page must publish the prescribed 640x360/15fps, no-simulcast, 500k video");
ok(/manager\?\.publisher/.test(page) && /manager\?\.subscriber/.test(page) && /getStats\(\)/.test(page) && /NO-GO: no selected UDP/.test(page) && /setInterval\(.*5_000/.test(page) && /currentRoundTripTime/.test(page) && /jitter/.test(page) && /packetsLost/.test(page) && /framesPerSecond/.test(page) && /qualityLimitation/.test(page), "spike page must sample public PCTransport stats and mark a missing selected UDP pair NO-GO");
ok(/RoomServiceClient/.test(mint) && /AgentDispatchClient/.test(mint) && /createRoom/.test(mint) && /createDispatch/.test(mint) && /canPublishSources/.test(mint) && /canPublishData: false/.test(mint) && !/r1-spike-agent/.test(mint), "mint helper must create a room, dispatch r1-spike, and mint only a least-privilege candidate token");
ok(/agent_name(?:=|"\s*:\s*)"r1-spike"/.test(echo) && /AudioStream/.test(echo) && /capture_frame/.test(echo) && /participant_disconnected/.test(echo) && /await candidate_left/.test(echo) && /await source\.aclose\(\)/.test(echo), "echo worker must return subscribed audio until the candidate disconnects, then close its source");
const spikeTools = [mint, coldDispatch, dispatchDiagnosis, laptopCheck, echo, s0eAgent];
ok(spikeTools.every((tool) => /assertSpikeUrl|assert_spike_url/.test(tool)) && /SPIKE_HOST/.test(spikeHost) && /project-hello-r1-rtc-spike\.fly\.dev/.test(spikeHost), "all spike tools must use the shared exact-host fence without an environment override");
ok(!/(?:browser-screener|phone-screener)/.test(echo), "echo worker must never use a production agent name");
ok(/≥98%/.test(results) && /≥90%/.test(results) && /≤200ms/.test(results) && /≥12fps/.test(results) && /NO-GO/.test(results), "results template must preserve v2 S0-F pass thresholds and kill switch");
const cases = [
  ["wrong region", { "fly.toml": goodToml.replace('primary_region = "sin"', 'primary_region = "bom"') }, /DEPRECATED/],
  ["Cloud host", { "fly.toml": `${goodToml}\n# test-v87uzexo.livekit.cloud\n` }, /LiveKit Cloud/],
  ["baked secret", { "fly.toml": goodToml.replace("  # LIVEKIT_KEYS", '  LIVEKIT_KEYS = "not-a-secret"\n  # LIVEKIT_KEYS') }, /secret-shaped/],
  ["UDP port drift", { "fly.toml": goodToml.replace('port = 7882', 'port = 7883') }, /7882/],
  ["raw TCP handler drift", { "fly.toml": goodToml.replace('handlers = []', 'handlers = ["tls"]') }, /raw TCP/],
  ["memory drift", { "fly.toml": goodToml.replace("memory_mb = 2048", "memory_mb = 1024") }, /2 GB/],
  ["unpinned image", { Dockerfile: goodDockerfile.replace("@sha256:5d3dcc475d064536d9948ebe4eeab8e3b24d6f07a46f6d71a3415a2901bbdc52", "") }, /pin livekit/],
  ["trailing-comment service bypass", { "fly.toml": `${goodToml}\n[[services]] # a fourth service must still count\n` }, /exactly three service/],
  ["generic password", { "fly.toml": `${goodToml}\nTURN_PASSWORD = \"not-a-secret\"\n` }, /secret-shaped/],
  ["credential URL", { "fly.toml": `${goodToml}\nSUPABASE_DB_URL = \"postgresql:\/\/user:pass@example.test\/db\"\n` }, /credential-bearing URL/],
  ["env NODE_IP bypass", { "fly.toml": goodToml.replace("  # NODE_IP", "  NODE_IP = \"1.2.3.4\"\n  # NODE_IP") }, /not allowlisted/],
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
