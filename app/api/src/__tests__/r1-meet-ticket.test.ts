/**
 * M034 S05 T1: the Meet bridge ticket helper S06 arms with (lib/r1/meet/ticket.ts).
 *
 * Pinned here: the ticket is 32 fresh random bytes as 43 base64url characters; the digest is the
 * hex HMAC in the `hello:r1:meet-bridge:v1` domain under HMAC(WORKER_CONTEXT_SECRET, domain),
 * recomputed independently below, and is neither a plain SHA-256 nor any other R1 MAC; the claim
 * window opens at or before the bot's join time and stays inside the 0142 §16 bounds (read from
 * the migration); and the page URL helper refuses anything but `https://<origin>/candidate/r1/meet`.
 *
 * Fixtures are low entropy and built at runtime (no realistic secret or ticket literal).
 */

import { describe, expect, it, vi } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { R1_MEET_BRIDGE_PAGE_PATH } from '../lib/r1/meet/config.js';
import { R1_MEET_DEFAULT_PROFILE_ID, getR1MeetProfile } from '../lib/r1/meet/profiles.js';
import {
  R1_MEET_TICKET_BYTES,
  R1_MEET_TICKET_DOMAIN,
  R1_MEET_TICKET_LEAD_SEC,
  R1_MEET_TICKET_MAX_LEAD_SEC,
  R1_MEET_TICKET_MAX_TAIL_SEC,
  R1_MEET_TICKET_PATTERN,
  R1_MEET_TICKET_TAIL_SEC,
  mintR1MeetTicket,
  parseR1MeetInstant,
  r1MeetBridgeKeysConfigured,
  r1MeetBridgePageUrl,
  r1MeetDerivedKey,
  r1MeetTicketDigest,
  r1MeetTicketWindow,
} from '../lib/r1/meet/ticket.js';

const SECRET = 'w'.repeat(40);
const ENV = { WORKER_CONTEXT_SECRET: SECRET } as NodeJS.ProcessEnv;
const TICKET = 'mt' + 'k'.repeat(41);
const NOW = Date.parse('2030-01-01T09:00:00.000Z');
const START = '2030-01-01T10:00:00.000Z';
const END = '2030-01-01T10:40:00.000Z';
const START_MS = Date.parse(START);
const END_MS = Date.parse(END);
const PAGE = `https://hello.example.test${R1_MEET_BRIDGE_PAGE_PATH}`;

const hmacHex = (key: Buffer | string, text: string): string => createHmac('sha256', key).update(text).digest('hex');
const domainKey = (domain: string): Buffer => createHmac('sha256', SECRET).update(domain).digest();

function windowFor(botJoinLeadSec: number, over: Partial<{ startAt: string; endAt: string; nowMs: number }> = {}) {
  return r1MeetTicketWindow({ startAt: START, endAt: END, botJoinLeadSec, nowMs: NOW, ...over });
}

describe('mintR1MeetTicket: fresh random tickets', () => {
  it('mints 43-character base64url tickets that match the exported pattern', () => {
    const minted = mintR1MeetTicket({ startAt: START, endAt: END, botJoinLeadSec: 120, nowMs: NOW }, { source: ENV })!;
    expect(minted).not.toBeNull();
    expect(minted.ticket).toHaveLength(43);
    expect(minted.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(R1_MEET_TICKET_PATTERN.test(minted.ticket)).toBe(true);
    expect(Buffer.from(minted.ticket, 'base64url')).toHaveLength(R1_MEET_TICKET_BYTES);
    expect(Object.keys(minted).sort()).toEqual(['digest', 'expires_at', 'not_before', 'ticket']);
    expect(Object.isFrozen(minted)).toBe(true);
  });

  it('never repeats: 200 mints give 200 distinct tickets and 200 distinct digests', () => {
    const tickets = new Set<string>();
    const digests = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const minted = mintR1MeetTicket({ startAt: START, endAt: END, botJoinLeadSec: 120, nowMs: NOW }, { source: ENV })!;
      tickets.add(minted.ticket);
      digests.add(minted.digest);
    }
    expect(tickets.size).toBe(200);
    expect(digests.size).toBe(200);
  });

  it('uses the injected random source (asked for exactly 32 bytes), so the ticket is deterministic', () => {
    const random = vi.fn((bytes: number) => Buffer.alloc(bytes, 7));
    const input = { startAt: START, endAt: END, botJoinLeadSec: 120, nowMs: NOW };
    const a = mintR1MeetTicket(input, { random, source: ENV })!;
    const b = mintR1MeetTicket(input, { random, source: ENV })!;
    expect(random).toHaveBeenCalledTimes(2);
    expect(random).toHaveBeenCalledWith(32);
    expect(a.ticket).toBe(Buffer.alloc(32, 7).toString('base64url'));
    expect(a).toEqual(b);
    expect(a.digest).toBe(r1MeetTicketDigest(a.ticket, ENV));
    expect({ not_before: a.not_before, expires_at: a.expires_at }).toEqual(windowFor(120));
  });

  it('mints nothing without a key, without a window, or when the random source misbehaves', () => {
    const input = { startAt: START, endAt: END, botJoinLeadSec: 120, nowMs: NOW };
    const random = vi.fn((bytes: number) => Buffer.alloc(bytes, 1));
    for (const env of [{}, { WORKER_CONTEXT_SECRET: 'w'.repeat(31) }] as NodeJS.ProcessEnv[]) {
      expect(mintR1MeetTicket(input, { random, source: env })).toBeNull();
    }
    expect(mintR1MeetTicket({ ...input, botJoinLeadSec: 900 }, { random, source: ENV })).toBeNull();
    expect(mintR1MeetTicket({ ...input, nowMs: END_MS + 900_000 }, { random, source: ENV })).toBeNull();
    // No key or no window: no randomness is spent.
    expect(random).not.toHaveBeenCalled();
    expect(mintR1MeetTicket(input, { random: () => Buffer.alloc(31, 1), source: ENV })).toBeNull();
    expect(mintR1MeetTicket(input, { random: () => Buffer.alloc(33, 1), source: ENV })).toBeNull();
    expect(mintR1MeetTicket(input, { random: () => 'x'.repeat(32) as unknown as Buffer, source: ENV })).toBeNull();
  });
});

describe('r1MeetTicketDigest: its own HMAC domain', () => {
  it('equals HMAC(HMAC(secret, "hello:r1:meet-bridge:v1"), ticket), recomputed here, as 64 lowercase hex', () => {
    expect(R1_MEET_TICKET_DOMAIN).toBe('hello:r1:meet-bridge:v1');
    const expected = hmacHex(domainKey('hello:r1:meet-bridge:v1'), TICKET);
    const digest = r1MeetTicketDigest(TICKET, ENV);
    expect(digest).toBe(expected);
    // The 0142 CHECK on r1_meet_bookings.ticket_digest.
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(r1MeetDerivedKey(R1_MEET_TICKET_DOMAIN, ENV)).toEqual(domainKey(R1_MEET_TICKET_DOMAIN));
  });

  it('is neither a plain SHA-256, nor the resume-domain MAC, nor the attempt-token-domain MAC, nor keyed by the raw secret', () => {
    const digest = r1MeetTicketDigest(TICKET, ENV)!;
    expect(digest).not.toBe(createHash('sha256').update(TICKET).digest('hex'));
    expect(digest).not.toBe(hmacHex(domainKey('hello:r1:meet-resume:v1'), TICKET));
    expect(digest).not.toBe(hmacHex(domainKey('hello:r1:attempt-token:v1'), TICKET));
    expect(digest).not.toBe(hmacHex(SECRET, TICKET));
    expect(digest).not.toContain(TICKET);
  });

  it('depends on the secret, and is null with no or a short secret or a ticket outside the pattern', () => {
    const other = { WORKER_CONTEXT_SECRET: 'v'.repeat(40) } as NodeJS.ProcessEnv;
    expect(r1MeetTicketDigest(TICKET, other)).not.toBe(r1MeetTicketDigest(TICKET, ENV));
    for (const env of [{}, { WORKER_CONTEXT_SECRET: '' }, { WORKER_CONTEXT_SECRET: 'w'.repeat(31) }] as NodeJS.ProcessEnv[]) {
      expect(r1MeetTicketDigest(TICKET, env)).toBeNull();
      expect(r1MeetBridgeKeysConfigured(env)).toBe(false);
    }
    expect(r1MeetBridgeKeysConfigured(ENV)).toBe(true);
    expect(r1MeetBridgeKeysConfigured({ WORKER_CONTEXT_SECRET: 'w'.repeat(32) } as NodeJS.ProcessEnv)).toBe(true);
    for (const bad of ['k'.repeat(31), 'k'.repeat(129), 'k'.repeat(42) + '=', 'k'.repeat(42) + '+', 'k'.repeat(42) + '/', `${'k'.repeat(40)} kk`, '']) {
      expect(r1MeetTicketDigest(bad, ENV), bad).toBeNull();
    }
    for (const bad of [undefined, null, 42, { ticket: TICKET }]) {
      expect(r1MeetTicketDigest(bad as unknown as string, ENV)).toBeNull();
    }
    expect(r1MeetTicketDigest('k'.repeat(32), ENV)).toMatch(/^[a-f0-9]{64}$/);
    expect(r1MeetTicketDigest('k'.repeat(128), ENV)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('derives keys only for the Meet bridge domains, never for another R1 key', () => {
    expect(r1MeetDerivedKey('hello:r1:meet-resume:v1', ENV)).toEqual(domainKey('hello:r1:meet-resume:v1'));
    for (const domain of ['hello:r1:attempt-token:v1', 'hello:r1:meet-bridge', 'meet-bridge:v1', '', 'hello:r1:MEET-bridge:v1']) {
      expect(r1MeetDerivedKey(domain, ENV), domain).toBeNull();
    }
  });
});

describe('r1MeetTicketWindow: start - max(300 s, lead + 60 s) .. end + 900 s', () => {
  it('gives start-5 min .. end+15 min for the default profile (lead 120 s)', () => {
    const profile = getR1MeetProfile(R1_MEET_DEFAULT_PROFILE_ID)!;
    expect(profile.botJoinLeadSec).toBe(120);
    expect(windowFor(profile.botJoinLeadSec)).toEqual({
      not_before: new Date(START_MS - 300_000).toISOString(),
      expires_at: new Date(END_MS + 900_000).toISOString(),
    });
    expect(R1_MEET_TICKET_LEAD_SEC).toBe(300);
    expect(R1_MEET_TICKET_TAIL_SEC).toBe(900);
  });

  it('follows a longer lead (600 s -> start-660 s), refuses a lead past the 15-minute bound (900 s)', () => {
    expect(windowFor(600)!.not_before).toBe(new Date(START_MS - 660_000).toISOString());
    expect(windowFor(840)!.not_before).toBe(new Date(START_MS - 900_000).toISOString());
    expect(windowFor(841)).toBeNull();
    expect(windowFor(900)).toBeNull();
    expect(windowFor(0)!.not_before).toBe(new Date(START_MS - 300_000).toISOString());
  });

  it('opens at or before the bot join time, for every lead 0..840 s, inside the 0142 §16 bounds', () => {
    for (let lead = 0; lead <= 840; lead += 60) {
      const window = windowFor(lead);
      expect(window, `lead ${lead}`).not.toBeNull();
      const notBefore = Date.parse(window!.not_before);
      const expires = Date.parse(window!.expires_at);
      // A 425 is terminal on the page: the bot (join_at = start - lead) must never be early.
      expect(notBefore, `lead ${lead}`).toBeLessThanOrEqual(START_MS - lead * 1000);
      expect(notBefore).toBeLessThanOrEqual(START_MS - 60_000 - lead * 1000);
      expect(notBefore).toBeGreaterThanOrEqual(START_MS - R1_MEET_TICKET_MAX_LEAD_SEC * 1000);
      expect(expires).toBeLessThanOrEqual(END_MS + R1_MEET_TICKET_MAX_TAIL_SEC * 1000);
      expect(notBefore).toBeLessThan(expires);
      expect(expires).toBeGreaterThan(NOW);
    }
  });

  it('mirrors the bounds r1_meet_arm_ticket enforces (read from migration 0142 §16)', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const sql = readFileSync(path.resolve(here, '../../../supabase/migrations/0142_r1_meet_bookings.sql'), 'utf8')
      .replace(/\r\n/g, '\n')
      .replace(/\s+/g, ' ');
    expect(sql).toContain("p_not_before < v_booking.start_at - interval '15 minutes'");
    expect(sql).toContain("p_expires_at > v_booking.end_at + interval '30 minutes'");
    expect(R1_MEET_TICKET_MAX_LEAD_SEC).toBe(15 * 60);
    expect(R1_MEET_TICKET_MAX_TAIL_SEC).toBe(30 * 60);
    expect(R1_MEET_TICKET_TAIL_SEC).toBeLessThan(R1_MEET_TICKET_MAX_TAIL_SEC);
  });

  it('is null once the window has closed (now >= expires_at), and open one ms before', () => {
    const expires = END_MS + 900_000;
    expect(windowFor(120, { nowMs: expires })).toBeNull();
    expect(windowFor(120, { nowMs: expires + 1 })).toBeNull();
    expect(windowFor(120, { nowMs: expires - 1 })).not.toBeNull();
    // Inside the slot (after not_before) a re-arm still gets the same window.
    expect(windowFor(120, { nowMs: START_MS + 60_000 })).toEqual(windowFor(120));
  });

  it('is null for an empty or inverted slot, an unparseable or zoneless time, a bad lead or a bad clock', () => {
    expect(windowFor(120, { endAt: START })).toBeNull();
    expect(windowFor(120, { startAt: END, endAt: START })).toBeNull();
    for (const bad of ['', 'nope', '2030-01-01', '2030-01-01T10:00:00', '2030-13-01T10:00:00Z', '1893456000000']) {
      expect(windowFor(120, { startAt: bad }), bad).toBeNull();
      expect(windowFor(120, { endAt: bad }), bad).toBeNull();
    }
    for (const lead of [-60, 120.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(windowFor(lead), String(lead)).toBeNull();
    }
    expect(windowFor(120, { nowMs: Number.NaN })).toBeNull();
    expect(r1MeetTicketWindow({ startAt: null, endAt: END, botJoinLeadSec: 120, nowMs: NOW } as never)).toBeNull();
  });

  it('accepts the instants PostgREST and the RPC answers print (offsets, microseconds)', () => {
    const window = windowFor(120, {
      startAt: '2030-01-01T15:30:00.123456+05:30',
      endAt: '2030-01-01T10:40:00+00:00',
    })!;
    expect(window.not_before).toBe('2030-01-01T09:55:00.123Z');
    expect(window.expires_at).toBe(new Date(END_MS + 900_000).toISOString());
    expect(parseR1MeetInstant('2030-01-01T10:00:00z')).toBe(START_MS);
    expect(parseR1MeetInstant('2030-01-01T10:00:00')).toBeNull();
    expect(parseR1MeetInstant(START_MS)).toBeNull();
  });
});

describe('r1MeetBridgePageUrl: the page the bot shows as its camera', () => {
  it('puts the ticket in the fragment of the canonical https bridge page URL', () => {
    expect(PAGE).toBe('https://hello.example.test/candidate/r1/meet');
    expect(r1MeetBridgePageUrl(PAGE, TICKET)).toBe(`https://hello.example.test/candidate/r1/meet#t=${TICKET}`);
    const minted = mintR1MeetTicket({ startAt: START, endAt: END, botJoinLeadSec: 120, nowMs: NOW }, { source: ENV })!;
    const url = new URL(r1MeetBridgePageUrl(PAGE, minted.ticket)!);
    expect(url.hash).toBe(`#t=${minted.ticket}`);
    expect(url.search).toBe('');
    expect(url.pathname).toBe(R1_MEET_BRIDGE_PAGE_PATH);
  });

  it('refuses http, a query, a fragment, another path, userinfo, a port spelling or a bad ticket', () => {
    const refusedPages = [
      'http://hello.example.test/candidate/r1/meet',
      'https://hello.example.test/candidate/r1/meet?x=1',
      'https://hello.example.test/candidate/r1/meet?',
      'https://hello.example.test/candidate/r1/meet#t=old',
      'https://hello.example.test/candidate/r1/meet#',
      'https://hello.example.test/candidate/r1',
      'https://hello.example.test/candidate/r1/meet/',
      'https://hello.example.test/candidate/r1/meeting',
      'https://hello.example.test/',
      'https://user:pw@hello.example.test/candidate/r1/meet',
      'https://hello.example.test:443/candidate/r1/meet',
      'https://HELLO.example.test/candidate/r1/meet',
      'not a url',
      '',
    ];
    for (const page of refusedPages) expect(r1MeetBridgePageUrl(page, TICKET), page).toBeNull();
    for (const ticket of ['k'.repeat(31), 'k'.repeat(129), `${'k'.repeat(42)}#`, `${'k'.repeat(42)}&`, '']) {
      expect(r1MeetBridgePageUrl(PAGE, ticket), ticket).toBeNull();
    }
    expect(r1MeetBridgePageUrl(undefined as unknown as string, TICKET)).toBeNull();
    expect(r1MeetBridgePageUrl(PAGE, 42 as unknown as string)).toBeNull();
    // A non-default port is a different origin, and still the canonical spelling: allowed.
    expect(r1MeetBridgePageUrl('https://hello.example.test:8443/candidate/r1/meet', TICKET)).toBe(
      `https://hello.example.test:8443/candidate/r1/meet#t=${TICKET}`,
    );
  });
});
