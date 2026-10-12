/**
 * An in-memory Supabase/PostgREST double for the R1 recording suites.
 *
 * Beyond the usual filters it models what the recording code relies on from the real database:
 *  - a unique primary key on `interview_round_recordings.session_id` (a second insert answers
 *    `{ code: '23505' }` and changes nothing);
 *  - the column defaults of the 0127 table and its CHECK windows (a display-only value outside its
 *    window is rejected with `{ code: '23514' }`, exactly what an un-sanitised report would hit);
 *  - the 0127 `enqueue_r1_recording_finalize` trigger: a status change to `finishing` inserts ONE
 *    `r1.recording.finalize` job (dedup against live jobs, like `uq_job_queue_dedup_active`);
 *  - the 0127 `purge_on_r1_recording_delete` trigger: deleting a recording row that is not a tombstone
 *    (`deleted_at` null) leaves an `r1_recording_purge` outbox row;
 *  - `select(cols, { count: 'exact', head: true })` answers `{ count }` like PostgREST;
 *  - `.update(...).select()` answers exactly the rows it changed, so compare-and-set code can count.
 * `hooks.beforeWrite` lets a test change the world between a read and the write that follows it, to
 * prove a compare-and-set loses cleanly. `failOn` makes the next matching operation answer an error.
 *
 * It is deliberately small; the SQL itself is proven by app/supabase/tests/r1_recordings_assert.sql.
 */

export type Row = Record<string, any>;
export type Tables = Record<string, Row[]>;

export interface FakeRecordingDb {
  tables: Tables;
  /** Every `{ table, op }` the code under test issued, in order. */
  ops: Array<{ table: string; op: 'select' | 'insert' | 'update' | 'delete' }>;
  client: {
    from: (table: string) => any;
    rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
  };
  hooks: {
    beforeWrite?: (table: string, op: 'insert' | 'update' | 'delete', patch: Row | undefined, matching: Row[]) => void;
  };
  /** The next `times` operations on `table` of kind `op` answer a database error, after letting `skip` pass. */
  failOn(table: string, op: 'select' | 'insert' | 'update' | 'delete', times?: number, skip?: number): void;
}

const RECORDING_DEFAULTS: Row = {
  layout: null,
  has_video: null,
  upload_id: null,
  parts_issued: 0,
  urls_issued: 0,
  video_key: null,
  video_bytes: null,
  video_sha256: null,
  video_etag: null,
  video_content_type: null,
  audio_key: null,
  audio_bytes: null,
  audio_sha256: null,
  audio_etag: null,
  started_at_ms: null,
  duration_ms: null,
  width: null,
  height: null,
  fps: null,
  frames_encoded: null,
  frames_dropped: null,
  camera_off_ms: null,
  degraded_at_ms: null,
  reported_stream_bytes: null,
  reported_parts: null,
  degraded_reason: null,
  failure_reason: null,
  finalize_attempts: 0,
  finalize_requested_at: null,
  finalized_at: null,
  delete_requested_at: null,
  delete_reason: null,
  deleted_at: null,
};

const within = (v: unknown, min: number, max: number): boolean => v === null || v === undefined || (typeof v === 'number' && v >= min && v <= max);

/** The CHECK constraints of `interview_round_recordings` (0127) that a display-only report can hit. */
function recordingViolation(row: Row): boolean {
  return !(
    within(row.parts_issued, 0, 60)
    && within(row.urls_issued, 0, 400)
    && within(row.started_at_ms, 1_577_836_800_000, 4_102_444_800_000)
    && within(row.duration_ms, 1, 86_400_000)
    && within(row.width, 16, 4096)
    && within(row.height, 16, 4096)
    && within(row.fps, 1, 60)
    && within(row.frames_encoded, 0, 10_000_000)
    && within(row.frames_dropped, 0, 10_000_000)
    && within(row.camera_off_ms, 0, Number.MAX_SAFE_INTEGER)
    && within(row.degraded_at_ms, 0, 86_400_000)
    && within(row.reported_stream_bytes, 0, 1_099_511_627_776)
    && within(row.reported_parts, 0, 60)
    && ((row.status === 'deleted') === (row.deleted_at !== null && row.deleted_at !== undefined))
  );
}

const asTime = (v: unknown): number => (typeof v === 'string' ? Date.parse(v) : Number.NaN);

function compare(left: unknown, right: unknown): number {
  if (left === null || left === undefined) return Number.NaN;
  const a = asTime(left);
  const b = asTime(right);
  if (Number.isFinite(a) && Number.isFinite(b)) return a - b;
  return (left as any) > (right as any) ? 1 : (left as any) < (right as any) ? -1 : 0;
}

export function createRecordingFakeDb(initial: Tables = {}, options: { now?: () => number } = {}): FakeRecordingDb {
  const clockMs = options.now ?? Date.now;
  const tables: Tables = initial;
  const ops: FakeRecordingDb['ops'] = [];
  const hooks: FakeRecordingDb['hooks'] = {};
  const failures: Array<{ table: string; op: string; times: number; skip: number }> = [];
  let idCounter = 0;

  function takeFailure(table: string, op: string): boolean {
    const f = failures.find((x) => x.table === table && x.op === op && x.times > 0);
    if (!f) return false;
    if (f.skip > 0) {
      f.skip -= 1;
      return false;
    }
    f.times -= 1;
    return true;
  }

  function afterRecordingUpdate(before: Row, after: Row): void {
    if (after.status === 'finishing' && before.status !== 'finishing') {
      const jobs = (tables.job_queue ??= []);
      const dedup = `r1.recording.finalize:${after.session_id}`;
      const live = jobs.some((j) => j.dedup_key === dedup && ['pending', 'active', 'delayed'].includes(j.status ?? 'pending'));
      if (!live) {
        jobs.push({
          id: `job-${++idCounter}`,
          name: 'r1.recording.finalize',
          payload: { session_id: after.session_id },
          dedup_key: dedup,
          max_attempts: 5,
          status: 'pending',
        });
      }
    }
  }

  function query(table: string) {
    let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
    let payload: any;
    const filters: Array<(row: Row) => boolean> = [];
    const orderBy: Array<[string, boolean]> = [];
    let limit: number | null = null;
    let wantCount = false;
    let headOnly = false;

    const matching = (): Row[] => {
      let out = (tables[table] ?? []).filter((row) => filters.every((f) => f(row)));
      if (orderBy.length > 0) {
        out = [...out].sort((a, b) => {
          for (const [key, asc] of orderBy) {
            const c = compare(a[key], b[key]) || 0;
            if (c !== 0) return c * (asc ? 1 : -1);
          }
          return 0;
        });
      }
      return limit === null ? out : out.slice(0, limit);
    };

    const run = (): { data: any; error: any; count?: number } => {
      ops.push({ table, op });
      if (takeFailure(table, op)) return { data: null, error: { code: 'XX000', message: 'injected' } };
      if (op === 'select' && wantCount) {
        const saved = limit;
        limit = null;
        const total = matching().length;
        limit = saved;
        return { data: headOnly ? null : matching().map((r) => ({ ...r })), count: total, error: null };
      }
      if (op === 'select') return { data: matching().map((r) => ({ ...r })), error: null };
      if (op === 'insert') {
        const list = (Array.isArray(payload) ? payload : [payload]) as Row[];
        const inserted: Row[] = [];
        for (const item of list) {
          hooks.beforeWrite?.(table, 'insert', item, []);
          let row: Row = { ...item };
          if (table === 'interview_round_recordings') {
            if ((tables[table] ?? []).some((r) => r.session_id === row.session_id)) {
              return { data: null, error: { code: '23505', message: 'duplicate key' } };
            }
            row = { ...RECORDING_DEFAULTS, ...row };
            if (recordingViolation(row)) return { data: null, error: { code: '23514', message: 'check violation' } };
          }
          // Columns the database stamps itself (`default now()`).
          if (table === 'governance_audit' && row.created_at === undefined) row.created_at = new Date(clockMs()).toISOString();
          (tables[table] ??= []).push(row);
          inserted.push({ ...row });
        }
        return { data: inserted, error: null };
      }
      if (op === 'update') {
        const rows = matching();
        hooks.beforeWrite?.(table, 'update', payload, rows);
        // The hook may have changed the world: re-evaluate the filters.
        const live = rows.filter((row) => filters.every((f) => f(row)));
        const updated: Row[] = [];
        for (const row of live) {
          const before = { ...row };
          const next = { ...row, ...payload };
          if (table === 'interview_round_recordings' && recordingViolation(next)) {
            return { data: null, error: { code: '23514', message: 'check violation' } };
          }
          Object.assign(row, payload);
          if (table === 'interview_round_recordings') afterRecordingUpdate(before, row);
          updated.push({ ...row });
        }
        return { data: updated, error: null };
      }
      const rows = matching();
      hooks.beforeWrite?.(table, 'delete', undefined, rows);
      if (table === 'interview_round_recordings') {
        // 0127 purge_on_r1_recording_delete: BEFORE DELETE ... WHEN (old.deleted_at is null).
        for (const row of rows) {
          if (row.deleted_at === null || row.deleted_at === undefined) {
            (tables.r1_recording_purge ??= []).push({
              id: `purge-${++idCounter}`,
              bucket: row.bucket,
              prefix: row.prefix,
              upload_id: row.upload_id ?? null,
              reason: 'row_deleted',
              queued_at: new Date().toISOString(),
              attempts: 0,
              last_error_code: null,
              done_at: null,
            });
          }
        }
      }
      tables[table] = (tables[table] ?? []).filter((row) => !rows.includes(row));
      return { data: rows.map((r) => ({ ...r })), error: null };
    };

    const q: any = {
      select: (_columns?: string, options?: { count?: string; head?: boolean }) => {
        if (options?.count) {
          wantCount = true;
          headOnly = options.head === true;
        }
        return q;
      },
      eq: (key: string, value: unknown) => { filters.push((row) => (row[key] ?? null) === (value ?? null) && (value !== undefined)); return q; },
      neq: (key: string, value: unknown) => { filters.push((row) => row[key] !== value); return q; },
      is: (key: string, value: unknown) => { filters.push((row) => (row[key] ?? null) === value); return q; },
      in: (key: string, values: unknown[]) => { filters.push((row) => values.includes(row[key])); return q; },
      lt: (key: string, value: unknown) => { filters.push((row) => compare(row[key], value) < 0); return q; },
      lte: (key: string, value: unknown) => { filters.push((row) => compare(row[key], value) <= 0); return q; },
      gt: (key: string, value: unknown) => { filters.push((row) => compare(row[key], value) > 0); return q; },
      gte: (key: string, value: unknown) => { filters.push((row) => compare(row[key], value) >= 0); return q; },
      not: (key: string, operator: string, value: unknown) => {
        if (operator === 'is' && value === null) filters.push((row) => row[key] !== null && row[key] !== undefined);
        return q;
      },
      order: (key: string, options?: { ascending?: boolean }) => { orderBy.push([key, options?.ascending !== false]); return q; },
      limit: (n: number) => { limit = n; return q; },
      insert: (value: Row | Row[]) => { op = 'insert'; payload = value; return q; },
      update: (value: Row) => { op = 'update'; payload = value; return q; },
      delete: () => { op = 'delete'; return q; },
      maybeSingle: async () => {
        const r = run();
        return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error };
      },
      single: async () => {
        const r = run();
        if (!r.error && Array.isArray(r.data) && r.data.length === 0) return { data: null, error: { code: 'PGRST116', message: 'no rows' } };
        return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error };
      },
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject),
    };
    return q;
  }

  return {
    tables,
    ops,
    hooks,
    failOn(table, op, times = 1, skip = 0) {
      failures.push({ table, op, times, skip });
    },
    client: {
      from: (table: string) => query(table),
      rpc: async () => ({ data: null, error: null }),
    },
  };
}

// ---------------------------------------------------------------- shared fixtures

export const ROOM_SESSION = '30000000-0000-4000-8000-000000000001';
export const ROOM_ROUND = '20000000-0000-4000-8000-000000000001';
export const ROOM_CANDIDATE = '10000000-0000-4000-8000-000000000001';
export const ROOM_NAME = `screening-${ROOM_SESSION}`;

/** Tables for one live R1 browser session whose round holds a live recording consent. */
export function liveRecordingTables(options: { recordingMode?: string; consents?: string[] | null } = {}): Tables {
  return {
    call_sessions: [{
      id: ROOM_SESSION,
      candidate_id: ROOM_CANDIDATE,
      interview_round_id: ROOM_ROUND,
      status: 'in_progress',
      external_call_id: ROOM_NAME,
      mode: 'browser',
    }],
    r1_settings: [{ singleton: true, enabled: true, recording_mode: options.recordingMode ?? 'av' }],
    interview_round_consents: options.consents === null
      ? []
      : [{ id: 'consent-1', round_id: ROOM_ROUND, consents: options.consents ?? ['ai_interview', 'video_audio_recording', 'ai_evaluation', 'data_processing'], withdrawn_at: null, proof: null }],
    interview_round_recordings: [],
    job_queue: [],
  };
}

// ---------------------------------------------------------------- recording row fixtures

/** 2026-10-12T10:00:00Z, the clock every recording suite starts at. */
export const FIXTURE_NOW_MS = Date.parse('2026-10-12T10:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

/** `n`-th fixture id: `a` = round, `b` = session, `c` = candidate. */
export const fixtureId = (kind: 'a' | 'b' | 'c', n: number): string =>
  `${kind === 'a' ? '20000000' : kind === 'b' ? '30000000' : '10000000'}-0000-4000-8000-${String(n).padStart(12, '0')}`;

/**
 * A complete `interview_round_recordings` row (every 0127 column). Defaults describe a recording that
 * was created 10 minutes before {@link FIXTURE_NOW_MS}, is `ready`, and holds one `stream.mp4`.
 * `n` picks the session/round pair (n = 1 is {@link ROOM_SESSION} / {@link ROOM_ROUND}).
 */
export function recordingRow(n = 1, overrides: Row = {}): Row {
  const round = fixtureId('a', n);
  const session = fixtureId('b', n);
  const prefix = `r1/${round}/${session}/`;
  const created = FIXTURE_NOW_MS - 10 * 60_000;
  return {
    session_id: session,
    round_id: round,
    bucket: 'ik-r1-recordings',
    prefix,
    requested_mode: 'av',
    status: 'ready',
    layout: 'combined',
    has_video: true,
    upload_id: null,
    parts_issued: 2,
    urls_issued: 3,
    video_key: `${prefix}stream.mp4`,
    video_bytes: 4096,
    video_sha256: 'a'.repeat(64),
    video_etag: '"etag-video"',
    video_content_type: 'video/mp4',
    audio_key: null,
    audio_bytes: null,
    audio_sha256: null,
    audio_etag: null,
    started_at_ms: created,
    duration_ms: 540_000,
    width: 640,
    height: 360,
    fps: 15,
    frames_encoded: 8000,
    frames_dropped: 10,
    camera_off_ms: 0,
    degraded_at_ms: null,
    reported_stream_bytes: 4096,
    reported_parts: 2,
    degraded_reason: null,
    failure_reason: null,
    finalize_attempts: 1,
    created_at: iso(created),
    updated_at: iso(created + 9 * 60_000),
    finalize_requested_at: iso(created + 9 * 60_000),
    finalized_at: iso(created + 9 * 60_000 + 5000),
    delete_after: iso(created + 90 * 86_400_000),
    delete_requested_at: null,
    delete_reason: null,
    deleted_at: null,
    ...overrides,
  };
}

/** The round (+ attempt) rows the staff routes, erase and DSAR read for fixture `n`. */
export function roundTables(n = 1, options: { candidate?: number; owner?: string | null } = {}): Tables {
  return {
    interview_rounds: [{ id: fixtureId('a', n), candidate_id: fixtureId('c', options.candidate ?? 1) }],
    interview_round_attempts: [{ session_id: fixtureId('b', n), round_id: fixtureId('a', n), attempt_number: 1, counted: true, outcome: 'complete' }],
    candidates: [{ id: fixtureId('c', options.candidate ?? 1), owner_id: options.owner ?? null }],
  };
}
