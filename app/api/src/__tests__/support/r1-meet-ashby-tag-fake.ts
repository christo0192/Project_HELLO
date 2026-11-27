/**
 * The "Dex R1: Booked" tag lane's fakes (M035 S11). T2 adds the Ashby half: a STATEFUL scripted
 * `AshbyTransport` that runs under the REAL Ashby client and the REAL tag port, so every body, every
 * error class and every log line is what production would produce (the `r1-meet-feedback-fake.ts`
 * pattern).
 *
 * STATE
 *   catalogue     the tenant's tags `{ id, title, isArchived? }` (`candidateTag.list`);
 *   candidates    candidate id -> the tags it carries (`candidate.info`, `candidate.addTag`,
 *                 `candidate.removeTag`). `candidate.info` also answers a SENTINEL name and email, so
 *                 a test can prove neither ever reaches a log, an error or a write body;
 *   applications  application id -> candidate id (`application.info`).
 *
 * ANSWERS
 *   /candidateTag.list   pages of the catalogue by the request `limit` (100 when absent) behind an
 *                        opaque cursor, with `moreDataAvailable` and `nextCursor`; `includeArchived:
 *                        false` drops entries with `isArchived === true` unless
 *                        `ignoreIncludeArchived` is set (a tenant that ignores the flag);
 *   /candidate.info      `{ success, results: Candidate }` with the candidate's tags;
 *   /application.info    `{ success, results: { id, candidate: { id, name } } }`;
 *   /candidate.addTag    adds the catalogue entry of `tagId` when the candidate lacks it, answers the
 *                        Candidate; an id outside the catalogue answers `success: false`;
 *   /candidate.removeTag removes it, answers the Candidate;
 *   anything else        HTTP 404. An unknown candidate or application answers `success: false`.
 *
 * SCRIPTING
 *   next(path, step)   queues one answer for the next request of that path instead of the state's:
 *                      `{ status, body?, headers? }`, `'network'` (nothing reached Ashby) or
 *                      `'timeout'` (the client's deadline fired). A scripted answer changes no state;
 *   onRequest(hook)    runs before each answer, with the recorded request (a test uses it to change
 *                      the state mid-run, to advance a clock, ...);
 *   requests           `{ path, body, raw, headers }` per request, `authorization` redacted.
 *
 * Ids are fixture ids (`7f000000-0000-4000-8000-…`); the key is built at run time and never looks
 * like a real credential. Never shipped: `tsconfig.build.json` excludes `src/__tests__`.
 */

import type { AshbyTransport, AshbyTransportRequest, AshbyTransportResponse } from '../../integrations/ashby/client.js';

/** The five paths the lane may ever call. */
export const ASHBY_TAG_LANE_PATHS = Object.freeze([
  '/application.info',
  '/candidate.info',
  '/candidateTag.list',
  '/candidate.addTag',
  '/candidate.removeTag',
] as const);

/** Planted in the fake's candidate answers: none may ever reach a log, an error or a write body. */
export const ASHBY_TAG_SENTINELS = Object.freeze({
  name: 'SENTINEL-NAME-8811',
  email: 'sentinel-8812@example.test',
});

/** A synthetic Ashby key, built at run time (never a key-shaped literal). */
export function fakeAshbyTagKey(): string {
  return ['synthetic', 'tag', 'credential'].join('-');
}

export interface FakeTag {
  readonly id: string;
  readonly title: string;
  /** Left out on purpose by a test that checks an entry which does not say it is active. */
  readonly isArchived?: boolean;
}

export type FakeAshbyStep =
  | { readonly status: number; readonly body?: unknown; readonly headers?: Record<string, string> }
  | 'network'
  | 'timeout';

export interface FakeAshbyRequest {
  readonly path: string;
  /** The parsed JSON body. */
  readonly body: Record<string, unknown>;
  /** The JSON body exactly as sent (key order kept). */
  readonly raw: string;
  /** Lower-cased names; `authorization` redacted. */
  readonly headers: Record<string, string>;
}

export type FakeAshbyHook = (request: FakeAshbyRequest) => void | Promise<void>;

export interface FakeAshbyTags {
  readonly transport: AshbyTransport;
  readonly requests: FakeAshbyRequest[];
  readonly catalogue: FakeTag[];
  readonly candidates: Map<string, FakeTag[]>;
  readonly applications: Map<string, string>;
  /** A tenant that ignores `includeArchived: false` (archived entries are listed too). */
  ignoreIncludeArchived: boolean;
  next(path: string, step: FakeAshbyStep): void;
  onRequest(hook: FakeAshbyHook): void;
  /** The request paths, in order. */
  paths(): string[];
  /** The requests of one path, in order. */
  requestsOf(path: string): FakeAshbyRequest[];
  /** The tags the candidate carries now (a copy), or undefined for an unknown candidate. */
  tagsOf(candidateId: string): FakeTag[] | undefined;
}

const CURSOR_PREFIX = 'opaque-page-';

function answer(status: number, body: unknown, headers: Record<string, string> = {}): AshbyTransportResponse {
  const lower: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) lower[name.toLowerCase()] = value;
  const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    text: async () => text,
  };
}

const success = (results: unknown, extra: Record<string, unknown> = {}): AshbyTransportResponse =>
  answer(200, { success: true, results, ...extra });
const refused = (code: string): AshbyTransportResponse => answer(200, { success: false, errors: [code] });

export function createFakeAshbyTags(): FakeAshbyTags {
  const requests: FakeAshbyRequest[] = [];
  const catalogue: FakeTag[] = [];
  const candidates = new Map<string, FakeTag[]>();
  const applications = new Map<string, string>();
  const queued = new Map<string, FakeAshbyStep[]>();
  const hooks: FakeAshbyHook[] = [];
  const fake = {
    requests,
    catalogue,
    candidates,
    applications,
    ignoreIncludeArchived: false,
  } as FakeAshbyTags;

  const candidateOf = (id: string, tags: readonly FakeTag[]) => ({
    id,
    createdAt: '2029-12-01T00:00:00.000Z',
    updatedAt: '2029-12-02T00:00:00.000Z',
    name: ASHBY_TAG_SENTINELS.name,
    primaryEmailAddress: { value: ASHBY_TAG_SENTINELS.email, type: 'Personal', isPrimary: true },
    emailAddresses: [],
    phoneNumbers: [],
    socialLinks: [],
    tags: tags.map((tag) => ({ ...tag })),
    applicationIds: [...applications].filter(([, candidate]) => candidate === id).map(([application]) => application),
    fileHandles: [],
  });

  const tagList = (body: Record<string, unknown>): AshbyTransportResponse => {
    const listed = catalogue.filter(
      (tag) => fake.ignoreIncludeArchived || body.includeArchived !== false || tag.isArchived !== true,
    );
    const limit = typeof body.limit === 'number' && body.limit > 0 ? body.limit : 100;
    let offset = 0;
    if (body.cursor !== undefined) {
      const raw = typeof body.cursor === 'string' && body.cursor.startsWith(CURSOR_PREFIX)
        ? Number.parseInt(body.cursor.slice(CURSOR_PREFIX.length), 36)
        : Number.NaN;
      if (!Number.isInteger(raw) || raw < 0) return refused('invalid_cursor');
      offset = raw;
    }
    const page = listed.slice(offset, offset + limit);
    const more = offset + limit < listed.length;
    return success(
      page.map((tag) => ({ ...tag })),
      more ? { moreDataAvailable: true, nextCursor: `${CURSOR_PREFIX}${(offset + limit).toString(36)}` } : { moreDataAvailable: false },
    );
  };

  const stateful = (path: string, body: Record<string, unknown>): AshbyTransportResponse => {
    switch (path) {
      case '/candidateTag.list':
        return tagList(body);
      case '/candidate.info': {
        const id = typeof body.id === 'string' ? body.id : '';
        const tags = candidates.get(id);
        return tags ? success(candidateOf(id, tags)) : refused('candidate_not_found');
      }
      case '/application.info': {
        const id = typeof body.applicationId === 'string' ? body.applicationId : '';
        const candidate = applications.get(id);
        return candidate
          ? success({ id, status: 'Active', candidate: { id: candidate, name: ASHBY_TAG_SENTINELS.name } })
          : refused('application_not_found');
      }
      case '/candidate.addTag': {
        const candidateId = typeof body.candidateId === 'string' ? body.candidateId : '';
        const tags = candidates.get(candidateId);
        if (!tags) return refused('candidate_not_found');
        const entry = catalogue.find((tag) => tag.id === body.tagId);
        if (!entry) return refused('tag_not_found');
        if (!tags.some((tag) => tag.id === entry.id)) tags.push({ ...entry });
        return success(candidateOf(candidateId, tags));
      }
      case '/candidate.removeTag': {
        const candidateId = typeof body.candidateId === 'string' ? body.candidateId : '';
        const tags = candidates.get(candidateId);
        if (!tags) return refused('candidate_not_found');
        const kept = tags.filter((tag) => tag.id !== body.tagId);
        tags.splice(0, tags.length, ...kept);
        return success(candidateOf(candidateId, tags));
      }
      default:
        return answer(404, { success: false, errors: ['not_found'] });
    }
  };

  const transport: AshbyTransport = async (req: AshbyTransportRequest) => {
    const path = new URL(req.url).pathname;
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      headers[name.toLowerCase()] = name.toLowerCase() === 'authorization' ? '<redacted>' : value;
    }
    const record: FakeAshbyRequest = Object.freeze({
      path,
      body: JSON.parse(req.body) as Record<string, unknown>,
      raw: req.body,
      headers,
    });
    requests.push(record);
    for (const hook of [...hooks]) await hook(record);
    const step = queued.get(path)?.shift();
    if (step === 'network') throw new Error('fake ashby network failure');
    if (step === 'timeout') {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    }
    if (step !== undefined) return answer(step.status, step.body, step.headers);
    return stateful(path, record.body);
  };

  return Object.assign(fake, {
    transport,
    next(path: string, step: FakeAshbyStep) {
      const list = queued.get(path) ?? [];
      list.push(step);
      queued.set(path, list);
    },
    onRequest(hook: FakeAshbyHook) {
      hooks.push(hook);
    },
    paths: () => requests.map((request) => request.path),
    requestsOf: (path: string) => requests.filter((request) => request.path === path),
    tagsOf: (candidateId: string) => candidates.get(candidateId)?.map((tag) => ({ ...tag })),
  });
}
