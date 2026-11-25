/**
 * The `r1-meet` flow harness (M034 S06 T2, shared with T3..T5): the REAL Recall client
 * (`createRecallClient`) over the S01 Recall fake, the in-memory 0142 port, a settable clock, the
 * captured log lines (the flows' own and the Recall client's metadata lines), and one shared timeline
 * of `recall:<op>`, `db:<rpc>` and `queue:<kind>` steps, so a test can pin the exact call order.
 *
 * `intercept(match, response)` answers ONE matching Recall request instead of the fake: a canned
 * status (not cached, unlike `recall.failNext`), `network` (nothing reached Recall), `hang` (no answer:
 * the client's deadline fires), or `lost` (the fake handled it, and cached it under its key, then the
 * answer was lost). `afterRecall` runs after each forwarded request, so a test can change the
 * database between a create and its attach.
 *
 * Fixture ids live in `7f000000-0000-4000-8000-…`; the worker secret is built at run time; no name or
 * email exists anywhere. Never shipped: `tsconfig.build.json` excludes `src/__tests__`.
 */

import { createRecallClient, type RecallClient, type RecallTransport, type RecallTransportRequest, type RecallTransportResponse } from '../../integrations/recall/client.js';
import { r1MeetJobMeta, type R1MeetJobMeta } from '../../lib/r1/meet/jobs.js';
import {
  r1MeetRecallClientLogger,
  type R1MeetFlowConfig,
  type R1MeetFlowDeps,
  type R1MeetLog,
  type R1MeetLogMeta,
} from '../../lib/r1/meet/recall-actions.js';
import type { R1MeetCreateAnswer } from '../../lib/r1/meet/runtime-store.js';
import { FAKE_RECALL_API_KEY, createFakeRecall, type FakeRecall } from './recall-fake.js';
import { createR1MeetFakeDb, type R1MeetFakeDb } from './r1-meet-fake-db.js';

export const HARNESS_NOW = '2030-01-01T10:00:00.000Z';
export const WEB_ORIGIN_FIXTURE = 'https://hello.example.test';
export const BRIDGE_PAGE_URL = `${WEB_ORIGIN_FIXTURE}/candidate/r1/meet`;
export const REALTIME_URL = `${WEB_ORIGIN_FIXTURE}/api/integrations/recall/realtime`;
export const MEET_URL = 'https://meet.google.com/abc-defg-hij';
export const OTHER_MEET_URL = 'https://meet.google.com/xyz-wxyz-xyz';
/** The bridge key source: a worker secret built at run time (never a secret-shaped literal). */
export const BRIDGE_SOURCE = { WORKER_CONTEXT_SECRET: 'w'.repeat(40) } as NodeJS.ProcessEnv;

let fixtureCounter = 0x100;
/** A fresh fixture id in the test namespace. */
export function fixtureId(): string {
  fixtureCounter += 1;
  return `7f000000-0000-4000-8000-${fixtureCounter.toString(16).padStart(12, '0')}`;
}

export const SCHEDULER_ID = '7f000000-0000-4000-8000-0000000000b5';
export const STAFF_USER_ID = '7f000000-0000-4000-8000-0000000000c3';

export type RecallOp = 'create' | 'get' | 'delete' | 'leave' | 'output_media' | 'output_media_stop' | 'other';

export function recallOp(req: Pick<RecallTransportRequest, 'method' | 'url'>): RecallOp {
  const path = new URL(req.url).pathname;
  if (path === '/api/v1/bot/') return req.method === 'POST' ? 'create' : 'other';
  if (/\/leave_call\/$/.test(path)) return 'leave';
  if (/\/output_media\/$/.test(path)) return req.method === 'POST' ? 'output_media' : 'output_media_stop';
  if (req.method === 'GET') return 'get';
  if (req.method === 'DELETE') return 'delete';
  return 'other';
}

export type InterceptResponse =
  | { readonly status: number; readonly body?: unknown; readonly headers?: Record<string, string> }
  | 'network'
  | 'lost'
  | 'hang';

export interface LogLine {
  readonly level: 'info' | 'warn' | 'error';
  readonly meta: R1MeetLogMeta;
}

export interface R1MeetHarness {
  readonly db: R1MeetFakeDb;
  readonly recall: FakeRecall;
  readonly client: RecallClient;
  readonly deps: R1MeetFlowDeps;
  readonly config: { -readonly [K in keyof R1MeetFlowConfig]: R1MeetFlowConfig[K] };
  readonly timeline: string[];
  readonly logs: LogLine[];
  /** Every hot-window hint the flows emitted (`deps.hotUntil`), as epoch ms, in order. */
  readonly hot: number[];
  /** Every in-run wait the flows asked for (`deps.sleep`), in ms; each one advances the clock. */
  readonly sleeps: number[];
  /** Every Recall request as sent (headers lower-cased; authorization redacted). */
  readonly requests: Array<{ op: RecallOp; method: string; path: string; headers: Record<string, string>; body: unknown }>;
  now(): number;
  setNow(value: string | number): void;
  advance(ms: number): void;
  intercept(match: RecallOp | ((req: RecallTransportRequest, op: RecallOp) => boolean), response: InterceptResponse): void;
  afterRecall: ((op: RecallOp, response: unknown) => void) | null;
  /** Errors logged at error level, as their categories. */
  alerts(): string[];
  /** A `pending` booking through the real create RPC: an application link, a staff user, a slot. */
  createBooking(options?: CreateBookingOptions): Promise<Extract<R1MeetCreateAnswer, { status: 'created' | 'relinked' }>>;
  /** A first run of a job (attempts 1, no deferral), or the meta you ask for. */
  meta(
    overrides?: Partial<Pick<R1MeetJobMeta, 'attempts' | 'maxAttempts' | 'deferCount' | 'deferredAt' | 'lastDeferReason' | 'lastError'>>,
  ): R1MeetJobMeta;
}

export interface CreateBookingOptions {
  readonly eventId?: string;
  readonly scheduleId?: string;
  readonly applicationId?: string;
  readonly startAt?: string;
  readonly endAt?: string;
  readonly meetUrl?: string;
}

export interface HarnessOptions {
  readonly config?: Partial<R1MeetFlowConfig>;
  readonly ticketSource?: NodeJS.ProcessEnv;
  readonly random?: (bytes: number) => Buffer;
  /** The Recall client deadline (a timeout test uses a few ms). */
  readonly timeoutMs?: number;
}

function canned(status: number, body: unknown = undefined, headers: Record<string, string> = {}): RecallTransportResponse {
  const lower: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) lower[name.toLowerCase()] = value;
  const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  return { status, headers: { get: (name: string) => lower[name.toLowerCase()] ?? null }, text: async () => text };
}

export function createR1MeetHarness(options: HarnessOptions = {}): R1MeetHarness {
  let nowMs = Date.parse(HARNESS_NOW);
  const timeline: string[] = [];
  const logs: LogLine[] = [];
  const hot: number[] = [];
  const sleeps: number[] = [];
  const db = createR1MeetFakeDb({ timeline, now: () => nowMs });
  const recall = createFakeRecall();
  const interceptors: Array<{ match: (req: RecallTransportRequest, op: RecallOp) => boolean; response: InterceptResponse }> = [];
  const requests: R1MeetHarness['requests'] = [];

  const log: R1MeetLog = {
    info: (meta) => logs.push({ level: 'info', meta }),
    warn: (meta) => logs.push({ level: 'warn', meta }),
    error: (meta) => logs.push({ level: 'error', meta }),
  };

  const harness = {} as { afterRecall: R1MeetHarness['afterRecall'] };
  harness.afterRecall = null;

  const transport: RecallTransport = async (req) => {
    const op = recallOp(req);
    timeline.push(`recall:${op}`);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) headers[name.toLowerCase()] = name.toLowerCase() === 'authorization' ? '<redacted>' : value;
    requests.push({
      op,
      method: req.method,
      path: new URL(req.url).pathname,
      headers,
      body: req.body === undefined ? null : (JSON.parse(req.body) as unknown),
    });
    const index = interceptors.findIndex((entry) => entry.match(req, op));
    if (index !== -1) {
      const [entry] = interceptors.splice(index, 1);
      const response = entry!.response;
      if (response === 'network') throw new Error('fake network failure');
      // Never answers: the client's own deadline turns it into a timeout.
      if (response === 'hang') return new Promise<RecallTransportResponse>(() => {});
      if (response === 'lost') {
        await recall.transport(req);
        throw new Error('fake lost answer');
      }
      return canned(response.status, response.body, response.headers);
    }
    const response = await recall.transport(req);
    if (harness.afterRecall) {
      const text = await response.text();
      harness.afterRecall(op, text === '' ? null : (JSON.parse(text) as unknown));
    }
    return response;
  };

  const client = createRecallClient({
    apiKey: FAKE_RECALL_API_KEY,
    transport,
    logger: r1MeetRecallClientLogger(log),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });

  const config = {
    dailyBotCap: 20,
    botNameOverride: null,
    armAtCreate: false,
    bridgePageUrl: BRIDGE_PAGE_URL,
    recallRealtimeWebhookUrl: REALTIME_URL,
    recall: { googleLoginGroupId: null },
    serviceUserId: STAFF_USER_ID,
    multiHumanPolicy: 'end',
    ...options.config,
  } as R1MeetHarness['config'];

  const deps: R1MeetFlowDeps = {
    store: db.store,
    recall: client,
    config,
    enqueue: async (spec, opts) => {
      db.enqueue(spec, opts?.scheduledAt === undefined ? {} : { scheduledAt: opts.scheduledAt });
    },
    now: () => nowMs,
    log,
    ticketSource: options.ticketSource ?? BRIDGE_SOURCE,
    ...(options.random === undefined ? {} : { random: options.random }),
    hotUntil: (untilMs) => {
      hot.push(untilMs);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      nowMs += ms;
    },
  };

  db.users.add(STAFF_USER_ID);

  return Object.assign(harness, {
    db,
    recall,
    client,
    deps,
    config,
    timeline,
    logs,
    hot,
    sleeps,
    requests,
    now: () => nowMs,
    setNow(value: string | number) {
      nowMs = typeof value === 'number' ? value : Date.parse(value);
    },
    advance(ms: number) {
      nowMs += ms;
    },
    intercept(match: RecallOp | ((req: RecallTransportRequest, op: RecallOp) => boolean), response: InterceptResponse) {
      interceptors.push({ match: typeof match === 'string' ? (_req, op) => op === match : match, response });
    },
    alerts: () => logs.filter((line) => line.level === 'error').map((line) => line.meta.error_category),
    async createBooking(opts: CreateBookingOptions = {}) {
      const applicationId = opts.applicationId ?? fixtureId();
      const candidateId = fixtureId();
      db.linkApplication(applicationId, candidateId);
      const startAt = opts.startAt ?? new Date(nowMs + 24 * 3600 * 1000).toISOString();
      const endAt = opts.endAt ?? new Date(Date.parse(startAt) + 45 * 60 * 1000).toISOString();
      const answer = await db.store.createRound({
        eventId: opts.eventId ?? fixtureId(),
        scheduleId: opts.scheduleId ?? fixtureId(),
        applicationId,
        interviewStageId: null,
        interviewId: null,
        scheduledByUserId: SCHEDULER_ID,
        attestedAt: new Date(nowMs).toISOString(),
        ashbyUpdatedAt: new Date(nowMs).toISOString(),
        meetUrl: opts.meetUrl ?? MEET_URL,
        startAt,
        endAt,
        createdBy: STAFF_USER_ID,
        objectiveProfile: 'r1_dex_sales',
        nowIso: new Date(nowMs).toISOString(),
      });
      if (answer.status !== 'created' && answer.status !== 'relinked') {
        throw new Error(`harness: createBooking answered ${answer.status}`);
      }
      return answer;
    },
    meta(
      overrides: Partial<Pick<R1MeetJobMeta, 'attempts' | 'maxAttempts' | 'deferCount' | 'deferredAt' | 'lastDeferReason' | 'lastError'>> = {},
    ) {
      return r1MeetJobMeta({
        attempts: overrides.attempts ?? 1,
        maxAttempts: overrides.maxAttempts ?? 10,
        deferCount: overrides.deferCount ?? 0,
        deferredAt: overrides.deferredAt ?? undefined,
        createdAt: new Date(nowMs).toISOString(),
        deferReason: overrides.lastDeferReason ?? undefined,
        errorMessage: overrides.lastError ?? undefined,
      });
    },
  }) as R1MeetHarness;
}
