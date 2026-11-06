/**
 * scale-db.ts — an in-memory PostgREST double with the two limits that broke
 * the candidate list in production at workspace scale (M026, 2026-11-04).
 *
 *   1. An `.in()` read sends every value in the GET URL, and the response
 *      echoes that URL in a header. Past about 16 KiB of headers Node's fetch
 *      (undici) rejects the response: `TypeError: fetch failed ...
 *      HeadersOverflowError (UND_ERR_HEADERS_OVERFLOW)`. In production 353 ids
 *      passed and 400 failed. Here a query whose `.in()` lists hold more than
 *      `overflowAt` values in total answers with exactly that error.
 *   2. PostgREST answers at most `max_rows` (1000, app/supabase/config.toml)
 *      rows and truncates anything longer WITHOUT an error. Here every
 *      response is cut at `rowCap` rows, and the cut is recorded.
 *
 * Every query is recorded (`queries`), with whether it overflowed or was
 * truncated, so a test can assert that no read hit either limit. A read that
 * caps ITSELF at the row cap never trips the cut, and is just as partial:
 * `.limit(1000)`, or one `.range(0, 999)` with no next page, answers 1000 of
 * 5,000 rows. `selfCaps()` names those. A test can
 * also fail chosen queries (`failWhen`), make the builder throw (`throwWhen`),
 * act between page reads (`beforeExecute`), shuffle rows the requested order
 * leaves tied (`scrambleTies`), and delay every read to observe concurrency
 * (`delayMs`, `inFlight`, `peak`).
 *
 * A builder method this double does not model is recorded in `unsupported`
 * and throws, so a route can never pass a test because a filter was silently
 * ignored. An embed spelled `candidates!inner(...)` joins on `candidate_id` and
 * drops a row with no match, dotted columns (`candidates.owner_id`) filter on
 * it, `.or()` takes PostgREST's logic grammar with SQL's NULL rules, and a
 * counted read past the end answers 416 (PGRST103), as PostgREST does.
 *
 * Use one engine per test file: point the supabase mock at the shared
 * `scaleDb.client` and reset it before each test.
 *
 *   vi.mock('../lib/supabase.js', async () => {
 *     const { scaleDb } = await import('./support/scale-db.js');
 *     return { supabase: scaleDb.client, RESUME_BUCKET: 'resumes_v2' };
 *   });
 */

export type Row = Record<string, unknown>;

export interface RecordedQuery {
  table: string;
  op: 'select' | 'insert' | 'update' | 'delete';
  /** The `.eq()` filters, in call order. */
  eqs: Array<[string, unknown]>;
  /** Every value passed to `.in()` on this query, all lists together (null when none). */
  inValues: unknown[] | null;
  range: [number, number] | null;
  limit: number | null;
  orders: Array<{ column: string; ascending: boolean }>;
  /** Rows the filters matched, before range, limit and the row cap. */
  matched: number;
  /** Rows the response carried. */
  returned: number;
  /** Refused as undici refuses an oversized response header. */
  overflowed: boolean;
  /** Cut by the row cap, with no error, as PostgREST does. */
  truncated: boolean;
}

/** What undici's rejection looks like once postgrest-js has wrapped it. */
export const UNDICI_OVERFLOW_ERROR = Object.freeze({
  message: 'TypeError: fetch failed',
  details: 'TypeError: fetch failed Caused by: HeadersOverflowError: Headers Overflow Error (UND_ERR_HEADERS_OVERFLOW)',
  hint: '',
  code: '',
});

/** Measured in production on 2026-11-04: 353 ids passed, 400 failed. */
export const PRODUCTION_OVERFLOW_AT = 390;

/** PostgREST `max_rows` (app/supabase/config.toml). */
export const POSTGREST_ROW_CAP = 1000;

export interface ScaleDbOptions {
  /** An `.in()` total above this many values overflows (default PRODUCTION_OVERFLOW_AT). */
  overflowAt?: number;
  /** No response carries more than this many rows (default POSTGREST_ROW_CAP). */
  rowCap?: number;
}

export interface ScaleDb {
  tables: Record<string, Row[]>;
  queries: RecordedQuery[];
  overflowAt: number;
  rowCap: number;
  failWhen: ((q: RecordedQuery) => boolean) | null;
  throwWhen: ((q: RecordedQuery) => boolean) | null;
  beforeExecute: ((q: RecordedQuery) => void) | null;
  scrambleTies: boolean;
  /** When > 0, every read resolves after this many ms, so concurrency can be observed. */
  delayMs: number;
  inFlight: Record<string, number>;
  peak: Record<string, number>;
  /** `table.method` for every builder method a route called that this double does not model. */
  unsupported: string[];
  /** Answers `client.rpc()`. Unset, an rpc call is an error answer. */
  rpc: ((name: string, args: unknown) => { data: unknown; error: unknown }) | null;
  /** Hand this to the supabase mock. */
  client: { from: (table: string) => unknown; rpc: (name: string, args?: unknown) => Promise<{ data: unknown; error: unknown }> };
  /** The queries that overflowed. */
  overflows(): RecordedQuery[];
  /** The queries the row cap cut. */
  truncations(): RecordedQuery[];
  /**
   * The reads that stopped at exactly the row cap by their own `.limit()` or
   * `.range()`, with more rows matched and no next page ever read.
   */
  selfCaps(): RecordedQuery[];
  /** Empty every table and log, clear every control, and apply `options`. */
  reset(options?: ScaleDbOptions): void;
}

/** A small deterministic PRNG, so a scrambled run is reproducible. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/**
 * Two non-null values as Postgres compares them: numbers numerically, two ISO
 * timestamps as instants (`...00Z` equals `...00.000Z`), everything else by
 * its string form (dates and uuids sort correctly that way).
 */
function compareNonNull(x: unknown, y: unknown): number {
  if (typeof x === 'number' && typeof y === 'number') return x - y;
  if (typeof x === 'string' && typeof y === 'string' && TIMESTAMP.test(x) && TIMESTAMP.test(y)) {
    const a = Date.parse(x);
    const b = Date.parse(y);
    if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return a - b;
    if (Number.isFinite(a) && Number.isFinite(b)) return 0;
  }
  const a = String(x);
  const b = String(y);
  return a === b ? 0 : a < b ? -1 : 1;
}

/**
 * Postgres ordering. NULLs sort LAST ascending and FIRST descending unless
 * `nullsFirst` says otherwise.
 */
function compareValues(x: unknown, y: unknown, ascending: boolean, nullsFirst: boolean | undefined): number {
  const xNull = x === null || x === undefined;
  const yNull = y === null || y === undefined;
  if (xNull || yNull) {
    if (xNull && yNull) return 0;
    const nullFirst = nullsFirst ?? !ascending;
    return (xNull ? -1 : 1) * (nullFirst ? 1 : -1);
  }
  const c = compareNonNull(x, y);
  return ascending ? c : -c;
}

/** Non-null comparison filters (`gt`, `lte`, ...): NULL never matches, as in SQL. */
function comparable(value: unknown, against: unknown): number | null {
  if (value === null || value === undefined) return null;
  return compareNonNull(value, against);
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** LIKE as Postgres reads it: a backslash escapes the next character, and PostgREST takes `*` for `%`. */
function likeToRegExp(pattern: string, flags: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '\\' && i + 1 < pattern.length) {
      i += 1;
      source += escapeRegExp(pattern[i]);
    } else if (c === '%' || c === '*') source += '.*';
    else if (c === '_') source += '.';
    else source += escapeRegExp(c);
  }
  return new RegExp(`^${source}$`, flags);
}

/** A column of the row, or of a row embedded in it: `candidates.owner_id`. */
function valueAt(row: Row, column: string): unknown {
  const dot = column.indexOf('.');
  if (dot === -1) return row[column];
  const embedded = row[column.slice(0, dot)];
  return typeof embedded === 'object' && embedded !== null ? (embedded as Row)[column.slice(dot + 1)] : undefined;
}

/** Split a logic list on its top-level commas: parentheses nest. */
function splitTopLevel(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] === '(') depth += 1;
    else if (list[i] === ')') depth -= 1;
    else if (list[i] === ',' && depth === 0) {
      parts.push(list.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(list.slice(start));
  return parts;
}

/** Whether a filter holds, or null when SQL answers NULL, which a `not` leaves NULL. */
function leafTest(row: Row, column: string, op: string, value: string): boolean | null {
  const actual = valueAt(row, column);
  if (op === 'is') {
    if (value !== 'null') throw new Error(`scale-db: .or() is.${value} is not modelled`);
    return actual === null || actual === undefined;
  }
  if (actual === null || actual === undefined) return null;
  if (op === 'eq') return String(actual) === value;
  if (op === 'neq') return String(actual) !== value;
  if (op === 'in') return splitTopLevel(value.slice(1, -1)).includes(String(actual));
  // Every value in the grammar is text: a number column still compares as a number.
  const c = compareNonNull(actual, typeof actual === 'number' ? Number(value) : value);
  return op === 'gt' ? c > 0 : op === 'gte' ? c >= 0 : op === 'lt' ? c < 0 : c <= 0;
}

/** One item of PostgREST's logic grammar: `and(...)`, `or(...)` or `column[.not].op.value`. */
function logicItem(item: string): (r: Row) => boolean {
  const group = /^(and|or)\((.*)\)$/.exec(item);
  if (group) {
    const items = splitTopLevel(group[2]).map(logicItem);
    return group[1] === 'and' ? (r) => items.every((f) => f(r)) : (r) => items.some((f) => f(r));
  }
  const leaf = /^([\w.]+?)\.(not\.)?(eq|neq|is|in|gte|gt|lte|lt)\.(.*)$/.exec(item);
  if (!leaf) throw new Error(`scale-db: .or() item ${item} is not modelled`);
  const [, column, negated, op, value] = leaf;
  return (r) => {
    const held = leafTest(r, column, op, value);
    return held === null ? false : negated ? !held : held;
  };
}

/** Properties that tooling may read off a builder without it being a query method. */
const INTROSPECTION = new Set(['toJSON', 'constructor', 'asymmetricMatch', '$$typeof', 'nodeType', 'toString', 'valueOf', 'inspect', 'catch', 'finally']);

const isForeign = (opts: unknown): boolean => {
  const o = opts as { foreignTable?: unknown; referencedTable?: unknown } | undefined;
  return !!o && (o.foreignTable !== undefined || o.referencedTable !== undefined);
};

/** Two pages of one read: the same table, equality filters and id list. */
const sameRead = (a: RecordedQuery, b: RecordedQuery): boolean =>
  a.table === b.table
  && JSON.stringify(a.eqs) === JSON.stringify(b.eqs)
  && JSON.stringify(a.inValues) === JSON.stringify(b.inValues);

export function createScaleDb(options: ScaleDbOptions = {}): ScaleDb {
  let seedCounter = 0;

  const engine: ScaleDb = {
    tables: {},
    queries: [],
    overflowAt: options.overflowAt ?? PRODUCTION_OVERFLOW_AT,
    rowCap: options.rowCap ?? POSTGREST_ROW_CAP,
    failWhen: null,
    throwWhen: null,
    beforeExecute: null,
    scrambleTies: false,
    delayMs: 0,
    inFlight: {},
    peak: {},
    unsupported: [],
    rpc: null,
    client: {
      from: (table: string) => builder(table),
      rpc: async (name: string, args?: unknown) => (engine.rpc
        ? engine.rpc(name, args)
        : { data: null, error: { message: `rpc ${name} is not stubbed`, details: '', hint: '', code: 'PGRST202' } }),
    },
    overflows: () => engine.queries.filter((q) => q.overflowed),
    truncations: () => engine.queries.filter((q) => q.truncated),
    selfCaps: () => engine.queries.filter((q, i) => {
      if (q.op !== 'select' || q.truncated || q.returned !== engine.rowCap) return false;
      const first = q.range?.[0] ?? 0;
      if (q.matched <= first + q.returned) return false;
      if (!q.range) return true;
      const nextFrom = q.range[1] + 1;
      return !engine.queries.some((later, j) => j > i && later.range?.[0] === nextFrom && sameRead(later, q));
    }),
    reset(next: ScaleDbOptions = {}) {
      for (const k of Object.keys(engine.tables)) delete engine.tables[k];
      engine.queries.length = 0;
      engine.unsupported.length = 0;
      engine.failWhen = null;
      engine.throwWhen = null;
      engine.beforeExecute = null;
      engine.scrambleTies = false;
      engine.delayMs = 0;
      engine.rpc = null;
      engine.overflowAt = next.overflowAt ?? PRODUCTION_OVERFLOW_AT;
      engine.rowCap = next.rowCap ?? POSTGREST_ROW_CAP;
      for (const k of Object.keys(engine.inFlight)) delete engine.inFlight[k];
      for (const k of Object.keys(engine.peak)) delete engine.peak[k];
      seedCounter = 0;
    },
  };

  function builder(table: string): unknown {
    const q: RecordedQuery = {
      table, op: 'select', eqs: [], inValues: null, range: null, limit: null, orders: [],
      matched: 0, returned: 0, overflowed: false, truncated: false,
    };
    const filters: Array<(r: Row) => boolean> = [];
    const orderSpecs: Array<{ column: string; ascending: boolean; nullsFirst?: boolean }> = [];
    const innerEmbeds: string[] = [];
    let single: 'single' | 'maybeSingle' | null = null;
    let countRequested = false;
    let head = false;
    let payload: unknown = null;

    const b: Record<string, unknown> = {};
    const chain = <A extends unknown[]>(fn: (...args: A) => void) => (...args: A) => { fn(...args); return proxy; };

    b.select = chain((columns?: string, opts?: { count?: string; head?: boolean }) => {
      if (opts?.count) countRequested = true;
      if (opts?.head) head = true;
      for (const embed of (columns ?? '').matchAll(/(\w+)!inner\(/g)) innerEmbeds.push(embed[1]);
    });
    b.eq = chain((column: string, value: unknown) => {
      q.eqs.push([column, value]);
      filters.push((r) => valueAt(r, column) === value);
    });
    b.neq = chain((column: string, value: unknown) => {
      filters.push((r) => { const v = valueAt(r, column); return v !== null && v !== undefined && v !== value; });
    });
    const cmp = (test: (c: number) => boolean) => chain((column: string, value: unknown) => {
      filters.push((r) => { const c = comparable(valueAt(r, column), value); return c !== null && test(c); });
    });
    b.gt = cmp((c) => c > 0);
    b.gte = cmp((c) => c >= 0);
    b.lt = cmp((c) => c < 0);
    b.lte = cmp((c) => c <= 0);
    b.like = chain((column: string, pattern: string) => {
      const re = likeToRegExp(pattern, '');
      filters.push((r) => { const v = valueAt(r, column); return typeof v === 'string' && re.test(v); });
    });
    b.ilike = chain((column: string, pattern: string) => {
      const re = likeToRegExp(pattern, 'i');
      filters.push((r) => { const v = valueAt(r, column); return typeof v === 'string' && re.test(v); });
    });
    b.is = chain((column: string, value: unknown) => {
      filters.push((r) => { const v = valueAt(r, column); return value === null ? v == null : v === value; });
    });
    b.not = chain((column: string, op: string, value: unknown) => {
      if (op === 'is' && value === null) filters.push((r) => valueAt(r, column) != null);
      else if (op === 'eq') filters.push((r) => { const v = valueAt(r, column); return v != null && v !== value; });
      else {
        engine.unsupported.push(`${table}.not(${op})`);
        throw new Error(`scale-db: .not(column, '${op}', ...) is not modelled`);
      }
    });
    b.in = chain((column: string, values: readonly unknown[]) => {
      q.inValues = [...(q.inValues ?? []), ...values];
      const set = new Set(values);
      filters.push((r) => set.has(valueAt(r, column)));
    });
    b.or = chain((list: string) => {
      try {
        const items = splitTopLevel(list).map(logicItem);
        filters.push((r) => items.some((f) => f(r)));
      } catch (error) {
        engine.unsupported.push(`${table}.or(${list})`);
        throw error;
      }
    });
    b.order = chain((column: string, opts?: { ascending?: boolean; nullsFirst?: boolean; foreignTable?: string; referencedTable?: string }) => {
      if (isForeign(opts)) return;
      const ascending = opts?.ascending !== false;
      orderSpecs.push({ column, ascending, nullsFirst: opts?.nullsFirst });
      q.orders.push({ column, ascending });
    });
    b.limit = chain((n: number, opts?: unknown) => { if (!isForeign(opts)) q.limit = n; });
    b.range = chain((from: number, to: number, opts?: unknown) => { if (!isForeign(opts)) q.range = [from, to]; });
    b.single = chain(() => { single = 'single'; });
    b.maybeSingle = chain(() => { single = 'maybeSingle'; });
    b.abortSignal = chain(() => {});
    b.returns = chain(() => {});
    b.insert = chain((rows: unknown) => { q.op = 'insert'; payload = rows; });
    b.update = chain((patch: unknown) => { q.op = 'update'; payload = patch; });
    b.delete = chain(() => { q.op = 'delete'; });

    const execute = (): { data: unknown; error: unknown; count?: number | null; status: number } => {
      engine.queries.push(q);
      if (engine.throwWhen?.(q)) throw new Error('driver-detail postgres://10.0.0.5 user@example.com');
      engine.beforeExecute?.(q);
      if ((q.inValues?.length ?? 0) > engine.overflowAt) {
        q.overflowed = true;
        return { data: null, error: { ...UNDICI_OVERFLOW_ERROR }, status: 0 };
      }
      if (engine.failWhen?.(q)) return { data: null, error: { message: 'boom', details: '', hint: '', code: 'XX000' }, status: 500 };

      const stored = (engine.tables[table] ??= []);
      if (q.op === 'insert') {
        const list = (Array.isArray(payload) ? payload : [payload]) as Row[];
        stored.push(...list.map((r) => ({ ...r })));
        return { data: null, error: null, status: 201 };
      }
      if (q.op === 'update' || q.op === 'delete') {
        const hit = stored.filter((r) => filters.every((f) => f(r)));
        if (q.op === 'update') for (const r of hit) Object.assign(r, payload as Row);
        else engine.tables[table] = stored.filter((r) => !hit.includes(r));
        return { data: null, error: null, status: 204 };
      }

      // The `!inner` joins: a row without its match is gone, as in the SQL.
      let joined = stored;
      for (const embed of innerEmbeds) {
        const byId = new Map((engine.tables[embed] ?? []).map((row) => [row.id, row]));
        const key = `${embed.replace(/s$/, '')}_id`;
        joined = joined.flatMap((row) => (byId.has(row[key]) ? [{ ...row, [embed]: byId.get(row[key]) }] : []));
      }
      let rows = joined.filter((r) => filters.every((f) => f(r)));
      q.matched = rows.length;
      if (countRequested && q.range && q.range[0] > q.matched) {
        return {
          data: null,
          error: { message: 'Requested range not satisfiable', details: `An offset of ${q.range[0]} was requested, but there are only ${q.matched} rows.`, hint: null, code: 'PGRST103' },
          count: null,
          status: 416,
        };
      }
      if (engine.scrambleTies) {
        const rand = prng(++seedCounter);
        rows = rows.map((r) => [rand(), r] as const).sort((x, y) => x[0] - y[0]).map(([, r]) => r);
      }
      if (orderSpecs.length > 0) {
        rows = [...rows].sort((x, y) => {
          for (const o of orderSpecs) {
            const c = compareValues(x[o.column], y[o.column], o.ascending, o.nullsFirst);
            if (c !== 0) return c;
          }
          return 0;
        });
      }
      if (q.range) rows = rows.slice(q.range[0], q.range[1] + 1);
      if (q.limit !== null) rows = rows.slice(0, q.limit);
      if (rows.length > engine.rowCap) {
        q.truncated = true;
        rows = rows.slice(0, engine.rowCap);
      }
      q.returned = rows.length;
      const count = countRequested ? q.matched : null;
      if (head) return { data: null, error: null, count, status: 200 };
      const copies = rows.map((r) => ({ ...r }));
      if (single) {
        if (copies.length === 1) return { data: copies[0], error: null, count, status: 200 };
        if (copies.length === 0 && single === 'maybeSingle') return { data: null, error: null, count, status: 200 };
        return {
          data: null,
          error: { message: 'JSON object requested, multiple (or no) rows returned', details: `The result contains ${copies.length} rows`, hint: null, code: 'PGRST116' },
          status: 406,
        };
      }
      return { data: copies, error: null, count, status: 200 };
    };

    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      if (engine.delayMs > 0) {
        engine.inFlight[table] = (engine.inFlight[table] ?? 0) + 1;
        engine.peak[table] = Math.max(engine.peak[table] ?? 0, engine.inFlight[table]);
        return new Promise((r) => setTimeout(r, engine.delayMs))
          .then(() => execute())
          .finally(() => { engine.inFlight[table] -= 1; })
          .then(resolve, reject);
      }
      try {
        return Promise.resolve(execute()).then(resolve, reject);
      } catch (error) {
        return Promise.reject(error).then(resolve, reject);
      }
    };

    const proxy: unknown = new Proxy(b, {
      get(target, prop) {
        if (typeof prop !== 'string' || prop in target) return target[prop as string];
        if (INTROSPECTION.has(prop)) return undefined;
        engine.unsupported.push(`${table}.${prop}`);
        throw new Error(`scale-db: .${prop}() is not modelled`);
      },
    });
    return proxy;
  }

  return engine;
}

/** The engine a test file's supabase mock points at. Reset it before each test. */
export const scaleDb = createScaleDb();
