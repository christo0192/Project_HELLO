/**
 * M035 S12 T5: the on-the-spot import of the public booking page
 * (lib/r1/meet/public/import.ts and import-store.ts; S12-PLAN R17-R19).
 *
 * Pinned here, with a fake Ashby (`application.info`, `candidate.info`), a recording RPC double, the
 * REAL Supabase client over a capturing fetch and a recording log:
 *  - the happy path: ONE RPC call with exactly the eight 0144 parameters in signature order, every
 *    value from the two Ashby reads (ids as application.info spells them), frozen results;
 *  - a typed form value can never reach the RPC or a log (the input type has no such field, and an
 *    extra key cast in is ignored);
 *  - every refusal and its call pattern (what is read, whether the RPC runs, what is logged);
 *  - the number is sent only when it is dialable, the name only when it reads as a name;
 *  - a database failure or an answer outside the contract throws `r1_meet_db_error` after one
 *    `rpc_failed` line;
 *  - every log line is the closed alert word, a closed type and at most a status number;
 *  - parity with migration 0144 (codes, fields, parameter names) and with S04's alert word.
 * Every id, name, email and number below is synthetic.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { AshbyError, type AshbyErrorCategory } from '../integrations/ashby/errors.js';
import type { supabase } from '../lib/supabase.js';
import { R1MeetJobError } from '../lib/r1/meet/jobs.js';
import type { R1MeetLog, R1MeetLogMeta } from '../lib/r1/meet/recall-actions.js';
import {
  R1_PUBLIC_IMPORT_ALERTS,
  R1_PUBLIC_IMPORT_REFUSALS,
  importR1PublicApplication,
  r1PublicImportAlert,
  type R1PublicImportDeps,
  type R1PublicImportInput,
  type R1PublicImportResult,
} from '../lib/r1/meet/public/import.js';
import {
  R1_PUBLIC_IMPORT_INVALID_FIELDS,
  R1_PUBLIC_IMPORT_REFUSAL_CODES,
  R1_PUBLIC_IMPORT_RPC,
  callR1PublicImportRpc,
  type R1PublicImportRpcInput,
} from '../lib/r1/meet/public/import-store.js';
import { r1PublicMatchAlert } from '../lib/r1/meet/public/match.js';

// ── Synthetic identity ───────────────────────────────────────────────────────

const hex = (n: number): string => n.toString(16).padStart(12, '0');
/** Local `candidates.id` values (RPC answers). */
const cand = (n: number): string => `5e12a0b1-1111-4a00-8000-${hex(n)}`;
/** Ashby application ids. */
const app = (n: number): string => `5e12a0b1-2222-4a00-8000-${hex(n)}`;
/** Ashby candidate ids. */
const person = (n: number): string => `5e12a0b1-3333-4a00-8000-${hex(n)}`;
/** `ashby_application_links.id` values (RPC answers). */
const link = (n: number): string => `5e12a0b1-4444-4a00-8000-${hex(n)}`;

const APP = app(1);
const APP2 = app(2);
const PERSON = person(1);
const PERSON2 = person(2);
const CAND = cand(1);
const LINK = link(1);
const JOB = 'mpi-job-0001';
const STAGE = 'mpi-stage-0001';

/** What Ashby holds for the person. */
const NAME = 'Test Person';
const EMAIL = 'test.person@example.com';
const NUMBER_RAW = '+91 98123 45670';
const NUMBER_E164 = '+919812345670';

/** What the person might have TYPED (distinct from everything Ashby holds). */
const TYPED = { name: 'Typed Zebra', email: 'typed.zebra@example.test', phone: '+919900112233' };
const TYPED_FRAGMENTS = ['Typed Zebra', 'Zebra', 'typed.zebra', 'example.test', '9900112233', '99001'];

const NOW_ISO = '2026-12-01T04:00:00.000Z';
const NOW_MS = Date.parse(NOW_ISO);

const INPUT: R1PublicImportInput = { applicationId: APP, ashbyCandidateId: PERSON };

const RPC_KEYS = [
  'p_ashby_application_id',
  'p_ashby_candidate_id',
  'p_ashby_job_id',
  'p_ashby_stage_id',
  'p_name',
  'p_email',
  'p_phone_e164',
  'p_now',
] as const;

const ASHBY_CATEGORIES = Object.keys({
  invalid_request: true,
  logical_failure: true,
  http_client_error: true,
  rate_limited: true,
  http_server_error: true,
  malformed_response: true,
  timeout: true,
  network: true,
  output_limit: true,
  retry_exhausted: true,
} satisfies Record<AshbyErrorCategory, true>) as AshbyErrorCategory[];

// ── Ashby payloads ───────────────────────────────────────────────────────────

const contact = (value: string, isPrimary = true) => ({ value, type: 'Personal', isPrimary });
const read = (results: unknown) => ({ results, moreDataAvailable: false });

function without(object: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
  const copy = { ...object };
  for (const name of keys) delete copy[name];
  return copy;
}

/** An `application.info` result: Active, on JOB at STAGE, the person embedded with another name. */
function applicationResults(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: APP,
    status: 'Active',
    candidate: { id: PERSON, name: 'Embedded Name' },
    job: { id: JOB },
    currentInterviewStage: { id: STAGE },
    ...over,
  };
}

/** A `candidate.info` result for the person: reachable, not flagged, listing APP. */
function candidateResults(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PERSON,
    name: NAME,
    doNotContact: false,
    fraudStatus: 'NotFraudulent',
    primaryEmailAddress: contact(EMAIL),
    emailAddresses: [contact(EMAIL)],
    primaryPhoneNumber: contact(NUMBER_RAW),
    phoneNumbers: [contact(NUMBER_RAW)],
    applicationIds: [APP],
    ...over,
  };
}

// ── Doubles ──────────────────────────────────────────────────────────────────

interface AshbyCall {
  readonly op: 'applicationInfo' | 'candidateInfo';
  readonly args: unknown[];
}

/** A fake Ashby: each read answers its reply, or throws it when it is an Error. */
function fakeAshby(applicationReply: unknown, candidateReply: unknown) {
  const calls: AshbyCall[] = [];
  const reply = (op: AshbyCall['op'], value: unknown) =>
    vi.fn(async (...args: unknown[]) => {
      calls.push({ op, args });
      if (value instanceof Error) throw value;
      return value;
    });
  const ashby = {
    applicationInfo: reply('applicationInfo', applicationReply),
    candidateInfo: reply('candidateInfo', candidateReply),
  };
  return { ashby: ashby as unknown as R1PublicImportDeps['ashby'], calls };
}

type Answer = { data: unknown; error: unknown };
type Responder = Answer | Error | (() => Answer | Error);
interface RpcCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly options: unknown;
}

/** Records every `rpc` call; any table read throws; `throwOnCall` makes `rpc` itself throw. */
function fakeDb(responder: Responder, options: { throwOnCall?: boolean } = {}) {
  const calls: RpcCall[] = [];
  const db = {
    from() {
      throw new Error('the import reads no table');
    },
    rpc(name: string, args: Record<string, unknown>, rpcOptions?: unknown) {
      if (options.throwOnCall) throw new Error(`driver detail ${NAME} ${EMAIL} ${NUMBER_E164}`);
      calls.push({ name, args, options: rpcOptions });
      const answer = typeof responder === 'function' ? responder() : responder;
      return {
        then: (resolve: (value: Answer) => unknown, reject: (reason: unknown) => unknown) =>
          (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)).then(resolve, reject),
      };
    },
  };
  return { db: db as unknown as typeof supabase, calls };
}

interface LogLine {
  readonly level: 'info' | 'warn' | 'error';
  readonly meta: R1MeetLogMeta;
}

function recordingLog() {
  const lines: LogLine[] = [];
  const log: R1MeetLog = {
    info: (meta) => lines.push({ level: 'info', meta }),
    warn: (meta) => lines.push({ level: 'warn', meta }),
    error: (meta) => lines.push({ level: 'error', meta }),
  };
  return { log, lines };
}

const answer = (data: unknown): Answer => ({ data, error: null });
const IMPORTED = { status: 'imported', candidate_id: CAND, application_link_id: LINK };

interface WorldOptions {
  app?: unknown;
  cand?: unknown;
  db?: Responder;
  throwOnCall?: boolean;
  now?: () => number;
}

function world(o: WorldOptions = {}) {
  const ashby = fakeAshby(
    'app' in o ? o.app : read(applicationResults()),
    'cand' in o ? o.cand : read(candidateResults()),
  );
  const db = fakeDb('db' in o ? (o.db as Responder) : answer(IMPORTED), { throwOnCall: o.throwOnCall });
  const { log, lines } = recordingLog();
  const deps: R1PublicImportDeps = { db: db.db, ashby: ashby.ashby, now: o.now ?? (() => NOW_MS), log };
  return {
    deps,
    ashbyCalls: ashby.calls,
    rpcCalls: db.calls,
    lines,
    ops: () => ashby.calls.map((call) => call.op),
    run: (input: R1PublicImportInput = INPUT) => importR1PublicApplication(deps, input),
  };
}

const failedLine = (errorType: string, httpStatus?: number): LogLine => ({
  level: 'error',
  meta:
    httpStatus === undefined
      ? { error_category: 'r1_meet_public_import_failed', error_type: errorType }
      : { error_category: 'r1_meet_public_import_failed', error_type: errorType, http_status: httpStatus },
});

const refusedWith = (reason: string) => ({ status: 'refused', reason });

/** The args of the one RPC call, and that there was exactly one. */
function onlyRpcArgs(rpcCalls: readonly RpcCall[]): Record<string, unknown> {
  expect(rpcCalls).toHaveLength(1);
  expect(rpcCalls[0]!.name).toBe('r1_meet_public_import_application');
  return rpcCalls[0]!.args;
}

async function expectDbError(promise: Promise<unknown>, label?: string): Promise<void> {
  const error = await promise.then(
    (value) => {
      throw new Error(`expected r1_meet_db_error, got ${JSON.stringify(value)} (${label ?? ''})`);
    },
    (reason: unknown) => reason,
  );
  expect(error, label).toBeInstanceOf(R1MeetJobError);
  expect((error as R1MeetJobError).code, label).toBe('r1_meet_db_error');
  expect((error as Error).message, label).toBe('r1_meet_db_error');
  const shown = [String(error), JSON.stringify(error), (error as Error).message].join(' ');
  for (const fragment of [NAME, EMAIL, '9812345670', APP, PERSON, CAND]) {
    expect(shown, `${label ?? ''}: ${fragment}`).not.toContain(fragment);
  }
}

// ── (1) The happy path ───────────────────────────────────────────────────────

describe('(1) importing one application', () => {
  it('reads application.info then candidate.info, and calls the RPC once with exactly the eight parameters', async () => {
    const w = world();
    const result = await w.run();

    expect(result).toEqual({ status: 'imported', candidateId: CAND });
    expect(Object.keys(result)).toEqual(['status', 'candidateId']);
    expect(Object.isFrozen(result)).toBe(true);

    expect(w.ashbyCalls).toEqual([
      { op: 'applicationInfo', args: [APP] },
      { op: 'candidateInfo', args: [PERSON] },
    ]);
    const args = onlyRpcArgs(w.rpcCalls);
    expect(Object.keys(args)).toEqual([...RPC_KEYS]);
    expect(args).toEqual({
      p_ashby_application_id: APP,
      p_ashby_candidate_id: PERSON,
      p_ashby_job_id: JOB,
      p_ashby_stage_id: STAGE,
      p_name: NAME,
      p_email: EMAIL,
      p_phone_e164: NUMBER_E164,
      p_now: NOW_ISO,
    });
    expect(w.rpcCalls[0]!.options).toBeUndefined();
    expect(w.lines).toEqual([]);
  });

  it('an existing link answers exists with its candidate, lower-cased; nothing is logged', async () => {
    const w = world({ db: answer({ status: 'exists', candidate_id: cand(7).toUpperCase(), application_link_id: LINK }) });
    const result = await w.run();
    expect(result).toEqual({ status: 'exists', candidateId: cand(7) });
    expect(Object.isFrozen(result)).toBe(true);
    expect(w.lines).toEqual([]);
  });

  it('sends the ids as application.info spells them, and reads candidate.info by that id', async () => {
    const appAsAshby = APP.toUpperCase();
    const personAsAshby = PERSON.toUpperCase();
    const w = world({
      app: read(applicationResults({ id: appAsAshby, candidate: { id: personAsAshby } })),
      cand: read(candidateResults({ id: personAsAshby, applicationIds: [appAsAshby] })),
    });
    expect(await w.run()).toEqual({ status: 'imported', candidateId: CAND });
    expect(w.ashbyCalls).toEqual([
      { op: 'applicationInfo', args: [APP] },
      { op: 'candidateInfo', args: [personAsAshby] },
    ]);
    const args = onlyRpcArgs(w.rpcCalls);
    expect(args.p_ashby_application_id).toBe(appAsAshby);
    expect(args.p_ashby_candidate_id).toBe(personAsAshby);
  });

  it('reads an application nested under `application`, and sends a missing stage as null', async () => {
    const nested = { application: without(applicationResults(), 'currentInterviewStage') };
    const w = world({ app: read(nested) });
    expect(await w.run()).toEqual({ status: 'imported', candidateId: CAND });
    const args = onlyRpcArgs(w.rpcCalls);
    expect(args.p_ashby_stage_id).toBeNull();
    expect(args.p_ashby_job_id).toBe(JOB);
  });

  it('takes the name and email from candidate.info, and the clock once, as an ISO instant', async () => {
    const now = vi.fn(() => NOW_MS + 1234);
    const w = world({ now });
    await w.run();
    const args = onlyRpcArgs(w.rpcCalls);
    expect(args.p_name).toBe(NAME);
    expect(args.p_email).toBe(EMAIL);
    expect(args.p_now).toBe('2026-12-01T04:00:01.234Z');
    expect(now).toHaveBeenCalledTimes(1);
  });

  it('without a log, a failure goes to the structured r1-meet logger at error level', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const w = world();
      const result = await importR1PublicApplication({ ...w.deps, log: undefined }, {
        applicationId: 'not-a-uuid',
        ashbyCandidateId: PERSON,
      });
      expect(result).toEqual(refusedWith('invalid'));
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const line = String(errorSpy.mock.calls[0]?.[0]);
      expect(line).toContain('r1_meet_public_import_failed');
      expect(line).toContain('input_invalid');
      expect(line).not.toContain(PERSON);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

// ── (2) Typed values never reach the RPC ─────────────────────────────────────

describe('(2) a typed form value never reaches the RPC or a log', () => {
  it('extra typed keys cast into the input are ignored: every RPC value is Ashby\'s', async () => {
    const w = world();
    const input = { ...INPUT, ...TYPED, phoneE164: TYPED.phone, nowIso: NOW_ISO } as unknown as R1PublicImportInput;
    expect(await w.run(input)).toEqual({ status: 'imported', candidateId: CAND });
    const args = onlyRpcArgs(w.rpcCalls);
    expect(args.p_name).toBe(NAME);
    expect(args.p_email).toBe(EMAIL);
    expect(args.p_phone_e164).toBe(NUMBER_E164);
    const shown = JSON.stringify([w.rpcCalls, w.ashbyCalls, w.lines]);
    for (const fragment of TYPED_FRAGMENTS) expect(shown, fragment).not.toContain(fragment);
  });

  it('also on every failure path: nothing typed in a log line', async () => {
    const input = { ...INPUT, ...TYPED } as unknown as R1PublicImportInput;
    const worlds = [
      world({ app: new AshbyError('timeout') }),
      world({ cand: read(candidateResults({ id: PERSON2 })) }),
      world({ db: answer({ status: 'invalid_request', field: 'email' }) }),
    ];
    for (const w of worlds) await w.run(input);
    const shown = JSON.stringify(worlds.map((w) => [w.lines, w.rpcCalls, w.ashbyCalls]));
    for (const fragment of TYPED_FRAGMENTS) expect(shown, fragment).not.toContain(fragment);
  });

  it('the input type has no typed field (compile-time pin)', () => {
    function typeOnly(deps: R1PublicImportDeps): void {
      // @ts-expect-error the import input has no email: a typed value cannot be passed in
      void importR1PublicApplication(deps, { applicationId: APP, ashbyCandidateId: PERSON, email: TYPED.email });
      // @ts-expect-error nor a phone
      void importR1PublicApplication(deps, { applicationId: APP, ashbyCandidateId: PERSON, phone: TYPED.phone });
    }
    expect(typeof typeOnly).toBe('function');
  });

  it('the store sends only the eight named fields, never an extra key of its input', async () => {
    const db = fakeDb(answer(IMPORTED));
    const input = {
      applicationId: APP,
      ashbyCandidateId: PERSON,
      jobId: JOB,
      stageId: null,
      name: null,
      email: null,
      phoneE164: null,
      nowIso: NOW_ISO,
      typedEmail: TYPED.email,
      p_typed: TYPED.phone,
    } as unknown as R1PublicImportRpcInput;
    await callR1PublicImportRpc(db.db, input);
    const args = onlyRpcArgs(db.calls);
    expect(Object.keys(args)).toEqual([...RPC_KEYS]);
    expect(JSON.stringify(args)).not.toContain('zebra');
    expect(JSON.stringify(args)).not.toContain('9900112233');
  });
});

// ── (3) Every refusal and its call pattern ───────────────────────────────────

describe('(3) refusals', () => {
  it.each(R1_PUBLIC_IMPORT_REFUSAL_CODES.map((code) => [code]))(
    'the RPC refusal %s is the same reason, with no log line',
    async (code) => {
      const w = world({ db: answer({ status: 'refused', code }) });
      expect(await w.run()).toEqual(refusedWith(code));
      expect(w.rpcCalls).toHaveLength(1);
      expect(w.ops()).toEqual(['applicationInfo', 'candidateInfo']);
      expect(w.lines).toEqual([]);
    },
  );

  type StatusCase = [label: string, results: Record<string, unknown>];
  it.each<StatusCase>([
    ['Archived', applicationResults({ status: 'Archived' })],
    ['Hired', applicationResults({ status: 'Hired' })],
    ['Lead', applicationResults({ status: 'Lead' })],
    ['active in lower case', applicationResults({ status: 'active' })],
    ['a missing status', without(applicationResults(), 'status')],
    ['a status that is not text', applicationResults({ status: 1 })],
    ['a 64-character cut value starting Active', applicationResults({ status: `Active${'x'.repeat(100)}` })],
  ])('not_active for %s: no candidate.info, no RPC, no log', async (_label, results) => {
    const w = world({ app: read(results) });
    expect(await w.run()).toEqual(refusedWith('not_active'));
    expect(w.ops()).toEqual(['applicationInfo']);
    expect(w.rpcCalls).toEqual([]);
    expect(w.lines).toEqual([]);
  });

  type FlagCase = [label: string, candidate: Record<string, unknown>];
  it.each<FlagCase>([
    ['doNotContact true', candidateResults({ doNotContact: true })],
    ['doNotContact missing', without(candidateResults(), 'doNotContact')],
    ['doNotContact not a boolean', candidateResults({ doNotContact: 'false' })],
    ['fraud Fraudulent', candidateResults({ fraudStatus: 'Fraudulent' })],
    ['fraud Unsure', candidateResults({ fraudStatus: 'Unsure' })],
    ['an unknown fraud status', candidateResults({ fraudStatus: 'SomethingNew' })],
    ['no primary email (only the list)', without(candidateResults(), 'primaryEmailAddress')],
    ['a blank primary email', candidateResults({ primaryEmailAddress: contact('   ') })],
    ['a primary email that is not an address', candidateResults({ primaryEmailAddress: contact('not-an-email') })],
  ])('candidate_flagged for %s: nothing is written, no log', async (_label, candidate) => {
    const w = world({ cand: read(candidate) });
    expect(await w.run()).toEqual(refusedWith('candidate_flagged'));
    expect(w.ops()).toEqual(['applicationInfo', 'candidateInfo']);
    expect(w.rpcCalls).toEqual([]);
    expect(w.lines).toEqual([]);
  });

  it.each(ASHBY_CATEGORIES.map((category) => [category]))(
    'ashby_unavailable when application.info fails with %s: logged with its status number',
    async (category) => {
      const w = world({ app: new AshbyError(category, { httpStatus: 503 }) });
      expect(await w.run()).toEqual(refusedWith('ashby_unavailable'));
      expect(w.ops()).toEqual(['applicationInfo']);
      expect(w.rpcCalls).toEqual([]);
      expect(w.lines).toEqual([failedLine(`application_info:${category}`, 503)]);
    },
  );

  it.each(ASHBY_CATEGORIES.map((category) => [category]))(
    'ashby_unavailable when candidate.info fails with %s: logged with its status number',
    async (category) => {
      const w = world({ cand: new AshbyError(category, { httpStatus: 429 }) });
      expect(await w.run()).toEqual(refusedWith('ashby_unavailable'));
      expect(w.ops()).toEqual(['applicationInfo', 'candidateInfo']);
      expect(w.rpcCalls).toEqual([]);
      expect(w.lines).toEqual([failedLine(`candidate_info:${category}`, 429)]);
    },
  );

  it('an Ashby error without a status number logs no http_status', async () => {
    const w = world({ app: new AshbyError('network') });
    expect(await w.run()).toEqual(refusedWith('ashby_unavailable'));
    expect(w.lines).toEqual([failedLine('application_info:network')]);
  });

  it('a throw that is not an AshbyError is :unexpected, and its text never reaches the log', async () => {
    const leaky = new Error(`boom ${NAME} ${EMAIL} ${NUMBER_E164} https://app.ashbyhq.com/x`);
    const first = world({ app: leaky });
    expect(await first.run()).toEqual(refusedWith('ashby_unavailable'));
    expect(first.lines).toEqual([failedLine('application_info:unexpected')]);
    const second = world({ cand: leaky });
    expect(await second.run()).toEqual(refusedWith('ashby_unavailable'));
    expect(second.lines).toEqual([failedLine('candidate_info:unexpected')]);
    expect(JSON.stringify([first.lines, second.lines])).not.toMatch(/boom|ashbyhq|@|\+91/);
  });

  type InputCase = [label: string, input: unknown, now?: () => number];
  it.each<InputCase>([
    ['an application id that is not a UUID', { applicationId: 'not-a-uuid', ashbyCandidateId: PERSON }],
    ['an empty application id', { applicationId: '', ashbyCandidateId: PERSON }],
    ['a padded application id', { applicationId: ` ${APP}`, ashbyCandidateId: PERSON }],
    ['a candidate id that is not a UUID', { applicationId: APP, ashbyCandidateId: 'person-1' }],
    ['ids that are not text', { applicationId: 1, ashbyCandidateId: null }],
    ['no candidate id', { applicationId: APP }],
    ['no application id', { ashbyCandidateId: PERSON }],
    ['no input at all', null],
    ['a clock that gives NaN', INPUT, () => Number.NaN],
    ['a clock that gives Infinity', INPUT, () => Number.POSITIVE_INFINITY],
    ['a clock past the date range', INPUT, () => 1e20],
    ['a clock that throws', INPUT, () => { throw new Error(`clock ${EMAIL}`); }],
  ])('invalid for %s: no Ashby call, one input_invalid line', async (_label, input, now) => {
    const w = world(now ? { now } : {});
    expect(await w.run(input as R1PublicImportInput)).toEqual(refusedWith('invalid'));
    expect(w.ashbyCalls).toEqual([]);
    expect(w.rpcCalls).toEqual([]);
    expect(w.lines).toEqual([failedLine('input_invalid')]);
  });

  type ApplicationCase = [label: string, reply: unknown, errorType: string];
  it.each<ApplicationCase>([
    ['another application id', read(applicationResults({ id: APP2 })), 'application_mismatch'],
    ['another candidate id', read(applicationResults({ candidate: { id: PERSON2 } })), 'application_mismatch'],
    ['no job id', read(without(applicationResults(), 'job')), 'application_unreadable'],
    ['no application id', read(without(applicationResults(), 'id')), 'application_unreadable'],
    ['no candidate id', read(without(applicationResults(), 'candidate')), 'application_unreadable'],
    ['results that are not an object', read(null), 'application_unreadable'],
    ['an answer with no results', {}, 'application_unreadable'],
    ['no answer at all', undefined, 'application_unreadable'],
  ])('invalid for an application.info with %s: no candidate.info, no RPC', async (_label, reply, errorType) => {
    const w = world({ app: reply });
    expect(await w.run()).toEqual(refusedWith('invalid'));
    expect(w.ops()).toEqual(['applicationInfo']);
    expect(w.rpcCalls).toEqual([]);
    expect(w.lines).toEqual([failedLine(errorType)]);
  });

  type CandidateCase = [label: string, reply: unknown, errorType: string];
  it.each<CandidateCase>([
    ['an id that is not a UUID', read(candidateResults({ id: 'person-1' })), 'candidate_unreadable'],
    ['no application id list', read(without(candidateResults(), 'applicationIds')), 'candidate_unreadable'],
    ['results that are not an object', read([candidateResults()]), 'candidate_unreadable'],
    ['no answer at all', undefined, 'candidate_unreadable'],
    ['another person', read(candidateResults({ id: PERSON2 })), 'candidate_mismatch'],
    ['an application list without this application', read(candidateResults({ applicationIds: [APP2] })), 'application_not_listed'],
  ])('invalid for a candidate.info with %s: no RPC', async (_label, reply, errorType) => {
    const w = world({ cand: reply });
    expect(await w.run()).toEqual(refusedWith('invalid'));
    expect(w.ops()).toEqual(['applicationInfo', 'candidateInfo']);
    expect(w.rpcCalls).toEqual([]);
    expect(w.lines).toEqual([failedLine(errorType)]);
  });

  it.each(R1_PUBLIC_IMPORT_INVALID_FIELDS.map((field) => [field]))(
    'invalid for an RPC invalid_request on %s, logged with the field',
    async (field) => {
      const w = world({ db: answer({ status: 'invalid_request', field }) });
      expect(await w.run()).toEqual(refusedWith('invalid'));
      expect(w.rpcCalls).toHaveLength(1);
      expect(w.lines).toEqual([failedLine(`rpc_invalid_request:${field}`)]);
    },
  );
});

// ── (4) The number and the name ──────────────────────────────────────────────

describe('(4) only a dialable number and a name that reads as one are sent', () => {
  type PhoneCase = [label: string, candidate: Record<string, unknown>];
  it.each<PhoneCase>([
    ['a placeholder (one digit repeated)', candidateResults({ primaryPhoneNumber: contact('+91 99999 99999'), phoneNumbers: [] })],
    ['a placeholder (a descending run)', candidateResults({ primaryPhoneNumber: contact('+91 98765 43210'), phoneNumbers: [] })],
    ['a placeholder (a digit and nine zeros)', candidateResults({ primaryPhoneNumber: contact('+91 90000 00000'), phoneNumbers: [] })],
    ['an invalid number', candidateResults({ primaryPhoneNumber: contact('12345'), phoneNumbers: [] })],
    ['a landline', candidateResults({ primaryPhoneNumber: contact('+91 22 2345 6789'), phoneNumbers: [] })],
    ['a foreign mobile', candidateResults({ primaryPhoneNumber: contact('+44 7700 900123'), phoneNumbers: [] })],
    ['no number at all', without(candidateResults(), 'primaryPhoneNumber', 'phoneNumbers')],
    ['a bad primary beside a good secondary', candidateResults({ primaryPhoneNumber: contact('12345'), phoneNumbers: [contact(NUMBER_RAW, false)] })],
  ])('%s: p_phone_e164 is null and the import goes on', async (_label, candidate) => {
    const w = world({ cand: read(candidate) });
    expect(await w.run()).toEqual({ status: 'imported', candidateId: CAND });
    expect(onlyRpcArgs(w.rpcCalls).p_phone_e164).toBeNull();
  });

  it('a secondary number is used only when there is no primary', async () => {
    const w = world({ cand: read(candidateResults({ primaryPhoneNumber: null, phoneNumbers: [contact(NUMBER_RAW, false)] })) });
    await w.run();
    expect(onlyRpcArgs(w.rpcCalls).p_phone_e164).toBe(NUMBER_E164);
  });

  type NameCase = [label: string, candidate: Record<string, unknown>];
  it.each<NameCase>([
    ['a name with three digits', candidateResults({ name: 'Agent 007 Person' })],
    ['a name that is an email', candidateResults({ name: 'someone@example.com' })],
    ['a name of punctuation only', candidateResults({ name: '...' })],
  ])('%s: p_name is null and the import goes on', async (_label, candidate) => {
    const w = world({ cand: read(candidate) });
    expect(await w.run()).toEqual({ status: 'imported', candidateId: CAND });
    expect(onlyRpcArgs(w.rpcCalls).p_name).toBeNull();
  });
});

// ── (5) Database failures ────────────────────────────────────────────────────

describe('(5) a database failure or an answer outside the contract throws r1_meet_db_error', () => {
  type DbCase = [label: string, responder: Responder | 'throw'];
  const cases: DbCase[] = [
    ['a database error', { data: null, error: { message: `db ${EMAIL}` } }],
    ['a database error beside a well-formed answer', { data: IMPORTED, error: { message: 'db' } }],
    ['a rejected call', new Error(`network ${NAME}`)],
    ['a throwing builder', 'throw'],
    ['an unknown status', answer({ status: 'ok' })],
    ['an extra key', answer({ ...IMPORTED, name: NAME })],
    ['a missing key', answer({ status: 'imported', candidate_id: CAND })],
    ['a candidate id that is not a UUID', answer({ ...IMPORTED, candidate_id: 'cand-1' })],
    ['a link id that is not a UUID', answer({ ...IMPORTED, application_link_id: 42 })],
    ['an exists answer with an extra key', answer({ status: 'exists', candidate_id: CAND, application_link_id: LINK, x: 1 })],
    ['an unknown refusal code', answer({ status: 'refused', code: 'nope' })],
    ['a refusal with an extra key', answer({ status: 'refused', code: 'dsar_hold', candidate_id: CAND })],
    ['a refusal with no code', answer({ status: 'refused' })],
    ['an unknown field', answer({ status: 'invalid_request', field: 'typed_email' })],
    ['an invalid_request with no field', answer({ status: 'invalid_request' })],
    ['a null answer', answer(null)],
    ['an array answer', answer([IMPORTED])],
    ['a text answer', answer('imported')],
    ['no answer object', null as unknown as Answer],
  ];
  it.each(cases)('%s: one rpc_failed line, then the throw', async (_label, responder) => {
    const w = world(responder === 'throw' ? { throwOnCall: true } : { db: responder });
    await expectDbError(w.run(), _label);
    expect(w.lines).toEqual([failedLine('rpc_failed')]);
  });

  it('the store alone: lower-cased ids, frozen answers, and the same one code for every failure', async () => {
    const base: R1PublicImportRpcInput = {
      applicationId: APP,
      ashbyCandidateId: PERSON,
      jobId: JOB,
      stageId: STAGE,
      name: NAME,
      email: EMAIL,
      phoneE164: NUMBER_E164,
      nowIso: NOW_ISO,
    };
    const upper = await callR1PublicImportRpc(
      fakeDb(answer({ status: 'imported', candidate_id: CAND.toUpperCase(), application_link_id: LINK.toUpperCase() })).db,
      base,
    );
    expect(upper).toEqual({ status: 'imported', candidateId: CAND, applicationLinkId: LINK });
    expect(Object.isFrozen(upper)).toBe(true);
    for (const code of R1_PUBLIC_IMPORT_REFUSAL_CODES) {
      const out = await callR1PublicImportRpc(fakeDb(answer({ status: 'refused', code })).db, base);
      expect(out).toEqual({ status: 'refused', code });
      expect(Object.isFrozen(out)).toBe(true);
    }
    for (const field of R1_PUBLIC_IMPORT_INVALID_FIELDS) {
      const out = await callR1PublicImportRpc(fakeDb(answer({ status: 'invalid_request', field })).db, base);
      expect(out).toEqual({ status: 'invalid_request', field });
    }
    for (const [label, responder] of cases) {
      const db = responder === 'throw' ? fakeDb(answer(IMPORTED), { throwOnCall: true }) : fakeDb(responder);
      await expectDbError(callR1PublicImportRpc(db.db, base), label);
    }
    await expectDbError(callR1PublicImportRpc(fakeDb(answer(IMPORTED)).db, null as unknown as R1PublicImportRpcInput), 'null input');
  });
});

// ── (6) As the real client sends it ──────────────────────────────────────────

describe('(6) the call as the real Supabase client sends it', () => {
  function realDb(reply: unknown) {
    const requests: Array<{ method: string; url: URL; body: unknown }> = [];
    const client = createClient('https://db.example.invalid', 'k'.repeat(40), {
      auth: { persistSession: false, autoRefreshToken: false },
      db: { schema: 'screening_v2' },
      global: {
        fetch: async (input: unknown, init?: { method?: string; body?: unknown }) => {
          requests.push({ method: init?.method ?? 'GET', url: new URL(String(input)), body: init?.body ?? null });
          return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
        },
      },
    });
    return { db: client as unknown as typeof supabase, requests };
  }

  it('one POST to the RPC; the eight keys in the body, nothing in the URL', async () => {
    const { db, requests } = realDb(IMPORTED);
    const w = world();
    const result = await importR1PublicApplication({ ...w.deps, db }, { ...INPUT, ...TYPED } as unknown as R1PublicImportInput);
    expect(result).toEqual({ status: 'imported', candidateId: CAND });

    expect(requests).toHaveLength(1);
    const [request] = requests as [(typeof requests)[number]];
    expect(request.method).toBe('POST');
    expect(request.url.pathname).toBe('/rest/v1/rpc/r1_meet_public_import_application');
    expect(request.url.search).toBe('');
    const url = decodeURIComponent(request.url.href);
    for (const fragment of [...TYPED_FRAGMENTS, NAME, EMAIL, '9812345670', APP, PERSON, JOB]) {
      expect(url, fragment).not.toContain(fragment);
    }
    const body = JSON.parse(String(request.body)) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual([...RPC_KEYS]);
    expect(body).toEqual({
      p_ashby_application_id: APP,
      p_ashby_candidate_id: PERSON,
      p_ashby_job_id: JOB,
      p_ashby_stage_id: STAGE,
      p_name: NAME,
      p_email: EMAIL,
      p_phone_e164: NUMBER_E164,
      p_now: NOW_ISO,
    });
    for (const fragment of TYPED_FRAGMENTS) expect(String(request.body), fragment).not.toContain(fragment);
  });

  it('a PostgREST error answer from the real client is r1_meet_db_error', async () => {
    const requests: unknown[] = [];
    const client = createClient('https://db.example.invalid', 'k'.repeat(40), {
      auth: { persistSession: false, autoRefreshToken: false },
      db: { schema: 'screening_v2' },
      global: {
        fetch: async (input: unknown) => {
          requests.push(input);
          return new Response(JSON.stringify({ code: 'PGRST202', message: `missing ${EMAIL}` }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          });
        },
      },
    });
    const w = world();
    await expectDbError(importR1PublicApplication({ ...w.deps, db: client as unknown as typeof supabase }, INPUT));
    expect(requests).toHaveLength(1);
    expect(w.lines).toEqual([failedLine('rpc_failed')]);
  });
});

// ── (7) The log lines ────────────────────────────────────────────────────────

describe('(7) every log line is closed and carries no personal data', () => {
  const CLOSED_TYPES: ReadonlySet<string> = new Set([
    'input_invalid',
    ...ASHBY_CATEGORIES.map((category) => `application_info:${category}`),
    'application_info:unexpected',
    ...ASHBY_CATEGORIES.map((category) => `candidate_info:${category}`),
    'candidate_info:unexpected',
    'application_unreadable',
    'application_mismatch',
    'candidate_unreadable',
    'candidate_mismatch',
    'application_not_listed',
    ...R1_PUBLIC_IMPORT_INVALID_FIELDS.map((field) => `rpc_invalid_request:${field}`),
    'rpc_failed',
  ]);

  it('across every failing path: error level, the alert word, a closed type, at most a status number', async () => {
    const leaky = new Error(`boom ${NAME} ${EMAIL} ${NUMBER_E164}`);
    const scenarios: WorldOptions[] = [
      { now: () => Number.NaN },
      { app: new AshbyError('http_server_error', { httpStatus: 502 }) },
      { app: leaky },
      { cand: new AshbyError('rate_limited', { httpStatus: 429 }) },
      { cand: leaky },
      { app: read(without(applicationResults(), 'job')) },
      { app: read(applicationResults({ id: APP2 })) },
      { cand: read(candidateResults({ id: 'person-1' })) },
      { cand: read(candidateResults({ id: PERSON2 })) },
      { cand: read(candidateResults({ applicationIds: [APP2] })) },
      ...R1_PUBLIC_IMPORT_INVALID_FIELDS.map((field) => ({ db: answer({ status: 'invalid_request', field }) })),
      { db: { data: null, error: { message: `db ${EMAIL}` } } },
      { db: answer({ ...IMPORTED, name: NAME }) },
    ];
    const lines: LogLine[] = [];
    for (const scenario of scenarios) {
      const w = world(scenario);
      await w.run({ ...INPUT, ...TYPED } as unknown as R1PublicImportInput).catch(() => undefined);
      expect(w.lines, JSON.stringify(Object.keys(scenario))).toHaveLength(1);
      lines.push(...w.lines);
    }
    expect(lines).toHaveLength(scenarios.length);
    const seen = new Set<string>();
    for (const line of lines) {
      expect(line.level).toBe('error');
      const keys = Object.keys(line.meta);
      expect(keys.every((name) => ['error_category', 'error_type', 'http_status'].includes(name)), keys.join()).toBe(true);
      expect(line.meta.error_category).toBe('r1_meet_public_import_failed');
      expect(line.meta.error_category).toBe(R1_PUBLIC_IMPORT_ALERTS[0]);
      expect(CLOSED_TYPES.has(line.meta.error_type ?? ''), line.meta.error_type).toBe(true);
      if ('http_status' in line.meta) expect(Number.isInteger(line.meta.http_status)).toBe(true);
      seen.add(line.meta.error_type ?? '');
    }
    expect(seen.size).toBeGreaterThanOrEqual(10);
    const shown = JSON.stringify(lines);
    expect(shown).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/);
    expect(shown).not.toMatch(/\+91|\d{10}/);
    expect(shown).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    for (const fragment of [NAME, 'Embedded Name', 'boom', JOB, STAGE, ...TYPED_FRAGMENTS]) {
      expect(shown, fragment).not.toContain(fragment);
    }
  });

  it('every closed type is a safe identifier the structured logger keeps (at most 64 characters)', () => {
    for (const type of CLOSED_TYPES) expect(type, type).toMatch(/^[a-zA-Z0-9_:.-]{1,64}$/);
  });

  it('success and a refusal that is a fact about the person log nothing', async () => {
    const quiet: WorldOptions[] = [
      {},
      { db: answer({ status: 'exists', candidate_id: CAND, application_link_id: LINK }) },
      ...R1_PUBLIC_IMPORT_REFUSAL_CODES.map((code) => ({ db: answer({ status: 'refused', code }) })),
      { app: read(applicationResults({ status: 'Archived' })) },
      { cand: read(candidateResults({ doNotContact: true })) },
    ];
    for (const scenario of quiet) {
      const w = world(scenario);
      await w.run();
      expect(w.lines).toEqual([]);
    }
  });
});

// ── (8) Parity with migration 0144 ───────────────────────────────────────────

const here = path.dirname(fileURLToPath(import.meta.url));
const M0144 = readFileSync(
  path.resolve(here, '../../../supabase/migrations/0144_r1_meet_public_import.sql'),
  'utf8',
).replace(/\r\n/g, '\n');

/** The import RPC's text, header to `$$;`, with SQL line comments removed. */
function importFunction(): string {
  const start = M0144.indexOf('create or replace function screening_v2.r1_meet_public_import_application(');
  expect(start).toBeGreaterThan(0);
  const end = M0144.indexOf('\n$$;\n', start);
  expect(end).toBeGreaterThan(start);
  return M0144.slice(start, end).replace(/--[^\n]*/g, '');
}

const distinct = (values: string[]): string[] => [...new Set(values)];

describe('(8) parity with migration 0144', () => {
  it('the RPC name, and its parameters in signature order are the keys the store sends', async () => {
    expect(R1_PUBLIC_IMPORT_RPC).toBe('r1_meet_public_import_application');
    const text = importFunction();
    const header = text.slice(0, text.indexOf('returns jsonb'));
    const params = [...header.matchAll(/^\s+(p_[a-z0-9_]+)\s+(?:text|timestamptz)\b/gm)].map((m) => m[1]!);
    expect(params).toEqual([...RPC_KEYS]);
    expect(header).toContain('p_now timestamptz default now()');

    const w = world();
    await w.run();
    expect(Object.keys(onlyRpcArgs(w.rpcCalls))).toEqual(params);
  });

  it('the refusal codes and the invalid fields are the RPC\'s, in its order', () => {
    const text = importFunction();
    const codes = distinct([...text.matchAll(/'code', '([a-z_]+)'/g)].map((m) => m[1]!));
    const fields = distinct([...text.matchAll(/'field', '([a-z_]+)'/g)].map((m) => m[1]!));
    expect([...R1_PUBLIC_IMPORT_REFUSAL_CODES]).toEqual(codes);
    expect([...R1_PUBLIC_IMPORT_INVALID_FIELDS]).toEqual(fields);
    const statuses = new Set([...text.matchAll(/'status', '([a-z_]+)'/g)].map((m) => m[1]!));
    expect(statuses).toEqual(new Set(['invalid_request', 'refused', 'exists', 'imported']));
    expect(text).toContain("'status', 'imported', 'candidate_id', v_candidate_id::text,");
    expect(text).toMatch(/'status', 'exists', 'candidate_id', v_link_candidate::text,\s+'application_link_id', v_link_id::text\)/);
  });

  it('every RPC code is an import refusal, and the lists are frozen and exact', () => {
    for (const code of R1_PUBLIC_IMPORT_REFUSAL_CODES) expect(R1_PUBLIC_IMPORT_REFUSALS).toContain(code);
    expect([...R1_PUBLIC_IMPORT_REFUSALS]).toEqual([
      'mapping_unavailable',
      'application_terminal',
      'link_unbound',
      'not_active',
      'dsar_hold',
      'candidate_ineligible',
      'candidate_flagged',
      'ashby_unavailable',
      'invalid',
    ]);
    for (const list of [R1_PUBLIC_IMPORT_REFUSALS, R1_PUBLIC_IMPORT_REFUSAL_CODES, R1_PUBLIC_IMPORT_INVALID_FIELDS, R1_PUBLIC_IMPORT_ALERTS]) {
      expect(Object.isFrozen(list)).toBe(true);
    }
  });
});

// ── (9) Alerts ───────────────────────────────────────────────────────────────

describe('(9) alerts', () => {
  it('the two closed words; the unmapped-job word is S04\'s', () => {
    expect([...R1_PUBLIC_IMPORT_ALERTS]).toEqual(['r1_meet_public_import_failed', 'r1_meet_public_unmapped_job']);
    expect(R1_PUBLIC_IMPORT_ALERTS[0]).toBe('r1_meet_public_import_failed');
    expect(R1_PUBLIC_IMPORT_ALERTS[1]).toBe(r1PublicMatchAlert('unmapped_job'));
  });

  it('r1PublicImportAlert names the unmapped-job alert for mapping_unavailable only', () => {
    for (const reason of R1_PUBLIC_IMPORT_REFUSALS) {
      const result: R1PublicImportResult = { status: 'refused', reason };
      expect(r1PublicImportAlert(result), reason).toBe(reason === 'mapping_unavailable' ? 'r1_meet_public_unmapped_job' : null);
    }
    expect(r1PublicImportAlert({ status: 'imported', candidateId: CAND })).toBeNull();
    expect(r1PublicImportAlert({ status: 'exists', candidateId: CAND })).toBeNull();
  });

  it('a mapping_unavailable end to end: no log line here, the alert comes from the result', async () => {
    const w = world({ db: answer({ status: 'refused', code: 'mapping_unavailable' }) });
    const result = await w.run();
    expect(result).toEqual(refusedWith('mapping_unavailable'));
    expect(w.lines).toEqual([]);
    expect(r1PublicImportAlert(result)).toBe('r1_meet_public_unmapped_job');
  });
});
