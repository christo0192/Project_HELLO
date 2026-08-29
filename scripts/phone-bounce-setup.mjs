#!/usr/bin/env node

/**
 * phone-bounce-setup.mjs — provision (or verify) the LiveKit BOUNCE outbound
 * trunk for answer-first origination, and PRINT the manual Plivo-console steps.
 *
 * ── WHAT ANSWER-FIRST ORIGINATION IS ──────────────────────────────────
 * LiveKit Cloud's outbound-SIP state machine never registers the answer on our
 * Plivo Zentrunk calls and kills every live call ~45 s after INVITE. Plivo's
 * own answer supervision works. So LiveKit dials a Plivo VOICE-APP SIP ENDPOINT
 * that answers INSTANTLY (LiveKit sees an answered call in ~1 s; its timers are
 * satisfied), and Plivo's app then dials the candidate and bridges. This script
 * provisions the LiveKit half — the outbound trunk pointing at Plivo's voice-app
 * SIP domain, authenticated with the Plivo ENDPOINT credentials, mapping our
 * `xhelloattempt` participant attribute onto the SIP header `X-PH-HELLO-ATTEMPT`
 * so Plivo's answer callback can correlate the leg back to our attempt.
 *
 * ── THE FOUR RULES (same posture as scripts/phone-canary/halt-drill.mjs) ──
 *
 *  1. DEFAULT TO DOING NOTHING. No mode mutates without `--execute`. Bare
 *     invocation (or `--dry-run`) prints exactly what WOULD happen and exits.
 *
 *  2. CREDENTIALS ARRIVE IN THE ENVIRONMENT OR ON STDIN, NEVER IN ARGV.
 *     `/proc/<pid>/cmdline` is world-readable and shell history is forever. A
 *     `--auth-password`/`--api-secret` flag is REFUSED with a message that says
 *     why. The Plivo endpoint password may be piped on stdin as a single line.
 *
 *  3. NOTHING IDENTIFYING IS PRINTED. Every line is a boolean, a bounded count,
 *     a fixed code, or a NON-SECRET identifier the operator already configured
 *     (the trunk name, the address, the caller id, the attribute/header names).
 *     No credential, ever — not the api secret, not the endpoint password.
 *
 *  4. THE PLIVO CONSOLE STEPS ARE PRINTED, NEVER EXECUTED. This design makes no
 *     Plivo API call; creating the Application and the Endpoint is a manual,
 *     human-reviewed step, and this script only tells the operator what to do.
 *
 * ── CONFIG SOURCE ─────────────────────────────────────────────────────
 * Everything is read from the ENVIRONMENT (the same names app/api reads), so a
 * run reuses the deployment's own configuration rather than re-typing it:
 *
 *   LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET   — to reach LiveKit
 *   PHONE_BOUNCE_TRUNK_ID                              — verify target (verify mode)
 *   PHONE_BOUNCE_SIP_USER                              — endpoint username (informational)
 *   PHONE_BOUNCE_CALLER_ID                             — the trunk's number / caller id
 *   PLIVO_BOUNCE_ENDPOINT_USERNAME                     — Plivo endpoint auth user
 *   PLIVO_BOUNCE_ENDPOINT_PASSWORD                     — Plivo endpoint auth pass (or stdin)
 *   PLIVO_ANSWER_URL, PLIVO_DIAL_STATUS_URL, PLIVO_HANGUP_URL — printed in the steps
 *
 * USAGE
 *   node scripts/phone-bounce-setup.mjs plan                      # dry-run (default)
 *   node scripts/phone-bounce-setup.mjs apply --execute           # create/update the trunk
 *   echo "$PW" | node scripts/phone-bounce-setup.mjs apply --execute   # pass endpoint pw on stdin
 *   node scripts/phone-bounce-setup.mjs verify                    # list trunk, assert mapping
 */

// ── constants ─────────────────────────────────────────────────────────

/** The Plivo voice-app SIP address the bounce trunk points at. */
export const PLIVO_SIP_ADDRESS = 'phone.plivo.com';

/** The attribute→header mapping that carries the correlation id to Plivo. */
export const BOUNCE_ATTRIBUTE = 'xhelloattempt';
export const BOUNCE_HEADER = 'X-PH-HELLO-ATTEMPT';

/** The default trunk name (a non-secret identifier). */
export const BOUNCE_TRUNK_NAME = 'phone-bounce-plivo';

export const MODES = Object.freeze(['plan', 'apply', 'verify']);

/** Flags that would put a secret in argv. Refused, with a reason. */
const SECRET_FLAGS = Object.freeze([
  '--auth-password',
  '--api-secret',
  '--endpoint-password',
  '--password',
  '--token',
]);

export class SetupRefusal extends Error {
  constructor(code, hint) {
    super(hint === undefined ? code : `${code}: ${hint}`);
    this.name = 'SetupRefusal';
    this.code = code;
  }
}

// ── argument parsing (pure, exported for tests) ───────────────────────

export function parseArgs(argv) {
  const args = { mode: undefined, execute: false, dryRun: false };
  for (const token of argv) {
    if (SECRET_FLAGS.includes(token) || SECRET_FLAGS.some((f) => token.startsWith(`${f}=`))) {
      throw new SetupRefusal(
        'secret_in_argv',
        'credentials must arrive in the environment or on stdin, never in argv',
      );
    }
    if (token === '--execute') {
      args.execute = true;
    } else if (token === '--dry-run') {
      args.dryRun = true;
    } else if (token.startsWith('--')) {
      throw new SetupRefusal('unknown_flag', token);
    } else if (args.mode === undefined) {
      if (!MODES.includes(token)) throw new SetupRefusal('unknown_mode', token);
      args.mode = token;
    } else {
      throw new SetupRefusal('unexpected_argument', token);
    }
  }
  if (args.mode === undefined) args.mode = 'plan';
  // `apply` mutates, and mutation requires `--execute`. `--dry-run` forces the
  // no-op even if `--execute` is also present (belt-and-braces: a dry run is a
  // dry run).
  const willMutate = args.mode === 'apply' && args.execute && !args.dryRun;
  return { ...args, willMutate };
}

// ── config from environment (never argv) ──────────────────────────────

function requiredEnv(source, name) {
  const value = typeof source[name] === 'string' ? source[name].trim() : '';
  if (value === '') throw new SetupRefusal('missing_env', name);
  return value;
}

function optionalEnv(source, name) {
  return typeof source[name] === 'string' ? source[name].trim() : '';
}

/** Read a single-line secret from stdin, if any is piped. Never echoed. */
async function readStdinSecret() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').split('\n')[0].trim();
}

// ── the LiveKit trunk operations ──────────────────────────────────────

/**
 * Build the desired outbound-trunk info. Pure and exported so a test asserts
 * the shape — chiefly that `attributesToHeaders` maps our attribute to the SIP
 * header, which is the one field the incident depends on.
 */
export function desiredTrunkInfo(protocol, cfg) {
  const { SIPOutboundTrunkInfo, SIPTransport } = protocol;
  return new SIPOutboundTrunkInfo({
    name: BOUNCE_TRUNK_NAME,
    address: PLIVO_SIP_ADDRESS,
    // UDP, per the runbook: the Plivo voice-app SIP endpoint speaks UDP.
    transport: SIPTransport.SIP_TRANSPORT_UDP,
    numbers: cfg.callerId === '' ? [] : [cfg.callerId],
    authUsername: cfg.endpointUsername,
    authPassword: cfg.endpointPassword,
    // THE LOAD-BEARING MAPPING. Our `xhelloattempt` participant attribute is
    // emitted as the SIP header Plivo forwards to the answer callback.
    attributesToHeaders: { [BOUNCE_ATTRIBUTE]: BOUNCE_HEADER },
  });
}

/** True iff the trunk's attributesToHeaders carries our exact mapping. */
export function mappingHolds(trunk) {
  const map = trunk?.attributesToHeaders;
  return !!map && map[BOUNCE_ATTRIBUTE] === BOUNCE_HEADER;
}

// ── the printed Plivo console steps (never executed) ──────────────────

export function plivoConsoleSteps(cfg) {
  return [
    'MANUAL PLIVO CONSOLE STEPS (this script executes none of them):',
    '  1. Create a Plivo Voice Application with these webhook URLs:',
    `       Answer URL      (POST): ${cfg.answerUrl || '<set PLIVO_ANSWER_URL>'}`,
    `       Hangup URL      (POST): ${cfg.hangupUrl || '<set PLIVO_HANGUP_URL>'}`,
    `       (Dial action URL is returned in the answer XML: ${cfg.dialStatusUrl || '<set PLIVO_DIAL_STATUS_URL>'})`,
    '  2. Create a Plivo SIP Endpoint attached to that Application:',
    `       Username: ${cfg.endpointUsername || '<set PLIVO_BOUNCE_ENDPOINT_USERNAME>'}`,
    '       Password: <the endpoint password you provisioned; NOT printed here>',
    `  3. Confirm PHONE_BOUNCE_SIP_USER matches the endpoint username (${cfg.sipUser || '<unset>'}).`,
    '  4. Enable bounce mode on the API (PHONE_BOUNCE_MODE=true) only after the trunk verifies.',
  ];
}

// ── main ──────────────────────────────────────────────────────────────

function loadConfig(source) {
  return {
    url: optionalEnv(source, 'LIVEKIT_URL'),
    apiKey: optionalEnv(source, 'LIVEKIT_API_KEY'),
    apiSecret: optionalEnv(source, 'LIVEKIT_API_SECRET'),
    bounceTrunkId: optionalEnv(source, 'PHONE_BOUNCE_TRUNK_ID'),
    sipUser: optionalEnv(source, 'PHONE_BOUNCE_SIP_USER'),
    callerId: optionalEnv(source, 'PHONE_BOUNCE_CALLER_ID'),
    endpointUsername: optionalEnv(source, 'PLIVO_BOUNCE_ENDPOINT_USERNAME'),
    endpointPassword: optionalEnv(source, 'PLIVO_BOUNCE_ENDPOINT_PASSWORD'),
    answerUrl: optionalEnv(source, 'PLIVO_ANSWER_URL'),
    dialStatusUrl: optionalEnv(source, 'PLIVO_DIAL_STATUS_URL'),
    hangupUrl: optionalEnv(source, 'PLIVO_HANGUP_URL'),
  };
}

async function run(argv, { source = process.env, log = console.log } = {}) {
  const args = parseArgs(argv);
  const cfg = loadConfig(source);

  log(`mode=${args.mode} execute=${args.execute} will_mutate=${args.willMutate}`);

  if (args.mode === 'plan') {
    log('plan: would create/update the LiveKit bounce outbound trunk:');
    log(`  name=${BOUNCE_TRUNK_NAME} address=${PLIVO_SIP_ADDRESS} transport=udp`);
    log(`  numbers=[${cfg.callerId ? 'caller-id' : 'none'}] attributesToHeaders={${BOUNCE_ATTRIBUTE}:${BOUNCE_HEADER}}`);
    log(`  auth_username_configured=${cfg.endpointUsername !== ''}`);
    for (const line of plivoConsoleSteps(cfg)) log(line);
    log('plan: no changes made (add `apply --execute` to act).');
    return 0;
  }

  // Both apply and verify need to reach LiveKit.
  requiredEnv(source, 'LIVEKIT_URL');
  requiredEnv(source, 'LIVEKIT_API_KEY');
  requiredEnv(source, 'LIVEKIT_API_SECRET');
  const { SipClient } = await import('livekit-server-sdk');
  const protocol = await import('@livekit/protocol');
  const client = new SipClient(cfg.url, cfg.apiKey, cfg.apiSecret);

  if (args.mode === 'verify') {
    const trunks = await client.listSipOutboundTrunk();
    const target = trunks.find(
      (t) => (cfg.bounceTrunkId && t.sipTrunkId === cfg.bounceTrunkId) || t.name === BOUNCE_TRUNK_NAME,
    );
    if (!target) {
      log('verify: FAIL — no bounce trunk found (checked by id and by name).');
      return 1;
    }
    const ok = mappingHolds(target);
    log(`verify: trunk_found=true address_ok=${target.address === PLIVO_SIP_ADDRESS} mapping_ok=${ok}`);
    log(`verify: attribute=${BOUNCE_ATTRIBUTE} header=${BOUNCE_HEADER}`);
    return ok && target.address === PLIVO_SIP_ADDRESS ? 0 : 1;
  }

  // apply
  const endpointPassword = cfg.endpointPassword || (await readStdinSecret());
  const endpointUsername = requiredEnv(source, 'PLIVO_BOUNCE_ENDPOINT_USERNAME');
  if (endpointPassword === '') {
    throw new SetupRefusal(
      'missing_endpoint_password',
      'supply PLIVO_BOUNCE_ENDPOINT_PASSWORD or pipe it on stdin',
    );
  }
  if (!args.willMutate) {
    log('apply: DRY RUN (no --execute) — would create/update the trunk and set the mapping.');
    for (const line of plivoConsoleSteps({ ...cfg, endpointUsername })) log(line);
    return 0;
  }

  const applyCfg = { ...cfg, endpointUsername, endpointPassword };
  // Create the base trunk (name/address/numbers/auth), then REPLACE it with the
  // full desired info so `attributesToHeaders` is set — the convenience create
  // does not carry that field. If a trunk of this name already exists, the
  // create errors and we fall back to updating the configured id.
  let trunkId = cfg.bounceTrunkId;
  try {
    const created = await client.createSipOutboundTrunk(
      BOUNCE_TRUNK_NAME,
      PLIVO_SIP_ADDRESS,
      applyCfg.callerId === '' ? [] : [applyCfg.callerId],
      {
        transport: protocol.SIPTransport.SIP_TRANSPORT_UDP,
        authUsername: endpointUsername,
        authPassword: endpointPassword,
      },
    );
    trunkId = created.sipTrunkId;
    log('apply: created base trunk.');
  } catch {
    if (trunkId === '') {
      throw new SetupRefusal(
        'create_failed_no_id',
        'create failed and PHONE_BOUNCE_TRUNK_ID is unset, so there is nothing to update',
      );
    }
    log('apply: base trunk exists; updating the configured id.');
  }
  await client.updateSipOutboundTrunk(trunkId, desiredTrunkInfo(protocol, applyCfg));
  const after = (await client.listSipOutboundTrunk()).find((t) => t.sipTrunkId === trunkId);
  const ok = mappingHolds(after);
  log(`apply: mapping_ok=${ok} (set PHONE_BOUNCE_TRUNK_ID to this trunk's id if not already).`);
  for (const line of plivoConsoleSteps(applyCfg)) log(line);
  return ok ? 0 : 1;
}

// Only run when invoked directly, so the tests can import the pure helpers.
import { fileURLToPath } from 'node:url';
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      // Print the stable code only — never a credential or a stack that could
      // quote one.
      console.error(err instanceof SetupRefusal ? err.message : 'setup_error');
      process.exit(2);
    });
}

export { run, loadConfig };
