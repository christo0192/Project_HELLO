import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../supabase', () => ({ supabase: { auth: { getSession: vi.fn() } } }));

import { istWallClockUtcIso } from '../ist-datetime';
import {
  parseBookConsentTemplate,
  parseBooked,
  parseBookSlots,
  parseCancelled,
  parseConsented,
  parseManage,
  parseMoved,
  R1_BOOK_CONTRACT,
  R1_BOOK_ERROR_WORDS,
  R1_BOOK_ROUTES,
  r1BookApi,
  type R1BookConsentInput,
  type R1BookRouteContract,
  type R1BookRouteName,
  type R1BookSubmission,
} from './r1-book-api';

/**
 * The web side of the public booking contract (M035 S07; `.gsd/milestones/M035/contracts/
 * public-contracts.md` section 6, served by S06). `R1_BOOK_CONTRACT` in r1-book-api.ts is the one
 * statement of what the /book and /book/manage pages depend on; this suite keeps it, the client
 * and the server's spec from drifting apart in three layers:
 *
 *   1. r1BookApi really sends what R1_BOOK_CONTRACT declares (method, path, the exact body keys,
 *      the nested consent keys), credential-free, uncached and without a referrer, with every
 *      token and typed value in the body only;
 *   2. the parsers require exactly the declared response fields, no more and no less;
 *   3. app/api/openapi/openapi.yaml documents every route, request field, nested consent field,
 *      required response field and error word (with its status), and some non-test app/api/src
 *      source answers each word.
 *
 * Pending, then strict (D-S07-M21): the web lands before the API, so the seven routes are excused
 * ONLY while the spec documents none of them. The moment it documents any `/api/r1/book*` path
 * the allowance switches off for all seven and every check applies, with no web edit. The real
 * spec test always runs (it is never skipped); the checker itself is proven on synthetic specs
 * below, so a check that excuses today is not an untested one.
 *
 * Self-contained on purpose: the YAML readers and the API source walk are copied from
 * r1-contract.test.ts (not imported), so the two suites can change independently. Tokens are
 * built at run time (gitleaks).
 */

const NAMES = Object.keys(R1_BOOK_ROUTES) as R1BookRouteName[];

const DAY_1 = '2026-09-16';
const DAY_2 = '2026-09-17';
const ISSUED_AT = Date.UTC(2026, 8, 16, 6, 30);
const GRID_TOKEN = `g1.${ISSUED_AT}.${'g'.repeat(43)}`;
const MANAGE_TOKEN = `${'m'.repeat(21)}_-${'k'.repeat(20)}`;
const REQUEST_ID = ['3f2b8c1e', '9a4d', '4c7b', '8e2f', '1a2b3c4d5e6f'].join('-');
const TEMPLATE_VERSION = 'r1-public-2026-11';
const TYPED = { name: 'Asha Rao', email: 'asha.rao@example.com', phone: '+91 98765 43210' };

const at = (date: string, hour: number, minute: number): string =>
  istWallClockUtcIso(date, hour, minute);
const plus45 = (iso: string): string => new Date(Date.parse(iso) + 45 * 60_000).toISOString();

const START = at(DAY_1, 9, 0);
const LATER = at(DAY_2, 20, 30);

// ── Layer 1: the client sends what the contract declares ─────────────────────────────────────

/** Every declared response field of each route, required and optional, and nothing else. */
const FULL_RESPONSES: Record<R1BookRouteName, Record<string, unknown>> = {
  consentTemplate: {
    version: TEMPLATE_VERSION,
    locale: 'en-IN',
    title: 'Interview notice',
    body_md: 'Dex is an AI interviewer.\n\nThe interview is recorded.',
    required_consents: ['ai_interview', 'recording'],
    consent_items: [
      { type: 'ai_interview', label: 'I agree to an AI interview' },
      { type: 'recording', label: 'I agree to the recording' },
    ],
  },
  slots: {
    timezone: 'Asia/Kolkata',
    slot_minutes: 45,
    generated_at: new Date(ISSUED_AT).toISOString(),
    grid_token: GRID_TOKEN,
    fully_booked: false,
    days: [
      { date: DAY_1, slots: [{ start_at: START, end_at: plus45(START), available: true }] },
      { date: DAY_2, slots: [{ start_at: LATER, end_at: plus45(LATER), available: false }] },
    ],
  },
  book: { status: 'booked', start_at: START, end_at: plus45(START) },
  manage: {
    state: 'booked',
    start_at: START,
    end_at: plus45(START),
    can_move: true,
    can_cancel: true,
    moves_left: 2,
    consent_current: true,
  },
  move: { status: 'moved', start_at: LATER, end_at: plus45(LATER) },
  cancel: { status: 'cancelled' },
  consent: { status: 'consented' },
};

const consentInput = (): R1BookConsentInput => ({
  template_version: TEMPLATE_VERSION,
  consents: ['ai_interview', 'recording'],
  in_india: true,
});

function submission(): R1BookSubmission {
  return {
    request_id: REQUEST_ID,
    name: `  ${TYPED.name} `,
    email: ` ${TYPED.email}  `,
    phone: `\t${TYPED.phone} `,
    slot_start: START,
    grid_token: GRID_TOKEN,
    consent: consentInput(),
    website: '',
  };
}

/** A caller object carrying keys the contract does not declare: none may reach the body. */
function withExtras<T extends object>(value: T): T {
  return { ...value, meet_url: 'meet.example/abc-defg-hij', candidate_id: 'cand-1', seats: 3 } as T;
}

interface Invocation {
  label: string;
  run: () => Promise<unknown>;
}

/** Every way the pages call each route. */
const INVOCATIONS: Record<R1BookRouteName, Invocation[]> = {
  consentTemplate: [{ label: 'the notice', run: () => r1BookApi.consentTemplate() }],
  slots: [{ label: 'the grid', run: () => r1BookApi.slots() }],
  book: [
    { label: 'a person', run: () => r1BookApi.book(submission()) },
    {
      label: 'the honeypot filled',
      run: () => r1BookApi.book({ ...submission(), website: 'filled by a bot' }),
    },
    {
      label: 'caller objects with undeclared keys',
      run: () => r1BookApi.book(withExtras({ ...submission(), consent: withExtras(consentInput()) })),
    },
  ],
  manage: [{ label: 'read the booking', run: () => r1BookApi.manage(MANAGE_TOKEN) }],
  move: [{ label: 'move', run: () => r1BookApi.move(MANAGE_TOKEN, LATER, GRID_TOKEN) }],
  cancel: [
    { label: 'keep the consent', run: () => r1BookApi.cancel(MANAGE_TOKEN, false) },
    { label: 'withdraw the consent too', run: () => r1BookApi.cancel(MANAGE_TOKEN, true) },
  ],
  consent: [
    { label: 're-consent', run: () => r1BookApi.consent(MANAGE_TOKEN, consentInput()) },
    {
      label: 'a consent object with undeclared keys',
      run: () => r1BookApi.consent(MANAGE_TOKEN, withExtras(consentInput())),
    },
  ],
};

/** Tokens and typed or chosen values: never in a URL, raw or percent-encoded. */
const NEVER_IN_URL = [
  MANAGE_TOKEN,
  GRID_TOKEN,
  REQUEST_ID,
  TEMPLATE_VERSION,
  TYPED.name,
  TYPED.email,
  TYPED.phone,
  START,
  LATER,
].flatMap((value) => [value, encodeURIComponent(value)]);

function mockFetch(status: number, body: unknown) {
  const fetchMock = vi.fn().mockImplementation(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe('r1BookApi sends what R1_BOOK_CONTRACT declares', () => {
  beforeEach(() => {
    (globalThis as { __resetNetworkCount?: () => void }).__resetNetworkCount?.();
  });

  it('declares exactly the routes of R1_BOOK_ROUTES, each on its own /api/r1/book path', () => {
    expect(Object.keys(R1_BOOK_CONTRACT)).toEqual(Object.keys(R1_BOOK_ROUTES));
    for (const name of NAMES) {
      expect(R1_BOOK_CONTRACT[name].path, name).toBe(R1_BOOK_ROUTES[name]);
      expect(R1_BOOK_CONTRACT[name].path.startsWith('/api/r1/book'), name).toBe(true);
    }
    expect(new Set(NAMES.map((name) => R1_BOOK_CONTRACT[name].path)).size).toBe(NAMES.length);
  });

  it('reads with a bodiless GET and acts with a POST, and nests consent keys only under consent', () => {
    for (const name of NAMES) {
      const contract = R1_BOOK_CONTRACT[name];
      const isRead = name === 'consentTemplate' || name === 'slots';
      expect(contract.method, name).toBe(isRead ? 'GET' : 'POST');
      if (isRead) expect(contract.request, name).toEqual([]);
      else expect(contract.request.length, name).toBeGreaterThan(0);
      expect(contract.consentKeys.length > 0, name).toBe(contract.request.includes('consent'));
      expect(INVOCATIONS[name].length, name).toBeGreaterThan(0);
    }
  });

  for (const name of NAMES) {
    const contract = R1_BOOK_CONTRACT[name];
    for (const invocation of INVOCATIONS[name]) {
      it(`${name} (${invocation.label}) uses the declared method, path and body`, async () => {
        const fetchMock = mockFetch(name === 'book' ? 201 : 200, FULL_RESPONSES[name]);
        await invocation.run();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(init.method).toBe(contract.method);
        expect(url.endsWith(contract.path)).toBe(true);
        expect(url).not.toContain('?');
        expect(url).not.toContain('#');
        for (const value of NEVER_IN_URL) expect(url, 'a value in the URL').not.toContain(value);
        expect(init.credentials).toBe('omit');
        expect(init.cache).toBe('no-store');
        expect(init.referrerPolicy).toBe('no-referrer');
        const headers = Object.keys((init.headers ?? {}) as Record<string, string>).map((header) =>
          header.toLowerCase(),
        );
        expect(headers).not.toContain('authorization');
        if (contract.method === 'GET') {
          expect(init.body).toBeUndefined();
          expect(headers).not.toContain('content-type');
        } else {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          expect(Object.keys(body).sort()).toEqual([...contract.request].sort());
          if (contract.consentKeys.length > 0) {
            expect(Object.keys(body.consent as object).sort()).toEqual(
              [...contract.consentKeys].sort(),
            );
          }
        }
      });
    }
  }
});

// ── Layer 2: the parsers require exactly the declared response fields ────────────────────────

type Parser = (data: unknown) => unknown;

const PARSERS: Record<R1BookRouteName, Parser> = {
  consentTemplate: parseBookConsentTemplate,
  slots: parseBookSlots,
  book: parseBooked,
  manage: parseManage,
  move: parseMoved,
  cancel: parseCancelled,
  consent: parseConsented,
};

describe('the booking parsers read exactly the declared response fields', () => {
  it('has a parser for every route, and every route returns data', () => {
    expect(Object.keys(PARSERS).sort()).toEqual([...NAMES].sort());
    for (const name of NAMES) {
      expect(R1_BOOK_CONTRACT[name].response.length, name).toBeGreaterThan(0);
    }
  });

  for (const name of NAMES) {
    const contract = R1_BOOK_CONTRACT[name];
    const parse = PARSERS[name];
    const full = FULL_RESPONSES[name];

    it(`${name}: the sample carries exactly the declared fields and parses`, () => {
      expect(Object.keys(full).sort()).toEqual(
        [...contract.response, ...contract.responseOptional].sort(),
      );
      expect(() => parse(full)).not.toThrow();
    });

    for (const field of contract.response) {
      it(`${name}: a response without required ${field} is rejected`, () => {
        const { [field]: _removed, ...rest } = full;
        expect(() => parse(rest)).toThrow(
          expect.objectContaining({ message: 'r1_malformed_response' }),
        );
      });
    }

    for (const field of contract.responseOptional) {
      it(`${name}: a response without optional ${field} is accepted`, () => {
        const { [field]: _removed, ...rest } = full;
        expect(() => parse(rest)).not.toThrow();
      });
    }
  }
});

// ── Layer 3: openapi.yaml documents the contract ─────────────────────────────────────────────

/** A line-oriented reading of an OpenAPI YAML file: enough to find blocks, not to evaluate them. */
function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** The lines of the block headed by `key:` at exactly `indent`, or null when absent. */
function nested(source: string[], key: string, indent: number): string[] | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const header = new RegExp(`^ {${indent}}${escaped}:(\\s|$)`);
  const start = source.findIndex((line) => header.test(line));
  if (start === -1) return null;
  const body: string[] = [source[start]];
  for (const line of source.slice(start + 1)) {
    if (line.trim() !== '' && indentOf(line) <= indent) break;
    body.push(line);
  }
  return body;
}

/**
 * A reference to a shared schema or a shared response. (r1-contract.test.ts follows schemas
 * only; the booking routes may also share a `components/responses` entry for the 503 answers.)
 */
const COMPONENT_REF = /#\/components\/(schemas|responses)\/([A-Za-z0-9_]+)/g;

function componentBlock(spec: string[], kind: string, name: string): string[] | null {
  const components = nested(spec, 'components', 0);
  const group = components ? nested(components, kind, 2) : null;
  return group ? nested(group, name, 4) : null;
}

/** The text plus every `#/components/{schemas,responses}/X` it references, transitively. */
function closure(spec: string[], text: string[]): string {
  const seen = new Set<string>();
  const parts: string[] = [text.join('\n')];
  const queue = [...text.join('\n').matchAll(COMPONENT_REF)];
  while (queue.length > 0) {
    const match = queue.shift();
    if (!match) continue;
    const key = `${match[1]}/${match[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const block = componentBlock(spec, match[1], match[2]);
    if (!block) continue;
    parts.push(block.join('\n'));
    queue.push(...block.join('\n').matchAll(COMPONENT_REF));
  }
  return parts.join('\n');
}

function hasProperty(text: string, field: string): boolean {
  return new RegExp(`(^|[\\s{,])['"]?${field}['"]?\\s*:`, 'm').test(text);
}

function isRequired(text: string, field: string): boolean {
  const inline = [...text.matchAll(/required:\s*\[([^\]]*)\]/g)].some((match) =>
    match[1]
      .split(',')
      .map((item) => item.trim().replace(/['"]/g, ''))
      .includes(field),
  );
  const dash = `[ \\t]*-[ \\t]*`;
  const block = new RegExp(
    `required:[ \\t]*\\n(?:${dash}\\S+[ \\t]*\\n)*?${dash}['"]?${field}['"]?[ \\t]*(?:\\n|$)`,
  ).test(text);
  return inline || block;
}

/** The text of the 2xx entries under `responses:`, or all of `responses:` for a flow mapping. */
function successResponses(operation: string[]): string[] {
  const responses = nested(operation, 'responses', 6);
  if (!responses) return [];
  const entries: string[][] = [];
  let current: string[] | null = null;
  for (const line of responses.slice(1)) {
    if (line.trim() !== '' && indentOf(line) === 8) {
      current = /^\s*['"]?2\d\d['"]?\s*:/.test(line) ? [] : null;
      if (current) entries.push(current);
    }
    current?.push(line);
  }
  return entries.length > 0 ? entries.map((entry) => entry.join('\n')) : [responses.join('\n')];
}

/** The status codes an operation documents as keys under `responses:` (`'404':` or `404:`). */
function documentedStatuses(operation: string[]): Set<number> {
  const statuses = new Set<number>();
  for (const line of nested(operation, 'responses', 6)?.slice(1) ?? []) {
    const match = /^ {8}['"]?(\d{3})['"]?\s*:/.exec(line);
    if (match) statuses.add(Number(match[1]));
  }
  return statuses;
}

/** True when the operation is documented as public (`security: []`), as section 6 requires. */
function documentsPublic(operation: string[]): boolean {
  return operation.some((line) => /^ {6}security:\s*\[\s*\]\s*$/.test(line));
}

/**
 * The seven booking routes the web calls before the server documents them (M035 S06 serves them
 * behind R1_MEET_PUBLIC_BOOKING_ENABLED). The pages are dark without them: today the API answers
 * them 401, which the pages show as "temporarily unavailable".
 */
const BOOK_PENDING: ReadonlySet<R1BookRouteName> = new Set<R1BookRouteName>([
  'consentTemplate',
  'slots',
  'book',
  'manage',
  'move',
  'cancel',
  'consent',
]);

/**
 * True once the spec documents any `/api/r1/book*` path under `paths:`: one of the seven, or any
 * other (a renamed route also switches the allowance off, so the rename is caught). A mention in
 * prose or outside `paths:` is not a documented path.
 */
function documentsAnyBookRoute(specText: string): boolean {
  const paths = nested(splitLines(specText), 'paths', 0) ?? [];
  return paths.some((line) => /^ {2}['"]?\/api\/r1\/book/.test(line));
}

/** The allowance for a spec (D-S07-M21): all seven while it documents none, else none. */
function allowanceFor(specText: string): ReadonlySet<R1BookRouteName> {
  return documentsAnyBookRoute(specText) ? new Set<R1BookRouteName>() : BOOK_PENDING;
}

const API_SOURCE_ROOT = resolve(process.cwd(), '..', 'api', 'src');

/** Every non-test `.ts` file under `dir` (no `__tests__` folder, no `*.test.ts`). */
function apiSourceFiles(dir: string = API_SOURCE_ROOT): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__' && entry.name !== 'node_modules') files.push(...apiSourceFiles(path));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(path);
    }
  }
  return files;
}

let realApiSources: readonly string[] | null = null;

/** The text of every non-test app/api/src source, read once and only when a check needs it. */
function apiSources(): readonly string[] {
  realApiSources ??= apiSourceFiles().map((file) => readFileSync(file, 'utf8'));
  return realApiSources;
}

/** True when some source quotes `word` exactly, in any quote style (a longer name is not it). */
function answered(sources: readonly string[], word: string): boolean {
  const quoted = new RegExp(`(['"\`])${word}\\1`);
  return sources.some((source) => quoted.test(source));
}

/**
 * Everything wrong between `specText` and R1_BOOK_CONTRACT, as readable lines. A route in
 * `pending` that the spec does not document is not a problem; one it does document is checked in
 * full: method, `security: []`, the request (none for a GET), each nested consent field, each
 * required and optional response field, and for each `(status, word)` the route declares: the
 * word named inside that path's block (with what it references), the status documented under
 * `responses:`, and the word quoted by some non-test app/api/src source (`sources`, read from the
 * real tree when not given, and only for a documented route).
 */
function bookContractProblems(
  specText: string,
  pending: ReadonlySet<R1BookRouteName> = new Set(),
  sources: readonly string[] | null = null,
): string[] {
  const spec = splitLines(specText);
  const paths = nested(spec, 'paths', 0) ?? [];
  const problems: string[] = [];
  const unanswered: string[] = [];
  for (const name of NAMES) {
    const contract: R1BookRouteContract = R1_BOOK_CONTRACT[name];
    const method = contract.method.toLowerCase();
    const where = `${contract.method} ${contract.path}`;
    const pathBlock = nested(paths, contract.path, 2);
    if (!pathBlock) {
      if (!pending.has(name)) problems.push(`${where}: path is not documented`);
      continue;
    }
    const operation = nested(pathBlock, method, 4);
    if (!operation) {
      problems.push(`${where}: ${method} is not documented on the path`);
      continue;
    }
    if (!documentsPublic(operation)) problems.push(`${where}: is not documented as public (security: [])`);
    const requestBody = nested(operation, 'requestBody', 6);
    if (contract.request.length === 0) {
      if (requestBody) problems.push(`${where}: documents a request body, but the client sends none`);
    } else {
      const requestText = closure(spec, requestBody ?? []);
      for (const field of contract.request) {
        if (!hasProperty(requestText, field)) problems.push(`${where}: request lacks ${field}`);
      }
      for (const key of contract.consentKeys) {
        if (!hasProperty(requestText, key)) problems.push(`${where}: request lacks consent.${key}`);
      }
    }
    const responseText = successResponses(operation)
      .map((entry) => closure(spec, entry.split('\n')))
      .join('\n');
    for (const field of contract.response) {
      if (!hasProperty(responseText, field)) {
        problems.push(`${where}: response lacks ${field}`);
      } else if (!isRequired(responseText, field)) {
        problems.push(`${where}: response does not mark ${field} required`);
      }
    }
    for (const field of contract.responseOptional) {
      if (!hasProperty(responseText, field)) problems.push(`${where}: response lacks optional ${field}`);
    }
    const named = closure(spec, pathBlock);
    const statuses = documentedStatuses(operation);
    const reportedWords = new Set<string>();
    const reportedStatuses = new Set<number>();
    for (const [status, word] of contract.errors) {
      if (!reportedWords.has(word) && !new RegExp(`\\b${word}\\b`).test(named)) {
        reportedWords.add(word);
        problems.push(`${where}: the spec does not name ${word}`);
      }
      if (!reportedStatuses.has(status) && !statuses.has(status)) {
        reportedStatuses.add(status);
        problems.push(`${where}: response ${status} is not documented`);
      }
      if (!unanswered.includes(word) && !answered(sources ?? apiSources(), word)) {
        unanswered.push(word);
      }
    }
  }
  return [...problems, ...unanswered.map((word) => `${word}: no app/api/src source answers it`)];
}

const SPEC_PATH = resolve(process.cwd(), '..', 'api', 'openapi', 'openapi.yaml');
const REAL_SPEC = readFileSync(SPEC_PATH, 'utf8');
/** True once S06 (or anything) documents a `/api/r1/book*` path: then all seven are strict. */
const SPEC_DOCUMENTS_BOOK = documentsAnyBookRoute(REAL_SPEC);

describe('openapi.yaml documents the public booking contract', () => {
  it('finds the real spec and its candidate routes', () => {
    expect(REAL_SPEC).toContain('openapi: 3.0.3');
    expect(REAL_SPEC).toMatch(/^paths:/m);
    expect(/^ {2}\/api\/r1\/status:/m.test(REAL_SPEC)).toBe(true);
  });

  it(
    'documents every booking route, field and error word the pages rely on ' +
      `(${SPEC_DOCUMENTS_BOOK ? 'strict: the spec documents booking routes' : 'pending: the spec documents no booking route yet, so all seven are excused'})`,
    () => {
      expect(
        bookContractProblems(REAL_SPEC, SPEC_DOCUMENTS_BOOK ? new Set() : BOOK_PENDING),
      ).toEqual([]);
    },
    30_000,
  );

  it('walks only the non-test API sources for the error words', () => {
    const files = apiSourceFiles().map((file) => relative(API_SOURCE_ROOT, file).replace(/\\/g, '/'));
    expect(files).toContain('routes/r1-candidate.ts');
    expect(files.filter((file) => /\.test\.ts$|(^|\/)__tests__\//.test(file))).toEqual([]);
    expect(files.every((file) => file.endsWith('.ts'))).toBe(true);
  });
});

// The checker is proven on synthetic specs, so it can be trusted the day it switches on.

interface BookRouteParts {
  /** False leaves the path out of the spec. */
  documented: boolean;
  path: string;
  operation: string;
  /** Whether the operation documents a requestBody (by default: only when the client sends one). */
  requestBody: boolean;
  /** False leaves `security: []` out. */
  isPublic: boolean;
  request: string[];
  consentKeys: string[];
  response: string[];
  required: string[];
  /** The words each documented refusal status names in its description, by status. */
  refusals: Map<number, string[]>;
  /** Words the operation names in its own description. */
  described: string[];
}

type BookMutation = (name: R1BookRouteName, parts: BookRouteParts) => void;

function refusalsOf(contract: R1BookRouteContract): Map<number, string[]> {
  const byStatus = new Map<number, string[]>();
  for (const [status, word] of contract.errors) {
    byStatus.set(status, [...(byStatus.get(status) ?? []), word]);
  }
  return byStatus;
}

const schemaName = (name: R1BookRouteName): string =>
  `R1Book${name[0].toUpperCase()}${name.slice(1)}`;
const property = (key: string): string => `        ${key}: { type: string }`;

/** A spec that documents the contract in the house style, changed by `mutate`. */
function syntheticBookSpec(mutate: BookMutation = () => undefined): string {
  const paths: string[] = [
    'paths:',
    '  /api/r1/status:',
    '    post:',
    "      description: 'an unrelated candidate route'",
  ];
  const schemas: string[] = [
    'components:',
    '  schemas:',
    '    R1BookError:',
    '      type: object',
    '      additionalProperties: false',
    '      required: [error]',
    '      properties:',
    property('error'),
  ];
  for (const name of NAMES) {
    const contract = R1_BOOK_CONTRACT[name];
    const parts: BookRouteParts = {
      documented: true,
      path: contract.path,
      operation: contract.method.toLowerCase(),
      requestBody: contract.request.length > 0,
      isPublic: true,
      request: [...contract.request],
      consentKeys: [...contract.consentKeys],
      response: [...contract.response, ...contract.responseOptional],
      required: [...contract.response],
      refusals: refusalsOf(contract),
      described: [],
    };
    mutate(name, parts);
    if (!parts.documented) continue;
    const schema = schemaName(name);
    const ref = (suffix: string): string => `'#/components/schemas/${schema}${suffix}'`;
    paths.push(`  ${parts.path}:`, `    ${parts.operation}:`, '      tags: [r1]');
    if (parts.isPublic) paths.push('      security: []');
    if (parts.described.length > 0) {
      paths.push(`      description: 'notes: ${parts.described.join(', ')}'`);
    }
    if (parts.requestBody) {
      paths.push(
        '      requestBody:',
        '        required: true',
        '        content:',
        '          application/json:',
        '            schema:',
        `              $ref: ${ref('Request')}`,
      );
    }
    paths.push(
      '      responses:',
      `        '${name === 'book' ? 201 : 200}':`,
      '          description: ok',
      '          content:',
      '            application/json:',
      '              schema:',
      `                $ref: ${ref('Response')}`,
    );
    for (const [status, words] of parts.refusals) {
      paths.push(
        `        '${status}':`,
        `          description: 'refused: ${words.join(', ')}'`,
        '          content:',
        '            application/json:',
        '              schema:',
        "                $ref: '#/components/schemas/R1BookError'",
      );
    }
    if (parts.requestBody) {
      schemas.push(
        `    ${schema}Request:`,
        '      type: object',
        '      additionalProperties: false',
        `      required: [${contract.request.join(', ')}]`,
        '      properties:',
        ...parts.request.map((key) =>
          key === 'consent' ? `        consent: { $ref: ${ref('Consent')} }` : property(key),
        ),
      );
      if (contract.consentKeys.length > 0) {
        schemas.push(
          `    ${schema}Consent:`,
          '      type: object',
          '      additionalProperties: false',
          `      required: [${contract.consentKeys.join(', ')}]`,
          '      properties:',
          ...parts.consentKeys.map(property),
        );
      }
    }
    schemas.push(
      `    ${schema}Response:`,
      '      type: object',
      ...(parts.required.length > 0
        ? ['      required:', ...parts.required.map((field) => `        - ${field}`)]
        : []),
      '      properties:',
      ...parts.response.map(property),
    );
  }
  paths.push('  /api/health:', '    get:', "      description: 'liveness'");
  return ['openapi: 3.0.3', ...paths, ...schemas, ''].join('\n');
}

const without = (list: string[], item: string): string[] => list.filter((entry) => entry !== item);

/** One source that answers every word the pages act on. */
const ANSWERING: readonly string[] = [
  R1_BOOK_ERROR_WORDS.map((word) => `refuse(res, 409, '${word}');`).join('\n'),
];

const notDocumented = (name: R1BookRouteName): string =>
  `${R1_BOOK_CONTRACT[name].method} ${R1_BOOK_CONTRACT[name].path}: path is not documented`;

describe('the booking contract checker', () => {
  it('accepts a spec that documents the contract', () => {
    const spec = syntheticBookSpec();
    expect(documentsAnyBookRoute(spec)).toBe(true);
    expect(bookContractProblems(spec, new Set(), ANSWERING)).toEqual([]);
    expect(bookContractProblems(spec, allowanceFor(spec), ANSWERING)).toEqual([]);
  });

  it('reads block-style and inline required lists alike', () => {
    expect(isRequired('required:\n  - a\n  - b\n', 'b')).toBe(true);
    expect(isRequired('required: [a, "b"]', 'b')).toBe(true);
    expect(isRequired('required: [a]', 'b')).toBe(false);
    expect(isRequired('required:\n  - a\nproperties:\n  b: x\n', 'b')).toBe(false);
  });

  it('follows shared schemas and shared responses, and reads quoted and bare status keys', () => {
    const spec = splitLines(
      [
        'components:',
        '  responses:',
        '    R1BookOff:',
        "      description: 'booking_disabled'",
        '  schemas:',
        '    R1BookWords:',
        '      enum: [not_found]',
        '',
      ].join('\n'),
    );
    expect(closure(spec, ["$ref: '#/components/responses/R1BookOff'"])).toContain('booking_disabled');
    expect(closure(spec, ["$ref: '#/components/schemas/R1BookWords'"])).toContain('not_found');
    expect(closure(spec, ["$ref: '#/components/schemas/R1BookOff'"])).not.toContain('booking_disabled');
    const operation = [
      '    post:',
      '      responses:',
      '        404:',
      '          description: x',
      "        '409':",
      '          description: the 503 is not a key here',
    ];
    expect([...documentedStatuses(operation)]).toEqual([404, 409]);
  });

  it('names a route the spec does not document, and excuses it only while no booking route is documented', () => {
    const spec = syntheticBookSpec((name, parts) => {
      if (name === 'consentTemplate') parts.documented = false;
    });
    expect(bookContractProblems(spec, new Set(), ANSWERING)).toEqual([notDocumented('consentTemplate')]);
    // Six documented routes switch the allowance off: the seventh is not excused.
    expect(bookContractProblems(spec, allowanceFor(spec), ANSWERING)).toEqual([
      notDocumented('consentTemplate'),
    ]);
    const none = syntheticBookSpec((_name, parts) => {
      parts.documented = false;
    });
    expect(documentsAnyBookRoute(none)).toBe(false);
    expect(bookContractProblems(none, new Set(), ANSWERING)).toEqual(NAMES.map(notDocumented));
    expect(bookContractProblems(none, allowanceFor(none), ANSWERING)).toEqual([]);
    // Nothing documented, nothing checked against the sources either.
    expect(bookContractProblems(none, allowanceFor(none), [])).toEqual([]);
  });

  it('one documented booking route switches the allowance off for all seven', () => {
    const one = syntheticBookSpec((name, parts) => {
      if (name !== 'slots') parts.documented = false;
    });
    expect(documentsAnyBookRoute(one)).toBe(true);
    expect(allowanceFor(one).size).toBe(0);
    expect(bookContractProblems(one, allowanceFor(one), ANSWERING)).toEqual(
      NAMES.filter((name) => name !== 'slots').map(notDocumented),
    );
    // Only the words of the documented route are looked for in the sources.
    expect(bookContractProblems(one, allowanceFor(one), [])).toEqual([
      ...NAMES.filter((name) => name !== 'slots').map(notDocumented),
      'booking_disabled: no app/api/src source answers it',
      'temporarily_unavailable: no app/api/src source answers it',
    ]);
    // A booking path that is not one of the seven (a renamed route) switches it off too.
    const renamed = syntheticBookSpec((name, parts) => {
      if (name === 'consentTemplate') parts.path = '/api/r1/book/notice';
      else parts.documented = false;
    });
    expect(documentsAnyBookRoute(renamed)).toBe(true);
    expect(bookContractProblems(renamed, allowanceFor(renamed), ANSWERING)).toEqual(
      NAMES.map(notDocumented),
    );
  });

  it('does not take an unrelated route, prose or a component for a documented booking path', () => {
    expect(documentsAnyBookRoute('openapi: 3.0.3\npaths:\n  /api/r1/status:\n    post: {}\n')).toBe(false);
    expect(
      documentsAnyBookRoute(
        "openapi: 3.0.3\npaths:\n  /api/r1/status:\n    post:\n      description: 'see /api/r1/book'\n",
      ),
    ).toBe(false);
    expect(
      documentsAnyBookRoute(
        'openapi: 3.0.3\npaths:\n  /api/health:\n    get: {}\ncomponents:\n  /api/r1/book:\n    x: 1\n',
      ),
    ).toBe(false);
    expect(documentsAnyBookRoute('openapi: 3.0.3\npaths:\n  /api/r1/book:\n    post: {}\n')).toBe(true);
  });

  it('names a route documented under the wrong method', () => {
    const spec = syntheticBookSpec((name, parts) => {
      if (name === 'slots') parts.operation = 'post';
      if (name === 'book') parts.operation = 'put';
    });
    expect(bookContractProblems(spec, new Set(), ANSWERING)).toEqual([
      'GET /api/r1/book/slots: get is not documented on the path',
      'POST /api/r1/book: post is not documented on the path',
    ]);
  });

  it('names a route not documented as public, and a GET documented with a request body', () => {
    const spec = syntheticBookSpec((name, parts) => {
      if (name === 'manage') parts.isPublic = false;
      if (name === 'consentTemplate') parts.requestBody = true;
    });
    expect(bookContractProblems(spec, new Set(), ANSWERING)).toEqual([
      'GET /api/r1/book/consent-template: documents a request body, but the client sends none',
      'POST /api/r1/book/manage: is not documented as public (security: [])',
    ]);
  });

  it('names a request field the server does not accept', () => {
    const spec = syntheticBookSpec((name, parts) => {
      if (name === 'book') parts.request = without(parts.request, 'website');
      // `grid_token` is not `token`.
      if (name === 'move') parts.request = without(parts.request, 'token');
    });
    expect(bookContractProblems(spec, new Set(), ANSWERING)).toEqual([
      'POST /api/r1/book: request lacks website',
      'POST /api/r1/book/manage/move: request lacks token',
    ]);
  });

  it('names a nested consent field the server does not accept', () => {
    const spec = syntheticBookSpec((name, parts) => {
      // `consent` is not `consents`.
      if (name === 'book') parts.consentKeys = without(parts.consentKeys, 'consents');
      if (name === 'consent') parts.consentKeys = without(parts.consentKeys, 'in_india');
    });
    expect(bookContractProblems(spec, new Set(), ANSWERING)).toEqual([
      'POST /api/r1/book: request lacks consent.consents',
      'POST /api/r1/book/manage/consent: request lacks consent.in_india',
    ]);
  });

  it('names a response field the parser needs but the server does not send or may omit', () => {
    const spec = syntheticBookSpec((name, parts) => {
      if (name === 'slots') {
        parts.response = without(parts.response, 'grid_token');
        parts.required = without(parts.required, 'grid_token');
      }
      if (name === 'manage') parts.required = without(parts.required, 'moves_left');
      if (name === 'consentTemplate') parts.response = without(parts.response, 'consent_items');
    });
    expect(bookContractProblems(spec, new Set(), ANSWERING)).toEqual([
      'GET /api/r1/book/consent-template: response lacks optional consent_items',
      'GET /api/r1/book/slots: response lacks grid_token',
      'POST /api/r1/book/manage: response does not mark moves_left required',
    ]);
  });

  it('names an error word missing on its route, named only on another route, or only as a longer name', () => {
    const missing = syntheticBookSpec((name, parts) => {
      if (name === 'book') parts.refusals.set(409, ['already_booked', 'slot_unavailable']);
    });
    expect(bookContractProblems(missing, new Set(), ANSWERING)).toEqual([
      'POST /api/r1/book: the spec does not name consent_stale',
    ]);
    const elsewhere = syntheticBookSpec((name, parts) => {
      if (name === 'move') parts.refusals.set(409, ['slot_unavailable']);
      if (name === 'cancel') parts.described = ['move_not_allowed'];
    });
    expect(bookContractProblems(elsewhere, new Set(), ANSWERING)).toEqual([
      'POST /api/r1/book/manage/move: the spec does not name move_not_allowed',
    ]);
    const longer = syntheticBookSpec((name, parts) => {
      if (name === 'move') parts.refusals.set(409, ['slot_unavailable', 'move_not_allowed_v2']);
    });
    expect(bookContractProblems(longer, new Set(), ANSWERING)).toEqual([
      'POST /api/r1/book/manage/move: the spec does not name move_not_allowed',
    ]);
    // Named anywhere in the path's own block counts, e.g. the operation's description.
    const described = syntheticBookSpec((name, parts) => {
      if (name === 'move') {
        parts.refusals.set(409, ['slot_unavailable']);
        parts.described = ['move_not_allowed'];
      }
    });
    expect(bookContractProblems(described, new Set(), ANSWERING)).toEqual([]);
  });

  it('names a refusal status the route does not document', () => {
    const spec = syntheticBookSpec((name, parts) => {
      if (name !== 'manage') return;
      parts.refusals.delete(404);
      parts.described = ['not_found'];
    });
    expect(bookContractProblems(spec, new Set(), ANSWERING)).toEqual([
      'POST /api/r1/book/manage: response 404 is not documented',
    ]);
    const neither = syntheticBookSpec((name, parts) => {
      if (name === 'manage') parts.refusals.delete(404);
    });
    expect(bookContractProblems(neither, new Set(), ANSWERING)).toEqual([
      'POST /api/r1/book/manage: the spec does not name not_found',
      'POST /api/r1/book/manage: response 404 is not documented',
    ]);
  });

  it('names an error word no app/api/src source answers, once, in any quote style', () => {
    const spec = syntheticBookSpec();
    // Two routes declare cancel_not_allowed: it is reported once.
    const unanswered = [ANSWERING[0].replace("'cancel_not_allowed'", "'cancel_refused'")];
    expect(bookContractProblems(spec, new Set(), unanswered)).toEqual([
      'cancel_not_allowed: no app/api/src source answers it',
    ]);
    const otherQuotes = R1_BOOK_ERROR_WORDS.map((word, index) =>
      index % 2 === 0 ? `"${word}"` : `\`${word}\``,
    ).join(' ');
    expect(bookContractProblems(spec, new Set(), [otherQuotes])).toEqual([]);
    // A longer name is not the word; a bare mention is not an answer.
    const longer = [ANSWERING[0].replace("'not_found'", "'not_found_v2'")];
    expect(bookContractProblems(spec, new Set(), longer)).toEqual([
      'not_found: no app/api/src source answers it',
    ]);
    const bare = [ANSWERING[0].replace("'slot_unavailable'", 'slot_unavailable')];
    expect(bookContractProblems(spec, new Set(), bare)).toEqual([
      'slot_unavailable: no app/api/src source answers it',
    ]);
  });
});

describe('the pending allowance and the error words', () => {
  it('keeps the pending allowance to exactly the seven booking routes', () => {
    expect([...BOOK_PENDING]).toEqual([
      'consentTemplate',
      'slots',
      'book',
      'manage',
      'move',
      'cancel',
      'consent',
    ]);
    // A new route is not pending by default: the author must decide.
    expect([...BOOK_PENDING].sort()).toEqual([...NAMES].sort());
  });

  it('acts on exactly the nine error words of contract section 6', () => {
    expect([...R1_BOOK_ERROR_WORDS]).toEqual([
      'already_booked',
      'booking_disabled',
      'cancel_not_allowed',
      'consent_stale',
      'invalid_request',
      'move_not_allowed',
      'not_found',
      'slot_unavailable',
      'temporarily_unavailable',
    ]);
  });
});
