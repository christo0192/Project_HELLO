/**
 * L3 stitched-integration + chaos harness (TST-03 / TST-10).
 *
 * Phase-6 lane L3 (PR1): integration-session-flow + chaos-failure-injection
 * exercise the REAL public seams — L1 queue (`Queue` + `MemoryAdapter`),
 * transactional outbox / durable transcript events (REL-02/03), session
 * lifecycle CAS state machine (REL-07) and reconciliation (REL-09) — with
 * only the two I/O boundaries emulated in-memory:
 *
 *   1. Supabase (DB):   MemoryDb — a stateful in-memory emulator that mirrors
 *                       the migration semantics the code relies on
 *                       (UNIQUE(session_id, turn_index) dedup on
 *                       transcript_events, CAS update rows, ordered reads,
 *                       and the four reconciliation RPCs from 0011).
 *   2. Provider (LLM):  scripted child-process spawn fed through the REAL
 *                       createClaudeRunner() (real breaker, real timeout,
 *                       real JSON extraction, real error taxonomy). The
 *                       harness NEVER spawns a real `claude` process.
 *
 * Fault injection is boundary-level and deterministic: per-op DB faults,
 * scripted provider spawn failures (exit codes, spawn errors, hangs), a
 * faulting queue-adapter wrapper, and worker-kill scripts at lifecycle
 * boundaries. Nothing here re-implements product logic; the assertions in
 * the tests are made against real queue/outbox/reconciler/session output.
 *
 * Safety: this module never opens sockets, spawns processes, or reads
 * secrets. It is only imported from tests.
 */

import { Readable, Writable } from 'node:stream';
import { Queue } from '../../lib/queue/index.js';
import { MemoryAdapter } from '../../lib/queue/memory-adapter.js';
import type { IQueueAdapter, QueueJob } from '../../lib/queue/types.js';
import type {
  ReconciliationIssue,
  RepairPlan,
  RepairResult,
  ReconciliationReport,
} from '../../lib/reconciliation.js';
import {
  CircuitBreaker,
  MonotonicClock,
  DefaultTimerSet,
} from '../../lib/provider-resilience.js';
import type { Clock, TimerSet } from '../../lib/provider-resilience.js';
import type { ClaudeRunner, ClaudeRunnerDeps } from '../../lib/claude.js';

// NOTE: lib/outbox.js and lib/reconciliation.js are imported DYNAMICALLY
// inside the functions that use them. This harness is loaded from vi.mock
// factories and must not pull supabase-dependent modules into its static
// import graph (avoids factory/import-order cycles).

// ═══════════════════════════════════════════════════════════════════════
// 1. Deterministic identifiers + clock helpers
// ═══════════════════════════════════════════════════════════════════════

let uuidCounter = 0;

/** Deterministic UUID v4-format identifier (passes the app's UUID regexes). */
export function makeUuid(seed?: number): string {
  const n = seed ?? ++uuidCounter;
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

export function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

/** Injectable monotonic clock for deterministic breaker/cooldown tests. */
export function makeMonotonicClock(): { clock: Clock; advance(ms: number): void } {
  let t = 0;
  return { clock: { now: () => t }, advance: (ms) => { t += ms; } };
}

/** Controllable wall clock for deterministic queue retry/backoff timing. */
export function makeTickableClock(startIso = '2026-01-01T00:00:00.000Z'): {
  clock: () => string;
  nowMs(): number;
  tick(ms: number): void;
} {
  let t = Date.parse(startIso);
  return {
    clock: () => new Date(t).toISOString(),
    nowMs: () => t,
    tick: (ms: number) => { t += ms; },
  };
}

/**
 * TimerSet whose timeouts fire on the next microtask. Used ONLY for the
 * deterministic provider-hang case: the runner's deadline timer fires
 * immediately, so a hung provider is rejected with ClaudeError('timeout')
 * without waiting 30 s and without creating real timer handles.
 */
export function makeAutoTimeoutTimers(): TimerSet {
  return {
    setTimeout: ((fn: (...args: unknown[]) => void) => {
      queueMicrotask(() => fn());
      return 1;
    }) as unknown as TimerSet['setTimeout'],
    clearTimeout: (() => {}) as unknown as TimerSet['clearTimeout'],
  };
}

// ═══════════════════════════════════════════════════════════════════════
// 2. In-memory Supabase emulator (DB boundary)
// ═══════════════════════════════════════════════════════════════════════

export type DbRow = Record<string, unknown>;
export interface SupabaseResult {
  data: unknown;
  error: { message: string } | null;
}
export interface SupabaseCountResult {
  count: number | null;
  error: { message: string } | null;
}

/** UNIQUE constraint sets that mirror the migrations the code relies on. */
const TABLE_UNIQUES: Record<string, string[][]> = {
  transcript_events: [['session_id', 'turn_index']], // 0010: dedup key
  quarantined_sessions: [['session_id']],            // 0011: idempotent quarantine
  reconciliation_log: [['issue_signature']],         // 0011: idempotent detection
  transcript_turns: [],   // 0001: NO unique constraint (limitation, see handoff)
  call_sessions: [],
  candidates: [],
  roles: [],
  outbox: [],
  assessments: [],
  audit_events: [],
  candidate_invites: [],
  candidate_access_grants: [],
};

type DbOp = 'insert' | 'upsert' | 'update' | 'delete' | 'read';
interface FaultSpec {
  op: DbOp | 'rpc';
  table?: string;
  remaining: number;
}

type PredicateOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'is' | 'in';
interface Predicate { col: string; op: PredicateOp; value: unknown; }

export class MemoryDb {
  private store: Record<string, DbRow[]> = {};
  private faults: FaultSpec[] = [];
  private clock: () => string;

  constructor(clock: () => string = () => new Date().toISOString()) {
    this.clock = clock;
    for (const t of Object.keys(TABLE_UNIQUES)) this.store[t] = [];
  }

  nowIso(): string { return this.clock(); }
  nowMs(): number { return Date.parse(this.clock()); }

  /** Reset all state — call between tests (no mutation leaks). */
  reset(): void {
    for (const t of Object.keys(this.store)) this.store[t] = [];
    this.faults = [];
  }

  /** Deterministic fault injection at the DB boundary. */
  injectFault(op: DbOp | 'rpc', table?: string, times = 1): void {
    this.faults.push({ op, table, remaining: times });
  }
  clearFaults(): void { this.faults = []; }

  private consumeFault(op: DbOp | 'rpc', table: string): boolean {
    for (const f of this.faults) {
      if (f.op === op && (f.table === undefined || f.table === table) && f.remaining > 0) {
        f.remaining -= 1;
        return true;
      }
    }
    return false;
  }

  // ── Public query surface (mirrors @supabase/supabase-js usage) ────────

  from(table: string): QueryBuilder {
    return new QueryBuilder(this, table);
  }

  async rpc(name: string, args: Record<string, unknown> = {}): Promise<SupabaseResult> {
    if (this.consumeFault('rpc', name)) {
      return { data: null, error: { message: 'simulated rpc failure' } };
    }
    try {
      const data = this.runRpc(name, args);
      return { data, error: null };
    } catch (err) {
      return { data: null, error: { message: err instanceof Error ? err.message : 'rpc failed' } };
    }
  }

  storage: Record<string, unknown> = {
    from: () => ({
      upload: async () => ({ data: { path: 'stub' }, error: null }),
      createSignedUrl: async () => ({ data: { signedUrl: 'stub' }, error: null }),
    }),
  };

  // ── Inspection helpers for tests (read-only views of the emulated DB) ─

  rows(table: string): DbRow[] {
    return this.store[table]?.map((r) => clone(r)) ?? [];
  }
  count(table: string): number {
    return this.store[table]?.length ?? 0;
  }
  findOne(table: string, predicate: (row: DbRow) => boolean): DbRow | null {
    const row = this.store[table]?.find(predicate);
    return row ? clone(row) : null;
  }

  // ── Internal execution ────────────────────────────────────────────────

  private nextId(): string {
    const base = makeUuid();
    return base;
  }

  private matches(row: DbRow, predicates: Predicate[]): boolean {
    for (const p of predicates) {
      const v = row[p.col];
      const val = p.value;
      switch (p.op) {
        case 'eq': if (v !== val) return false; break;
        case 'neq': if (v === val) return false; break;
        case 'gt': if (!compareForPredicate(v, val, (a, b) => a > b)) return false; break;
        case 'gte': if (!compareForPredicate(v, val, (a, b) => a >= b)) return false; break;
        case 'lt': if (!compareForPredicate(v, val, (a, b) => a < b)) return false; break;
        case 'lte': if (!compareForPredicate(v, val, (a, b) => a <= b)) return false; break;
        case 'is': if (val === null ? v !== null : v === null) return false; break;
        case 'in': {
          const arr = Array.isArray(val) ? val : [val];
          if (!arr.includes(v)) return false; break;
        }
      }
    }
    return true;
  }

  private insertRow(table: string, payload: DbRow): DbRow {
    const defs = TABLE_UNIQUES[table] ?? [];
    for (const cols of defs) {
      const conflict = this.store[table].find((r) => cols.every((c) => r[c] === payload[c]));
      if (conflict) {
        throw new Error(
          `duplicate key value violates unique constraint (${cols.join(', ')})`,
        );
      }
    }
    const now = this.clock();
    const row: DbRow = { ...clone(payload) };
    if (row.id === undefined || row.id === null) row.id = this.nextId();
    if (row.created_at === undefined) row.created_at = now;
    // call_sessions.started_at defaults to now() in the DB (0001).
    if (table === 'call_sessions' && row.started_at === undefined) row.started_at = now;
    // Null-defaulted columns the code matches with `.is(col, null)` (0001/0006).
    if (table === 'call_sessions') {
      if (row.owner_id === undefined) row.owner_id = null;
      if (row.external_call_id === undefined) row.external_call_id = null;
      if (row.recording_object_key === undefined) row.recording_object_key = null;
      if (row.terminal_reason === undefined) row.terminal_reason = null;
      if (row.ended_at === undefined) row.ended_at = null;
      if (row.waiting_at === undefined) row.waiting_at = null;
    }
    this.store[table].push(row);
    return clone(row);
  }

  private project(row: DbRow, cols: string[] | null): DbRow {
    if (cols === null) return clone(row);
    const out: DbRow = {};
    for (const c of cols) if (c in row) out[c] = clone(row[c]);
    return out;
  }

  doRead(
    table: string, predicates: Predicate[],
    orderBy?: { col: string; asc: boolean }, limitVal?: number,
    rangeVal?: [number, number], cols: string[] | null = null,
    countMode = false, single = false, maybeSingle = false,
  ): SupabaseResult | SupabaseCountResult {
    if (this.consumeFault('read', table)) {
      return countMode
        ? { count: null, error: { message: 'simulated read failure' } }
        : { data: null, error: { message: 'simulated read failure' } };
    }
    let rows = (this.store[table] ?? []).filter((r) => this.matches(r, predicates));
    if (orderBy) {
      const { col, asc } = orderBy;
      rows = [...rows].sort((a, b) => {
        const va = a[col]; const vb = b[col];
        if (va === vb) return 0;
        if (va === null || va === undefined) return 1;
        if (vb === null || vb === undefined) return -1;
        const cmp = typeof va === 'number' && typeof vb === 'number'
          ? va - vb
          : String(va).localeCompare(String(vb));
        return asc ? cmp : -cmp;
      });
    }
    if (rangeVal) rows = rows.slice(rangeVal[0], rangeVal[1] + 1);
    if (limitVal !== undefined && rows.length > limitVal) rows = rows.slice(0, limitVal);

    if (countMode) return { count: rows.length, error: null };

    if (single) {
      if (rows.length === 0) return { data: null, error: { message: 'no rows returned' } };
      if (rows.length > 1) return { data: null, error: { message: 'multiple rows returned' } };
      return { data: this.project(rows[0], cols), error: null };
    }
    if (maybeSingle) {
      return { data: rows.length > 0 ? this.project(rows[0], cols) : null, error: null };
    }
    return { data: rows.map((r) => this.project(r, cols)), error: null };
  }

  doInsert(
    table: string, payload: DbRow | DbRow[],
    wantRows: boolean, cols: string[] | null, single: boolean,
  ): SupabaseResult {
    if (this.consumeFault('insert', table)) {
      return { data: null, error: { message: 'simulated insert failure' } };
    }
    try {
      const arr = Array.isArray(payload) ? payload : [payload];
      const inserted = arr.map((p) => this.insertRow(table, p));
      if (!wantRows) return { data: null, error: null }; // no .select() → no rows returned
      const projected = inserted.map((r) => this.project(r, cols));
      if (single) return { data: projected[0] ?? null, error: null };
      return { data: projected, error: null };
    } catch (err) {
      return { data: null, error: { message: err instanceof Error ? err.message : 'insert failed' } };
    }
  }

  doUpsert(
    table: string, payload: DbRow | DbRow[],
    opts: { onConflict?: string; ignoreDuplicates?: boolean },
    wantRows: boolean, cols: string[] | null, single: boolean,
  ): SupabaseResult {
    if (this.consumeFault('upsert', table)) {
      return { data: null, error: { message: 'simulated upsert failure' } };
    }
    try {
      const conflictCols = (opts.onConflict ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const arr = Array.isArray(payload) ? payload : [payload];
      const result: DbRow[] = [];
      for (const p of arr) {
        const existing = conflictCols.length > 0
          ? this.store[table].find((r) => conflictCols.every((c) => r[c] === p[c]))
          : undefined;
        if (existing && opts.ignoreDuplicates) {
          result.push(clone(existing));
        } else {
          result.push(this.insertRow(table, p));
        }
      }
      if (!wantRows) return { data: null, error: null };
      const projected = result.map((r) => this.project(r, cols));
      if (single) return { data: projected[0] ?? null, error: null };
      return { data: projected, error: null };
    } catch (err) {
      return { data: null, error: { message: err instanceof Error ? err.message : 'upsert failed' } };
    }
  }

  doUpdate(
    table: string, payload: DbRow, predicates: Predicate[],
    wantRows: boolean, cols: string[] | null, single: boolean, maybeSingle: boolean,
  ): SupabaseResult {
    if (this.consumeFault('update', table)) {
      return { data: null, error: { message: 'simulated update failure' } };
    }
    const targets = this.store[table].filter((r) => this.matches(r, predicates));
    const updated = targets.map((r) => {
      Object.assign(r, clone(payload));
      return clone(r);
    });
    if (!wantRows) return { data: null, error: null };
    const projected = updated.map((r) => this.project(r, cols));
    if (single) return { data: projected[0] ?? null, error: null };
    if (maybeSingle) return { data: projected[0] ?? null, error: null };
    return { data: projected, error: null };
  }

  doDelete(table: string, predicates: Predicate[]): SupabaseResult {
    if (this.consumeFault('delete', table)) {
      return { data: null, error: { message: 'simulated delete failure' } };
    }
    this.store[table] = this.store[table].filter((r) => !this.matches(r, predicates));
    return { data: [], error: null };
  }

  // ── RPC emulation: the four reconciliation functions from migration 0011 ─

  private runRpc(name: string, args: Record<string, unknown>): DbRow[] {
    const now = Date.parse(this.clock());
    const sessions = this.store.call_sessions ?? [];
    const turns = this.store.transcript_turns ?? [];
    const assessments = this.store.assessments ?? [];

    switch (name) {
      case 'stuck_sessions': {
        const waitingSec = Number(args.waiting_timeout_sec ?? 300);
        const createdSec = Number(args.created_timeout_sec ?? 1800);
        const progressSec = Number(args.progress_timeout_sec ?? 7200);
        const out: DbRow[] = [];
        for (const s of sessions) {
          if (s.status === 'waiting' && s.waiting_at != null) {
            const dur = (now - Date.parse(String(s.waiting_at))) / 1000;
            if (dur > waitingSec) {
              out.push({ session_id: s.id, status: 'waiting', state_duration_sec: dur, candidate_id: s.candidate_id, reason_hint: 'stuck_in_waiting' });
            }
          } else if (s.status === 'created') {
            const dur = (now - Date.parse(String(s.started_at))) / 1000;
            if (dur > createdSec) {
              out.push({ session_id: s.id, status: 'created', state_duration_sec: dur, candidate_id: s.candidate_id, reason_hint: 'stuck_in_created' });
            }
          } else if (s.status === 'in_progress') {
            const dur = (now - Date.parse(String(s.started_at))) / 1000;
            if (dur > progressSec) {
              out.push({ session_id: s.id, status: 'in_progress', state_duration_sec: dur, candidate_id: s.candidate_id, reason_hint: 'stuck_in_progress' });
            }
          }
        }
        out.sort((a, b) => Number(b.state_duration_sec) - Number(a.state_duration_sec));
        return out;
      }
      case 'sessions_without_transcripts': {
        const terminal = new Set(['completed', 'failed']);
        return sessions
          .filter((s) => terminal.has(String(s.status)) && !turns.some((t) => t.session_id === s.id))
          .map((s) => ({ session_id: s.id, candidate_id: s.candidate_id, ended_at: s.ended_at, status: s.status }));
      }
      case 'sessions_missing_recording': {
        return sessions
          .filter((s) => s.status === 'completed' && (s.recording_object_key === null || s.recording_object_key === undefined))
          .map((s) => ({ session_id: s.id, candidate_id: s.candidate_id, ended_at: s.ended_at, status: s.status }));
      }
      case 'missing_assessment_sessions': {
        return sessions
          .filter((s) => s.status === 'completed' && !assessments.some((a) => a.session_id === s.id))
          .map((s) => ({ session_id: s.id, candidate_id: s.candidate_id, completed_at: s.ended_at, status: s.status }));
      }
      default:
        return [];
    }
  }
}

/** Deep-copy rows so tests cannot alias emulator state. */
function clone<T>(v: T): T {
  if (v === null || v === undefined || typeof v !== 'object') return v;
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Ordered comparison for predicates. Supports numbers and ISO-8601 strings
 * (lexicographic ordering is chronological for RFC3339 UTC timestamps).
 */
function compareForPredicate(a: unknown, b: unknown, cmp: (x: number, y: number) => boolean): boolean {
  if (typeof a === 'number' && typeof b === 'number') return cmp(a, b);
  if (typeof a === 'string' && typeof b === 'string') return cmp(a.localeCompare(b), 0);
  return false;
}

/** Chainable query builder with real supabase-js resolution semantics. */
export class QueryBuilder {
  private op: DbOp = 'read';
  private payload?: DbRow | DbRow[];
  private upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {};
  private predicates: Predicate[] = [];
  private orderBy?: { col: string; asc: boolean };
  private limitVal?: number;
  private rangeVal?: [number, number];
  private cols: string[] | null = null;
  private selectCalled = false;
  private countMode = false;
  private singleMode = false;
  private maybeSingleMode = false;
  private executed = false;

  constructor(private db: MemoryDb, private table: string) {}

  select(cols?: string | Record<string, unknown>): this {
    if (cols && typeof cols === 'object') {
      this.countMode = true;
      return this;
    }
    this.selectCalled = true;
    this.cols = cols === undefined || cols === '*' ? null : cols.split(',').map((c) => c.trim());
    return this;
  }
  insert(payload: DbRow | DbRow[]): this { this.op = 'insert'; this.payload = payload; return this; }
  upsert(payload: DbRow | DbRow[], opts: { onConflict?: string; ignoreDuplicates?: boolean } = {}): this {
    this.op = 'upsert'; this.payload = payload; this.upsertOpts = opts; return this;
  }
  update(payload: DbRow): this { this.op = 'update'; this.payload = payload; return this; }
  delete(): this { this.op = 'delete'; return this; }
  eq(col: string, value: unknown): this { this.predicates.push({ col, op: 'eq', value }); return this; }
  neq(col: string, value: unknown): this { this.predicates.push({ col, op: 'neq', value }); return this; }
  gt(col: string, value: unknown): this { this.predicates.push({ col, op: 'gt', value }); return this; }
  gte(col: string, value: unknown): this { this.predicates.push({ col, op: 'gte', value }); return this; }
  lt(col: string, value: unknown): this { this.predicates.push({ col, op: 'lt', value }); return this; }
  lte(col: string, value: unknown): this { this.predicates.push({ col, op: 'lte', value }); return this; }
  is(col: string, value: unknown): this { this.predicates.push({ col, op: 'is', value }); return this; }
  in(col: string, values: unknown[]): this { this.predicates.push({ col, op: 'in', value: values }); return this; }
  order(col: string, opts: { ascending?: boolean } = {}): this {
    this.orderBy = { col, asc: opts.ascending ?? true }; return this;
  }
  limit(n: number): this { this.limitVal = n; return this; }
  range(from: number, to: number): this { this.rangeVal = [from, to]; return this; }
  single(): this { this.singleMode = true; return this; }
  maybeSingle(): this { this.maybeSingleMode = true; return this; }

  then<TResult>(
    onFulfilled?: (value: SupabaseResult | SupabaseCountResult) => TResult | PromiseLike<TResult>,
    onRejected?: (reason: unknown) => TResult | PromiseLike<TResult>,
  ): Promise<TResult> {
    return this.execute().then(onFulfilled, onRejected);
  }
  catch<TResult>(onRejected: (reason: unknown) => TResult | PromiseLike<TResult>): Promise<TResult> {
    return this.execute().then(undefined, onRejected);
  }

  private execute(): Promise<SupabaseResult | SupabaseCountResult> {
    if (this.executed) return Promise.resolve({ data: null, error: null });
    this.executed = true;
    switch (this.op) {
      case 'insert': return Promise.resolve(this.db.doInsert(this.table, this.payload as DbRow | DbRow[], this.selectCalled, this.cols, this.singleMode));
      case 'upsert': return Promise.resolve(this.db.doUpsert(this.table, this.payload as DbRow | DbRow[], this.upsertOpts, this.selectCalled, this.cols, this.singleMode));
      case 'update': return Promise.resolve(this.db.doUpdate(this.table, this.payload as DbRow, this.predicates, this.selectCalled, this.cols, this.singleMode, this.maybeSingleMode));
      case 'delete': return Promise.resolve(this.db.doDelete(this.table, this.predicates));
      default: return Promise.resolve(this.db.doRead(this.table, this.predicates, this.orderBy, this.limitVal, this.rangeVal, this.cols, this.countMode, this.singleMode, this.maybeSingleMode));
    }
  }
}

// ── Supabase module proxy (stable reference for vi.mock) ──────────────

let activeDb: MemoryDb | null = null;

export function setActiveDb(db: MemoryDb): void { activeDb = db; }
export function getActiveDb(): MemoryDb {
  if (!activeDb) throw new Error('no active MemoryDb — call setActiveDb() in beforeEach');
  return activeDb;
}

/** Stable object handed to vi.mock('../lib/supabase.js'). Delegates per-call. */
export const supabaseProxy: Record<string, unknown> = {
  from: (table: string) => getActiveDb().from(table),
  rpc: (name: string, args: Record<string, unknown>) => getActiveDb().rpc(name, args),
  get storage() { return getActiveDb().storage; },
};

// ═══════════════════════════════════════════════════════════════════════
// 3. Emulated provider (LLM boundary) — REAL createClaudeRunner
// ═══════════════════════════════════════════════════════════════════════

export interface ScriptedChildSpec {
  stdout?: string;
  stderr?: string;
  /** Child exit code (0 = success). Default 0. */
  exitCode?: number;
  /** Emulate spawn/OS failure (e.g. ECONNRESET, ENOENT). */
  spawnError?: NodeJS.ErrnoException;
  /** Emulate a hung provider that never produces output (deadline fires). */
  hang?: boolean;
}
export type ScriptedChildFactory = ScriptedChildSpec | ((callIndex: number) => ScriptedChildSpec);

interface SpawnLike {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  stdin: NodeJS.WritableStream | null;
  readonly pid?: number;
  kill: (signal?: number | string) => boolean;
  on: (event: string, listener: (...args: any[]) => void) => void;
}

/** Build a fake child process that plays back a scripted spec. */
export function makeScriptedChild(spec: ScriptedChildSpec): SpawnLike {
  const listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const stdin = new Writable({ write(_c: unknown, _e: unknown, cb: () => void) { cb(); } });
  const child: SpawnLike & { on: (e: string, l: (...a: unknown[]) => void) => SpawnLike } = {
    stdout, stderr, stdin, pid: 9001,
    kill: () => true,
    on: (event: string, listener: (...a: unknown[]) => void) => {
      (listeners[event] ??= []).push(listener);
      return child;
    },
  };
  const emit = (event: string, ...args: unknown[]) => {
    for (const l of listeners[event] ?? []) l(...args);
  };
  setImmediate(() => {
    if (spec.spawnError) {
      // Close streams so the bounded collector settles; then fire the error.
      stdout.push(null); stderr.push(null);
      emit('error', spec.spawnError);
      return;
    }
    if (spec.stdout !== undefined) stdout.push(Buffer.from(spec.stdout, 'utf8'));
    if (spec.stderr !== undefined) stderr.push(Buffer.from(spec.stderr, 'utf8'));
    stdout.push(null);
    stderr.push(null);
    if (!spec.hang) {
      // Defer close until stream 'end' events have flushed.
      setImmediate(() => emit('close', spec.exitCode ?? 0));
    }
  });
  return child;
}

/**
 * spawnFn that plays back `script` in call order. Indexes beyond the script
 * tail default to a non-zero exit (deterministic failure — never a real
 * process). With a function entry, the function receives the call index.
 */
export function makeScriptedSpawn(script: ScriptedChildFactory[]): NonNullable<ClaudeRunnerDeps['spawnFn']> {
  let call = 0;
  return (_command: string, _args: readonly string[], _opts?: { shell?: boolean }) => {
    const raw = script[call];
    call += 1;
    const spec = typeof raw === 'function' ? raw(call - 1) : raw;
    return makeScriptedChild(spec ?? { exitCode: 2 });
  };
}

export interface ScriptedRunnerOptions {
  real: ClaudeModuleReal;
  script: ScriptedChildFactory[];
  failureThreshold?: number;
  cooldownMs?: number;
  clock?: Clock;
  timers?: TimerSet;
  breaker?: CircuitBreaker;
}

/** Real createClaudeRunner with a scripted spawn + real breaker semantics. */
export function createScriptedRunner(
  opts: ScriptedRunnerOptions,
): { runner: ClaudeRunner; breaker: CircuitBreaker } {
  const clock = opts.clock ?? MonotonicClock;
  const timers = opts.timers ?? DefaultTimerSet;
  const breaker = opts.breaker ?? new CircuitBreaker({
    failureThreshold: opts.failureThreshold ?? 5,
    cooldownMs: opts.cooldownMs ?? 30_000,
    clock,
    timers,
  });
  const runner = opts.real.createClaudeRunner({
    spawnFn: makeScriptedSpawn(opts.script),
    clock,
    timers,
    breaker,
  });
  return { runner, breaker };
}

/** Minimal bindings the harness needs from the real (unmocked) claude.js. */
export interface ClaudeModuleReal {
  createClaudeRunner: (deps?: Partial<ClaudeRunnerDeps>) => ClaudeRunner;
  ClaudeError: new (...args: any[]) => Error;
  isClaudeProviderFailure: (err: unknown) => boolean;
}

export interface ClaudeHarness {
  /** Exports handed to vi.mock('../lib/claude.js') — stable wrappers. */
  exports: Record<string, unknown>;
  /** Swap the active runner (per-test script/breaker config). */
  configure(runner: ClaudeRunner): void;
  getRunner(): ClaudeRunner;
  getReal(): ClaudeModuleReal;
}

let claudeHarness: ClaudeHarness | null = null;

/**
 * Build + register the claude.js mock exports. The vi.mock factory calls
 * this with the REAL module (via importOriginal) so the harness can drive
 * the real runner/breaker without ever spawning a real process.
 */
export function bindClaudeHarness(real: ClaudeModuleReal): ClaudeHarness {
  // Default runner is fail-closed: scripted non-zero exit, never a real spawn.
  const safeDefault = real.createClaudeRunner({
    spawnFn: makeScriptedSpawn([{ exitCode: 2 }]),
  });
  const state: { runner: ClaudeRunner } = { runner: safeDefault };
  const harness: ClaudeHarness = {
    exports: {
      runClaude: (...a: unknown[]) => state.runner.runClaude(a[0] as string, a[1] as never),
      runClaudeJSON: (...a: unknown[]) => state.runner.runClaudeJSON(a[0] as string, a[1] as never),
      runClaudeJSONWithProvenance: (...a: unknown[]) =>
        state.runner.runClaudeJSONWithProvenance(a[0] as string, a[1] as never),
      ClaudeError: real.ClaudeError,
      isClaudeProviderFailure: real.isClaudeProviderFailure,
      createClaudeRunner: real.createClaudeRunner,
    },
    configure: (r: ClaudeRunner) => { state.runner = r; },
    getRunner: () => state.runner,
    getReal: () => real,
  };
  claudeHarness = harness;
  return harness;
}

export function getClaudeHarness(): ClaudeHarness {
  if (!claudeHarness) {
    throw new Error('claude harness not bound — the vi.mock factory must call bindClaudeHarness()');
  }
  return claudeHarness;
}

// ═══════════════════════════════════════════════════════════════════════
// 4. Emulated LiveKit (join boundary)
// ═══════════════════════════════════════════════════════════════════════

let liveKitBehavior = { failRoomCreate: false };

/** Exports for vi.mock('livekit-server-sdk') — emulated room service. */
export function bindLiveKitHarness(): { exports: Record<string, unknown>; setBehavior(b: { failRoomCreate?: boolean }): void } {
  const exports: Record<string, unknown> = {
    RoomServiceClient: class FakeRoomServiceClient {
      constructor(..._args: unknown[]) {}
      async createRoom(_opts: unknown): Promise<void> {
        if (liveKitBehavior.failRoomCreate) throw new Error('room create failed (emulated)');
      }
      async updateRoomMetadata(_name: string, _meta: unknown): Promise<void> {}
      async deleteRoom(_name: string): Promise<void> {}
    },
    AccessToken: class FakeAccessToken {
      constructor(..._args: unknown[]) {}
      addGrant(_g: unknown): void {}
      toJwt(): string { return 'emulated-jwt'; }
    },
  };
  return { exports, setBehavior: (b) => { liveKitBehavior = { ...liveKitBehavior, ...b }; } };
}

// ═══════════════════════════════════════════════════════════════════════
// 5. Worker pipeline drivers (REAL L1 queue seams)
// ═══════════════════════════════════════════════════════════════════════

export interface DeliveryEvent {
  sessionId: string;
  turnIndex: number;
  speaker: 'bot' | 'candidate';
  text: string;
}
export const DELIVERY_QUEUE = 'transcript.delivery';

export function deliveryKey(e: DeliveryEvent): string {
  return `${e.sessionId}:${e.turnIndex}`;
}

export interface QueueHarness {
  adapter: IQueueAdapter;
  queue: Queue;
}

/** Fresh Queue + MemoryAdapter with a real (wall-clock) deterministic setup. */
export function createQueueHarness(options?: {
  defaultMaxAttempts?: number;
  backoffBaseMs?: number;
  clock?: () => string;
}): QueueHarness {
  const adapter = options?.clock
    ? new MemoryAdapter({ clock: options.clock })
    : new MemoryAdapter();
  const queue = new Queue(adapter, {
    defaultMaxAttempts: options?.defaultMaxAttempts ?? 3,
    backoffBaseMs: options?.backoffBaseMs ?? 1000,
    ...(options?.clock ? { clock: options.clock } : {}),
  });
  return { adapter, queue };
}

export function enqueueDelivery(
  qh: QueueHarness, e: DeliveryEvent,
  opts?: { dedupKey?: string; maxAttempts?: number },
): Promise<QueueJob<DeliveryEvent>> {
  return qh.queue.enqueue<DeliveryEvent>(DELIVERY_QUEUE, e, {
    dedupKey: opts?.dedupKey ?? deliveryKey(e),
    maxAttempts: opts?.maxAttempts,
  });
}

export interface WorkerPassOptions {
  /** Apply the payload (e.g. real upsertTranscriptEvent). */
  apply: (payload: DeliveryEvent) => Promise<void> | void;
  /** Batch indices killed after dequeue (job stays active, unprocessed). */
  killAfterDequeue?: number[];
  /** Batch indices applied but killed before complete (job stays active). */
  killAfterApply?: number[];
  batchSize?: number;
}

export interface WorkerPassResult {
  jobs: QueueJob<DeliveryEvent>[];
  processed: number;
  killed: number;
}

/**
 * One worker pass over the real queue: dequeueBatch (real claim), apply via
 * the caller's processing function, complete (real). Kills = simply not
 * completing, leaving the job 'active' in the real adapter.
 */
export async function runWorkerPass(qh: QueueHarness, opts: WorkerPassOptions): Promise<WorkerPassResult> {
  const jobs = await qh.queue.dequeueBatch<DeliveryEvent>(DELIVERY_QUEUE, opts.batchSize ?? 10);
  let processed = 0;
  let killed = 0;
  for (const [i, job] of jobs.entries()) {
    if (opts.killAfterDequeue?.includes(i)) { killed += 1; continue; }
    await opts.apply(job.payload);
    if (opts.killAfterApply?.includes(i)) { killed += 1; continue; }
    await qh.queue.complete(job);
    processed += 1;
  }
  return { jobs, processed, killed };
}

/**
 * Supervisor recovery for worker-kill: the L1 adapter has NO lease/expiry —
 * a killed worker leaves the job 'active' and nothing re-claims it. Recovery
 * goes through the real queue.fail() seam: retry (delayed → redeliver) or
 * DLQ when attempts are exhausted. `leaseMs` gates staleness; 0 = any active
 * job with a startedAt is stale.
 */
export async function superviseStaleActive(
  qh: QueueHarness, jobIds: string[], leaseMs = 0, reason = 'worker_kill',
): Promise<{ failed: number; recovered: string[] }> {
  const now = Date.now();
  const recovered: string[] = [];
  let failed = 0;
  for (const id of jobIds) {
    const job = await qh.queue.getById(id);
    if (!job || job.status !== 'active') continue;
    if (job.startedAt && now - Date.parse(job.startedAt) < leaseMs) continue;
    await qh.queue.fail(job, reason);
    failed += 1;
    recovered.push(id);
  }
  return { failed, recovered };
}

/** Replay every DLQ job back to pending (real replay seam). */
export async function drainDlq(qh: QueueHarness): Promise<QueueJob[]> {
  const dlq = await qh.queue.getDlqJobs();
  for (const job of dlq) await qh.queue.replay(job.id);
  return dlq;
}

/** Faulting wrapper around the real MemoryAdapter (queue-boundary chaos). */
export class FaultyQueueAdapter implements IQueueAdapter {
  fault = { enqueue: 0, dequeue: 0, complete: 0, fail: 0 };

  constructor(private inner: IQueueAdapter) {}

  private trip(kind: keyof FaultyQueueAdapter['fault']): void {
    if (this.fault[kind] > 0) {
      this.fault[kind] -= 1;
      throw new Error('simulated queue failure');
    }
  }

  enqueue(job: import('../../lib/queue/types.js').EnqueueInput): Promise<import('../../lib/queue/types.js').QueueJob> {
    this.trip('enqueue'); return this.inner.enqueue(job);
  }
  dequeue(queueName: string, batchSize?: number): Promise<import('../../lib/queue/types.js').QueueJob[]> {
    this.trip('dequeue'); return this.inner.dequeue(queueName, batchSize);
  }
  complete(jobId: string): Promise<void> {
    this.trip('complete'); return this.inner.complete(jobId);
  }
  fail(jobId: string, errorMessage: string): Promise<void> {
    this.trip('fail'); return this.inner.fail(jobId, errorMessage);
  }
  scheduleRetry(jobId: string, scheduledAt: string): Promise<void> {
    return this.inner.scheduleRetry(jobId, scheduledAt);
  }
  moveToDlq(jobId: string, errorMessage: string): Promise<import('../../lib/queue/types.js').QueueJob> {
    return this.inner.moveToDlq(jobId, errorMessage);
  }
  replay(jobId: string): Promise<import('../../lib/queue/types.js').QueueJob> {
    return this.inner.replay(jobId);
  }
  getById(jobId: string): Promise<import('../../lib/queue/types.js').QueueJob | null> {
    return this.inner.getById(jobId);
  }
  getDlqJobs(): Promise<import('../../lib/queue/types.js').QueueJob[]> {
    return this.inner.getDlqJobs();
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 6. Outbox delivery consumer (REAL REL-02/03 seams)
// ═══════════════════════════════════════════════════════════════════════

export interface OutboxDrainOptions {
  /** aggregate_ids whose first delivery attempt fails (network). */
  failAggregateIds?: Set<string>;
  /** Number of failure attempts per matching row. */
  failTimesPerRow?: number;
}

export interface OutboxDrainResult {
  published: number;
  failed: number;
  pendingAfter: number;
}

/**
 * Delivery loop over the REAL outbox: pollOutbox() + markOutboxEntry().
 * Failures are recorded with the real 'failed' status + last_error, then
 * retried by the supervisor until published or left visible as failed.
 */
export async function drainOutbox(opts: OutboxDrainOptions = {}): Promise<OutboxDrainResult> {
  const { pollOutbox, markOutboxEntry, countPendingOutbox } = await import('../../lib/outbox.js');
  let published = 0;
  let failed = 0;
  const failBudget = new Map<string, number>();
  const perRow = opts.failTimesPerRow ?? 1;
  for (;;) {
    const { data, error } = await pollOutbox(50);
    if (error || data.length === 0) break;
    for (const row of data) {
      const budget = failBudget.get(row.aggregate_id) ?? perRow;
      if (opts.failAggregateIds?.has(row.aggregate_id) && budget > 0) {
        failBudget.set(row.aggregate_id, budget - 1);
        await markOutboxEntry(row.id, 'failed', 'network_unreachable');
        failed += 1;
        continue;
      }
      await markOutboxEntry(row.id, 'published');
      published += 1;
    }
  }
  const { data: pending } = await countPendingOutbox();
  return { published, failed, pendingAfter: pending ?? 0 };
}

// ═══════════════════════════════════════════════════════════════════════
// 7. Reconciliation driver (REAL REL-09 seams)
// ═══════════════════════════════════════════════════════════════════════

export interface ReconcileOutcome {
  issue: ReconciliationIssue;
  plan: RepairPlan;
  result: RepairResult;
}
export interface ReconcileRunResult {
  report: ReconciliationReport;
  repairs: ReconcileOutcome[];
}

/**
 * Full real reconcile() → planRepair() → executeRepair() cycle. executeRepair
 * uses its default dynamic-import path → REAL transitionSession (CAS).
 */
export async function runReconciliation(
  runId: string,
  timeouts?: Partial<{ waitingTimeoutMs: number; createdTimeoutMs: number; progressTimeoutMs: number }>,
): Promise<ReconcileRunResult> {
  const { reconcile, planRepair, executeRepair } = await import('../../lib/reconciliation.js');
  const report = await reconcile(runId, timeouts);
  const repairs: ReconcileOutcome[] = [];
  for (const issue of report.issues) {
    const plan = planRepair(issue);
    const result = await executeRepair(plan);
    repairs.push({ issue, plan, result });
  }
  return { report, repairs };
}

// ═══════════════════════════════════════════════════════════════════════
// 8. Seed helpers (seeding the emulated DB — the boundary, not product code)
// ═══════════════════════════════════════════════════════════════════════

export async function seedCandidate(
  db: MemoryDb, overrides: DbRow = {},
): Promise<DbRow> {
  const row = await db.from('candidates').insert({
    id: overrides.id ?? makeUuid(),
    name: overrides.name ?? 'Alice Example',
    email: overrides.email ?? 'alice@example.com',
    role_id: overrides.role_id ?? null,
    skills: overrides.skills ?? ['TypeScript', 'React'],
    parsed: overrides.parsed ?? { summary: '5 years frontend' },
    status: overrides.status ?? 'new',
    owner_id: overrides.owner_id ?? null,
  }).select().single();
  return (row as SupabaseResult).data as DbRow;
}

export async function seedRole(db: MemoryDb, overrides: DbRow = {}): Promise<DbRow> {
  const row = await db.from('roles').insert({
    id: overrides.id ?? makeUuid(),
    title: overrides.title ?? 'Frontend Engineer',
    jd: overrides.jd ?? 'Build web apps',
    required_skills: overrides.required_skills ?? ['TypeScript'],
    screening_template: overrides.screening_template ?? [],
    is_active: true,
  }).select().single();
  return (row as SupabaseResult).data as DbRow;
}

export interface SeedSessionFields {
  id?: string;
  candidateId: string;
  roleId?: string | null;
  status?: string;
  externalCallId?: string | null;
  waitingAt?: string | null;
  startedAt?: string;
  endedAt?: string | null;
  recordingObjectKey?: string | null;
  mode?: string;
  provider?: string | null;
}

/** Seed a call_sessions row directly (emulated DB boundary). */
export async function seedSession(db: MemoryDb, f: SeedSessionFields): Promise<DbRow> {
  const row = await db.from('call_sessions').insert({
    id: f.id ?? makeUuid(),
    candidate_id: f.candidateId,
    role_id: f.roleId ?? null,
    mode: f.mode ?? 'browser',
    provider: f.provider ?? 'livekit',
    status: f.status ?? 'created',
    terminal_reason: null,
    started_at: f.startedAt ?? db.nowIso(),
    ended_at: f.endedAt ?? null,
    waiting_at: f.waitingAt ?? null,
    external_call_id: f.externalCallId ?? null,
    recording_object_key: f.recordingObjectKey ?? null,
  }).select().single();
  return (row as SupabaseResult).data as DbRow;
}

/** Insert a transcript_turns row directly (worker/API write path emulation). */
export async function seedTranscriptTurn(
  db: MemoryDb, sessionId: string, turnIndex: number, speaker: string, text: string,
): Promise<void> {
  await db.from('transcript_turns').insert({
    session_id: sessionId, turn_index: turnIndex, speaker, text,
  });
}
