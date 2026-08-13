/**
 * Ashby SSRF defense primitives — exhaustive adversarial negative controls.
 *
 * Covers the contract's required SSRF matrix at the pure-function layer:
 * localhost, private IPv4/IPv6, link-local (cloud metadata), CGNAT, ULA,
 * NAT64, IPv4-mapped/compatible IPv6, DNS-rebinding-style mixed answers,
 * userinfo/confusable/IP-literal hosts, non-HTTPS schemes, and disabled-by-
 * default allowlist fail-closed behavior. Reason codes are sanitized/stable.
 */

import { describe, it, expect } from 'vitest';
import {
  checkFetchUrl,
  isPublicAddress,
  assertPublicAddresses,
  parseIpv4,
  isIpLiteral,
  type UrlPolicy,
} from '../integrations/ashby/ssrf.js';

const APPROVED_HOST = 'files.ashby.example';

/** An "approved tenant" policy (allowlist enabled with one real host). */
const approved: UrlPolicy = {
  allowlistEnabled: true,
  allowedHosts: [APPROVED_HOST],
  allowedPorts: [443],
};

/** The DEFAULT policy: allowlist disabled → everything fails closed. */
const disabled: UrlPolicy = { allowlistEnabled: false, allowedHosts: [] };

describe('checkFetchUrl — allowlist is disabled by default (fail closed)', () => {
  it('refuses even a well-formed HTTPS URL when the allowlist is disabled', () => {
    const r = checkFetchUrl(`https://${APPROVED_HOST}/resume.pdf`, disabled);
    expect(r).toEqual({ ok: false, reason: 'allowlist_disabled' });
  });

  it('accepts an approved host only when the allowlist is enabled', () => {
    const r = checkFetchUrl(`https://${APPROVED_HOST}/a/b/resume.pdf?sig=x`, approved);
    expect(r).toEqual({ ok: true, host: APPROVED_HOST, port: 443 });
  });

  it('rejects a host that is not on the enabled allowlist', () => {
    const r = checkFetchUrl('https://evil.example/resume.pdf', approved);
    expect(r).toEqual({ ok: false, reason: 'host_not_allowlisted' });
  });
});

describe('checkFetchUrl — scheme / userinfo / port / host-literal', () => {
  it('rejects non-HTTPS schemes', () => {
    for (const url of [
      `http://${APPROVED_HOST}/r.pdf`,
      `file:///etc/passwd`,
      `gopher://${APPROVED_HOST}/`,
      `data:text/plain;base64,QQ==`,
      `ftp://${APPROVED_HOST}/r.pdf`,
    ]) {
      expect(checkFetchUrl(url, approved).ok).toBe(false);
    }
    expect(checkFetchUrl(`http://${APPROVED_HOST}/r.pdf`, approved)).toEqual({
      ok: false,
      reason: 'scheme_not_https',
    });
  });

  it('rejects embedded userinfo (confusable-host allowlist bypass)', () => {
    // `https://files.ashby.example@evil.example` — real host is evil.example.
    const r = checkFetchUrl(`https://${APPROVED_HOST}@evil.example/r.pdf`, approved);
    expect(r).toEqual({ ok: false, reason: 'userinfo_present' });
  });

  it('rejects user:pass@ credentials', () => {
    const r = checkFetchUrl(`https://user:pass@${APPROVED_HOST}/r.pdf`, approved);
    expect(r).toEqual({ ok: false, reason: 'userinfo_present' });
  });

  it('rejects a bare IPv4-literal host', () => {
    expect(checkFetchUrl('https://169.254.169.254/latest/meta-data/', approved)).toEqual({
      ok: false,
      reason: 'ip_literal_host',
    });
    expect(checkFetchUrl('https://127.0.0.1/r.pdf', approved)).toEqual({
      ok: false,
      reason: 'ip_literal_host',
    });
  });

  it('rejects a bracketed IPv6-literal host', () => {
    expect(checkFetchUrl('https://[::1]/r.pdf', approved).ok).toBe(false);
    expect(checkFetchUrl('https://[fd00::1]/r.pdf', approved).ok).toBe(false);
  });

  it('rejects a non-allowed port even for the approved host', () => {
    const r = checkFetchUrl(`https://${APPROVED_HOST}:8443/r.pdf`, approved);
    expect(r).toEqual({ ok: false, reason: 'port_not_allowed' });
  });

  it('rejects a malformed URL', () => {
    expect(checkFetchUrl('not a url', approved)).toEqual({ ok: false, reason: 'invalid_url' });
  });
});

describe('isPublicAddress — IPv4 classification', () => {
  const blockedV4 = [
    '0.0.0.0',
    '10.0.0.1',
    '10.255.255.255',
    '100.64.0.1', // CGNAT
    '100.127.255.255',
    '127.0.0.1', // loopback
    '169.254.169.254', // cloud metadata
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.1',
    '192.0.2.5', // TEST-NET-1
    '192.88.99.1',
    '192.168.1.1',
    '198.18.0.1', // benchmarking
    '198.51.100.9', // TEST-NET-2
    '203.0.113.9', // TEST-NET-3
    '224.0.0.1', // multicast
    '239.255.255.255',
    '240.0.0.1', // reserved
    '255.255.255.255', // broadcast
  ];
  it('blocks every private/reserved IPv4 range', () => {
    for (const ip of blockedV4) {
      expect(isPublicAddress(ip), `expected ${ip} blocked`).toBe(false);
    }
  });
  it('allows genuinely public IPv4 addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.0.1', '172.32.0.1', '100.63.255.255', '100.128.0.0']) {
      expect(isPublicAddress(ip), `expected ${ip} public`).toBe(true);
    }
  });
  it('rejects non-canonical / leading-zero octets', () => {
    expect(parseIpv4('010.0.0.1')).toBeNull();
    expect(parseIpv4('1.2.3.256')).toBeNull();
    expect(parseIpv4('1.2.3')).toBeNull();
    expect(parseIpv4('1.2.3.4.5')).toBeNull();
  });
});

describe('isPublicAddress — IPv6 classification', () => {
  const blockedV6 = [
    '::1', // loopback
    '::', // unspecified
    'fe80::1', // link-local
    'fe80::1%eth0', // scoped link-local
    'fc00::1', // ULA
    'fd12:3456:789a::1', // ULA
    'ff02::1', // multicast
    '::ffff:127.0.0.1', // IPv4-mapped loopback
    '::ffff:169.254.169.254', // IPv4-mapped metadata
    '::ffff:10.0.0.1', // IPv4-mapped private
    '64:ff9b::7f00:1', // NAT64 -> 127.0.0.1
    '64:ff9b::a00:1', // NAT64 -> 10.0.0.1
    '2001:db8::1', // documentation
  ];
  it('blocks loopback/link-local/ULA/multicast/mapped/NAT64/doc IPv6', () => {
    for (const ip of blockedV6) {
      expect(isPublicAddress(ip), `expected ${ip} blocked`).toBe(false);
    }
  });
  it('allows genuinely public IPv6 addresses', () => {
    for (const ip of ['2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8']) {
      expect(isPublicAddress(ip), `expected ${ip} public`).toBe(true);
    }
  });
  it('fails closed on garbage that is not a parseable address', () => {
    for (const s of ['', 'not-an-ip', 'zzzz::', '12345::', '1.2.3.4.5', ':::']) {
      expect(isPublicAddress(s)).toBe(false);
    }
  });
});

describe('assertPublicAddresses — DNS rebinding + empty resolution', () => {
  it('accepts when every resolved address is public', () => {
    expect(assertPublicAddresses(['8.8.8.8', '1.1.1.1'])).toEqual({ ok: true });
  });

  it('rejects the whole set if ANY address is private (rebinding poison)', () => {
    // A rebinding answer that mixes a decoy public IP with an internal target.
    expect(assertPublicAddresses(['93.184.216.34', '169.254.169.254'])).toEqual({
      ok: false,
      reason: 'blocked_address',
    });
    expect(assertPublicAddresses(['93.184.216.34', '::1'])).toEqual({
      ok: false,
      reason: 'blocked_address',
    });
  });

  it('rejects an empty / all-blank resolution as unresolvable', () => {
    expect(assertPublicAddresses([])).toEqual({ ok: false, reason: 'unresolvable_host' });
    expect(assertPublicAddresses(['', '   '])).toEqual({ ok: false, reason: 'unresolvable_host' });
  });
});

describe('isIpLiteral', () => {
  it('detects v4 and v6 literals, rejects hostnames', () => {
    expect(isIpLiteral('10.0.0.1')).toBe(true);
    expect(isIpLiteral('fd00::1')).toBe(true);
    expect(isIpLiteral('files.ashby.example')).toBe(false);
  });
});
