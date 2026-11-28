/**
 * M035 S05 T2: the manage-link token of a public booking (lib/r1/meet/public/manage-token.ts).
 *
 * Pinned here: the token is 32 fresh random bytes as 43 base64url characters; the digest is the hex
 * HMAC in the `hello:r1:meet-manage:v1` domain under HMAC(WORKER_CONTEXT_SECRET, domain), recomputed
 * independently below, and never equals the bridge-ticket digest of the same text; nothing is
 * minted or digested without a key or from a misbehaving random source; and the link helper turns
 * the canonical bridge page URL into `https://<origin>/book/manage#m=<token>`, refusing anything
 * else.
 *
 * Fixtures are low entropy and built at run time (no realistic secret or token literal).
 */

import { describe, expect, it, vi } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { R1_MEET_PUBLIC_MANAGE_PAGE_PATH } from '../lib/r1/meet/config.js';
import {
  R1_MEET_MANAGE_DOMAIN,
  R1_MEET_MANAGE_TOKEN_BYTES,
  R1_MEET_MANAGE_TOKEN_PATTERN,
  mintR1MeetManageToken,
  r1MeetManageTokenDigest,
  r1MeetPublicManageLink,
} from '../lib/r1/meet/public/manage-token.js';
import { R1_MEET_TICKET_DOMAIN, r1MeetDerivedKey, r1MeetTicketDigest } from '../lib/r1/meet/ticket.js';
import { BRIDGE_PAGE_URL, BRIDGE_SOURCE } from './support/r1-meet-harness.js';

/** The worker secret, built at run time like the harness BRIDGE_SOURCE. */
const SECRET = 'w'.repeat(40);
const SRC = { WORKER_CONTEXT_SECRET: SECRET } as NodeJS.ProcessEnv;
/** A token-shaped value (43 characters), built at run time. */
const TOKEN = ['m', 'x'.repeat(42)].join('');

const hmacHex = (key: Buffer | string, text: string): string => createHmac('sha256', key).update(text).digest('hex');
const domainKey = (domain: string): Buffer => createHmac('sha256', SECRET).update(domain).digest();

describe('mintR1MeetManageToken: fresh random tokens', () => {
  it('mints 43-character base64url tokens of 32 bytes, frozen, with their digest', () => {
    const minted = mintR1MeetManageToken({ source: SRC })!;
    expect(minted).not.toBeNull();
    expect(R1_MEET_MANAGE_TOKEN_BYTES).toBe(32);
    expect(minted.token).toHaveLength(43);
    expect(minted.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(R1_MEET_MANAGE_TOKEN_PATTERN.test(minted.token)).toBe(true);
    expect(Buffer.from(minted.token, 'base64url')).toHaveLength(R1_MEET_MANAGE_TOKEN_BYTES);
    expect(Object.keys(minted).sort()).toEqual(['digest', 'token']);
    expect(Object.isFrozen(minted)).toBe(true);
    expect(minted.digest).toBe(r1MeetManageTokenDigest(minted.token, SRC));
    // The 0143 CHECK on r1_meet_bookings.manage_token_digest.
    expect(minted.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(minted.digest).not.toContain(minted.token);
  });

  it('never repeats: 200 mints give 200 distinct tokens and 200 distinct digests', () => {
    const tokens = new Set<string>();
    const digests = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const minted = mintR1MeetManageToken({ source: SRC })!;
      tokens.add(minted.token);
      digests.add(minted.digest);
    }
    expect(tokens.size).toBe(200);
    expect(digests.size).toBe(200);
  });

  it('uses the injected random source (asked for exactly 32 bytes), so the token is deterministic', () => {
    const random = vi.fn((bytes: number) => Buffer.alloc(bytes, 7));
    const a = mintR1MeetManageToken({ random, source: SRC })!;
    const b = mintR1MeetManageToken({ random, source: SRC })!;
    expect(random).toHaveBeenCalledTimes(2);
    expect(random).toHaveBeenCalledWith(32);
    expect(a.token).toBe(Buffer.alloc(32, 7).toString('base64url'));
    expect(a).toEqual(b);
  });

  it('mints with the harness worker secret too (the flows pass R1MeetFlowDeps.ticketSource)', () => {
    const minted = mintR1MeetManageToken({ source: BRIDGE_SOURCE })!;
    expect(minted.digest).toBe(r1MeetManageTokenDigest(minted.token, SRC));
  });

  it('mints nothing without a key (spending no randomness), or when the random source misbehaves', () => {
    const random = vi.fn((bytes: number) => Buffer.alloc(bytes, 1));
    for (const env of [{}, { WORKER_CONTEXT_SECRET: '' }, { WORKER_CONTEXT_SECRET: 'w'.repeat(31) }] as NodeJS.ProcessEnv[]) {
      expect(mintR1MeetManageToken({ random, source: env })).toBeNull();
    }
    expect(random).not.toHaveBeenCalled();
    expect(mintR1MeetManageToken({ random: () => Buffer.alloc(31, 1), source: SRC })).toBeNull();
    expect(mintR1MeetManageToken({ random: () => Buffer.alloc(33, 1), source: SRC })).toBeNull();
    expect(mintR1MeetManageToken({ random: () => Buffer.alloc(0), source: SRC })).toBeNull();
    expect(mintR1MeetManageToken({ random: () => 'x'.repeat(32) as unknown as Buffer, source: SRC })).toBeNull();
    expect(mintR1MeetManageToken({ random: () => new Uint8Array(32) as unknown as Buffer, source: SRC })).toBeNull();
    expect(
      mintR1MeetManageToken({
        random: () => {
          throw new Error('entropy_unavailable');
        },
        source: SRC,
      }),
    ).toBeNull();
    // The minimum secret length is a key source.
    expect(mintR1MeetManageToken({ source: { WORKER_CONTEXT_SECRET: 'w'.repeat(32) } as NodeJS.ProcessEnv })).not.toBeNull();
  });
});

describe('r1MeetManageTokenDigest: its own HMAC domain', () => {
  it('equals HMAC(HMAC(secret, "hello:r1:meet-manage:v1"), token), recomputed here, as 64 lowercase hex', () => {
    expect(R1_MEET_MANAGE_DOMAIN).toBe('hello:r1:meet-manage:v1');
    const derived = r1MeetDerivedKey(R1_MEET_MANAGE_DOMAIN, SRC);
    expect(derived).toEqual(domainKey('hello:r1:meet-manage:v1'));
    const digest = r1MeetManageTokenDigest(TOKEN, SRC);
    expect(digest).toBe(createHmac('sha256', derived!).update(TOKEN).digest('hex'));
    expect(digest).toBe(hmacHex(domainKey('hello:r1:meet-manage:v1'), TOKEN));
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('differs from the bridge-ticket digest of the same text, a plain SHA-256 and the raw-secret MAC', () => {
    const digest = r1MeetManageTokenDigest(TOKEN, SRC)!;
    expect(R1_MEET_TICKET_DOMAIN).not.toBe(R1_MEET_MANAGE_DOMAIN);
    // A manage token is ticket-shaped too, so the ticket digest exists and must differ.
    const ticketDigest = r1MeetTicketDigest(TOKEN, SRC);
    expect(ticketDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(digest).not.toBe(ticketDigest);
    expect(digest).not.toBe(createHash('sha256').update(TOKEN).digest('hex'));
    expect(digest).not.toBe(hmacHex(SECRET, TOKEN));
    expect(digest).not.toBe(hmacHex(domainKey('hello:r1:meet-resume:v1'), TOKEN));
    expect(digest).not.toContain(TOKEN);
  });

  it('depends on the secret, and is null with no or a short secret', () => {
    const other = { WORKER_CONTEXT_SECRET: 'v'.repeat(40) } as NodeJS.ProcessEnv;
    expect(r1MeetManageTokenDigest(TOKEN, other)).not.toBe(r1MeetManageTokenDigest(TOKEN, SRC));
    for (const env of [{}, { WORKER_CONTEXT_SECRET: '' }, { WORKER_CONTEXT_SECRET: 'w'.repeat(31) }] as NodeJS.ProcessEnv[]) {
      expect(r1MeetManageTokenDigest(TOKEN, env)).toBeNull();
    }
  });

  it('digests only a token-shaped value: exactly 43 base64url characters', () => {
    for (const bad of [
      'x'.repeat(42),
      'x'.repeat(44),
      'x'.repeat(32),
      'x'.repeat(128),
      `${'x'.repeat(42)}=`,
      `${'x'.repeat(42)}+`,
      `${'x'.repeat(42)}/`,
      `${'x'.repeat(42)}#`,
      `${'x'.repeat(41)} x`,
      `${'x'.repeat(42)}\n`,
      '',
    ]) {
      expect(r1MeetManageTokenDigest(bad, SRC), JSON.stringify(bad)).toBeNull();
    }
    for (const bad of [undefined, null, 42, { token: TOKEN }, [TOKEN]]) {
      expect(r1MeetManageTokenDigest(bad as unknown as string, SRC)).toBeNull();
    }
    expect(r1MeetManageTokenDigest(`${'A'.repeat(20)}_-${'9'.repeat(21)}`, SRC)).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('r1MeetPublicManageLink: the link in the invite', () => {
  it('turns the canonical bridge page URL into <origin>/book/manage#m=<token>', () => {
    expect(BRIDGE_PAGE_URL).toBe('https://hello.example.test/candidate/r1/meet');
    expect(R1_MEET_PUBLIC_MANAGE_PAGE_PATH).toBe('/book/manage');
    const minted = mintR1MeetManageToken({ source: SRC })!;
    const link = r1MeetPublicManageLink(BRIDGE_PAGE_URL, minted.token)!;
    expect(link).toBe(`https://hello.example.test/book/manage#m=${minted.token}`);
    const url = new URL(link);
    expect(url.origin).toBe('https://hello.example.test');
    expect(url.pathname).toBe(R1_MEET_PUBLIC_MANAGE_PAGE_PATH);
    expect(url.search).toBe('');
    expect(url.hash).toBe(`#m=${minted.token}`);
    expect(r1MeetPublicManageLink(BRIDGE_PAGE_URL, TOKEN)).toBe(`https://hello.example.test/book/manage#m=${TOKEN}`);
  });

  it('keeps a non-default port (a different origin, and still the canonical spelling)', () => {
    expect(r1MeetPublicManageLink('https://hello.example.test:8443/candidate/r1/meet', TOKEN)).toBe(
      `https://hello.example.test:8443/book/manage#m=${TOKEN}`,
    );
  });

  it('refuses a non-canonical bridge page URL: http, a query, a fragment, another path, userinfo, a port spelling', () => {
    const refusedPages = [
      'http://hello.example.test/candidate/r1/meet',
      'https://hello.example.test/candidate/r1/meet?x=1',
      'https://hello.example.test/candidate/r1/meet?',
      'https://hello.example.test/candidate/r1/meet#t=old',
      'https://hello.example.test/candidate/r1/meet#',
      'https://hello.example.test/candidate/r1',
      'https://hello.example.test/candidate/r1/meet/',
      'https://hello.example.test/candidate/r1/meeting',
      'https://hello.example.test/book/manage',
      'https://hello.example.test/',
      'https://hello.example.test',
      'https://user:pw@hello.example.test/candidate/r1/meet',
      'https://hello.example.test:443/candidate/r1/meet',
      'https://HELLO.example.test/candidate/r1/meet',
      ' https://hello.example.test/candidate/r1/meet',
      'not a url',
      '',
    ];
    for (const page of refusedPages) expect(r1MeetPublicManageLink(page, TOKEN), page).toBeNull();
    expect(r1MeetPublicManageLink(undefined as unknown as string, TOKEN)).toBeNull();
    expect(r1MeetPublicManageLink(null as unknown as string, TOKEN)).toBeNull();
  });

  it('refuses a value that is not token-shaped', () => {
    for (const token of [
      'x'.repeat(42),
      'x'.repeat(44),
      'x'.repeat(32),
      `${'x'.repeat(42)}#`,
      `${'x'.repeat(42)}&`,
      `${'x'.repeat(42)}=`,
      `${'x'.repeat(41)} x`,
      '',
    ]) {
      expect(r1MeetPublicManageLink(BRIDGE_PAGE_URL, token), token).toBeNull();
    }
    expect(r1MeetPublicManageLink(BRIDGE_PAGE_URL, 42 as unknown as string)).toBeNull();
    expect(r1MeetPublicManageLink(BRIDGE_PAGE_URL, undefined as unknown as string)).toBeNull();
  });
});
