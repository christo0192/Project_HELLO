#!/usr/bin/env node
// Static contract for the isolated, manual-only R1 LiveKit SFU spike. This is
// intentionally separate from validate-voice-worker-apps.mjs: that validator
// hard-codes the two worker apps and correctly forbids [[services]].

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { assertPolicyConsistent, checkPrimaryRegion } from "./fly-region-policy.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const configPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(root, "infra/livekit-r1/fly.toml");
const configDir = path.dirname(configPath);
const failures = [];
const ok = (condition, message) => { if (!condition) failures.push(message); };
const read = (file) => {
  try { return readFileSync(file, "utf8"); }
  catch { failures.push(`missing required file: ${file}`); return ""; }
};

const toml = read(configPath);
const dockerfile = read(path.join(configDir, "Dockerfile"));
const template = read(path.join(configDir, "livekit.yaml.tmpl"));
const entrypoint = read(path.join(configDir, "entrypoint.sh"));

function oneTopLevel(text, key) {
  const values = [...text.matchAll(new RegExp(`^${key}\\s*=\\s*"([^"]*)"\\s*(?:#.*)?$`, "gm"))].map((m) => m[1]);
  ok(values.length === 1, `${path.basename(configPath)} must declare exactly one top-level ${key}`);
  return values[0] ?? null;
}
function serviceBlocks(text) {
  const marks = [...text.matchAll(/^[ \t]*\[\[services\]\][ \t]*(?:#.*)?$/gm)].map((m) => m.index);
  return marks.map((start, index) => text.slice(start, marks[index + 1] ?? text.length));
}
function serviceShape(block) {
  const protocol = block.match(/^\s*protocol\s*=\s*"([^"]+)"/m)?.[1];
  const internal = Number(block.match(/^\s*internal_port\s*=\s*(\d+)/m)?.[1]);
  const ports = [...block.matchAll(/^\s*port\s*=\s*(\d+)/gm)].map((m) => Number(m[1]));
  return { protocol, internal, ports, block };
}

for (const problem of assertPolicyConsistent()) failures.push(problem);
const app = oneTopLevel(toml, "app");
const region = oneTopLevel(toml, "primary_region");
for (const problem of checkPrimaryRegion("infra/livekit-r1/fly.toml", region)) failures.push(problem);
ok(app === "project-hello-r1-rtc-spike", "SFU config app must be project-hello-r1-rtc-spike (production is a separate manual config)");

// There are three Fly service blocks but exactly four externally exposed ports:
// 443 and force-HTTPS 80 share the signaling service, plus raw 7881 and UDP 7882.
const services = serviceBlocks(toml).map(serviceShape);
ok(services.length === 3, "SFU config must have exactly three service blocks for the four required external services");
const signaling = services.find((s) => s.protocol === "tcp" && s.internal === 7880);
const iceTcp = services.find((s) => s.protocol === "tcp" && s.internal === 7881);
const iceUdp = services.find((s) => s.protocol === "udp" && s.internal === 7882);
ok(Boolean(signaling) && signaling?.ports.length === 2 && signaling?.ports.includes(443) && signaling?.ports.includes(80), "must expose 443 TLS+HTTP and 80 force-HTTPS to internal 7880");
ok(Boolean(signaling) && /port\s*=\s*443[\s\S]*?handlers\s*=\s*\["tls",\s*"http"\]/.test(signaling?.block ?? ""), "443 must use tls+http handlers");
ok(Boolean(signaling) && /port\s*=\s*80[\s\S]*?handlers\s*=\s*\["http"\][\s\S]*?force_https\s*=\s*true/.test(signaling?.block ?? ""), "80 must use the http handler and force HTTPS");
ok(Boolean(iceTcp) && iceTcp?.ports.length === 1 && iceTcp?.ports[0] === 7881 && /handlers\s*=\s*\[\]/.test(iceTcp?.block ?? ""), "7881 must be raw TCP with handlers = []");
ok(Boolean(iceUdp) && iceUdp?.ports.length === 1 && iceUdp?.ports[0] === 7882, "7882 must be the sole UDP ICE mux service");
ok(services.filter((s) => s.protocol === "udp").length === 1, "must expose exactly one UDP service");
ok(!/\[http_service\]/.test(toml), "SFU config must use explicit services, not [http_service]");

ok((toml.match(/^\[\[vm\]\]/gm) || []).length === 1, "SFU config must declare exactly one VM shape (deploy with --ha=false for one Machine)");
ok(/cpu_kind\s*=\s*"performance"/.test(toml) && /cpus\s*=\s*1/.test(toml) && /memory_mb\s*=\s*2048/.test(toml), "VM must be performance-1x with 2 GB memory");
ok(/min_machines_running\s*=\s*0/.test(toml) && /auto_stop_machines\s*=\s*"stop"/.test(toml), "spike must retain the reviewed on-demand, no-autoscale posture");
ok(/\[metrics\][\s\S]*?port\s*=\s*6789/.test(toml), "Prometheus metrics must be private on port 6789");
ok(/http_checks[\s\S]*?method\s*=\s*"get"[\s\S]*?path\s*=\s*"\/"/.test(toml), "signaling service must health-check GET / on 7880");

ok(!/livekit\.cloud/i.test(toml), "SFU TOML must not reference a LiveKit Cloud host");
const envAllowlist = new Set(); // NODE_IP and all runtime credentials are Fly secrets, never [env].
let table = "";
for (const rawLine of toml.split(/\r?\n/)) {
  const line = rawLine.replace(/\s+#.*$/, "");
  const header = line.match(/^\s*(?:\[\[([^\]]+)\]\]|\[([^\]]+)\])\s*$/);
  if (header) { table = header[1] ?? header[2]; continue; }
  if (line.trimStart().startsWith("#")) continue;
  const assignment = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (!assignment) continue;
  const [, name, value] = assignment;
  if (table === "env" && !envAllowlist.has(name)) {
    failures.push(`[env] assignment ${name} is not allowlisted; runtime values must come from Fly secrets`);
  }
  if (/(?:_KEYS?|_SECRET|_PASSWORD|_TOKEN)$/i.test(name)) {
    failures.push(`SFU TOML must not assign secret-shaped variable ${name}`);
  }
  const credentialUrl = /[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i.test(value);
  if (/postgresql:\/\//i.test(value) || /https?:\/\/[^\s/@:]+:[^\s/@]+@/i.test(value) || (/_URL$/i.test(name) && credentialUrl)) {
    failures.push(`SFU TOML must not contain credential-bearing URL value for ${name}`);
  }
}
ok(!/^[ \t]*keys:/m.test(toml), "SFU TOML must not contain inline LiveKit YAML keys");

const digest = "sha256:5d3dcc475d064536d9948ebe4eeab8e3b24d6f07a46f6d71a3415a2901bbdc52";
ok(new RegExp(`^FROM livekit/livekit-server:v1\\.13\\.7@${digest}$`, "m").test(dockerfile), "Dockerfile must pin livekit/livekit-server:v1.13.7 to the approved amd64 digest");
ok(/LIVEKIT_R1_CONFIG:-A/.test(entrypoint) && /if \[ "\$R1_CONFIG" = "B" \]/.test(entrypoint) && /__RTC_IPS__/.test(template) && !/^\s*ips:/m.test(template), "Config A must default to no rtc.ips filter; Config B alone may render the FGS filter");
ok(/FLY_APP_NAME/.test(entrypoint) && /FLY_MACHINE_ID/.test(entrypoint) && /forbidden on Fly/.test(entrypoint), "the local FGS override must fail closed on Fly");
ok(/udp_port:\s*7882/.test(template) && /tcp_port:\s*7881/.test(template) && /use_external_ip:\s*false/.test(template), "LiveKit template must pin the reviewed ICE ports and explicit node-IP mode");
ok(/node_ip:\s*"__NODE_IP__"/.test(template) && /auto_create:\s*false/.test(template) && /prometheus:\s*\{ port: 6789 \}/.test(template), "LiveKit template must use NODE_IP, API-created rooms, and private Prometheus");

if (failures.length) {
  console.error(`livekit-r1 SFU contract FAILED (${failures.length})`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("livekit-r1 SFU contract OK");
  console.log("region_configs_checked=infra/livekit-r1/fly.toml");
  console.log("external_services=443,80,7881,7882 udp_mux=7882 vm=performance-1x/2048");
}
