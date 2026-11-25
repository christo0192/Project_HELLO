/**
 * An in-memory port of migration 0142 for the `r1-meet` runtime suites (M034 S06 T2).
 *
 * What it is: a Supabase/PostgREST double (`client`, also wrapped as the real `createR1MeetStore`)
 * over seven tables (`r1_meet_bookings`, `r1_meet_receipts`, `interview_rounds`, `call_sessions`,
 * `interview_round_attempts`, `ashby_application_links`, `job_queue`) plus the consent rows the create
 * RPC writes, and a port of
 * every 0142 RPC the Meet runtime and the bridge page call. Each RPC keeps the SQL's refusal ORDER
 * (the first refusal wins), answers the same jsonb keys, and runs as one transaction: a CHECK it would
 * break (`chk_r1_meet_bookings_status_reason`, the round and bot bindings, the ticket pairing, the
 * counters, the slot) rolls everything back and answers `{ data: null, error: { code: '23514' } }`,
 * a unique index `23505`, and the create RPC's own `raise` `P0001`.
 *
 * What it is NOT: the SQL. `r1_send_round` (capacity, holds, the month counter) is a knob
 * (`settings.sendRound`), and so are the consent template and the sales_r1 role. The SQL itself is
 * proven by app/supabase/tests; `r1-meet-fake-db.test.ts` pins this port's matrix, pairing and answer
 * sets to the migration text, so a drift of either fails there.
 *
 * Test aids: `failNext(rpcOrTable, mode)` (`error`: the next call answers a DB error and writes
 * nothing; `lost`: an RPC commits, then the answer is lost), `calls` (every rpc and table call),
 * an optional shared `timeline` (`db:<rpc>`, `db:set_bot:<action>`, `db:transition:<to>`,
 * `queue:<kind>`), seeding helpers, the two 0142 triggers (`deleteBooking`, `cancelRound`), and the
 * bridge page's half (`claimTicket`, `bind`).
 *
 * Never shipped: `tsconfig.build.json` excludes `src/__tests__`. Ids are generated in the namespace
 * `7f000000-0000-4000-9000-…`, apart from the fixtures' `7f000000-0000-4000-8000-…`.
 */

import type { supabase } from '../../lib/supabase.js';
import { createR1MeetStore, type R1MeetStore } from '../../lib/r1/meet/runtime-store.js';
import { r1MeetTicketDigest } from '../../lib/r1/meet/ticket.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;

export interface FakeAnswer {
  data: unknown;
  error: { code: string; message: string } | null;
  count?: number | null;
}

// ── The 0142 vocabulary this port enforces (pinned to the migration by r1-meet-fake-db.test.ts) ──

/** `chk_r1_meet_bookings_status_reason`: the reasons each status accepts. */
export const FAKE_STATUS_REASONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  pending: ['eligible'],
  bot_scheduled: ['eligible'],
  bot_joining: ['eligible'],
  human_present: ['eligible'],
  in_call: ['eligible'],
  unmatched_application: ['application_unknown', 'application_terminal'],
  unmapped_scheduler: ['scheduler_unmapped', 'created_by_unknown'],
  blocked: [
    'not_scheduled', 'no_attester', 'no_meet_link', 'disabled', 'paused', 'candidate_ineligible',
    'role_not_configured', 'round_active', 'phone_engagement_active', 'phone_assessment_pending',
    'capacity_exhausted', 'consent_template_unavailable', 'slot_too_far', 'bot_cap_reached',
  ],
  completed: ['attempt_settled'],
  cancelled: ['cancelled', 'dex_absent', 'event_removed', 'round_cancelled'],
  failed: ['in_past', 'bot_create_failed', 'bot_fatal', 'no_show', 'admission_refused', 'multiple_humans', 'round_expired'],
  drained: ['flag_off'],
});

/** `r1_meet_transition_booking`'s matrix, as `[from statuses, to statuses]` rows. */
export const FAKE_TRANSITIONS: ReadonlyArray<readonly [readonly string[], readonly string[]]> = Object.freeze([
  [['bot_scheduled'], ['bot_joining']],
  [['bot_scheduled', 'bot_joining'], ['human_present']],
  [['in_call'], ['completed']],
  [['pending', 'blocked'], ['blocked']],
  [
    ['pending', 'blocked', 'unmatched_application', 'unmapped_scheduler', 'bot_scheduled', 'bot_joining', 'human_present', 'in_call'],
    ['failed', 'drained'],
  ],
]);

/** What `r1_send_round` may answer here besides `ok` and `round_active` (which the port derives). */
export const FAKE_SEND_ROUND_REFUSALS = Object.freeze([
  'disabled',
  'paused',
  'candidate_ineligible',
  'role_not_configured',
  'phone_engagement_active',
  'phone_assessment_pending',
  'capacity_exhausted',
] as const);
export type FakeSendRoundAnswer = 'ok' | (typeof FAKE_SEND_ROUND_REFUSALS)[number] | 'unexpected';

const TERMINAL = ['completed', 'cancelled', 'failed', 'drained'];
const DISPATCHED = ['bot_joining', 'human_present', 'in_call'];
const HOLDS_BOT = ['bot_scheduled', ...DISPATCHED];
const ROUND_BOUND = ['pending', 'bot_scheduled', 'bot_joining', 'human_present', 'in_call', 'completed'];
const BOTLESS = ['pending', 'blocked', 'unmatched_application', 'unmapped_scheduler'];
const LIVE_SESSION = ['created', 'waiting', 'in_progress'];
const LIVE_JOB = ['pending', 'active', 'delayed'];
const UUID_I = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MEET = /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const DEDUPE_KEY = /^[A-Za-z0-9_.:-]+$/;
const EVENT_TYPE = /^[A-Za-z0-9_.:-]{1,128}$/;
const KIND = /^[a-z][a-z0-9_]{0,39}$/;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

// ── Small helpers ───────────────────────────────────────────────────────────

class SqlError extends Error {
  constructor(readonly code: string, readonly detail: string) {
    super(detail);
  }
}

const check = (ok: boolean, constraint: string): void => {
  if (!ok) throw new SqlError('23514', constraint);
};

/** A timestamptz as the fake stores it (always `toISOString()`), or null. */
export function ts(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const ms = typeof value === 'number' ? value : Date.parse(String(value));
  if (!Number.isFinite(ms)) throw new SqlError('22007', 'invalid_timestamp');
  return new Date(ms).toISOString();
}

const ms = (value: unknown): number => Date.parse(String(value));
const iso = (value: number): string => new Date(value).toISOString();

function uuidArg(value: unknown, nullable = true): string | null {
  if (value === null || value === undefined) {
    if (nullable) return null;
    throw new SqlError('22P02', 'invalid_uuid');
  }
  if (typeof value !== 'string' || !UUID_I.test(value)) throw new SqlError('22P02', 'invalid_uuid');
  return value.toLowerCase();
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

const ISO_PREFIX = /^\d{4}-\d{2}-\d{2}T/;

function compare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string' && ISO_PREFIX.test(a) && ISO_PREFIX.test(b)) return ms(a) - ms(b);
  const left = String(a);
  const right = String(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function same(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return a === b || String(a) === String(b);
}

/** A column, or a `payload->>key` / `payload->key` JSON path. */
function get(row: Row, column: string): unknown {
  const text = /^(\w+)->>(\w+)$/.exec(column);
  if (text) {
    const value = row[text[1]!]?.[text[2]!];
    if (value === undefined || value === null) return null;
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
  const json = /^(\w+)->(\w+)$/.exec(column);
  if (json) {
    const value = row[json[1]!]?.[json[2]!];
    return value === undefined ? null : clone(value);
  }
  return row[column];
}

function project(row: Row, columns: string): Row {
  if (columns.trim() === '*') return clone(row);
  const out: Row = {};
  for (const item of columns.split(',').map((part) => part.trim()).filter(Boolean)) {
    const at = item.indexOf(':');
    const alias = at === -1 ? item : item.slice(0, at);
    const expr = at === -1 ? item : item.slice(at + 1);
    if (!/^\w+(->>?\w+)?$/.test(expr)) throw new SqlError('PGRST100', 'unsupported_select');
    const value = get(row, expr);
    out[alias] = value === undefined ? null : clone(value);
  }
  return out;
}

// ── Rows ────────────────────────────────────────────────────────────────────

export interface FakeTables {
  r1_meet_bookings: Row[];
  r1_meet_receipts: Row[];
  interview_rounds: Row[];
  call_sessions: Row[];
  interview_round_attempts: Row[];
  ashby_application_links: Row[];
  job_queue: Row[];
  interview_round_consents: Row[];
}

function checkBooking(b: Row): void {
  const reasons = FAKE_STATUS_REASONS[b.status as string];
  check(reasons !== undefined, 'chk_r1_meet_bookings_status');
  check(reasons!.includes(b.reason), 'chk_r1_meet_bookings_status_reason');
  check(Number.isInteger(b.version) && b.version >= 0 && b.version <= 50, 'chk_r1_meet_bookings_version');
  check(Number.isInteger(b.key_attempt) && b.key_attempt >= 0 && b.key_attempt <= 20, 'chk_r1_meet_bookings_key_attempt');
  check(Number.isInteger(b.ticket_arms) && b.ticket_arms >= 0 && b.ticket_arms <= 5, 'chk_r1_meet_bookings_ticket_arms');
  check(typeof b.meet_url === 'string' && MEET.test(b.meet_url), 'chk_r1_meet_bookings_meet_url');
  check(ms(b.end_at) > ms(b.start_at) && ms(b.end_at) <= ms(b.start_at) + DAY, 'chk_r1_meet_bookings_slot');
  check(b.ticket_digest === null || HEX64.test(b.ticket_digest), 'chk_r1_meet_bookings_ticket_digest');
  for (const key of ['ashby_schedule_id', 'ashby_application_id', 'ashby_scheduled_by_user_id']) {
    check(typeof b[key] === 'string' && UUID_I.test(b[key]), `chk_r1_meet_bookings_${key}`);
  }
  check(
    (!ROUND_BOUND.includes(b.status) || (b.round_id !== null && b.candidate_id !== null))
      && (b.status !== 'unmatched_application' || (b.candidate_id === null && b.round_id === null))
      && (b.status !== 'unmapped_scheduler' || b.round_id === null)
      && (b.round_id === null || b.candidate_id !== null),
    'chk_r1_meet_bookings_round_binding',
  );
  check(
    (!HOLDS_BOT.includes(b.status) || b.recall_bot_id !== null) && (!BOTLESS.includes(b.status) || b.recall_bot_id === null),
    'chk_r1_meet_bookings_bot_binding',
  );
  check(
    (b.ticket_digest === null) === (b.ticket_not_before === null)
      && (b.ticket_digest === null) === (b.ticket_expires_at === null)
      && (b.ticket_expires_at === null || ms(b.ticket_expires_at) > ms(b.ticket_not_before))
      && (b.ticket_claimed_at === null || b.ticket_digest !== null)
      && (b.ticket_digest === null || [...HOLDS_BOT, ...TERMINAL].includes(b.status)),
    'chk_r1_meet_bookings_ticket',
  );
}

/**
 * 0142's unique constraint on the receipts' dedupe column. A named constant, not an inline literal
 * after `dedupe_key,`: gitleaks' generic-api-key rule reads that pair as a key and its value.
 */
const RECEIPTS_DEDUPE_UNIQUE = 'uq_r1_meet_receipts_dedupe_key';

function checkUnique(rows: Row[], key: (row: Row) => string | null, index: string): void {
  const seen = new Set<string>();
  for (const row of rows) {
    const value = key(row);
    if (value === null) continue;
    if (seen.has(value)) throw new SqlError('23505', index);
    seen.add(value);
  }
}

function checkReceipt(r: Row): void {
  check(['recall', 'ashby'].includes(r.source), 'chk_r1_meet_receipts_source');
  check(
    typeof r.dedupe_key === 'string' && r.dedupe_key.length >= 1 && r.dedupe_key.length <= 256 && DEDUPE_KEY.test(r.dedupe_key),
    'chk_r1_meet_receipts_dedupe_key',
  );
  check((r.source === 'ashby') === r.dedupe_key.startsWith('ashby-schedule:'), 'chk_r1_meet_receipts_dedupe_space');
  check(['recorded', 'enqueued', 'processed', 'ignored', 'failed'].includes(r.outcome), 'chk_r1_meet_receipts_outcome');
  check((r.processed_at === null) === ['recorded', 'enqueued'].includes(r.outcome), 'chk_r1_meet_receipts_processed');
}

function validate(tables: FakeTables): void {
  for (const booking of tables.r1_meet_bookings) checkBooking(booking);
  const bookings = tables.r1_meet_bookings;
  checkUnique(bookings, (b) => b.ashby_interview_event_id, 'uq_r1_meet_bookings_event');
  checkUnique(bookings, (b) => b.recall_bot_id, 'uq_r1_meet_bookings_recall_bot');
  checkUnique(bookings, (b) => b.ticket_digest, 'uq_r1_meet_bookings_ticket_digest');
  checkUnique(
    bookings,
    (b) => (b.round_id !== null && !TERMINAL.includes(b.status) ? b.round_id : null),
    'uq_r1_meet_bookings_live_round',
  );
  for (const receipt of tables.r1_meet_receipts) checkReceipt(receipt);
  checkUnique(tables.r1_meet_receipts, (r) => r.dedupe_key, RECEIPTS_DEDUPE_UNIQUE);
  checkUnique(
    tables.job_queue,
    (j) => (j.dedup_key && LIVE_JOB.includes(j.status) ? j.dedup_key : null),
    'uq_job_queue_dedup_active',
  );
}

// ── The fake ────────────────────────────────────────────────────────────────

export interface FakeDbCall {
  readonly kind: 'rpc' | 'from';
  readonly name: string;
  readonly args?: Record<string, unknown>;
}

export interface FakeDbSettings {
  /** What `r1_send_round` answers when the candidate has no live round (then it is `round_active`). */
  sendRound: FakeSendRoundAnswer;
  /** An active en-IN consent template that requires something exists. */
  consentTemplate: boolean;
  /** Exactly one sales_r1 role exists. */
  roleConfigured: boolean;
  /** The two phone checks the re-link runs itself (step 10). */
  phoneBlock: null | 'phone_engagement_active' | 'phone_assessment_pending';
}

export interface FakeEnqueueSpec {
  readonly payload: Readonly<Record<string, unknown>>;
  readonly dedupKey?: string;
  readonly maxAttempts?: number;
}

export interface R1MeetFakeDb {
  readonly client: typeof supabase;
  readonly store: R1MeetStore;
  readonly tables: FakeTables;
  /** Auth users (`auth.users`): `p_created_by` must be one of them. */
  readonly users: Set<string>;
  readonly settings: FakeDbSettings;
  readonly calls: FakeDbCall[];
  /** `rpc` (the 0142 function name, e.g. `r1_meet_set_bot`) or a table name. */
  failNext(target: string, mode?: 'error' | 'lost'): void;
  /** The raw row (every column, `ticket_digest` and `candidate_id` included), or undefined. */
  booking(id: string): Row | undefined;
  seedBooking(row: Partial<Row>): Row;
  addRound(row?: Partial<Row>): Row;
  addSession(row: Partial<Row> & { interview_round_id: string }): Row;
  /** The attempt of a session (`interview_round_attempts`, keyed by `session_id`), as `r1_settle_attempt` leaves it. */
  addAttempt(row: Partial<Row> & { session_id: string; round_id: string }): Row;
  linkApplication(applicationId: string, candidateId: string | null, terminalState?: string | null): Row;
  /** The queue's insert with `uq_job_queue_dedup_active`: a live job with the same key wins. */
  enqueue(spec: FakeEnqueueSpec, options?: { readonly scheduledAt?: string | Date }): Row;
  /** Job rows of the `r1-meet` queue, optionally of one `kind`. */
  jobs(kind?: string): Row[];
  /** A DSAR-style delete: the 0142 §5 trigger queues a `bot_release` for a bot the row held. */
  deleteBooking(id: string): void;
  /** HR cancels a Meet round in the app: the 0142 §6 trigger queues `round_cancelled` jobs. */
  cancelRound(roundId: string): void;
  /** The bridge page: digest the plaintext (with `source`'s secret) and call the claim RPC. */
  claimTicket(ticket: string, nowIso: string, source?: NodeJS.ProcessEnv): Promise<FakeAnswer>;
  bind(bookingId: string, sessionId: string, nowIso: string): Promise<FakeAnswer>;
}

export interface R1MeetFakeDbOptions {
  /** A shared, ordered log of `db:` and `queue:` steps (tests add their own `recall:` steps). */
  readonly timeline?: string[];
  /** Clock of job and seed rows (RPCs only use their `p_now`). */
  readonly now?: () => number;
}

export function createR1MeetFakeDb(options: R1MeetFakeDbOptions = {}): R1MeetFakeDb {
  const clock = options.now ?? (() => Date.parse('2030-01-01T10:00:00.000Z'));
  const timeline = options.timeline;
  let tables: FakeTables = {
    r1_meet_bookings: [],
    r1_meet_receipts: [],
    interview_rounds: [],
    call_sessions: [],
    interview_round_attempts: [],
    ashby_application_links: [],
    job_queue: [],
    interview_round_consents: [],
  };
  const users = new Set<string>();
  const settings: FakeDbSettings = { sendRound: 'ok', consentTemplate: true, roleConfigured: true, phoneBlock: null };
  const calls: FakeDbCall[] = [];
  const pending = new Map<string, Array<'error' | 'lost'>>();
  let counter = 0;
  const newId = (): string => `7f000000-0000-4000-9000-${(++counter).toString(16).padStart(12, '0')}`;

  const takeFailure = (target: string): 'error' | 'lost' | null => {
    const queue = pending.get(target);
    if (!queue || queue.length === 0) return null;
    return queue.shift()!;
  };

  /** One transaction: everything rolls back on a refusal of the database. */
  function transaction<T>(work: () => T): { ok: true; value: T } | { ok: false; error: SqlError } {
    const snapshot = clone(tables);
    try {
      const value = work();
      validate(tables);
      return { ok: true, value };
    } catch (error) {
      tables = snapshot;
      if (error instanceof SqlError) return { ok: false, error };
      throw error;
    }
  }

  const findBooking = (id: unknown): Row | undefined =>
    typeof id === 'string' ? tables.r1_meet_bookings.find((b) => b.id === id.toLowerCase()) : undefined;
  const findRound = (id: unknown): Row | undefined =>
    typeof id === 'string' ? tables.interview_rounds.find((r) => r.id === id.toLowerCase()) : undefined;
  const roundLiveAt = (round: Row | undefined, now: number): boolean =>
    round !== undefined
    && round.channel === 'meet'
    && ['invited', 'in_progress'].includes(round.status)
    && ms(round.expires_at) > now;
  const liveSessionOf = (roundId: string): boolean =>
    tables.call_sessions.some((s) => s.interview_round_id === roundId && LIVE_SESSION.includes(s.status));

  const insertJob = (payload: Record<string, unknown>, dedupKey: string | null, maxAttempts: number, scheduledAt: string): Row => {
    if (dedupKey !== null) {
      const live = tables.job_queue.find((j) => j.dedup_key === dedupKey && LIVE_JOB.includes(j.status));
      if (live) return live;
    }
    const row: Row = {
      id: newId(),
      name: 'r1-meet',
      payload: clone(payload),
      status: 'pending',
      dedup_key: dedupKey,
      attempts: 0,
      max_attempts: maxAttempts,
      scheduled_at: scheduledAt,
      created_at: iso(clock()),
    };
    tables.job_queue.push(row);
    timeline?.push(`queue:${String(payload.kind)}`);
    return row;
  };

  // ── The RPCs ──────────────────────────────────────────────────────────────

  type Rpc = (args: Record<string, unknown>) => Row;

  const createRound: Rpc = (a) => {
    // 1. Validation. Nothing is written.
    if (a.p_ashby_interview_event_id === null || a.p_ashby_interview_event_id === undefined) {
      return { status: 'invalid_request', field: 'event_id' };
    }
    const eventId = uuidArg(a.p_ashby_interview_event_id)!;
    const createdBy = uuidArg(a.p_created_by);
    const textUuid = (value: unknown): boolean => typeof value === 'string' && UUID_I.test(value);
    if (!textUuid(a.p_ashby_schedule_id)) return { status: 'invalid_request', field: 'schedule_id' };
    if (!textUuid(a.p_ashby_application_id)) return { status: 'invalid_request', field: 'application_id' };
    if (a.p_ashby_interview_stage_id !== null && !textUuid(a.p_ashby_interview_stage_id)) {
      return { status: 'invalid_request', field: 'stage_id' };
    }
    if (a.p_ashby_interview_id !== null && !textUuid(a.p_ashby_interview_id)) {
      return { status: 'invalid_request', field: 'interview_id' };
    }
    if (!textUuid(a.p_ashby_scheduled_by_user_id)) return { status: 'invalid_request', field: 'attester' };
    if (typeof a.p_meet_url !== 'string' || !MEET.test(a.p_meet_url)) return { status: 'invalid_request', field: 'meet_url' };
    const start = a.p_start_at === null ? null : ms(ts(a.p_start_at));
    const end = a.p_end_at === null ? null : ms(ts(a.p_end_at));
    if (start === null || end === null || end <= start || end > start + DAY) return { status: 'invalid_request', field: 'slot' };
    const now = a.p_now === null || a.p_now === undefined ? null : ms(ts(a.p_now));
    if (a.p_attested_at === null || (now !== null && ms(ts(a.p_attested_at)) > now + 5 * MINUTE)) {
      return { status: 'invalid_request', field: 'attested_at' };
    }
    if (a.p_objective_profile !== 'r1_dex_sales') return { status: 'invalid_request', field: 'profile' };
    const grace = a.p_expiry_grace_sec;
    if (typeof grace !== 'number' || grace < 900 || grace > 86400) return { status: 'invalid_request', field: 'grace' };
    if (now === null) return { status: 'invalid_request', field: 'now' };
    const updatedAt = ts(a.p_ashby_updated_at);
    const meetUrl = a.p_meet_url;

    // 2. The event's booking first: a replay always reads it.
    const booking = tables.r1_meet_bookings.find((b) => b.ashby_interview_event_id === eventId);
    let rebind = false;
    if (booking) {
      const sameSlot = ms(booking.start_at) === start && ms(booking.end_at) === end && booking.meet_url === meetUrl;
      if (['completed', 'cancelled', 'drained'].includes(booking.status) || (booking.status === 'failed' && (start <= now || sameSlot))) {
        return { status: 'booking_terminal', booking_id: booking.id, booking_status: booking.status, reason: booking.reason };
      }
      if (booking.round_id !== null && booking.status !== 'failed') {
        const round = findRound(booking.round_id);
        const live = round !== undefined && ['invited', 'in_progress'].includes(round.status) && ms(round.expires_at) > now;
        const lapsed = round !== undefined
          && (round.status === 'expired' || (['invited', 'in_progress'].includes(round.status) && ms(round.expires_at) <= now));
        if (!lapsed || DISPATCHED.includes(booking.status) || start <= now) {
          return {
            status: 'exists',
            booking_id: booking.id,
            round_id: booking.round_id,
            candidate_id: booking.candidate_id,
            booking_status: booking.status,
            reason: booking.reason,
            version: booking.version,
            key_attempt: booking.key_attempt,
            round_expires_at: round ? round.expires_at : null,
            round_live: live,
            objective_profile: booking.objective_profile,
          };
        }
      }
      if (updatedAt !== null && booking.ashby_updated_at !== null && ms(updatedAt) < ms(booking.ashby_updated_at)) {
        return { status: 'stale_update', booking_id: booking.id };
      }
      if (booking.recall_bot_id !== null) {
        return {
          status: 'bot_attached',
          booking_id: booking.id,
          booking_status: booking.status,
          version: booking.version,
          key_attempt: booking.key_attempt,
        };
      }
      rebind = booking.round_id !== null || booking.status === 'failed';
      if (rebind && booking.version >= 50) return { status: 'version_exhausted', booking_id: booking.id, version: booking.version };
      if (start <= now) return { status: 'in_past', booking_id: booking.id };
    } else if (start <= now) {
      // 3. Never booked; nothing is written.
      return { status: 'in_past' };
    }

    let status = '';
    let reason = '';
    let result: 'created' | 'relinked' | null = null;
    let roundId: string | null = null;
    let candidateId: string | null = null;
    let retryAfter: string | null = null;
    const expires = end + grace * 1000;
    decide: {
      // 4. The candidate, through the application link only.
      const link = tables.ashby_application_links.find(
        (l) => l.provider === 'ashby' && l.external_application_id === a.p_ashby_application_id,
      );
      if (!link || link.candidate_id === null) {
        [status, reason] = ['unmatched_application', 'application_unknown'];
        break decide;
      }
      if (link.terminal_state !== null && link.terminal_state !== undefined) {
        [status, reason] = ['unmatched_application', 'application_terminal'];
        break decide;
      }
      candidateId = link.candidate_id as string;
      // 5. The round creator must be a real auth user.
      if (createdBy === null) {
        [status, reason] = ['unmapped_scheduler', 'scheduler_unmapped'];
        break decide;
      }
      if (!users.has(createdBy)) {
        [status, reason] = ['unmapped_scheduler', 'created_by_unknown'];
        break decide;
      }
      // 6. The bounded expiry.
      if (expires > now + 14 * DAY) {
        retryAfter = iso(expires - 14 * DAY);
        [status, reason] = ['blocked', 'slot_too_far'];
        break decide;
      }
      // 7. The notice. 8. The role.
      if (!settings.consentTemplate) {
        [status, reason] = ['blocked', 'consent_template_unavailable'];
        break decide;
      }
      if (!settings.roleConfigured) {
        [status, reason] = ['blocked', 'role_not_configured'];
        break decide;
      }
      // 8a. A lapsed, unused Meet round of the candidate is expired, as the sweep would.
      const lapsed = tables.interview_rounds.find(
        (r) => r.candidate_id === candidateId
          && r.kind === 'sales_r1'
          && r.channel === 'meet'
          && r.status === 'invited'
          && r.starts_used === 0
          && ms(r.expires_at) <= now
          && !liveSessionOf(r.id)
          && !tables.r1_meet_bookings.some(
            (o) => o.round_id === r.id && !TERMINAL.includes(o.status) && o.ashby_interview_event_id !== eventId,
          ),
      );
      if (lapsed) {
        lapsed.status = 'expired';
        lapsed.version += 1;
      }
      // 9. r1_send_round.
      const live = tables.interview_rounds.find(
        (r) => r.candidate_id === candidateId && r.kind === 'sales_r1' && ['invited', 'in_progress'].includes(r.status),
      );
      const code = live ? 'round_active' : settings.sendRound;
      if (code === 'ok') {
        const round: Row = {
          id: newId(),
          candidate_id: candidateId,
          kind: 'sales_r1',
          channel: 'meet',
          status: 'invited',
          expires_at: iso(expires),
          starts_used: 0,
          attempts_counted: 0,
          attempts_allowed: 3,
          version: 1,
          created_by: createdBy,
          updated_at: iso(now),
        };
        tables.interview_rounds.push(round);
        roundId = round.id;
        [status, reason, result] = ['pending', 'eligible', 'created'];
        break decide;
      }
      if ((FAKE_SEND_ROUND_REFUSALS as readonly string[]).includes(code)) {
        [status, reason] = ['blocked', code];
        break decide;
      }
      if (code !== 'round_active') throw new SqlError('P0001', 'unexpected answer from r1_send_round');
      // 10. Re-link a reusable Meet round.
      [status, reason] = ['blocked', 'round_active'];
      if (!live) break decide;
      if (
        live.channel !== 'meet'
        || !['invited', 'in_progress'].includes(live.status)
        || ms(live.expires_at) <= now
        || live.starts_used >= 3
        || live.attempts_counted >= live.attempts_allowed
        || liveSessionOf(live.id)
        || tables.r1_meet_bookings.some((b) => b.round_id === live.id && !TERMINAL.includes(b.status))
      ) {
        break decide;
      }
      if (settings.phoneBlock !== null) {
        reason = settings.phoneBlock;
        break decide;
      }
      if (!settings.consentTemplate) {
        reason = 'consent_template_unavailable';
        break decide;
      }
      live.expires_at = iso(expires);
      live.version += 1;
      live.updated_at = iso(now);
      for (const consent of tables.interview_round_consents) {
        if (consent.round_id === live.id && consent.withdrawn_at === null) consent.withdrawn_at = iso(now);
      }
      roundId = live.id;
      [status, reason, result] = ['pending', 'eligible', 'relinked'];
    }

    if (result !== null) {
      tables.interview_round_consents.push({
        id: newId(),
        round_id: roundId,
        method: 'hr_attested_ashby',
        attested_by_external_id: a.p_ashby_scheduled_by_user_id,
        attested_at: ts(a.p_attested_at),
        india_location_attested: true,
        granted_at: iso(now),
        withdrawn_at: null,
      });
    }

    let row: Row;
    if (booking) {
      Object.assign(booking, {
        ashby_schedule_id: a.p_ashby_schedule_id,
        ashby_application_id: a.p_ashby_application_id,
        ashby_interview_stage_id: a.p_ashby_interview_stage_id,
        ashby_interview_id: a.p_ashby_interview_id,
        ashby_scheduled_by_user_id: a.p_ashby_scheduled_by_user_id,
        ashby_updated_at:
          booking.ashby_updated_at === null ? updatedAt
          : updatedAt === null ? booking.ashby_updated_at
          : iso(Math.max(ms(booking.ashby_updated_at), ms(updatedAt))),
        candidate_id: candidateId,
        round_id: roundId,
        objective_profile: a.p_objective_profile,
        status,
        reason,
        meet_url: meetUrl,
        start_at: iso(start),
        end_at: iso(end),
        updated_at: iso(now),
      });
      if (rebind) {
        Object.assign(booking, {
          version: booking.version + 1,
          key_attempt: 0,
          ticket_digest: null,
          ticket_not_before: null,
          ticket_expires_at: null,
          ticket_claimed_at: null,
          ticket_arms: 0,
          session_id: null,
        });
      }
      row = booking;
    } else {
      row = {
        id: newId(),
        ashby_interview_event_id: eventId,
        ashby_schedule_id: a.p_ashby_schedule_id,
        ashby_application_id: a.p_ashby_application_id,
        ashby_interview_stage_id: a.p_ashby_interview_stage_id,
        ashby_interview_id: a.p_ashby_interview_id,
        ashby_scheduled_by_user_id: a.p_ashby_scheduled_by_user_id,
        ashby_updated_at: updatedAt,
        candidate_id: candidateId,
        round_id: roundId,
        objective_profile: a.p_objective_profile,
        status,
        reason,
        version: 0,
        key_attempt: 0,
        meet_url: meetUrl,
        start_at: iso(start),
        end_at: iso(end),
        recall_bot_id: null,
        ticket_digest: null,
        ticket_not_before: null,
        ticket_expires_at: null,
        ticket_claimed_at: null,
        ticket_arms: 0,
        session_id: null,
        created_at: iso(now),
        updated_at: iso(now),
      };
      tables.r1_meet_bookings.push(row);
    }

    let out: Row;
    if (result !== null) {
      out = {
        status: result,
        booking_id: row.id,
        round_id: row.round_id,
        candidate_id: row.candidate_id,
        booking_status: row.status,
        reason: row.reason,
        version: row.version,
        key_attempt: row.key_attempt,
        round_expires_at: iso(expires),
        objective_profile: row.objective_profile,
      };
    } else {
      out = { status, reason, booking_id: row.id };
      if (retryAfter !== null) out.retry_after = retryAfter;
    }
    if (rebind) out.rebound = true;
    return out;
  };

  const reschedule: Rpc = (a) => {
    if (typeof a.p_meet_url !== 'string' || !MEET.test(a.p_meet_url)) return { status: 'invalid_request', field: 'meet_url' };
    const start = a.p_start_at === null ? null : ms(ts(a.p_start_at));
    const end = a.p_end_at === null ? null : ms(ts(a.p_end_at));
    if (start === null || end === null || end <= start || end > start + DAY) return { status: 'invalid_request', field: 'slot' };
    const grace = a.p_expiry_grace_sec;
    if (typeof grace !== 'number' || grace < 900 || grace > 86400) return { status: 'invalid_request', field: 'grace' };
    if (a.p_now === null || a.p_now === undefined) return { status: 'invalid_request', field: 'now' };
    const now = ms(ts(a.p_now));
    uuidArg(a.p_booking_id, false);
    const b = findBooking(a.p_booking_id);
    if (!b) return { status: 'not_found' };
    if (TERMINAL.includes(b.status)) {
      return { status: 'booking_terminal', booking_id: b.id, booking_status: b.status, reason: b.reason };
    }
    if (b.version !== a.p_expected_version) {
      return { status: 'version_conflict', booking_id: b.id, version: b.version, key_attempt: b.key_attempt };
    }
    const updatedAt = ts(a.p_ashby_updated_at);
    if (updatedAt !== null && b.ashby_updated_at !== null && ms(updatedAt) < ms(b.ashby_updated_at)) {
      return { status: 'stale_update', booking_id: b.id };
    }
    if (DISPATCHED.includes(b.status)) return { status: 'booking_dispatched', booking_id: b.id, booking_status: b.status };
    if (b.recall_bot_id !== null) {
      return { status: 'bot_attached', booking_id: b.id, version: b.version, key_attempt: b.key_attempt };
    }
    if (b.round_id === null) {
      return { status: 'no_round', booking_id: b.id, booking_status: b.status, reason: b.reason };
    }
    if (!['pending', 'blocked'].includes(b.status)) return { status: 'not_allowed', booking_id: b.id, booking_status: b.status };
    if (start <= now) return { status: 'in_past', booking_id: b.id };
    const expires = end + grace * 1000;
    if (expires > now + 14 * DAY) return { status: 'slot_too_far', booking_id: b.id, retry_after: iso(expires - 14 * DAY) };
    const moved = ms(b.start_at) !== start || ms(b.end_at) !== end || b.meet_url !== a.p_meet_url;
    if (moved && b.version >= 50) return { status: 'version_exhausted', booking_id: b.id, version: b.version };
    const round = findRound(b.round_id);
    if (!roundLiveAt(round, now)) return { status: 'round_not_live', booking_id: b.id, round_id: b.round_id };
    round!.expires_at = iso(expires);
    round!.version += 1;
    round!.updated_at = iso(now);
    Object.assign(b, {
      start_at: iso(start),
      end_at: iso(end),
      meet_url: a.p_meet_url,
      version: moved ? b.version + 1 : b.version,
      key_attempt: moved ? 0 : b.key_attempt,
      ashby_updated_at:
        b.ashby_updated_at === null ? updatedAt
        : updatedAt === null ? b.ashby_updated_at
        : iso(Math.max(ms(b.ashby_updated_at), ms(updatedAt))),
      ticket_digest: null,
      ticket_not_before: null,
      ticket_expires_at: null,
      ticket_claimed_at: null,
      status: 'pending',
      reason: 'eligible',
      updated_at: iso(now),
    });
    return { status: 'ok', booking_id: b.id, round_expires_at: iso(expires), version: b.version, key_attempt: b.key_attempt };
  };

  const cancel: Rpc = (a) => {
    if (!['cancelled', 'dex_absent', 'event_removed', 'round_cancelled'].includes(a.p_reason as string)) {
      return { status: 'invalid_reason' };
    }
    if (a.p_now === null || a.p_now === undefined) return { status: 'invalid_request', field: 'now' };
    const now = ts(a.p_now)!;
    uuidArg(a.p_booking_id, false);
    const b = findBooking(a.p_booking_id);
    if (!b) return { status: 'not_found' };
    if (b.status === 'cancelled') {
      return { status: 'already_cancelled', booking_id: b.id, reason: b.reason, recall_bot_id: b.recall_bot_id };
    }
    if (['completed', 'failed', 'drained'].includes(b.status)) {
      return { status: 'booking_terminal', booking_id: b.id, booking_status: b.status, reason: b.reason };
    }
    const previous = b.status;
    Object.assign(b, { status: 'cancelled', reason: a.p_reason, updated_at: now });
    if (b.ticket_claimed_at === null) Object.assign(b, { ticket_digest: null, ticket_not_before: null, ticket_expires_at: null });
    return {
      status: 'ok',
      booking_id: b.id,
      previous_status: previous,
      recall_bot_id: b.recall_bot_id,
      bot_dispatched: DISPATCHED.includes(previous),
    };
  };

  const setBot: Rpc = (a) => {
    if (!['attach', 'rotate_key', 'replace', 'release'].includes(a.p_action as string)) return { status: 'invalid_action' };
    if (a.p_now === null || a.p_now === undefined) return { status: 'invalid_request', field: 'now' };
    const botId = uuidArg(a.p_recall_bot_id);
    if (a.p_action === 'attach' && botId === null) return { status: 'invalid_request', field: 'recall_bot_id' };
    const now = ms(ts(a.p_now));
    uuidArg(a.p_booking_id, false);
    const b = findBooking(a.p_booking_id);
    if (!b) return { status: 'not_found' };
    let answer: string;
    if (b.version !== a.p_expected_version || b.key_attempt !== a.p_expected_key_attempt) {
      answer = 'version_conflict';
    } else if (a.p_action === 'attach') {
      if (b.status === 'bot_scheduled' && b.recall_bot_id === botId) answer = 'duplicate';
      else if (b.status === 'bot_scheduled') answer = 'bot_conflict';
      else if (b.status !== 'pending') answer = 'not_allowed';
      else if (now >= ms(b.end_at)) answer = 'in_past';
      else if (!roundLiveAt(findRound(b.round_id), now)) answer = 'round_not_live';
      else if (tables.r1_meet_bookings.some((o) => o.recall_bot_id === botId && o.id !== b.id)) answer = 'bot_in_use';
      else {
        Object.assign(b, { recall_bot_id: botId, status: 'bot_scheduled', reason: 'eligible', updated_at: iso(now) });
        answer = 'ok';
      }
    } else if (a.p_action === 'rotate_key') {
      if (b.status !== 'pending') answer = 'not_allowed';
      else if (b.key_attempt >= 20) answer = 'key_attempts_exhausted';
      else {
        Object.assign(b, { key_attempt: b.key_attempt + 1, updated_at: iso(now) });
        answer = 'ok';
      }
    } else if (a.p_action === 'replace') {
      if (b.status !== 'bot_scheduled') answer = 'not_allowed';
      else if (b.version >= 50) answer = 'version_exhausted';
      else {
        Object.assign(b, {
          recall_bot_id: null,
          version: b.version + 1,
          key_attempt: 0,
          ticket_digest: null,
          ticket_not_before: null,
          ticket_expires_at: null,
          ticket_claimed_at: null,
          ticket_arms: 0,
          status: 'pending',
          reason: 'eligible',
          updated_at: iso(now),
        });
        answer = 'ok';
      }
    } else if (!TERMINAL.includes(b.status)) {
      answer = 'not_allowed';
    } else if (b.recall_bot_id === null) {
      answer = 'duplicate';
    } else {
      Object.assign(b, { recall_bot_id: null, updated_at: iso(now) });
      answer = 'ok';
    }
    return { status: answer, booking_id: b.id, version: b.version, key_attempt: b.key_attempt, booking_status: b.status };
  };

  const transition: Rpc = (a) => {
    if (a.p_now === null || a.p_now === undefined) return { status: 'invalid_request', field: 'now' };
    const now = ts(a.p_now)!;
    uuidArg(a.p_booking_id, false);
    const b = findBooking(a.p_booking_id);
    if (!b) return { status: 'not_found' };
    if (b.status !== a.p_from_status) return { status: 'status_conflict', booking_id: b.id, current: b.status };
    const allowed = FAKE_TRANSITIONS.some(
      ([from, to]) => from.includes(a.p_from_status as string) && to.includes(a.p_to_status as string),
    );
    if (!allowed) {
      return { status: 'invalid_transition', booking_id: b.id, from_status: a.p_from_status, to_status: a.p_to_status };
    }
    const terminal = ['completed', 'failed', 'drained'].includes(a.p_to_status as string);
    const previous = b.status;
    Object.assign(b, { status: a.p_to_status, reason: a.p_reason, updated_at: now });
    if (terminal && b.ticket_claimed_at === null) Object.assign(b, { ticket_digest: null, ticket_not_before: null, ticket_expires_at: null });
    return {
      status: 'ok',
      booking_id: b.id,
      previous_status: previous,
      booking_status: a.p_to_status,
      reason: a.p_reason,
      recall_bot_id: b.recall_bot_id,
    };
  };

  const bindSession: Rpc = (a) => {
    if (a.p_now === null || a.p_now === undefined) return { status: 'invalid_request', field: 'now' };
    const now = ts(a.p_now)!;
    uuidArg(a.p_booking_id, false);
    const sessionId = uuidArg(a.p_session_id);
    const b = findBooking(a.p_booking_id);
    if (!b) return { status: 'not_found' };
    if (b.status !== 'in_call') return { status: 'not_in_call', booking_id: b.id, booking_status: b.status };
    const session = tables.call_sessions.find((s) => s.id === sessionId);
    if (!session || session.interview_round_id !== b.round_id) return { status: 'session_mismatch', booking_id: b.id };
    if (b.session_id === sessionId) return { status: 'duplicate', booking_id: b.id, session_id: b.session_id };
    const previous = b.session_id;
    Object.assign(b, { session_id: sessionId, updated_at: now });
    return { status: 'ok', booking_id: b.id, session_id: sessionId, previous_session_id: previous };
  };

  const armTicket: Rpc = (a) => {
    if (typeof a.p_ticket_digest !== 'string' || !HEX64.test(a.p_ticket_digest)) return { status: 'invalid_ticket' };
    if (a.p_now === null || a.p_now === undefined) return { status: 'invalid_request', field: 'now' };
    const now = ms(ts(a.p_now));
    if (a.p_not_before === null || a.p_expires_at === null) return { status: 'invalid_window' };
    const notBefore = ms(ts(a.p_not_before));
    const expires = ms(ts(a.p_expires_at));
    if (notBefore >= expires || expires <= now) return { status: 'invalid_window' };
    uuidArg(a.p_booking_id, false);
    const b = findBooking(a.p_booking_id);
    if (!b) return { status: 'not_found' };
    if (notBefore < ms(b.start_at) - 15 * MINUTE || expires > ms(b.end_at) + 30 * MINUTE) {
      return { status: 'invalid_window', booking_id: b.id };
    }
    if (!HOLDS_BOT.includes(b.status)) return { status: 'not_armable', booking_id: b.id, booking_status: b.status };
    if (b.ticket_digest === a.p_ticket_digest) {
      if (b.ticket_claimed_at !== null) return { status: 'digest_in_use', booking_id: b.id };
      if (ms(b.ticket_not_before) === notBefore && ms(b.ticket_expires_at) === expires) {
        return {
          status: 'duplicate',
          booking_id: b.id,
          not_before: b.ticket_not_before,
          expires_at: b.ticket_expires_at,
          ticket_arms: b.ticket_arms,
        };
      }
    }
    if (b.ticket_arms >= 5) return { status: 'ticket_arms_exhausted', booking_id: b.id, ticket_arms: b.ticket_arms };
    if (tables.r1_meet_bookings.some((o) => o.ticket_digest === a.p_ticket_digest && o.id !== b.id)) {
      return { status: 'digest_in_use', booking_id: b.id };
    }
    Object.assign(b, {
      ticket_digest: a.p_ticket_digest,
      ticket_not_before: iso(notBefore),
      ticket_expires_at: iso(expires),
      ticket_claimed_at: null,
      ticket_arms: b.ticket_arms + 1,
      updated_at: iso(now),
    });
    return {
      status: 'ok',
      booking_id: b.id,
      not_before: b.ticket_not_before,
      expires_at: b.ticket_expires_at,
      ticket_arms: b.ticket_arms,
    };
  };

  const claimTicketRpc: Rpc = (a) => {
    if (typeof a.p_ticket_digest !== 'string' || !HEX64.test(a.p_ticket_digest)) return { status: 'invalid_ticket' };
    if (a.p_now === null || a.p_now === undefined) return { status: 'invalid_request', field: 'now' };
    const now = ms(ts(a.p_now));
    const b = tables.r1_meet_bookings.find((row) => row.ticket_digest === a.p_ticket_digest);
    if (!b) return { status: 'ticket_unknown' };
    if (b.ticket_claimed_at !== null) return { status: 'ticket_already_claimed', booking_id: b.id };
    if (!HOLDS_BOT.includes(b.status)) return { status: 'booking_not_claimable', booking_id: b.id, booking_status: b.status };
    if (now < ms(b.ticket_not_before)) return { status: 'ticket_not_yet_valid', booking_id: b.id };
    if (now >= ms(b.ticket_expires_at)) return { status: 'ticket_expired', booking_id: b.id };
    if (!roundLiveAt(findRound(b.round_id), now)) return { status: 'round_not_live', booking_id: b.id, round_id: b.round_id };
    Object.assign(b, { ticket_claimed_at: iso(now), status: 'in_call', reason: 'eligible', updated_at: iso(now) });
    return {
      status: 'ok',
      booking_id: b.id,
      round_id: b.round_id,
      candidate_id: b.candidate_id,
      objective_profile: b.objective_profile,
      ashby_interview_event_id: b.ashby_interview_event_id,
      session_id: b.session_id,
      start_at: b.start_at,
      end_at: b.end_at,
    };
  };

  const recordReceipt: Rpc = (a) => {
    if (!['recall', 'ashby'].includes(a.p_source as string)) return { status: 'invalid_source' };
    const key = a.p_dedupe_key;
    if (
      typeof key !== 'string' || key.length < 1 || key.length > 256 || !DEDUPE_KEY.test(key)
      || (a.p_source === 'ashby') !== key.startsWith('ashby-schedule:')
    ) {
      return { status: 'invalid_dedupe_key' };
    }
    if (typeof a.p_event_type !== 'string' || !EVENT_TYPE.test(a.p_event_type)) return { status: 'invalid_event_type' };
    if (a.p_now === null || a.p_now === undefined) return { status: 'invalid_request', field: 'now' };
    const now = ms(ts(a.p_now));
    const enqueue = a.p_enqueue === true;
    const payload = a.p_payload as Row | null | undefined;
    if (enqueue) {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.kind !== 'string' || !KIND.test(payload.kind)) {
        return { status: 'invalid_payload' };
      }
      if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > 4096) return { status: 'payload_too_large' };
    } else if (payload !== null && payload !== undefined) {
      return { status: 'invalid_payload' };
    }
    const scheduledAt = a.p_scheduled_at === null || a.p_scheduled_at === undefined ? null : ms(ts(a.p_scheduled_at));
    if (scheduledAt !== null && (!enqueue || scheduledAt < now - 60 * MINUTE || scheduledAt > now + 30 * DAY)) {
      return { status: 'invalid_scheduled_at' };
    }
    const bookingId = uuidArg(a.p_booking_id);
    const linked = bookingId !== null && findBooking(bookingId) ? bookingId : null;
    let receipt = tables.r1_meet_receipts.find((r) => r.dedupe_key === key);
    const created = receipt === undefined;
    if (!receipt) {
      receipt = {
        id: newId(),
        source: a.p_source,
        dedupe_key: key,
        event_type: a.p_event_type,
        booking_id: linked,
        outcome: enqueue ? 'enqueued' : 'recorded',
        received_at: iso(now),
        processed_at: null,
      };
      tables.r1_meet_receipts.push(receipt);
    } else if (enqueue && receipt.outcome === 'recorded') {
      receipt.outcome = 'enqueued';
    }
    let enqueued = false;
    let workPending = false;
    if (enqueue) {
      const jobKey = `r1-meet:receipt:${receipt.id}`;
      if (['processed', 'ignored', 'failed'].includes(receipt.outcome)) workPending = true;
      else if (tables.job_queue.some((j) => j.dedup_key === jobKey && LIVE_JOB.includes(j.status))) workPending = true;
      else {
        insertJob({ ...payload!, receipt_id: receipt.id, source: a.p_source }, jobKey, 5, iso(scheduledAt ?? now));
        enqueued = true;
        workPending = true;
      }
    }
    return {
      status: created ? 'inserted' : 'duplicate',
      id: receipt.id,
      outcome: receipt.outcome,
      enqueued,
      work_pending: workPending,
      booking_linked: receipt.booking_id !== null,
    };
  };

  const prune = (table: 'r1_meet_receipts' | 'r1_meet_bookings'): Rpc => (a) => {
    if (a.p_now === null || a.p_now === undefined) return { status: 'invalid_request', field: 'now' };
    if (a.p_older_than === null || a.p_older_than === undefined) return { status: 'invalid_request', field: 'older_than' };
    const limit = a.p_limit;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 5000) {
      return { status: 'invalid_request', field: 'limit' };
    }
    const now = ms(ts(a.p_now));
    const olderThan = ms(ts(a.p_older_than));
    if (olderThan > now - 7 * DAY) return { status: 'retention_too_short' };
    let victims: Row[];
    if (table === 'r1_meet_receipts') {
      victims = tables.r1_meet_receipts
        .filter(
          (r) => ms(r.received_at) < olderThan
            && (['recorded', 'processed', 'ignored', 'failed'].includes(r.outcome)
              || (r.outcome === 'enqueued'
                && !tables.job_queue.some((j) => j.dedup_key === `r1-meet:receipt:${r.id}` && LIVE_JOB.includes(j.status)))),
        )
        .sort((x, y) => ms(x.received_at) - ms(y.received_at))
        .slice(0, limit);
      tables.r1_meet_receipts = tables.r1_meet_receipts.filter((r) => !victims.includes(r));
    } else {
      victims = tables.r1_meet_bookings
        .filter((b) => b.round_id === null && b.recall_bot_id === null && ms(b.end_at) < olderThan)
        .sort((x, y) => ms(x.end_at) - ms(y.end_at))
        .slice(0, limit);
      const ids = new Set(victims.map((b) => b.id));
      tables.r1_meet_bookings = tables.r1_meet_bookings.filter((b) => !ids.has(b.id));
      for (const receipt of tables.r1_meet_receipts) if (ids.has(receipt.booking_id)) receipt.booking_id = null;
    }
    return { status: 'ok', deleted: victims.length };
  };

  const RPCS: Record<string, Rpc> = {
    r1_meet_create_round_from_ashby: createRound,
    r1_meet_reschedule_booking: reschedule,
    r1_meet_cancel_booking: cancel,
    r1_meet_set_bot: setBot,
    r1_meet_transition_booking: transition,
    r1_meet_bind_session: bindSession,
    r1_meet_arm_ticket: armTicket,
    r1_meet_claim_ticket: claimTicketRpc,
    r1_meet_record_receipt: recordReceipt,
    r1_meet_prune_receipts: prune('r1_meet_receipts'),
    r1_meet_prune_bookings: prune('r1_meet_bookings'),
  };

  const failure = (code: string, message: string): FakeAnswer => ({ data: null, error: { code, message } });

  async function rpc(name: string, args: Record<string, unknown> = {}): Promise<FakeAnswer> {
    calls.push({ kind: 'rpc', name, args: clone(args) });
    const short = name.replace(/^r1_meet_/, '');
    timeline?.push(
      name === 'r1_meet_set_bot' ? `db:set_bot:${String(args.p_action)}`
      : name === 'r1_meet_transition_booking' ? `db:transition:${String(args.p_to_status)}`
      : `db:${short}`,
    );
    const mode = takeFailure(name);
    if (mode === 'error') return failure('XX000', 'fake_db_failure');
    const fn = RPCS[name];
    if (!fn) return failure('PGRST202', 'unknown_function');
    const outcome = transaction(() => fn(args));
    if (!outcome.ok) return failure(outcome.error.code, outcome.error.detail);
    if (mode === 'lost') return failure('08006', 'fake_answer_lost');
    return { data: clone(outcome.value), error: null };
  }

  // ── Tables ────────────────────────────────────────────────────────────────

  type Filter = (row: Row) => boolean;

  class FakeQuery implements PromiseLike<FakeAnswer> {
    private readonly filters: Filter[] = [];
    private mode: 'select' | 'update' | 'delete' = 'select';
    private columns = '*';
    private counting = false;
    private head = false;
    private patch: Row | null = null;
    private returning: string | null = null;
    private readonly orders: Array<{ column: string; ascending: boolean }> = [];
    private max: number | null = null;

    constructor(private readonly table: keyof FakeTables, private readonly fail: 'error' | 'lost' | null) {}

    select(columns = '*', opts: { count?: 'exact'; head?: boolean } = {}): this {
      if (this.mode !== 'select') {
        this.returning = columns;
        return this;
      }
      this.columns = columns;
      this.counting = opts.count === 'exact';
      this.head = opts.head === true;
      return this;
    }

    update(patch: Row): this {
      this.mode = 'update';
      this.patch = clone(patch);
      return this;
    }

    delete(): this {
      this.mode = 'delete';
      return this;
    }

    eq(column: string, value: unknown): this {
      this.filters.push((row) => same(get(row, column), value));
      return this;
    }

    neq(column: string, value: unknown): this {
      this.filters.push((row) => {
        const v = get(row, column);
        return v !== null && v !== undefined && !same(v, value);
      });
      return this;
    }

    in(column: string, values: readonly unknown[]): this {
      this.filters.push((row) => values.some((value) => same(get(row, column), value)));
      return this;
    }

    not(column: string, operator: string, value: unknown): this {
      if (operator !== 'is' || value !== null) throw new Error('fake db: only not(column, "is", null) is supported');
      this.filters.push((row) => get(row, column) !== null && get(row, column) !== undefined);
      return this;
    }

    private range(column: string, test: (c: number) => boolean, value: unknown): this {
      this.filters.push((row) => {
        const v = get(row, column);
        return v !== null && v !== undefined && test(compare(v, value));
      });
      return this;
    }

    lt(column: string, value: unknown): this {
      return this.range(column, (c) => c < 0, value);
    }

    lte(column: string, value: unknown): this {
      return this.range(column, (c) => c <= 0, value);
    }

    gt(column: string, value: unknown): this {
      return this.range(column, (c) => c > 0, value);
    }

    gte(column: string, value: unknown): this {
      return this.range(column, (c) => c >= 0, value);
    }

    like(column: string, pattern: string): this {
      const re = new RegExp(`^${pattern.split('%').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
      this.filters.push((row) => {
        const v = get(row, column);
        return typeof v === 'string' && re.test(v);
      });
      return this;
    }

    order(column: string, opts: { ascending?: boolean } = {}): this {
      this.orders.push({ column, ascending: opts.ascending !== false });
      return this;
    }

    limit(n: number): this {
      this.max = n;
      return this;
    }

    async maybeSingle(): Promise<FakeAnswer> {
      const answer = await this.run();
      if (answer.error) return answer;
      const rows = answer.data as Row[];
      if (rows.length > 1) return failure('PGRST116', 'more than one row');
      return { data: rows[0] ?? null, error: null };
    }

    then<A = FakeAnswer, B = never>(
      onFulfilled?: ((value: FakeAnswer) => A | PromiseLike<A>) | null,
      onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
    ): PromiseLike<A | B> {
      return this.run().then(onFulfilled, onRejected);
    }

    private matching(): Row[] {
      const all = tables[this.table];
      let rows = all.filter((row) => this.filters.every((filter) => filter(row)));
      if (this.orders.length > 0) {
        const index = new Map(all.map((row, i) => [row, i] as const));
        rows = [...rows].sort((x, y) => {
          for (const { column, ascending } of this.orders) {
            const c = compare(get(x, column), get(y, column));
            if (c !== 0) return ascending ? c : -c;
          }
          const ascending = this.orders[0]!.ascending;
          return ascending ? index.get(x)! - index.get(y)! : index.get(y)! - index.get(x)!;
        });
      }
      return this.max === null ? rows : rows.slice(0, this.max);
    }

    private async run(): Promise<FakeAnswer> {
      if (this.fail === 'error') return failure('XX000', 'fake_db_failure');
      try {
        if (this.mode === 'select') {
          const rows = this.matching();
          if (this.counting && this.head) return { data: null, error: null, count: rows.length };
          return { data: rows.map((row) => project(row, this.columns)), error: null, count: this.counting ? rows.length : null };
        }
        const outcome = transaction(() => {
          const rows = this.matching();
          if (this.mode === 'update') {
            for (const row of rows) Object.assign(row, clone(this.patch));
          } else {
            const victims = new Set(rows);
            tables[this.table] = tables[this.table].filter((row) => !victims.has(row)) as Row[];
          }
          return rows.map((row) => project(row, this.returning ?? '*'));
        });
        if (!outcome.ok) return failure(outcome.error.code, outcome.error.detail);
        return { data: this.returning === null ? null : outcome.value, error: null };
      } catch (error) {
        if (error instanceof SqlError) return failure(error.code, error.detail);
        throw error;
      }
    }
  }

  const client = {
    from(table: string) {
      calls.push({ kind: 'from', name: table });
      if (!(table in tables)) throw new Error(`fake db: unknown table ${table}`);
      return new FakeQuery(table as keyof FakeTables, takeFailure(table));
    },
    rpc,
  };

  // ── Seeding and the page's half ───────────────────────────────────────────

  const BOOKING_DEFAULTS = (): Row => ({
    id: newId(),
    ashby_interview_event_id: newId(),
    ashby_schedule_id: '7f000000-0000-4000-8000-0000000000b1',
    ashby_application_id: '7f000000-0000-4000-8000-0000000000b2',
    ashby_interview_stage_id: null,
    ashby_interview_id: null,
    ashby_scheduled_by_user_id: '7f000000-0000-4000-8000-0000000000b5',
    ashby_updated_at: null,
    candidate_id: null,
    round_id: null,
    objective_profile: 'r1_dex_sales',
    status: 'pending',
    reason: 'eligible',
    version: 0,
    key_attempt: 0,
    meet_url: 'https://meet.google.com/abc-defg-hij',
    start_at: iso(clock() + DAY),
    end_at: iso(clock() + DAY + 45 * MINUTE),
    recall_bot_id: null,
    ticket_digest: null,
    ticket_not_before: null,
    ticket_expires_at: null,
    ticket_claimed_at: null,
    ticket_arms: 0,
    session_id: null,
    created_at: iso(clock()),
    updated_at: iso(clock()),
  });

  const commit = (work: () => void): void => {
    const outcome = transaction(work);
    if (!outcome.ok) throw new Error(`fake db: ${outcome.error.code} ${outcome.error.detail}`);
  };

  const fake: R1MeetFakeDb = {
    client: client as unknown as typeof supabase,
    store: createR1MeetStore(client as unknown as typeof supabase),
    get tables() {
      return tables;
    },
    users,
    settings,
    calls,
    failNext(target, mode = 'error') {
      const queue = pending.get(target) ?? [];
      queue.push(mode);
      pending.set(target, queue);
    },
    booking(id) {
      return findBooking(id);
    },
    seedBooking(row) {
      const booking: Row = { ...BOOKING_DEFAULTS(), ...row };
      for (const key of ['start_at', 'end_at', 'ashby_updated_at', 'ticket_not_before', 'ticket_expires_at', 'ticket_claimed_at', 'created_at', 'updated_at']) {
        booking[key] = ts(booking[key]);
      }
      if (booking.round_id !== null && booking.candidate_id === null) {
        booking.candidate_id = findRound(booking.round_id)?.candidate_id ?? null;
      }
      commit(() => {
        tables.r1_meet_bookings.push(booking);
      });
      return findBooking(booking.id)!;
    },
    addRound(row = {}) {
      const round: Row = {
        id: newId(),
        candidate_id: newId(),
        kind: 'sales_r1',
        channel: 'meet',
        status: 'invited',
        expires_at: iso(clock() + 3 * DAY),
        starts_used: 0,
        attempts_counted: 0,
        attempts_allowed: 3,
        version: 1,
        created_by: null,
        updated_at: iso(clock()),
        ...row,
      };
      round.expires_at = ts(round.expires_at);
      tables.interview_rounds.push(round);
      return round;
    },
    addSession(row) {
      const round = findRound(row.interview_round_id);
      const session: Row = {
        id: newId(),
        candidate_id: round?.candidate_id ?? null,
        status: 'created',
        mode: 'browser',
        ...row,
      };
      tables.call_sessions.push(session);
      return session;
    },
    addAttempt(row) {
      const attempt: Row = { attempt_number: 1, outcome: null, counted: false, created_at: iso(clock()), ...row };
      tables.interview_round_attempts.push(attempt);
      return attempt;
    },
    linkApplication(applicationId, candidateId, terminalState = null) {
      const link: Row = {
        provider: 'ashby',
        external_application_id: applicationId,
        candidate_id: candidateId,
        terminal_state: terminalState,
      };
      tables.ashby_application_links.push(link);
      return link;
    },
    enqueue(spec, opts = {}) {
      const scheduledAt = opts.scheduledAt === undefined ? iso(clock()) : ts(opts.scheduledAt)!;
      let row: Row | null = null;
      commit(() => {
        row = insertJob({ ...spec.payload }, spec.dedupKey ?? null, spec.maxAttempts ?? 3, scheduledAt);
      });
      return row!;
    },
    jobs(kind) {
      return tables.job_queue.filter((j) => j.name === 'r1-meet' && (kind === undefined || j.payload?.kind === kind));
    },
    deleteBooking(id) {
      commit(() => {
        const booking = findBooking(id);
        if (!booking) return;
        tables.r1_meet_bookings = tables.r1_meet_bookings.filter((b) => b !== booking);
        for (const receipt of tables.r1_meet_receipts) if (receipt.booking_id === booking.id) receipt.booking_id = null;
        if (booking.recall_bot_id !== null) {
          insertJob(
            { kind: 'bot_release', recall_bot_id: booking.recall_bot_id, booking_id: booking.id },
            `r1-meet:bot-release:${booking.recall_bot_id}`,
            10,
            iso(clock()),
          );
        }
      });
    },
    cancelRound(roundId) {
      commit(() => {
        const round = findRound(roundId);
        if (!round || round.status === 'cancelled') return;
        round.status = 'cancelled';
        if (round.channel !== 'meet') return;
        for (const booking of tables.r1_meet_bookings) {
          if (booking.round_id !== round.id || TERMINAL.includes(booking.status)) continue;
          insertJob(
            { kind: 'round_cancelled', booking_id: booking.id, round_id: round.id },
            `r1-meet:round-cancelled:${booking.id}`,
            10,
            iso(clock()),
          );
        }
      });
    },
    async claimTicket(ticket, nowIso, source) {
      const digest = r1MeetTicketDigest(ticket, source);
      return rpc('r1_meet_claim_ticket', { p_ticket_digest: digest, p_now: nowIso });
    },
    async bind(bookingId, sessionId, nowIso) {
      return rpc('r1_meet_bind_session', { p_booking_id: bookingId, p_session_id: sessionId, p_now: nowIso });
    },
  };
  return fake;
}
