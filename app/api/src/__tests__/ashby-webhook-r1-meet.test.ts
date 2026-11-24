/**
 * M034 S03 T4: the existing Ashby webhook receiver (`routes/ashby-webhook.ts`) routes
 * `interviewScheduleCreate` / `interviewScheduleUpdate` into the `r1-meet` queue ONLY when R1 over
 * Google Meet is on (R1_MEET_ENABLED and R1_ENABLED), end to end on a bare Express app.
 *
 * Proves:
 *  (1) FLAG OFF is byte-identical to the legacy receiver (S03 plan R8). For every body (schedule
 *      Create, Update with a candidate id, Cancelled Update, a refused schedule, ping,
 *      candidateStageChange, applicationUpdate) and every flag-off variant (R1 off + Meet on, R1 on +
 *      Meet disabled, Meet seams omitted with the process env unset), the
 *      response status, raw text and JSON body equal what the UNCHANGED `ingestWebhook` answers with
 *      an independent outbox, mapped exactly as the route did before S03; the legacy outbox sees the
 *      same record inputs; the Meet port sees nothing. The schedule actions answer 400
 *      `unresolvable_id` with no receipt, and the non-schedule bodies never read a Meet seam.
 * (1b) MEET SET BUT INVALID (fix round S03-R4) is not "off": the two schedule actions answer a
 *      retryable 503 `r1_meet_misconfigured` with no receipt (Ashby redelivers once the configuration
 *      is fixed, instead of losing a cancellation to a non-retried 400), whether R1 is on or off. Every
 *      other action stays byte-identical and never reads a Meet seam.
 *  (2) FLAG ON (R9, R13): a Dex event gives one receipt and job with the exact T2 payload, a
 *      duplicate converges to one job, the legacy outbox is bypassed, a Dex-less Create is skipped, a
 *      Dex-less future Update and a Cancelled identity each give one schedule job, a refused
 *      non-cancelled schedule is 400, two Dex events give two jobs, port failures are retryable
 *      500s, ping and candidateStageChange keep the legacy path, and a disabled Ashby integration
 *      still answers 503 first.
 *  (3) PII: no email, name or dropped fixture value in anything the Meet port saw or any response.
 *
 * gitleaks: the Ashby HMAC secret and the Recall values are assembled from parts, and the Recall
 * workspace secret is generated at run time. Synthetic fixtures only (`support/ashby-schedule-fixture`).
 * `ashby-webhook-route.test.ts` is left untouched and still pins the legacy receiver on its own.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { createAshbyWebhookRouter, type AshbyWebhookRouterDeps } from '../routes/ashby-webhook.js';
import type { AshbyIntegrationConfig } from '../integrations/ashby/config.js';
import { ingestWebhook } from '../integrations/ashby/ingress.js';
import type { ReceiptStore, ReceiptOutcome } from '../integrations/ashby/ports.js';
import { getR1MeetConfig, type R1MeetConfig } from '../lib/r1/meet/config.js';
import {
  parseR1MeetAshbyScheduleWebhook,
  r1MeetAshbyScheduleDedupKey,
  type R1MeetAshbySchedule,
} from '../lib/r1/meet/ashby-schedule.js';
import {
  FIXTURE_APPLICATION_ID,
  FIXTURE_CANDIDATE_ID,
  FIXTURE_DEX_USER_ID,
  FIXTURE_DROPPED_VALUES,
  FIXTURE_END_TIME,
  FIXTURE_EVENT_ID,
  FIXTURE_EVENT_UPDATED_AT,
  FIXTURE_HR_USER_ID,
  FIXTURE_INTERVIEW_ID,
  FIXTURE_MEET_URL,
  FIXTURE_OTHER_INTERVIEWER_ID,
  FIXTURE_SCHEDULE_ID,
  FIXTURE_SCHEDULE_UPDATED_AT,
  FIXTURE_STAGE_ID,
  FIXTURE_START_TIME,
  makeAshbyInterviewEvent,
  makeAshbyInterviewSchedule,
  makeAshbyScheduleWebhookRaw,
} from './support/ashby-schedule-fixture.js';
import { makeRecallWebhookSecret } from './support/meet-webhook-signing.js';
import { createR1MeetReceiptsFake, type R1MeetReceiptsFake } from './support/r1-meet-receipts-fake.js';

// ── Ashby signing and the legacy outbox (pattern of ashby-webhook-route.test.ts:20-58) ──────────

// Built from parts so no secret-shaped literal exists in source (fixture only).
const SECRET = ['ashby', 'meet', 'route', 'test', 'hmac', 'fixture', 'value'].join('-');
const ACTIVE: AshbyIntegrationConfig = { enabled: true, webhookSecretConfigured: true, webhookSecret: SECRET };
const DISABLED: AshbyIntegrationConfig = { enabled: false, webhookSecretConfigured: false, webhookSecret: '' };

function sign(body: string): string {
  return 'sha256=' + createHmac('sha256', SECRET).update(Buffer.from(body, 'utf8')).digest('hex');
}

type RecordInput = Parameters<ReceiptStore['record']>[0];

/** In-memory transactional outbox (receipt + signal job in one atomic call) that keeps its inputs. */
class FakeOutbox implements ReceiptStore {
  receipts = new Map<string, string>();
  liveJobs = new Set<string>();
  /** A deep copy of every `record` input, in call order. */
  inputs: unknown[] = [];
  async record(input: RecordInput): Promise<ReceiptOutcome> {
    this.inputs.push(JSON.parse(JSON.stringify(input)) as unknown);
    const key = `${input.action}:${input.webhookActionId}`;
    const fresh = !this.receipts.has(key);
    if (fresh) this.receipts.set(key, `rcpt_${this.receipts.size + 1}`);
    let enqueued = false;
    let workPending = false;
    if (input.enqueue) {
      if (this.liveJobs.has(input.enqueue.dedupKey)) workPending = true;
      else { this.liveJobs.add(input.enqueue.dedupKey); enqueued = true; workPending = true; }
    }
    return { status: fresh ? 'inserted' : 'duplicate', id: this.receipts.get(key)!, enqueued, workPending };
  }
}

// ── Meet configs and the clock ──────────────────────────────────────────────

const CREATE = 'interviewScheduleCreate';
const UPDATE = 'interviewScheduleUpdate';
/** Six days before the fixture slot (2026-12-01T10:30Z), so the slot is in the future. */
const NOW_MS = Date.parse('2026-11-25T04:00:00.000Z');
const NOW_ISO = new Date(NOW_MS).toISOString();

const RECALL_API_VALUE = ['fixture', 'recall', 'api', 'value'].join('-');
const MEET_ON: R1MeetConfig = getR1MeetConfig({
  R1_MEET_ENABLED: 'true',
  RECALL_API_KEY: RECALL_API_VALUE,
  RECALL_WEBHOOK_SECRET: makeRecallWebhookSecret(),
  R1_MEET_ASHBY_DEX_USER_ID: FIXTURE_DEX_USER_ID,
  WEB_ORIGIN: 'https://hello.example.test',
});
const MEET_DISABLED: R1MeetConfig = getR1MeetConfig({});
// The invalid config logs its own one-time `[r1-meet-config]` line; silence it for this file.
const MEET_INVALID: R1MeetConfig = (() => {
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    return getR1MeetConfig({ R1_MEET_ENABLED: 'yes' });
  } finally {
    quiet.mockRestore();
  }
})();

const FLAG_OFF_VARIANTS = ['r1_off_meet_on', 'r1_on_meet_disabled', 'meet_seams_omitted'] as const;
/** Meet set but invalid (S03-R4): not "off" for the two schedule actions. */
const MEET_INVALID_VARIANTS = ['r1_on_meet_invalid', 'r1_off_meet_invalid'] as const;
type Variant = (typeof FLAG_OFF_VARIANTS)[number] | (typeof MEET_INVALID_VARIANTS)[number] | 'flag_on';

function harness(variant: Variant, config: AshbyIntegrationConfig = ACTIVE) {
  const outbox = new FakeOutbox();
  const meet: R1MeetReceiptsFake = createR1MeetReceiptsFake();
  const r1Spy = vi.fn(() => ({ enabled: variant !== 'r1_off_meet_on' && variant !== 'r1_off_meet_invalid' }));
  const meetSpy = vi.fn((): R1MeetConfig => {
    if (variant === 'r1_on_meet_disabled') return MEET_DISABLED;
    if (variant === 'r1_on_meet_invalid' || variant === 'r1_off_meet_invalid') return MEET_INVALID;
    return MEET_ON;
  });
  const nowSpy = vi.fn(() => NOW_MS);
  const deps: AshbyWebhookRouterDeps = { config, receipts: outbox, loggerComponent: 'ashby-webhook-r1-meet-test' };
  if (variant !== 'meet_seams_omitted') {
    deps.r1Meet = { r1Config: r1Spy, meetConfig: meetSpy, receipts: meet, now: nowSpy };
  }
  const app = express();
  app.use('/api/integrations/ashby', createAshbyWebhookRouter(deps));
  return { app, outbox, meet, r1Spy, meetSpy, nowSpy };
}

function post(app: express.Express, body: string, sig: string = sign(body)) {
  return request(app)
    .post('/api/integrations/ashby/webhook')
    .set('Content-Type', 'application/json')
    .set('Ashby-Signature', sig)
    .send(body);
}

/** What the receiver answered before S03: the unchanged `ingestWebhook`, mapped as the route did. */
async function legacyExpectation(raw: string): Promise<{ status: number; body: Record<string, unknown>; inputs: unknown[] }> {
  const independent = new FakeOutbox();
  const outcome = await ingestWebhook(JSON.parse(raw) as unknown, { receipts: independent });
  const body = outcome.httpStatus === 200 ? { ok: true, status: outcome.code } : { ok: false, error: outcome.code };
  return { status: outcome.httpStatus, body, inputs: independent.inputs };
}

// ── Bodies ──────────────────────────────────────────────────────────────────

const STAGE_BODY = JSON.stringify({
  action: 'candidateStageChange',
  data: { application: { id: 'app_123', currentInterviewStage: { id: 'stage_ai' }, job: { id: 'job_1' } } },
});
const PING_BODY = JSON.stringify({ action: 'ping', data: { webhookActionType: 'ping' } });
const APPLICATION_UPDATE_BODY = JSON.stringify({ action: 'applicationUpdate', id: 'evt_9', data: { application: { id: 'app_9' } } });

/** An event with only a non-Dex interviewer. */
const nonDexEvent = (): Record<string, unknown> => makeAshbyInterviewEvent({ interviewerIds: [FIXTURE_OTHER_INTERVIEWER_ID] });

/** A schedule whose parse is refused for an event-level reason (no interviewer data), with `status`. */
function refusedScheduleRaw(action: string, status: string): string {
  return makeAshbyScheduleWebhookRaw(
    action,
    makeAshbyInterviewSchedule({ status, interviewEvents: [makeAshbyInterviewEvent({ interviewers: null, interviewerUserIds: null })] }),
  );
}

const CREATE_RAW = makeAshbyScheduleWebhookRaw(CREATE);

const BODY_CASES = [
  { name: 'schedule Create', raw: CREATE_RAW, schedule: true },
  {
    name: 'schedule Update with candidateId',
    raw: makeAshbyScheduleWebhookRaw(UPDATE, makeAshbyInterviewSchedule(), { candidateId: FIXTURE_CANDIDATE_ID }),
    schedule: true,
  },
  { name: 'schedule Update, Cancelled', raw: makeAshbyScheduleWebhookRaw(UPDATE, makeAshbyInterviewSchedule({ status: 'Cancelled' })), schedule: true },
  { name: 'a refused schedule (malformed event)', raw: refusedScheduleRaw(UPDATE, 'Scheduled'), schedule: true },
  { name: 'ping', raw: PING_BODY, schedule: false },
  { name: 'candidateStageChange', raw: STAGE_BODY, schedule: false },
  { name: 'applicationUpdate with an id', raw: APPLICATION_UPDATE_BODY, schedule: false },
] as const;

// ── Expected Meet payloads (the T2 contract, S03 plan R10) ────────────────────

const PAYLOAD_KEYS = [
  'kind',
  'scope',
  'ashby_interview_event_id',
  'ashby_schedule_id',
  'ashby_application_id',
  'ashby_interview_stage_id',
  'ashby_interview_id',
  'ashby_scheduled_by_user_id',
  'ashby_updated_at',
  'decision',
  'start_at',
  'end_at',
  'meet_url',
  'received_at',
  'ashby_schedule_event_ids',
  'ashby_dex_event_ids',
];

function expectedEventPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'ashby_schedule',
    scope: 'event',
    ashby_interview_event_id: FIXTURE_EVENT_ID,
    ashby_schedule_id: FIXTURE_SCHEDULE_ID,
    ashby_application_id: FIXTURE_APPLICATION_ID,
    ashby_interview_stage_id: FIXTURE_STAGE_ID,
    ashby_interview_id: FIXTURE_INTERVIEW_ID,
    ashby_scheduled_by_user_id: FIXTURE_HR_USER_ID,
    ashby_updated_at: FIXTURE_EVENT_UPDATED_AT,
    decision: 'eligible',
    start_at: FIXTURE_START_TIME,
    end_at: FIXTURE_END_TIME,
    meet_url: FIXTURE_MEET_URL,
    received_at: NOW_ISO,
    ashby_schedule_event_ids: [FIXTURE_EVENT_ID],
    ashby_dex_event_ids: [FIXTURE_EVENT_ID],
    ...overrides,
  };
}

/** A schedule-scope job: no event fields and no application, stage or scheduler id (S03-R3). */
function expectedSchedulePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return expectedEventPayload({
    scope: 'schedule',
    ashby_interview_event_id: null,
    ashby_application_id: null,
    ashby_interview_stage_id: null,
    ashby_interview_id: null,
    ashby_scheduled_by_user_id: null,
    start_at: null,
    end_at: null,
    meet_url: null,
    ...overrides,
  });
}

function parsedSchedule(raw: string): R1MeetAshbySchedule {
  const result = parseR1MeetAshbyScheduleWebhook(JSON.parse(raw) as unknown, { dexUserId: FIXTURE_DEX_USER_ID });
  if (!result.ok) throw new Error(`expected a parsed schedule, got ${result.reason}`);
  return result.schedule;
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Everything the Meet port saw plus every response body, for the PII asserts. */
const seen: unknown[] = [];

function expectNoPii(serialized: string): void {
  expect(serialized).not.toContain('@');
  expect(serialized).not.toContain('example.invalid');
  for (const name of ['Example', 'Recruiter', 'Interviewer']) expect(serialized).not.toContain(name);
  for (const value of Object.values(FIXTURE_DROPPED_VALUES)) expect(serialized).not.toContain(value);
  expect(serialized).not.toContain(FIXTURE_CANDIDATE_ID);
}

// ── (1) Flag OFF: byte-identical ────────────────────────────────────────────

describe('(1) flag OFF: the receiver is byte-identical to the legacy receiver', () => {
  const savedEnv: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const name of ['R1_ENABLED', 'R1_MEET_ENABLED']) {
      savedEnv[name] = process.env[name];
      delete process.env[name];
    }
  });
  afterEach(() => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  describe.each(FLAG_OFF_VARIANTS)('variant %s', (variant) => {
    it.each(BODY_CASES)('$name: same status, bytes, body and legacy receipt inputs; no Meet work', async ({ raw, schedule }) => {
      const h = harness(variant);
      const expected = await legacyExpectation(raw);

      const res = await post(h.app, raw);
      expect(res.status).toBe(expected.status);
      expect(res.body).toEqual(expected.body);
      expect(res.text).toBe(JSON.stringify(expected.body));
      expect(res.headers['content-type']).toMatch(/^application\/json/);
      expect(h.outbox.inputs).toEqual(expected.inputs);
      expect(h.meet.calls).toHaveLength(0);
      expect(h.meet.jobs()).toHaveLength(0);
      expect(h.nowSpy).not.toHaveBeenCalled();
      seen.push(res.body);

      if (schedule) {
        // Explicit pin (S01 hand-off): with the flag off the generic extractor cannot resolve an id.
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ ok: false, error: 'unresolvable_id' });
        expect(h.outbox.inputs).toHaveLength(0);
      } else {
        // Only the two schedule actions ever read a Meet seam.
        expect(h.meetSpy).not.toHaveBeenCalled();
        expect(h.r1Spy).not.toHaveBeenCalled();
      }
    });
  });

  it('a stage change still records and enqueues exactly one legacy signal in every variant', async () => {
    for (const variant of FLAG_OFF_VARIANTS) {
      const h = harness(variant);
      const res = await post(h.app, STAGE_BODY);
      expect(res.body, variant).toEqual({ ok: true, status: 'accepted' });
      expect(h.outbox.liveJobs.size, variant).toBe(1);
      expect(h.meet.calls, variant).toHaveLength(0);
    }
  });
});

// ── (1b) Meet set but invalid ───────────────────────────────────────────────

describe('(1b) Meet set but invalid: schedule actions answer a retryable 503, everything else is unchanged', () => {
  describe.each(MEET_INVALID_VARIANTS)('variant %s', (variant) => {
    it.each(BODY_CASES)('$name', async ({ raw, schedule }) => {
      const h = harness(variant);
      const expected = await legacyExpectation(raw);
      const res = await post(h.app, raw);
      expect(h.outbox.inputs).toEqual(schedule ? [] : expected.inputs);
      expect(h.meet.calls).toHaveLength(0);
      expect(h.meet.jobs()).toHaveLength(0);
      expect(h.nowSpy).not.toHaveBeenCalled();
      // The R1 switch is never consulted: an invalid Meet configuration is a misconfiguration either way.
      expect(h.r1Spy).not.toHaveBeenCalled();
      seen.push(res.body);
      if (schedule) {
        expect(res.status).toBe(503);
        expect(res.text).toBe(JSON.stringify({ ok: false, error: 'r1_meet_misconfigured' }));
        expect(h.meetSpy).toHaveBeenCalledTimes(1);
      } else {
        expect(res.status).toBe(expected.status);
        expect(res.text).toBe(JSON.stringify(expected.body));
        expect(h.meetSpy).not.toHaveBeenCalled();
      }
    });
  });

  it('a stage change still records and enqueues exactly one legacy signal', async () => {
    for (const variant of MEET_INVALID_VARIANTS) {
      const h = harness(variant);
      const res = await post(h.app, STAGE_BODY);
      expect(res.body, variant).toEqual({ ok: true, status: 'accepted' });
      expect(h.outbox.liveJobs.size, variant).toBe(1);
      expect(h.meet.calls, variant).toHaveLength(0);
    }
  });

  it('once the configuration is fixed, the redelivered schedule is recorded', async () => {
    let meetConfig: R1MeetConfig = MEET_INVALID;
    const meet = createR1MeetReceiptsFake();
    const app = express();
    app.use(
      '/api/integrations/ashby',
      createAshbyWebhookRouter({
        config: ACTIVE,
        receipts: new FakeOutbox(),
        loggerComponent: 'ashby-webhook-r1-meet-test',
        r1Meet: { r1Config: () => ({ enabled: true }), meetConfig: () => meetConfig, receipts: meet, now: () => NOW_MS },
      }),
    );
    const cancelled = makeAshbyScheduleWebhookRaw(UPDATE, makeAshbyInterviewSchedule({ status: 'Cancelled' }));
    expect((await post(app, cancelled)).status).toBe(503);
    expect(meet.calls).toHaveLength(0);
    meetConfig = MEET_ON;
    const redelivered = await post(app, cancelled);
    expect(redelivered.status).toBe(200);
    expect(redelivered.body).toEqual({ ok: true, status: 'r1_meet_accepted' });
    expect(meet.jobs().map((job) => job.payload.decision)).toEqual(['cancelled']);
  });
});

// ── (2) Flag ON ─────────────────────────────────────────────────────────────

describe('(2) flag ON: interview schedules go to the r1-meet queue', () => {
  it('Create with a Dex event: 200 r1_meet_accepted, one receipt with the exact payload; the duplicate converges', async () => {
    const h = harness('flag_on');
    const res = await post(h.app, CREATE_RAW);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, status: 'r1_meet_accepted' });
    expect(h.meet.calls).toHaveLength(1);
    const call = h.meet.calls[0]!;
    expect(call.source).toBe('ashby');
    expect(call.eventType).toBe(CREATE);
    expect(call.bookingId).toBeNull();
    expect(call.nowMs).toBe(NOW_MS);
    expect(call.dedupeKey).toBe(`${r1MeetAshbyScheduleDedupKey(parsedSchedule(CREATE_RAW), NOW_MS)}:${FIXTURE_EVENT_ID.toLowerCase()}`);
    expect(Object.keys(call.payload)).toEqual(PAYLOAD_KEYS);
    expect(call.payload).toEqual(expectedEventPayload());
    expect(h.meet.jobs()).toHaveLength(1);
    expect(h.outbox.inputs).toHaveLength(0);
    expect(h.nowSpy).toHaveBeenCalledTimes(1);

    const duplicate = await post(h.app, CREATE_RAW);
    expect(duplicate.status).toBe(200);
    expect(duplicate.body).toEqual({ ok: true, status: 'r1_meet_duplicate' });
    expect(h.meet.calls).toHaveLength(2);
    expect(h.meet.calls[1]!.dedupeKey).toBe(call.dedupeKey);
    expect(h.meet.jobs()).toHaveLength(1);
    expect(h.outbox.inputs).toHaveLength(0);
    seen.push(res.body, duplicate.body, h.meet.calls, h.meet.jobs());
  });

  it('an Update with a candidate id: the same event payload, and the candidate id never travels', async () => {
    const h = harness('flag_on');
    const raw = makeAshbyScheduleWebhookRaw(UPDATE, makeAshbyInterviewSchedule(), { candidateId: FIXTURE_CANDIDATE_ID });
    const res = await post(h.app, raw);
    expect(res.body).toEqual({ ok: true, status: 'r1_meet_accepted' });
    expect(h.meet.calls).toHaveLength(1);
    expect(h.meet.calls[0]!.eventType).toBe(UPDATE);
    expect(h.meet.calls[0]!.payload).toEqual(expectedEventPayload());
    expect(h.outbox.inputs).toHaveLength(0);
    seen.push(res.body, h.meet.calls);
  });

  it('a Dex-less Create: 200 r1_meet_no_dex_event with no receipt', async () => {
    const h = harness('flag_on');
    const raw = makeAshbyScheduleWebhookRaw(CREATE, makeAshbyInterviewSchedule({ interviewEvents: [nonDexEvent()] }));
    const res = await post(h.app, raw);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, status: 'r1_meet_no_dex_event' });
    expect(h.meet.calls).toHaveLength(0);
    expect(h.outbox.inputs).toHaveLength(0);
    seen.push(res.body);
  });

  it('a Dex-less future Update: one schedule job, decision dex_absent (S06 can cancel a removed Dex)', async () => {
    const h = harness('flag_on');
    const raw = makeAshbyScheduleWebhookRaw(UPDATE, makeAshbyInterviewSchedule({ interviewEvents: [nonDexEvent()] }));
    const res = await post(h.app, raw);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, status: 'r1_meet_accepted' });
    expect(h.meet.calls).toHaveLength(1);
    const call = h.meet.calls[0]!;
    expect(call.eventType).toBe(UPDATE);
    expect(call.dedupeKey).toBe(`${r1MeetAshbyScheduleDedupKey(parsedSchedule(raw), NOW_MS)}:schedule`);
    expect(Object.keys(call.payload)).toEqual(PAYLOAD_KEYS);
    expect(call.payload).toEqual(expectedSchedulePayload({ decision: 'dex_absent', ashby_dex_event_ids: [] }));
    expect(h.meet.jobs()).toHaveLength(1);
    expect(h.outbox.inputs).toHaveLength(0);
    seen.push(res.body, h.meet.calls);
  });

  it('a refused parse whose identity is Cancelled: one schedule job, decision cancelled, nulls elsewhere', async () => {
    const h = harness('flag_on');
    const raw = refusedScheduleRaw(UPDATE, 'Cancelled');
    const res = await post(h.app, raw);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, status: 'r1_meet_accepted' });
    expect(h.meet.calls).toHaveLength(1);
    const call = h.meet.calls[0]!;
    expect(call.eventType).toBe(UPDATE);
    const prefix = ['ashby', 'schedule'].join('-') + ':';
    const stamp = String(Date.parse(FIXTURE_SCHEDULE_UPDATED_AT));
    expect(call.dedupeKey).toMatch(new RegExp(`^${escapeRe(prefix)}${escapeRe(FIXTURE_SCHEDULE_ID)}:${stamp}:cancelled$`));
    expect(Object.keys(call.payload)).toEqual(PAYLOAD_KEYS);
    expect(call.payload).toEqual({
      kind: 'ashby_schedule',
      scope: 'schedule',
      ashby_interview_event_id: null,
      ashby_schedule_id: FIXTURE_SCHEDULE_ID,
      ashby_application_id: null,
      ashby_interview_stage_id: null,
      ashby_interview_id: null,
      ashby_scheduled_by_user_id: null,
      ashby_updated_at: FIXTURE_SCHEDULE_UPDATED_AT,
      decision: 'cancelled',
      start_at: null,
      end_at: null,
      meet_url: null,
      received_at: NOW_ISO,
      ashby_schedule_event_ids: null,
      ashby_dex_event_ids: null,
    });
    expect(h.outbox.inputs).toHaveLength(0);
    seen.push(res.body, h.meet.calls);
  });

  it('a refused, non-cancelled schedule: 400 malformed_event with no receipt', async () => {
    const h = harness('flag_on');
    const res = await post(h.app, refusedScheduleRaw(UPDATE, 'Scheduled'));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: 'malformed_event' });
    expect(h.meet.calls).toHaveLength(0);
    expect(h.outbox.inputs).toHaveLength(0);
    seen.push(res.body);
  });

  it('two Dex events: two receipts and two jobs with distinct keys', async () => {
    const h = harness('flag_on');
    const second = 'aaaaaaaa-0000-4000-8000-000000000002';
    const raw = makeAshbyScheduleWebhookRaw(
      UPDATE,
      makeAshbyInterviewSchedule({
        interviewEvents: [
          makeAshbyInterviewEvent(),
          makeAshbyInterviewEvent({ id: second, startTime: '2026-12-02T10:30:00.000Z', endTime: '2026-12-02T11:15:00.000Z' }),
        ],
      }),
    );
    const res = await post(h.app, raw);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, status: 'r1_meet_accepted' });
    expect(h.meet.calls).toHaveLength(2);
    expect(h.meet.calls.map((call) => call.payload.ashby_interview_event_id)).toEqual([FIXTURE_EVENT_ID, second]);
    expect(new Set(h.meet.calls.map((call) => call.dedupeKey)).size).toBe(2);
    for (const call of h.meet.calls) {
      expect(call.payload.ashby_dex_event_ids).toEqual([FIXTURE_EVENT_ID, second]);
      expect(call.payload.ashby_schedule_event_ids).toEqual([FIXTURE_EVENT_ID, second]);
    }
    expect(h.meet.jobs()).toHaveLength(2);
    expect(h.outbox.inputs).toHaveLength(0);
    seen.push(res.body, h.meet.calls);
  });

  it('a Meet port throw: 500 receipt_persist_failed (retryable); the redelivery converges to one job', async () => {
    const h = harness('flag_on');
    h.meet.throwNext();
    const failed = await post(h.app, CREATE_RAW);
    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ ok: false, error: 'receipt_persist_failed' });
    expect(h.meet.jobs()).toHaveLength(0);
    const retried = await post(h.app, CREATE_RAW);
    expect(retried.status).toBe(200);
    expect(retried.body).toEqual({ ok: true, status: 'r1_meet_accepted' });
    expect(h.meet.jobs()).toHaveLength(1);
    expect(h.outbox.inputs).toHaveLength(0);
    seen.push(failed.body, retried.body);
  });

  it('a Meet port refusal: 500 receipt_rejected; no durable work: 500 enqueue_incomplete', async () => {
    const refused = harness('flag_on');
    refused.meet.answerNext({ status: 'refused', reason: 'payload_too_large' });
    const rejected = await post(refused.app, CREATE_RAW);
    expect(rejected.status).toBe(500);
    expect(rejected.body).toEqual({ ok: false, error: 'receipt_rejected' });

    const noWork = harness('flag_on');
    noWork.meet.answerNext({
      status: 'inserted',
      id: '5e000000-0000-4000-8000-0000000000f1',
      outcome: 'recorded',
      enqueued: false,
      workPending: false,
      bookingLinked: false,
    });
    const incomplete = await post(noWork.app, CREATE_RAW);
    expect(incomplete.status).toBe(500);
    expect(incomplete.body).toEqual({ ok: false, error: 'enqueue_incomplete' });
    seen.push(rejected.body, incomplete.body);
  });

  it('an unexpected failure in the Meet branch: 500 internal_error, nothing recorded', async () => {
    const outbox = new FakeOutbox();
    const meet = createR1MeetReceiptsFake();
    const app = express();
    app.use(
      '/api/integrations/ashby',
      createAshbyWebhookRouter({
        config: ACTIVE,
        receipts: outbox,
        loggerComponent: 'ashby-webhook-r1-meet-test',
        r1Meet: {
          r1Config: () => ({ enabled: true }),
          meetConfig: () => MEET_ON,
          receipts: meet,
          now: () => {
            throw new Error('fixture clock failure');
          },
        },
      }),
    );
    const res = await post(app, CREATE_RAW);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'internal_error' });
    expect(meet.calls).toHaveLength(0);
    expect(outbox.inputs).toHaveLength(0);
  });

  it('an unreadable Meet configuration fails inert: the legacy path answers', async () => {
    const outbox = new FakeOutbox();
    const meet = createR1MeetReceiptsFake();
    const app = express();
    app.use(
      '/api/integrations/ashby',
      createAshbyWebhookRouter({
        config: ACTIVE,
        receipts: outbox,
        r1Meet: {
          r1Config: () => ({ enabled: true }),
          meetConfig: () => {
            throw new Error('fixture config failure');
          },
          receipts: meet,
          now: () => NOW_MS,
        },
      }),
    );
    const res = await post(app, CREATE_RAW);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: 'unresolvable_id' });
    expect(meet.calls).toHaveLength(0);
  });

  it.each([
    { name: 'ping', raw: PING_BODY },
    { name: 'candidateStageChange', raw: STAGE_BODY },
    { name: 'applicationUpdate', raw: APPLICATION_UPDATE_BODY },
  ])('$name with the flag ON keeps the legacy path, byte for byte, and reads no Meet seam', async ({ raw }) => {
    const h = harness('flag_on');
    const expected = await legacyExpectation(raw);
    const res = await post(h.app, raw);
    expect(res.status).toBe(expected.status);
    expect(res.text).toBe(JSON.stringify(expected.body));
    expect(h.outbox.inputs).toEqual(expected.inputs);
    expect(h.meet.calls).toHaveLength(0);
    expect(h.meetSpy).not.toHaveBeenCalled();
    expect(h.r1Spy).not.toHaveBeenCalled();
    expect(h.nowSpy).not.toHaveBeenCalled();
  });

  it('gate order: a disabled Ashby integration with Meet ON still answers 503 and does no Meet work', async () => {
    const h = harness('flag_on', DISABLED);
    const res = await post(h.app, CREATE_RAW);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ok: false, error: 'integration_disabled' });
    expect(h.meet.calls).toHaveLength(0);
    expect(h.meetSpy).not.toHaveBeenCalled();
    expect(h.r1Spy).not.toHaveBeenCalled();
    expect(h.outbox.inputs).toHaveLength(0);
  });

  it('signature first: an unsigned or forged schedule delivery never reaches the Meet branch', async () => {
    const h = harness('flag_on');
    const forged = await post(h.app, CREATE_RAW, 'sha256=' + 'a'.repeat(64));
    expect(forged.status).toBe(403);
    const tampered = await post(h.app, CREATE_RAW + ' ', sign(CREATE_RAW));
    expect(tampered.status).toBe(403);
    expect(h.meet.calls).toHaveLength(0);
    expect(h.meetSpy).not.toHaveBeenCalled();
  });
});

// ── (3) PII ─────────────────────────────────────────────────────────────────

describe('(3) PII: ids, times and the canonical Meet URL only', () => {
  it('nothing the Meet port saw and no response body carries an email, a name or a dropped value', async () => {
    // A self-contained sweep over every flag-ON schedule shape, so this does not depend on test order.
    const h = harness('flag_on');
    const raws = [
      CREATE_RAW,
      makeAshbyScheduleWebhookRaw(UPDATE, makeAshbyInterviewSchedule(), { candidateId: FIXTURE_CANDIDATE_ID }),
      makeAshbyScheduleWebhookRaw(UPDATE, makeAshbyInterviewSchedule({ status: 'Cancelled' })),
      makeAshbyScheduleWebhookRaw(UPDATE, makeAshbyInterviewSchedule({ interviewEvents: [nonDexEvent()] })),
      makeAshbyScheduleWebhookRaw(CREATE, makeAshbyInterviewSchedule({ interviewEvents: [nonDexEvent()] })),
      refusedScheduleRaw(UPDATE, 'Cancelled'),
      refusedScheduleRaw(UPDATE, 'Scheduled'),
    ];
    // Sanity: the inputs DO carry the values the asserts look for.
    expect(raws.join('')).toContain('example.invalid');
    expect(raws.join('')).toContain(FIXTURE_DROPPED_VALUES.location);
    const bodies: unknown[] = [];
    for (const raw of raws) bodies.push((await post(h.app, raw)).body);
    expect(h.meet.calls.length).toBeGreaterThanOrEqual(4);
    expectNoPii(JSON.stringify({ calls: h.meet.calls, jobs: h.meet.jobs(), receipts: h.meet.receipts(), bodies }));
    // And everything the earlier tests collected.
    expectNoPii(JSON.stringify(seen));
  });
});
