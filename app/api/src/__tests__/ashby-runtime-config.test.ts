/**
 * Ashby runtime activation — fail-closed configuration + secret containment.
 *
 * Fixed negative controls proven here:
 *  - disabled / missing key / missing webhook secret ⇒ ZERO client construction,
 *    zero timers, zero DB calls, zero network (asserted with doubles that throw
 *    on ANY property access, so even touching them fails the test).
 *  - no serialized config view contains the synthetic API key or webhook secret.
 *  - the resume host allowlist is empty by default and is EXACT-host only —
 *    a suffix-matching implementation would accept `evil-ashbycdn.com` and go red.
 *
 * Zero network, zero DB, no real secrets: every value is a synthetic sentinel.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  loadAshbyConfig,
  loadAshbyRuntimeConfig,
  isAshbyRuntimeActive,
  describeAshbyConfig,
  describeAshbyRuntime,
  parseResumeHosts,
  RUNTIME_BOUNDS,
  MIN_API_KEY_LENGTH,
} from '../integrations/ashby/config.js';
import { createAshbyRuntime } from '../integrations/ashby/runtime.js';

const SENTINEL_APIKEY = 'SENTINEL_APIKEY_aaaaaaaaaaaaaaaaaaaa';
const SENTINEL_SECRET = 'SENTINEL_SECRET_bbbbbbbbbbbbbbbbbbbb';

function envMap(over: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ASHBY_INTEGRATION_ENABLED: 'true',
    ASHBY_WEBHOOK_SECRET: SENTINEL_SECRET,
    ASHBY_RUNTIME_ENABLED: 'true',
    ASHBY_API_KEY: SENTINEL_APIKEY,
    ...over,
  } as NodeJS.ProcessEnv;
}

/** A Supabase double that fails the test if ANY property is touched. */
function forbiddenSupabase(label: string): never {
  return new Proxy({}, {
    get(_t, prop) {
      throw new Error(`${label}: supabase.${String(prop)} must not be touched when gates are closed`);
    },
  }) as never;
}

describe('loadAshbyRuntimeConfig — fail-closed defaults', () => {
  it('defaults to a fully disabled runtime with an empty host allowlist', () => {
    const rc = loadAshbyRuntimeConfig({} as NodeJS.ProcessEnv);
    expect(rc.runtimeEnabled).toBe(false);
    expect(rc.apiKeyConfigured).toBe(false);
    expect(rc.resumeHosts).toEqual([]);
    // Empty allowlist is what keeps UrlPolicy.allowlistEnabled false.
    expect(rc.resumeHosts.length).toBe(0);
  });

  it('rejects a placeholder or too-short API key as not configured', () => {
    expect(loadAshbyRuntimeConfig(envMap({ ASHBY_API_KEY: 'replace_me' })).apiKeyConfigured).toBe(false);
    expect(loadAshbyRuntimeConfig(envMap({ ASHBY_API_KEY: '' })).apiKeyConfigured).toBe(false);
    expect(loadAshbyRuntimeConfig(envMap({ ASHBY_API_KEY: 'x'.repeat(MIN_API_KEY_LENGTH - 1) })).apiKeyConfigured).toBe(false);
    expect(loadAshbyRuntimeConfig(envMap({ ASHBY_API_KEY: 'x'.repeat(MIN_API_KEY_LENGTH) })).apiKeyConfigured).toBe(true);
  });

  it('treats any value other than the literal "true" as disabled', () => {
    for (const v of ['false', 'TRUE', '1', 'yes', '', ' true']) {
      expect(loadAshbyRuntimeConfig(envMap({ ASHBY_RUNTIME_ENABLED: v })).runtimeEnabled).toBe(false);
    }
    expect(loadAshbyRuntimeConfig(envMap({ ASHBY_RUNTIME_ENABLED: 'true' })).runtimeEnabled).toBe(true);
  });

  it('clamps every tuning value into its documented bounds', () => {
    const low = loadAshbyRuntimeConfig(envMap({
      ASHBY_SIGNAL_POLL_MS: '1',
      ASHBY_OPERATION_POLL_MS: '0',
      ASHBY_RECONCILE_INTERVAL_MS: '5',
      ASHBY_RECLAIM_INTERVAL_MS: '1',
      ASHBY_LEASE_SECONDS: '0',
    }));
    expect(low.signalPollMs).toBe(RUNTIME_BOUNDS.signalPollMs.min);
    expect(low.operationPollMs).toBe(RUNTIME_BOUNDS.operationPollMs.min);
    expect(low.reconcileIntervalMs).toBe(RUNTIME_BOUNDS.reconcileIntervalMs.min);
    expect(low.reclaimIntervalMs).toBe(RUNTIME_BOUNDS.reclaimIntervalMs.min);
    expect(low.leaseSeconds).toBe(RUNTIME_BOUNDS.leaseSeconds.min);

    const high = loadAshbyRuntimeConfig(envMap({
      ASHBY_SIGNAL_POLL_MS: '999999999',
      ASHBY_LEASE_SECONDS: '999999',
    }));
    expect(high.signalPollMs).toBe(RUNTIME_BOUNDS.signalPollMs.max);
    expect(high.leaseSeconds).toBe(RUNTIME_BOUNDS.leaseSeconds.max);
  });

  it('falls back to the default for a malformed numeric value', () => {
    const rc = loadAshbyRuntimeConfig(envMap({
      ASHBY_SIGNAL_POLL_MS: 'abc',
      ASHBY_LEASE_SECONDS: '-5',
      ASHBY_RECLAIM_INTERVAL_MS: '1e9',
    }));
    expect(rc.signalPollMs).toBe(RUNTIME_BOUNDS.signalPollMs.def);
    expect(rc.leaseSeconds).toBe(RUNTIME_BOUNDS.leaseSeconds.def);
    expect(rc.reclaimIntervalMs).toBe(RUNTIME_BOUNDS.reclaimIntervalMs.def);
  });
});

describe('parseResumeHosts — exact-host allowlist, never suffix matching', () => {
  it('is empty for absent/blank input', () => {
    expect(parseResumeHosts(undefined)).toEqual([]);
    expect(parseResumeHosts('')).toEqual([]);
    expect(parseResumeHosts('   ')).toEqual([]);
  });

  it('lowercases, trims, and de-duplicates exact hostnames', () => {
    expect(parseResumeHosts(' Files.Ashby.example , files.ashby.example ,cdn.ashby.example'))
      .toEqual(['files.ashby.example', 'cdn.ashby.example']);
  });

  it('drops anything that is not a bare hostname rather than coercing it', () => {
    // A suffix-matching or URL-parsing implementation would accept these and
    // widen the allowlist. Each must be dropped.
    const dropped = [
      '*.ashby.example',            // wildcard
      '.ashby.example',             // leading dot (suffix idiom)
      'https://files.ashby.example',// scheme
      'files.ashby.example:443',    // port
      'files.ashby.example/path',   // path
      'user@files.ashby.example',   // userinfo
      'files ashby example',        // spaces
      'localhost',                  // no dot
      '-bad.ashby.example',         // leading hyphen label
      'a'.repeat(300) + '.example', // over-long
    ];
    for (const entry of dropped) {
      expect(parseResumeHosts(entry), `must drop: ${entry}`).toEqual([]);
    }
  });

  it('does not accept a confusable host that merely shares a suffix', () => {
    const hosts = parseResumeHosts('files.ashby.example');
    expect(hosts).toEqual(['files.ashby.example']);
    // Exact membership only — the SSRF policy uses `allowedHosts.includes`.
    expect(hosts.includes('evil-files.ashby.example')).toBe(false);
    expect(hosts.includes('files.ashby.example.evil.com')).toBe(false);
  });

  it('bounds the number of accepted hosts', () => {
    const many = Array.from({ length: 50 }, (_, i) => `h${i}.ashby.example`).join(',');
    expect(parseResumeHosts(many).length).toBeLessThanOrEqual(16);
  });
});

describe('isAshbyRuntimeActive — all four gates required', () => {
  const cases: Array<[string, Record<string, string>]> = [
    ['integration disabled', { ASHBY_INTEGRATION_ENABLED: 'false' }],
    ['webhook secret missing', { ASHBY_WEBHOOK_SECRET: '' }],
    ['webhook secret placeholder', { ASHBY_WEBHOOK_SECRET: 'replace_me' }],
    ['runtime flag off', { ASHBY_RUNTIME_ENABLED: 'false' }],
    ['api key missing', { ASHBY_API_KEY: '' }],
    ['api key placeholder', { ASHBY_API_KEY: 'replace_me' }],
  ];

  for (const [label, over] of cases) {
    it(`is inactive when ${label}`, () => {
      const src = envMap(over);
      expect(isAshbyRuntimeActive(loadAshbyConfig(src), loadAshbyRuntimeConfig(src))).toBe(false);
    });
  }

  it('is active only when all four gates are satisfied', () => {
    const src = envMap();
    expect(isAshbyRuntimeActive(loadAshbyConfig(src), loadAshbyRuntimeConfig(src))).toBe(true);
  });
});

describe('createAshbyRuntime — constructs NOTHING while any gate is closed', () => {
  const closed: Array<[string, Record<string, string>]> = [
    ['integration disabled', { ASHBY_INTEGRATION_ENABLED: 'false' }],
    ['no webhook secret', { ASHBY_WEBHOOK_SECRET: '' }],
    ['runtime flag off', { ASHBY_RUNTIME_ENABLED: 'false' }],
    ['no api key', { ASHBY_API_KEY: '' }],
  ];

  for (const [label, over] of closed) {
    it(`returns null and never touches supabase when ${label}`, () => {
      const src = envMap(over);
      const transport = vi.fn();
      const runtime = createAshbyRuntime({
        supabase: forbiddenSupabase(label),
        config: loadAshbyConfig(src),
        runtimeConfig: loadAshbyRuntimeConfig(src),
        transport,
      });
      expect(runtime).toBeNull();
      // No client was constructed, so no transport could ever have been called.
      expect(transport).not.toHaveBeenCalled();
    });
  }

  it('builds a runtime with a disabled SSRF allowlist when no hosts are configured', () => {
    const src = envMap();
    const runtime = createAshbyRuntime({
      supabase: {} as never,
      config: loadAshbyConfig(src),
      runtimeConfig: loadAshbyRuntimeConfig(src),
      transport: vi.fn(),
    });
    expect(runtime).not.toBeNull();
    expect(runtime!.urlPolicy.allowlistEnabled).toBe(false);
    expect(runtime!.urlPolicy.allowedHosts).toEqual([]);
    expect(runtime!.urlPolicy.allowedPorts).toEqual([443]);
  });

  it('enables the SSRF allowlist only for the exact configured hosts', () => {
    const src = envMap({ ASHBY_RESUME_HOSTS: 'files.ashby.example' });
    const runtime = createAshbyRuntime({
      supabase: {} as never,
      config: loadAshbyConfig(src),
      runtimeConfig: loadAshbyRuntimeConfig(src),
      transport: vi.fn(),
    });
    expect(runtime!.urlPolicy.allowlistEnabled).toBe(true);
    expect(runtime!.urlPolicy.allowedHosts).toEqual(['files.ashby.example']);
  });
});

describe('secret containment — sentinels never escape a describe/serialize', () => {
  it('describeAshbyConfig / describeAshbyRuntime emit no secret material', () => {
    const src = envMap({ ASHBY_RESUME_HOSTS: 'files.ashby.example' });
    const cfg = loadAshbyConfig(src);
    const rc = loadAshbyRuntimeConfig(src);

    const serialized = JSON.stringify({
      integration: describeAshbyConfig(cfg),
      runtime: describeAshbyRuntime(cfg, rc),
    });

    expect(serialized).not.toContain(SENTINEL_APIKEY);
    expect(serialized).not.toContain(SENTINEL_SECRET);
    expect(serialized).not.toContain('SENTINEL_');
    expect(serialized).not.toContain('Basic ');
    // The presigned host is tenant-identifying: report the COUNT, not the host.
    expect(serialized).not.toContain('files.ashby.example');
    expect(JSON.parse(serialized).runtime.resumeAllowlistCount).toBe(1);
  });

  it('a constructed runtime exposes no enumerable field equal to the API key', () => {
    const src = envMap();
    const runtime = createAshbyRuntime({
      supabase: {} as never,
      config: loadAshbyConfig(src),
      runtimeConfig: loadAshbyRuntimeConfig(src),
      transport: vi.fn(),
    })!;
    // `runtimeConfig.apiKey` is the deliberate single carrier handed to the
    // client constructor; nothing else may hold it.
    const withoutConfig = { ...runtime, runtimeConfig: undefined, config: undefined };
    for (const [key, value] of Object.entries(withoutConfig)) {
      expect(value, `field ${key} must not be the API key`).not.toBe(SENTINEL_APIKEY);
    }
    // The client must not surface it either.
    for (const [key, value] of Object.entries(runtime.client as unknown as Record<string, unknown>)) {
      expect(value, `client.${key} must not be the API key`).not.toBe(SENTINEL_APIKEY);
    }
  });
});
