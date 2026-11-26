/**
 * ashby-candidate-search-contract.test.ts — M035 S04: does `candidate.search`
 * go out exactly as Ashby documents it, and does the documented answer reach
 * the public booking matcher's readers intact?
 *
 *   documented JSON envelope ─► REAL AshbyClient (injected transport, no
 *   network) ─► readR1PublicAshbySearch ─► pickR1PublicAshbyCandidate
 *
 * Documented shapes (developers.ashbyhq.com, reference page `candidatesearch`,
 * OpenAPI 3.1 for API version 2026-01-01, read 2026-11-26; research R04 §1):
 *
 *   - Request `CandidateSearchRequest`, `additionalProperties: false`, nothing
 *     required: `email` (string|null), `name` (string|null), `limit` (integer
 *     1..100|null, default 100). No phone field and no cursor. We send exactly
 *     `{ email, limit: 20 }`.
 *   - Response `{ success: true, results: Candidate[], moreDataAvailable }`;
 *     `moreDataAvailable` means more people matched "beyond the requested
 *     limit". A failure is the ErrorResponse `{ success: false, errors: [...] }`
 *     or `errorInfo { code, message, requestId }`; a missing module is
 *     `missing_endpoint_permission` on HTTP 403 or HTTP 200 + success:false.
 *   - `Candidate` REQUIRED keys: id, createdAt, updatedAt, name, doNotContact,
 *     primaryEmailAddress, emailAddresses, primaryPhoneNumber, phoneNumbers,
 *     socialLinks, tags, applicationIds, resumeFileHandle, fileHandles,
 *     profileUrl. Optional: fraudStatus (Fraudulent | NotFraudulent | Unsure |
 *     Unreviewed | PassedFraudCheck), timezone, location, source, ... Contact
 *     items are ContactInfo `{ value, type: 'Personal'|'Work'|'Other',
 *     isPrimary }`.
 *   - UNVERIFIED (live spike): whether the email match is exact or partial and
 *     whether it ignores case. The matcher therefore filters the results
 *     itself; the partial and case cases below pin that it does.
 *
 * Every name, email, id and number below is synthetic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Record every logger call with its RAW arguments ─────────────────────────
// The production logger scrubs emails and long digit runs before it writes,
// so a stdout capture would hide a leak the code made. The assertion here is
// stricter: no contact value is ever HANDED to the logger at all.
const loggerCalls = vi.hoisted(
  () => [] as Array<{ component: string; level: string; args: unknown[] }>,
);
vi.mock('../lib/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/logger.js')>();
  return {
    ...actual,
    createLogger: (component: string, deps?: Parameters<typeof actual.createLogger>[1]) => {
      const real = actual.createLogger(component, deps);
      const wrap = (level: 'debug' | 'info' | 'warn' | 'error') =>
        (...args: Parameters<typeof real.info>) => {
          loggerCalls.push({ component, level, args });
          return real[level](...args);
        };
      return { debug: wrap('debug'), info: wrap('info'), warn: wrap('warn'), error: wrap('error') };
    },
  };
});

import { createAshbyClient, type AshbyLogRecord, type AshbyTransportRequest } from '../integrations/ashby/client.js';
import { AshbyError } from '../integrations/ashby/errors.js';
import { createMetadataLogger } from '../integrations/ashby/logging.js';
import {
  ACCESS_CHECK_READ_OPERATIONS,
  assertAccessCheckReadOnly,
  classifyAccessError,
} from '../integrations/ashby/access-check.js';
import { ASHBY_CANDIDATE_SEARCH_LIMIT, ASHBY_OPERATIONS } from '../integrations/ashby/types.js';
import {
  pickR1PublicAshbyCandidate,
  readR1PublicAshbySearch,
  type R1PublicAshbyCandidateHit,
} from '../lib/r1/meet/public/match.js';
import { normalizePublicEmail } from '../lib/r1/meet/public/normalize.js';

// ── Synthetic identity ──────────────────────────────────────────────────────
const CAND_ID = '0b6f3c1e-2222-4a00-8000-00000000c001';
const OTHER_CAND_ID = '0b6f3c1e-2222-4a00-8000-00000000c002';
const APP_ID = '0b6f3c1e-1111-4a00-8000-00000000a001';
const OTHER_APP_ID = '0b6f3c1e-1111-4a00-8000-00000000a002';

const NAME = 'Test Person';
const EMAIL = 'test.person@example.com';
const WORK_EMAIL = 'test.person.work@example.com';
const PHONE_RAW = '+91 98123 45670';

/** Substrings that must never reach a logger argument, a client log record, a URL or a throw. */
const PII_FRAGMENTS = [
  'Test Person', 'Person', 'test.person', 'example.com', 'person@',
  '9812345670', '98123', '45670',
];

type ContactType = 'Personal' | 'Work' | 'Other';
function contact(value: string, type: ContactType = 'Personal', isPrimary = true) {
  return { value, type, isPrimary };
}

/** One `candidate.search` result: a Candidate with every documented required key. */
function documentedCandidate(over: Record<string, unknown> = {}): Record<string, unknown> {
  const id = typeof over.id === 'string' ? over.id : CAND_ID;
  return {
    id,
    createdAt: '2026-10-01T09:30:00.000Z',
    updatedAt: '2026-11-19T11:05:00.000Z',
    name: NAME,
    doNotContact: false,
    primaryEmailAddress: contact(EMAIL),
    emailAddresses: [contact(EMAIL)],
    primaryPhoneNumber: contact(PHONE_RAW),
    phoneNumbers: [contact(PHONE_RAW)],
    socialLinks: [],
    tags: [],
    applicationIds: [APP_ID],
    resumeFileHandle: null,
    fileHandles: [],
    profileUrl: `https://app.ashbyhq.com/candidates/${id}`,
    source: null,
    creditedToUser: null,
    timezone: null,
    fraudStatus: 'Unreviewed',
    ...over,
  };
}

const ok = (results: unknown, moreDataAvailable = false) => ({ success: true, results, moreDataAvailable });

/** The documented ErrorResponse, with contact data in the message on purpose. */
const documentedError = {
  success: false,
  errors: [{ message: `No candidate ${NAME} <${EMAIL}> ${PHONE_RAW}`, parameter: 'email' }],
};

// ── A REAL client over an in-memory transport ───────────────────────────────

type Reply = { status?: number; body: unknown } | Error;

interface Wire {
  reply: Reply;
  requests: Array<{ method: string; url: string; body: string; headers: Record<string, string> }>;
  clientEvents: AshbyLogRecord[];
}

function newWire(reply: Reply = { body: ok([documentedCandidate()]) }): Wire {
  return { reply, requests: [], clientEvents: [] };
}

function realClient(wire: Wire) {
  // Records each metadata record AND forwards it to the production adapter, so
  // the raw logger capture above sees exactly what production would log.
  const metadata = createMetadataLogger('ashby-search-contract');
  return createAshbyClient({
    apiKey: 'synthetic-test-key',
    maxAttempts: 1,
    sleep: async () => undefined,
    random: () => 0.5,
    logger: { event: (record) => { wire.clientEvents.push(record); metadata.event(record); } },
    transport: async (req: AshbyTransportRequest) => {
      wire.requests.push({ method: req.method, url: req.url, body: req.body, headers: req.headers });
      if (!req.url.endsWith('/candidate.search')) throw new Error('unexpected_operation');
      if (wire.reply instanceof Error) throw wire.reply;
      const status = wire.reply.status ?? 200;
      const text = JSON.stringify(wire.reply.body);
      return { status, ok: status >= 200 && status < 300, headers: { get: () => null }, text: async () => text };
    },
  });
}

/** Search through the REAL client, then read and pick as S06 will. */
async function searchAndPick(wire: Wire, typed: string, o?: { phoneAshbyCandidateIds?: readonly string[] | null }) {
  const page = await realClient(wire).candidateSearch(typed);
  const read = readR1PublicAshbySearch(page);
  const pick = read.ok ? pickR1PublicAshbyCandidate(typed, read.hits, o) : null;
  return { page, read, pick };
}

/** Everything a value could leak through: both log surfaces, every URL, and the error. */
function leakSurface(wire: Wire, error?: unknown): string {
  const parts = [
    JSON.stringify(loggerCalls.map((c) => c.args)),
    JSON.stringify(wire.clientEvents),
    wire.requests.map((r) => r.url).join('\n'),
  ];
  if (error instanceof Error) parts.push(error.message, String(error), String(error.stack), JSON.stringify(error));
  return parts.join('\n');
}

function expectNoLeak(wire: Wire, error?: unknown): void {
  const text = leakSurface(wire, error);
  for (const fragment of PII_FRAGMENTS) expect(text, fragment).not.toContain(fragment);
}

beforeEach(() => {
  loggerCalls.length = 0;
});

// ═══════════════════════════════════════════════════════════════════════
// 1. The registry
// ═══════════════════════════════════════════════════════════════════════

describe('the candidate.search registry entry', () => {
  it('is a fixed-path READ', () => {
    expect(ASHBY_OPERATIONS['candidate.search']).toEqual({ path: '/candidate.search', mutation: false });
    expect(ASHBY_OPERATIONS['candidate.search'].mutation).toBe(false);
  });

  it('pages at most 20 people, inside the documented 1..100 range', () => {
    expect(ASHBY_CANDIDATE_SEARCH_LIMIT).toBe(20);
    expect(Number.isInteger(ASHBY_CANDIDATE_SEARCH_LIMIT)).toBe(true);
    expect(ASHBY_CANDIDATE_SEARCH_LIMIT).toBeGreaterThanOrEqual(1);
    expect(ASHBY_CANDIDATE_SEARCH_LIMIT).toBeLessThanOrEqual(100);
  });

  it('is one of the access check\'s allowlisted reads', () => {
    expect(ACCESS_CHECK_READ_OPERATIONS).toContain('candidate.search');
    expect(() => assertAccessCheckReadOnly('candidate.search')).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. The request on the wire
// ═══════════════════════════════════════════════════════════════════════

describe('candidateSearch sends exactly the documented request', () => {
  it('POSTs { email, limit: 20 } to the fixed path, with nothing in the URL', async () => {
    const wire = newWire();
    await realClient(wire).candidateSearch(EMAIL);
    expect(wire.requests).toHaveLength(1);
    const [req] = wire.requests;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.ashbyhq.com/candidate.search');
    // Exactly this string: key order email, limit; no name, no extra field.
    expect(req.body).toBe('{"email":"test.person@example.com","limit":20}');
    expect(req.url).not.toContain('?');
    expect(req.url).not.toContain('@');
    expect(req.headers.authorization).toMatch(/^Basic /);
    expectNoLeak(wire);
  });

  it('sends the address exactly as given: the caller normalises, the client never folds or trims', async () => {
    const wire = newWire({ body: ok([]) });
    await realClient(wire).candidateSearch('Test.Person+Tag@Example.COM');
    expect(JSON.parse(wire.requests[0].body)).toEqual({ email: 'Test.Person+Tag@Example.COM', limit: 20 });
  });

  it('a live deadline and the fail-fast flag are internal: the body is unchanged', async () => {
    const wire = newWire();
    await realClient(wire).candidateSearch(EMAIL, { deadlineAt: Date.now() + 60_000, failFastPastDeadline: true });
    expect(wire.requests[0].body).toBe('{"email":"test.person@example.com","limit":20}');
    expect(wire.requests[0].body).not.toContain('deadline');
    expect(wire.requests[0].body).not.toContain('failFast');
  });

  it('a spent deadline fails as a timeout before any transport call', async () => {
    const wire = newWire();
    const error = await realClient(wire).candidateSearch(EMAIL, { deadlineAt: Date.now() - 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AshbyError);
    expect(error).toMatchObject({ category: 'timeout', code: 'deadline_exceeded', operation: 'candidate.search' });
    expect(wire.requests).toHaveLength(0);
    expectNoLeak(wire, error);
  });

  it('accepts the boundary lengths: 3 and 254 characters', async () => {
    const wire = newWire({ body: ok([]) });
    const client = realClient(wire);
    const longest = `${'a'.repeat(64)}@${'b'.repeat(184)}.test`;
    expect(longest).toHaveLength(254);
    await client.candidateSearch('a@b');
    await client.candidateSearch(longest);
    expect(wire.requests.map((r) => JSON.parse(r.body).email)).toEqual(['a@b', longest]);
  });
});

describe('an unusable address is refused before any transport call, and the error carries none of it', () => {
  const cases: Array<[string, unknown]> = [
    ['empty', ''],
    ['too short', 'a@'],
    ['no @', 'test.person.example.com'],
    ['two @', 'test.person@@example.com'],
    ['two @ apart', 'test@person@example.com'],
    ['leading @', '@test.person.example.com'],
    ['trailing @', 'test.person.example.com@'],
    ['a leading space', ` ${EMAIL}`],
    ['a trailing space', `${EMAIL} `],
    ['an inner space', 'test person@example.com'],
    ['a tab', `${EMAIL}\t`],
    ['a newline', `test.person@example.com\nbcc@example.com`],
    ['a no-break space', 'test.person @example.com'],
    ['a zero-width space', 'test.person​@example.com'],
    ['a bidi override', '‮test.person@example.com'],
    ['a byte-order mark', '﻿test.person@example.com'],
    ['a NUL', `${EMAIL}\u0000`],
    ['a DEL', `test.person\u007f@example.com`],
    ['a C1 control', `test.person\u0085@example.com`],
    ['255 characters', `${'t'.repeat(64)}@${'e'.repeat(185)}.test`],
    ['a number', 42],
    ['null', null],
    ['undefined', undefined],
    ['an object', { email: EMAIL }],
    ['an array', [EMAIL]],
  ];

  it.each(cases)('%s', async (_label, input) => {
    const wire = newWire();
    const error = await realClient(wire).candidateSearch(input as string).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AshbyError);
    expect(error).toMatchObject({ category: 'invalid_request', code: 'invalid_email', operation: 'candidate.search' });
    expect((error as AshbyError).message).toBe('ashby_invalid_request');
    expect(wire.requests).toHaveLength(0);
    expect(wire.clientEvents).toHaveLength(0);
    expectNoLeak(wire, error);
  });

  it('the 255-character case really is one over the bound', () => {
    expect(`${'t'.repeat(64)}@${'e'.repeat(185)}.test`).toHaveLength(255);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. The documented answer, through the matcher's readers
// ═══════════════════════════════════════════════════════════════════════

describe('the documented envelope reaches readR1PublicAshbySearch and pickR1PublicAshbyCandidate', () => {
  it('exact match: one person, with ids verbatim and the flags read', async () => {
    const wire = newWire();
    const { page, read, pick } = await searchAndPick(wire, EMAIL);
    expect(page.moreDataAvailable).toBe(false);
    expect(read.ok).toBe(true);
    expect(pick?.kind).toBe('one');
    const hit = (pick as { kind: 'one'; hit: R1PublicAshbyCandidateHit }).hit;
    expect(hit.id).toBe(CAND_ID);
    expect(hit.applicationIds).toEqual([APP_ID]);
    expect(hit.doNotContact).toBe(false);
    expect(hit.fraudStatus).toBe('Unreviewed');
    // A hit serialises to a marker, never to the address it carries.
    expect(JSON.stringify(pick)).not.toContain('example.com');
    expectNoLeak(wire);
  });

  it('an empty page: no match', async () => {
    const { read, pick } = await searchAndPick(newWire({ body: ok([]) }), EMAIL);
    expect(read).toEqual({ ok: true, hits: [] });
    expect(pick).toEqual({ kind: 'not_found', reason: 'no_match' });
  });

  it('a partial match only (Ashby returned a longer address): no match', async () => {
    const wire = newWire({ body: ok([documentedCandidate({
      primaryEmailAddress: contact(WORK_EMAIL), emailAddresses: [contact(WORK_EMAIL)],
    })]) });
    const { read, pick } = await searchAndPick(wire, EMAIL);
    expect(read.ok).toBe(true);
    expect(pick).toEqual({ kind: 'not_found', reason: 'no_match' });
  });

  it('a different case on file still matches the typed (normalised) address', async () => {
    const stored = 'Test.Person@Example.COM';
    const wire = newWire({ body: ok([documentedCandidate({
      primaryEmailAddress: contact(stored), emailAddresses: [contact(stored)],
    })]) });
    const typed = normalizePublicEmail(' Test.PERSON@example.com ');
    expect(typed).toBe(EMAIL);
    const { pick } = await searchAndPick(wire, typed as string);
    expect(pick).toMatchObject({ kind: 'one', hit: { id: CAND_ID } });
  });

  it('a match on a secondary address in emailAddresses counts', async () => {
    const wire = newWire({ body: ok([documentedCandidate({
      primaryEmailAddress: contact(WORK_EMAIL, 'Work'),
      emailAddresses: [contact(WORK_EMAIL, 'Work'), contact(EMAIL, 'Personal', false)],
    })]) });
    const { pick } = await searchAndPick(wire, EMAIL);
    expect(pick).toMatchObject({ kind: 'one', hit: { id: CAND_ID } });
  });

  it('two people on the same address: ambiguous', async () => {
    const wire = newWire({ body: ok([
      documentedCandidate(),
      documentedCandidate({ id: OTHER_CAND_ID, applicationIds: [OTHER_APP_ID] }),
    ]) });
    const { pick } = await searchAndPick(wire, EMAIL);
    expect(pick).toEqual({ kind: 'not_found', reason: 'ambiguous' });
  });

  it('two people, only one exact: that one', async () => {
    const wire = newWire({ body: ok([
      documentedCandidate({ id: OTHER_CAND_ID, primaryEmailAddress: contact(WORK_EMAIL), emailAddresses: [contact(WORK_EMAIL)] }),
      documentedCandidate(),
    ]) });
    const { pick } = await searchAndPick(wire, EMAIL);
    expect(pick).toMatchObject({ kind: 'one', hit: { id: CAND_ID } });
  });

  it('more data available beyond the page: ambiguous, before any pick', async () => {
    const wire = newWire({ body: ok([documentedCandidate()], true) });
    const { page, read, pick } = await searchAndPick(wire, EMAIL);
    expect(page.moreDataAvailable).toBe(true);
    expect(read).toEqual({ ok: false, reason: 'ambiguous' });
    expect(pick).toBeNull();
  });

  it('a full page of the limit reads; one more than the limit is ambiguous', async () => {
    const people = (n: number) => Array.from({ length: n }, (_, i) => documentedCandidate({
      id: `0b6f3c1e-2222-4a00-8000-${String(i).padStart(12, '0')}`,
      primaryEmailAddress: contact(`other${i}@example.com`),
      emailAddresses: [contact(`other${i}@example.com`)],
    }));
    const full = await searchAndPick(newWire({ body: ok(people(ASHBY_CANDIDATE_SEARCH_LIMIT)) }), EMAIL);
    expect(full.read.ok).toBe(true);
    expect(full.pick).toEqual({ kind: 'not_found', reason: 'no_match' });
    const over = await searchAndPick(newWire({ body: ok(people(ASHBY_CANDIDATE_SEARCH_LIMIT + 1)) }), EMAIL);
    expect(over.read).toEqual({ ok: false, reason: 'ambiguous' });
  });

  it('a result that is not a well-formed Candidate makes the page malformed', async () => {
    const wire = newWire({ body: ok([documentedCandidate(), { id: 'not-a-uuid', name: NAME }]) });
    const { read } = await searchAndPick(wire, EMAIL);
    expect(read).toEqual({ ok: false, reason: 'malformed' });
  });

  it('results that are not an array make the page malformed', async () => {
    const wire = newWire({ body: { success: true, results: documentedCandidate(), moreDataAvailable: false } });
    const { read } = await searchAndPick(wire, EMAIL);
    expect(read).toEqual({ ok: false, reason: 'malformed' });
  });

  it('the phone pointing at another Ashby person: conflicting identity', async () => {
    const { pick } = await searchAndPick(newWire(), EMAIL, { phoneAshbyCandidateIds: [OTHER_CAND_ID] });
    expect(pick).toEqual({ kind: 'not_found', reason: 'conflicting_identity' });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. Failures: a permission verdict or a coarse code, never contact data
// ═══════════════════════════════════════════════════════════════════════

describe('a failed search', () => {
  it.each([
    ['HTTP 200 success:false errorInfo', { status: 200, body: { success: false, errorInfo: { code: 'missing_endpoint_permission', message: `no ${EMAIL}`, requestId: 'r' } } }],
    ['HTTP 403 errorInfo', { status: 403, body: { success: false, errorInfo: { code: 'missing_endpoint_permission' } } }],
    ['HTTP 403 errors list', { status: 403, body: { success: false, errors: ['missing_endpoint_permission'] } }],
  ])('missing_endpoint_permission (%s) classifies as missing_permission', async (_label, reply) => {
    const wire = newWire(reply);
    const error = await realClient(wire).candidateSearch(EMAIL).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AshbyError);
    expect((error as AshbyError).operation).toBe('candidate.search');
    expect((error as AshbyError).endpointCodes).toContain('missing_endpoint_permission');
    expect(classifyAccessError(error)).toEqual({ state: 'missing_permission', error: null });
    expectNoLeak(wire, error);
  });

  it('the documented ErrorResponse is a logical failure that carries none of its message', async () => {
    const wire = newWire({ body: documentedError });
    const error = await realClient(wire).candidateSearch(EMAIL).catch((e: unknown) => e);
    expect(error).toMatchObject({ category: 'logical_failure', operation: 'candidate.search' });
    expect((error as AshbyError).message).toBe('ashby_logical_failure');
    expect(classifyAccessError(error)).toEqual({ state: 'error', error: 'logical_failure' });
    expectNoLeak(wire, error);
  });

  it('a transport error whose text holds contact data does not pass it on', async () => {
    const wire = newWire(new Error(`socket reset ${EMAIL} ${PHONE_RAW}`));
    const error = await realClient(wire).candidateSearch(EMAIL).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AshbyError);
    expectNoLeak(wire, error);
  });

  it('HTTP 500 ends retry_exhausted (one attempt in this suite) and reads as server_error', async () => {
    const wire = newWire({ status: 500, body: documentedError });
    const error = await realClient(wire).candidateSearch(EMAIL).catch((e: unknown) => e);
    expect(error).toMatchObject({ category: 'retry_exhausted', operation: 'candidate.search' });
    expect(classifyAccessError(error)).toEqual({ state: 'error', error: 'server_error' });
    expectNoLeak(wire, error);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. What is logged
// ═══════════════════════════════════════════════════════════════════════

describe('logging is metadata only', () => {
  it('a success and a failure each log the operation and outcome, and no contact value', async () => {
    const good = newWire();
    await realClient(good).candidateSearch(EMAIL);
    const bad = newWire({ status: 403, body: { success: false, errorInfo: { code: 'missing_endpoint_permission', message: EMAIL } } });
    await realClient(bad).candidateSearch(EMAIL).catch(() => undefined);
    expect(good.clientEvents.map((e) => [e.operation, e.outcome])).toEqual([['candidate.search', 'success']]);
    expect(bad.clientEvents.map((e) => [e.operation, e.outcome])).toEqual([['candidate.search', 'failure']]);
    // Non-vacuous: the production adapter handed both records to the logger.
    expect(loggerCalls.length).toBeGreaterThanOrEqual(2);
    for (const record of [...good.clientEvents, ...bad.clientEvents]) {
      expect(Object.keys(record).sort()).toEqual(
        expect.arrayContaining(['attempt', 'durationMs', 'operation', 'outcome']),
      );
      for (const key of Object.keys(record)) {
        expect(['operation', 'attempt', 'outcome', 'category', 'httpStatus', 'durationMs'], key).toContain(key);
      }
    }
    expectNoLeak(good);
    expectNoLeak(bad);
  });
});
