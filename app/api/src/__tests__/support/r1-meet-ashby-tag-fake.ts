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
 * T3 adds the TABLES half (`createBookedTagTables()`): the two tables the booked-tag store reads,
 * `r1_meet_bookings` and `ashby_application_links`, as plain rows behind an in-memory client whose
 * `from(table)` answers a query with `select(columns)`, `eq`, `in`, `order(column, { ascending })`
 * (stable; successive calls are successive sort keys; nulls last ascending and first descending, as
 * Postgres sorts), `limit(n)`, `maybeSingle()` (PGRST116 on more than one row) and `then`.
 *   select projects the named columns; a column the row does not have stays ABSENT (not null), so
 *                a test can prove that a missing selected column is drift;
 *   failNext     the next query of a table answers a DB error (`'error'`, the default), rejects
 *                (`'reject'`) or throws from `from()` (`'throw'`, a builder that throws);
 *   calls        one `{ table, columns, filters, orders, limit, terminal }` per query, in order;
 *   seeds        `publicBooking({ applicationId, ... })` (defaults: source `public_page`, status
 *                `pending`, a slot 24 h after `HARNESS_NOW`, `created_at = updated_at = HARNESS_NOW`;
 *                the row also carries columns the store must never read: our candidate id, the Meet
 *                URL, a ticket digest, the calendar and manage columns) and
 *                `link({ applicationId, candidateId })` (provider `ashby`, lifecycle `imported`).
 *
 * Ids are fixture ids (`7f000000-0000-4000-8000-…`); the key is built at run time and never looks
 * like a real credential. Never shipped: `tsconfig.build.json` excludes `src/__tests__`.
 */

import type { AshbyTransport, AshbyTransportRequest, AshbyTransportResponse } from '../../integrations/ashby/client.js';
import type { R1MeetBookingStatus } from '../../lib/r1/meet/bookings-read.js';
import type { supabase } from '../../lib/supabase.js';
import { HARNESS_NOW, MEET_URL, fixtureId } from './r1-meet-harness.js';

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

// ── The tables half (T3): the rows the booked-tag store reads ───────────────

export type BookedTagTable = 'r1_meet_bookings' | 'ashby_application_links';
export type BookedTagRow = Record<string, unknown>;

export interface BookedTagFilter {
  readonly op: 'eq' | 'in';
  readonly column: string;
  readonly value: unknown;
}

export interface BookedTagOrder {
  readonly column: string;
  readonly ascending: boolean;
}

export interface BookedTagQueryCall {
  readonly table: string;
  /** The `select` argument exactly as passed, or null when none was. */
  columns: string | null;
  readonly filters: BookedTagFilter[];
  readonly orders: BookedTagOrder[];
  limit: number | null;
  /** How the query was settled. */
  terminal: 'maybeSingle' | 'then' | null;
}

/** `'error'`: a DB error answer; `'reject'`: the call rejects; `'throw'`: `from()` itself throws. */
export type BookedTagFailure = 'error' | 'reject' | 'throw';

export interface PublicBookingSeed {
  readonly id?: string;
  readonly applicationId: string;
  readonly status?: R1MeetBookingStatus;
  readonly startAt?: string;
  readonly updatedAt?: string;
  readonly createdAt?: string;
  /** Default `public_page`; `ashby` seeds an Ashby-scheduled row (its three Ashby ids set). */
  readonly source?: string;
}

export interface LinkSeed {
  readonly applicationId: string;
  readonly candidateId: string | null;
}

export interface BookedTagTables {
  readonly rows: { readonly r1_meet_bookings: BookedTagRow[]; readonly ashby_application_links: BookedTagRow[] };
  /** The in-memory client, typed as the service-role client the store takes. */
  readonly client: typeof supabase;
  readonly calls: BookedTagQueryCall[];
  /** The next query of `table` fails (see `BookedTagFailure`). */
  failNext(table: BookedTagTable, failure?: BookedTagFailure): void;
  /** Seeds one booking row and answers it (the stored object: a test may change it in place). */
  publicBooking(seed: PublicBookingSeed): BookedTagRow;
  /** Seeds one link row and answers it (the stored object). */
  link(seed: LinkSeed): BookedTagRow;
  /** The recorded queries of one table, in order. */
  callsOf(table: BookedTagTable): BookedTagQueryCall[];
}

type TableAnswer = { data: unknown; error: { code: string; message: string } | null };

const ZONED_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const ANY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Postgres-like: null sorts as the largest value; instants by time, UUIDs by value, else by text. */
function compareCells(a: unknown, b: unknown): number {
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  if (aNull || bNull) return aNull === bNull ? 0 : aNull ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') {
    if (ZONED_INSTANT.test(a) && ZONED_INSTANT.test(b)) return Date.parse(a) - Date.parse(b);
    const [x, y] = ANY_UUID.test(a) && ANY_UUID.test(b) ? [a.toLowerCase(), b.toLowerCase()] : [a, b];
    return x < y ? -1 : x > y ? 1 : 0;
  }
  const [x, y] = [String(a), String(b)];
  return x < y ? -1 : x > y ? 1 : 0;
}

/** select / eq / in / order / limit / maybeSingle / then over plain rows, recording the query. */
class BookedTagQuery {
  constructor(
    private readonly rows: () => BookedTagRow[],
    private readonly call: BookedTagQueryCall,
    private readonly failure: BookedTagFailure | undefined,
  ) {}

  select(columns?: string): this {
    this.call.columns = columns ?? null;
    return this;
  }

  eq(column: string, value: unknown): this {
    this.call.filters.push({ op: 'eq', column, value });
    return this;
  }

  in(column: string, values: readonly unknown[]): this {
    this.call.filters.push({ op: 'in', column, value: [...values] });
    return this;
  }

  order(column: string, options: { ascending?: boolean } = {}): this {
    this.call.orders.push({ column, ascending: options.ascending !== false });
    return this;
  }

  limit(count: number): this {
    this.call.limit = count;
    return this;
  }

  private run(): TableAnswer {
    if (this.failure === 'error') return { data: null, error: { code: 'XX000', message: 'fake_db_failure' } };
    const matches = (row: BookedTagRow) =>
      this.call.filters.every((filter) =>
        filter.op === 'eq' ? row[filter.column] === filter.value : (filter.value as unknown[]).includes(row[filter.column]),
      );
    const ordered = this.rows()
      .filter(matches)
      .map((row, index) => ({ row, index }))
      .sort((left, right) => {
        for (const order of this.call.orders) {
          const cmp = compareCells(left.row[order.column], right.row[order.column]);
          if (cmp !== 0) return order.ascending ? cmp : -cmp;
        }
        return left.index - right.index;
      })
      .map(({ row }) => row);
    const limited = this.call.limit === null ? ordered : ordered.slice(0, this.call.limit);
    const columns = this.call.columns === null || this.call.columns.trim() === '*'
      ? null
      : this.call.columns.split(',').map((column) => column.trim());
    return {
      data: limited.map((row) => {
        if (columns === null) return structuredClone(row);
        const out: BookedTagRow = {};
        for (const column of columns) {
          if (Object.prototype.hasOwnProperty.call(row, column)) out[column] = structuredClone(row[column]);
        }
        return out;
      }),
      error: null,
    };
  }

  private settle(terminal: 'maybeSingle' | 'then'): Promise<TableAnswer> {
    this.call.terminal = terminal;
    if (this.failure === 'reject') return Promise.reject(new Error('fake driver detail that must not leak'));
    return Promise.resolve(this.run());
  }

  async maybeSingle(): Promise<TableAnswer> {
    const result = await this.settle('maybeSingle');
    if (result.error) return result;
    const rows = result.data as BookedTagRow[];
    if (rows.length > 1) return { data: null, error: { code: 'PGRST116', message: 'more than one row' } };
    return { data: rows[0] ?? null, error: null };
  }

  then<A = TableAnswer, B = never>(
    onFulfilled?: ((value: TableAnswer) => A | PromiseLike<A>) | null,
    onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return this.settle('then').then(onFulfilled, onRejected);
  }
}

/** The reason a seeded booking carries for its status (one 0142 pairing each; the store never reads it). */
const SEED_REASONS: Readonly<Record<string, string>> = Object.freeze({
  pending: 'eligible',
  bot_scheduled: 'eligible',
  bot_joining: 'eligible',
  human_present: 'eligible',
  in_call: 'eligible',
  blocked: 'paused',
  unmatched_application: 'application_unknown',
  unmapped_scheduler: 'scheduler_unmapped',
  completed: 'attempt_settled',
  cancelled: 'cancelled',
  failed: 'bot_create_failed',
  drained: 'flag_off',
});

export function createBookedTagTables(): BookedTagTables {
  const rows = { r1_meet_bookings: [] as BookedTagRow[], ashby_application_links: [] as BookedTagRow[] };
  const calls: BookedTagQueryCall[] = [];
  const failures = new Map<string, BookedTagFailure[]>();
  const nowMs = Date.parse(HARNESS_NOW);

  const client = {
    from(table: string) {
      const call: BookedTagQueryCall = { table, columns: null, filters: [], orders: [], limit: null, terminal: null };
      calls.push(call);
      const failure = failures.get(table)?.shift();
      if (failure === 'throw') throw new Error('fake builder detail that must not leak');
      if (table !== 'r1_meet_bookings' && table !== 'ashby_application_links') {
        throw new Error(`fake booked-tag tables: no table ${table}`);
      }
      return new BookedTagQuery(() => rows[table], call, failure);
    },
  };

  return {
    rows,
    client: client as unknown as typeof supabase,
    calls,
    failNext(table: BookedTagTable, failure: BookedTagFailure = 'error') {
      const list = failures.get(table) ?? [];
      list.push(failure);
      failures.set(table, list);
    },
    publicBooking(seed: PublicBookingSeed) {
      const source = seed.source ?? 'public_page';
      const status = seed.status ?? 'pending';
      const startAt = seed.startAt ?? new Date(nowMs + 24 * 3600 * 1000).toISOString();
      const isPublic = source === 'public_page';
      const row: BookedTagRow = {
        id: seed.id ?? fixtureId(),
        source,
        status,
        reason: SEED_REASONS[status] ?? 'eligible',
        ashby_interview_event_id: isPublic ? null : fixtureId(),
        ashby_schedule_id: isPublic ? null : fixtureId(),
        ashby_application_id: seed.applicationId,
        ashby_scheduled_by_user_id: isPublic ? null : fixtureId(),
        candidate_id: fixtureId(),
        round_id: fixtureId(),
        meet_url: MEET_URL,
        ticket_digest: 'd'.repeat(64),
        start_at: startAt,
        end_at: new Date(Date.parse(startAt) + 45 * 60 * 1000).toISOString(),
        google_calendar_event_id: isPublic ? 'fakecalendarevent0001' : null,
        calendar_state: isPublic ? 'invited' : null,
        public_request_id: isPublic ? fixtureId() : null,
        manage_token_digest: isPublic ? 'm'.repeat(64) : null,
        move_count: 0,
        created_at: seed.createdAt ?? HARNESS_NOW,
        updated_at: seed.updatedAt ?? HARNESS_NOW,
      };
      rows.r1_meet_bookings.push(row);
      return row;
    },
    link(seed: LinkSeed) {
      const row: BookedTagRow = {
        id: fixtureId(),
        provider: 'ashby',
        external_application_id: seed.applicationId,
        external_candidate_id: seed.candidateId,
        candidate_id: fixtureId(),
        lifecycle: 'imported',
        terminal_state: null,
        created_at: HARNESS_NOW,
        updated_at: HARNESS_NOW,
      };
      rows.ashby_application_links.push(row);
      return row;
    },
    callsOf: (table: BookedTagTable) => calls.filter((call) => call.table === table),
  };
}
