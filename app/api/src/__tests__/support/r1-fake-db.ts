/**
 * A deliberately small in-memory Supabase double for the R1 scorer suites. It implements the
 * query methods the scorer services use, a `(session_id, revision)` unique index on v2
 * assessments (answering 23505 like Postgres), and delegates `rpc` to a recording function.
 */
import { vi } from 'vitest';
import { r1Scorecard } from './r1-scorer.js';

export type Row = Record<string, any>;
export type Tables = Record<string, Row[]>;

export interface RpcCall { fn: string; args: Record<string, any> }

export interface FakeDb {
  tables: Tables;
  rpcCalls: RpcCall[];
  /** Table names passed to `.from()`, in order. */
  fromCalls: string[];
  client: {
    from: (table: string) => any;
    rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
  };
}

let idCounter = 0;

function query(table: string, tables: Tables, onInsert: () => void) {
  let op: 'select' | 'insert' | 'update' = 'select';
  let payload: any;
  const filters: Array<(row: Row) => boolean> = [];
  let orderBy: [string, boolean] | null = null;
  let limit: number | null = null;

  const rows = (): Row[] => {
    let out = (tables[table] ?? []).filter((row) => filters.every((f) => f(row)));
    if (orderBy) {
      const [key, asc] = orderBy;
      out = [...out].sort((a, b) => (a[key] > b[key] ? 1 : a[key] < b[key] ? -1 : 0) * (asc ? 1 : -1));
    }
    return limit === null ? out : out.slice(0, limit);
  };

  const run = (): { data: any; error: any } => {
    if (op === 'select') return { data: rows(), error: null };
    if (op === 'insert') {
      const list = (Array.isArray(payload) ? payload : [payload]) as Row[];
      const inserted: Row[] = [];
      for (const item of list) {
        if (table === 'assessments' && item.schema_version === 2) {
          const clash = (tables.assessments ?? []).some(
            (existing) => existing.schema_version === 2
              && existing.session_id === item.session_id
              && existing.revision === item.revision,
          );
          if (clash) return { data: null, error: { code: '23505', message: 'duplicate key' } };
        }
        const row = { ...item, id: item.id ?? `${table}-${++idCounter}`, created_at: new Date().toISOString() };
        (tables[table] ??= []).push(row);
        inserted.push(row);
        onInsert();
      }
      return { data: inserted, error: null };
    }
    const updated = rows();
    for (const row of updated) Object.assign(row, payload);
    return { data: updated, error: null };
  };

  const q: any = {
    select: () => q,
    eq: (key: string, value: unknown) => { filters.push((row) => row[key] === value); return q; },
    in: (key: string, values: unknown[]) => { filters.push((row) => values.includes(row[key])); return q; },
    lte: (key: string, value: unknown) => {
      filters.push((row) => {
        const left = row[key];
        if (left === null || left === undefined) return false; // SQL: NULL <= x is not true
        const a = Date.parse(String(left));
        const b = Date.parse(String(value));
        return Number.isFinite(a) && Number.isFinite(b) ? a <= b : String(left) <= String(value);
      });
      return q;
    },
    is: (key: string, value: unknown) => { filters.push((row) => (row[key] ?? null) === value); return q; },
    not: (key: string, operator: string, value: unknown) => {
      if (operator === 'is' && value === null) filters.push((row) => row[key] !== null && row[key] !== undefined);
      return q;
    },
    order: (key: string, options?: { ascending?: boolean }) => { orderBy = [key, options?.ascending !== false]; return q; },
    limit: (n: number) => { limit = n; return q; },
    insert: (value: Row | Row[]) => { op = 'insert'; payload = value; return q; },
    update: (value: Row) => { op = 'update'; payload = value; return q; },
    maybeSingle: async () => {
      const result = run();
      return { data: Array.isArray(result.data) ? (result.data[0] ?? null) : result.data, error: result.error };
    },
    single: async () => {
      const result = run();
      return { data: Array.isArray(result.data) ? (result.data[0] ?? null) : result.data, error: result.error };
    },
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(run()).then(resolve, reject),
  };
  return q;
}

export function createFakeDb(
  tables: Tables,
  rpc?: (fn: string, args: Record<string, any>) => { data?: unknown; error?: unknown } | Promise<{ data?: unknown; error?: unknown }>,
): FakeDb {
  const rpcCalls: RpcCall[] = [];
  const fromCalls: string[] = [];
  return {
    tables,
    rpcCalls,
    fromCalls,
    client: {
      from: (table: string) => {
        fromCalls.push(table);
        return query(table, tables, () => undefined);
      },
      rpc: async (fn: string, args: Record<string, unknown> = {}) => {
        rpcCalls.push({ fn, args: args as Record<string, any> });
        const result = rpc ? await rpc(fn, args as Record<string, any>) : { data: { status: 'ok' } };
        return { data: result.data ?? null, error: result.error ?? null };
      },
    },
  };
}

export const SESSION_ID = '40000000-0000-4000-8000-000000000001';
export const ROUND_ID = '50000000-0000-4000-8000-000000000001';
export const CANDIDATE_ID = '60000000-0000-4000-8000-000000000001';
export const ROLE_ID = '30000000-0000-4000-8000-000000000001';

/** Tables for one completed R1 session with a seeded scorecard, settings and attempt. */
export function baseTables(): Tables {
  const scorecard = r1Scorecard();
  return {
    call_sessions: [{
      id: SESSION_ID,
      candidate_id: CANDIDATE_ID,
      role_id: ROLE_ID,
      status: 'completed',
      terminal_reason: 'conversation_complete',
      interview_round_id: ROUND_ID,
      mode: 'browser',
    }],
    candidates: [{ id: CANDIDATE_ID, name: "Ava O'Neil" }],
    roles: [{ id: ROLE_ID, title: 'Sales Program Advisor', active_scorecard_version_id: scorecard.id }],
    role_scorecard_versions: [{
      id: scorecard.id, role_id: ROLE_ID, version: 1, configuration_hash: scorecard.configurationHash,
    }],
    role_scorecard_version_metrics: scorecard.metrics.map((metric) => ({
      id: metric.id,
      scorecard_version_id: scorecard.id,
      library_metric_id: metric.libraryMetricId,
      metric_key: metric.key,
      name: metric.name,
      instruction: metric.instruction,
      rubric: { '1': metric.rubric[1], '2': metric.rubric[2], '3': metric.rubric[3], '4': metric.rubric[4] },
      weight_bps: metric.weightBps,
      display_order: metric.displayOrder,
    })),
    r1_settings: [{
      singleton: true, enabled: true, advance_threshold: '65.00', hold_threshold: '45.00',
      auto_status_enabled: false, updated_at: '2026-10-06T09:00:00+00:00',
    }],
    interview_round_attempts: [{ session_id: SESSION_ID, round_id: ROUND_ID, attempt_number: 1, outcome: 'complete' }],
    transcript_turns: [],
    r1_admin_log: [],
    assessments: [],
  };
}

/** Standard happy RPCs: attach ok, apply ok with a flag-off outcome. */
export function happyRpc() {
  return vi.fn((fn: string) => {
    if (fn === 'r1_attach_assessment') return { data: { status: 'ok', attached: true } };
    if (fn === 'r1_apply_status_effect') return { data: { status: 'ok', status_write: 'flag_off' } };
    return { data: { status: 'ok' } };
  });
}
