/**
 * M034 S09 T3: the `scorecard_feedback` job (lib/r1/meet/feedback.ts) end to end: the REAL feedback
 * store over the in-memory 0142 port (receipt and job in one RPC, the receipt CHECKs and the
 * compare-and-sets), the REAL Ashby client and feedback port over a scripted Ashby transport, and the
 * REAL dispatcher. Nothing calls Ashby or Recall.
 *
 * The brief's list:
 *  1  the mapping end to end: one submit whose body is the exact card, the receipt `processed`, ids
 *     only in the queued payload;
 *  2  idempotent: a re-delivered job and a manual re-post without `receipt_id` make ONE submit in all;
 *  3  a lost answer (or a timeout), then success: two identical submits (Ashby updates Dex's one card)
 *     and the receipt `processed`;
 *  4  a permanent 4xx (400, 404, 422) or `success:false` is terminal with an alert, the receipt
 *     `failed`, and `ashby_rejected_after_retry` only when an earlier run may have reached the submit
 *     or the queue cannot tell (S09-R2: one earlier run that stopped before the submit, or waits for
 *     the booking alone, do not count; more than one earlier run otherwise does);
 *  5  429 and 5xx defer (60 s, 30 s) within the bound, then throw their closed codes;
 *  6  a missing mapping or setting (off, invalid, no key, every form fault) submits nothing;
 *  7  every off-path guard makes ZERO Ashby calls, a browser round included;
 *  8  a failed receipt is re-postable by hand, and a success moves it to `processed`;
 *  9  every log line is closed words, counts and a status: no id, path, URL, name or text.
 * 10  M035 S02, a public-page booking (no interview event): general feedback guarded by
 *     `applicationFeedback.list` before every submit (`[form, list, submit]`, the body without
 *     `interviewEventId`; Dex's card already there is `already_posted`; list failures defer or end
 *     terminal and never submit; a lost submit answer is found on the re-run), while an Ashby booking
 *     never lists and posts exactly as before.
 */

import { describe, expect, it } from 'vitest';
import { Queue } from '../lib/queue/index.js';
import { MemoryAdapter } from '../lib/queue/memory-adapter.js';
import { createQueueRunner } from '../lib/queue/runner.js';
import { getR1MeetFeedbackConfig } from '../lib/r1/meet/config.js';
import {
  R1_MEET_FEEDBACK_ALERTS,
  R1_MEET_FEEDBACK_ALREADY_POSTED_LOG,
  R1_MEET_FEEDBACK_ASHBY_INACTIVE_LOG,
  R1_MEET_FEEDBACK_DEFER,
  r1MeetFeedbackSubmitMayHaveRun,
  r1MeetScorecardFeedbackDefinition,
} from '../lib/r1/meet/feedback.js';
import {
  R1MeetJobError,
  R1_MEET_DEFER_MAX_COUNT,
  R1_MEET_DEFER_MAX_MS,
  R1_MEET_QUEUE,
  parseScorecardFeedbackJob,
  r1MeetDefer,
  r1MeetIgnored,
  r1MeetJobs,
  r1MeetProcessed,
  type R1MeetJobMeta,
  type R1MeetJobResult,
  type R1MeetScorecardFeedbackJob,
} from '../lib/r1/meet/jobs.js';
import {
  R1_MEET_INACTIVE,
  R1_MEET_INACTIVE_DEFER_SEC,
  createR1MeetDispatcher,
  type R1MeetDispatcher,
} from '../lib/r1/meet/dispatcher.js';
import type { R1MeetFlowDeps } from '../lib/r1/meet/recall-actions.js';
import { R1_MEET_LIVE_STATUSES, R1_MEET_TERMINAL_STATUSES } from '../lib/r1/meet/runtime-store.js';
import { FAKE_STATUS_REASONS } from './support/r1-meet-fake-db.js';
import {
  DEX_USER_ID,
  FEEDBACK_FORM_ID,
  SENTINELS,
  createR1MeetFeedbackWorld,
  dexFormDefinition,
  dexFormFields,
  type AshbyStep,
  type CompletedBooking,
  type R1MeetFeedbackWorld,
} from './support/r1-meet-feedback-fake.js';
import { HARNESS_NOW, WEB_ORIGIN_FIXTURE, fixtureId } from './support/r1-meet-harness.js';

const EVENT_ID = '7f000000-0000-4000-8000-000000000501';
const APPLICATION_ID = '7f000000-0000-4000-8000-000000000401';
const DAY_MS = 24 * 60 * 60 * 1000;

const EXPECTED_SUMMARY = [
  'Lexy (AI interviewer): R1 sales role-play over Google Meet. Verdict: Borderline. Weighted 2.65/4 across 4 of 5 metrics; 1 not scored (listed below).',
  'Negotiation & discount discipline — NOT SCORED (insufficient evidence): Rationale 3.',
  'Probing & discovery — 3/4: Rationale 0.',
  'Objection handling — 3/4: Rationale 1.',
  'Urgency & close — 2/4: Rationale 2.',
  'Communication & rapport — 3/4: Rationale 4.',
].join('\n');

/** The exact body Ashby receives for the default card, as one string (key order included). */
function expectedBody(booking: CompletedBooking): string {
  return JSON.stringify({
    applicationId: APPLICATION_ID,
    formDefinitionId: FEEDBACK_FORM_ID,
    feedbackForm: {
      fieldSubmissions: [
        { path: 'overall_recommendation', value: '3' },
        { path: 'summary_path', value: { type: 'PlainText', value: EXPECTED_SUMMARY } },
        { path: 'report_path', value: `${WEB_ORIGIN_FIXTURE}/interviews/${booking.roundId}` },
        { path: 'metric_path_0', value: { score: 3 } },
        { path: 'metric_path_1', value: { score: 3 } },
        { path: 'metric_path_2', value: { score: 2 } },
        { path: 'metric_path_4', value: { score: 3 } },
      ],
    },
    userId: DEX_USER_ID,
    interviewEventId: EVENT_ID,
  });
}

async function world(options: Parameters<R1MeetFeedbackWorld['completedBooking']>[0] = {}) {
  const w = createR1MeetFeedbackWorld();
  const b = await w.completedBooking({ eventId: EVENT_ID, applicationId: APPLICATION_ID, ...options });
  return { w, b };
}

function jobOf(b: Pick<CompletedBooking, 'bookingId' | 'assessmentId'>): R1MeetScorecardFeedbackJob {
  const job = parseScorecardFeedbackJob(r1MeetJobs.scorecardFeedback(b.bookingId, b.assessmentId).payload);
  if (job === null) throw new Error('fixture job refused');
  return job;
}

type MetaOver = Partial<
  Pick<R1MeetJobMeta, 'attempts' | 'maxAttempts' | 'deferCount' | 'deferredAt' | 'lastDeferReason' | 'lastError'>
>;

/** One run of the handler, as the dispatcher would make it (a first run unless `over` says otherwise). */
function run(w: R1MeetFeedbackWorld, b: Pick<CompletedBooking, 'bookingId' | 'assessmentId'>, over: MetaOver = {}, deps: R1MeetFlowDeps = w.deps): Promise<R1MeetJobResult> {
  return r1MeetScorecardFeedbackDefinition.run(deps, jobOf(b), w.h.meta({ maxAttempts: 5, ...over }));
}

/** A re-run after one deferral. */
const RERUN: MetaOver = { deferCount: 1, deferredAt: HARNESS_NOW };
/** Past the deferral bound. */
const EXHAUSTED: MetaOver = { deferCount: R1_MEET_DEFER_MAX_COUNT, deferredAt: HARNESS_NOW };

async function thrown(promise: Promise<unknown>): Promise<R1MeetJobError> {
  const error = await promise.then(
    (value) => {
      throw new Error(`expected a throw, got ${JSON.stringify(value)}`);
    },
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(R1MeetJobError);
  return error as R1MeetJobError;
}

const outcome = (w: R1MeetFeedbackWorld, b: CompletedBooking): unknown => w.receiptRow(b.key)?.outcome;
const errorLines = (w: R1MeetFeedbackWorld) => w.h.logs.filter((line) => line.level === 'error').map((line) => line.meta);
const jobLines = (w: R1MeetFeedbackWorld) =>
  w.h.logs.filter((line) => line.meta.error_category === 'r1_meet_job').map((line) => line.meta.error_type);

// ── 1. The mapping end to end ───────────────────────────────────────────────

describe('1. the mapping end to end', () => {
  it('the trigger queued ids only, and the job posts the exact card once and ends the receipt processed', async () => {
    const { w, b } = await world();
    const receipt = w.receiptRow(b.key)!;
    expect(receipt).toMatchObject({ source: 'ashby', event_type: 'scorecard_feedback', booking_id: b.bookingId, outcome: 'enqueued' });
    expect(b.job).toMatchObject({ dedup_key: `r1-meet:receipt:${receipt.id}`, max_attempts: 5, status: 'pending' });
    expect(b.job!.payload).toStrictEqual({
      kind: 'scorecard_feedback',
      booking_id: b.bookingId,
      assessment_id: b.assessmentId,
      receipt_id: receipt.id,
      source: 'ashby',
    });

    await expect(w.dispatcher.handle(w.queueJob(b.job!.payload))).resolves.toBeUndefined();

    expect(w.ashby.requests.map((request) => [request.op, request.path])).toEqual([
      ['form', '/feedbackFormDefinition.info'],
      ['submit', '/applicationFeedback.submit'],
    ]);
    expect(w.ashby.forms()[0]!.body).toStrictEqual({ feedbackFormDefinitionId: FEEDBACK_FORM_ID });
    expect(w.ashby.submits()[0]!.raw).toBe(expectedBody(b));
    expect(w.ashby.submits()[0]!.headers.authorization).toBe('<redacted>');
    expect(w.receiptRow(b.key)).toMatchObject({ outcome: 'processed', processed_at: HARNESS_NOW });
    expect(jobLines(w)).toEqual(['scorecard_feedback:submitted']);
    expect(w.h.logs.find((line) => line.meta.error_category === 'r1_meet_feedback_submitted')).toEqual({
      level: 'info',
      meta: { error_category: 'r1_meet_feedback_submitted', error_type: 'metrics_4_unbound_0' },
    });
    expect(errorLines(w)).toEqual([]);
  });

  it('the request carries no candidate identity, transcript, evidence quote or Meet URL', async () => {
    const { w, b } = await world();
    expect(await run(w, b)).toEqual(r1MeetProcessed('submitted'));
    const sent = w.ashby.requests.map((request) => request.raw).join('\n');
    for (const sentinel of Object.values(SENTINELS)) expect(sent).not.toContain(sentinel);
    expect(sent).not.toMatch(/meet\.google\.com|christy/i);
    expect(sent).not.toContain(b.candidateId);
    expect(sent).not.toContain(b.sessionId);
    expect(sent).not.toContain(b.assessmentId);
    expect(sent).not.toContain(b.bookingId);
  });

  it('a metric field on another scale is left out and counted', async () => {
    const { w, b } = await world();
    w.ashby.definition = dexFormDefinition({
      fields: dexFormFields().map((entry) =>
        entry.field.path === 'metric_path_1'
          ? { ...entry, field: { ...entry.field, selectableValues: ['1', '2', '3', '4', '5'].map((value) => ({ value, label: value })) } }
          : entry,
      ),
    });
    expect(await run(w, b)).toEqual(r1MeetProcessed('submitted'));
    const paths = (w.ashby.submits()[0]!.body as { feedbackForm: { fieldSubmissions: Array<{ path: string }> } })
      .feedbackForm.fieldSubmissions.map((submission) => submission.path);
    expect(paths).not.toContain('metric_path_1');
    expect(w.h.logs.find((line) => line.meta.error_category === 'r1_meet_feedback_submitted')!.meta.error_type).toBe('metrics_3_unbound_1');
  });
});

// ── 2. Idempotent retry ─────────────────────────────────────────────────────

describe('2. once per booking and assessment', () => {
  it('a re-delivered job, a manual re-post and a re-fired trigger make no second submit', async () => {
    const { w, b } = await world();
    await w.dispatcher.handle(w.queueJob(b.job!.payload));
    expect(w.ashby.submits()).toHaveLength(1);

    // The same job delivered again (a lease lost after the work was done).
    await expect(w.dispatcher.handle(w.queueJob(b.job!.payload, { attempts: 2 }))).resolves.toBeUndefined();
    // An operator's manual re-post: no receipt_id, found by its key.
    const manual = r1MeetJobs.scorecardFeedback(b.bookingId.toUpperCase(), b.assessmentId.toUpperCase());
    expect(manual.payload).toStrictEqual({ kind: 'scorecard_feedback', booking_id: b.bookingId.toUpperCase(), assessment_id: b.assessmentId.toUpperCase() });
    await expect(w.dispatcher.handle(w.queueJob(manual.payload))).resolves.toBeUndefined();
    expect(jobLines(w)).toEqual([
      'scorecard_feedback:submitted',
      'scorecard_feedback:already_submitted',
      'scorecard_feedback:already_submitted',
    ]);

    // The trigger fires again for the same assessment: the RPC sees a terminal receipt, queues nothing.
    const jobs = w.h.db.jobs('scorecard_feedback').length;
    expect(await w.store.recordFeedback(b.bookingId, b.assessmentId, w.h.now())).toMatchObject({
      status: 'duplicate',
      outcome: 'processed',
      enqueued: false,
    });
    expect(w.h.db.jobs('scorecard_feedback')).toHaveLength(jobs);

    expect(w.ashby.submits()).toHaveLength(1);
    expect(w.ashby.forms()).toHaveLength(1);
    expect(outcome(w, b)).toBe('processed');
  });

  it.each(['lost', 'timeout'] as const)('a %s answer, then success: two identical submits, one card in Ashby', async (step) => {
    const { w, b } = await world();
    w.ashby.next('submit', step);
    expect(await run(w, b)).toEqual(r1MeetDefer('ashby_unavailable', R1_MEET_FEEDBACK_DEFER.unavailable));
    expect(outcome(w, b)).toBe('enqueued');

    expect(await run(w, b, RERUN)).toEqual(r1MeetProcessed('submitted'));
    const submits = w.ashby.submits();
    expect(submits).toHaveLength(2);
    expect(submits[1]!.raw).toBe(submits[0]!.raw);
    expect(submits[0]!.raw).toBe(expectedBody(b));
    // Ashby keys Dex's submission by (interview event, user): every accepted submit is the same card.
    const cards = new Set(
      submits
        .filter((submit) => submit.accepted)
        .map((submit) => {
          const body = submit.body as { interviewEventId: string; userId: string };
          return `${body.interviewEventId}/${body.userId}`;
        }),
    );
    expect(cards.size).toBe(1);
    expect(outcome(w, b)).toBe('processed');
  });
});

// ── 4. Permanent rejections ─────────────────────────────────────────────────

describe('4. a permanent Ashby rejection is terminal', () => {
  const REJECTIONS: Array<[string, AshbyStep, string, number]> = [
    ['400', { status: 400, body: { success: false, errors: ['invalid_input'] } }, 'http_client_error:invalid_input', 400],
    ['404', { status: 404, body: '' }, 'http_client_error', 404],
    ['422', { status: 422, body: { errors: [{ code: 'Feedback_Not_Editable', message: 'SENTINEL-MESSAGE' }] } }, 'http_client_error:feedback_not_editable', 422],
    ['success:false', { status: 200, body: { success: false, errors: ['feedback_locked'] } }, 'logical_failure:feedback_locked', 200],
  ];

  it.each(REJECTIONS)('%s: alert, receipt failed, no retry', async (_label, step, detail, status) => {
    const { w, b } = await world();
    w.ashby.next('submit', step);
    await expect(w.dispatcher.handle(w.queueJob(b.job!.payload))).resolves.toBeUndefined();
    expect(jobLines(w)).toEqual(['scorecard_feedback:ashby_rejected']);
    expect(errorLines(w)).toEqual([{ error_category: R1_MEET_FEEDBACK_ALERTS.rejected, error_type: detail, http_status: status }]);
    // The handler's `failed` stands: the dispatcher's own finish is a no-op compare-and-set.
    expect(w.receiptRow(b.key)).toMatchObject({ outcome: 'failed', processed_at: HARNESS_NOW });
    expect(w.ashby.submits()).toHaveLength(1);
    expect(JSON.stringify(w.h.logs)).not.toContain('SENTINEL');
  });

  // S09-R2: `_after_retry` says "the card may already be in Ashby", so it needs an earlier run that may
  // have reached the submit, not just any earlier run. The queue keeps only the PREVIOUS run's outcome,
  // so with more than one earlier run (other than booking waits alone) the history is unknown: yes.
  it.each([
    ['after a rate-limited submit', { deferCount: 1, deferredAt: HARNESS_NOW, lastDeferReason: 'ashby_rate_limited' }],
    ['after a submit Ashby could not answer', { deferCount: 2, deferredAt: HARNESS_NOW, lastDeferReason: 'ashby_unavailable' }],
    ['after a run that threw past the submit bound', { attempts: 2, lastError: 'r1_meet_feedback_ashby_unavailable' }],
    ['after a run that threw something unexpected', { attempts: 2, lastError: 'r1_meet_unexpected_error' }],
    ['after a run that ended with no outcome (a lost lease)', { attempts: 2 }],
    // S09-R2 round 2: the previous run stopped before the submit, but an earlier one is unknown.
    ['after two earlier runs, the last a form wait', { deferCount: 2, deferredAt: HARNESS_NOW, lastDeferReason: 'form_unavailable' }],
    ['after three form waits', { deferCount: 3, deferredAt: HARNESS_NOW, lastDeferReason: 'form_unavailable' }],
    ['after two earlier runs, the last Meet inactive', { deferCount: 2, deferredAt: HARNESS_NOW, lastDeferReason: 'r1_meet_inactive' }],
    ['after two earlier runs, the last a database throw', { attempts: 2, deferCount: 1, lastError: 'r1_meet_db_error' }],
    ['after two throws, the last a database throw', { attempts: 3, lastError: 'r1_meet_db_error' }],
    // A booking wait proves the history only when nothing threw or lost its lease (`attempts` 1).
    ['after a booking wait and a throw or lost lease', { attempts: 2, deferCount: 1, deferredAt: HARNESS_NOW, lastDeferReason: 'booking_not_settled' }],
  ] as Array<[string, MetaOver]>)('%s it is ashby_rejected_after_retry (the card may already be in Ashby)', async (_label, over) => {
    const { w, b } = await world();
    w.ashby.next('submit', { status: 403, body: { success: false, errors: ['feedback_edit_disabled'] } });
    expect(await run(w, b, over)).toEqual(r1MeetIgnored('ashby_rejected_after_retry'));
    expect(errorLines(w)).toEqual([
      { error_category: 'r1_meet_feedback_rejected', error_type: 'http_client_error:feedback_edit_disabled', http_status: 403 },
    ]);
    expect(outcome(w, b)).toBe('failed');
  });

  it.each([
    ['after waiting for the booking to settle', { deferCount: 1, deferredAt: HARNESS_NOW, lastDeferReason: 'booking_not_settled' }],
    // A completed booking is never revived (0142): runs that only deferred, the last on a live
    // booking, all found it not completed, so none of them reached the submit.
    ['after four waits, the last for the booking', { deferCount: 4, deferredAt: HARNESS_NOW, lastDeferReason: 'booking_not_settled' }],
    ['after waiting for the form', { deferCount: 1, deferredAt: HARNESS_NOW, lastDeferReason: 'form_unavailable' }],
    ['after a run claimed while Meet was inactive', { deferCount: 1, deferredAt: HARNESS_NOW, lastDeferReason: 'r1_meet_inactive' }],
    ['after a throw while the booking was still live', { attempts: 2, lastError: 'r1_meet_feedback_booking_not_settled' }],
    ['after a throw while the form could not be read', { attempts: 2, lastError: 'r1_meet_feedback_form_unavailable' }],
    // S09-R2 round 2: throws that cannot follow a submit that may have landed.
    ['after a database throw', { attempts: 2, lastError: 'r1_meet_db_error' }],
    ['after an unwired build', { attempts: 2, lastError: 'r1_meet_feedback_unwired' }],
    ['after a build that did not know the kind', { attempts: 2, lastError: 'r1_meet_unknown_kind' }],
    ['after a payload refusal', { attempts: 2, lastError: 'r1_meet_malformed_payload' }],
  ] as Array<[string, MetaOver]>)('%s, a first submit Ashby refuses is ashby_rejected (no card can be there yet)', async (_label, over) => {
    const { w, b } = await world();
    w.ashby.next('submit', { status: 403, body: { success: false, errors: ['missing_endpoint_permission'] } });
    expect(await run(w, b, over)).toEqual(r1MeetIgnored('ashby_rejected'));
    expect(w.ashby.submits()).toHaveLength(1);
    expect(outcome(w, b)).toBe('failed');
  });

  /**
   * The REAL in-memory queue on the world's clock; `pass()` is one runner pass, awaited to its end. The
   * handler is the world's always-active dispatcher unless a test passes its own.
   */
  function realQueue(w: R1MeetFeedbackWorld, dispatcher: R1MeetDispatcher = w.dispatcher) {
    const clock = (): string => new Date(w.h.now()).toISOString();
    const adapter = new MemoryAdapter({ clock });
    const queue = new Queue(adapter, { clock });
    return {
      adapter,
      queue,
      async pass(): Promise<void> {
        const runner = createQueueRunner({
          queue,
          handlers: { [R1_MEET_QUEUE]: (job) => dispatcher.handle(job) },
          owner: 'test-meet',
          leaseSeconds: 60,
          pollMs: 5000,
          now: () => w.h.now(),
          random: () => 0,
        });
        await runner.tick();
        await runner.stop();
      },
    };
  }

  it('through the real queue: waits for the booking, then a refused first submit, is ashby_rejected', async () => {
    const { w, b } = await world();
    const q = realQueue(w);
    // Scoring finished while the call was still `in_call`: the job waits (attempt refunded), twice.
    setStatus(w, b.bookingId, 'in_call');
    const queued = await q.queue.enqueue(R1_MEET_QUEUE, b.job!.payload, { maxAttempts: 5 });
    await q.pass();
    w.h.setNow(w.h.now() + (R1_MEET_FEEDBACK_DEFER.notSettled + 1) * 1000);
    await q.pass();
    expect(w.ashby.requests).toEqual([]);
    expect(await q.adapter.getById(queued.id)).toMatchObject({ status: 'delayed', attempts: 0, deferCount: 2, deferReason: 'booking_not_settled' });

    // The booking settles; the next run makes the FIRST submit, and Ashby refuses the key's permission.
    setStatus(w, b.bookingId, 'completed');
    w.ashby.next('submit', { status: 403, body: { success: false, errors: ['missing_endpoint_permission'] } });
    w.h.setNow(w.h.now() + (R1_MEET_FEEDBACK_DEFER.notSettled + 1) * 1000);
    await q.pass();
    expect(w.ashby.submits()).toHaveLength(1);
    expect(jobLines(w)).toEqual([
      'scorecard_feedback:booking_not_settled',
      'scorecard_feedback:booking_not_settled',
      'scorecard_feedback:ashby_rejected',
    ]);
    expect(outcome(w, b)).toBe('failed');
  });

  it('through the real queue: a submit Ashby could not answer, then a refusal, is ashby_rejected_after_retry', async () => {
    const { w, b } = await world();
    const q = realQueue(w);
    const queued = await q.queue.enqueue(R1_MEET_QUEUE, b.job!.payload, { maxAttempts: 5 });
    w.ashby.next('submit', { status: 503, body: '' });
    await q.pass();
    expect(await q.adapter.getById(queued.id)).toMatchObject({ status: 'delayed', deferCount: 1, deferReason: 'ashby_unavailable' });

    w.ashby.next('submit', { status: 403, body: { success: false, errors: ['feedback_edit_disabled'] } });
    w.h.setNow(w.h.now() + (R1_MEET_FEEDBACK_DEFER.unavailable + 1) * 1000);
    await q.pass();
    expect(w.ashby.submits()).toHaveLength(2);
    expect(jobLines(w)).toEqual(['scorecard_feedback:ashby_unavailable', 'scorecard_feedback:ashby_rejected_after_retry']);
    expect(outcome(w, b)).toBe('failed');
  });

  // S09-R2 round 2: the queue keeps only the previous run's outcome, so a form wait AFTER a submit Ashby
  // could not answer must not hide that submit (before this fix it read `ashby_rejected`).
  it('through the real queue: a submit Ashby could not answer, a failed form read, then a refusal, is ashby_rejected_after_retry', async () => {
    const { w, b } = await world();
    const q = realQueue(w);
    const queued = await q.queue.enqueue(R1_MEET_QUEUE, b.job!.payload, { maxAttempts: 5 });
    w.ashby.next('submit', { status: 503, body: '' });
    await q.pass();
    w.ashby.next('form', { status: 503, body: '' });
    w.h.setNow(w.h.now() + (R1_MEET_FEEDBACK_DEFER.unavailable + 1) * 1000);
    await q.pass();
    expect(await q.adapter.getById(queued.id)).toMatchObject({ status: 'delayed', attempts: 0, deferCount: 2, deferReason: 'form_unavailable' });

    w.ashby.next('submit', { status: 403, body: { success: false, errors: ['feedback_edit_disabled'] } });
    w.h.setNow(w.h.now() + (R1_MEET_FEEDBACK_DEFER.form + 1) * 1000);
    await q.pass();
    expect(w.ashby.submits()).toHaveLength(2);
    expect(jobLines(w)).toEqual([
      'scorecard_feedback:ashby_unavailable',
      'scorecard_feedback:form_unavailable',
      'scorecard_feedback:ashby_rejected_after_retry',
    ]);
    expect(outcome(w, b)).toBe('failed');
  });

  it('through the real queue: a database throw before any Ashby call, then a refused first submit, is ashby_rejected', async () => {
    const { w, b } = await world();
    const q = realQueue(w);
    const queued = await q.queue.enqueue(R1_MEET_QUEUE, b.job!.payload, { maxAttempts: 5 });
    w.failNext('assessments');
    await q.pass();
    expect(w.ashby.requests).toEqual([]);
    expect(await q.adapter.getById(queued.id)).toMatchObject({ status: 'delayed', attempts: 1, deferCount: 0, errorMessage: 'r1_meet_db_error' });

    w.ashby.next('submit', { status: 403, body: { success: false, errors: ['missing_endpoint_permission'] } });
    w.h.setNow(w.h.now() + 61_000);
    await q.pass();
    expect(w.ashby.submits()).toHaveLength(1);
    expect(jobLines(w)).toEqual(['scorecard_feedback:r1_meet_db_error', 'scorecard_feedback:ashby_rejected']);
    expect(outcome(w, b)).toBe('failed');
  });

  it('through the real queue: a run claimed while Meet was inactive, then a refused first submit, is ashby_rejected', async () => {
    const { w, b } = await world();
    let active = false;
    const q = realQueue(w, createR1MeetDispatcher({ flowDeps: () => w.deps, active: () => active }));
    const queued = await q.queue.enqueue(R1_MEET_QUEUE, b.job!.payload, { maxAttempts: 5 });
    await q.pass();
    expect(w.ashby.requests).toEqual([]);
    expect(await q.adapter.getById(queued.id)).toMatchObject({ status: 'delayed', attempts: 0, deferCount: 1, deferReason: R1_MEET_INACTIVE });

    active = true;
    w.ashby.next('submit', { status: 403, body: { success: false, errors: ['missing_endpoint_permission'] } });
    w.h.setNow(w.h.now() + (R1_MEET_INACTIVE_DEFER_SEC + 1) * 1000);
    await q.pass();
    expect(w.ashby.submits()).toHaveLength(1);
    expect(jobLines(w)).toEqual([`scorecard_feedback:${R1_MEET_INACTIVE}`, 'scorecard_feedback:ashby_rejected']);
    expect(outcome(w, b)).toBe('failed');
  });

  it('a request the client refuses before the network is terminal ashby_request_invalid', async () => {
    const { w, b } = await world();
    const deps: R1MeetFlowDeps = { ...w.deps, feedback: { ...w.feedback, dexUserId: '' } };
    expect(await run(w, b, {}, deps)).toEqual(r1MeetIgnored('ashby_request_invalid'));
    expect(errorLines(w)).toEqual([{ error_category: 'r1_meet_feedback_rejected', error_type: 'invalid_request' }]);
    expect(w.ashby.submits()).toHaveLength(0);
    expect(outcome(w, b)).toBe('failed');
  });
});

// ── 5. Rate limits and outages ──────────────────────────────────────────────

describe('5. 429 and 5xx retry through the queue', () => {
  const TRANSIENT: Array<[string, AshbyStep, string, number, string]> = [
    ['429', { status: 429, body: '' }, 'ashby_rate_limited', 60, 'r1_meet_feedback_ashby_rate_limited'],
    ['500', { status: 500, body: '' }, 'ashby_unavailable', 30, 'r1_meet_feedback_ashby_unavailable'],
    ['503', { status: 503, body: '' }, 'ashby_unavailable', 30, 'r1_meet_feedback_ashby_unavailable'],
    ['network', 'network', 'ashby_unavailable', 30, 'r1_meet_feedback_ashby_unavailable'],
  ];

  it('the delays', () => {
    expect(R1_MEET_FEEDBACK_DEFER).toStrictEqual({ notSettled: 60, form: 60, rateLimited: 60, unavailable: 30 });
    expect(Object.isFrozen(R1_MEET_FEEDBACK_DEFER)).toBe(true);
  });

  it.each(TRANSIENT)('%s defers within the bound and leaves the receipt alone', async (_label, step, code, seconds) => {
    const { w, b } = await world();
    w.ashby.next('submit', step);
    await expect(w.dispatcher.handle(w.queueJob(b.job!.payload))).resolves.toEqual({
      outcome: 'defer',
      reasonCode: code,
      delaySeconds: seconds,
    });
    expect(outcome(w, b)).toBe('enqueued');
    expect(w.ashby.submits()).toHaveLength(1);
    expect(errorLines(w)).toEqual([]);
  });

  it.each(TRANSIENT)('%s past the bound throws its closed code (then attempts and the DLQ)', async (_label, step, _code, _seconds, thrownCode) => {
    const { w, b } = await world();
    w.ashby.next('submit', step);
    expect((await thrown(run(w, b, EXHAUSTED))).code).toBe(thrownCode);

    // A streak older than the bound is past it too.
    w.ashby.next('submit', step);
    const old = new Date(w.h.now() - R1_MEET_DEFER_MAX_MS).toISOString();
    expect((await thrown(run(w, b, { deferCount: 1, deferredAt: old }))).code).toBe(thrownCode);
    expect(outcome(w, b)).toBe('enqueued');
  });

  it('on the final attempt the dispatcher dead-letters it and fails the receipt', async () => {
    const { w, b } = await world();
    w.ashby.next('submit', { status: 503, body: '' });
    const job = w.queueJob(b.job!.payload, { attempts: 5, maxAttempts: 5, deferCount: R1_MEET_DEFER_MAX_COUNT, deferredAt: HARNESS_NOW });
    await expect(w.dispatcher.handle(job)).rejects.toThrow('r1_meet_feedback_ashby_unavailable');
    expect(outcome(w, b)).toBe('failed');
    expect(errorLines(w)).toEqual([{ error_category: 'r1_meet_job_failed', error_type: 'scorecard_feedback:r1_meet_feedback_ashby_unavailable' }]);
  });
});

// ── 6. Missing mapping and configuration ────────────────────────────────────

describe('6. a missing mapping or setting submits nothing', () => {
  it('off: nothing is read and nothing is sent', async () => {
    const { w, b } = await world();
    w.setConfig({ status: 'off' });
    w.h.db.calls.length = 0;
    expect(await run(w, b)).toEqual(r1MeetIgnored('feedback_off'));
    expect(w.h.db.calls).toEqual([]);
    expect(w.ashby.requests).toEqual([]);
    expect(w.h.logs).toEqual([]);
  });

  it('a malformed form setting: alert, receipt failed, nothing sent', async () => {
    const { w, b } = await world();
    w.setConfig({ status: 'invalid', reason: 'R1_MEET_ASHBY_FEEDBACK_FORM_ID must be a UUID' });
    expect(await run(w, b)).toEqual(r1MeetIgnored('feedback_config_invalid'));
    expect(errorLines(w)).toEqual([{ error_category: R1_MEET_FEEDBACK_ALERTS.configInvalid, error_type: 'feedback_config_invalid' }]);
    expect(outcome(w, b)).toBe('failed');
    expect(w.ashby.requests).toEqual([]);
  });

  it('no usable Ashby key: alert, receipt failed, nothing sent', async () => {
    const { w, b } = await world();
    w.setKeyConfigured(false);
    expect(await run(w, b)).toEqual(r1MeetIgnored('ashby_key_missing'));
    expect(errorLines(w)).toEqual([{ error_category: 'r1_meet_feedback_config_invalid', error_type: 'ashby_key_missing' }]);
    expect(outcome(w, b)).toBe('failed');
    expect(w.ashby.requests).toEqual([]);
  });

  it("Ashby's own switches off (the 'stop all Ashby writes' rollback): one warning, receipt failed, no Ashby call (S09-R3)", async () => {
    const { w, b } = await world();
    w.setAshbyActive(false);
    await expect(w.dispatcher.handle(w.queueJob(b.job!.payload))).resolves.toBeUndefined();
    expect(jobLines(w)).toEqual(['scorecard_feedback:ashby_inactive']);
    expect(w.ashby.requests).toEqual([]);
    expect(errorLines(w)).toEqual([]);
    expect(w.h.logs.filter((line) => line.level === 'warn').map((line) => line.meta)).toEqual([
      { error_category: R1_MEET_FEEDBACK_ASHBY_INACTIVE_LOG },
    ]);
    // `failed`, not `ignored`: once Ashby is back on, the runbook re-post sends it.
    expect(outcome(w, b)).toBe('failed');
    w.setAshbyActive(true);
    await w.dispatcher.handle(w.queueJob(r1MeetJobs.scorecardFeedback(b.bookingId, b.assessmentId).payload));
    expect(outcome(w, b)).toBe('processed');
    expect(w.ashby.submits()).toHaveLength(1);
    expect(w.ashby.submits()[0]!.raw).toBe(expectedBody(b));
  });

  it('a form id pasted in upper case names the same form: the card is posted with the lower-case id (S09-R4)', async () => {
    const { w, b } = await world();
    w.setConfig(getR1MeetFeedbackConfig({ R1_MEET_ASHBY_FEEDBACK_FORM_ID: FEEDBACK_FORM_ID.toUpperCase() }));
    expect(await run(w, b)).toEqual(r1MeetProcessed('submitted'));
    expect(errorLines(w)).toEqual([]);
    expect(w.ashby.submits()).toHaveLength(1);
    expect(w.ashby.submits()[0]!.raw).toBe(expectedBody(b));
    expect(outcome(w, b)).toBe('processed');
  });

  const overall = (fields: ReturnType<typeof dexFormFields>, values: string[]) =>
    fields.map((entry) =>
      entry.field.path === 'overall_recommendation'
        ? { ...entry, field: { ...entry.field, selectableValues: values.map((value) => ({ value, label: value })) } }
        : entry,
    );

  const FORM_FAULTS: Array<[string, () => Record<string, unknown>]> = [
    ['form_mismatch', () => dexFormDefinition({ id: '7f000000-0000-4000-8000-00000000f0ff' })],
    ['form_archived', () => dexFormDefinition({ isArchived: true })],
    ['form_overall_missing', () => dexFormDefinition({ fields: dexFormFields().filter((entry) => entry.field.path !== 'overall_recommendation') })],
    ['form_overall_options_mismatch', () => dexFormDefinition({ fields: overall(dexFormFields(), ['1', '2', '3', '4', '5']) })],
    ['form_overall_options_mismatch', () => dexFormDefinition({ fields: overall(dexFormFields(), ['Yes', 'No']) })],
    ['form_summary_missing', () => dexFormDefinition({ fields: dexFormFields().filter((entry) => entry.field.title !== 'Summary') })],
    ['form_summary_ambiguous', () => dexFormDefinition({
      fields: [...dexFormFields(), { isRequired: false, field: { id: 'fld-summary-2', type: 'LongText', path: 'summary_two', title: 'summary' } }],
    })],
    ['form_required_field_unbound', () => dexFormDefinition({
      fields: [...dexFormFields(), { isRequired: true, field: { id: 'fld-notes', type: 'String', path: 'hiring_notes', title: 'Hiring notes' } }],
    })],
  ];

  it.each(FORM_FAULTS)('%s: alert with the reason, receipt failed, one form read and no submit', async (reason, definition) => {
    const { w, b } = await world();
    w.ashby.definition = definition();
    expect(await run(w, b)).toEqual(r1MeetIgnored(reason));
    expect(errorLines(w)).toEqual([{ error_category: R1_MEET_FEEDBACK_ALERTS.formInvalid, error_type: reason }]);
    expect(outcome(w, b)).toBe('failed');
    expect(w.ashby.forms()).toHaveLength(1);
    expect(w.ashby.submits()).toHaveLength(0);
  });

  it.each([
    ['403', { status: 403, body: { success: false, errors: ['missing_endpoint_permission'] } }, 403],
    ['404', { status: 404, body: '' }, 404],
    ['success:false', { status: 200, body: { success: false, errors: ['not_found'] } }, 200],
  ] as Array<[string, AshbyStep, number]>)('a form read %s: alert form_unreadable, receipt failed, no submit', async (_label, step, status) => {
    const { w, b } = await world();
    w.ashby.next('form', step);
    expect(await run(w, b)).toEqual(r1MeetIgnored('form_unreadable'));
    expect(errorLines(w)).toEqual([{ error_category: 'r1_meet_feedback_form_invalid', error_type: 'form_unreadable', http_status: status }]);
    expect(outcome(w, b)).toBe('failed');
    expect(w.ashby.submits()).toHaveLength(0);
  });

  it.each([
    ['429', { status: 429, body: '' }],
    ['503', { status: 503, body: '' }],
    ['network', 'network'],
    ['no usable definition', { status: 200, body: { success: true, results: {} } }],
    ['a definition without fields', { status: 200, body: { success: true, results: dexFormDefinition({ fields: [] }) } }],
  ] as Array<[string, AshbyStep]>)('a form read with %s defers form_unavailable, then throws past the bound', async (_label, step) => {
    const { w, b } = await world();
    w.ashby.next('form', step);
    expect(await run(w, b)).toEqual(r1MeetDefer('form_unavailable', R1_MEET_FEEDBACK_DEFER.form));
    w.ashby.next('form', step);
    expect((await thrown(run(w, b, EXHAUSTED))).code).toBe('r1_meet_feedback_form_unavailable');
    expect(w.ashby.submits()).toHaveLength(0);
    expect(outcome(w, b)).toBe('enqueued');
    expect(errorLines(w)).toEqual([]);
  });
});

// ── 7. Off-path guards ──────────────────────────────────────────────────────

/** Set a booking's status, keeping the 0142 row consistent (the reason, the bot and round bindings). */
function setStatus(w: R1MeetFeedbackWorld, bookingId: string, status: string): void {
  const row = w.h.db.booking(bookingId)!;
  row.status = status;
  row.reason = FAKE_STATUS_REASONS[status]![0];
  const holdsBot = ['bot_scheduled', 'bot_joining', 'human_present', 'in_call'].includes(status);
  const botless = ['pending', 'blocked', 'unmatched_application', 'unmapped_scheduler'].includes(status);
  row.recall_bot_id = holdsBot ? fixtureId() : botless ? null : row.recall_bot_id;
  if (status === 'unmatched_application') {
    row.round_id = null;
    row.candidate_id = null;
  }
  if (status === 'unmapped_scheduler') row.round_id = null;
}

describe('7. off-path guards: no Ashby call', () => {
  it.each(R1_MEET_LIVE_STATUSES.map((status) => [status]))('a %s booking is not settled yet: defer, then throw past the bound', async (status) => {
    const { w, b } = await world();
    setStatus(w, b.bookingId, status);
    expect(await run(w, b)).toEqual(r1MeetDefer('booking_not_settled', R1_MEET_FEEDBACK_DEFER.notSettled));
    expect((await thrown(run(w, b, EXHAUSTED))).code).toBe('r1_meet_feedback_booking_not_settled');
    expect(w.ashby.requests).toEqual([]);
    expect(outcome(w, b)).toBe('enqueued');
  });

  it.each(R1_MEET_TERMINAL_STATUSES.filter((status) => status !== 'completed').map((status) => [status]))(
    'a %s booking is never posted',
    async (status) => {
      const { w, b } = await world();
      setStatus(w, b.bookingId, status);
      expect(await run(w, b)).toEqual(r1MeetIgnored('booking_not_completed'));
      expect(w.ashby.requests).toEqual([]);
    },
  );

  // Each case changes the world, then the job must refuse with its code and send nothing.
  const GUARDS: Array<[string, string, (w: R1MeetFeedbackWorld, b: CompletedBooking) => void]> = [
    ['no booking', 'booking_missing', (w, b) => w.h.db.deleteBooking(b.bookingId)],
    ['no session', 'booking_unbound', (w, b) => {
      w.h.db.booking(b.bookingId)!.session_id = null;
    }],
    ['no round', 'booking_unbound', (w, b) => {
      w.h.db.booking(b.bookingId)!.round_id = null;
    }],
    // S09-R5: the card's header names the booking's profile, so a profile this build does not know
    // posts nothing rather than a card labelled as Dex's sales round.
    ['an objective profile this build does not know', 'profile_unknown', (w, b) => {
      w.h.db.booking(b.bookingId)!.objective_profile = 'r1_later_persona';
    }],
    ['a round that is gone', 'round_not_meet', (w, b) => {
      w.h.db.tables.interview_rounds.splice(w.h.db.tables.interview_rounds.findIndex((round) => round.id === b.roundId), 1);
    }],
    ['a browser round', 'round_not_meet', (w, b) => {
      w.h.db.tables.interview_rounds.find((round) => round.id === b.roundId)!.channel = 'browser';
    }],
    ['a newer assessment on the round', 'assessment_superseded', (w, b) => {
      w.h.db.tables.interview_rounds.find((round) => round.id === b.roundId)!.assessment_id = fixtureId();
    }],
    ['no assessment on the round', 'assessment_superseded', (w, b) => {
      w.h.db.tables.interview_rounds.find((round) => round.id === b.roundId)!.assessment_id = null;
    }],
    ['an assessment that is gone', 'assessment_missing', (w) => {
      w.tables.assessments.length = 0;
    }],
    ['an assessment of another session', 'assessment_not_booking_session', (w) => {
      w.tables.assessments[0]!.session_id = fixtureId();
    }],
    ['an open appeal', 'decision_use_blocked', (w) => {
      w.tables.candidates[0]!.decision_use_blocked_at = HARNESS_NOW;
    }],
    ['a candidate that is gone', 'decision_use_blocked', (w) => {
      w.tables.candidates.length = 0;
    }],
    ['a withdrawn consent', 'consent_withdrawn', (w, b) => {
      w.h.db.tables.interview_round_consents.push({ id: fixtureId(), round_id: b.roundId, withdrawn_at: HARNESS_NOW, proof: { decision: 'withdrawn' } });
    }],
    ['a declined consent', 'consent_withdrawn', (w, b) => {
      w.h.db.tables.interview_round_consents.push({ id: fixtureId(), round_id: b.roundId, withdrawn_at: HARNESS_NOW, proof: { decision: 'declined' } });
    }],
    ['a scoring placeholder', 'not_postable', (w) => {
      Object.assign(w.tables.assessments[0]!, { recommendation: null, overall_score: null, weighted_score_5: null });
    }],
    ['a human_review verdict (the column is null)', 'not_postable', (w) => {
      w.tables.assessments[0]!.recommendation = null;
    }],
    ['a v1 scorecard', 'not_postable', (w) => {
      w.tables.assessments[0]!.schema_version = 1;
    }],
  ];

  it.each(GUARDS)('%s: %s', async (_label, code, change) => {
    const { w, b } = await world();
    change(w, b);
    expect(await run(w, b)).toEqual(r1MeetIgnored(code));
    expect(w.ashby.requests).toEqual([]);
    expect(errorLines(w)).toEqual([]);
  });

  it('a browser round from the start never gets a card', async () => {
    const { w, b } = await world({ channel: 'browser' });
    await expect(w.dispatcher.handle(w.queueJob(b.job!.payload))).resolves.toBeUndefined();
    expect(jobLines(w)).toEqual(['scorecard_feedback:round_not_meet']);
    expect(outcome(w, b)).toBe('ignored');
    expect(w.ashby.requests).toEqual([]);
  });

  it('a consent superseded by a newer one is not a withdrawal', async () => {
    const { w, b } = await world();
    w.h.db.tables.interview_round_consents.push({ id: fixtureId(), round_id: b.roundId, withdrawn_at: HARNESS_NOW, proof: { decision: 'superseded' } });
    // And a withdrawal decision on a consent that is still live is not one either (no withdrawn_at).
    w.h.db.tables.interview_round_consents.push({ id: fixtureId(), round_id: b.roundId, withdrawn_at: null, proof: { decision: 'withdrawn' } });
    expect(await run(w, b)).toEqual(r1MeetProcessed('submitted'));
  });

  it('stale: posted up to exactly 7 days after the slot ended, never after', async () => {
    const late = await world();
    late.w.h.setNow(Date.parse(late.w.h.db.booking(late.b.bookingId)!.end_at) + 7 * DAY_MS + 1);
    expect(await run(late.w, late.b)).toEqual(r1MeetIgnored('stale'));
    expect(late.w.ashby.requests).toEqual([]);

    const edge = await world();
    edge.w.h.setNow(Date.parse(edge.w.h.db.booking(edge.b.bookingId)!.end_at) + 7 * DAY_MS);
    expect(await run(edge.w, edge.b)).toEqual(r1MeetProcessed('submitted'));
  });

  it('unwired (no feedback ports): the closed throw, no Ashby call', async () => {
    const { w, b } = await world();
    const { feedback: _absent, ...unwired } = w.deps;
    expect((await thrown(run(w, b, {}, unwired))).code).toBe('r1_meet_feedback_unwired');
    expect(w.ashby.requests).toEqual([]);
  });

  it('a database failure is the closed r1_meet_db_error, before any Ashby call', async () => {
    const { w, b } = await world();
    w.failNext('assessments');
    expect((await thrown(run(w, b))).code).toBe('r1_meet_db_error');
    expect(w.ashby.requests).toEqual([]);
  });
});

// ── 8. Re-posting a failed card ─────────────────────────────────────────────

describe('8. a failed receipt is re-postable', () => {
  it('the trigger does not re-queue it; a manual re-post sends it and ends it processed', async () => {
    const { w, b } = await world();
    w.ashby.next('submit', { status: 422, body: { success: false, errors: ['invalid_field_value'] } });
    await w.dispatcher.handle(w.queueJob(b.job!.payload));
    expect(outcome(w, b)).toBe('failed');

    // The scorecard-ready trigger fires again: a terminal receipt queues nothing.
    const jobs = w.h.db.jobs('scorecard_feedback').length;
    expect(await w.store.recordFeedback(b.bookingId, b.assessmentId, w.h.now())).toMatchObject({ status: 'duplicate', outcome: 'failed', enqueued: false });
    expect(w.h.db.jobs('scorecard_feedback')).toHaveLength(jobs);

    // After the fix, the runbook's manual re-post.
    await expect(w.dispatcher.handle(w.queueJob(r1MeetJobs.scorecardFeedback(b.bookingId, b.assessmentId).payload))).resolves.toBeUndefined();
    expect(outcome(w, b)).toBe('processed');
    expect(w.ashby.submits()).toHaveLength(2);
    expect(w.ashby.submits()[1]!.raw).toBe(expectedBody(b));
  });

  it('a failed settle after a good submit only warns; the dispatcher finishes the receipt', async () => {
    const { w, b } = await world();
    const deps: R1MeetFlowDeps = {
      ...w.deps,
      feedback: {
        ...w.feedback,
        store: {
          ...w.store,
          settleReceipt: async () => {
            throw new R1MeetJobError('r1_meet_db_error');
          },
        },
      },
    };
    const dispatcher = createR1MeetDispatcher({ flowDeps: () => deps, active: () => true });
    await expect(dispatcher.handle(w.queueJob(b.job!.payload))).resolves.toBeUndefined();
    expect(w.h.logs.filter((line) => line.level === 'warn').map((line) => line.meta)).toEqual([
      { error_category: 'r1_meet_feedback_receipt_settle_failed' },
    ]);
    expect(outcome(w, b)).toBe('processed');
    expect(w.ashby.submits()).toHaveLength(1);
  });
});

// ── 9. Logs ─────────────────────────────────────────────────────────────────

describe('9. logs are closed words only', () => {
  it('across success, rejection, deferral and every alert: no id, path, URL, name or text', async () => {
    const { w, b } = await world();
    const seen: string[] = [];
    const scenarios: Array<() => Promise<unknown>> = [
      async () => w.dispatcher.handle(w.queueJob(b.job!.payload)),
      async () => w.dispatcher.handle(w.queueJob(b.job!.payload)),
    ];
    for (const scenario of scenarios) await scenario();

    const more = await w.completedBooking({ eventId: fixtureId(), applicationId: fixtureId() });
    w.ashby.next('submit', { status: 429, body: '' });
    await w.dispatcher.handle(w.queueJob(more.job!.payload));
    w.ashby.next('submit', { status: 400, body: { success: false, errors: [{ code: 'bad', message: SENTINELS.name }] } });
    await w.dispatcher.handle(w.queueJob(more.job!.payload, { deferCount: 1, deferredAt: HARNESS_NOW }));

    const third = await w.completedBooking({ eventId: fixtureId(), applicationId: fixtureId() });
    w.ashby.definition = dexFormDefinition({ isArchived: true });
    await w.dispatcher.handle(w.queueJob(third.job!.payload));
    w.setKeyConfigured(false);
    const fourth = await w.completedBooking({ eventId: fixtureId(), applicationId: fixtureId() });
    await w.dispatcher.handle(w.queueJob(fourth.job!.payload));
    w.setConfig({ status: 'invalid', reason: 'R1_MEET_ASHBY_FEEDBACK_FORM_ID must be a UUID' });
    const fifth = await w.completedBooking({ eventId: fixtureId(), applicationId: fixtureId() });
    await w.dispatcher.handle(w.queueJob(fifth.job!.payload));

    const ids = [b, more, third, fourth, fifth].flatMap((booking) => [
      booking.bookingId, booking.roundId, booking.sessionId, booking.candidateId, booking.assessmentId, booking.eventId, booking.applicationId,
    ]);
    ids.push(FEEDBACK_FORM_ID, DEX_USER_ID, ...w.h.db.tables.r1_meet_receipts.map((row) => row.id as string));

    expect(w.h.logs.length).toBeGreaterThan(8);
    for (const line of w.h.logs) {
      expect(Object.keys(line.meta).every((key) => ['error_category', 'error_type', 'http_status'].includes(key)), JSON.stringify(line)).toBe(true);
      expect(line.meta.error_category).toMatch(/^[a-z0-9_]{1,64}$/);
      expect(line.meta.error_type ?? '').toMatch(/^[A-Za-z0-9_.:]{0,64}$/);
      if (line.meta.http_status !== undefined) expect(Number.isInteger(line.meta.http_status)).toBe(true);
      seen.push(line.meta.error_category);
    }
    const text = JSON.stringify(w.h.logs);
    for (const value of ids) expect(text).not.toContain(value);
    expect(text).not.toMatch(/https?:|example\.test|path|fld-|sec-1|Summary|Detailed|SENTINEL|sentinel|Rationale|synthetic-key|R1_MEET_ASHBY/);
    expect(new Set(seen)).toEqual(new Set([
      'r1_meet_ashby_ok',
      'r1_meet_ashby_failed',
      'r1_meet_feedback_submitted',
      'r1_meet_job',
      R1_MEET_FEEDBACK_ALERTS.rejected,
      R1_MEET_FEEDBACK_ALERTS.formInvalid,
      R1_MEET_FEEDBACK_ALERTS.configInvalid,
    ]));
  });
});

// ── 10. Public-page bookings (M035 S02) ─────────────────────────────────────

describe('10. a public-page booking: general feedback guarded by applicationFeedback.list', () => {
  const HOUR_MS = 60 * 60 * 1000;
  const OTHER_USER_ID = '7f000000-0000-4000-8000-000000000602';
  const OTHER_FORM_ID = '7f000000-0000-4000-8000-00000000f0ff';

  async function publicWorld(options: Parameters<R1MeetFeedbackWorld['completedBooking']>[0] = {}) {
    const w = createR1MeetFeedbackWorld();
    const b = await w.completedBooking({ source: 'public_page', applicationId: APPLICATION_ID, ...options });
    return { w, b };
  }

  const startOf = (w: R1MeetFeedbackWorld, b: CompletedBooking): string => w.h.db.booking(b.bookingId)!.start_at as string;

  /** The exact general body: the Ashby card's body without the event key, key order kept. */
  function expectedGeneralBody(b: CompletedBooking): string {
    const body = expectedBody(b).replace(`,"interviewEventId":"${EVENT_ID}"`, '');
    expect(body).not.toContain('interviewEventId');
    return body;
  }

  /** One of Dex's cards on the application, in Ashby's entry shape, 50 minutes after the slot start. */
  function dexCard(w: R1MeetFeedbackWorld, b: CompletedBooking, over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: fixtureId(),
      applicationId: b.applicationId,
      submittedValues: { summary_path: SENTINELS.quote },
      submittedByUser: { id: DEX_USER_ID, firstName: SENTINELS.name, email: SENTINELS.email },
      creditedToUser: { id: DEX_USER_ID },
      submittedAt: new Date(Date.parse(startOf(w, b)) + 50 * 60 * 1000).toISOString(),
      feedbackFormDefinitionId: FEEDBACK_FORM_ID,
      ...over,
    };
  }

  const ops = (w: R1MeetFeedbackWorld) => w.ashby.requests.map((request) => request.op);
  const infoLines = (w: R1MeetFeedbackWorld, category: string) =>
    w.h.logs.filter((line) => line.meta.error_category === category);

  it('the booking is the public shape: no interview event, schedule or scheduler', async () => {
    const { w, b } = await publicWorld();
    expect(b.eventId).toBeNull();
    const booking = await w.deps.store.getBooking(b.bookingId);
    expect(booking).toMatchObject({ source: 'public_page', eventId: null, scheduleId: null, scheduledByUserId: null, applicationId: APPLICATION_ID });
  });

  it('no Dex card yet: [form, list, submit], the exact general body, processed, the receipt processed', async () => {
    const { w, b } = await publicWorld();
    await expect(w.dispatcher.handle(w.queueJob(b.job!.payload))).resolves.toBeUndefined();

    expect(w.ashby.requests.map((request) => [request.op, request.path])).toEqual([
      ['form', '/feedbackFormDefinition.info'],
      ['list', '/applicationFeedback.list'],
      ['submit', '/applicationFeedback.submit'],
    ]);
    const createdAfter = Date.parse(startOf(w, b)) - HOUR_MS;
    expect(w.ashby.lists()[0]!.raw).toBe(`{"applicationId":"${APPLICATION_ID}","limit":100,"createdAfter":${createdAfter}}`);
    expect(w.ashby.submits()[0]!.raw).toBe(expectedGeneralBody(b));
    expect(w.ashby.submits()[0]!.raw).not.toContain('interviewEventId');
    expect(w.receiptRow(b.key)).toMatchObject({ outcome: 'processed', processed_at: HARNESS_NOW });
    expect(jobLines(w)).toEqual(['scorecard_feedback:submitted']);
    expect(infoLines(w, R1_MEET_FEEDBACK_ALREADY_POSTED_LOG)).toEqual([]);
    expect(errorLines(w)).toEqual([]);
  });

  it('the handler answers processed(submitted) directly as well', async () => {
    const { w, b } = await publicWorld();
    expect(await run(w, b)).toEqual(r1MeetProcessed('submitted'));
    expect(ops(w)).toEqual(['form', 'list', 'submit']);
    expect(outcome(w, b)).toBe('processed');
  });

  it.each([
    ['on the configured form', {}],
    ['with a null form id', { feedbackFormDefinitionId: null }],
    ['with no form id at all', { feedbackFormDefinitionId: undefined }],
    ['on the form, id in upper case', { feedbackFormDefinitionId: FEEDBACK_FORM_ID.toUpperCase() }],
    ['credited to Dex, submitted by someone else', { submittedByUser: { id: OTHER_USER_ID }, creditedToUser: { id: DEX_USER_ID.toUpperCase() } }],
    ['submitted exactly at the slot start', 'start'],
  ] as Array<[string, Record<string, unknown> | 'start']>)('a Dex card %s: [form, list], no submit, already_posted, the receipt processed', async (_label, over) => {
    const { w, b } = await publicWorld();
    w.ashby.feedbackList = [dexCard(w, b, over === 'start' ? { submittedAt: startOf(w, b) } : over)];
    expect(await run(w, b)).toEqual(r1MeetProcessed('already_posted'));
    expect(ops(w)).toEqual(['form', 'list']);
    expect(w.ashby.submits()).toHaveLength(0);
    expect(w.receiptRow(b.key)).toMatchObject({ outcome: 'processed', processed_at: HARNESS_NOW });
    expect(infoLines(w, R1_MEET_FEEDBACK_ALREADY_POSTED_LOG)).toEqual([
      { level: 'info', meta: { error_category: R1_MEET_FEEDBACK_ALREADY_POSTED_LOG } },
    ]);
    expect(infoLines(w, 'r1_meet_feedback_submitted')).toEqual([]);
    expect(errorLines(w)).toEqual([]);
  });

  it('already_posted through the dispatcher ends the job and the receipt processed', async () => {
    const { w, b } = await publicWorld();
    w.ashby.feedbackList = [dexCard(w, b)];
    await expect(w.dispatcher.handle(w.queueJob(b.job!.payload))).resolves.toBeUndefined();
    expect(jobLines(w)).toEqual(['scorecard_feedback:already_posted']);
    expect(outcome(w, b)).toBe('processed');
    // A re-delivered job makes no Ashby call at all.
    await w.dispatcher.handle(w.queueJob(b.job!.payload, { attempts: 2 }));
    expect(jobLines(w)).toEqual(['scorecard_feedback:already_posted', 'scorecard_feedback:already_submitted']);
    expect(ops(w)).toEqual(['form', 'list']);
  });

  it.each([
    ['submitted before the slot start', 'before'],
    ['on another form', { feedbackFormDefinitionId: OTHER_FORM_ID }],
    ["another interviewer's card", { submittedByUser: { id: OTHER_USER_ID }, creditedToUser: { id: OTHER_USER_ID } }],
    ['on another application', { applicationId: fixtureId() }],
  ] as Array<[string, Record<string, unknown> | 'before']>)('a card %s does not count: the card is submitted', async (_label, over) => {
    const { w, b } = await publicWorld();
    w.ashby.feedbackList = [
      dexCard(w, b, over === 'before' ? { submittedAt: new Date(Date.parse(startOf(w, b)) - 1).toISOString() } : over),
    ];
    expect(await run(w, b)).toEqual(r1MeetProcessed('submitted'));
    expect(ops(w)).toEqual(['form', 'list', 'submit']);
    expect(w.ashby.submits()[0]!.raw).toBe(expectedGeneralBody(b));
    expect(infoLines(w, R1_MEET_FEEDBACK_ALREADY_POSTED_LOG)).toEqual([]);
  });

  const LIST_TRANSIENT: Array<[string, () => AshbyStep[], string, number, string]> = [
    ['429', () => [{ status: 429, body: '' }], 'feedback_list_rate_limited', 60, 'r1_meet_feedback_list_rate_limited'],
    ['500', () => [{ status: 500, body: '' }], 'feedback_list_unavailable', 30, 'r1_meet_feedback_list_unavailable'],
    ['503', () => [{ status: 503, body: '' }], 'feedback_list_unavailable', 30, 'r1_meet_feedback_list_unavailable'],
    ['network', () => ['network'], 'feedback_list_unavailable', 30, 'r1_meet_feedback_list_unavailable'],
    ['timeout', () => ['timeout'], 'feedback_list_unavailable', 30, 'r1_meet_feedback_list_unavailable'],
    ['an unreadable list', () => [{ status: 200, body: { success: true, results: 'not a list' } }], 'feedback_list_unavailable', 30, 'r1_meet_feedback_list_unavailable'],
    ['an entry with no user id', () => [{ status: 200, body: { success: true, results: [{ submittedAt: HARNESS_NOW }] } }], 'feedback_list_unavailable', 30, 'r1_meet_feedback_list_unavailable'],
    ['more pages than the cap', () => [1, 2, 3, 4, 5].map((i) => ({
      status: 200,
      body: { success: true, results: [], moreDataAvailable: true, nextCursor: `cursor-${i}` },
    })), 'feedback_list_unavailable', 30, 'r1_meet_feedback_list_unavailable'],
  ];

  it('the list waits use the existing delays (no new deferral key)', () => {
    expect(R1_MEET_FEEDBACK_DEFER).toStrictEqual({ notSettled: 60, form: 60, rateLimited: 60, unavailable: 30 });
  });

  it.each(LIST_TRANSIENT)('a list %s defers within the bound, leaves the receipt alone and never submits', async (_label, steps, code, seconds) => {
    const { w, b } = await publicWorld();
    for (const step of steps()) w.ashby.next('list', step);
    await expect(w.dispatcher.handle(w.queueJob(b.job!.payload))).resolves.toEqual({ outcome: 'defer', reasonCode: code, delaySeconds: seconds });
    expect(w.ashby.submits()).toHaveLength(0);
    expect(w.ashby.lists().length).toBeGreaterThanOrEqual(1);
    expect(outcome(w, b)).toBe('enqueued');
    expect(errorLines(w)).toEqual([]);
  });

  it.each(LIST_TRANSIENT)('a list %s past the bound throws its closed code and never submits', async (_label, steps, _code, _seconds, thrownCode) => {
    const { w, b } = await publicWorld();
    for (const step of steps()) w.ashby.next('list', step);
    expect((await thrown(run(w, b, EXHAUSTED))).code).toBe(thrownCode);
    expect(w.ashby.submits()).toHaveLength(0);
    expect(outcome(w, b)).toBe('enqueued');
  });

  it.each([
    ['403', { status: 403, body: { success: false, errors: ['missing_endpoint_permission'] } }, 'http_client_error:missing_endpoint_permission', 403],
    ['404', { status: 404, body: '' }, 'http_client_error', 404],
    ['success:false', { status: 200, body: { success: false, errors: ['application_not_found'] } }, 'logical_failure:application_not_found', 200],
  ] as Array<[string, AshbyStep, string, number]>)('a list %s is terminal feedback_list_rejected: alert, receipt failed, no submit', async (_label, step, detail, status) => {
    const { w, b } = await publicWorld();
    w.ashby.next('list', step);
    await expect(w.dispatcher.handle(w.queueJob(b.job!.payload))).resolves.toBeUndefined();
    expect(jobLines(w)).toEqual(['scorecard_feedback:feedback_list_rejected']);
    expect(errorLines(w)).toEqual([{ error_category: R1_MEET_FEEDBACK_ALERTS.rejected, error_type: detail, http_status: status }]);
    expect(w.receiptRow(b.key)).toMatchObject({ outcome: 'failed', processed_at: HARNESS_NOW });
    expect(w.ashby.submits()).toHaveLength(0);
  });

  it('a list request the port refuses (a Dex user that is not a UUID) is terminal before the network', async () => {
    const { w, b } = await publicWorld();
    const deps: R1MeetFlowDeps = { ...w.deps, feedback: { ...w.feedback, dexUserId: 'dex' } };
    expect(await run(w, b, {}, deps)).toEqual(r1MeetIgnored('feedback_list_rejected'));
    expect(errorLines(w)).toEqual([{ error_category: R1_MEET_FEEDBACK_ALERTS.rejected, error_type: 'invalid_request' }]);
    expect(ops(w)).toEqual(['form']);
    expect(outcome(w, b)).toBe('failed');
  });

  it('a lost submit answer, then the re-run: the guard finds the card and nothing is posted twice', async () => {
    const { w, b } = await publicWorld();
    w.ashby.next('submit', 'lost');
    expect(await run(w, b)).toEqual(r1MeetDefer('ashby_unavailable', R1_MEET_FEEDBACK_DEFER.unavailable));
    expect(w.ashby.submits().filter((submit) => submit.accepted)).toHaveLength(1);
    expect(outcome(w, b)).toBe('enqueued');

    w.h.setNow(w.h.now() + (R1_MEET_FEEDBACK_DEFER.unavailable + 1) * 1000);
    expect(await run(w, b, { ...RERUN, lastDeferReason: 'ashby_unavailable' })).toEqual(r1MeetProcessed('already_posted'));
    expect(ops(w)).toEqual(['form', 'list', 'submit', 'form', 'list']);
    expect(w.ashby.submits()).toHaveLength(1);
    expect(outcome(w, b)).toBe('processed');
    expect(infoLines(w, R1_MEET_FEEDBACK_ALREADY_POSTED_LOG)).toHaveLength(1);
  });

  it('a card that landed before the job dead-lettered: the manual re-post finds it and posts nothing', async () => {
    const { w, b } = await publicWorld();
    w.ashby.next('submit', 'lost');
    const last = w.queueJob(b.job!.payload, { attempts: 5, maxAttempts: 5, deferCount: R1_MEET_DEFER_MAX_COUNT, deferredAt: HARNESS_NOW });
    await expect(w.dispatcher.handle(last)).rejects.toThrow('r1_meet_feedback_ashby_unavailable');
    expect(outcome(w, b)).toBe('failed');

    await expect(w.dispatcher.handle(w.queueJob(r1MeetJobs.scorecardFeedback(b.bookingId, b.assessmentId).payload))).resolves.toBeUndefined();
    expect(jobLines(w).at(-1)).toBe('scorecard_feedback:already_posted');
    expect(w.ashby.submits()).toHaveLength(1);
    expect(outcome(w, b)).toBe('processed');
  });

  it('a failed settle after already_posted only warns; the dispatcher finishes the receipt', async () => {
    const { w, b } = await publicWorld();
    w.ashby.feedbackList = [dexCard(w, b)];
    const deps: R1MeetFlowDeps = {
      ...w.deps,
      feedback: {
        ...w.feedback,
        store: {
          ...w.store,
          settleReceipt: async () => {
            throw new R1MeetJobError('r1_meet_db_error');
          },
        },
      },
    };
    const dispatcher = createR1MeetDispatcher({ flowDeps: () => deps, active: () => true });
    await expect(dispatcher.handle(w.queueJob(b.job!.payload))).resolves.toBeUndefined();
    expect(w.h.logs.filter((line) => line.level === 'warn').map((line) => line.meta)).toEqual([
      { error_category: 'r1_meet_feedback_receipt_settle_failed' },
    ]);
    expect(outcome(w, b)).toBe('processed');
    expect(w.ashby.submits()).toHaveLength(0);
  });

  it.each([
    [{ attempts: 1, deferCount: 1, lastDeferReason: 'feedback_list_unavailable', lastError: null }],
    [{ attempts: 1, deferCount: 1, lastDeferReason: 'feedback_list_rate_limited', lastError: null }],
    [{ attempts: 2, deferCount: 0, lastDeferReason: null, lastError: 'r1_meet_feedback_list_unavailable' }],
    [{ attempts: 2, deferCount: 0, lastDeferReason: null, lastError: 'r1_meet_feedback_list_rate_limited' }],
  ])('one earlier run that stopped at the list cannot have submitted: %o', (meta) => {
    expect(r1MeetFeedbackSubmitMayHaveRun(meta)).toBe(false);
  });

  it('more than one earlier run is still unknown (the rule is unchanged)', () => {
    expect(r1MeetFeedbackSubmitMayHaveRun({ attempts: 1, deferCount: 2, lastDeferReason: 'feedback_list_unavailable', lastError: null })).toBe(true);
    expect(r1MeetFeedbackSubmitMayHaveRun({ attempts: 2, deferCount: 1, lastDeferReason: 'feedback_list_rate_limited', lastError: null })).toBe(true);
  });

  it('after one list wait, a refused first submit is ashby_rejected (no card can be there yet)', async () => {
    const { w, b } = await publicWorld();
    w.ashby.next('submit', { status: 403, body: { success: false, errors: ['missing_endpoint_permission'] } });
    expect(await run(w, b, { deferCount: 1, deferredAt: HARNESS_NOW, lastDeferReason: 'feedback_list_unavailable' })).toEqual(r1MeetIgnored('ashby_rejected'));
    expect(ops(w)).toEqual(['form', 'list', 'submit']);
    expect(outcome(w, b)).toBe('failed');
  });

  it('a general submit Ashby answers 429 or 5xx defers like an event submit', async () => {
    const { w, b } = await publicWorld();
    w.ashby.next('submit', { status: 429, body: '' });
    expect(await run(w, b)).toEqual(r1MeetDefer('ashby_rate_limited', R1_MEET_FEEDBACK_DEFER.rateLimited));
    w.ashby.next('submit', { status: 503, body: '' });
    expect(await run(w, b, { ...RERUN, lastDeferReason: 'ashby_rate_limited' })).toEqual(r1MeetDefer('ashby_unavailable', R1_MEET_FEEDBACK_DEFER.unavailable));
    expect(w.ashby.submits().every((submit) => submit.raw === expectedGeneralBody(b))).toBe(true);
  });

  it.each([
    ['no session', 'booking_unbound', (w: R1MeetFeedbackWorld, b: CompletedBooking) => {
      w.h.db.booking(b.bookingId)!.session_id = null;
    }],
    ['no round', 'booking_unbound', (w: R1MeetFeedbackWorld, b: CompletedBooking) => {
      w.h.db.booking(b.bookingId)!.round_id = null;
    }],
    ['stale', 'stale', (w: R1MeetFeedbackWorld, b: CompletedBooking) => {
      w.h.setNow(Date.parse(w.h.db.booking(b.bookingId)!.end_at as string) + 7 * DAY_MS + 1);
    }],
    ['a withdrawn consent', 'consent_withdrawn', (w: R1MeetFeedbackWorld, b: CompletedBooking) => {
      w.h.db.tables.interview_round_consents.push({ id: fixtureId(), round_id: b.roundId, withdrawn_at: HARNESS_NOW, proof: { decision: 'withdrawn' } });
    }],
  ] as Array<[string, string, (w: R1MeetFeedbackWorld, b: CompletedBooking) => void]>)('the earlier guards still hold for it (%s): no Ashby call', async (_label, code, change) => {
    const { w, b } = await publicWorld();
    change(w, b);
    expect(await run(w, b)).toEqual(r1MeetIgnored(code));
    expect(w.ashby.requests).toEqual([]);
  });

  it('an Ashby booking never lists: [form, submit] and the event body, even with a Dex card in the list', async () => {
    const { w, b } = await world();
    w.ashby.feedbackList = [dexCard(w, b)];
    expect(await run(w, b)).toEqual(r1MeetProcessed('submitted'));
    expect(ops(w)).toEqual(['form', 'submit']);
    expect(w.ashby.lists()).toEqual([]);
    expect(w.ashby.submits()[0]!.raw).toBe(expectedBody(b));
    expect(JSON.parse(w.ashby.submits()[0]!.raw)).toHaveProperty('interviewEventId', EVENT_ID);
  });

  it('logs stay closed words: no id, card text, name or email from the list', async () => {
    const { w, b } = await publicWorld();
    w.ashby.feedbackList = [dexCard(w, b), dexCard(w, b, { submittedByUser: { id: OTHER_USER_ID, email: SENTINELS.email }, creditedToUser: null })];
    await w.dispatcher.handle(w.queueJob(b.job!.payload));
    const second = await w.completedBooking({ source: 'public_page', applicationId: fixtureId() });
    w.ashby.next('list', { status: 200, body: { success: true, results: [{ submittedByUser: { email: SENTINELS.email }, submittedValues: SENTINELS.quote }] } });
    await w.dispatcher.handle(w.queueJob(second.job!.payload));
    w.ashby.next('list', { status: 403, body: { success: false, errors: [{ code: 'forbidden', message: SENTINELS.name }] } });
    await w.dispatcher.handle(w.queueJob(second.job!.payload, { deferCount: 1, deferredAt: HARNESS_NOW }));

    const ids = [b, second].flatMap((booking) => [
      booking.bookingId, booking.roundId, booking.sessionId, booking.candidateId, booking.assessmentId, booking.applicationId,
    ]);
    ids.push(FEEDBACK_FORM_ID, DEX_USER_ID, OTHER_USER_ID);
    for (const line of w.h.logs) {
      expect(Object.keys(line.meta).every((key) => ['error_category', 'error_type', 'http_status'].includes(key)), JSON.stringify(line)).toBe(true);
      expect(line.meta.error_category).toMatch(/^[a-z0-9_]{1,64}$/);
      expect(line.meta.error_type ?? '').toMatch(/^[A-Za-z0-9_.:]{0,64}$/);
    }
    const text = JSON.stringify(w.h.logs);
    for (const value of ids) expect(text).not.toContain(value);
    expect(text).not.toMatch(/https?:|example\.test|SENTINEL|sentinel|cursor/);
    expect(jobLines(w)).toEqual([
      'scorecard_feedback:already_posted',
      'scorecard_feedback:feedback_list_unavailable',
      'scorecard_feedback:feedback_list_rejected',
    ]);
  });
});
