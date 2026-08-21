/**
 * Parse failure sub-classification, and the deferral that only becomes
 * possible once the causes are told apart.
 *
 * WHAT WAS WRONG: every one of nine distinct parser failures was written to
 * the durable ingestion row as the single word `parse_error`. Two of them —
 * the child killed by its wall-clock timeout on a contended CPU, and the
 * bounded pool refusing a submission — are statements about the PARSER'S
 * AVAILABILITY, not about the document, and recording them as `failed_review`
 * is a WAIT recorded as a VERDICT. That is the same conflation removed from
 * the scanner (0037) and from the invite attempt budget (0035/PR #66).
 *
 * WHAT MUST BE TRUE NOW:
 *   1. Ten stable codes, derived ONLY from the parser's fixed class/detail
 *      literals — never a message, a stack, child stderr, or document text.
 *   2. Exactly two of them defer; everything else rests loudly.
 *   3. The deferral is attempt-charging, wall-clock-bounded, and byte-wiping,
 *      and an unwired classifier reproduces the pre-change behaviour exactly.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  runResumeIngestion,
  classifyParserFailure,
  PARSE_FAILURE_CODES,
  PARSE_TRANSIENT_CODES,
  PARSE_CLASSIFIER,
  DEFAULT_PARSE_CLASSIFIER,
  type IngestionPorts,
  type StructuredResume,
} from '../integrations/ashby/resume-ingestion.js';
import {
  ParserError,
  ParserTimeoutError,
  ParserOutputExceededError,
  ParserAssetMissingError,
  ParserOverloadError,
} from '../lib/resume-parser.js';

const EMPTY: StructuredResume = {
  name: null, email: null, phone: null, skills: [], experience_years: null,
  current_role: null, summary: null,
};

/** The 0029 `chk_ashby_resume_ingestions_reason` shape. */
const REASON_SHAPE = /^[a-z0-9_.:-]{1,64}$/;

interface Recorded { state: string; reason?: string }

function portsFor(
  throwing: unknown,
  over: Partial<IngestionPorts> = {},
): { ports: IngestionPorts; states: Recorded[]; bytes: Buffer } {
  const states: Recorded[] = [];
  // A distinctive, non-zero buffer so "was it wiped?" is a real assertion and
  // not a tautology about an already-empty buffer.
  const bytes = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x25, 0x50, 0x44, 0x46]);
  const ports: IngestionPorts = {
    presignedUrl: 'https://host.example/r.pdf',
    policy: { allowlistEnabled: true, allowedHosts: ['host.example'], allowedPorts: [443] },
    fetch: async () => ({
      ok: true as const, bytes, sha256: 'a'.repeat(64),
      contentType: 'application/pdf', finalHost: 'host.example', hops: 0,
    }),
    scan: async () => ({ safe: true, status: 'clean' }),
    guard: () => ({ ok: true as const, mime: 'application/pdf' }),
    parse: async () => { throw throwing; },
    fallbackFromText: () => EMPTY,
    onState: (state, prov) => { states.push({ state, reason: prov?.failedReason }); },
    extractorVersion: 'x1',
    ...over,
  };
  return { ports, states, bytes };
}

// ═══════════════════════════════════════════════════════════════════════
// 1. The mapping table — by CLASS, never by message
// ═══════════════════════════════════════════════════════════════════════

describe('classifyParserFailure', () => {
  const CASES: Array<[string, unknown, string]> = [
    ['timeout',           new ParserTimeoutError(),          'parse_timeout'],
    ['pool overload',     new ParserOverloadError(),         'parse_overload'],
    ['output exceeded',   new ParserOutputExceededError(),   'parse_output_exceeded'],
    ['asset missing',     new ParserAssetMissingError(),     'parse_asset_missing'],
    ['spawn failure',     new ParserError('spawn_error'),    'parse_spawn_error'],
    ['non-zero exit',     new ParserError('child_exit'),     'parse_child_exit'],
    ['no stdout',         new ParserError('no_output'),      'parse_no_output'],
    ['garbled stdout',    new ParserError('bad_output'),     'parse_bad_output'],
    ['extraction failed', new ParserError('extract_failed'), 'parse_extract_failed'],
  ];

  for (const [label, err, code] of CASES) {
    it(`maps ${label} to ${code}`, () => {
      expect(classifyParserFailure(err)).toBe(code);
    });
  }

  it('an UNRECOGNISED failure stays exactly `parse_error` — the honest unknown', () => {
    // Every one of these could be "nearly" classified by guessing at its text.
    // None of them is, on purpose: a code this module did not derive from a
    // fixed literal would be a diagnosis it never made.
    expect(classifyParserFailure(new Error('boom'))).toBe('parse_error');
    expect(classifyParserFailure(new ParserError('some_future_detail'))).toBe('parse_error');
    expect(classifyParserFailure(new TypeError('x is not a function'))).toBe('parse_error');
    expect(classifyParserFailure('parse_timeout')).toBe('parse_error');
    expect(classifyParserFailure(null)).toBe('parse_error');
    expect(classifyParserFailure({ code: 'PARSER_TIMEOUT' })).toBe('parse_error');
  });

  it('NO dynamic message, stack, or document text can reach an emitted code', () => {
    // The parser's own messages are stable literals, but a future error need
    // not be — so the classifier is fed errors whose message IS the leak.
    const leaky = new ParserError('child_exit');
    (leaky as { message: string }).message =
      'ada.lovelace@example.com +44 7700 900123 /tmp/resume-secret.pdf ghp_TOKEN';
    (leaky as { stack?: string }).stack = 'Error: ' + leaky.message;
    const code = classifyParserFailure(leaky);
    expect(code).toBe('parse_child_exit');
    expect(code).not.toContain('example.com');
    expect(code).not.toContain('900123');
    expect(code).not.toContain('ghp_');
    expect(code).not.toContain('/tmp/');
  });

  it('every emitted code is DB-valid and bounded', () => {
    for (const code of PARSE_FAILURE_CODES) {
      expect(code).toMatch(REASON_SHAPE);
      expect(code.length).toBeLessThanOrEqual(64);
    }
    expect(new Set(PARSE_FAILURE_CODES).size).toBe(PARSE_FAILURE_CODES.length);
  });

  it('exactly two codes are transient, and they are the AVAILABILITY ones', () => {
    expect([...PARSE_TRANSIENT_CODES].sort()).toEqual(['parse_overload', 'parse_timeout']);
    // A broken deployment (spawn/exit/missing asset) must rest LOUDLY: waiting
    // silently on it is a fault nobody is paged for.
    for (const code of ['parse_spawn_error', 'parse_child_exit', 'parse_asset_missing']) {
      expect(PARSE_CLASSIFIER(code)).toBe('verdict');
    }
    // Document verdicts too.
    for (const code of ['parse_extract_failed', 'parse_bad_output', 'parse_no_output',
      'parse_output_exceeded', 'parse_error']) {
      expect(PARSE_CLASSIFIER(code)).toBe('verdict');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. What the ingestion does with each class
// ═══════════════════════════════════════════════════════════════════════

describe('runResumeIngestion — parse disposition', () => {
  it('a document verdict rests in failed_review with the SPECIFIC code, not `parse_error`', async () => {
    const { ports, states } = portsFor(new ParserError('extract_failed'), {
      classifyParse: PARSE_CLASSIFIER,
    });
    const out = await runResumeIngestion(ports);
    expect(out).toMatchObject({ state: 'failed_review', reason: 'parse_extract_failed' });
    expect(states.at(-1)).toEqual({ state: 'failed_review', reason: 'parse_extract_failed' });
  });

  it('a broken deployment rests loudly rather than waiting', async () => {
    const { ports, states } = portsFor(new ParserError('spawn_error'), {
      classifyParse: PARSE_CLASSIFIER,
    });
    const out = await runResumeIngestion(ports);
    expect(out).toMatchObject({ state: 'failed_review', reason: 'parse_spawn_error' });
    expect(states.map((s) => s.state)).toContain('failed_review');
  });

  it('an unknown failure still writes exactly `parse_error` — no regression in honesty', async () => {
    const { ports } = portsFor(new Error('something new'), { classifyParse: PARSE_CLASSIFIER });
    expect(await runResumeIngestion(ports)).toMatchObject({
      state: 'failed_review', reason: 'parse_error',
    });
  });

  for (const [label, err, code] of [
    ['timeout', new ParserTimeoutError(), 'parse_timeout'],
    ['overload', new ParserOverloadError(), 'parse_overload'],
  ] as Array<[string, unknown, string]>) {
    it(`a ${label} DEFERS: no failed_review row, no state emission at all`, async () => {
      const { ports, states } = portsFor(err, { classifyParse: PARSE_CLASSIFIER });
      const out = await runResumeIngestion(ports);
      expect(out).toEqual({
        state: 'deferred', reason: code, scanStatus: code, deferSource: 'parse',
      });
      // The durable row keeps `extracting` and gains NO failure reason, so
      // nothing downstream reads an unavailable parser as a document that
      // needs a human.
      expect(states.map((s) => s.state)).toEqual(['fetching', 'scanning', 'extracting']);
      expect(states.some((s) => s.reason != null)).toBe(false);
    });
  }

  it('the deferral wipes the resume bytes — the wait must not leak what the design protects', async () => {
    const { ports, bytes } = portsFor(new ParserTimeoutError(), { classifyParse: PARSE_CLASSIFIER });
    await runResumeIngestion(ports);
    expect(bytes.every((b) => b === 0)).toBe(true);
  });

  it('a verdict wipes the bytes too', async () => {
    const { ports, bytes } = portsFor(new ParserError('bad_output'), { classifyParse: PARSE_CLASSIFIER });
    await runResumeIngestion(ports);
    expect(bytes.every((b) => b === 0)).toBe(true);
  });

  it('an UNWIRED classifier reproduces the pre-change terminal behaviour', async () => {
    // Fail-safe in the direction that matters: forgetting to wire the
    // classifier closes the ingestion out loudly, never parks it in an
    // invisible wait. This is the same posture DEFAULT_SCAN_CLASSIFIER takes.
    const { ports, states } = portsFor(new ParserTimeoutError());
    const out = await runResumeIngestion(ports);
    expect(out).toMatchObject({ state: 'failed_review', reason: 'parse_timeout' });
    expect(states.at(-1)?.state).toBe('failed_review');
    expect(DEFAULT_PARSE_CLASSIFIER('parse_timeout')).toBe('verdict');
  });

  it('the guard still runs BEFORE the parser — an unsafe file is never parsed to make a canary green', async () => {
    const parse = vi.fn(async () => { throw new ParserTimeoutError(); });
    const { ports, states } = portsFor(new ParserTimeoutError(), {
      guard: () => ({ ok: false as const, reason: 'unsupported_type' }),
      parse,
      classifyParse: PARSE_CLASSIFIER,
    });
    const out = await runResumeIngestion(ports);
    expect(parse).not.toHaveBeenCalled();
    expect(out).toMatchObject({ state: 'failed_review', reason: 'guard_unsupported_type' });
    expect(states.at(-1)?.reason).toBe('guard_unsupported_type');
  });

  it('an INFECTED scan is still terminal and still never reaches the parser', async () => {
    const parse = vi.fn(async () => ({ text: '', structured: EMPTY, structurerVersion: 'v1' }));
    const { ports } = portsFor(new ParserTimeoutError(), {
      scan: async () => ({ safe: false, status: 'infected' }),
      parse,
      classifyScan: (s) => (s === 'infected' ? 'verdict' : 'transient'),
      classifyParse: PARSE_CLASSIFIER,
    });
    expect(await runResumeIngestion(ports)).toMatchObject({
      state: 'failed_review', reason: 'scan_infected',
    });
    expect(parse).not.toHaveBeenCalled();
  });
});
