import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../supabase', () => ({ supabase: { auth: { getSession: vi.fn() } } }));

import {
  parseAttempt,
  parseConsentTemplate,
  parseExchange,
  parsePreflight,
  parseStatus,
  R1_CONTRACT,
  R1_FINAL_REFUSAL_CODES,
  R1_ROUTES,
  R1_SERVER_ERROR_CODES,
  R1_STATUS_VOCABULARY,
  r1Api,
  type R1RouteContract,
  type R1RouteName,
} from './r1-api';

/**
 * The web side of the R1 wire contract (plan section 8.3), reconciled with PR-3's
 * implemented routes: the shapes in r1-api.ts are the server's, and this suite
 * keeps the two from drifting apart in three layers:
 *
 *   1. r1-api.ts really sends what R1_CONTRACT declares (method, path, body);
 *   2. the `parse*` functions require exactly the response fields R1_CONTRACT
 *      declares, no more and no less;
 *   3. app/api/openapi/openapi.yaml documents every route, request field and
 *      required response field, and the status vocabularies the page accepts.
 *      This layer is SKIPPED only on a tree whose spec documents no
 *      `/api/r1/...` candidate path (the web contract is then UNVERIFIED
 *      against the server); it switches itself on the moment the spec documents
 *      one, after which a missing or mismatched route fails CI. The checker
 *      itself is proven on synthetic specs below, so a skipped layer is not an
 *      untested one.
 */

const LINK = 'a'.repeat(64);
const NONCE = 'n'.repeat(32);
const NAMES = Object.keys(R1_ROUTES) as R1RouteName[];

// ── Layer 1: the client sends what the contract declares ──────────────────────

function mockFetch(body: unknown) {
  const fetchMock = vi.fn().mockImplementation(
    async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

const FULL_RESPONSES: Record<R1RouteName, unknown> = {
  status: {
    round_status: 'invited',
    expires_at: '2026-10-10T00:00:00Z',
    availability: 'open',
    attempts_allowed: 2,
    attempts_remaining: 2,
    starts_remaining: 3,
    consent: { state: 'granted', template_version: 'v1' },
    live_attempt: false,
    can_start: true,
    role_title: 'Sales Program Advisor',
    format: { duration_minutes: 20, camera_required: true, includes_role_play: true },
    audience: 'candidate',
  },
  consentTemplate: {
    version: 'v1',
    locale: 'en-IN',
    title: 'Notice',
    body_md: 'Body',
    required_consents: ['ai_interview'],
    consent_items: [{ type: 'ai_interview', label: 'Agree' }],
  },
  consent: { status: 'granted', consents: ['ai_interview'], template_version: 'v1' },
  consentWithdraw: { ok: true, withdrawn: true, sessions_stopped: 0 },
  preflight: {
    url: 'wss://lk.invalid',
    livekit_token: 'token',
    expires_at: '2026-10-07T00:00:00Z',
    policy_version: 'r1-av-v1',
  },
  attempts: {
    attempt_token: 'attempt',
    nonce: NONCE,
    attempt_id: 'session',
    rejoin: false,
    attempt_token_expires_at: '2026-10-07T00:05:00.000Z',
  },
  exchange: {
    status: 'ready',
    url: 'wss://lk.invalid',
    livekit_token: 'token',
    expires_at: '2026-10-07T00:10:00Z',
    attempt_id: 's',
  },
  ready: { ok: true },
};

interface Invocation {
  label: string;
  run: () => Promise<unknown>;
}

/** Every way the page calls each route, so optional request fields are exercised too. */
const INVOCATIONS: Record<R1RouteName, Invocation[]> = {
  status: [{ label: 'status', run: () => r1Api.status(LINK) }],
  consentTemplate: [{ label: 'template', run: () => r1Api.consentTemplate(LINK) }],
  consent: [
    {
      label: 'grant',
      run: () =>
        r1Api.submitConsent(LINK, {
          template_version: 'v1',
          consents: ['ai_interview'],
          status: 'granted',
        }),
    },
  ],
  consentWithdraw: [{ label: 'withdraw', run: () => r1Api.withdrawConsent(LINK) }],
  preflight: [{ label: 'preflight', run: () => r1Api.preflight(LINK) }],
  attempts: [
    { label: 'new attempt', run: () => r1Api.createAttempt(LINK, null) },
    { label: 'rejoin', run: () => r1Api.createAttempt(LINK, NONCE) },
  ],
  exchange: [{ label: 'exchange', run: () => r1Api.exchange('attempt', NONCE) }],
  ready: [{ label: 'ready', run: () => r1Api.ready('attempt', NONCE) }],
};

describe('r1-api sends what R1_CONTRACT declares', () => {
  const sent = new Map<R1RouteName, Set<string>>();

  beforeEach(() => {
    (globalThis as { __resetNetworkCount?: () => void }).__resetNetworkCount?.();
  });

  it('declares exactly the routes of R1_ROUTES, each as a POST on its own path', () => {
    expect(Object.keys(R1_CONTRACT).sort()).toEqual([...NAMES].sort());
    for (const name of NAMES) {
      expect(R1_CONTRACT[name].path, name).toBe(R1_ROUTES[name]);
      expect(R1_CONTRACT[name].method, name).toBe('POST');
    }
  });

  for (const name of NAMES) {
    const contract = R1_CONTRACT[name];
    for (const invocation of INVOCATIONS[name]) {
      it(`${name} (${invocation.label}) uses the declared method, path and body`, async () => {
        const fetchMock = mockFetch(FULL_RESPONSES[name]);
        await invocation.run();
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(init.method).toBe(contract.method);
        expect(url.endsWith(contract.path)).toBe(true);
        expect(url).not.toContain('?');
        expect(url).not.toContain(LINK);
        const keys = Object.keys(JSON.parse(String(init.body)) as object);
        for (const field of contract.request) {
          expect(keys, `${name} sends ${field}`).toContain(field);
        }
        const allowed = [...contract.request, ...contract.requestOptional];
        for (const key of keys) expect(allowed, `${name} sends undeclared ${key}`).toContain(key);
        sent.set(name, new Set([...(sent.get(name) ?? []), ...keys]));
      });
    }
  }

  it('sends every optional request field in at least one call', () => {
    for (const name of NAMES) {
      for (const field of R1_CONTRACT[name].requestOptional) {
        expect(sent.get(name), `${name} never sends ${field}`).toContain(field);
      }
    }
  });
});

// ── Layer 2: the parsers require exactly the declared response fields ─────────

type Parser = (data: unknown) => unknown;

const PARSERS: Partial<Record<R1RouteName, Parser>> = {
  status: parseStatus,
  consentTemplate: parseConsentTemplate,
  preflight: parsePreflight,
  attempts: parseAttempt,
  exchange: parseExchange,
};

describe('the parse functions read exactly the declared response fields', () => {
  it('has a parser for every route that returns data', () => {
    for (const name of NAMES) {
      const returnsData = R1_CONTRACT[name].response.length > 0;
      expect(Boolean(PARSERS[name]), name).toBe(returnsData);
    }
  });

  for (const [name, parse] of Object.entries(PARSERS) as Array<[R1RouteName, Parser]>) {
    const contract = R1_CONTRACT[name];
    const full = FULL_RESPONSES[name] as Record<string, unknown>;

    it(`${name}: the sample carries every declared field and parses`, () => {
      for (const field of [...contract.response, ...contract.responseOptional]) {
        expect(Object.keys(full), field).toContain(field);
      }
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

// ── Layer 3: openapi.yaml documents the contract ──────────────────────────────

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

const SCHEMA_REF = /#\/components\/schemas\/([A-Za-z0-9_]+)/g;

function schemaBlock(spec: string[], name: string): string[] | null {
  const components = nested(spec, 'components', 0);
  const schemas = components ? nested(components, 'schemas', 2) : null;
  return schemas ? nested(schemas, name, 4) : null;
}

/** The text plus every `#/components/schemas/X` it references, transitively. */
function closure(spec: string[], text: string[]): string {
  const seen = new Set<string>();
  const parts: string[] = [text.join('\n')];
  const queue = [...text.join('\n').matchAll(SCHEMA_REF)];
  while (queue.length > 0) {
    const name = queue.shift()?.[1];
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const block = schemaBlock(spec, name);
    if (!block) continue;
    parts.push(block.join('\n'));
    queue.push(...block.join('\n').matchAll(SCHEMA_REF));
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

/**
 * Routes the web calls that the server has not shipped yet. The web may land first: while the
 * spec does not document the path the route is skipped here (and the page never shows the
 * feature, because the worker does not raise the signal that reveals it), and the moment the
 * spec documents it the route is checked like every other one. Nothing to edit when the server
 * lands; the pending allowance simply stops being used.
 *
 *   ready: "I'm ready" during the role-play briefing (R1-Q: the server relays it to the worker).
 */
const PENDING_ON_SERVER: ReadonlySet<R1RouteName> = new Set<R1RouteName>(['ready']);

/**
 * Everything wrong between `specText` and R1_CONTRACT, as readable lines. A route in `pending`
 * that the spec does not document yet is not a problem; one it does document is checked.
 */
function contractProblems(
  specText: string,
  pending: ReadonlySet<R1RouteName> = new Set(),
): string[] {
  const spec = splitLines(specText);
  const paths = nested(spec, 'paths', 0) ?? [];
  const problems: string[] = [];
  for (const name of NAMES) {
    const contract: R1RouteContract = R1_CONTRACT[name];
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
    const requestText = closure(spec, nested(operation, 'requestBody', 6) ?? []);
    for (const field of contract.request) {
      if (!hasProperty(requestText, field)) problems.push(`${where}: request lacks ${field}`);
    }
    for (const field of contract.requestOptional) {
      if (!hasProperty(requestText, field)) {
        problems.push(`${where}: request lacks optional ${field}`);
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
    // An optional field the page reads must still be one the server can send: a field the
    // spec's closed (additionalProperties: false) schema does not list is a dead contract.
    for (const field of contract.responseOptional) {
      if (!hasProperty(responseText, field)) {
        problems.push(`${where}: response lacks optional ${field}`);
      }
    }
  }
  return problems;
}

const SPEC_PATH = resolve(process.cwd(), '..', 'api', 'openapi', 'openapi.yaml');
const REAL_SPEC = readFileSync(SPEC_PATH, 'utf8');
/** True once PR-3 (or anything) documents a candidate route under /api/r1/. */
const SPEC_DOCUMENTS_R1_CANDIDATE_ROUTES = /^ {2}\/api\/r1\//m.test(REAL_SPEC);

describe('openapi.yaml documents the R1 candidate contract', () => {
  it.skipIf(!SPEC_DOCUMENTS_R1_CANDIDATE_ROUTES)(
    'documents every route, request field and required response field the web relies on ' +
      '(SKIPPED while PR-3 has not documented /api/r1/*: the contract is UNVERIFIED)',
    () => {
      expect(contractProblems(REAL_SPEC, PENDING_ON_SERVER)).toEqual([]);
    },
  );

  it.skipIf(!SPEC_DOCUMENTS_R1_CANDIDATE_ROUTES)(
    'accepts exactly the status vocabularies the spec documents (an unknown one fails closed)',
    () => {
      const spec = splitLines(REAL_SPEC);
      const operation = (nested(nested(spec, 'paths', 0) ?? [], '/api/r1/status', 2) ?? []).join(
        '\n',
      );
      const documented = (property: string): string[] | null => {
        const match = new RegExp(
          `\\b${property}:\\s*\\n\\s*type: string\\s*\\n\\s*enum: \\[([^\\]]*)\\]`,
        ).exec(operation);
        return match ? match[1].split(',').map((item) => item.trim()).sort() : null;
      };
      expect(documented('round_status')).toEqual([...R1_STATUS_VOCABULARY.round_status].sort());
      expect(documented('availability')).toEqual([...R1_STATUS_VOCABULARY.availability].sort());
      expect(documented('state')).toEqual([...R1_STATUS_VOCABULARY.consent_state].sort());
    },
  );

  it('finds the real spec, and tells candidate routes from the admin and worker ones', () => {
    expect(REAL_SPEC).toContain('openapi: 3.0.3');
    expect(REAL_SPEC).toMatch(/^paths:/m);
    // /api/internal/r1/* and /api/admin/r1/* are not candidate routes.
    expect(/^ {2}\/api\/(internal|admin)\/r1\//m.test(REAL_SPEC)).toBe(true);
  });
});

// ── The error codes the web acts on are the server's ──────────────────────────

const SERVER_SOURCE_PATH = resolve(
  process.cwd(),
  '..',
  'api',
  'src',
  'routes',
  'r1-candidate.ts',
);
const SERVER_SOURCE = existsSync(SERVER_SOURCE_PATH) ? readFileSync(SERVER_SOURCE_PATH, 'utf8') : '';
/** The candidate routes of the spec: from the first /api/r1/ path to the next, unrelated one. */
const CANDIDATE_SPEC = (() => {
  const from = REAL_SPEC.indexOf('\n  /api/r1/status:');
  const to = REAL_SPEC.indexOf('\n  /api/health:');
  return from > -1 && to > from ? REAL_SPEC.slice(from, to) : '';
})();

describe('the error codes the web acts on are the ones the server answers', () => {
  it('pins the three codes the page relies on most, by name', () => {
    for (const code of ['r1_attempt_not_live', 'consent_template_stale', 'round_expired']) {
      expect(R1_SERVER_ERROR_CODES, code).toContain(code);
    }
  });

  it.skipIf(!SPEC_DOCUMENTS_R1_CANDIDATE_ROUTES || SERVER_SOURCE === '')(
    'every code the page names is answered by r1-candidate.ts and named in the candidate spec ' +
      '(a renamed code would turn a precise message into the generic one)',
    () => {
      expect(CANDIDATE_SPEC.length).toBeGreaterThan(1000);
      const unanswered = R1_SERVER_ERROR_CODES.filter(
        (code) => !SERVER_SOURCE.includes(`'${code}'`),
      );
      const undocumented = R1_SERVER_ERROR_CODES.filter(
        (code) => !new RegExp(`\\b${code}\\b`).test(CANDIDATE_SPEC),
      );
      expect({ unanswered, undocumented }).toEqual({ unanswered: [], undocumented: [] });
    },
  );

  it.skipIf(!SPEC_DOCUMENTS_R1_CANDIDATE_ROUTES || SERVER_SOURCE === '')(
    'every code that is final for the web (so "I\'m ready" never asks again) is answered and documented',
    () => {
      const unanswered = R1_FINAL_REFUSAL_CODES.filter((code) => !SERVER_SOURCE.includes(`'${code}'`));
      const undocumented = R1_FINAL_REFUSAL_CODES.filter(
        (code) => !new RegExp(`\\b${code}\\b`).test(CANDIDATE_SPEC),
      );
      expect({ unanswered, undocumented }).toEqual({ unanswered: [], undocumented: [] });
    },
  );

  it('would notice a code that is no longer there', () => {
    const answered = (code: string, source: string) => source.includes(`'${code}'`);
    expect(answered('r1_attempt_not_live', "refuse(res, 409, 'r1_attempt_not_live');")).toBe(true);
    expect(answered('r1_attempt_not_live', "refuse(res, 409, 'r1_attempt_gone');")).toBe(false);
    const named = (code: string, text: string) => new RegExp(`\\b${code}\\b`).test(text);
    expect(named('round_expired', '409: round_expired, round_not_admissible')).toBe(true);
    expect(named('round_expired', '409: round_expired_early')).toBe(false);
  });

  it('declares no field the spec does not document (the attempts `lead` was one)', () => {
    expect(R1_CONTRACT.attempts.responseOptional).not.toContain('lead');
    expect(Object.keys(FULL_RESPONSES.attempts as object)).not.toContain('lead');
  });
});

// The checker is proven on synthetic specs, so it can be trusted the day it switches on.

interface RouteParts {
  /** False leaves the path out of the spec. */
  documented: boolean;
  operation: string;
  request: string[];
  response: string[];
  required: string[];
  refusal: string[];
}

type Mutation = (name: R1RouteName, parts: RouteParts) => void;

const pascal = (name: string): string => `R1${name[0].toUpperCase()}${name.slice(1)}`;

function properties(fields: readonly string[]): string[] {
  return fields.map((field) => `        ${field}: { type: string }`);
}

function syntheticSpec(mutate: Mutation = () => undefined): string {
  const paths: string[] = ['paths:'];
  const schemas: string[] = ['components:', '  schemas:'];
  for (const name of NAMES) {
    const contract = R1_CONTRACT[name];
    const parts: RouteParts = {
      documented: true,
      operation: contract.method.toLowerCase(),
      request: [...contract.request, ...contract.requestOptional],
      response: [...contract.response, ...contract.responseOptional],
      required: [...contract.response],
      refusal: ['error'],
    };
    mutate(name, parts);
    if (!parts.documented) continue;
    const ref = (suffix: string): string => `'#/components/schemas/${pascal(name)}${suffix}'`;
    paths.push(
      `  ${contract.path}:`,
      `    ${parts.operation}:`,
      '      tags: [r1]',
      '      requestBody:',
      '        content:',
      '          application/json:',
      '            schema:',
      `              $ref: ${ref('Request')}`,
      '      responses:',
      "        '200':",
      '          description: ok',
      '          content:',
      '            application/json:',
      '              schema:',
      `                $ref: ${ref('Response')}`,
      "        '409':",
      '          description: refused',
      '          content:',
      '            application/json:',
      '              schema:',
      `                $ref: ${ref('Refusal')}`,
    );
    schemas.push(
      `    ${pascal(name)}Request:`,
      '      type: object',
      `      required: [${contract.request.join(', ')}]`,
      '      properties:',
      ...properties(parts.request),
      `    ${pascal(name)}Response:`,
      '      type: object',
      ...(parts.required.length > 0
        ? ['      required:', ...parts.required.map((field) => `        - ${field}`)]
        : []),
      '      properties:',
      ...properties(parts.response),
      `    ${pascal(name)}Refusal:`,
      '      type: object',
      '      required: [error]',
      '      properties:',
      ...properties(parts.refusal),
    );
  }
  return ['openapi: 3.0.3', ...paths, ...schemas, ''].join('\n');
}

const without = (list: string[], field: string): string[] =>
  list.filter((item) => item !== field);

describe('the contract checker', () => {
  it('accepts a spec that documents the contract', () => {
    expect(contractProblems(syntheticSpec())).toEqual([]);
  });

  it('reads block-style and inline required lists alike', () => {
    expect(isRequired('required:\n  - a\n  - b\n', 'b')).toBe(true);
    expect(isRequired('required: [a, "b"]', 'b')).toBe(true);
    expect(isRequired('required: [a]', 'b')).toBe(false);
    expect(isRequired('required:\n  - a\nproperties:\n  b: x\n', 'b')).toBe(false);
  });

  it('names a route the spec does not document', () => {
    const spec = syntheticSpec((name, parts) => {
      if (name === 'consentTemplate') parts.documented = false;
    });
    expect(contractProblems(spec)).toEqual([
      'POST /api/r1/consent-template: path is not documented',
    ]);
  });

  it('names a route documented under the wrong method', () => {
    const spec = syntheticSpec((name, parts) => {
      if (name === 'preflight') parts.operation = 'get';
    });
    expect(contractProblems(spec)).toEqual([
      'POST /api/r1/preflight: post is not documented on the path',
    ]);
  });

  it('names a request field the server does not accept', () => {
    const optional = syntheticSpec((name, parts) => {
      if (name === 'attempts') parts.request = without(parts.request, 'nonce');
    });
    expect(contractProblems(optional)).toEqual([
      'POST /api/r1/attempts: request lacks optional nonce',
    ]);
    const mandatory = syntheticSpec((name, parts) => {
      if (name === 'status') parts.request = without(parts.request, 'token');
    });
    expect(contractProblems(mandatory)).toEqual(['POST /api/r1/status: request lacks token']);
  });

  it('names a response field the parser needs but the server does not send', () => {
    const spec = syntheticSpec((name, parts) => {
      if (name !== 'exchange') return;
      parts.response = without(parts.response, 'livekit_token');
      parts.required = without(parts.required, 'livekit_token');
    });
    expect(contractProblems(spec)).toEqual(['POST /api/r1/exchange: response lacks livekit_token']);
  });

  it('names an optional response field the spec does not document (a dead contract field)', () => {
    const spec = syntheticSpec((name, parts) => {
      if (name === 'attempts') parts.response = without(parts.response, 'rejoin');
      if (name === 'status') parts.response = without(parts.response, 'audience');
    });
    expect(contractProblems(spec)).toEqual([
      'POST /api/r1/status: response lacks optional audience',
      'POST /api/r1/attempts: response lacks optional rejoin',
    ]);
  });

  it('names a response field the server may omit although the parser requires it', () => {
    const spec = syntheticSpec((name, parts) => {
      if (name === 'attempts') parts.required = without(parts.required, 'attempt_token');
    });
    expect(contractProblems(spec)).toEqual([
      'POST /api/r1/attempts: response does not mark attempt_token required',
    ]);
  });

  it('does not take a field of an error response for the success response', () => {
    const spec = syntheticSpec((name, parts) => {
      if (name !== 'status') return;
      parts.response = without(parts.response, 'round_status');
      parts.required = without(parts.required, 'round_status');
      parts.refusal = [...parts.refusal, 'round_status'];
    });
    expect(contractProblems(spec)).toEqual(['POST /api/r1/status: response lacks round_status']);
  });

  it('reports every route for a spec that documents none of them', () => {
    const spec = 'openapi: 3.0.3\npaths:\n  /api/health:\n    get: {}\n';
    expect(contractProblems(spec)).toHaveLength(NAMES.length);
  });

  it('lets a route the server has not shipped yet be undocumented, and nothing else', () => {
    const spec = syntheticSpec((name, parts) => {
      if (name === 'ready') parts.documented = false;
    });
    expect(contractProblems(spec)).toEqual(['POST /api/r1/ready: path is not documented']);
    expect(contractProblems(spec, PENDING_ON_SERVER)).toEqual([]);
    // Pending covers only the routes named: any other missing route is still a problem.
    const missing = syntheticSpec((name, parts) => {
      if (name === 'ready' || name === 'exchange') parts.documented = false;
    });
    expect(contractProblems(missing, PENDING_ON_SERVER)).toEqual([
      'POST /api/r1/exchange: path is not documented',
    ]);
  });

  it('checks a pending route in full the moment the spec documents it', () => {
    const spec = syntheticSpec((name, parts) => {
      if (name === 'ready') parts.request = without(parts.request, 'nonce');
    });
    expect(contractProblems(spec, PENDING_ON_SERVER)).toEqual([
      'POST /api/r1/ready: request lacks nonce',
    ]);
  });

  it('keeps the pending allowance to the one route that is awaiting the server', () => {
    expect([...PENDING_ON_SERVER]).toEqual(['ready']);
  });
});
