/**
 * M034 S09 T4: the scorecard-ready trigger and the maintenance re-drive of Dex's Ashby feedback
 * (lib/r1/meet/feedback-notify.ts), against stub ports (call counting) and the in-memory 0142 port with
 * the REAL feedback store (the receipt and its job in one RPC).
 *
 * Pinned (D-S09-8, D-S09-9):
 *  - flag off inert: R1 off, Meet disabled, Meet invalid and the feedback setting off each make ZERO
 *    reads and ZERO RPCs, even for a valid result; so do a superseded attach and malformed ids;
 *  - a browser round: Meet active and no booking for the session = exactly ONE read and NO RPC;
 *  - payload ids only: the one RPC records exactly `{ kind, booking_id, assessment_id }` under the
 *    `ashby-schedule:feedback:<b>:<a>` key, and the job it queues is posted end to end;
 *  - an `invalid` setting still records (the job alerts and fails it per interview);
 *  - it never rejects: a throwing store, a refused RPC, a throwing config or a throwing logger give at
 *    most one closed warning and no id;
 *  - the re-drive: inert without ports or with the setting off; looks at up to 100 completed bookings
 *    in [now - 26 h, now - 20 min] and records only the missing receipts, at most 10 a pass, so a
 *    booking that already has its receipt never hides a lost trigger behind it (S09-R1); skips a round
 *    without an assessment; a failure is one warning and the maintenance job's result is unchanged.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ID_BATCH_SIZE } from '../lib/id-batches.js';
import { getR1MeetConfig, type R1MeetConfig, type R1MeetFeedbackConfig } from '../lib/r1/meet/config.js';
import {
  R1_MEET_FEEDBACK_REDRIVE,
  notifyR1MeetScorecardReady,
  redriveR1MeetFeedback,
  type R1MeetScorecardNotifyDeps,
} from '../lib/r1/meet/feedback-notify.js';
import { r1MeetFeedbackReceiptKey, type R1MeetFeedbackStore } from '../lib/r1/meet/feedback-store.js';
import { R1MeetJobError, parseMaintenanceJob } from '../lib/r1/meet/jobs.js';
import { r1MeetMaintenanceDefinition } from '../lib/r1/meet/maintenance.js';
import type { R1MeetFlowDeps, R1MeetLog } from '../lib/r1/meet/recall-actions.js';
import type { R1MeetReceiptAnswer } from '../lib/r1/meet/receipts.js';
import type { R1MeetBooking } from '../lib/r1/meet/runtime-store.js';
import { createR1MeetFakeDb } from './support/r1-meet-fake-db.js';
import {
  FEEDBACK_FORM_ID,
  createR1MeetFeedbackWorld,
  type CompletedBooking,
  type R1MeetFeedbackWorld,
} from './support/r1-meet-feedback-fake.js';
import { STAFF_USER_ID, WEB_ORIGIN_FIXTURE, type LogLine } from './support/r1-meet-harness.js';
import { FAKE_RECALL_API_KEY } from './support/recall-fake.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const iso = (ms: number): string => new Date(ms).toISOString();

const R1_ON = { enabled: true };
const R1_OFF = { enabled: false };
const MEET_OFF: R1MeetConfig = { enabled: false, status: 'disabled' };
const MEET_INVALID: R1MeetConfig = { enabled: false, status: 'invalid', reason: 'R1_MEET_ENABLED must be either "true" or "false"' };
/** An enabled Meet config: the webhook secret is built at run time, never a secret-shaped literal. */
const MEET_ON = getR1MeetConfig({
  R1_MEET_ENABLED: 'true',
  RECALL_API_KEY: FAKE_RECALL_API_KEY,
  RECALL_WEBHOOK_SECRET: 'whsec' + '_' + Buffer.alloc(32, 7).toString('base64'),
  R1_MEET_ASHBY_DEX_USER_ID: '7f000000-0000-4000-8000-0000000000d1',
  R1_MEET_SERVICE_USER_ID: STAFF_USER_ID,
  WEB_ORIGIN: WEB_ORIGIN_FIXTURE,
});
const FEEDBACK_ON: R1MeetFeedbackConfig = { status: 'on', formDefinitionId: FEEDBACK_FORM_ID };
const FEEDBACK_OFF: R1MeetFeedbackConfig = { status: 'off' };
const FEEDBACK_INVALID: R1MeetFeedbackConfig = { status: 'invalid', reason: 'R1_MEET_ASHBY_FEEDBACK_FORM_ID must be a UUID' };

const SESSION_ID = '7f000000-0000-4000-8000-00000000e001';
const ASSESSMENT_ID = '7f000000-0000-4000-8000-00000000e002';
const BOOKING_ID = '7f000000-0000-4000-8000-00000000e003';
const NOW_MS = Date.parse('2030-01-01T10:00:00.000Z');
const OK_RESULT = Object.freeze({ sessionId: SESSION_ID, assessmentId: ASSESSMENT_ID, attach: 'ok' });

const INSERTED: R1MeetReceiptAnswer = Object.freeze({
  status: 'inserted',
  id: '7f000000-0000-4000-8000-00000000e004',
  outcome: 'enqueued',
  enqueued: true,
  workPending: true,
  bookingLinked: true,
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// ── Stub ports: every call counted ──────────────────────────────────────────

interface Stubs {
  readonly deps: R1MeetScorecardNotifyDeps;
  readonly getBookingBySession: ReturnType<typeof vi.fn>;
  readonly recordFeedback: ReturnType<typeof vi.fn>;
  readonly from: ReturnType<typeof vi.fn>;
  readonly rpc: ReturnType<typeof vi.fn>;
  readonly logs: LogLine[];
}

function capture(logs: LogLine[]): R1MeetLog {
  return {
    info: (meta) => logs.push({ level: 'info', meta }),
    warn: (meta) => logs.push({ level: 'warn', meta }),
    error: (meta) => logs.push({ level: 'error', meta }),
  };
}

function stubs(over: Partial<R1MeetScorecardNotifyDeps> = {}, booking: Partial<R1MeetBooking> | null = { id: BOOKING_ID }): Stubs {
  const logs: LogLine[] = [];
  const getBookingBySession = vi.fn(async () => (booking === null ? null : (booking as R1MeetBooking)));
  const recordFeedback = vi.fn(async () => INSERTED);
  // The client: touched only if a production store were built (no seam). It must never be.
  const from = vi.fn(() => {
    throw new Error('stub client: from');
  });
  const rpc = vi.fn(() => {
    throw new Error('stub client: rpc');
  });
  const deps: R1MeetScorecardNotifyDeps = {
    client: { from, rpc } as never,
    r1Config: () => R1_ON,
    meetConfig: () => MEET_ON,
    feedbackConfig: () => FEEDBACK_ON,
    store: { getBookingBySession },
    feedbackStore: { recordFeedback } as Pick<R1MeetFeedbackStore, 'recordFeedback'>,
    now: () => NOW_MS,
    log: capture(logs),
    ...over,
  };
  return { deps, getBookingBySession, recordFeedback, from, rpc, logs };
}

const noCalls = (s: Stubs): void => {
  expect(s.getBookingBySession).not.toHaveBeenCalled();
  expect(s.recordFeedback).not.toHaveBeenCalled();
  expect(s.from).not.toHaveBeenCalled();
  expect(s.rpc).not.toHaveBeenCalled();
};

/** No line names an id, a key or a URL. */
function expectClosedLines(logs: readonly LogLine[], ids: readonly string[] = []): void {
  const text = JSON.stringify(logs);
  for (const value of [SESSION_ID, ASSESSMENT_ID, BOOKING_ID, ...ids, 'ashby-schedule', '://']) expect(text).not.toContain(value);
}

// ── The trigger ─────────────────────────────────────────────────────────────

describe('notifyR1MeetScorecardReady: flag off is inert', () => {
  it.each([
    ['R1 off', { r1Config: () => R1_OFF }],
    ['Meet disabled', { meetConfig: () => MEET_OFF }],
    ['Meet invalid', { meetConfig: () => MEET_INVALID }],
    ['feedback off', { feedbackConfig: () => FEEDBACK_OFF }],
  ] as Array<[string, Partial<R1MeetScorecardNotifyDeps>]>)('%s: zero reads and zero RPCs for a valid result', async (_name, over) => {
    const s = stubs(over);
    await expect(notifyR1MeetScorecardReady(OK_RESULT, s.deps)).resolves.toBeUndefined();
    noCalls(s);
    expect(s.logs).toEqual([]);
  });

  it.each([
    ['R1 off', { r1Config: () => R1_OFF }],
    ['Meet disabled', { meetConfig: () => MEET_OFF }],
    ['Meet invalid', { meetConfig: () => MEET_INVALID }],
    ['feedback off', { feedbackConfig: () => FEEDBACK_OFF }],
  ] as Array<[string, Partial<R1MeetScorecardNotifyDeps>]>)(
    '%s with the PRODUCTION stores (no store seams): the client is never touched',
    async (_name, over) => {
      const s = stubs(over);
      const { store: _store, feedbackStore: _feedbackStore, ...rest } = s.deps;
      await notifyR1MeetScorecardReady(OK_RESULT, rest);
      expect(s.from).not.toHaveBeenCalled();
      expect(s.rpc).not.toHaveBeenCalled();
    },
  );

  it('the shipped defaults (no Meet variable, no seam): nothing is read', async () => {
    vi.stubEnv('R1_MEET_ENABLED', '');
    vi.stubEnv('R1_MEET_ASHBY_FEEDBACK_FORM_ID', '');
    const s = stubs();
    await notifyR1MeetScorecardReady(OK_RESULT, { client: s.deps.client, log: s.deps.log });
    expect(s.from).not.toHaveBeenCalled();
    expect(s.rpc).not.toHaveBeenCalled();
    expect(s.logs).toEqual([]);
  });
});

describe('notifyR1MeetScorecardReady: only the current assessment, ids only', () => {
  it.each([
    ['a superseded attach', { ...OK_RESULT, attach: 'superseded_by_newer' }],
    ['an unknown attach', { ...OK_RESULT, attach: 'unknown' }],
    ['a non-UUID session', { ...OK_RESULT, sessionId: 'not-a-uuid' }],
    ['a non-UUID assessment', { ...OK_RESULT, assessmentId: 'assessments-1' }],
    ['a number session', { ...OK_RESULT, sessionId: 7 }],
    ['a null assessment', { ...OK_RESULT, assessmentId: null }],
    ['a null result', null],
  ])('%s: zero calls', async (_name, result) => {
    const s = stubs();
    await expect(notifyR1MeetScorecardReady(result as never, s.deps)).resolves.toBeUndefined();
    noCalls(s);
    expect(s.logs).toEqual([]);
  });

  it('a browser round (Meet active, no booking for the session): exactly ONE read and NO RPC', async () => {
    const db = createR1MeetFakeDb();
    await notifyR1MeetScorecardReady(OK_RESULT, {
      client: db.client,
      r1Config: () => R1_ON,
      meetConfig: () => MEET_ON,
      feedbackConfig: () => FEEDBACK_ON,
      now: () => NOW_MS,
      log: capture([]),
    });
    expect(db.calls).toEqual([{ kind: 'from', name: 'r1_meet_bookings' }]);
    expect(db.tables.job_queue).toEqual([]);
    expect(db.tables.r1_meet_receipts).toEqual([]);
  });

  it('a Meet booking: one read, then one record with the lower-cased ids', async () => {
    const s = stubs();
    await notifyR1MeetScorecardReady(
      { sessionId: SESSION_ID.toUpperCase(), assessmentId: ASSESSMENT_ID.toUpperCase(), attach: 'ok' },
      s.deps,
    );
    expect(s.getBookingBySession.mock.calls).toEqual([[SESSION_ID]]);
    expect(s.recordFeedback.mock.calls).toEqual([[BOOKING_ID, ASSESSMENT_ID, NOW_MS]]);
    expect(s.logs).toEqual([]);
  });

  it('an invalid feedback setting still records (the job alerts and fails it per interview)', async () => {
    const s = stubs({ feedbackConfig: () => FEEDBACK_INVALID });
    await notifyR1MeetScorecardReady(OK_RESULT, s.deps);
    expect(s.getBookingBySession).toHaveBeenCalledTimes(1);
    expect(s.recordFeedback).toHaveBeenCalledTimes(1);
  });
});

describe('notifyR1MeetScorecardReady: payload ids only, through the real store and the 0142 port', () => {
  async function trigger(w: R1MeetFeedbackWorld, b: CompletedBooking): Promise<void> {
    await notifyR1MeetScorecardReady(
      { sessionId: b.sessionId, assessmentId: b.assessmentId, attach: 'ok' },
      {
        client: w.h.db.client,
        r1Config: () => R1_ON,
        meetConfig: () => MEET_ON,
        feedbackConfig: () => FEEDBACK_ON,
        now: () => w.h.now(),
        log: w.h.deps.log,
      },
    );
  }

  it('records ONE receipt and job with exactly the three ids, and the job posts the card', async () => {
    const w = createR1MeetFeedbackWorld();
    const b = await w.completedBooking({ record: false });
    const before = w.h.db.calls.length;
    await trigger(w, b);

    const calls = w.h.db.calls.slice(before);
    expect(calls.map((call) => `${call.kind}:${call.name}`)).toEqual(['from:r1_meet_bookings', 'rpc:r1_meet_record_receipt']);
    const args = calls[1]!.args!;
    expect(args).toStrictEqual({
      p_source: 'ashby',
      p_dedupe_key: `ashby-schedule:feedback:${b.bookingId}:${b.assessmentId}`,
      p_event_type: 'scorecard_feedback',
      p_booking_id: b.bookingId,
      p_enqueue: true,
      p_payload: { kind: 'scorecard_feedback', booking_id: b.bookingId, assessment_id: b.assessmentId },
      p_now: iso(w.h.now()),
    });
    // The receipt request as the port sends it: nothing but the source, key, type, booking and ids.
    expect({
      source: args.p_source,
      dedupeKey: args.p_dedupe_key,
      eventType: args.p_event_type,
      bookingId: args.p_booking_id,
      payload: args.p_payload,
    }).toStrictEqual({
      source: 'ashby',
      dedupeKey: r1MeetFeedbackReceiptKey(b.bookingId, b.assessmentId),
      eventType: 'scorecard_feedback',
      bookingId: b.bookingId,
      payload: { kind: 'scorecard_feedback', booking_id: b.bookingId, assessment_id: b.assessmentId },
    });

    const jobs = w.h.db.jobs('scorecard_feedback');
    expect(jobs).toHaveLength(1);
    const receipt = w.receiptRow(b.key)!;
    expect(receipt).toMatchObject({ source: 'ashby', event_type: 'scorecard_feedback', booking_id: b.bookingId, outcome: 'enqueued' });
    expect(jobs[0]!.payload).toStrictEqual({
      kind: 'scorecard_feedback',
      booking_id: b.bookingId,
      assessment_id: b.assessmentId,
      receipt_id: receipt.id,
      source: 'ashby',
    });

    // The queued job is the one the handler posts: one submit, the receipt processed.
    await w.dispatcher.handle(w.queueJob(jobs[0]!.payload));
    expect(w.ashby.submits()).toHaveLength(1);
    expect(w.receiptRow(b.key)!.outcome).toBe('processed');
    expectClosedLines(w.h.logs, [b.bookingId, b.assessmentId, b.sessionId, b.roundId]);
  });

  it('a second trigger for the same pair is a duplicate: still one receipt and one job', async () => {
    const w = createR1MeetFeedbackWorld();
    const b = await w.completedBooking({ record: false });
    await trigger(w, b);
    await trigger(w, b);
    expect(w.h.db.jobs('scorecard_feedback')).toHaveLength(1);
    expect(w.h.db.tables.r1_meet_receipts.filter((row) => row.dedupe_key === b.key)).toHaveLength(1);
    expect(w.h.logs).toEqual([]);
  });
});

describe('notifyR1MeetScorecardReady: never rejects, one closed warning', () => {
  const WARN = { level: 'warn', meta: { error_category: 'r1_meet_feedback_enqueue_failed' } };

  it('a throwing booking read', async () => {
    const s = stubs();
    s.getBookingBySession.mockRejectedValueOnce(new R1MeetJobError('r1_meet_db_error'));
    await expect(notifyR1MeetScorecardReady(OK_RESULT, s.deps)).resolves.toBeUndefined();
    expect(s.recordFeedback).not.toHaveBeenCalled();
    expect(s.logs).toEqual([WARN]);
  });

  it('a throwing record', async () => {
    const s = stubs();
    s.recordFeedback.mockRejectedValueOnce(new R1MeetJobError('r1_meet_db_error'));
    await expect(notifyR1MeetScorecardReady(OK_RESULT, s.deps)).resolves.toBeUndefined();
    expect(s.logs).toEqual([WARN]);
  });

  it('a refused RPC: the warning carries the closed refusal word', async () => {
    const s = stubs();
    s.recordFeedback.mockResolvedValueOnce({ status: 'refused', reason: 'invalid_payload' });
    await expect(notifyR1MeetScorecardReady(OK_RESULT, s.deps)).resolves.toBeUndefined();
    expect(s.logs).toEqual([{ level: 'warn', meta: { error_category: 'r1_meet_feedback_enqueue_failed', error_type: 'invalid_payload' } }]);
  });

  it('a throwing config read', async () => {
    const s = stubs({
      feedbackConfig: () => {
        throw new Error('boom');
      },
    });
    await expect(notifyR1MeetScorecardReady(OK_RESULT, s.deps)).resolves.toBeUndefined();
    noCalls(s);
    expect(s.logs).toEqual([WARN]);
  });

  it('a throwing logger on top of a throwing store is swallowed', async () => {
    const throwing: R1MeetLog = {
      info: () => {
        throw new Error('log');
      },
      warn: () => {
        throw new Error('log');
      },
      error: () => {
        throw new Error('log');
      },
    };
    const s = stubs({ log: throwing });
    s.getBookingBySession.mockRejectedValueOnce(new Error('db'));
    await expect(notifyR1MeetScorecardReady(OK_RESULT, s.deps)).resolves.toBeUndefined();
    const refused = stubs({ log: throwing });
    refused.recordFeedback.mockResolvedValueOnce({ status: 'refused', reason: 'invalid_request' });
    await expect(notifyR1MeetScorecardReady(OK_RESULT, refused.deps)).resolves.toBeUndefined();
  });

  it('no line ever names an id', async () => {
    const s = stubs();
    s.recordFeedback.mockRejectedValueOnce(new Error(`failed for ${BOOKING_ID}`));
    await notifyR1MeetScorecardReady(OK_RESULT, s.deps);
    expect(s.logs).toHaveLength(1);
    expectClosedLines(s.logs);
  });
});

// ── The re-drive ────────────────────────────────────────────────────────────

describe('redriveR1MeetFeedback', () => {
  const recordCalls = (w: R1MeetFeedbackWorld) =>
    w.h.db.calls.filter((call) => call.kind === 'rpc' && call.name === 'r1_meet_record_receipt');

  it('the window is frozen: 26 hours back, 20 minutes settle, 100 bookings looked at, 10 records a pass', () => {
    expect(R1_MEET_FEEDBACK_REDRIVE).toEqual({ lookbackMs: 26 * HOUR, settleMs: 20 * MINUTE, scanLimit: 100, recordLimit: 10 });
    expect(Object.isFrozen(R1_MEET_FEEDBACK_REDRIVE)).toBe(true);
    // One read of bookings, and their rounds in ONE `.in` batch.
    expect(R1_MEET_FEEDBACK_REDRIVE.scanLimit).toBe(ID_BATCH_SIZE);
  });

  it('without the feedback ports, or with the setting off: null and no read at all', async () => {
    const w = createR1MeetFeedbackWorld();
    await w.completedBooking({ record: false });
    const before = w.h.db.calls.length;
    await expect(redriveR1MeetFeedback(w.h.deps)).resolves.toBeNull();
    w.setConfig({ status: 'off' });
    await expect(redriveR1MeetFeedback(w.deps)).resolves.toBeNull();
    expect(w.h.db.calls.slice(before)).toEqual([]);
    expect(w.h.logs).toEqual([]);
  });

  it('records only the missing receipt: one booking already has one, the other is re-driven', async () => {
    const w = createR1MeetFeedbackWorld();
    const recorded = await w.completedBooking();
    const lost = await w.completedBooking({ record: false });
    const before = recordCalls(w).length;
    await expect(redriveR1MeetFeedback(w.deps)).resolves.toEqual({ queued: 1 });
    const calls = recordCalls(w).slice(before);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args!.p_payload).toStrictEqual({
      kind: 'scorecard_feedback',
      booking_id: lost.bookingId,
      assessment_id: lost.assessmentId,
    });
    expect(w.h.db.jobs('scorecard_feedback').map((job) => job.payload.booking_id).sort()).toEqual(
      [recorded.bookingId, lost.bookingId].sort(),
    );
    expect(w.h.logs).toEqual([{ level: 'info', meta: { error_category: 'r1_meet_feedback_redriven', error_type: 'queued_1' } }]);
    expectClosedLines(w.h.logs, [recorded.bookingId, lost.bookingId, lost.assessmentId]);

    // The next bucket finds nothing missing: nothing recorded, no line.
    w.h.logs.length = 0;
    await expect(redriveR1MeetFeedback(w.deps)).resolves.toEqual({ queued: 0 });
    expect(recordCalls(w).slice(before)).toHaveLength(1);
    expect(w.h.logs).toEqual([]);
  });

  it('an invalid setting still re-drives (the job alerts per interview)', async () => {
    const w = createR1MeetFeedbackWorld();
    await w.completedBooking({ record: false });
    w.setConfig(FEEDBACK_INVALID);
    await expect(redriveR1MeetFeedback(w.deps)).resolves.toEqual({ queued: 1 });
  });

  it('skips a round with no assessment, and a booking outside the window', async () => {
    const w = createR1MeetFeedbackWorld();
    const unscored = await w.completedBooking({ record: false });
    w.h.db.tables.interview_rounds.find((round) => round.id === unscored.roundId)!.assessment_id = null;
    const now = w.h.now();
    await w.completedBooking({ record: false, startAt: iso(now - 27 * HOUR) });
    await w.completedBooking({ record: false, startAt: iso(now - 10 * MINUTE) });
    const before = recordCalls(w).length;
    await expect(redriveR1MeetFeedback(w.deps)).resolves.toEqual({ queued: 0 });
    expect(recordCalls(w).slice(before)).toEqual([]);
    expect(w.h.logs).toEqual([]);
  });

  it('the window bounds and the limit reach the query; an idle bucket is ONE read', async () => {
    const w = createR1MeetFeedbackWorld();
    const listRecentCompleted = vi.fn(async () => []);
    const roundAssessmentIds = vi.fn();
    const deps: R1MeetFlowDeps = { ...w.deps, feedback: { ...w.feedback, store: { ...w.store, listRecentCompleted, roundAssessmentIds } } };
    await expect(redriveR1MeetFeedback(deps)).resolves.toEqual({ queued: 0 });
    const now = w.h.now();
    expect(listRecentCompleted.mock.calls).toEqual([[{ startAfter: iso(now - 26 * HOUR), startBefore: iso(now - 20 * MINUTE), limit: 100 }]]);
    expect(roundAssessmentIds).not.toHaveBeenCalled();
  });

  it('the real query: the window edges (start >= now - 26 h, start < now - 20 min), completed only', async () => {
    const w = createR1MeetFeedbackWorld();
    const now = w.h.now();
    const oldestIn = await w.completedBooking({ record: false, startAt: iso(now - 26 * HOUR) });
    const newestIn = await w.completedBooking({ record: false, startAt: iso(now - 20 * MINUTE - 1) });
    const tooOld = await w.completedBooking({ record: false, startAt: iso(now - 26 * HOUR - 1) });
    const tooNew = await w.completedBooking({ record: false, startAt: iso(now - 20 * MINUTE) });
    // A failed booking in the window: never looked at.
    w.h.db.seedBooking({ status: 'failed', reason: 'no_show', start_at: iso(now - 2 * HOUR), end_at: iso(now - HOUR) });
    await expect(redriveR1MeetFeedback(w.deps)).resolves.toEqual({ queued: 2 });
    const queuedFor = w.h.db.jobs('scorecard_feedback').map((job) => job.payload.booking_id).sort();
    expect(queuedFor).toEqual([oldestIn.bookingId, newestIn.bookingId].sort());
    expect(queuedFor).not.toContain(tooOld.bookingId);
    expect(queuedFor).not.toContain(tooNew.bookingId);
  });

  it('the real query: at most 10 records a pass, newest slot first; the rest at the next bucket', async () => {
    const w = createR1MeetFeedbackWorld();
    const now = w.h.now();
    const bookings: CompletedBooking[] = [];
    for (let i = 0; i < 12; i += 1) bookings.push(await w.completedBooking({ record: false, startAt: iso(now - HOUR - i * MINUTE) }));
    await expect(redriveR1MeetFeedback(w.deps)).resolves.toEqual({ queued: 10 });
    const first = w.h.db.jobs('scorecard_feedback').map((job) => job.payload.booking_id).sort();
    expect(first).toEqual(bookings.slice(0, 10).map((b) => b.bookingId).sort());
    // The ten that now have their receipt take no slot: the next bucket records the two oldest.
    await expect(redriveR1MeetFeedback(w.deps)).resolves.toEqual({ queued: 2 });
    expect(w.h.db.jobs('scorecard_feedback').map((job) => job.payload.booking_id).sort()).toEqual(
      bookings.map((b) => b.bookingId).sort(),
    );
    await expect(redriveR1MeetFeedback(w.deps)).resolves.toEqual({ queued: 0 });
    expect(w.h.db.jobs('scorecard_feedback')).toHaveLength(12);
  });

  it('a lost trigger behind more than ten newer bookings that have their receipt is still found (S09-R1)', async () => {
    const w = createR1MeetFeedbackWorld();
    const now = w.h.now();
    // The lost one settled first; fourteen newer interviews (R1 runs up to 15 at once) got their receipt.
    const lost = await w.completedBooking({ record: false, startAt: iso(now - 3 * HOUR) });
    for (let i = 0; i < 14; i += 1) await w.completedBooking({ startAt: iso(now - HOUR - i * MINUTE) });
    const before = recordCalls(w).length;
    await expect(redriveR1MeetFeedback(w.deps)).resolves.toEqual({ queued: 1 });
    const calls = recordCalls(w).slice(before);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args!.p_payload).toStrictEqual({
      kind: 'scorecard_feedback',
      booking_id: lost.bookingId,
      assessment_id: lost.assessmentId,
    });
    expect(w.receiptRow(lost.key)).toMatchObject({ outcome: 'enqueued' });
    // Nothing more is missing: the next bucket records nothing.
    await expect(redriveR1MeetFeedback(w.deps)).resolves.toEqual({ queued: 0 });
    expect(recordCalls(w).slice(before)).toHaveLength(1);
  });

  it('a failing read: one warning, nothing recorded, never a throw', async () => {
    const w = createR1MeetFeedbackWorld();
    await w.completedBooking({ record: false });
    const before = recordCalls(w).length;
    w.h.db.failNext('r1_meet_receipts');
    await expect(redriveR1MeetFeedback(w.deps)).resolves.toEqual({ queued: 0 });
    expect(recordCalls(w).slice(before)).toEqual([]);
    expect(w.h.logs).toEqual([{ level: 'warn', meta: { error_category: 'r1_meet_feedback_redrive_failed' } }]);
  });

  it('one refused or failing record does not stop the others; one warning', async () => {
    const w = createR1MeetFeedbackWorld();
    const first = await w.completedBooking({ record: false });
    const second = await w.completedBooking({ record: false });
    const third = await w.completedBooking({ record: false });
    let call = 0;
    const recordFeedback = vi.fn(async (bookingId: string, assessmentId: string, nowMs: number) => {
      call += 1;
      if (call === 1) return { status: 'refused', reason: 'invalid_payload' } as const;
      if (call === 2) throw new R1MeetJobError('r1_meet_db_error');
      return w.store.recordFeedback(bookingId, assessmentId, nowMs);
    });
    const deps: R1MeetFlowDeps = { ...w.deps, feedback: { ...w.feedback, store: { ...w.store, recordFeedback } } };
    await expect(redriveR1MeetFeedback(deps)).resolves.toEqual({ queued: 1 });
    expect(recordFeedback).toHaveBeenCalledTimes(3);
    expect(w.h.db.jobs('scorecard_feedback')).toHaveLength(1);
    expect(w.h.logs).toEqual([
      { level: 'warn', meta: { error_category: 'r1_meet_feedback_redrive_failed' } },
      { level: 'info', meta: { error_category: 'r1_meet_feedback_redriven', error_type: 'queued_1' } },
    ]);
    expectClosedLines(w.h.logs, [first.bookingId, second.bookingId, third.bookingId]);
  });

  it('a throwing logger is swallowed', async () => {
    const w = createR1MeetFeedbackWorld();
    await w.completedBooking({ record: false });
    const log: R1MeetLog = {
      info: () => {
        throw new Error('log');
      },
      warn: () => {
        throw new Error('log');
      },
      error: () => {
        throw new Error('log');
      },
    };
    await expect(redriveR1MeetFeedback({ ...w.deps, log })).resolves.toEqual({ queued: 1 });
    w.h.db.failNext('r1_meet_bookings');
    await expect(redriveR1MeetFeedback({ ...w.deps, log })).resolves.toEqual({ queued: 0 });
  });
});

describe('the maintenance job runs the re-drive after its steps, its result unchanged', () => {
  const job = parseMaintenanceJob({ kind: 'maintenance', bucket: 1 })!;

  it('a lost trigger is re-driven by maintenance; the job still answers processed `maintenance`', async () => {
    const w = createR1MeetFeedbackWorld();
    const lost = await w.completedBooking({ record: false });
    await expect(r1MeetMaintenanceDefinition.run(w.deps, job, w.h.meta())).resolves.toEqual({
      outcome: 'done',
      receipt: 'processed',
      code: 'maintenance',
    });
    expect(w.h.db.jobs('scorecard_feedback').map((row) => row.payload.booking_id)).toEqual([lost.bookingId]);
    expect(w.h.logs).toEqual([{ level: 'info', meta: { error_category: 'r1_meet_feedback_redriven', error_type: 'queued_1' } }]);
  });

  it('a failing re-drive is one warning, and the job result is unchanged', async () => {
    const w = createR1MeetFeedbackWorld();
    await w.completedBooking({ record: false });
    const listRecentCompleted = vi.fn(async () => {
      throw new R1MeetJobError('r1_meet_db_error');
    });
    const deps: R1MeetFlowDeps = { ...w.deps, feedback: { ...w.feedback, store: { ...w.store, listRecentCompleted } } };
    await expect(r1MeetMaintenanceDefinition.run(deps, job, w.h.meta())).resolves.toEqual({
      outcome: 'done',
      receipt: 'processed',
      code: 'maintenance',
    });
    expect(listRecentCompleted).toHaveBeenCalledTimes(1);
    expect(w.h.logs).toEqual([{ level: 'warn', meta: { error_category: 'r1_meet_feedback_redrive_failed' } }]);
    expect(w.h.db.jobs('scorecard_feedback')).toEqual([]);
  });

  it('without the feedback ports (the S06 harness) maintenance reads nothing more than before', async () => {
    const w = createR1MeetFeedbackWorld();
    await w.completedBooking({ record: false });
    const before = w.h.db.calls.length;
    await r1MeetMaintenanceDefinition.run(w.h.deps, job, w.h.meta());
    const tables = w.h.db.calls.slice(before).map((call) => call.name);
    // The S06 steps read bookings; the re-drive would add a receipts read and the RPC.
    expect(tables).not.toContain('r1_meet_receipts');
    expect(tables).not.toContain('interview_rounds');
    expect(tables).not.toContain('r1_meet_record_receipt');
    expect(w.h.db.jobs('scorecard_feedback')).toEqual([]);
  });
});
