/**
 * The disabled-by-default configuration spine.
 *
 * The load-bearing property is not any individual default: it is that
 * IMPORTING this module, and loading it from an EMPTY environment, produces a
 * system that does nothing. So the suite drives an injected env map — never
 * `process.env` — and separately proves the import itself is inert.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  MAX_DIAL_ALLOWLIST_ENTRIES,
  PHONE_BOUNDS,
  PHONE_DIAL_MODES,
  describePhoneScreeningConfig,
  isDialAllowedForDigest,
  isLiveDialPermitted,
  isPhoneRuntimeActive,
  loadPhoneScreeningConfig,
  parseDialAllowlist,
  parseDialMode,
} from '../lib/phone-screening/config.js';

/**
 * A phone-SHAPED value that is NOT dialable: `+91` followed by a leading `0`,
 * which fails 0042's `^\\+91[6-9][0-9]{9}$` gate. India publishes no reserved
 * documentation range — there is no +1-555 equivalent — so a committed literal
 * must be one the substrate itself would refuse, never a plausible subscriber
 * number. A structural assertion keeps any dialable form out of this tree.
 */
const NON_DIALABLE = '+910000000000';

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

const CONFIG_SOURCE = readFileSync(
  fileURLToPath(new URL('../lib/phone-screening/config.ts', import.meta.url)),
  'utf8',
);

/**
 * P4 moved the TRANSPORT knobs into `livekit-phone-dial/config.ts`, because
 * the domain core carries a structural assertion that no file under it names
 * SIP or a trunk — and a `sipTrunkId` field there would have forced that
 * assertion to be weakened. So the env contract now spans TWO config files,
 * and this suite reads both: the invariant being protected is "every PHONE_*
 * variable is declared, exampled and actually READ SOMEWHERE", which is
 * exactly as strong across two files as across one, and would be silently
 * lost if this suite kept reading only the first.
 */
const DIAL_CONFIG_SOURCE = readFileSync(
  fileURLToPath(new URL('../integrations/livekit-phone-dial/config.ts', import.meta.url)),
  'utf8',
);

/**
 * THIRD config file, for the same reason as the second.
 *
 * P5's cadence knobs cannot live in `phone-screening/config.ts`: that module
 * is forbidden from importing a timer, a queue or a logger (enforced by
 * `phone-screening-structural`), and its config type is the DOMAIN's, not the
 * runtime's. So the seven `PHONE_RUNTIME_*` knobs are read where they are
 * used. The invariant this suite protects — every PHONE_* variable is
 * declared, exampled and actually READ SOMEWHERE — is exactly as strong
 * across three files as across one, and would be silently lost if the suite
 * kept reading only two.
 */
const RUNTIME_CONFIG_SOURCE = readFileSync(
  fileURLToPath(new URL('../lib/phone-runtime/config.ts', import.meta.url)),
  'utf8',
);

const ALL_CONFIG_SOURCE = `${CONFIG_SOURCE}\n${DIAL_CONFIG_SOURCE}\n${RUNTIME_CONFIG_SOURCE}`;

const SCHEMA = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../config/environment.schema.json', import.meta.url)), 'utf8'),
) as { components: { api: { variables: Record<string, unknown> } } };

const ENV_EXAMPLE = readFileSync(
  fileURLToPath(new URL('../../.env.example', import.meta.url)),
  'utf8',
);

describe('defaults: an empty environment does nothing', () => {
  it('every switch is off and the allowlist is empty', () => {
    const c = loadPhoneScreeningConfig({});
    expect(c.screeningEnabled).toBe(false);
    expect(c.runtimeEnabled).toBe(false);
    expect(c.dialMode).toBe('off');
    expect(c.dialAllowlist).toEqual([]);
    expect(isPhoneRuntimeActive(c)).toBe(false);
    expect(isLiveDialPermitted(c)).toBe(false);
  });

  it('numeric defaults are the documented ones', () => {
    const c = loadPhoneScreeningConfig({});
    expect(c.slotSeconds).toBe(1_800);
    expect(c.reconnectBackoffSeconds).toBe(120);
    expect(c.ringTimeoutSeconds).toBe(45);
    expect(c.leaseSeconds).toBe(60);
    expect(c.webhookMaxBytes).toBe(65_536);
    expect(c.webhookToleranceSeconds).toBe(300);
  });

  it('the slot bound stays inside 0042\'s 900-3600s appointment envelope', () => {
    expect(PHONE_BOUNDS.slotSeconds.min).toBeGreaterThanOrEqual(900);
    expect(PHONE_BOUNDS.slotSeconds.max).toBeLessThanOrEqual(3_600);
  });

  it('the lease bound stays inside the RPC\'s own [5,900] clamp', () => {
    expect(PHONE_BOUNDS.leaseSeconds.min).toBeGreaterThanOrEqual(5);
    expect(PHONE_BOUNDS.leaseSeconds.max).toBeLessThanOrEqual(900);
  });

  it('there is NO fleet daily cap knob — 0042 has nothing to enforce it', () => {
    // A value with no consumer is a decoration. The per-day control in 0042 is
    // `uq_phone_attempts_one_per_ist_day`, which is PER-ENGAGEMENT.
    expect(CONFIG_SOURCE).not.toContain('PHONE_MAX_DIALS_PER_IST_DAY');
    expect(ENV_EXAMPLE).not.toContain('PHONE_MAX_DIALS_PER_IST_DAY');
    expect(SCHEMA.components.api.variables).not.toHaveProperty('PHONE_MAX_DIALS_PER_IST_DAY');
  });

  it('the window and the cap are NOT configurable here', () => {
    // They live in the SQL helpers and are mirrored in `ist-window.ts`.
    for (const name of ['PHONE_WINDOW', 'PHONE_MAX_CONCURRENT', '09:00', '21:00']) {
      expect(CONFIG_SOURCE).not.toContain(name);
    }
  });
});

describe('the two switches are independent', () => {
  it('neither flag alone activates the runtime', () => {
    expect(isPhoneRuntimeActive(loadPhoneScreeningConfig({ PHONE_SCREENING_ENABLED: 'true' })))
      .toBe(false);
    expect(isPhoneRuntimeActive(loadPhoneScreeningConfig({ PHONE_RUNTIME_ENABLED: 'true' })))
      .toBe(false);
    expect(isPhoneRuntimeActive(loadPhoneScreeningConfig({
      PHONE_SCREENING_ENABLED: 'true', PHONE_RUNTIME_ENABLED: 'true',
    }))).toBe(true);
  });

  it('each flag reads independently of the other', () => {
    const c = loadPhoneScreeningConfig({ PHONE_RUNTIME_ENABLED: 'true' });
    expect(c.runtimeEnabled).toBe(true);
    expect(c.screeningEnabled).toBe(false);
  });

  it('only the exact string "true" enables; anything else is off', () => {
    for (const raw of ['TRUE', 'True', '1', 'yes', 'on', '', ' true', 'true ']) {
      expect(loadPhoneScreeningConfig({ PHONE_SCREENING_ENABLED: raw }).screeningEnabled)
        .toBe(false);
    }
  });
});

describe('dial mode', () => {
  it('resolves the three modes and reads anything else as off', () => {
    expect(PHONE_DIAL_MODES).toEqual(['off', 'synthetic', 'live']);
    expect(parseDialMode('synthetic')).toBe('synthetic');
    expect(parseDialMode(' LIVE ')).toBe('live');
    for (const raw of [undefined, '', 'production', 'real', 'liv', 'off ']) {
      expect(parseDialMode(raw as string | undefined)).toBe(raw === 'off ' ? 'off' : 'off');
    }
  });

  it('live dialing needs BOTH switches, live mode, AND a non-empty allowlist', () => {
    const base = {
      PHONE_SCREENING_ENABLED: 'true',
      PHONE_RUNTIME_ENABLED: 'true',
      PHONE_DIAL_MODE: 'live',
    };
    // Enabled and live, but the allowlist is empty: FAIL CLOSED.
    expect(isLiveDialPermitted(loadPhoneScreeningConfig(base))).toBe(false);
    const withList = loadPhoneScreeningConfig({ ...base, PHONE_DIAL_ALLOWLIST: DIGEST_A });
    expect(isLiveDialPermitted(withList)).toBe(true);
    expect(isDialAllowedForDigest(withList, DIGEST_A)).toBe(true);
    expect(isDialAllowedForDigest(withList, DIGEST_B)).toBe(false);
    // Synthetic never permits a live dial, however long the allowlist is.
    expect(isLiveDialPermitted(loadPhoneScreeningConfig({
      ...base, PHONE_DIAL_MODE: 'synthetic', PHONE_DIAL_ALLOWLIST: DIGEST_A,
    }))).toBe(false);
  });
});

describe('the allowlist holds DIGESTS, never numbers', () => {
  it('accepts only 64-char lowercase hex, and drops everything else', () => {
    expect(parseDialAllowlist(`${DIGEST_A},${DIGEST_B}`)).toEqual([DIGEST_A, DIGEST_B]);
    expect(parseDialAllowlist(` ${DIGEST_A.toUpperCase()} `)).toEqual([DIGEST_A]);
    // A raw number, a partial digest and a non-hex run are all DROPPED rather
    // than coerced, so a malformed entry can never widen the allowlist.
    expect(parseDialAllowlist(NON_DIALABLE)).toEqual([]);
    expect(parseDialAllowlist('a'.repeat(63))).toEqual([]);
    expect(parseDialAllowlist('a'.repeat(65))).toEqual([]);
    expect(parseDialAllowlist('z'.repeat(64))).toEqual([]);
    expect(parseDialAllowlist('')).toEqual([]);
    expect(parseDialAllowlist(undefined)).toEqual([]);
  });

  it('deduplicates and caps', () => {
    expect(parseDialAllowlist(`${DIGEST_A},${DIGEST_A}`)).toEqual([DIGEST_A]);
    const many = Array.from({ length: MAX_DIAL_ALLOWLIST_ENTRIES + 10 }, (_, i) =>
      i.toString(16).padStart(64, '0')).join(',');
    expect(parseDialAllowlist(many)).toHaveLength(MAX_DIAL_ALLOWLIST_ENTRIES);
  });

  it('a valid entry survives an invalid neighbour', () => {
    expect(parseDialAllowlist(`not-a-digest,${DIGEST_A},,${NON_DIALABLE}`)).toEqual([DIGEST_A]);
  });
});

describe('numeric knobs are clamped, never fatal', () => {
  const cases: Array<[keyof typeof PHONE_BOUNDS, string]> = [
    ['slotSeconds', 'PHONE_SLOT_SECONDS'],
    ['reconnectBackoffSeconds', 'PHONE_RECONNECT_BACKOFF_SECONDS'],
    ['ringTimeoutSeconds', 'PHONE_RING_TIMEOUT_SECONDS'],
    ['leaseSeconds', 'PHONE_LEASE_SECONDS'],
    ['webhookMaxBytes', 'PHONE_WEBHOOK_MAX_BYTES'],
    ['webhookToleranceSeconds', 'PHONE_WEBHOOK_TOLERANCE_SECONDS'],
  ];

  for (const [key, name] of cases) {
    it(`${name} clamps low, clamps high, and falls back on garbage`, () => {
      const bound = PHONE_BOUNDS[key];
      expect(loadPhoneScreeningConfig({ [name]: '0' })[key]).toBe(bound.min);
      expect(loadPhoneScreeningConfig({ [name]: String(bound.max + 1_000) })[key]).toBe(bound.max);
      expect(loadPhoneScreeningConfig({ [name]: String(bound.min) })[key]).toBe(bound.min);
      expect(loadPhoneScreeningConfig({ [name]: String(bound.max) })[key]).toBe(bound.max);
      for (const bad of ['', 'abc', '-5', '1.5', '1e3', ' ', '99999999999999999999']) {
        // A typo in an operator's environment must not take the API down.
        expect(() => loadPhoneScreeningConfig({ [name]: bad })).not.toThrow();
        expect(loadPhoneScreeningConfig({ [name]: bad })[key]).toBe(bound.def);
      }
    });
  }
});

describe('the health view leaks nothing', () => {
  it('reports a COUNT, never the allowlist contents', () => {
    const c = loadPhoneScreeningConfig({
      PHONE_SCREENING_ENABLED: 'true',
      PHONE_RUNTIME_ENABLED: 'true',
      PHONE_DIAL_MODE: 'live',
      PHONE_DIAL_ALLOWLIST: `${DIGEST_A},${DIGEST_B}`,
    });
    const described = describePhoneScreeningConfig(c);
    expect(described.dialAllowlistSize).toBe(2);
    const serialized = JSON.stringify(described);
    expect(serialized).not.toContain(DIGEST_A);
    expect(serialized).not.toContain(DIGEST_B);
    expect(described).toEqual({
      screeningEnabled: true,
      runtimeEnabled: true,
      runtimeActive: true,
      dialMode: 'live',
      dialAllowlistSize: 2,
      liveDialPermitted: true,
    });
  });
});

describe('importing the module does nothing at all', () => {
  it('opens no connection, arms no timer, and reads no ambient state', async () => {
    const timers = {
      setTimeout: vi.spyOn(globalThis, 'setTimeout'),
      setInterval: vi.spyOn(globalThis, 'setInterval'),
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('network access from a disabled module');
    });
    try {
      vi.resetModules();
      const mod = await import('../lib/phone-screening/index.js');
      expect(typeof mod.loadPhoneScreeningConfig).toBe('function');
      expect(timers.setTimeout).not.toHaveBeenCalled();
      expect(timers.setInterval).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      timers.setTimeout.mockRestore();
      timers.setInterval.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  it('the loader is a function of its argument, not of process.env', () => {
    const before = process.env.PHONE_SCREENING_ENABLED;
    try {
      process.env.PHONE_SCREENING_ENABLED = 'true';
      // An explicitly injected map wins; the ambient value is not consulted.
      expect(loadPhoneScreeningConfig({}).screeningEnabled).toBe(false);
    } finally {
      if (before === undefined) delete process.env.PHONE_SCREENING_ENABLED;
      else process.env.PHONE_SCREENING_ENABLED = before;
    }
  });
});

describe('the env contract holds in BOTH directions', () => {
  const NAMES = [
    'PHONE_SCREENING_ENABLED',
    'PHONE_RUNTIME_ENABLED',
    'PHONE_DIAL_MODE',
    'PHONE_DIAL_ALLOWLIST',
    'PHONE_SLOT_SECONDS',
    'PHONE_RECONNECT_BACKOFF_SECONDS',
    'PHONE_RING_TIMEOUT_SECONDS',
    'PHONE_LEASE_SECONDS',
    'PHONE_WEBHOOK_MAX_BYTES',
    'PHONE_WEBHOOK_TOLERANCE_SECONDS',
    // P4 transport knobs, read in `livekit-phone-dial/config.ts`.
    'PHONE_SIP_TRUNK_ID',
    'PHONE_AGENT_NAME',
    'PHONE_ORIGINATE_TIMEOUT_SECONDS',
    'PHONE_MAX_CALL_SECONDS',
    // P5 runtime cadence and batch knobs, read in `lib/phone-runtime/config.ts`.
    // Every one of them is a BOUND, not a switch: the two switches that decide
    // whether the loops run at all are PHONE_SCREENING_ENABLED and
    // PHONE_RUNTIME_ENABLED, both already above.
    'PHONE_RUNTIME_DUE_MS',
    'PHONE_RUNTIME_RECLAIM_MS',
    'PHONE_RUNTIME_RECONCILE_MS',
    'PHONE_RUNTIME_EXPIRE_MS',
    'PHONE_RUNTIME_DUE_LIMIT',
    'PHONE_RUNTIME_RECLAIM_LIMIT',
    'PHONE_RUNTIME_JOB_LEASE_SECONDS',
  ];

  it('every variable is declared, exampled, and read', () => {
    for (const name of NAMES) {
      expect(SCHEMA.components.api.variables).toHaveProperty(name);
      expect(ENV_EXAMPLE).toMatch(new RegExp(`^${name}=`, 'm'));
      // The contract checker greps for a literal `process.env.<NAME>`; the
      // functional reads go through the injectable `source` map. Both phone
      // config files are searched — see ALL_CONFIG_SOURCE above for why the
      // knobs live in two places.
      expect(ALL_CONFIG_SOURCE).toContain(`process.env.${name}`);
    }
  });

  it('no PHONE_* variable exists in one place and not the others', () => {
    const inSchema = Object.keys(SCHEMA.components.api.variables).filter((k) =>
      k.startsWith('PHONE_'));
    const inExample = [...ENV_EXAMPLE.matchAll(/^(PHONE_[A-Z0-9_]*)=/gm)].map((m) => m[1]);
    const inSource = [...ALL_CONFIG_SOURCE.matchAll(/process\.env\.(PHONE_[A-Z0-9_]*)/g)]
      .map((m) => m[1]);
    expect(new Set(inSchema)).toEqual(new Set(NAMES));
    expect(new Set(inExample)).toEqual(new Set(NAMES));
    expect(new Set(inSource)).toEqual(new Set(NAMES));
  });

  it('no PHONE_* variable is marked required in production', () => {
    // The whole domain is off by default; requiring any of these would make a
    // production boot depend on a subsystem that must stay dormant.
    for (const name of NAMES) {
      expect((SCHEMA.components.api.variables[name] as { requiredInProduction: boolean })
        .requiredInProduction).toBe(false);
    }
  });
});
