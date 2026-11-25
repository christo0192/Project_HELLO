/**
 * The `scorecard_feedback` world (M034 S09 T3): everything Dex's Ashby feedback job runs against,
 * in memory, with the REAL code wherever it exists.
 *
 *  - The S06 flow harness (`createR1MeetHarness`): the in-memory 0142 port (bookings, receipts,
 *    rounds, sessions, consents, the job queue and the real `r1_meet_record_receipt` port), a
 *    settable clock and the captured log lines.
 *  - The feedback store: the REAL `createR1MeetFeedbackStore` over an in-memory client, so the 0142
 *    receipt rules hold exactly as in production: the receipt and its job in one RPC transaction,
 *    the receipt CHECKs (source and key space, `processed_at` set exactly when final), and the
 *    store's own outcome compare-and-sets. Two tables the 0142 port does not have, `assessments` and
 *    `candidates`, are kept here (`tables`), each with the reads the store makes.
 *  - The Ashby fake: a scripted `AshbyTransport` that records every request and answers the form read
 *    and the submit, under the REAL Ashby client and the REAL feedback port (`maxAttempts: 1`).
 *    `next(op, step)` queues one answer for the next request of that operation: a status and body,
 *    `network` (nothing reached Ashby), `timeout` (the client's deadline fired) or `lost` (Ashby took
 *    the submit, then the answer was lost: it is recorded as accepted, then the call fails).
 *  - `completedBooking()`: a booking that its attempt settled (`completed / attempt_settled`) with its
 *    Meet round, session, candidate and final v2 assessment, and (by default) the receipt and job the
 *    scorecard-ready trigger records.
 *
 * Fixture ids live in `7f000000-0000-4000-8000-…` (the 0142 port's own in `…-9000-…`). The Ashby key is
 * a short synthetic literal; no name, email, phone or real id exists anywhere. The assessment row
 * carries SENTINEL strings in the places that must never reach Ashby (evidence quotes, `raw`, the
 * candidate's name and contact columns) so a test can prove they never do. Never shipped:
 * `tsconfig.build.json` excludes `src/__tests__`.
 */

import type { AshbyTransport, AshbyTransportRequest, AshbyTransportResponse } from '../../integrations/ashby/client.js';
import type { R1MeetFeedbackConfig } from '../../lib/r1/meet/config.js';
import { createR1MeetDispatcher, type R1MeetDispatcher } from '../../lib/r1/meet/dispatcher.js';
import { createR1MeetAshbyFeedbackPort, type R1MeetAshbyFeedbackPort } from '../../lib/r1/meet/feedback-ashby.js';
import type { R1MeetFeedbackDeps } from '../../lib/r1/meet/feedback.js';
import {
  createR1MeetFeedbackStore,
  r1MeetFeedbackReceiptKey,
  type R1MeetFeedbackStore,
} from '../../lib/r1/meet/feedback-store.js';
import { R1_MEET_QUEUE } from '../../lib/r1/meet/jobs.js';
import type { R1MeetFlowDeps } from '../../lib/r1/meet/recall-actions.js';
import type { QueueJob } from '../../lib/queue/types.js';
import type { supabase } from '../../lib/supabase.js';
import { R1_METRICS } from '../../lib/r1/rubric.js';
import { BRIDGE_PAGE_URL, HARNESS_NOW, createR1MeetHarness, fixtureId, type R1MeetHarness } from './r1-meet-harness.js';
import type { Row } from './r1-meet-fake-db.js';

export const FEEDBACK_FORM_ID = '7f000000-0000-4000-8000-00000000f001';
export const DEX_USER_ID = '7f000000-0000-4000-8000-000000000601';
export const FEEDBACK_API_KEY = 'synthetic-key';

/** Planted where nothing may ever be copied from: evidence quotes, `raw`, the candidate's identity. */
export const SENTINELS = Object.freeze({
  quote: 'SENTINEL-QUOTE-7311',
  raw: 'SENTINEL-RAW-7312',
  name: 'SENTINEL-NAME-7313',
  email: 'sentinel-7314@example.test',
  phone: '+910000007315',
  transcript: 'SENTINEL-TRANSCRIPT-7316',
});

// ── The live form definition (Ashby's `feedbackFormDefinition.info` results) ──

const FOUR = ['1', '2', '3', '4'].map((value) => ({ value, label: value }));

export interface DefinitionField {
  readonly isRequired: boolean;
  readonly field: Record<string, unknown>;
}

/** The Dex form as the runbook sets it up: Overall, Summary, Detailed report, five metric scores. */
export function dexFormFields(): DefinitionField[] {
  return [
    { isRequired: true, field: { id: 'fld-overall', type: 'ValueSelect', path: 'overall_recommendation', title: 'Overall Recommendation', selectableValues: FOUR } },
    { isRequired: true, field: { id: 'fld-summary', type: 'RichText', path: 'summary_path', title: 'Summary' } },
    { isRequired: false, field: { id: 'fld-report', type: 'Url', path: 'report_path', title: 'Detailed report' } },
    ...R1_METRICS.map((metric, i) => ({
      isRequired: false,
      field: { id: `fld-metric-${i}`, type: 'Score', path: `metric_path_${i}`, title: metric.name, selectableValues: FOUR },
    })),
  ];
}

export function dexFormDefinition(
  over: { readonly id?: string; readonly isArchived?: boolean; readonly fields?: readonly DefinitionField[] } = {},
): Record<string, unknown> {
  return {
    id: over.id ?? FEEDBACK_FORM_ID,
    title: 'Dex R1 interview',
    isArchived: over.isArchived ?? false,
    formDefinition: { sections: [{ id: 'sec-1', title: 'Scorecard', fields: [...(over.fields ?? dexFormFields())] }] },
  };
}

// ── The final v2 assessment of a Meet attempt ────────────────────────────────

/** The `assessments` row the R1 scorer persists (v2, hold at 55, one metric not scored). */
export function finalAssessmentRow(id: string, sessionId: string, over: Partial<Row> = {}): Row {
  return {
    id,
    session_id: sessionId,
    schema_version: 2,
    recommendation: 'hold',
    overall_score: 55,
    weighted_score_5: 2.65,
    score_scale_max: 4,
    metric_results: R1_METRICS.map((metric, i) => ({
      metric: { key: metric.key, name: metric.name },
      score: i === 3 ? null : [3, 3, 2, 0, 3][i],
      evidenceStatus: i === 3 ? 'insufficient_evidence' : 'scored',
      rationale: `Rationale ${i}.`,
      evidence: [{ turn_index: 2, quote: SENTINELS.quote }],
      evidenceRefs: [{ turn_index: 2, quote: SENTINELS.quote }],
    })),
    raw: { transcript: SENTINELS.transcript, note: SENTINELS.raw },
    ...over,
  };
}

// ── The scripted Ashby transport ─────────────────────────────────────────────

export type AshbyOp = 'form' | 'submit' | 'other';
export type AshbyStep =
  | { readonly status: number; readonly body?: unknown; readonly headers?: Record<string, string> }
  | 'network'
  | 'timeout'
  | 'lost';

export interface AshbyRequestRecord {
  readonly op: AshbyOp;
  readonly path: string;
  /** Lower-cased names; `authorization` redacted. */
  readonly headers: Record<string, string>;
  /** The JSON body exactly as sent (key order kept). */
  readonly raw: string;
  readonly body: unknown;
  /** The submit reached Ashby (a `lost` step counts: Ashby stored it). */
  readonly accepted: boolean;
}

export interface ScriptedAshby {
  readonly transport: AshbyTransport;
  readonly requests: AshbyRequestRecord[];
  /** The definition the form read answers (replace it to break the form). */
  definition: Record<string, unknown>;
  next(op: AshbyOp, step: AshbyStep): void;
  /** The submit requests, in order. */
  submits(): AshbyRequestRecord[];
  forms(): AshbyRequestRecord[];
}

function opOf(path: string): AshbyOp {
  if (path === '/applicationFeedback.submit') return 'submit';
  if (path === '/feedbackFormDefinition.info') return 'form';
  return 'other';
}

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

export function createScriptedAshby(): ScriptedAshby {
  const requests: AshbyRequestRecord[] = [];
  const queued = new Map<AshbyOp, AshbyStep[]>();
  const fake = {
    requests,
    definition: dexFormDefinition(),
  } as ScriptedAshby;

  const transport: AshbyTransport = async (req: AshbyTransportRequest) => {
    const path = new URL(req.url).pathname;
    const op = opOf(path);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      headers[name.toLowerCase()] = name.toLowerCase() === 'authorization' ? '<redacted>' : value;
    }
    const step = queued.get(op)?.shift();
    const accepted = op === 'submit' && (step === undefined || step === 'lost' || (typeof step === 'object' && step.status < 300));
    requests.push({ op, path, headers, raw: req.body, body: JSON.parse(req.body) as unknown, accepted });
    if (step === 'network' || step === 'lost') throw new Error('fake ashby network failure');
    if (step === 'timeout') {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    }
    if (step !== undefined) return answer(step.status, step.body, step.headers);
    if (op === 'form') return answer(200, { success: true, results: fake.definition });
    if (op === 'submit') {
      return answer(200, { success: true, results: { submittedFormInstance: { id: '7f000000-0000-4000-8000-00000000fa01' } } });
    }
    return answer(404, { success: false, errors: ['not_found'] });
  };

  return Object.assign(fake, {
    transport,
    next(op: AshbyOp, step: AshbyStep) {
      const list = queued.get(op) ?? [];
      list.push(step);
      queued.set(op, list);
    },
    submits: () => requests.filter((request) => request.op === 'submit'),
    forms: () => requests.filter((request) => request.op === 'form'),
  });
}

// ── The two tables the 0142 port does not hold ───────────────────────────────

interface ExtraTables {
  assessments: Row[];
  candidates: Row[];
}

type Answer = { data: unknown; error: { code: string; message: string } | null };

/** select / eq / in / maybeSingle over plain rows: the reads the feedback store makes of these tables. */
class MemoryQuery {
  private readonly filters: Array<(row: Row) => boolean> = [];
  private columns = '*';

  constructor(private readonly rows: () => Row[], private readonly fail: boolean) {}

  select(columns = '*'): this {
    this.columns = columns;
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push((row) => row[column] === value);
    return this;
  }

  in(column: string, values: readonly unknown[]): this {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }

  private run(): Answer {
    if (this.fail) return { data: null, error: { code: 'XX000', message: 'fake_db_failure' } };
    const rows = this.rows().filter((row) => this.filters.every((filter) => filter(row)));
    const columns = this.columns.trim() === '*' ? null : this.columns.split(',').map((column) => column.trim());
    return {
      data: rows.map((row) => {
        if (columns === null) return structuredClone(row);
        const out: Row = {};
        for (const column of columns) out[column] = row[column] === undefined ? null : structuredClone(row[column]);
        return out;
      }),
      error: null,
    };
  }

  async maybeSingle(): Promise<Answer> {
    const result = this.run();
    if (result.error) return result;
    const rows = result.data as Row[];
    if (rows.length > 1) return { data: null, error: { code: 'PGRST116', message: 'more than one row' } };
    return { data: rows[0] ?? null, error: null };
  }

  then<A = Answer, B = never>(
    onFulfilled?: ((value: Answer) => A | PromiseLike<A>) | null,
    onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return Promise.resolve(this.run()).then(onFulfilled, onRejected);
  }
}

// ── The world ───────────────────────────────────────────────────────────────

export interface CompletedBookingOptions {
  readonly channel?: 'browser' | 'meet';
  readonly eventId?: string;
  readonly applicationId?: string;
  readonly startAt?: string;
  readonly endAt?: string;
  /** Overrides of the assessment row (`finalAssessmentRow`). */
  readonly assessment?: Partial<Row>;
  /** Record the trigger's receipt and job (default true). */
  readonly record?: boolean;
}

export interface CompletedBooking {
  readonly bookingId: string;
  readonly roundId: string;
  readonly sessionId: string;
  readonly candidateId: string;
  readonly assessmentId: string;
  readonly eventId: string;
  readonly applicationId: string;
  /** The feedback receipt key. */
  readonly key: string;
  /** The `r1-meet` job the trigger queued (its payload carries `receipt_id` and `source`), or null. */
  readonly job: Row | null;
}

export interface R1MeetFeedbackWorld {
  readonly h: R1MeetHarness;
  /** The harness ports plus `feedback`. */
  readonly deps: R1MeetFlowDeps;
  readonly feedback: R1MeetFeedbackDeps;
  readonly store: R1MeetFeedbackStore;
  readonly port: R1MeetAshbyFeedbackPort;
  readonly ashby: ScriptedAshby;
  readonly tables: ExtraTables;
  /** The real dispatcher over `deps`, always active. */
  readonly dispatcher: R1MeetDispatcher;
  setConfig(config: R1MeetFeedbackConfig): void;
  /** False: `ashby()` answers null (no usable Ashby key). */
  setKeyConfigured(configured: boolean): void;
  /** False: `ashbyActive()` answers false (Ashby's master or runtime switch is off). */
  setAshbyActive(active: boolean): void;
  /** The next read of `assessments` or `candidates` answers a DB error. */
  failNext(table: keyof ExtraTables): void;
  completedBooking(options?: CompletedBookingOptions): Promise<CompletedBooking>;
  /** The receipt row of a key (the raw 0142 row), or undefined. */
  receiptRow(key: string): Row | undefined;
  /** A claimed `r1-meet` job of this payload, as the queue hands it to the dispatcher. */
  queueJob(payload: unknown, over?: Partial<QueueJob<unknown>>): QueueJob<unknown>;
}

export function createR1MeetFeedbackWorld(): R1MeetFeedbackWorld {
  const h = createR1MeetHarness();
  const tables: ExtraTables = { assessments: [], candidates: [] };
  const failures = new Set<keyof ExtraTables>();

  // The 0142 port, as the plain double it is (its typed face is the Supabase client's).
  const port0142 = h.db.client as unknown as {
    from(table: string): unknown;
    rpc(name: string, args: Record<string, unknown>): unknown;
  };
  const client = {
    from(table: string) {
      if (table === 'assessments' || table === 'candidates') {
        h.db.calls.push({ kind: 'from', name: table });
        const fail = failures.delete(table);
        return new MemoryQuery(() => tables[table], fail);
      }
      return port0142.from(table);
    },
    rpc(name: string, args: Record<string, unknown>) {
      return port0142.rpc(name, args);
    },
  };
  const store = createR1MeetFeedbackStore(client as unknown as typeof supabase);
  const ashby = createScriptedAshby();
  const port = createR1MeetAshbyFeedbackPort({ apiKey: FEEDBACK_API_KEY, log: h.deps.log, transport: ashby.transport });

  let config: R1MeetFeedbackConfig = Object.freeze({ status: 'on', formDefinitionId: FEEDBACK_FORM_ID });
  let keyConfigured = true;
  let ashbyActive = true;
  const feedback: R1MeetFeedbackDeps = Object.freeze({
    config: () => config,
    store,
    ashbyActive: () => ashbyActive,
    ashby: () => (keyConfigured ? port : null),
    dexUserId: DEX_USER_ID,
    bridgePageUrl: BRIDGE_PAGE_URL,
  });
  const deps: R1MeetFlowDeps = { ...h.deps, feedback };
  const dispatcher = createR1MeetDispatcher({ flowDeps: () => deps, active: () => true });

  return {
    h,
    deps,
    feedback,
    store,
    port,
    ashby,
    tables,
    dispatcher,
    setConfig(next) {
      config = next;
    },
    setKeyConfigured(configured) {
      keyConfigured = configured;
    },
    setAshbyActive(active) {
      ashbyActive = active;
    },
    failNext(table) {
      failures.add(table);
    },
    async completedBooking(options = {}) {
      const nowMs = h.now();
      const round = h.db.addRound({ channel: options.channel ?? 'meet', status: 'completed' });
      const session = h.db.addSession({ interview_round_id: round.id, status: 'completed' });
      const assessmentId = fixtureId();
      round.assessment_id = assessmentId;
      tables.candidates.push({
        id: round.candidate_id,
        decision_use_blocked_at: null,
        name: SENTINELS.name,
        email: SENTINELS.email,
        phone: SENTINELS.phone,
      });
      tables.assessments.push(finalAssessmentRow(assessmentId, session.id, options.assessment));
      const startAt = options.startAt ?? new Date(nowMs - 2 * 3600 * 1000).toISOString();
      const endAt = options.endAt ?? new Date(Date.parse(startAt) + 45 * 60 * 1000).toISOString();
      const eventId = options.eventId ?? fixtureId();
      const applicationId = options.applicationId ?? fixtureId();
      const booking = h.db.seedBooking({
        ashby_interview_event_id: eventId,
        ashby_application_id: applicationId,
        round_id: round.id,
        status: 'completed',
        reason: 'attempt_settled',
        session_id: session.id,
        start_at: startAt,
        end_at: endAt,
      });
      const key = r1MeetFeedbackReceiptKey(booking.id, assessmentId);
      let job: Row | null = null;
      if (options.record !== false) {
        const recorded = await store.recordFeedback(booking.id, assessmentId, nowMs);
        if (recorded.status === 'refused') throw new Error(`feedback world: the receipt was refused (${recorded.reason})`);
        job = h.db.jobs('scorecard_feedback').find((row) => row.payload?.receipt_id === recorded.id) ?? null;
      }
      return {
        bookingId: booking.id,
        roundId: round.id,
        sessionId: session.id,
        candidateId: round.candidate_id,
        assessmentId,
        eventId: booking.ashby_interview_event_id,
        applicationId,
        key,
        job,
      };
    },
    receiptRow(key) {
      return h.db.tables.r1_meet_receipts.find((row) => row.dedupe_key === key);
    },
    queueJob(payload, over = {}) {
      return {
        id: fixtureId(),
        name: R1_MEET_QUEUE,
        payload,
        status: 'active',
        attempts: 1,
        maxAttempts: 5,
        priority: 0,
        scheduledAt: HARNESS_NOW,
        createdAt: HARNESS_NOW,
        deferCount: 0,
        ...over,
      };
    },
  };
}
