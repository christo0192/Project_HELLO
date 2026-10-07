#!/usr/bin/env node
// Render the startup template without an image or a LiveKit binary. This makes
// the three reviewed rtc.ips modes (A, B, C) regression-testable on every
// platform. Config C is also driven through a `getent` test double on PATH, so
// the exact production lookup path (`getent hosts fly-local-6pn | awk`) runs, and
// against a fixture of the kernel's /proc/net/if_inet6 table, so "the 6PN address
// is really on an interface" is checked end to end as well.
// Every case is a real entrypoint.sh invocation. `bash` runs the full set and
// POSIX `sh` (dash on Linux CI; production is Alpine's /bin/sh) runs the core set.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const directory = path.dirname(fileURLToPath(import.meta.url));
// Low-entropy generated fixture, so secret scanners don't flag it as a key.
const secret = "a".repeat(40);
const failures = [];
const ok = (condition, message) => { if (!condition) failures.push(message); };

const shQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
const entrypointSource = readFileSync(path.join(directory, "entrypoint.sh"), "utf8");

// A minimal `getent` double. Only the two names the entrypoint asks for are
// answered; everything else (and an unset canned line) is "not found" (exit 2),
// exactly like the real tool.
const getentDouble = [
  "#!/bin/sh",
  '[ "$1" = "hosts" ] || exit 2',
  'case "$2" in',
  '  fly-global-services) [ -n "${FAKE_GETENT_FGS:-}" ] && { printf \'%s\\n\' "$FAKE_GETENT_FGS"; exit 0; } ;;',
  '  fly-local-6pn) [ -n "${FAKE_GETENT_6PN:-}" ] && { printf \'%s\\n\' "$FAKE_GETENT_6PN"; exit 0; } ;;',
  "esac",
  "exit 2",
  "",
].join("\n");
const scratch = mkdtempSync(path.join(tmpdir(), "livekit-r1-entrypoint-"));
const scratchFiles = [];
const scratchWrite = (name, content) => {
  const file = path.join(scratch, name);
  writeFileSync(file, content, { mode: 0o755 });
  scratchFiles.push(file);
};
scratchWrite("getent", getentDouble);
// PATH is a colon-separated POSIX list, so a Windows temp directory has to be
// translated by the shell that will use it: cygpath in Git Bash, wslpath in WSL,
// and the path unchanged on Linux/macOS.
const scratchOnPath = [
  "if command -v cygpath >/dev/null 2>&1; then F=$(cygpath -u " + shQuote(scratch) + ");",
  "elif command -v wslpath >/dev/null 2>&1; then F=$(wslpath -u " + shQuote(scratch) + ");",
  "else F=" + shQuote(scratch) + "; fi;",
].join(" ");

function exec(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, options);
    let output = "";
    let error = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { error += chunk; });
    child.on("error", (e) => resolve({ code: -1, output, error: `${error}${e.message}` }));
    child.on("close", (code) => resolve({ code, output, error }));
  });
}

// `run` is a real entrypoint invocation. WSL's bash.exe does not inherit
// arbitrary Windows environment variables, so every fixed, non-secret fixture
// value goes into the Bash command itself. `shell` is the interpreter that runs
// entrypoint.sh.
// `ifInet6` names a fixture written with scratchWrite; it becomes
// LIVEKIT_R1_IF_INET6_FILE, translated to the interpreter's own path syntax.
function run({ shell = "bash", config = "A", env = {}, getent = null, ifInet6 = null } = {}) {
  const variables = {
    NODE_IP: "203.0.113.10",
    LIVEKIT_KEYS: `r1-test:${secret}`,
    LIVEKIT_R1_RENDER_ONLY: "1",
    LIVEKIT_R1_CONFIG: config,
    LIVEKIT_R1_FGS_IP_OVERRIDE: "",
    LIVEKIT_R1_6PN_IP_OVERRIDE: "",
    FLY_APP_NAME: "",
    FLY_MACHINE_ID: "",
    FLY_PRIVATE_IP: "",
    LIVEKIT_R1_IF_INET6_FILE: "",
    ...(getent ? { FAKE_GETENT_FGS: getent.fgs ?? "", FAKE_GETENT_6PN: getent.sixpn ?? "" } : {}),
    ...env,
  };
  if (ifInet6) delete variables.LIVEKIT_R1_IF_INET6_FILE;
  const assignments = Object.entries(variables).map(([name, value]) => `${name}=${shQuote(value)}`).join(" ")
    + (ifInet6 ? ` LIVEKIT_R1_IF_INET6_FILE="$F/${ifInet6}"` : "");
  const prefix = getent || ifInet6 ? `${scratchOnPath} ${getent ? "PATH=$F:$PATH " : ""}` : "";
  return exec("bash", ["-c", `${prefix}${assignments} ${shell} entrypoint.sh`], { cwd: directory });
}

// Cases run one after another: entrypoint.sh always renders to the fixed path
// /tmp/livekit.yaml, so concurrent invocations would overwrite each other.
// (The pure-function matrix below never touches that file and runs alongside.)
const queue = [];
const pending = [];
const expectRun = (options, verify) => { queue.push(async () => verify(await run(options))); };

// Just enough YAML for the rendered file: nested block mappings, "- scalar"
// lists, quoted/number/boolean scalars, and flow mappings kept opaque. It throws
// on tabs or on structure that is not a plain nesting, so a mis-indented
// rtc.ips block cannot pass by accident.
function parseYaml(text) {
  const root = {};
  const frames = [{ indent: -1, value: root }];
  const scalar = (raw) => {
    const value = raw.trim();
    if (/^"(?:[^"\\]|\\.)*"$/.test(value)) return JSON.parse(value);
    if (/^-?\d+$/.test(value)) return Number(value);
    if (value === "true" || value === "false") return value === "true";
    return value;
  };
  const materialize = (frame, wantList, line) => {
    if (frame.value === undefined) {
      frame.value = wantList ? [] : {};
      frame.pending.target[frame.pending.key] = frame.value;
    }
    if (Array.isArray(frame.value) !== wantList) throw new Error(`line ${line}: mixed list and mapping`);
    return frame.value;
  };
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = index + 1;
    if (/^\s*(?:#.*)?$/.test(raw)) continue;
    if (raw.includes("\t")) throw new Error(`line ${line}: tab indentation`);
    const indent = raw.length - raw.trimStart().length;
    const body = raw.trim();
    while (frames.length > 1 && frames.at(-1).indent >= indent) frames.pop();
    const owner = frames.at(-1);
    if (body.startsWith("- ")) {
      materialize(owner, true, line).push(scalar(body.slice(2)));
      continue;
    }
    const mapping = body.match(/^([A-Za-z_][A-Za-z0-9_-]*):(?:\s+(.*))?$/);
    if (!mapping) throw new Error(`line ${line}: unsupported YAML: ${body}`);
    const target = materialize(owner, false, line);
    if (mapping[2] === undefined || mapping[2] === "") {
      frames.push({ indent, value: undefined, pending: { target, key: mapping[1] } });
    } else {
      target[mapping[1]] = scalar(mapping[2]);
    }
  }
  return root;
}

function parseOrReport(output, label) {
  try { return parseYaml(output); } catch (error) { failures.push(`${label} must be valid YAML: ${error.message}`); return null; }
}

function assertCommonYaml(output, label) {
  const lines = output.split(/\r?\n/);
  const keyIndex = lines.indexOf("keys:");
  ok(!output.includes("__"), `${label}: all template markers must be rendered`);
  ok(!output.includes(secret), `${label}: render-only output must redact the key secret`);
  ok(lines[keyIndex + 1] === "  r1-test: REDACTED", `${label}: keys must remain a mapping under keys`);
  ok(lines.includes('  node_ip: "203.0.113.10"'), `${label}: node IP must remain nested under rtc`);
}

// ---------------------------------------------------------------------------
// Config A and Config B: byte-for-byte snapshots, taken from the entrypoint as
// it was before Config C existed. Any intended template change must update them.
// ---------------------------------------------------------------------------
const snapshotHead = [
  "# Rendered by entrypoint.sh. This file intentionally contains no credentials.",
  "port: 7880",
  "logging: { level: info, json: true }",
  "",
  "rtc:",
  "  tcp_port: 7881",
  "  udp_port: 7882",
  "  use_external_ip: false",
  '  node_ip: "203.0.113.10"',
  "  allow_tcp_fallback: true",
  "  # Config B only: entrypoint replaces the marker with rtc.ips.includes.",
];
const snapshotTail = [
  "",
  "room:",
  "  auto_create: false",
  "",
  "# LIVEKIT_KEYS is injected only as a Fly secret. The entrypoint validates it",
  "# before this template is rendered as the single YAML mapping below.",
  "keys:",
  "  r1-test: REDACTED",
  "",
  "# Redis, TURN, webhooks, Egress, SIP, and Ingress are deliberately absent.",
  "turn: { enabled: false }",
  "prometheus: { port: 6789 }",
  "",
];
const snapshotA = [...snapshotHead, ...snapshotTail].join("\n");
const snapshotB = [
  ...snapshotHead,
  "  ips:",
  "    includes:",
  '      - "127.0.0.1/32"',
  ...snapshotTail,
].join("\n");
const withoutIps = (text) => text.split("\n").filter((line) => !/^\s+(?:ips:|includes:|- ")/.test(line)).join("\n");

// 6PN shape matrix. The function under test is extracted verbatim from
// entrypoint.sh and run for every value in ONE shell process per interpreter.
const sixpn = "fdaa:0:863:a7b:1b3:abcd:ef01:2";
const accepted = [
  sixpn,
  "fdaa:0:863:a7b::2",
  "fdaa::1",
  "FDAA:0:863:A7B:1B3:ABCD:EF01:2",
  "fdaa:0:863:a7b:1b3:abcd:ef01:0",
  "fdaa:1:2:3:4:5:6::",
];
const rejected = [
  ["empty", ""],
  ["IPv4", "127.0.0.1"],
  ["loopback", "::1"],
  ["link-local", "fe80::1"],
  ["other ULA prefix", "fd00::1"],
  ["near-miss prefix", "fdab::1"],
  ["bare prefix", "fdaa"],
  ["prefix and colon only", "fdaa:"],
  ["seven groups", "fdaa:0:1:2:3:4:5"],
  ["nine groups", "fdaa:0:1:2:3:4:5:6:7"],
  ["eight groups with trailing ::", "fdaa:0:1:2:3:4:5:6::"],
  ["compressed form with too many groups", "fdaa:0:1:2:3:4:5::6:7"],
  ["non-hex digit", "fdaa:0:1:2:3:4:5:g"],
  ["five-digit group", "fdaa:0:1:2:3:4:5:12345"],
  ["two ::", "fdaa::1::2"],
  ["triple colon", "fdaa:::1"],
  ["trailing single colon", "fdaa::1:"],
  ["empty group", "fdaa:0:1:2:3:4:5:"],
  ["prefix length", "fdaa:0:1:2:3:4:5:6/112"],
  ["zone id", "fdaa:0:1:2:3:4:5:6%eth0"],
  ["brackets", "[fdaa:0:1:2:3:4:5:6]"],
  ["trailing space", "fdaa:0:1:2:3:4:5:6 "],
  ["leading space", " fdaa:0:1:2:3:4:5:6"],
  ["leading garbage", "xfdaa::1"],
  ["two lines", "fdaa:0:1:2:3:4:5:6\nfdaa:0:1:2:3:4:5:7"],
  ["YAML injection", 'fdaa::1"\n  evil: true'],
  ["quote", 'fdaa::1"'],
];
const fnMatch = entrypointSource.match(/^is_6pn_ipv6\(\) \{\n[\s\S]*?\n\}\n/m);
ok(Boolean(fnMatch), "entrypoint.sh must define is_6pn_ipv6() so the 6PN shape check is testable");
const matrixCases = [...accepted.map((v) => ["ACCEPT", v]), ...rejected.map(([, v]) => ["REJECT", v])];
scratchWrite(
  "matrix.sh",
  [
    fnMatch?.[0] ?? "is_6pn_ipv6() { return 1; }",
    ...matrixCases.map(([, value]) => `if is_6pn_ipv6 ${shQuote(value)}; then echo ACCEPT; else echo REJECT; fi`),
    "",
  ].join("\n"),
);

// Kernel interface-table fixtures (/proc/net/if_inet6 layout: address as 32 hex
// digits, ifindex, prefix length, scope, flags, device; all in hex). The 32-digit
// forms below are written out by hand, not derived with the code under test.
const hex = {
  sixpn: "fdaa000008630a7b01b3abcdef010002", // fdaa:0:863:a7b:1b3:abcd:ef01:2
  compressed: "fdaa000008630a7b0000000000000002", // fdaa:0:863:a7b::2
  fallback: "fdaa000008630a7b01b3abcdef010009", // fdaa:0:863:a7b:1b3:abcd:ef01:9
  shortest: "fdaa0000000000000000000000000001", // fdaa::1
  trailing: "fdaa0001000200030004000500060000", // fdaa:1:2:3:4:5:6::
  longer: "fdaa000008630a7b01b3abcdef010020", // fdaa:0:863:a7b:1b3:abcd:ef01:20
  other: "fdaa000008630a7b01b3abcdef01000f", // fdaa:0:863:a7b:1b3:abcd:ef01:f
};
const tableLine = (address, device = "eth0", prefix = "70") => `${address} 05 ${prefix} 00 80 ${device.padStart(8)}`;
const tableLo = tableLine("00000000000000000000000000000001", "lo", "80");
const tableLinkLocal = tableLine("fe80000000000000d4a2d0fffe123456", "eth0", "40");
const writeTable = (name, ...addresses) => scratchWrite(name, [tableLo, tableLinkLocal, ...addresses.map((a) => tableLine(a)), ""].join("\n"));
// Everything the happy paths below can ask for is on the interface.
writeTable("inet6-all.txt", hex.sixpn, hex.compressed, hex.fallback);
// The interface carries a different, well-formed 6PN address than the one asked for.
writeTable("inet6-other.txt", hex.other, hex.longer);
writeTable("inet6-trailing.txt", hex.trailing);
writeTable("inet6-shortest.txt", hex.shortest);
scratchWrite("inet6-empty.txt", "");

// v6_is_configured, extracted verbatim like is_6pn_ipv6, against the fixtures
// (relative paths: the script runs with the scratch directory as cwd).
const configuredCases = [
  ["ACCEPT", "full address on the interface", sixpn, "inet6-all.txt"],
  ["ACCEPT", "upper-case input", "FDAA:0:863:A7B:1B3:ABCD:EF01:2", "inet6-all.txt"],
  ["ACCEPT", "compressed input, zero run in the middle", "fdaa:0:863:a7b::2", "inet6-all.txt"],
  ["ACCEPT", "fallback address among several", "fdaa:0:863:a7b:1b3:abcd:ef01:9", "inet6-all.txt"],
  ["ACCEPT", "shortest compressed input", "fdaa::1", "inet6-shortest.txt"],
  ["ACCEPT", "trailing :: expands to the last group", "fdaa:1:2:3:4:5:6::", "inet6-trailing.txt"],
  ["ACCEPT", "a near-miss entry (...:20) does not hide the real one", "fdaa:0:863:a7b:1b3:abcd:ef01:20", "inet6-other.txt"],
  ["REJECT", "well-formed address on no interface", sixpn, "inet6-other.txt"],
  ["REJECT", "...:20 must not be satisfied by the ...:2 entry", "fdaa:0:863:a7b:1b3:abcd:ef01:20", "inet6-all.txt"],
  ["REJECT", "...:200 matches neither ...:2 nor ...:20", "fdaa:0:863:a7b:1b3:abcd:ef01:200", "inet6-other.txt"],
  ["REJECT", "compressed form of an absent address", "fdaa:0:863:a7b::2", "inet6-other.txt"],
  ["REJECT", "shortest form absent", "fdaa::1", "inet6-trailing.txt"],
  ["REJECT", "empty table", sixpn, "inet6-empty.txt"],
  ["REJECT", "missing table", sixpn, "inet6-does-not-exist.txt"],
  ["REJECT", "nine groups cannot expand to 32 digits", "fdaa:0:1:2:3:4:5:6:7", "inet6-all.txt"],
];
const configuredFn = entrypointSource.match(/^v6_is_configured\(\) \{\n[\s\S]*?\n\}\n/m);
ok(Boolean(configuredFn), "entrypoint.sh must define v6_is_configured() so the interface check is testable");
scratchWrite(
  "configured.sh",
  [
    configuredFn?.[0] ?? "v6_is_configured() { return 1; }",
    ...configuredCases.map(([, , address, table]) => `if v6_is_configured ${shQuote(address)} ${shQuote(table)}; then echo ACCEPT; else echo REJECT; fi`),
    "",
  ].join("\n"),
);

const shells = ["bash"];
if (spawnSync("bash", ["-c", "command -v sh"], { encoding: "utf8" }).status === 0) shells.push("sh");

const flyEnv = { FLY_APP_NAME: "project-hello-r1-rtc-spike", FLY_MACHINE_ID: "148e2d3b5c0948" };
// The interface-table seam (LIVEKIT_R1_IF_INET6_FILE) is forbidden on Fly, so the
// runs that feed the entrypoint a fixture table carry no Fly markers. They take the
// same code path as flyEnv: the markers are read only by the forbid guards.
const tableEnv = {};
const fgsLine = "172.19.66.154   fly-global-services";
const flyBothAddresses = { fgs: fgsLine, sixpn: `${sixpn}  fly-local-6pn` };

for (const shell of shells) {
  const tag = `[${shell}]`;
  // bash runs everything; sh (dash on Linux CI) runs the core Config A/B/C paths.
  const full = shell === "bash";

  pending.push(exec(shell, ["matrix.sh"], { cwd: scratch }).then((result) => {
    const lines = result.output.split(/\r?\n/).filter(Boolean);
    ok(lines.length === matrixCases.length, `${tag} 6PN shape matrix must run every case, got ${lines.length} of ${matrixCases.length}:\n${result.error}`);
    matrixCases.forEach(([expected, value], index) => {
      ok(lines[index] === expected, `${tag} 6PN address ${JSON.stringify(value)} must be ${expected}ED, got ${lines[index]}`);
    });
  }));

  pending.push(exec(shell, ["configured.sh"], { cwd: scratch }).then((result) => {
    const lines = result.output.split(/\r?\n/).filter(Boolean);
    ok(lines.length === configuredCases.length, `${tag} interface-table matrix must run every case, got ${lines.length} of ${configuredCases.length}:\n${result.error}`);
    configuredCases.forEach(([expected, label], index) => {
      ok(lines[index] === expected, `${tag} interface check (${label}) must be ${expected}ED, got ${lines[index]}`);
    });
  }));

  expectRun({ shell, config: "A" }, (result) => {
    ok(result.code === 0, `${tag} Config A render must exit 0:\n${result.error}`);
    assertCommonYaml(result.output, `${tag} Config A`);
    ok(!/^\s+ips:/m.test(result.output), `${tag} Config A must omit the rtc.ips block entirely`);
    ok(result.output === snapshotA, `${tag} Config A output must be byte-identical to the pre-Config-C snapshot`);
    ok(result.error === "", `${tag} Config A must log nothing to stderr in render-only mode, got: ${result.error}`);
  });

  // A stray 6PN override must be ignored by Config B (it is only read by C).
  expectRun({ shell, config: "B", env: { LIVEKIT_R1_FGS_IP_OVERRIDE: "127.0.0.1", LIVEKIT_R1_6PN_IP_OVERRIDE: "not-an-address" } }, (result) => {
    ok(result.code === 0, `${tag} Config B render must exit 0:\n${result.error}`);
    assertCommonYaml(result.output, `${tag} Config B`);
    const lines = result.output.split(/\r?\n/);
    const ipsIndex = lines.indexOf("  ips:");
    ok(
      lines.indexOf("rtc:") < ipsIndex
        && lines[ipsIndex + 1] === "    includes:"
        && lines[ipsIndex + 2] === '      - "127.0.0.1/32"',
      `${tag} Config B must render rtc.ips.includes at valid nested YAML indentation`,
    );
    ok(!/^ips:/m.test(result.output), `${tag} Config B ips must not escape the rtc mapping`);
    ok(!result.output.includes("/128"), `${tag} Config B must not render any 6PN entry`);
    ok(result.output === snapshotB, `${tag} Config B output must be byte-identical to the pre-Config-C snapshot`);
    ok(
      result.error === "livekit-r1-entrypoint: using LIVEKIT_R1_FGS_IP_OVERRIDE=127.0.0.1 for a non-Fly local Config-B run\n",
      `${tag} Config B stderr must be unchanged, got: ${result.error}`,
    );
  });

  // ---- Config C through the local override seams ----
  expectRun({ shell, config: "C", env: { LIVEKIT_R1_FGS_IP_OVERRIDE: "127.0.0.1", LIVEKIT_R1_6PN_IP_OVERRIDE: sixpn } }, (result) => {
    ok(result.code === 0, `${tag} Config C render must exit 0:\n${result.error}`);
    assertCommonYaml(result.output, `${tag} Config C`);
    const document = parseOrReport(result.output, `${tag} Config C`);
    ok(
      JSON.stringify(document?.rtc?.ips?.includes) === JSON.stringify(["127.0.0.1/32", `${sixpn}/128`]),
      `${tag} Config C must render both FGS /32 and 6PN /128 under rtc.ips.includes, got ${JSON.stringify(document?.rtc?.ips)}`,
    );
    ok(Object.keys(document?.rtc?.ips ?? {}).join() === "includes", `${tag} Config C rtc.ips must contain only includes`);
    ok(document !== null && !("ips" in document), `${tag} Config C ips must not escape the rtc mapping`);
    const { ips, ...rtcWithoutIps } = document?.rtc ?? {};
    ok(
      JSON.stringify(rtcWithoutIps) === JSON.stringify({
        tcp_port: 7881,
        udp_port: 7882,
        use_external_ip: false,
        node_ip: "203.0.113.10",
        allow_tcp_fallback: true,
      }),
      `${tag} Config C must leave every other rtc setting exactly as A/B (no IPv6 knob, no port range, node_ip stays IPv4), got ${JSON.stringify(rtcWithoutIps)}`,
    );
    ok(!/port_range|use_ice_lite|force_tcp|use_ipv6|stun_servers/.test(result.output), `${tag} Config C must not set port ranges, ICE-lite, forced TCP or STUN`);
    ok(withoutIps(result.output) === withoutIps(snapshotB), `${tag} Config C must differ from Config B only inside rtc.ips`);
    ok(
      result.error.includes("LIVEKIT_R1_6PN_IP_OVERRIDE") && result.error.includes("Config-C"),
      `${tag} Config C must log that the local 6PN override is in use, got: ${result.error}`,
    );
  });

  // ---- Config C with no overrides: addresses from getent, 6PN checked against the interface table ----
  // The first field containing ":" wins, so an IPv4 line ahead of it is ignored.
  expectRun({ shell, config: "C", env: tableEnv, ifInet6: "inet6-all.txt", getent: { fgs: fgsLine, sixpn: `10.0.0.5 fly-local-6pn\n${sixpn}  fly-local-6pn` } }, (result) => {
    ok(result.code === 0, `${tag} Config C via getent must exit 0:\n${result.error}`);
    const document = parseOrReport(result.output, `${tag} Config C via getent`);
    ok(
      JSON.stringify(document?.rtc?.ips?.includes) === JSON.stringify(["172.19.66.154/32", `${sixpn}/128`]),
      `${tag} Config C must read both addresses from getent, got ${JSON.stringify(document?.rtc?.ips)}`,
    );
    ok(!/OVERRIDE/.test(result.error), `${tag} Config C on Fly must not use an override, got: ${result.error}`);
  });

  // ---- Config C fails closed ----
  expectRun({ shell, config: "C", env: flyEnv, getent: { fgs: fgsLine, sixpn: "" } }, (result) => {
    ok(result.code !== 0, `${tag} Config C must exit non-zero when getent has no fly-local-6pn entry`);
    ok(result.output === "", `${tag} Config C must render nothing when the 6PN address is missing`);
    ok(/Config C requires the Machine's fly-local-6pn IPv6/.test(result.error), `${tag} Config C must explain the missing 6PN address, got: ${result.error}`);
  });
  expectRun({ shell, config: "C", env: flyEnv, getent: { fgs: fgsLine, sixpn: "::1 fly-local-6pn" } }, (result) => {
    ok(result.code !== 0 && result.output === "" && /must be an fdaa: 6PN IPv6 address/.test(result.error), `${tag} getent returning a non-6PN IPv6 address must be rejected, got: ${result.error}`);
  });
  // A well-formed fdaa: address that no interface carries (stale /etc/hosts, mismatched
  // FLY_PRIVATE_IP): LiveKit would open no 6PN socket and log nothing, i.e. silently be
  // Config B. The entrypoint must refuse, before rendering, and say why.
  expectRun({ shell, config: "C", env: tableEnv, ifInet6: "inet6-other.txt", getent: flyBothAddresses }, (result) => {
    ok(result.code !== 0, `${tag} Config C must exit non-zero when the 6PN address is on no interface`);
    ok(result.output === "", `${tag} Config C must render nothing when the 6PN address is on no interface`);
    ok(
      result.error.includes(`Config C: 6PN address ${sixpn} is not configured on any interface`),
      `${tag} Config C must name the unconfigured 6PN address, got: ${result.error}`,
    );
  });
  // On Fly (markers set, no seam) the kernel's own table is read. No test host has
  // this address, so a Fly-shaped start must refuse and say which table it read.
  expectRun({ shell, config: "C", env: flyEnv, getent: flyBothAddresses }, (result) => {
    ok(
      result.code !== 0 && result.output === ""
        && result.error.includes(`Config C: 6PN address ${sixpn} is not configured on any interface (not in /proc/net/if_inet6)`),
      `${tag} Config C on Fly must check /proc/net/if_inet6 by default, got: ${result.error}`,
    );
  });

  // ---- Local-only override seams are forbidden on Fly ----
  const forbid = (variable, value, marker, config) => expectRun({ shell, config, env: { [variable]: value, [marker]: "set-by-fly" } }, (result) => {
    ok(result.code !== 0, `${tag} ${variable} with ${marker} must be rejected for Config ${config}`);
    ok(result.output === "", `${tag} ${variable} on Fly must render nothing (Config ${config})`);
    ok(result.error.includes(`${variable} is forbidden on Fly`), `${tag} ${variable} on Fly must say so (Config ${config}), got: ${result.error}`);
  });
  forbid("LIVEKIT_R1_6PN_IP_OVERRIDE", sixpn, "FLY_APP_NAME", "C");
  forbid("LIVEKIT_R1_FGS_IP_OVERRIDE", "127.0.0.1", "FLY_APP_NAME", "C");
  forbid("LIVEKIT_R1_IF_INET6_FILE", "/tmp/fake-if_inet6", "FLY_APP_NAME", "C");

  if (!full) continue;

  // ---- Remaining Config C edge cases (bash only; same code paths as above) ----
  // getent may print a compressed form.
  expectRun({ shell, config: "C", env: tableEnv, ifInet6: "inet6-all.txt", getent: { fgs: fgsLine, sixpn: "fdaa:0:863:a7b::2 fly-local-6pn" } }, (result) => {
    ok(result.code === 0 && result.output.includes('      - "fdaa:0:863:a7b::2/128"'), `${tag} Config C must accept a compressed 6PN address from getent:\n${result.error}`);
  });
  expectRun({ shell, config: "C", env: flyEnv, getent: { fgs: fgsLine, sixpn: "10.0.0.5 fly-local-6pn" } }, (result) => {
    ok(result.code !== 0 && result.output === "" && /Config C requires the Machine's fly-local-6pn IPv6/.test(result.error), `${tag} an IPv4-only fly-local-6pn must count as missing, got: ${result.error}`);
  });
  expectRun({ shell, config: "C", env: flyEnv, getent: { fgs: fgsLine, sixpn: "fdaa:0:1:2:3:4:5:zz fly-local-6pn" } }, (result) => {
    ok(result.code !== 0 && result.output === "" && /must be an fdaa: 6PN IPv6 address/.test(result.error), `${tag} a malformed 6PN address from getent must be rejected, got: ${result.error}`);
  });
  // FLY_PRIVATE_IP is only a fallback for an fly-local-6pn alias that does not resolve.
  const otherSixpn = "fdaa:0:863:a7b:1b3:abcd:ef01:9";
  expectRun({ shell, config: "C", env: { ...tableEnv, FLY_PRIVATE_IP: otherSixpn }, ifInet6: "inet6-all.txt", getent: { fgs: fgsLine, sixpn: "" } }, (result) => {
    ok(result.code === 0 && result.output.includes(`      - "${otherSixpn}/128"`) && result.error.includes("using FLY_PRIVATE_IP"), `${tag} Config C must fall back to FLY_PRIVATE_IP when fly-local-6pn does not resolve:
${result.error}`);
  });
  expectRun({ shell, config: "C", env: { ...tableEnv, FLY_PRIVATE_IP: otherSixpn }, ifInet6: "inet6-all.txt", getent: flyBothAddresses }, (result) => {
    ok(result.code === 0 && result.output.includes(`      - "${sixpn}/128"`) && !result.output.includes(otherSixpn) && !result.error.includes("FLY_PRIVATE_IP"), `${tag} fly-local-6pn must win over FLY_PRIVATE_IP:
${result.error}`);
  });
  expectRun({ shell, config: "C", env: { ...flyEnv, FLY_PRIVATE_IP: "10.0.0.5" }, getent: { fgs: fgsLine, sixpn: "" } }, (result) => {
    ok(result.code !== 0 && result.output === "" && /must be an fdaa: 6PN IPv6 address/.test(result.error), `${tag} a malformed FLY_PRIVATE_IP fallback must be rejected, got: ${result.error}`);
  });
  // End to end through the override seam: a bad value dies before anything is rendered.
  expectRun({ shell, config: "C", env: { LIVEKIT_R1_FGS_IP_OVERRIDE: "127.0.0.1", LIVEKIT_R1_6PN_IP_OVERRIDE: 'fdaa::1"\n  evil: true' } }, (result) => {
    ok(result.code !== 0 && result.output === "" && /must be an fdaa: 6PN IPv6 address/.test(result.error), `${tag} a YAML-injecting 6PN override must be rejected, got: ${result.error}`);
  });
  // Config C still needs the FGS address for browsers.
  expectRun({ shell, config: "C", env: flyEnv, getent: { fgs: "", sixpn: `${sixpn} fly-local-6pn` } }, (result) => {
    ok(result.code !== 0 && /Config C requires fly-global-services IPv4/.test(result.error), `${tag} Config C must still require fly-global-services, got: ${result.error}`);
  });
  // Config B on the same Machine keeps working with no 6PN lookup at all.
  expectRun({ shell, config: "B", env: flyEnv, getent: { fgs: fgsLine, sixpn: "" } }, (result) => {
    ok(result.code === 0 && !result.output.includes("/128") && result.output.includes('      - "172.19.66.154/32"'), `${tag} Config B must not require 6PN:\n${result.error}`);
  });

  // ---- Config C refuses an address that is not on any interface ----
  const notConfigured = (label, options) => expectRun({ shell, config: "C", getent: flyBothAddresses, ...options }, (result) => {
    ok(
      result.code !== 0 && result.output === "" && /Config C: 6PN address fdaa:\S+ is not configured on any interface/.test(result.error),
      `${tag} ${label} must fail closed with the not-configured message, got: ${result.error}`,
    );
  });
  // An unreadable or empty kernel table cannot vouch for the address either.
  notConfigured("a missing interface table", { env: tableEnv, ifInet6: "inet6-does-not-exist.txt" });
  notConfigured("an empty interface table", { env: tableEnv, ifInet6: "inet6-empty.txt" });
  // The FLY_PRIVATE_IP fallback is held to the same standard as fly-local-6pn.
  notConfigured("a FLY_PRIVATE_IP fallback on no interface", {
    env: { ...tableEnv, FLY_PRIVATE_IP: "fdaa:0:863:a7b:1b3:abcd:ef01:9" },
    getent: { fgs: fgsLine, sixpn: "" },
    ifInet6: "inet6-other.txt",
  });
  // A near-miss entry on the interface (...:20 for ...:2) is not the address.
  notConfigured("a near-miss interface entry", { env: tableEnv, ifInet6: "inet6-other.txt" });
  // The local override seam is a non-Fly smoke test, where a made-up address is on no interface.
  expectRun({ shell, config: "C", env: { LIVEKIT_R1_FGS_IP_OVERRIDE: "127.0.0.1", LIVEKIT_R1_6PN_IP_OVERRIDE: sixpn }, ifInet6: "inet6-other.txt" }, (result) => {
    ok(result.code === 0 && result.output.includes(`      - "${sixpn}/128"`), `${tag} the local 6PN override must skip the interface check:\n${result.error}`);
  });
  // Configs A and B never consult the interface table.
  expectRun({ shell, config: "B", env: tableEnv, ifInet6: "inet6-does-not-exist.txt", getent: { fgs: fgsLine, sixpn: "" } }, (result) => {
    ok(result.code === 0 && !result.output.includes("/128"), `${tag} Config B must not consult the interface table:\n${result.error}`);
  });

  // Both Fly markers count, for every seam, and for every config.
  forbid("LIVEKIT_R1_6PN_IP_OVERRIDE", sixpn, "FLY_MACHINE_ID", "C");
  forbid("LIVEKIT_R1_FGS_IP_OVERRIDE", "127.0.0.1", "FLY_MACHINE_ID", "C");
  forbid("LIVEKIT_R1_IF_INET6_FILE", "/tmp/fake-if_inet6", "FLY_MACHINE_ID", "C");
  forbid("LIVEKIT_R1_6PN_IP_OVERRIDE", sixpn, "FLY_APP_NAME", "A");
  forbid("LIVEKIT_R1_6PN_IP_OVERRIDE", sixpn, "FLY_APP_NAME", "B");
  forbid("LIVEKIT_R1_IF_INET6_FILE", "/tmp/fake-if_inet6", "FLY_APP_NAME", "A");
  forbid("LIVEKIT_R1_IF_INET6_FILE", "/tmp/fake-if_inet6", "FLY_APP_NAME", "B");

  // ---- The selector accepts exactly A, B and C ----
  // (An empty LIVEKIT_R1_CONFIG falls back to A, the documented default.)
  for (const bad of ["D", "c"]) {
    expectRun({ shell, config: bad }, (result) => {
      ok(result.code !== 0 && /LIVEKIT_R1_CONFIG must be A \(default\), B or C/.test(result.error), `${tag} LIVEKIT_R1_CONFIG=${JSON.stringify(bad)} must be rejected, got: ${result.error}`);
    });
  }
}

await Promise.all(pending);
for (const task of queue) await task();

// Render-only mode exits before the runtime tail, so check the runtime contract
// by source order: LIVEKIT_KEYS must be unset before livekit-server starts.
// Otherwise livekit-server re-reads it in its own "key: secret" format and refuses to start.
{
  const source = entrypointSource;
  const unsetAt = source.search(/^\s*unset LIVEKIT_KEYS\s*$/m);
  const execAt = source.search(/^\s*exec \/livekit-server\b/m);
  ok(unsetAt !== -1, "entrypoint.sh must unset LIVEKIT_KEYS before starting livekit-server");
  ok(execAt !== -1, "entrypoint.sh must exec /livekit-server");
  ok(unsetAt !== -1 && execAt !== -1 && unsetAt < execAt,
    "unset LIVEKIT_KEYS must occur before exec /livekit-server");

  // The Config C startup line is part of the operator contract (README verification).
  const cLog = source.search(/echo "livekit-r1-entrypoint: Config C; advertising \$\{NODE_IP\}:7882 and 6PN \$\{V6\}" >&2/);
  const abLog = source.search(/echo "livekit-r1-entrypoint: Config \$\{R1_CONFIG\}; advertising \$\{NODE_IP\}:7882" >&2/);
  ok(cLog !== -1, 'entrypoint.sh must log "Config C; advertising <node_ip>:7882 and 6PN <addr>"');
  ok(abLog !== -1, "entrypoint.sh must keep the Config A/B startup log line unchanged");
  ok(cLog !== -1 && execAt !== -1 && cLog < execAt, "the Config C startup log must precede exec /livekit-server");
}

for (const file of scratchFiles) { try { unlinkSync(file); } catch { /* best effort */ } }
try { rmdirSync(scratch); } catch { /* temp dir; the OS reclaims it */ }

if (failures.length) {
  console.error(`livekit-r1 entrypoint render tests FAILED (${failures.length})`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`livekit-r1 entrypoint render tests OK (Config A, Config B and Config C; shells: ${shells.join(", ")})`);
}
