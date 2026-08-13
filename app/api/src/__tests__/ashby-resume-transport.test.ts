/**
 * Ashby pinned-IP transport — pure helpers (status classification + the
 * rebinding-defense pinned lookup). The thin https.request wrapper runs only
 * when the integration is activated with an approved host.
 */

import { describe, it, expect } from 'vitest';
import { classifyStatus, pinnedLookup, createPinnedHttpsTransport } from '../integrations/ashby/resume-transport.js';

describe('classifyStatus', () => {
  it('maps 2xx/3xx/other to body/redirect/error', () => {
    expect(classifyStatus(200)).toBe('body');
    expect(classifyStatus(206)).toBe('body');
    expect(classifyStatus(301)).toBe('redirect');
    expect(classifyStatus(302)).toBe('redirect');
    expect(classifyStatus(404)).toBe('error');
    expect(classifyStatus(500)).toBe('error');
    expect(classifyStatus(0)).toBe('error');
  });
});

describe('pinnedLookup — forces the validated IP', () => {
  it('resolves any hostname to the pinned IPv4 with family 4', () => {
    const lookup = pinnedLookup('93.184.216.34');
    let seen: { addr: string; family: number } | null = null;
    lookup('files.ashby.example', {}, (_e, address, family) => {
      seen = { addr: address, family };
    });
    expect(seen).toEqual({ addr: '93.184.216.34', family: 4 });
  });

  it('resolves to a pinned IPv6 with family 6', () => {
    const lookup = pinnedLookup('2606:4700:4700::1111');
    let fam = 0;
    lookup('h', {}, (_e, _a, family) => { fam = family; });
    expect(fam).toBe(6);
  });

  it('errors on an invalid pinned IP', () => {
    const lookup = pinnedLookup('not-an-ip');
    let err: Error | null = null;
    lookup('h', {}, (e) => { err = e as Error; });
    expect(err).toBeInstanceOf(Error);
  });
});

describe('createPinnedHttpsTransport', () => {
  it('returns a callable transport and fails closed on an unparseable url / no pinned ip', async () => {
    const transport = createPinnedHttpsTransport();
    expect(typeof transport).toBe('function');
    expect(await transport({ url: 'not a url', pinnedIps: ['1.1.1.1'], timeoutMs: 10, maxBytes: 10 })).toEqual({ kind: 'error', status: 0 });
    expect(await transport({ url: 'https://h/x', pinnedIps: [], timeoutMs: 10, maxBytes: 10 })).toEqual({ kind: 'error', status: 0 });
  });
});
