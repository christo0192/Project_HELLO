/**
 * TST-02 — OpenAPI ⇄ live-handler contract test (Phase 6 lane L2).
 *
 * This test does NOT merely parse the spec text. It:
 *   1. Loads app/api/openapi/openapi.yaml with a small dependency-free YAML
 *      subset parser (no new deps, offline — the package may not add any).
 *   2. Drives the REAL Express app (createApp) — with only Supabase/LiveKit/
 *      Claude side effects mocked — through every documented 2xx route and
 *      validates the live response body against the documented schema
 *      (required keys, types, enums, uuid/date-time formats, nested objects,
 *      arrays, and additionalProperties:false exactness for handler-built
 *      envelopes).
 *   3. Asserts the reverse direction too: every route the app actually
 *      registers is documented, and every documented route is registered
 *      (Express router-stack introspection vs the spec's paths).
 *   4. Asserts the auth boundary from the spec's security model: every
 *      non-public route rejects unauthenticated requests with the
 *      middleware 401 contract, and public routes are reachable without
 *      bearer auth.
 *   5. Runs the required negative control in-process: mutating a documented
 *      response field (spec) makes the live-handler validation go red; the
 *      mutation is restored and never left in the file.
 *
 * Auth/RBAC/RLS assertions are only ever strengthened (never weakened): the
 * existing auth-rbac-rate-audit, validation, recordings and invites suites
 * remain untouched and green.
 *
 * No network, no real provider calls, no secrets, no real candidate data —
 * all fixtures are synthetic and the LiveKit SDK is mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createApp } from '../app.js';
import { mockAuthGetUser, type AuthUser } from '../lib/auth.js';
import { MemoryRateLimitStore, setRateLimitStore } from '../lib/rate-limit.js';
import { injectAssessmentRunner } from '../services/assessment.js';
import type { Assessment, TranscriptTurn } from '../lib/types.js';

// ════════════════════════════════════════════════════════════════════
//  Environment (before any app construction)
// ════════════════════════════════════════════════════════════════════

process.env.RATE_LIMIT_DEFAULT = '100000';
process.env.RATE_LIMIT_IP = '100000';
process.env.WORKER_CONTEXT_SECRET = 'contract-test-worker-secret-0123456789abcdef';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = resolve(__dirname, '../../openapi/openapi.yaml');

// ════════════════════════════════════════════════════════════════════
//  Dependency-free YAML subset parser
//
//  Supports exactly the subset used by openapi.yaml: 2-space indentation,
//  block mappings, block sequences, single-line flow sequences, quoted and
//  plain scalars, full-line comments. No anchors/aliases/tags/folded blocks.
// ════════════════════════════════════════════════════════════════════

type YValue = string | number | boolean | null | YMap | YValue[];
interface YMap {
  [key: string]: YValue;
}

/** Strip a full-line comment (only lines whose FIRST non-space char is #). */
function stripComment(raw: string): string {
  const trimmed = raw.trimStart();
  if (trimmed.startsWith('#')) return '';
  return raw;
}

function unquoteKey(raw: string): string {
  const t = raw.trim();
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  return t;
}

function parseScalar(raw: string): YValue {
  const t = raw.trim();
  if (t === '' || t === '~' || t === 'null') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(t)) return Number(t);
  return t;
}

function splitTopLevel(input: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      current += ch;
      if (ch === quote && input[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '[' || ch === '{') depth++;
    if (ch === ']' || ch === '}') depth--;
    if (ch === sep && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim() !== '') parts.push(current);
  return parts;
}

function parseFlowSequence(raw: string): YValue[] {
  const t = raw.trim();
  if (!t.startsWith('[') || !t.endsWith(']')) {
    throw new Error(`YAML parse error: expected flow sequence, got "${raw}"`);
  }
  const inner = t.slice(1, -1).trim();
  if (!inner) return [];
  return splitTopLevel(inner, ',').map((part) => parseScalar(part.trim()));
}

function findKeySep(text: string): number {
  // Find the first unquoted ": " separator or a trailing ":".
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote && text[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === ':' ) {
      if (i === text.length - 1) return i;
      if (text[i + 1] === ' ' || text[i + 1] === '\t') return i;
    }
  }
  return -1;
}

interface YamlLine {
  indent: number;
  text: string;
  lineNo: number;
}

function parseYamlDocument(text: string): YMap {
  const lines: YamlLine[] = [];
  for (const [idx, rawLine] of text.split('\n').entries()) {
    const stripped = stripComment(rawLine);
    const trimmed = stripped.trim();
    if (!trimmed) continue;
    lines.push({ indent: rawLine.length - rawLine.trimStart().length, text: trimmed, lineNo: idx + 1 });
  }
  let pos = 0;

  function parseNode(expectIndent: number): YValue {
    if (pos >= lines.length) return {};
    const line = lines[pos];
    if (line.indent < expectIndent) throw new Error(`YAML indentation error at line ${line.lineNo}`);
    if (line.text.startsWith('- ')) return parseSequence(line.indent);
    return parseMapping(line.indent);
  }

  function parseSequence(indent: number): YValue[] {
    const items: YValue[] = [];
    while (pos < lines.length && lines[pos].indent === indent && lines[pos].text.startsWith('- ')) {
      const line = lines[pos];
      const rest = line.text.slice(2);
      if (rest === '') {
        pos++;
        if (pos < lines.length && lines[pos].indent > indent) {
          items.push(parseNode(lines[pos].indent));
        } else {
          items.push(null);
        }
        continue;
      }
      const sep = findKeySep(rest);
      if (sep !== -1) {
        // Inline first key of an item map: "- key: value"
        const itemMap: YMap = {};
        let key = unquoteKey(rest.slice(0, sep));
        let valueText = rest.slice(sep + 1).trim();
        pos++;
        if (valueText === '') {
          if (pos < lines.length && lines[pos].indent > indent) {
            itemMap[key] = parseNode(lines[pos].indent);
          } else {
            itemMap[key] = null;
          }
        } else if (valueText === '[]') {
          itemMap[key] = [];
        } else if (valueText === '{}') {
          itemMap[key] = {};
        } else if (valueText.startsWith('[') && valueText.endsWith(']')) {
          itemMap[key] = parseFlowSequence(valueText);
        } else {
          itemMap[key] = parseScalar(valueText);
        }
        // Continuation keys of the same item map at indent+2.
        while (pos < lines.length && lines[pos].indent > indent && !lines[pos].text.startsWith('- ')) {
          const cl = lines[pos];
          const csep = findKeySep(cl.text);
          if (csep === -1) throw new Error(`YAML parse error at line ${cl.lineNo}`);
          const ckey = unquoteKey(cl.text.slice(0, csep));
          let cval = cl.text.slice(csep + 1).trim();
          pos++;
          if (cval === '') {
            if (pos < lines.length && lines[pos].indent > cl.indent) {
              itemMap[ckey] = parseNode(lines[pos].indent);
            } else {
              itemMap[ckey] = null;
            }
          } else if (cval === '[]') {
            itemMap[ckey] = [];
          } else if (cval === '{}') {
            itemMap[ckey] = {};
          } else if (cval.startsWith('[') && cval.endsWith(']')) {
            itemMap[ckey] = parseFlowSequence(cval);
          } else {
            itemMap[ckey] = parseScalar(cval);
          }
        }
        items.push(itemMap);
      } else {
        items.push(parseScalar(rest));
        pos++;
      }
    }
    return items;
  }

  function parseMapping(indent: number): YMap {
    const map: YMap = {};
    while (pos < lines.length && lines[pos].indent === indent) {
      const line = lines[pos];
      if (line.text.startsWith('- ')) break;
      const sep = findKeySep(line.text);
      if (sep === -1) throw new Error(`YAML parse error at line ${line.lineNo}: "${line.text}"`);
      const key = unquoteKey(line.text.slice(0, sep));
      let rest = line.text.slice(sep + 1).trim();
      pos++;
      if (rest === '') {
        if (pos < lines.length && lines[pos].indent > indent) {
          map[key] = parseNode(lines[pos].indent);
        } else {
          map[key] = null;
        }
      } else if (rest === '[]') {
        map[key] = [];
      } else if (rest === '{}') {
        map[key] = {};
      } else if (rest.startsWith('[') && rest.endsWith(']')) {
        map[key] = parseFlowSequence(rest);
      } else {
        map[key] = parseScalar(rest);
      }
    }
    return map;
  }

  if (lines.length === 0) return {};
  const root = parseNode(lines[0].indent);
  if (typeof root !== 'object' || root === null || Array.isArray(root)) {
    throw new Error('YAML root must be a mapping');
  }
  return root as YMap;
}

// ════════════════════════════════════════════════════════════════════
//  OpenAPI schema validator (small, structural)
// ════════════════════════════════════════════════════════════════════

interface SchemaNode {
  type?: string;
  required?: string[];
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  enum?: YValue[];
  additionalProperties?: boolean;
  nullable?: boolean;
  const?: YValue;
  $ref?: string;
  format?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function resolveRef(ref: string, spec: YMap): SchemaNode {
  if (!ref.startsWith('#/components/schemas/')) {
    throw new Error(`Unsupported $ref "${ref}" — only components/schemas refs are allowed`);
  }
  const name = ref.slice('#/components/schemas/'.length);
  const schemas = (spec.components as YMap)?.schemas as YMap | undefined;
  if (!schemas || typeof schemas[name] !== 'object' || schemas[name] === null || Array.isArray(schemas[name])) {
    throw new Error(`Unknown component schema "${name}" referenced by spec`);
  }
  return schemas[name] as unknown as SchemaNode;
}

function deref(schema: SchemaNode | undefined, spec: YMap): SchemaNode | undefined {
  let s = schema;
  const seen = new Set<string>();
  while (s && s.$ref) {
    if (seen.has(s.$ref)) throw new Error(`Cyclic $ref "${s.$ref}"`);
    seen.add(s.$ref);
    s = resolveRef(s.$ref, spec);
  }
  return s;
}

function validateValue(value: unknown, schema: SchemaNode | undefined, spec: YMap, path: string, errors: string[]): void {
  const wrapper = schema;
  const s = deref(schema, spec);
  if (!s) return;

  if (value === null) {
    const nullable = wrapper?.nullable === true || s.nullable === true;
    if (!nullable) errors.push(`${path}: expected a value, got null`);
    return;
  }

  if (wrapper?.const !== undefined && value !== wrapper.const) {
    errors.push(`${path}: const mismatch (expected ${JSON.stringify(wrapper.const)}, got ${JSON.stringify(value)})`);
    return;
  }
  if (s.const !== undefined && value !== s.const) {
    errors.push(`${path}: const mismatch (expected ${JSON.stringify(s.const)}, got ${JSON.stringify(value)})`);
    return;
  }
  if (s.enum && !s.enum.includes(value as YValue)) {
    errors.push(`${path}: value ${JSON.stringify(value)} not in enum [${s.enum.join(', ')}]`);
    return;
  }

  switch (s.type) {
    case 'string': {
      if (typeof value !== 'string') {
        errors.push(`${path}: expected string, got ${typeof value}`);
        return;
      }
      if (s.format === 'uuid' && !UUID_RE.test(value)) errors.push(`${path}: expected uuid format, got "${value}"`);
      if (s.format === 'date-time' && Number.isNaN(Date.parse(value))) errors.push(`${path}: expected date-time format, got "${value}"`);
      return;
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) errors.push(`${path}: expected finite number, got ${JSON.stringify(value)}`);
      return;
    }
    case 'integer': {
      if (typeof value !== 'number' || !Number.isInteger(value)) errors.push(`${path}: expected integer, got ${JSON.stringify(value)}`);
      return;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') errors.push(`${path}: expected boolean, got ${typeof value}`);
      return;
    }
    case 'array': {
      if (!Array.isArray(value)) {
        errors.push(`${path}: expected array, got ${typeof value}`);
        return;
      }
      if (s.items) value.forEach((v, i) => validateValue(v, s.items, spec, `${path}[${i}]`, errors));
      return;
    }
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) {
        errors.push(`${path}: expected object, got ${typeof value}`);
        return;
      }
      const props = s.properties ?? {};
      if (s.required) {
        for (const req of s.required) {
          if (!(req in (value as Record<string, unknown>))) errors.push(`${path}.${req}: missing required property`);
        }
      }
      if (s.additionalProperties === false) {
        for (const key of Object.keys(value as Record<string, unknown>)) {
          if (!(key in props)) errors.push(`${path}.${key}: undocumented property (handler returns a field the spec does not document)`);
        }
      }
      for (const [key, sub] of Object.entries(props)) {
        if (key in (value as Record<string, unknown>)) {
          validateValue((value as Record<string, unknown>)[key], sub, spec, `${path}.${key}`, errors);
        }
      }
      return;
    }
    case undefined: {
      // No declared type. An empty schema ({}) accepts anything; a schema
      // with only properties behaves like an object schema.
      if (!s.properties) return;
      if (typeof value !== 'object' || Array.isArray(value)) {
        errors.push(`${path}: expected object, got ${typeof value}`);
        return;
      }
      const props = s.properties;
      if (s.required) {
        for (const req of s.required) {
          if (!(req in (value as Record<string, unknown>))) errors.push(`${path}.${req}: missing required property`);
        }
      }
      if (s.additionalProperties === false) {
        for (const key of Object.keys(value as Record<string, unknown>)) {
          if (!(key in props)) errors.push(`${path}.${key}: undocumented property`);
        }
      }
      for (const [key, sub] of Object.entries(props)) {
        if (key in (value as Record<string, unknown>)) {
          validateValue((value as Record<string, unknown>)[key], sub, spec, `${path}.${key}`, errors);
        }
      }
      return;
    }
    default:
      return;
  }
}

function validateResponseBody(body: unknown, schemaRef: string, spec: YMap): string[] {
  if (!schemaRef.startsWith('#/components/schemas/')) {
    schemaRef = `#/components/schemas/${schemaRef}`;
  }
  const schema = resolveRef(schemaRef, spec);
  const errors: string[] = [];
  validateValue(body, schema, spec, '$', errors);
  return errors;
}

/** Validate a value against a named component schema, returning the errors. */
function validateNamed(value: unknown, schemaName: string, spec: YMap): string[] {
  const errors: string[] = [];
  validateValue(value, resolveRef(`#/components/schemas/${schemaName}`, spec), spec, '$', errors);
  return errors;
}

// ════════════════════════════════════════════════════════════════════
//  Spec loading + route inventory helpers
// ════════════════════════════════════════════════════════════════════

const specText = readFileSync(SPEC_PATH, 'utf8');
const spec = parseYamlDocument(specText);

/** { "GET /api/roles": true, ... } — every documented operation. */
function documentedOperations(): Map<string, string> {
  const ops = new Map<string, string>(); // key -> schemaRef of primary 2xx
  const paths = spec.paths as YMap;
  for (const [pathKey, pathItem] of Object.entries(paths)) {
    const item = pathItem as YMap;
    for (const method of ['get', 'post', 'put', 'delete', 'patch']) {
      const op = item[method] as YMap | undefined;
      if (!op || typeof op !== 'object') continue;
      const responses = op.responses as YMap;
      const statuses = Object.keys(responses).filter((k) => k === '200' || k === '201' || k === '204');
      let schemaRef = '';
      if (statuses.length > 0) {
        const status = statuses[0];
        const content = (responses[status] as YMap)?.content as YMap | undefined;
        schemaRef = (content?.['application/json'] as YMap)?.schema as unknown as string ?? '';
      }
      ops.set(`${method.toUpperCase()} ${pathKey}`, schemaRef);
    }
  }
  return ops;
}

/** Introspect the real Express app's router stack.
 *
 * Express 4 router layers do not carry a `path` property, so the mount
 * path is recovered from the layer regexp source (e.g. ^\/api\/dsar\/?(?=\/|$)
 * => /api/dsar). Route paths with :params are normalized to {params} so
 * they can be compared 1:1 with the OpenAPI paths keys. */
function collectExpressRoutes(app: ReturnType<typeof createApp>): Set<string> {
  const routes = new Set<string>();
  function normalizePath(p: string): string {
    const braced = p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    return braced.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
  }
  function mountPathFromRegexp(source: string): string {
    let s = source.startsWith('^') ? source.slice(1) : source;
    // Express appends the optional-trailing-slash lookahead \/?(?=\/|$) to
    // mounted-router paths; strip it as a literal suffix.
    const marker = String.raw`\/?(?=\/|$)`;
    if (s.endsWith(marker)) s = s.slice(0, -marker.length);
    s = s.replace(/\$\s*$/, '');
    return s.replace(/\\\//g, '/');
  }
  function walk(stack: unknown[], base: string): void {
    for (const layer of stack as Array<Record<string, any>>) {
      if (!layer) continue;
      if (layer.route) {
        const methods = Object.keys(layer.route.methods).filter((m) => m !== '_all');
        for (const m of methods) {
          const p = normalizePath(base + layer.route.path);
          routes.add(`${m.toUpperCase()} ${p}`);
        }
      } else if (layer.name === 'router' && layer.handle && Array.isArray(layer.handle.stack)) {
        const mount = mountPathFromRegexp(layer.regexp?.source ?? '');
        walk(layer.handle.stack, base + mount);
      }
    }
  }
  walk((app as any)._router?.stack ?? [], '');
  return routes;
}

// ════════════════════════════════════════════════════════════════════
//  Test doubles
// ════════════════════════════════════════════════════════════════════

const mockFrom = vi.fn();
const mockStorageFrom = vi.fn();
const mockRpc = vi.fn();

vi.mock('../lib/supabase.js', () => ({
  supabase: {
    from: (...args: unknown[]) => mockFrom(...args),
    rpc: (...args: unknown[]) => mockRpc(...args),
    storage: {
      from: (...args: unknown[]) => mockStorageFrom(...args),
    },
  },
  RESUME_BUCKET: 'resumes_v2',
}));

vi.mock('../lib/claude.js', () => ({
  runClaudeJSON: vi.fn().mockResolvedValue({ message: 'Hello from mocked brain', done: false }),
  runClaudeJSONWithProvenance: vi.fn().mockResolvedValue({
    data: { message: 'Hello from mocked brain', done: false },
    requestedModel: 'haiku',
  }),
}));

vi.mock('../lib/resume-parser.js', () => ({
  parseResume: vi.fn().mockResolvedValue({
    text: 'Alice Example — Senior Software Engineer with 8 years of TypeScript and Go experience.',
    totalLength: 88,
    truncated: false,
  }),
  ParserError: class ParserError extends Error {},
  ParserTimeoutError: class ParserTimeoutError extends Error {},
  ParserOutputExceededError: class ParserOutputExceededError extends Error {},
}));

vi.mock('livekit-server-sdk', () => {
  class FakeRoomServiceClient {
    createRoom = vi.fn().mockResolvedValue({ name: 'screening-room' });
    updateRoomMetadata = vi.fn().mockResolvedValue({});
    deleteRoom = vi.fn().mockResolvedValue({});
  }
  class FakeAccessToken {
    addGrant = vi.fn();
    toJwt = vi.fn().mockResolvedValue('fake-livekit-jwt-token');
  }
  return {
    RoomServiceClient: FakeRoomServiceClient,
    AccessToken: FakeAccessToken,
  };
});

/** Chainable, awaitable Supabase query-builder mock. */
function chain(value: unknown) {
  const c: Record<string, unknown> = {};
  const methods = [
    'select', 'insert', 'update', 'upsert', 'delete',
    'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'not',
    'order', 'limit', 'range', 'single', 'maybeSingle', 'execute',
  ];
  for (const m of methods) c[m] = (..._args: unknown[]) => chain(value);
  c.then = (resolve: (v: unknown) => unknown) => Promise.resolve(value).then(resolve);
  c.catch = (reject: (e: unknown) => unknown) => Promise.resolve(value).catch(reject);
  return c;
}

/** Configure per-table resolved values (function form receives 0-based call index). */
function configureTables(config: Record<string, unknown | ((callIndex: number) => unknown)>): void {
  const counters: Record<string, number> = {};
  mockFrom.mockImplementation((table: string) => {
    const entry = config[table];
    if (entry === undefined) return chain({ data: null, error: null });
    const n = counters[table] ?? 0;
    counters[table] = n + 1;
    const value = typeof entry === 'function' ? (entry as (c: number) => unknown)(n) : entry;
    return chain(value);
  });
}

function configureStorage(options: { upload?: unknown; createSignedUrl?: unknown; download?: unknown } = {}): void {
  mockStorageFrom.mockReturnValue({
    upload: vi.fn().mockResolvedValue(options.upload ?? { data: { path: '2026/01/fake.txt' }, error: null }),
    createSignedUrl: vi.fn().mockResolvedValue(
      options.createSignedUrl ?? { data: { signedUrl: 'https://storage.example/signed' }, error: null },
    ),
    remove: vi.fn().mockResolvedValue({ data: null, error: null }),
    download: vi.fn().mockResolvedValue(
      options.download ?? { data: null, error: { message: 'no object' } },
    ),
  });
}

function ok(value: unknown) {
  return { data: value, error: null };
}

// ════════════════════════════════════════════════════════════════════
//  Fixtures (synthetic; no real data)
// ════════════════════════════════════════════════════════════════════

const UUID_1 = '00000000-0000-4000-8000-000000000001';
const UUID_2 = '00000000-0000-4000-8000-000000000002';
const UUID_3 = '00000000-0000-4000-8000-000000000003';
const ROOM_NAME = `screening-${UUID_1}`;
const T_2026 = '2026-01-01T00:00:00.000Z';
const GRANT_TOKEN = 'a'.repeat(64);

const mockRole = {
  id: UUID_1,
  title: 'Software Engineer',
  jd: 'Build things',
  required_skills: ['TypeScript'],
  screening_template: [{ id: 'q1', question: 'Tell me about a hard problem', weight: 1, follow_up_hint: 'dig deeper', mandatory: false }],
  is_active: true,
  owner_id: null,
  created_at: T_2026,
  updated_at: T_2026,
};

const mockCandidateRow = {
  id: UUID_2,
  role_id: UUID_1,
  resume_id: UUID_3,
  name: 'Alice Example',
  email: 'alice@example.com',
  phone_raw: '+919876543210',
  phone_e164: '+919876543210',
  phone_valid: true,
  skills: ['TypeScript', 'Go'],
  experience_years: 8,
  parsed: { summary: 'Senior engineer', current_role: 'Staff Engineer' },
  status: 'new',
  consent_source: 'job_application',
  consent_at: T_2026,
  owner_id: null,
  ats_external_id: null,
  ats_source: null,
  created_at: T_2026,
  updated_at: T_2026,
};

const mockCandidateListItem = {
  id: UUID_2,
  name: 'Alice Example',
  email: 'alice@example.com',
  phone_e164: '+919876543210',
  phone_valid: true,
  skills: ['TypeScript'],
  experience_years: 8,
  status: 'new',
  role_id: UUID_1,
  created_at: T_2026,
};

const mockSessionRow = {
  id: UUID_1,
  candidate_id: UUID_2,
  role_id: UUID_1,
  mode: 'simulation',
  provider: 'simulation',
  external_call_id: null,
  status: 'in_progress',
  recording_url: null,
  recording_object_key: null,
  current_question_index: 0,
  owner_id: null,
  provenance: { schema_version: 1, provider: 'test', requestedModel: 'haiku', workload: 'screening', prompt_template_version: 'v1', timestamp: T_2026 },
  waiting_at: null,
  terminal_reason: null,
  started_at: T_2026,
  ended_at: null,
  duration_sec: null,
  created_at: T_2026,
  updated_at: T_2026,
};

const mockTranscriptTurns: TranscriptTurn[] = [
  { speaker: 'bot', text: 'Hello, thanks for joining.', start_offset_sec: 0.0 },
  { speaker: 'candidate', text: 'Hi, happy to be here.', start_offset_sec: 2.5 },
  { speaker: 'bot', text: 'Tell me about your experience.', start_offset_sec: null },
];

const mockAssessmentRecord = {
  id: UUID_3,
  session_id: UUID_1,
  candidate_id: UUID_2,
  english: null,
  tone: { clarity: 8, confidence: 7, professionalism: 9, sentiment: 'positive', notes: 'warm' },
  communication: { score: 8, clarity: 8, structure: 7, listening: 8, rapport: 8, notes: 'clear' },
  motivation: { score: 8, notes: 'interested' },
  role_fit: { score: 8, matched_skills: ['TS'], gaps: [], red_flags: [], notes: 'good' },
  resume_conflicts: [],
  overall_score: 82,
  recommendation: 'advance',
  summary: 'Strong communicator with the required skills.',
  raw: null,
  provenance: { schema_version: 1, provider: 'test', requestedModel: 'sonnet', workload: 'scoring', prompt_template_version: 'v1', timestamp: T_2026 },
  created_at: T_2026,
  updated_at: T_2026,
};

const mockAssessmentCamel: Assessment & { id: string } = {
  id: UUID_3,
  english: {
    band: 'B2',
    grammar: 8,
    vocabulary: 7,
    fluency: 8,
    coherence: 8,
    notes: 'Confident and mostly fluent.',
  },
  tone: { clarity: 8, confidence: 7, professionalism: 9, sentiment: 'positive', notes: 'warm' },
  communication: {
    score: 8,
    clarity: 8,
    structure: 7,
    listening: 8,
    rapport: 8,
    english_proficiency: {
      band: 'B2', grammar: 8, vocabulary: 7, fluency: 8, coherence: 8, notes: 'Confident.',
    },
    filler_usage: { level: 'low', examples: [], impact_score: 8, notes: 'minimal fillers' },
    native_language_usage: { level: 'low', examples: [], impact_score: 8, notes: 'rare' },
    notes: 'clear',
  },
  motivation: { score: 8, notes: 'interested' },
  role_fit: { score: 8, matched_skills: ['TS'], gaps: [], red_flags: [], notes: 'good' },
  overall_score: 82,
  recommendation: 'advance',
  summary: 'Strong communicator with the required skills.',
  resume_conflicts: [
    { topic: 'Years of experience', resume_says: '8 years', candidate_said: '8 years', resolved: true, note: 'consistent' },
  ],
};

const mockResumeRow = {
  id: UUID_3,
  file_path: '2026/01/fake.txt',
  file_name: 'resume.txt',
  mime_type: 'text/plain',
  text_extracted: 'Alice Example ...',
  parsed: { name: 'Alice Example', email: 'alice@example.com', phone: null, skills: ['TS'], experience_years: 8, current_role: 'Engineer', summary: 'x' },
  created_at: T_2026,
  updated_at: T_2026,
};

const mockDsarRow = {
  id: UUID_3,
  candidate_id: UUID_2,
  request_type: 'export',
  request_status: 'pending',
  requested_by: 'user-admin-0000-0000-000000000001',
  requested_at: T_2026,
  reviewed_by: null,
  reviewed_at: null,
  fulfilled_at: null,
  rejection_reason: null,
  legal_hold_blocked: false,
  notes: null,
  metadata: null,
  created_at: T_2026,
  updated_at: T_2026,
};

const mockHoldRow = {
  id: UUID_3,
  entity_type: 'candidate',
  entity_id: UUID_2,
  hold_reason: 'Pending litigation',
  hold_source: 'litigation_hold',
  placed_by: 'user-admin-0000-0000-000000000001',
  placed_at: T_2026,
  released_at: null,
  released_by: null,
  release_reason: null,
  expires_at: null,
  metadata: null,
};

const mockConsentRecordRow = {
  id: UUID_3,
  candidate_id: UUID_2,
  status: 'granted',
  consents: ['ai_interview', 'recording'],
  version: '1.0',
  created_at: T_2026,
  updated_at: T_2026,
  expires_at: null,
};

const mockTemplateRow = {
  id: UUID_3,
  version: '1.0',
  locale: 'en',
  title: 'Screening privacy notice',
  body_md: '# Privacy notice',
  required_consents: ['ai_interview', 'recording'],
  is_active: true,
};

// ════════════════════════════════════════════════════════════════════
//  Auth + app helpers
// ════════════════════════════════════════════════════════════════════

const JWT_ADMIN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTAwMSIsImFhbCI6ImFhbDIifQ.signature';
const AUTH_HEADER = 'Bearer ' + JWT_ADMIN;

const ADMIN: AuthUser = {
  id: 'user-admin-0000-0000-000000000001',
  email: 'admin@example.com',
  aal: 'aal2',
  active: true,
  appRole: 'admin',
  orgId: 'org-0000-0000-0000-000000000001',
};

function createContractApp(): ReturnType<typeof createApp> {
  return createApp({
    nodeEnv: 'test',
    webOrigin: 'http://localhost:5173',
    authDeps: { getUser: mockAuthGetUser(ADMIN, JWT_ADMIN) },
    auditSinkOverride: async () => {},
  });
}

function createUnauthedApp(): ReturnType<typeof createApp> {
  return createApp({
    nodeEnv: 'test',
    webOrigin: 'http://localhost:5173',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  setRateLimitStore(new MemoryRateLimitStore());
  injectAssessmentRunner(null);
  configureStorage();
  // Default: every table resolves { data: null, error: null } unless a test
  // overrides it via configureTables.
  configureTables({});
  // Default RPC: finalize_recording_upload → ok, quarantine_recording → quarantined
  mockRpc.mockImplementation((fn: string) => {
    if (fn === 'finalize_recording_upload') {
      return Promise.resolve({ data: { status: 'ok' }, error: null });
    }
    if (fn === 'quarantine_recording') {
      return Promise.resolve({ data: { status: 'quarantined' }, error: null });
    }
    return Promise.resolve({ data: null, error: { message: 'unknown rpc' } });
  });
});

afterEach(() => {
  injectAssessmentRunner(null);
});

// ════════════════════════════════════════════════════════════════════
//  Tests
// ════════════════════════════════════════════════════════════════════

describe('OpenAPI document integrity', () => {
  it('parses as a document with info, paths and components', () => {
    expect(spec.openapi).toBe('3.0.3');
    expect(spec.paths).toBeTypeOf('object');
    expect((spec as YMap).components).toBeTypeOf('object');
  });

  it('has the expected route, schema, and security-scheme counts (anti-degradation)', () => {
    // Hard expected counts so a parser mis-parse or inadvertent spec
    // deletion fails loudly instead of silently weakening assertions.
    // These are the verified counts at the time of this commit; if you
    // intentionally add/remove routes or schemas, update these numbers.
    const paths = spec.paths as YMap;
    const schemas = ((spec as YMap).components as YMap).schemas as YMap;
    const securitySchemes = ((spec as YMap).components as YMap).securitySchemes as YMap;
    // 70 + GET /api/recordings/health (0038 convergence surface).
    expect(Object.keys(paths).length).toBe(72);
    // 149 + RoomUnavailableError + MaintenanceBlockedBody (discriminated
    // 503 bodies on exchangeInvite) + RecordingFinalizeHealth (0038)
    // + the five read-only feedback-form discovery schemas.
    expect(Object.keys(schemas).length).toBe(157);
    expect(Object.keys(securitySchemes).length).toBe(3);
    // At least 70 of the schemas must carry additionalProperties:false —
    // the few with true are intentionally extensible envelope/record types.
    // A parser mis-parse that silently drops additionalProperties would
    // reduce this count and fail loudly.
    let apFalseCount = 0;
    for (const [name, s] of Object.entries(schemas)) {
      if (s && typeof s === 'object' && (s as YMap).type === 'object' && (s as YMap).additionalProperties === false) {
        apFalseCount += 1;
      }
    }
    expect(apFalseCount).toBeGreaterThanOrEqual(80);
  });

  it('references only component schemas that exist', () => {
    const schemas = ((spec as YMap).components as YMap).schemas as YMap;
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (node && typeof node === 'object') {
        const obj = node as YMap;
        if (typeof obj.$ref === 'string') {
          expect(schemas[obj.$ref.slice('#/components/schemas/'.length)], `missing schema for $ref ${obj.$ref}`).toBeDefined();
        }
        Object.values(obj).forEach(walk);
      }
    };
    walk(spec);
  });

  it('documents every route the app registers and nothing else', () => {
    const app = createContractApp();
    const documented = [...documentedOperations().keys()];
    const actual = [...collectExpressRoutes(app)].sort();

    expect(actual.length).toBeGreaterThan(0);
    // Every app route is documented (no undocumented surface).
    for (const route of actual) {
      expect(documented, `app route ${route} is not documented in openapi.yaml`).toContain(route);
    }
    // Every documented route is actually mounted.
    for (const route of documented) {
      expect(actual, `documented route ${route} is not mounted in the app`).toContain(route);
    }
    // Exact bijection — keeps the spec from silently drifting.
    expect(actual.length).toBe(documented.length);
  });
});

describe('auth boundary vs spec security model', () => {
  const publicRoutes = new Set([
    'GET /api/health',
    'POST /api/csp-report',
    'POST /api/livekit/exchange',
    'POST /api/livekit/worker-context',
    'POST /api/internal/assess/{sessionId}',
    // Ashby webhook: HMAC-gated (not recruiter-authenticated), mounted pre-auth.
    'POST /api/integrations/ashby/webhook',
    'POST /api/livekit/grant/recording',
    // Phase 9 L4 exact public allowlist (method+path precise).
    'GET /api/status',
    'GET /api/candidate-consent/template',
    'POST /api/candidate-consent/status',
    'POST /api/candidate-consent/submit',
    'POST /api/appeals',
  ]);
  const grantAuthenticatedPattern = /^POST \/api\/livekit\/\{sessionId\}\/(recording|complete)$/;

  it('rejects unauthenticated requests on every non-public route with the middleware 401 contract', async () => {
    const app = createUnauthedApp();
    const routes = collectExpressRoutes(app);
    const failures: string[] = [];
    for (const route of routes) {
      if (publicRoutes.has(route)) continue;
      if (grantAuthenticatedPattern.test(route)) continue; // grant-authenticated inside route
      const [method, rawPath] = route.split(' ');
      const path = rawPath.replace(/\{[^}]+\}/g, UUID_1);
      let res: request.Response;
      if (method === 'GET') res = await request(app).get(path);
      else if (method === 'POST') res = await request(app).post(path).send({});
      else if (method === 'PUT') res = await request(app).put(path).send({});
      else res = await request(app).patch(path).send({});
      if (res.status !== 401 || res.body?.error?.type !== 'authentication_error') {
        failures.push(`${method} ${path} -> ${res.status} ${JSON.stringify(res.body)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('public routes are reachable without bearer auth', async () => {
    const app = createUnauthedApp();
    const health = await request(app).get('/api/health');
    expect(health.status).toBe(200);
    expect(health.body.ok).toBe(true);

    const csp = await request(app)
      .post('/api/csp-report')
      .send({ 'csp-report': { 'document-uri': 'https://app.example/', 'violated-directive': 'script-src' } });
    expect(csp.status).toBe(204);

    // Phase 9 L4 public routes are reachable without bearer auth.
    const status = await request(app).get('/api/status');
    expect(status.status).toBe(200);
    expect(status.body.status).toBe('ok');
    expect(status.body).not.toHaveProperty('model');
    expect(status.body).not.toHaveProperty('provider');

    const consentStatus = await request(app)
      .post('/api/candidate-consent/status')
      .send({ invite_token: 'a'.repeat(64) });
    expect(consentStatus.status).toBe(404); // unknown invite → stable fail, route reachable
    expect(consentStatus.body.error).toBe('invite_token_invalid_or_expired');

    const appealsSubmit = await request(app)
      .post('/api/appeals')
      .send({ appeal_grant_token: 'b'.repeat(64), category: 'scoring', description: 'x' });
    expect(appealsSubmit.status).toBe(404); // unknown grant → stable fail, route reachable
    expect(appealsSubmit.body.error).toBe('appeal_grant_invalid_or_expired');

    const exchange = await request(app)
      .post('/api/livekit/exchange')
      .send({ token: 'not-a-valid-token' });
    expect(exchange.status).toBe(400);

    const workerCtx = await request(app)
      .post('/api/livekit/worker-context')
      .set('Authorization', `Bearer ${process.env.WORKER_CONTEXT_SECRET}`)
      .send({ session_id: UUID_1, room_name: ROOM_NAME });
    expect(workerCtx.status).toBe(404); // session not found — proves public path + validation ran
  });

  it('does not weaken the RBAC assertion on admin-only screening routes', async () => {
    const app = createContractApp();
    // Screening router requires admin; a viewer must be denied.
    const viewerApp = createApp({
      nodeEnv: 'test',
      webOrigin: 'http://localhost:5173',
      authDeps: {
        getUser: mockAuthGetUser(
          { ...ADMIN, appRole: 'viewer', id: 'user-view-0000-0000-000000000002' },
          JWT_ADMIN,
        ),
      },
      auditSinkOverride: async () => {},
    });
    const res = await request(viewerApp)
      .post('/api/screening/start')
      .set('Authorization', AUTH_HEADER)
      .send({ candidate_id: UUID_2 });
    expect(res.status).toBe(403);
    expect(res.body.error.type).toBe('authorization_error');
  });

  // Phase 9 L4 negative control: the public allowlist is exact method+path.
  // Near misses (same path, different method; same method, adjacent path)
  // must stay behind auth — 401 without a token, never silently public.
  it('near-miss methods/paths stay protected (exact allowlist, not prefix)', async () => {
    const app = createUnauthedApp();
    const nearMisses: Array<[string, string, unknown]> = [
      ['get', '/api/candidate-consent/status', undefined], // GET vs POST
      ['get', '/api/candidate-consent/submit', undefined],
      ['post', '/api/candidate-consent/template', {}], // POST vs GET
      ['post', '/api/candidate-consent/status/sub', {}], // prefix suffix
      ['get', '/api/status/sub', undefined],
      ['get', '/api/appeals', undefined], // GET list is recruiter
      ['post', '/api/appeals/grants', {}],
      ['post', '/api/appeals/extra', {}],
      ['get', '/api/me', undefined], // never public
      ['get', '/api/me/sub', undefined],
      ['get', '/api/admin/members', undefined],
      ['post', '/api/admin/maintenance', {}],
      ['get', '/api/notes', undefined],
      ['get', '/api/notifications', undefined],
      ['get', '/api/export/' + UUID_1 + '/csv', undefined],
    ];
    const failures: string[] = [];
    for (const [method, path, body] of nearMisses) {
      let res: request.Response;
      if (method === 'get') res = await (request(app) as any).get(path);
      else res = await (request(app) as any).post(path).send(body ?? {});
      if (res.status !== 401 || res.body?.error?.type !== 'authentication_error') {
        failures.push(`${method.toUpperCase()} ${path} -> ${res.status} ${JSON.stringify(res.body)}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

describe('live handler shapes match documented schemas', () => {
  it('GET /api/health', async () => {
    const app = createUnauthedApp();
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(validateResponseBody(res.body, 'HealthResponse', spec)).toEqual([]);
  });

  it('GET /api/roles → Role[]', async () => {
    configureTables({ roles: ok([mockRole]) });
    const app = createContractApp();
    const res = await request(app).get('/api/roles').set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(validateNamed(res.body[0], 'Role', spec)).toEqual([]);
  });

  it('GET /api/roles/{id} → Role', async () => {
    configureTables({ roles: ok(mockRole) });
    const app = createContractApp();
    const res = await request(app).get(`/api/roles/${UUID_1}`).set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(validateResponseBody(res.body, 'Role', spec)).toEqual([]);
  });

  it('POST /api/roles → 201 Role', async () => {
    configureTables({ roles: ok(mockRole) });
    const app = createContractApp();
    const res = await request(app)
      .post('/api/roles')
      .set('Authorization', AUTH_HEADER)
      .send({ title: 'Software Engineer', required_skills: ['TS'] });
    expect(res.status).toBe(201);
    expect(validateResponseBody(res.body, 'Role', spec)).toEqual([]);
  });

  it('PUT /api/roles/{id} → Role', async () => {
    configureTables({ roles: ok({ ...mockRole, title: 'Updated' }) });
    const app = createContractApp();
    const res = await request(app)
      .put(`/api/roles/${UUID_1}`)
      .set('Authorization', AUTH_HEADER)
      .send({ title: 'Updated' });
    expect(res.status).toBe(200);
    expect(validateResponseBody(res.body, 'Role', spec)).toEqual([]);
  });

  it('GET /api/candidates → CandidateListItem[]', async () => {
    configureTables({ candidates: ok([mockCandidateListItem]) });
    const app = createContractApp();
    const res = await request(app).get('/api/candidates').set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(validateNamed(res.body[0], 'CandidateListItem', spec)).toEqual([]);
  });

  it('GET /api/candidates/{id} → CandidateDetail', async () => {
    configureTables({
      candidates: ok(mockCandidateRow),
      call_sessions: ok([mockSessionRow]),
      assessments: ok([mockAssessmentRecord]),
    });
    const app = createContractApp();
    const res = await request(app).get(`/api/candidates/${UUID_2}`).set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(validateResponseBody(res.body, 'CandidateDetail', spec)).toEqual([]);
  });

  it('POST /api/resumes → 201 ResumeUploadResponse', async () => {
    // The resumes route runs runClaudeJSON as the resume LLM parser; give it
    // a resume-shaped result for this test only (screening tests use the
    // default BotReply shape).
    const { runClaudeJSON } = await import('../lib/claude.js');
    vi.mocked(runClaudeJSON).mockResolvedValue({
      name: 'Alice Example',
      email: 'alice@example.com',
      phone: '+919876543210',
      skills: ['TypeScript'],
      experience_years: 8,
      current_role: 'Staff Engineer',
      summary: 'Senior engineer',
    });
    configureTables({
      resumes: ok(mockResumeRow),
      candidates: ok(mockCandidateRow),
      consent_records: ok({ data: null, error: null }),
    });
    const app = createContractApp();
    const res = await request(app)
      .post('/api/resumes')
      .set('Authorization', AUTH_HEADER)
      .field('role_id', UUID_1)
      .attach('file', Buffer.from('Alice Example\nSenior Software Engineer with 8 years of TypeScript experience.'), 'alice-resume.txt');
    expect(res.status).toBe(201);
    expect(validateResponseBody(res.body, 'ResumeUploadResponse', spec)).toEqual([]);
    expect(res.body.phone).toMatchObject({ valid: true });
  });

  it('POST /api/screening/start → 201 StartScreeningResponse', async () => {
    configureTables({
      candidates: ok({ ...mockCandidateRow, id: UUID_2, role_id: UUID_1, skills: ['TS'], parsed: { summary: 'x' } }),
      roles: ok(mockRole),
      call_sessions: (n: number) => (n === 0 ? ok(mockSessionRow) : ok([{ id: mockSessionRow.id }])),
      transcript_turns: ok([]),
    });
    const app = createContractApp();
    const res = await request(app)
      .post('/api/screening/start')
      .set('Authorization', AUTH_HEADER)
      .send({ candidate_id: UUID_2 });
    expect(res.status).toBe(201);
    expect(validateResponseBody(res.body, 'StartScreeningResponse', spec)).toEqual([]);
  });

  it('POST /api/screening/{id}/turn → ScreeningTurnResponse', async () => {
    // The resumes test above swaps runClaudeJSON to a resume-shaped result;
    // restore the BotReply shape this route depends on.
    const { runClaudeJSON } = await import('../lib/claude.js');
    vi.mocked(runClaudeJSON).mockResolvedValue({ message: 'Hello from mocked brain', done: false });
    configureTables({
      call_sessions: ok({ id: UUID_1, candidate_id: UUID_2, status: 'in_progress' }),
      candidates: ok({ ...mockCandidateRow, id: UUID_2, role_id: UUID_1, skills: ['TS'], parsed: { summary: 'x' } }),
      roles: ok(mockRole),
      transcript_turns: ok([]),
    });
    const app = createContractApp();
    const res = await request(app)
      .post(`/api/screening/${UUID_1}/turn`)
      .set('Authorization', AUTH_HEADER)
      .send({ text: 'I have led teams before.' });
    expect(res.status).toBe(200);
    expect(validateResponseBody(res.body, 'ScreeningTurnResponse', spec)).toEqual([]);
    expect(res.body.done).toBe(false);
    expect(res.body.assessment).toBeNull();
  });

  it('GET /api/screening/{id} → ScreeningSessionDetail', async () => {
    configureTables({
      call_sessions: ok(mockSessionRow),
      transcript_turns: ok(mockTranscriptTurns),
      assessments: ok(mockAssessmentRecord),
    });
    const app = createContractApp();
    const res = await request(app).get(`/api/screening/${UUID_1}`).set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(validateResponseBody(res.body, 'ScreeningSessionDetail', spec)).toEqual([]);
  });

  it('POST /api/assess/{sessionId} → Assessment (injected runner)', async () => {
    injectAssessmentRunner(async () => mockAssessmentCamel);
    const app = createContractApp();
    const res = await request(app).post(`/api/assess/${UUID_1}`).set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(validateResponseBody(res.body, 'Assessment', spec)).toEqual([]);
  });

  it('POST /api/internal/assess/{sessionId} requires the worker credential', async () => {
    injectAssessmentRunner(async () => mockAssessmentCamel);
    const app = createContractApp();
    await request(app).post(`/api/internal/assess/${UUID_1}`).expect(401);
    await request(app)
      .post(`/api/internal/assess/${UUID_1}`)
      .set('Authorization', 'Bearer wrong-worker-secret-0123456789abcdef')
      .expect(403);
  });

  it('POST /api/internal/assess/{sessionId} scores with the worker credential', async () => {
    injectAssessmentRunner(async () => mockAssessmentCamel);
    const app = createContractApp();
    const res = await request(app)
      .post(`/api/internal/assess/${UUID_1}`)
      .set('Authorization', `Bearer ${process.env.WORKER_CONTEXT_SECRET}`);
    expect(res.status).toBe(200);
    expect(validateResponseBody(res.body, 'Assessment', spec)).toEqual([]);
  });

  it('POST /api/livekit/start → 201 LiveKitStartResponse', async () => {
    configureTables({
      candidates: ok({ ...mockCandidateRow, id: UUID_2, role_id: UUID_1, owner_id: null }),
      call_sessions: (n: number) => (n === 0 ? ok(mockSessionRow) : ok([{ id: mockSessionRow.id }])),
    });
    const app = createContractApp();
    const res = await request(app)
      .post('/api/livekit/start')
      .set('Authorization', AUTH_HEADER)
      .send({ candidate_id: UUID_2 });
    expect(res.status).toBe(201);
    expect(validateResponseBody(res.body, 'LiveKitStartResponse', spec)).toEqual([]);
    expect(res.body.url).toBeTruthy();
  });

  it('POST /api/livekit/{sessionId}/recording → RecordingUploadResponse (grant-authenticated)', async () => {
    // Synthetic minimal WebM fixture: valid EBML magic bytes only (no real media).
    const webmBytes = Buffer.concat([
      Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
      Buffer.from('webm-bytes'),
    ]);
    configureTables({
      candidate_access_grants: ok({
        candidate_id: UUID_2,
        session_id: UUID_1,
        room_name: ROOM_NAME,
        expires_at: '2099-01-01T00:00:00.000Z',
        consumed_at: null,
        revoked_at: null,
      }),
      call_sessions: ok([{ id: UUID_1 }]),
    });
    const app = createContractApp();
    const res = await request(app)
      .post(`/api/livekit/${UUID_1}/recording`)
      .set('x-grant-token', GRANT_TOKEN)
      .attach('file', webmBytes, { filename: 'session.webm', contentType: 'audio/webm' });
    expect(res.status).toBe(200);
    expect(validateResponseBody(res.body, 'RecordingUploadResponse', spec)).toEqual([]);
    expect(res.body.object_key).toContain(UUID_1);
  });

  it('POST /api/livekit/worker-context → WorkerContextResponse', async () => {
    configureTables({
      call_sessions: ok({
        id: UUID_1,
        candidate_id: UUID_2,
        role_id: UUID_1,
        status: 'waiting',
        external_call_id: ROOM_NAME,
      }),
      candidates: ok({ name: 'Alice Example' }),
    });
    const app = createUnauthedApp();
    const res = await request(app)
      .post('/api/livekit/worker-context')
      .set('Authorization', `Bearer ${process.env.WORKER_CONTEXT_SECRET}`)
      .send({ session_id: UUID_1, room_name: ROOM_NAME });
    expect(res.status).toBe(200);
    expect(validateResponseBody(res.body, 'WorkerContextResponse', spec)).toEqual([]);
  });

  it('POST /api/livekit/invite → 201 InviteCreateResponse', async () => {
    configureTables({
      call_sessions: ok({
        id: UUID_1,
        candidate_id: UUID_2,
        status: 'waiting',
        external_call_id: ROOM_NAME,
        owner_id: ADMIN.id,
      }),
      candidate_invites: ok({ data: null, error: null }),
    });
    const app = createContractApp();
    const res = await request(app)
      .post('/api/livekit/invite')
      .set('Authorization', AUTH_HEADER)
      .send({ candidate_id: UUID_2, session_id: UUID_1 });
    expect(res.status).toBe(201);
    expect(validateResponseBody(res.body, 'InviteCreateResponse', spec)).toEqual([]);
    expect(res.body.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('POST /api/livekit/exchange → InviteExchangeResponse', async () => {
    configureTables({
      candidate_invites: (n: number) =>
        n === 0
          ? ok({
              id: UUID_3,
              candidate_id: UUID_2,
              session_id: UUID_1,
              expires_at: '2099-01-01T00:00:00.000Z',
              consumed_at: null,
              revoked_at: null,
            })
          : ok([{ id: UUID_3 }]),
      // Phase 9 L4 consent gate: system_config (maintenance off), latest
      // consent record (granted, all required types), active template.
      system_config: ok(null),
      consent_records: ok({ status: 'granted', consents: ['ai_interview', 'recording', 'purpose', 'data_processing', 'retention', 'rights'], expires_at: null }),
      consent_templates: ok({ version: '1.0', required_consents: ['ai_interview', 'recording', 'purpose', 'data_processing', 'retention', 'rights'] }),
      call_sessions: ok({ id: UUID_1, external_call_id: ROOM_NAME, status: 'waiting' }),
      candidate_access_grants: ok({ data: null, error: null }),
    });
    const app = createUnauthedApp();
    const res = await request(app)
      .post('/api/livekit/exchange')
      .send({ token: GRANT_TOKEN });
    expect(res.status).toBe(200);
    expect(validateResponseBody(res.body, 'InviteExchangeResponse', spec)).toEqual([]);
  });

  it('POST /api/livekit/grant/recording → RecordingGrantResponse (route-shadow fixed, C-2)', async () => {
    // C-2: grant is registered before /:sessionId/recording, so the literal
    // "grant" segment is no longer captured by the UUID path-param route.
    // A valid grant bound to a healthy session yields the real 200 {url}.
    configureTables({
      call_sessions: ok({
        id: UUID_1,
        recording_object_key: `${UUID_1}.webm`,
        recording_deleted_at: null,
        recording_quarantined: false,
        recording_revoked_at: null,
      }),
      candidate_access_grants: ok({
        candidate_id: UUID_2,
        session_id: UUID_1,
        room_name: ROOM_NAME,
        expires_at: '2099-01-01T00:00:00.000Z',
        consumed_at: null,
        revoked_at: null,
      }),
    });
    const app = createUnauthedApp();
    const res = await request(app)
      .post('/api/livekit/grant/recording')
      .send({ grant_token: GRANT_TOKEN, session_id: UUID_1 });
    expect(res.status).toBe(200);
    expect(validateResponseBody(res.body, 'RecordingGrantResponse', spec)).toEqual([]);
    expect(res.body.url).toBeTruthy();
  });

  it('GET /api/recordings/{sessionId}/download → RecordingDownloadResponse', async () => {
    configureTables({
      call_sessions: ok({ owner_id: ADMIN.id, recording_object_key: `${UUID_1}.webm` }),
    });
    const app = createContractApp();
    const res = await request(app)
      .get(`/api/recordings/${UUID_1}/download`)
      .set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(validateResponseBody(res.body, 'RecordingDownloadResponse', spec)).toEqual([]);
  });

  it('POST /api/recordings/{sessionId}/revoke → RecordingRevokeResponse (admin)', async () => {
    configureTables({
      call_sessions: ok({ id: UUID_1, recording_revoked_at: null }),
    });
    const app = createContractApp();
    const res = await request(app)
      .post(`/api/recordings/${UUID_1}/revoke`)
      .set('Authorization', AUTH_HEADER)
      .send({ reason: 'contract shape' });
    expect(res.status).toBe(200);
    expect(validateResponseBody(res.body, 'RecordingRevokeResponse', spec)).toEqual([]);
    expect(res.body).toMatchObject({ ok: true, status: 'revoked' });
  });

  it('POST /api/dsar → 201 DSAREnvelope', async () => {
    configureTables({
      data_subject_requests: ok(mockDsarRow),
      governance_audit: ok({ data: null, error: null }),
    });
    const app = createContractApp();
    const res = await request(app)
      .post('/api/dsar')
      .set('Authorization', AUTH_HEADER)
      .send({ candidate_id: UUID_2, request_type: 'export' });
    expect(res.status).toBe(201);
    expect(validateResponseBody(res.body, 'DSAREnvelope', spec)).toEqual([]);
  });

  it('GET /api/dsar/{dsarId} → DSAREnvelope', async () => {
    configureTables({ data_subject_requests: ok(mockDsarRow) });
    const app = createContractApp();
    const res = await request(app).get(`/api/dsar/${UUID_3}`).set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(validateResponseBody(res.body, 'DSAREnvelope', spec)).toEqual([]);
  });

  it('GET /api/dsar/candidate/{candidateId} → DSARListEnvelope', async () => {
    configureTables({ data_subject_requests: ok([mockDsarRow]) });
    const app = createContractApp();
    const res = await request(app).get(`/api/dsar/candidate/${UUID_2}`).set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(validateResponseBody(res.body, 'DSARListEnvelope', spec)).toEqual([]);
  });

  it('POST /api/dsar/{dsarId}/fulfill → DSAREnvelope', async () => {
    configureTables({
      data_subject_requests: ok({ ...mockDsarRow, request_status: 'fulfilled' }),
      governance_audit: ok({ data: null, error: null }),
    });
    const app = createContractApp();
    const res = await request(app)
      .post(`/api/dsar/${UUID_3}/fulfill`)
      .set('Authorization', AUTH_HEADER)
      .send({ status: 'fulfilled' });
    expect(res.status).toBe(200);
    expect(validateResponseBody(res.body, 'DSAREnvelope', spec)).toEqual([]);
  });

  it('POST /api/dsar/{dsarId}/export → DSARExportEnvelope', async () => {
    configureTables({
      data_subject_requests: ok({ ...mockDsarRow, request_type: 'export', request_status: 'fulfilled' }),
      candidates: ok(mockCandidateRow),
      call_sessions: ok([mockSessionRow]),
      assessments: ok([mockAssessmentRecord]),
      transcript_turns: ok([]),
      resumes: ok([]),
      governance_audit: ok({ data: null, error: null }),
    });
    const app = createContractApp();
    const res = await request(app)
      .post(`/api/dsar/${UUID_3}/export`)
      .set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(validateResponseBody(res.body, 'DSARExportEnvelope', spec)).toEqual([]);
    expect(res.body.data.recordingDataIncluded).toBe(false); // job_application consent boundary
  });

  it('POST /api/dsar/{dsarId}/delete → DSARDeleteEnvelope', async () => {
    configureTables({
      data_subject_requests: ok({ ...mockDsarRow, request_type: 'delete' }),
      legal_holds: ok(null),
      call_sessions: ok([]),
      transcript_turns: ok([]),
      assessments: ok([]),
      candidate_invites: ok([]),
      resumes: ok([]),
      candidates: ok([]),
      governance_audit: ok({ data: null, error: null }),
    });
    const app = createContractApp();
    const res = await request(app)
      .post(`/api/dsar/${UUID_3}/delete`)
      .set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(validateResponseBody(res.body, 'DSARDeleteEnvelope', spec)).toEqual([]);
    expect(res.body.data.success).toBe(true);
  });

  it('POST /api/dsar/{dsarId}/correct → DSARCorrectEnvelope', async () => {
    configureTables({
      data_subject_requests: ok({ ...mockDsarRow, request_type: 'correct' }),
      candidates: ok({ ...mockCandidateRow, name: 'Alice Old' }),
      governance_audit: ok({ data: null, error: null }),
    });
    const app = createContractApp();
    const res = await request(app)
      .post(`/api/dsar/${UUID_3}/correct`)
      .set('Authorization', AUTH_HEADER)
      .send({ corrections: [{ field: 'name', value: 'Alice New' }] });
    expect(res.status).toBe(200);
    expect(validateResponseBody(res.body, 'DSARCorrectEnvelope', spec)).toEqual([]);
    expect(res.body.data.corrections[0].oldValue).toBe('Alice Old');
  });

  it('POST /api/dsar/legal-holds → 201 LegalHoldEnvelope', async () => {
    configureTables({
      legal_holds: ok(mockHoldRow),
      governance_audit: ok({ data: null, error: null }),
    });
    const app = createContractApp();
    const res = await request(app)
      .post('/api/dsar/legal-holds')
      .set('Authorization', AUTH_HEADER)
      .send({ entity_type: 'candidate', entity_id: UUID_2, hold_reason: 'Pending litigation', hold_source: 'litigation_hold' });
    expect(res.status).toBe(201);
    expect(validateResponseBody(res.body, 'LegalHoldEnvelope', spec)).toEqual([]);
  });

  it('POST /api/dsar/legal-holds/{holdId}/release → LegalHoldEnvelope', async () => {
    configureTables({
      legal_holds: ok({ ...mockHoldRow, released_at: T_2026, released_by: ADMIN.id, release_reason: 'resolved' }),
      governance_audit: ok({ data: null, error: null }),
    });
    const app = createContractApp();
    const res = await request(app)
      .post(`/api/dsar/legal-holds/${UUID_3}/release`)
      .set('Authorization', AUTH_HEADER)
      .send({ release_reason: 'resolved' });
    expect(res.status).toBe(200);
    expect(validateResponseBody(res.body, 'LegalHoldEnvelope', spec)).toEqual([]);
  });

  it('GET /api/dsar/legal-holds/check → LegalHoldCheck', async () => {
    configureTables({
      legal_holds: ok(null),
      erasure_exceptions: ok(null),
    });
    const app = createContractApp();
    const res = await request(app)
      .get(`/api/dsar/legal-holds/check?entity_type=candidate&entity_id=${UUID_2}`)
      .set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(validateResponseBody(res.body, 'LegalHoldCheck', spec)).toEqual([]);
    expect(res.body.data.under_legal_hold).toBe(false);
  });

  it('GET /api/dsar/legal-holds/{holdId} → LegalHoldRowEnvelope', async () => {
    configureTables({
      legal_holds: ok({
        id: UUID_3,
        entity_type: 'candidate',
        entity_id: UUID_2,
        hold_reason: 'Pending litigation',
        hold_source: 'litigation_hold',
        placed_by: ADMIN.id,
        placed_at: T_2026,
        released_at: null,
        released_by: null,
        release_reason: null,
        expires_at: null,
        metadata: null,
        created_at: T_2026,
        updated_at: T_2026,
      }),
    });
    const app = createContractApp();
    const res = await request(app).get(`/api/dsar/legal-holds/${UUID_3}`).set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(validateResponseBody(res.body, 'LegalHoldRowEnvelope', spec)).toEqual([]);
  });

  it('POST /api/consent/submit → 201 ConsentSubmitResponse', async () => {
    configureTables({
      candidates: ok({ id: UUID_2 }),
      consent_records: ok(mockConsentRecordRow),
    });
    const app = createContractApp();
    const res = await request(app)
      .post('/api/consent/submit')
      .set('Authorization', AUTH_HEADER)
      .send({ candidate_id: UUID_2, consents: ['ai_interview', 'recording'], status: 'granted' });
    expect(res.status).toBe(201);
    expect(validateResponseBody(res.body, 'ConsentSubmitResponse', spec)).toEqual([]);
  });

  it('GET /api/consent/{candidateId}/status → ConsentStatusResponse', async () => {
    configureTables({
      candidates: ok({ id: UUID_2 }),
      consent_records: ok(mockConsentRecordRow),
    });
    const app = createContractApp();
    const res = await request(app).get(`/api/consent/${UUID_2}/status`).set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(validateResponseBody(res.body, 'ConsentStatusResponse', spec)).toEqual([]);
  });

  it('POST /api/consent/check → ConsentCheckResponse', async () => {
    configureTables({
      candidates: ok({ id: UUID_2 }),
      consent_records: ok({ ...mockConsentRecordRow, consents: ['ai_interview', 'recording'] }),
    });
    const app = createContractApp();
    const res = await request(app)
      .post('/api/consent/check')
      .set('Authorization', AUTH_HEADER)
      .send({ candidate_id: UUID_2, required: ['ai_interview'] });
    expect(res.status).toBe(200);
    expect(validateResponseBody(res.body, 'ConsentCheckResponse', spec)).toEqual([]);
    expect(res.body.ok).toBe(true);
  });

  it('POST /api/consent/withdraw → ConsentWithdrawResponse', async () => {
    configureTables({
      candidates: ok({ id: UUID_2 }),
      // First call = fetch latest granted record (needs consents);
      // second call = insert the withdrawal record.
      consent_records: (n: number) =>
        n === 0 ? ok({ ...mockConsentRecordRow, consents: ['ai_interview', 'recording'] }) : ok({ id: UUID_3, status: 'withdrawn', updated_at: T_2026 }),
    });
    const app = createContractApp();
    const res = await request(app)
      .post('/api/consent/withdraw')
      .set('Authorization', AUTH_HEADER)
      .send({ candidate_id: UUID_2, consent_types: ['recording'] });
    expect(res.status).toBe(200);
    expect(validateResponseBody(res.body, 'ConsentWithdrawResponse', spec)).toEqual([]);
  });

  it('GET /api/consent/templates → ConsentTemplate[]', async () => {
    configureTables({ consent_templates: ok([mockTemplateRow]) });
    const app = createContractApp();
    const res = await request(app).get('/api/consent/templates').set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(validateNamed(res.body[0], 'ConsentTemplate', spec)).toEqual([]);
  });

  // ══════════════════════════════════════════════════════════════════
  //  Phase 9 L4 — live handler shapes for the newly wired routes
  // ══════════════════════════════════════════════════════════════════

  it('GET /api/status → StatusResponse (public, no model/provider leakage)', async () => {
    const app = createUnauthedApp();
    const res = await request(app).get('/api/status');
    expect(res.status).toBe(200);
    expect(validateResponseBody(res.body, 'StatusResponse', spec)).toEqual([]);
    expect(res.body).not.toHaveProperty('model');
    expect(res.body).not.toHaveProperty('provider');
  });

  it('GET /api/me → MeResponse (authenticated authoritative)', async () => {
    const app = createContractApp();
    const res = await request(app).get('/api/me').set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(validateResponseBody(res.body, 'MeResponse', spec)).toEqual([]);
    expect(res.body.role).toBe('admin');
  });

  it('GET /api/admin/members → AdminMember[] (opaque, no email)', async () => {
    configureTables({ recruiter_memberships: ok([{ user_id: 'u-admin-1', role: 'admin', active: true }]) });
    const app = createContractApp();
    const res = await request(app).get('/api/admin/members').set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(validateNamed(res.body[0], 'AdminMember', spec)).toEqual([]);
    expect(res.body[0]).not.toHaveProperty('email');
  });

  it('PATCH /api/admin/members/{userId} → AdminMemberUpdateResponse', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'ok' }, error: null });
    const app = createContractApp();
    const res = await request(app)
      .patch(`/api/admin/members/${UUID_1}`)
      .set('Authorization', AUTH_HEADER)
      .send({ role: 'viewer' });
    expect(res.status).toBe(200);
    expect(validateResponseBody(res.body, 'AdminMemberUpdateResponse', spec)).toEqual([]);
  });

  it('POST /api/admin/maintenance → AdminMaintenanceToggleResponse', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'ok', enabled: true }, error: null });
    const app = createContractApp();
    const res = await request(app)
      .post('/api/admin/maintenance')
      .set('Authorization', AUTH_HEADER)
      .send({ enabled: true, reason: 'planned window' });
    expect(res.status).toBe(200);
    expect(validateResponseBody(res.body, 'AdminMaintenanceToggleResponse', spec)).toEqual([]);
  });

  it('POST /api/admin/sessions/{sessionId}/override → AdminSessionOverrideResponse', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'ok', prior_status: 'in_progress' }, error: null });
    const app = createContractApp();
    const res = await request(app)
      .post(`/api/admin/sessions/${UUID_1}/override`)
      .set('Authorization', AUTH_HEADER)
      .send({ target_status: 'completed', reason: 'call finished off-hook' });
    expect(res.status).toBe(200);
    expect(validateResponseBody(res.body, 'AdminSessionOverrideResponse', spec)).toEqual([]);
  });

  it('GET /api/notes?candidate_id= → NoteListResponse', async () => {
    configureTables({
      candidates: ok({ id: UUID_2, owner_id: null }),
      recruiter_notes: ok([{ id: UUID_3, candidate_id: UUID_2, author_id: 'u-admin-1', note: 'follow up', created_at: T_2026 }]),
    });
    const app = createContractApp();
    const res = await request(app).get(`/api/notes?candidate_id=${UUID_2}`).set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(validateResponseBody(res.body, 'NoteListResponse', spec)).toEqual([]);
  });

  it('POST /api/notes → 201 NoteResponse', async () => {
    configureTables({
      candidates: ok({ id: UUID_2, owner_id: null }),
      recruiter_notes: ok({ id: UUID_3, candidate_id: UUID_2, author_id: 'u-admin-1', note: 'notes', created_at: T_2026 }),
    });
    const app = createContractApp();
    const res = await request(app)
      .post('/api/notes')
      .set('Authorization', AUTH_HEADER)
      .send({ candidate_id: UUID_2, note: 'notes' });
    expect(res.status).toBe(201);
    expect(validateResponseBody(res.body, 'NoteResponse', spec)).toEqual([]);
  });

  it('POST /api/notes/{candidateId}/status → StatusTransitionResponse', async () => {
    configureTables({
      candidates: (n: number) =>
        n === 0 ? ok({ id: UUID_2, owner_id: null, status: 'screening', decision_use_blocked_at: null }) : ok([{ id: UUID_2 }]),
      audit_events: ok(null),
    });
    const app = createContractApp();
    const res = await request(app)
      .post(`/api/notes/${UUID_2}/status`)
      .set('Authorization', AUTH_HEADER)
      .send({ status: 'screened' });
    expect(res.status).toBe(200);
    expect(validateResponseBody(res.body, 'StatusTransitionResponse', spec)).toEqual([]);
  });

  it('POST /api/candidate-consent/status → CandidateConsentStatusResponse (public)', async () => {
    configureTables({
      candidate_invites: ok({ id: UUID_3, candidate_id: UUID_2, session_id: UUID_1, expires_at: '2999-01-01T00:00:00.000Z', consumed_at: null, revoked_at: null }),
      consent_records: ok({ status: 'granted', consents: ['ai_interview', 'recording'], expires_at: null }),
      consent_templates: ok({ version: '1.0', locale: 'en-IN', required_consents: ['ai_interview', 'recording'] }),
    });
    const app = createUnauthedApp();
    const res = await request(app)
      .post('/api/candidate-consent/status')
      .send({ invite_token: 'a'.repeat(64) });
    expect(res.status).toBe(200);
    expect(validateResponseBody(res.body, 'CandidateConsentStatusResponse', spec)).toEqual([]);
    expect(res.body).not.toHaveProperty('candidate_id');
    expect(res.body).not.toHaveProperty('token');
  });

  it('GET /api/candidate-consent/template → CandidateConsentTemplateResponse (public)', async () => {
    configureTables({
      consent_templates: ok({ version: '1.0', locale: 'en-IN', title: 'Consent', body_md: 'plain text', required_consents: ['ai_interview'] }),
    });
    const app = createUnauthedApp();
    const res = await request(app).get('/api/candidate-consent/template?locale=en-IN');
    expect(res.status).toBe(200);
    expect(validateResponseBody(res.body, 'CandidateConsentTemplateResponse', spec)).toEqual([]);
  });

  it('POST /api/candidate-consent/submit → 201 CandidateConsentSubmitResponse (public, invite never consumed)', async () => {
    configureTables({
      candidate_invites: ok({ id: UUID_3, candidate_id: UUID_2, session_id: UUID_1, expires_at: '2999-01-01T00:00:00.000Z', consumed_at: null, revoked_at: null }),
      consent_templates: ok({ version: '1.0', required_consents: ['ai_interview', 'recording'] }),
      consent_records: ok({ id: UUID_3, status: 'granted', consents: ['ai_interview', 'recording'], version: '1.0', created_at: T_2026 }),
      audit_events: ok(null),
    });
    const app = createUnauthedApp();
    const res = await request(app)
      .post('/api/candidate-consent/submit')
      .send({
        invite_token: 'a'.repeat(64),
        template_version: '1.0',
        locale: 'en-IN',
        consents: ['ai_interview', 'recording'],
        status: 'granted',
      });
    expect(res.status).toBe(201);
    expect(validateResponseBody(res.body, 'CandidateConsentSubmitResponse', spec)).toEqual([]);
  });

  it('GET /api/notifications → NotificationIntentListResponse (interviewer+)', async () => {
    configureTables({
      notification_intents: ok([{ id: UUID_3, kind: 'assessment_ready', candidate_id: UUID_2, consent_verified: false, created_at: T_2026 }]),
    });
    const app = createContractApp();
    const res = await request(app).get('/api/notifications').set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(validateResponseBody(res.body, 'NotificationIntentListResponse', spec)).toEqual([]);
  });

  it('GET /api/export/{candidateId}/csv → text/csv attachment (ownership-scoped)', async () => {
    configureTables({
      candidates: ok({ id: UUID_2, owner_id: null, status: 'screened' }),
      assessments: ok([{ id: UUID_3, english: null, tone: { clarity: 8 }, communication: { score: 8 }, motivation: { score: 8 }, role_fit: { score: 8 }, overall_score: 82, recommendation: 'advance', created_at: T_2026 }]),
      audit_events: ok(null),
    });
    const app = createContractApp();
    const res = await request(app).get(`/api/export/${UUID_2}/csv`).set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.text.startsWith('\uFEFF')).toBe(true);
  });

  it('POST /api/appeals/grants → 201 AppealGrantResponse (digest persisted, plaintext once)', async () => {
    configureTables({
      candidates: ok({ id: UUID_2, owner_id: null }),
      call_sessions: ok({ candidate_id: UUID_2 }),
      appeal_grants: ok(null),
    });
    const app = createContractApp();
    const res = await request(app)
      .post('/api/appeals/grants')
      .set('Authorization', AUTH_HEADER)
      .send({ candidate_id: UUID_2, session_id: UUID_1, expires_in_hours: 24 });
    expect(res.status).toBe(201);
    expect(validateResponseBody(res.body, 'AppealGrantResponse', spec)).toEqual([]);
  });

  it('POST /api/appeals → 201 AppealCreateResponse (public, grant-authenticated, minimized snapshot)', async () => {
    configureTables({
      appeal_grants: ok({ id: UUID_3, candidate_id: UUID_2, session_id: UUID_1, expires_at: '2999-01-01T00:00:00.000Z', consumed_at: null, revoked_at: null }),
      assessments: ok({ id: UUID_3, english: null, tone: { clarity: 8 }, communication: { score: 8 }, motivation: { score: 8 }, role_fit: { score: 8 }, overall_score: 82, recommendation: 'advance' }),
    });
    mockRpc.mockImplementation(async (fn: string) => {
      if (fn === 'create_appeal') return { data: { status: 'ok', appeal_id: UUID_3 }, error: null };
      return { data: null, error: { message: 'unknown rpc' } };
    });
    const app = createUnauthedApp();
    const res = await request(app)
      .post('/api/appeals')
      .send({ appeal_grant_token: 'b'.repeat(64), category: 'scoring', description: 'score seems low' });
    expect(res.status).toBe(201);
    expect(validateResponseBody(res.body, 'AppealCreateResponse', spec)).toEqual([]);
  });

  it('POST /api/appeals/{appealId}/review → AppealReviewResponse (immutable review event via RPC)', async () => {
    configureTables({ appeal_requests: ok({ id: UUID_3, candidate_id: UUID_2 }) });
    mockRpc.mockImplementation(async (fn: string) => {
      if (fn === 'review_appeal') return { data: { status: 'ok' }, error: null };
      return { data: null, error: { message: 'unknown rpc' } };
    });
    const app = createContractApp();
    const res = await request(app)
      .post(`/api/appeals/${UUID_3}/review`)
      .set('Authorization', AUTH_HEADER)
      .send({ to_status: 'under_review', notes: 'checking' });
    expect(res.status).toBe(200);
    expect(validateResponseBody(res.body, 'AppealReviewResponse', spec)).toEqual([]);
  });

  it('GET /api/appeals?candidate_id= → AppealListResponse (recruiter list)', async () => {
    configureTables({
      appeal_requests: ok([{ id: UUID_3, candidate_id: UUID_2, session_id: UUID_1, assessment_id: UUID_3, category: 'scoring', description: 'score seems low', status: 'open', created_at: T_2026, updated_at: T_2026 }]),
    });
    const app = createContractApp();
    const res = await request(app).get(`/api/appeals?candidate_id=${UUID_2}`).set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(validateResponseBody(res.body, 'AppealListResponse', spec)).toEqual([]);
  });

  // ══════════════════════════════════════════════════════════════════
  //  Phase 9 review repair — admin audit / sessions / quota views
  // ══════════════════════════════════════════════════════════════════

  it('GET /api/admin/audit → AdminAuditListResponse (redacted, admin only)', async () => {
    configureTables({
      audit_events: ok([
        { id: UUID_3, action: 'admin_maintenance_toggle', actor_type: 'recruiter', actor_id: UUID_1, target_type: 'system', target_id: 'maintenance', result: 'success', created_at: T_2026 },
      ]),
    });
    const app = createContractApp();
    const res = await request(app).get('/api/admin/audit').set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(validateResponseBody(res.body, 'AdminAuditListResponse', spec)).toEqual([]);
    expect(JSON.stringify(res.body)).not.toContain('metadata');
  });

  it('GET /api/admin/sessions → AdminSessionListResponse (opaque, admin only)', async () => {
    configureTables({
      call_sessions: ok([
        { id: UUID_1, candidate_id: UUID_2, role_id: null, status: 'in_progress', created_at: T_2026, started_at: T_2026, ended_at: null },
      ]),
    });
    const app = createContractApp();
    const res = await request(app).get('/api/admin/sessions').set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(validateResponseBody(res.body, 'AdminSessionListResponse', spec)).toEqual([]);
  });

  it('GET /api/admin/quotas → QuotaPolicyListResponse (abstract units, no price)', async () => {
    configureTables({
      quota_policies: ok([
        { id: UUID_3, scope: 'global', scope_id: null, mode: 'simulation', max_sessions: 10, max_cost_units: null, cost_units_per_session: 5, warning_percentage: null, period_days: 1, enabled: false, created_at: T_2026, updated_at: T_2026 },
      ]),
    });
    const app = createContractApp();
    const res = await request(app).get('/api/admin/quotas').set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(validateResponseBody(res.body, 'QuotaPolicyListResponse', spec)).toEqual([]);
  });

  it('POST /api/admin/quotas → 201 QuotaPolicyCreateResponse (atomic RPC + audit)', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'ok', id: UUID_3, created: true }, error: null });
    const app = createContractApp();
    const res = await request(app)
      .post('/api/admin/quotas')
      .set('Authorization', AUTH_HEADER)
      .send({ scope: 'global', max_sessions: 25, enabled: false });
    expect(res.status).toBe(201);
    expect(validateResponseBody(res.body, 'QuotaPolicyCreateResponse', spec)).toEqual([]);
  });

  it('PATCH /api/admin/quotas/{id} → QuotaPolicyUpdateResponse', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'ok', id: UUID_3, created: false }, error: null });
    const app = createContractApp();
    const res = await request(app)
      .patch(`/api/admin/quotas/${UUID_3}`)
      .set('Authorization', AUTH_HEADER)
      .send({ scope: 'global', enabled: true });
    expect(res.status).toBe(200);
    expect(validateResponseBody(res.body, 'QuotaPolicyUpdateResponse', spec)).toEqual([]);
  });

  // ── HELLO access allowlist (0016): normalized-email access gate ──
  it('GET /api/admin/allowlist → AdminAllowlistListResponse (admin-only, no internal fields)', async () => {
    configureTables({
      email_allowlist: ok([
        {
          id: UUID_3,
          email: 'gopu.nair@interviewkickstart.com',
          role: 'admin',
          active: true,
          linked_user_id: null,
          linked_at: null,
          created_at: T_2026,
          updated_at: T_2026,
          email_normalized: 'should-never-leak',
        },
      ]),
    });
    const app = createContractApp();
    const res = await request(app).get('/api/admin/allowlist').set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(validateResponseBody(res.body, 'AdminAllowlistListResponse', spec)).toEqual([]);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].email).toBe('gopu.nair@interviewkickstart.com');
    expect(JSON.stringify(res.body)).not.toContain('email_normalized');
    expect(JSON.stringify(res.body)).not.toContain('updated_at');
  });

  it('POST /api/admin/allowlist → 201 AdminAllowlistAddResponse (atomic RPC + audit)', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'ok', id: UUID_3 }, error: null });
    const app = createContractApp();
    const res = await request(app)
      .post('/api/admin/allowlist')
      .set('Authorization', AUTH_HEADER)
      .send({ email: 'alice@interviewkickstart.com', role: 'interviewer' });
    expect(res.status).toBe(201);
    expect(validateResponseBody(res.body, 'AdminAllowlistAddResponse', spec)).toEqual([]);
    expect(res.body.ok).toBe(true);
  });

  it('PATCH /api/admin/allowlist/{id} → AdminAllowlistUpdateResponse', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'ok' }, error: null });
    const app = createContractApp();
    const res = await request(app)
      .patch(`/api/admin/allowlist/${UUID_3}`)
      .set('Authorization', AUTH_HEADER)
      .send({ active: false });
    expect(res.status).toBe(200);
    expect(validateResponseBody(res.body, 'AdminAllowlistUpdateResponse', spec)).toEqual([]);
  });

  it('allowlist routes are protected: unauthenticated → 401, non-admin → 403', async () => {
    const unauth = createUnauthedApp();
    const noAuth = await request(unauth).get('/api/admin/allowlist');
    expect(noAuth.status).toBe(401);
    expect(noAuth.body.error.type).toBe('authentication_error');

    const viewer: AuthUser = {
      id: 'user-view-0000-0000-000000000003',
      email: 'viewer@example.com',
      aal: 'aal1',
      active: true,
      appRole: 'viewer',
      orgId: null,
    };
    const viewerApp = createApp({ authDeps: { getUser: mockAuthGetUser(viewer, JWT_ADMIN) } });
    const forbidden = await request(viewerApp)
      .post('/api/admin/allowlist')
      .set('Authorization', AUTH_HEADER)
      .send({ email: 'alice@interviewkickstart.com' });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.type).toBe('authorization_error');
  });
});

describe('negative control: mutating a documented response field turns the contract red', () => {
  function makeScreeningStartApp() {
    configureTables({
      candidates: ok({ ...mockCandidateRow, id: UUID_2, role_id: UUID_1, skills: ['TS'], parsed: { summary: 'x' } }),
      roles: ok(mockRole),
      call_sessions: (n: number) => (n === 0 ? ok(mockSessionRow) : ok([{ id: mockSessionRow.id }])),
      transcript_turns: ok({ data: null, error: null }),
    });
    return createContractApp();
  }

  async function liveScreeningStartBody() {
    const app = makeScreeningStartApp();
    const res = await request(app)
      .post('/api/screening/start')
      .set('Authorization', AUTH_HEADER)
      .send({ candidate_id: UUID_2 });
    expect(res.status).toBe(201);
    return res.body as Record<string, unknown>;
  }

  function deepCloneSpec(): YMap {
    return JSON.parse(JSON.stringify(spec)) as YMap;
  }

  it('baseline: unmutated spec validates the live response', async () => {
    const body = await liveScreeningStartBody();
    expect(validateResponseBody(body, 'StartScreeningResponse', spec)).toEqual([]);
  });

  it('red when a documented required field is removed from the spec (extra-key violation)', async () => {
    const body = await liveScreeningStartBody();
    const mutated = deepCloneSpec();
    const schemas = (mutated.components as YMap).schemas as YMap;
    const startSchema = schemas.StartScreeningResponse as YMap;
    delete (startSchema.properties as YMap).session_id;
    (startSchema.required as YValue[]) = (startSchema.required as YValue[]).filter((r) => r !== 'session_id');
    const errors = validateResponseBody(body, 'StartScreeningResponse', mutated);
    // Handler still returns session_id but the spec no longer documents it.
    expect(errors.some((e) => e.includes('undocumented property'))).toBe(true);
    expect(errors).not.toEqual([]);
  });

  it('red when a required field the handler does not return is added to the spec', async () => {
    const body = await liveScreeningStartBody();
    const mutated = deepCloneSpec();
    const schemas = (mutated.components as YMap).schemas as YMap;
    const startSchema = schemas.StartScreeningResponse as YMap;
    (startSchema.properties as YMap).phantom_field = { type: 'string' };
    ((startSchema.required as YValue[])).push('phantom_field');
    const errors = validateResponseBody(body, 'StartScreeningResponse', mutated);
    expect(errors.some((e) => e.includes('missing required property'))).toBe(true);
    expect(errors).not.toEqual([]);
  });

  it('red when a documented field type is mutated (string → number)', async () => {
    const body = await liveScreeningStartBody();
    const mutated = deepCloneSpec();
    const schemas = (mutated.components as YMap).schemas as YMap;
    const startSchema = schemas.StartScreeningResponse as YMap;
    (startSchema.properties as YMap).done = { type: 'string' };
    const errors = validateResponseBody(body, 'StartScreeningResponse', mutated);
    expect(errors.some((e) => e.includes('done'))).toBe(true);
    expect(errors).not.toEqual([]);
  });

  it('spec file on disk is unmutated after the negative control (no residual mutation)', () => {
    const onDisk = readFileSync(SPEC_PATH, 'utf8');
    expect(onDisk).toBe(specText);
  });
});

describe('documented routes respond to invalid params with the documented 400 contract', () => {
  it('path-param validation is real on parameterized routes', async () => {
    const app = createContractApp();
    const parameterized = [
      ['get', '/api/roles/{id}'],
      ['get', '/api/candidates/{id}'],
      ['post', '/api/screening/{id}/turn'],
      ['get', '/api/screening/{id}'],
      ['post', '/api/assess/{sessionId}'],
      ['post', '/api/livekit/{sessionId}/recording'],
      ['get', '/api/recordings/{sessionId}/download'],
      ['get', '/api/dsar/{dsarId}'],
      ['get', '/api/dsar/candidate/{candidateId}'],
      ['post', '/api/dsar/{dsarId}/fulfill'],
      ['post', '/api/dsar/{dsarId}/export'],
      ['post', '/api/dsar/{dsarId}/delete'],
      ['post', '/api/dsar/{dsarId}/correct'],
      ['post', '/api/dsar/legal-holds/{holdId}/release'],
      // NOTE: GET /api/dsar/legal-holds/{holdId} and GET /api/consent/{candidateId}/status
      // intentionally have no UUID param validation in the current handlers
      // (raw pass-through), so they are excluded from the 400 sweep.
    ] as const;
    const failures: string[] = [];
    for (const [method, template] of parameterized) {
      const path = template.replace(/\{[^}]+\}/g, 'not-a-uuid');
      let res: request.Response;
      if (method === 'get') res = await request(app).get(path).set('Authorization', AUTH_HEADER);
      else res = await request(app).post(path).set('Authorization', AUTH_HEADER).send({});
      if (res.status !== 400 || res.body?.error?.type !== 'validation_error') {
        failures.push(`${method.toUpperCase()} ${template} -> ${res.status} ${JSON.stringify(res.body)}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 0026: deriveStartOffsetSec — deterministic, zero I/O
// ═══════════════════════════════════════════════════════════════════

import { deriveStartOffsetSec } from '../routes/screening.js';

describe('deriveStartOffsetSec', () => {
  it('derives a positive offset in seconds', () => {
    expect(deriveStartOffsetSec(1700000005000, 1700000000000)).toBe(5.0);
  });

  it('derives offset with sub-second precision (rounded to ms)', () => {
    expect(deriveStartOffsetSec(1700000000123, 1700000000000)).toBe(0.123);
  });

  it('rounds to nearest ms', () => {
    expect(deriveStartOffsetSec(1700000000001, 1700000000000)).toBe(0.001);
  });

  it('returns null when turnMs is null', () => {
    expect(deriveStartOffsetSec(null, 1700000000000)).toBeNull();
  });

  it('returns null when egressMs is null', () => {
    expect(deriveStartOffsetSec(1700000005000, null)).toBeNull();
  });

  it('returns null when both anchors are null', () => {
    expect(deriveStartOffsetSec(null, null)).toBeNull();
  });

  it('clamps negative offset to 0 (turn < egress — NTP skew)', () => {
    expect(deriveStartOffsetSec(1700000000000, 1700000005000)).toBe(0.0);
  });

  it('returns 0 when turn equals egress', () => {
    expect(deriveStartOffsetSec(1700000000000, 1700000000000)).toBe(0.0);
  });

  it('returns null when turnMs is NaN', () => {
    expect(deriveStartOffsetSec(NaN, 1700000000000)).toBeNull();
  });

  it('returns null when egressMs is NaN', () => {
    expect(deriveStartOffsetSec(1700000005000, NaN)).toBeNull();
  });

  it('returns null when turnMs is a boolean', () => {
    expect(deriveStartOffsetSec(true, 1700000000000)).toBeNull();
  });

  it('returns null when turnMs is a float', () => {
    expect(deriveStartOffsetSec(1700000005000.5, 1700000000000)).toBeNull();
  });

  it('returns null when turnMs is an invalid string', () => {
    expect(deriveStartOffsetSec('abc', 1700000000000)).toBeNull();
  });

  it('returns null when turnMs is a negative number', () => {
    expect(deriveStartOffsetSec(-1, 1700000000000)).toBeNull();
  });

  it('returns null when turnMs is 0', () => {
    expect(deriveStartOffsetSec(0, 1700000000000)).toBeNull();
  });

  it('returns null when egressMs is a non-numeric string', () => {
    expect(deriveStartOffsetSec(1700000005000, 'not-a-number')).toBeNull();
  });

  it('accepts numeric strings for both anchors', () => {
    expect(deriveStartOffsetSec('1700000005000', '1700000000000')).toBe(5.0);
  });

  it('returns null when turnMs exceeds MAX_EPOCH_MS_ANCHOR', () => {
    expect(deriveStartOffsetSec(4102444800000, 1700000000000)).toBeNull();
  });

  it('returns null when egressMs is out of range (negative)', () => {
    expect(deriveStartOffsetSec(1700000005000, -5)).toBeNull();
  });
});
