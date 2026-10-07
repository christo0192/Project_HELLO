/**
 * PR-L: LEGACY_BROWSER_SCREENING_ENABLED is interpreted lazily, never throws,
 * defaults to ENABLED, and fails CLOSED (retired) on a malformed value.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BROWSER_SCREENING_RETIRED,
  getLegacyBrowserScreeningConfig,
  legacyBrowserScreeningEnabled,
} from '../lib/legacy-browser-screening.js';

const ORIGINAL = process.env.LEGACY_BROWSER_SCREENING_ENABLED;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.LEGACY_BROWSER_SCREENING_ENABLED;
  else process.env.LEGACY_BROWSER_SCREENING_ENABLED = ORIGINAL;
  vi.restoreAllMocks();
});

describe('LEGACY_BROWSER_SCREENING_ENABLED', () => {
  it('exposes the stable machine code from the plan', () => {
    expect(BROWSER_SCREENING_RETIRED).toBe('browser_screening_retired');
  });

  it.each([undefined, '', 'true'])('keeps the lane ENABLED for %j', (raw) => {
    expect(getLegacyBrowserScreeningConfig(raw)).toEqual({ enabled: true, status: 'enabled' });
  });

  it('retires the lane only for the exact string "false"', () => {
    expect(getLegacyBrowserScreeningConfig('false')).toEqual({
      enabled: false,
      status: 'retired',
    });
  });

  it.each(['FALSE', 'False', '0', 'no', 'off', ' false', 'false ', 'ture', '1'])(
    'fails CLOSED (retired) for the malformed value %j and never throws',
    (raw) => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const config = getLegacyBrowserScreeningConfig(raw);
      expect(config.enabled).toBe(false);
      expect(config.status).toBe('invalid');
      expect(config.reason).toContain('LEGACY_BROWSER_SCREENING_ENABLED');
    },
  );

  it('does not echo the offending value into the log', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    getLegacyBrowserScreeningConfig('sekret-value-xyz');
    const logged = spy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(logged).not.toContain('sekret-value-xyz');
  });

  it('reads the live process environment at CALL time, not at import', () => {
    delete process.env.LEGACY_BROWSER_SCREENING_ENABLED;
    expect(legacyBrowserScreeningEnabled()).toBe(true);
    process.env.LEGACY_BROWSER_SCREENING_ENABLED = 'false';
    expect(legacyBrowserScreeningEnabled()).toBe(false);
    process.env.LEGACY_BROWSER_SCREENING_ENABLED = 'true';
    expect(legacyBrowserScreeningEnabled()).toBe(true);
  });
});
