#!/usr/bin/env node

/**
 * phone-bounce-setup.test.mjs — the OFFLINE half of the bounce-setup tool.
 *
 * No LiveKit, no network. Exercises the pure helpers: the argument state
 * machine (default no-op, secret-in-argv refusal, mutation gate), the desired
 * trunk info's attribute→header mapping (the field the incident depends on),
 * and that the printed console steps never carry the endpoint password.
 *
 * Run: node scripts/phone-bounce-setup.test.mjs   (exit 0 = pass, 1 = fail)
 */

import {
  parseArgs,
  desiredTrunkInfo,
  mappingHolds,
  plivoConsoleSteps,
  BOUNCE_ATTRIBUTE,
  BOUNCE_HEADER,
  PLIVO_SIP_ADDRESS,
  SetupRefusal,
} from './phone-bounce-setup.mjs';

let passed = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) passed += 1;
  else failures.push({ name, detail });
}
function throws(name, fn, code) {
  try {
    fn();
    failures.push({ name, detail: 'did not throw' });
  } catch (err) {
    ok(name, err instanceof SetupRefusal && err.code === code, `got ${err.code ?? err.message}`);
  }
}

// ── argument state machine ────────────────────────────────────────────
ok('DEFAULT_MODE_IS_PLAN', parseArgs([]).mode === 'plan');
ok('PLAN_NEVER_MUTATES', parseArgs(['plan']).willMutate === false);
ok('APPLY_WITHOUT_EXECUTE_IS_A_NOOP', parseArgs(['apply']).willMutate === false);
ok('APPLY_EXECUTE_MUTATES', parseArgs(['apply', '--execute']).willMutate === true);
ok('DRY_RUN_FORCES_NOOP_EVEN_WITH_EXECUTE',
  parseArgs(['apply', '--execute', '--dry-run']).willMutate === false);
throws('SECRET_IN_ARGV_REFUSED', () => parseArgs(['apply', '--api-secret=x']), 'secret_in_argv');
throws('SECRET_FLAG_BARE_REFUSED', () => parseArgs(['apply', '--auth-password']), 'secret_in_argv');
throws('UNKNOWN_MODE_REFUSED', () => parseArgs(['frobnicate']), 'unknown_mode');
throws('UNKNOWN_FLAG_REFUSED', () => parseArgs(['plan', '--wat']), 'unknown_flag');

// ── the trunk info carries the load-bearing mapping ───────────────────
// A tiny protocol stub, shaped like @livekit/protocol's constructors.
const protocolStub = {
  SIPOutboundTrunkInfo: class {
    constructor(fields) {
      Object.assign(this, fields);
    }
  },
  SIPTransport: { SIP_TRANSPORT_UDP: 'udp' },
};
const info = desiredTrunkInfo(protocolStub, {
  callerId: '+919800000001',
  endpointUsername: 'hello_bounce',
  endpointPassword: 'secret-pw',
});
ok('TRUNK_ADDRESS_IS_PLIVO', info.address === PLIVO_SIP_ADDRESS);
ok('TRUNK_TRANSPORT_IS_UDP', info.transport === 'udp');
ok('TRUNK_MAPS_ATTRIBUTE_TO_HEADER',
  info.attributesToHeaders[BOUNCE_ATTRIBUTE] === BOUNCE_HEADER);
ok('MAPPING_HOLDS_TRUE', mappingHolds(info) === true);
ok('MAPPING_HOLDS_FALSE_WHEN_WRONG',
  mappingHolds({ attributesToHeaders: { [BOUNCE_ATTRIBUTE]: 'X-WRONG' } }) === false);
ok('MAPPING_HOLDS_FALSE_WHEN_ABSENT', mappingHolds({}) === false);

// ── the printed console steps never carry the endpoint password ───────
const steps = plivoConsoleSteps({
  answerUrl: 'https://x/answer',
  dialStatusUrl: 'https://x/dial-status',
  hangupUrl: 'https://x/hangup',
  endpointUsername: 'hello_bounce',
  sipUser: 'hello_bounce',
}).join('\n');
ok('STEPS_MENTION_ANSWER_URL', steps.includes('https://x/answer'));
ok('STEPS_NEVER_PRINT_A_PASSWORD', !/secret-pw/.test(steps) && /NOT printed/.test(steps));

// ══════════════════════════════════════════════════════════════════════

console.log('');
if (failures.length > 0) {
  console.log(`phone-bounce-setup offline: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.log(`  - ${f.name}: ${f.detail ?? ''}`);
  process.exitCode = 1;
} else {
  console.log(`phone-bounce-setup offline: ${passed} passed, 0 failed`);
}
