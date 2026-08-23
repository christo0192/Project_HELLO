/**
 * routes/phone-worker.ts — the internal, service-authenticated surface the
 * phone voice worker calls. Five endpoints, all `POST`, none recruiter facing
 * and none reachable from a browser session.
 *
 * ── AUTH IS THE EXISTING WORKER SECRET, DELIBERATELY ──────────────────
 * `WORKER_CONTEXT_SECRET` already authenticates the worker's two existing
 * calls (`/api/livekit/worker-context` and `/api/internal/assess/:id`), using
 * the same >=32-character, constant-time comparison. A THIRD credential for
 * the same principal would be a third thing to rotate, a third thing to leak
 * and a third thing to forget to configure — and the trust boundary is
 * identical: this is the same worker, on the same private path, asking the
 * same API to do something on its behalf.
 *
 * ── WHY A STRICT EVENT ALLOWLIST ──────────────────────────────────────
 * `apply_phone_event` deliberately accepts an OPEN event-type FORMAT, because
 * an unrecognised event must be recordable so it can be answered with
 * `unexpected_event`. That is right for the ingress ledger and wrong for this
 * route: the worker is not a provider, it is our own code, and it has exactly
 * one legitimate vocabulary. So the allowlist here is CLOSED, and an event
 * outside it is refused BEFORE the database is touched. Anything else would
 * let a compromised or buggy worker drive arbitrary state transitions.
 *
 * ── THE THREE 0044 ASSESSMENT ENDPOINTS ───────────────────────────────
 * `/assessment/start`, `/assessment/turn` and `/assessment/complete` are the
 * durable half of a phone screening. Two rules govern all three:
 *
 *   1. NOTHING IS DECIDED HERE THAT THE DATABASE CAN DECIDE. The consent gate,
 *      the session binding, the plan snapshot, the cursor CAS, the key the
 *      model owes and the "an assessment must exist before anything claims a
 *      completion" interlock all live in 0044's RPCs. This router forwards
 *      refusals; it does not invent them.
 *   2. THE RESPONSE IS A PROJECTION, NOT A PASS-THROUGH. `sanitizeAssessmentState`
 *      builds the body key by key. Whatever a future migration adds to the RPC
 *      answer does not reach the worker — and therefore does not reach a
 *      language model — until this file changes.
 *
 * ── THE ONE RULE OF THE SCHEDULING ENDPOINT ───────────────────────────
 * It must NEVER report success for a booking that did not happen. The worker
 * speaks a confirmation only when this endpoint says `ok`/`ok_prereqs_pending`,
 * so a lenient answer here becomes a bot confidently promising a callback that
 * does not exist — on a call whose entire purpose is to be truthful. Every
 * refusal is therefore forwarded as a refusal with its own stable code, and
 * `unknown_status` is treated as a refusal rather than as success.
 */

import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { runAssessment } from '../services/assessment.js';
import { transitionSession } from '../lib/session-lifecycle.js';
import {
  PHONE_APPOINTMENT_MAX_SECONDS,
  PHONE_APPOINTMENT_MIN_SECONDS,
  PHONE_SYSTEM_ACTOR,
  createPhoneReadStore,
  createPhoneStores,
  istDate,
  istWindowOpen,
  loadPhoneScreeningConfig,
  type PhoneAssessmentState,
  type PhoneStores,
} from '../lib/phone-screening/index.js';
import { supabase } from '../lib/supabase.js';
import { phoneRoomName } from '../integrations/livekit-phone-dial/phone-room.js';
import { startPhoneAttemptRecording } from '../integrations/livekit-phone-dial/recording.js';
import { purgePhoneEngagementRecordings } from '../integrations/livekit-phone-dial/recording-purge.js';
import { supabaseStorageRecordingStorage } from '../lib/retention.js';
import { env } from '../lib/env.js';
import {
  createPhoneEgressClient,
  createPhoneEgressOutput,
  phoneEgressConfigured,
} from '../integrations/livekit-phone-dial/egress-output.js';

/**
 * The CLOSED set of events the worker may post.
 *
 * `sip.originate_*` are absent on purpose: those are the PROVIDER's verdicts
 * and arrive through the signed webhook, which is a different trust boundary.
 * A worker that could post them could manufacture a no-answer for a call that
 * was answered — and that charges a real candidate's anti-harassment budget.
 */
/**
 * The events whose 0042 transition is TERMINAL and carries a suppression. Each
 * must have its recordings deleted and verified BEFORE it is posted.
 */
export const PURGE_BEFORE_EVENTS: ReadonlySet<string> = new Set([
  'disclosure.refused',
  'candidate.opt_out',
  'candidate.wrong_number',
]);

export const WORKER_PHONE_EVENTS = [
  'classify.human',
  'classify.machine',
  'disclosure.delivered',
  'disclosure.refused',
  'candidate.opt_out',
  'candidate.wrong_number',
  'candidate.deferred_pre_disclosure',
  'sip.participant_left',
  'assessment.completed',
  'assessment.aborted',
] as const;

export type WorkerPhoneEvent = (typeof WORKER_PHONE_EVENTS)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const workerEventSchema = z
  .object({
    attempt_id: z.string().regex(UUID_RE),
    event_type: z.enum(WORKER_PHONE_EVENTS),
    epoch: z.number().int().min(0).max(2_147_483_647).nullable().optional(),
  })
  .strict();

/**
 * An ABSOLUTE UTC instant with a literal `Z`. An offset or a naive datetime is
 * refused rather than coerced: "18:30" means two different instants depending
 * on who is reading it, and the whole calendar is pinned to IST precisely so
 * that ambiguity never enters.
 *
 * Seconds are OPTIONAL and fractional seconds run to six digits, matching the
 * worker's own `_ISO_UTC_RE` exactly. The two diverged in an earlier draft, and
 * the divergence was not benign: a legitimate proposal in a shape the worker
 * considered valid arrived here as a flat `400 invalid_request`, which the
 * worker reports as a malformed-response error rather than as a refusal it can
 * SPEAK. The candidate would have heard a generic failure for a perfectly good
 * time. Neither shape is ambiguous — both end in `Z`.
 */
const UTC_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?Z$/;

const workerScheduleSchema = z
  .object({
    attempt_id: z.string().regex(UUID_RE),
    starts_at: z.string().regex(UTC_ISO_RE),
    duration_seconds: z
      .number()
      .int()
      .min(PHONE_APPOINTMENT_MIN_SECONDS)
      .max(PHONE_APPOINTMENT_MAX_SECONDS),
  })
  .strict();

/** A single ordered exchange inside one question boundary. */
const boundaryTurnSchema = z
  .object({
    speaker: z.enum(['bot', 'candidate']),
    text: z.string().trim().min(1).max(8_000),
  })
  .strict();

const assessmentStartSchema = z
  .object({
    attempt_id: z.string().regex(UUID_RE),
    session_id: z.string().regex(UUID_RE),
  })
  .strict();

const assessmentTurnSchema = z
  .object({
    session_id: z.string().regex(UUID_RE),
    question_key: z.string().trim().regex(/^[A-Za-z0-9_.:-]{1,100}$/),
    expected_index: z.number().int().min(0).max(99),
    source_event_id: z.string().trim().regex(/^[A-Za-z0-9_.:-]{1,200}$/),
    turns: z.array(boundaryTurnSchema).min(2).max(12),
  })
  .strict();

const assessmentCompleteSchema = z
  .object({
    attempt_id: z.string().regex(UUID_RE),
    session_id: z.string().regex(UUID_RE),
  })
  .strict();

export interface PhoneWorkerRouterDeps {
  readonly stores?: PhoneStores;
  /** Resolves an attempt to its engagement. Injected so tests need no DB. */
  readonly resolveEngagement?: (attemptId: string) => Promise<{
    engagementId: string;
    engagementState: string;
    version: number;
    /** Needed only to derive the room name when a recording is started. */
    sessionId?: string;
  } | null>;
  /**
   * Starts THIS attempt's recording. Called on exactly one event —
   * `disclosure.delivered` — and never on any other, because that is the only
   * transition after which a candidate has been told they are being recorded
   * and has agreed.
   *
   * Optional so a test can assert it is NOT called on every other path. In
   * production it is supplied only when an egress destination is actually
   * configured; an unconfigured deployment simply does not record, which is
   * the safe direction to be wrong in (recording less than promised harms
   * nobody; recording more than promised is the failure this phase exists to
   * prevent).
   */
  /**
   * Deletes and verifies every recording artifact of the engagement, and
   * reports whether the terminal event may now be posted. Injected so a test
   * can prove the ORDER; production wires the real purge.
   */
  readonly purgeRecordings?: (input: {
    engagementId: string;
    now: Date;
  }) => Promise<{ status: string; safeToAcknowledge: boolean }>;
  readonly startRecording?: (input: {
    engagementId: string;
    attemptId: string;
    roomName: string;
    now: Date;
  }) => Promise<{ status: string; egressStarted: boolean }>;
  readonly configSource?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  /**
   * Completes the session with the SHARED lifecycle CAS the browser path uses.
   * Injected only so a test can observe the ORDER and force a conflict; the
   * production default is `transitionSession` itself.
   */
  readonly completeSession?: (input: {
    sessionId: string;
  }) => Promise<{ ok: boolean; conflict: boolean }>;
  /**
   * Scores the session through the SHARED runner. AWAITED, deliberately — the
   * browser route fires this on a detached 8-second timer and swallows the
   * error, which is right for a path where a completed session is durable on
   * its own and a reconciler can retry. It is wrong here: nothing may claim a
   * phone completion until the score exists, so the phone path waits for it
   * and reports the failure.
   */
  readonly scoreSession?: (sessionId: string) => Promise<void>;
}


/**
 * Build the assessment-state body KEY BY KEY.
 *
 * This is a projection, not a pass-through, and the difference is the whole
 * control: whatever a future migration adds to `get_phone_assessment_state`'s
 * answer does not reach the worker — and therefore does not reach a language
 * model or a log line — until this function changes.
 *
 * `context` is a strict SUBSET of the worker context the browser path has
 * always resolved (`session_id`, `candidate_name`, `status`). It carries no
 * `candidate_id`, no `role_id` and no `room_name`, and nothing anywhere in the
 * body carries a phone number, a SIP or provider identifier, an attempt id, an
 * egress key or raw resume text.
 */
export function sanitizeAssessmentState(state: PhoneAssessmentState): Record<string, unknown> {
  return {
    context: {
      session_id: state.sessionId ?? null,
      candidate_name: state.candidateName ?? null,
      status: state.sessionStatus ?? null,
    },
    plan: {
      source: state.planSource ?? null,
      question_count: state.questionCount ?? 0,
      questions: (state.questions ?? []).map((q) => ({
        key: q.key,
        text: q.text,
        mandatory: q.mandatory,
        hint: q.hint,
      })),
    },
    progress: {
      cursor: state.cursor ?? 0,
      next_key: state.nextKey ?? null,
      completed_keys: [...(state.completedKeys ?? [])],
      plan_complete: state.planComplete === true,
    },
    turns: (state.turns ?? []).map((t) => ({
      turn_index: t.turnIndex,
      speaker: t.speaker,
      text: t.text,
    })),
    assessment_exists: state.assessmentExists === true,
  };
}

function requireWorkerPhoneAuth(
  req: import('express').Request,
  res: import('express').Response,
  next: import('express').NextFunction,
): void {
  const configured = process.env.WORKER_CONTEXT_SECRET;
  if (!configured || configured.length < 32) {
    res.status(503).json({ ok: false, error: 'worker_auth_not_configured' });
    return;
  }
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    res.status(401).json({ ok: false, error: 'authentication_required' });
    return;
  }
  const supplied = Buffer.from(auth.slice(7), 'utf8');
  const expected = Buffer.from(configured, 'utf8');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    res.status(403).json({ ok: false, error: 'access_denied' });
    return;
  }
  next();
}

export function createPhoneWorkerRouter(deps: PhoneWorkerRouterDeps = {}): Router {
  const router = Router();
  const now = deps.now ?? ((): Date => new Date());
  const stores = (): PhoneStores => deps.stores ?? createPhoneStores(supabase as never);
  const config = (): ReturnType<typeof loadPhoneScreeningConfig> =>
    loadPhoneScreeningConfig(deps.configSource ?? process.env);
  // Both seams carry a REAL default. A router built with an empty deps object
  // must complete and score a call, not silently do neither — a feature that
  // ships green and inert is a failure mode this project has already paid for.
  const completeSession = deps.completeSession
    ?? (async (input: { sessionId: string }) => {
      const result = await transitionSession(
        input.sessionId,
        'in_progress',
        'completed',
        'conversation_complete',
      );
      return { ok: result.ok, conflict: result.ok === false && result.conflict === true };
    });
  const scoreSession = deps.scoreSession
    ?? (async (sessionId: string): Promise<void> => {
      await runAssessment(sessionId, { source: 'phone' });
    });

  router.post('/events', requireWorkerPhoneAuth, async (req, res, next) => {
    try {
      // The master switch first, and BEFORE any database work. A disabled
      // deployment must be indistinguishable from one that never had the
      // route, not merely one that refuses more slowly.
      if (!config().screeningEnabled) {
        return res.status(503).json({ ok: false, error: 'phone_screening_disabled' });
      }
      const parsed = workerEventSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ ok: false, error: 'invalid_request' });
      }
      // ── B-3: PURGE BEFORE ACKNOWLEDGING A REFUSAL ───────────────────
      // `disclosure.refused`, `candidate.opt_out` and `candidate.wrong_number`
      // are TERMINAL in 0042, and the terminal transition writes the
      // suppression in the SAME transaction. Posting one of them before the
      // audio is gone commits "this line is suppressed and this engagement is
      // over" on top of a recording still sitting in the bucket — and it is
      // invisible afterwards, because the engagement reads as correctly opted
      // out.
      //
      // So the purge runs FIRST, and the event is posted only when the purge
      // says it is safe to acknowledge. A purge that could not verify deletion
      // leaves the request UNACKNOWLEDGED and retryable; nothing is posted.
      if (PURGE_BEFORE_EVENTS.has(parsed.data.event_type) && deps.purgeRecordings !== undefined) {
        const purged = await purgeBeforeTerminal(parsed.data.attempt_id, deps, now());
        if (!purged) {
          return res.status(503).json({ ok: false, error: 'phone_purge_incomplete' });
        }
      }

      const result = await stores().applyEvent({
        // `internal` is the correct source, and it mints a deterministic
        // synthetic provider id inside 0042, so a worker retry converges on
        // the original verdict instead of writing a second ledger row.
        source: 'internal',
        eventType: parsed.data.event_type,
        attemptId: parsed.data.attempt_id,
        epoch: parsed.data.epoch ?? undefined,
        now: now(),
      });
      // ── The ONE place a recording may begin ─────────────────────────
      // Only after `disclosure.delivered` has been APPLIED — not merely
      // posted, and not on any other event. 0043's
      // `attach_phone_attempt_recording` independently refuses unless the
      // engagement is already `in_call`, so this is the second of two locks
      // rather than the only one; if this call site were ever moved or
      // duplicated, the database would still refuse.
      //
      // A recording failure does NOT undo the event. The disclosure has been
      // delivered and the transition is durable; failing the request would ask
      // the worker to re-deliver a disclosure the candidate already answered.
      // The asymmetry is deliberate and safe in this direction: the candidate
      // was told the call is recorded and it may not be, which harms nobody.
      if (
        parsed.data.event_type === 'disclosure.delivered'
        && result.status === 'applied'
        && deps.startRecording !== undefined
      ) {
        await startRecordingForAttempt(parsed.data.attempt_id, deps, now());
      }

      // ── `ok` MEANS APPLIED. `ignored` IS NOT `ok`. ──────────────────
      // The worker branches its SAFETY decisions on this field: it treats a
      // successful `disclosure.delivered` as permission to assess and to
      // record. `ignored` covers `terminal` — which is exactly what an HR
      // `emergency.stop` or `hr.cancelled` produces — plus `stale_epoch` and
      // `unknown_attempt`. Reporting any of those as `ok` told the worker that
      // consent had been recorded when the state machine had just declared the
      // conversation over, and the agent would have kept the candidate on the
      // line and run the whole screening.
      //
      // `duplicate` re-posts of an already-applied event return `applied`, so
      // idempotency is preserved by this rule rather than broken by it.
      //
      // The verdict itself is still forwarded in `status`/`ignored_reason`, so
      // a caller that legitimately wants to distinguish "recorded but not
      // applied" from "never reached the ledger" still can.
      return res.json({
        ok: result.status === 'applied',
        status: result.status,
        ignored_reason: result.ignoredReason ?? null,
        duplicate: result.duplicate ?? false,
      });
    } catch {
      // Bare, sanitized. A driver message here could quote a row.
      return res.status(500).json({ ok: false, error: 'phone_event_error' });
    }
  });

  router.post('/appointments', requireWorkerPhoneAuth, async (req, res, next) => {
    try {
      if (!config().screeningEnabled) {
        return res.status(503).json({ ok: false, error: 'phone_screening_disabled' });
      }
      const parsed = workerScheduleSchema.safeParse(req.body);
      if (!parsed.success) {
        // Duration and format refusals are DISTINCT from booking refusals, so
        // the worker can say "I can't do that time" rather than "something
        // went wrong". Neither is ever a confirmation.
        return res.status(400).json({ ok: false, status: 'invalid_request' });
      }

      const startsAt = new Date(parsed.data.starts_at);
      const at = now();
      if (Number.isNaN(startsAt.getTime())) {
        return res.status(400).json({ ok: false, status: 'invalid_request' });
      }
      // The server revalidates. The worker proposes an instant; it does not
      // get to decide whether the instant is legal, because an LLM-driven
      // caller is exactly the sort of client that will confidently propose
      // 03:00 IST.
      if (startsAt.getTime() <= at.getTime()) {
        return res.json({ ok: false, status: 'slot_in_past' });
      }
      if (!istWindowOpen(startsAt)) {
        return res.json({ ok: false, status: 'window_closed' });
      }

      const resolved = deps.resolveEngagement
        ? await deps.resolveEngagement(parsed.data.attempt_id)
        : null;
      if (resolved === null) {
        return res.json({ ok: false, status: 'unknown_attempt' });
      }

      // ── THE PRE-DISCLOSURE PATH ─────────────────────────────────────
      // `schedule_phone_appointment` refuses outright while the engagement is
      // `dialing`: a live dial owns the engagement, and booking under it would
      // put the calendar and the wire into disagreement. But "call me later"
      // is MOST likely said during the identity/disclosure exchange — i.e.
      // exactly while the engagement IS `dialing`.
      //
      // So the attempt is first ended truthfully and WITHOUT CHARGE, via
      // 0043's `candidate.deferred_pre_disclosure` edge, which leaves the
      // engagement `eligible`. Only then is the booking attempted, from a
      // state the RPC accepts. If that first step does not succeed, we refuse
      // — we do NOT book, and we do NOT confirm.
      let engagementState = resolved.engagementState;
      if (engagementState === 'dialing') {
        const ended = await stores().applyEvent({
          source: 'internal',
          eventType: 'candidate.deferred_pre_disclosure',
          attemptId: parsed.data.attempt_id,
          now: at,
        });
        if (ended.status !== 'applied') {
          return res.json({ ok: false, status: 'attempt_in_flight' });
        }
        engagementState = 'eligible';
        // ── AND THE SLOT MUST BE ONE ADMISSION CAN ACTUALLY DIAL ──────
        // 0043's pre-disclosure edge moves `next_eligible_at` to the next IST
        // day, and the ended attempt keeps TODAY's `ist_date` and its
        // non-reconnect kind — so `admit_phone_attempt` would refuse a
        // same-day retry twice over (`not_yet_eligible`, then
        // `daily_attempt_exists`). `schedule_phone_appointment` checks neither
        // field, so it would happily book 16:00 today and the endpoint would
        // report success.
        //
        // That is the exact failure this route exists to prevent: the bot
        // would say "I've got that booked" for a call nothing will ever place.
        // A candidate saying "call me back this afternoon" is the MOST likely
        // deferral there is, so this is not an edge case.
        if (istDate(startsAt) <= istDate(at)) {
          return res.json({ ok: false, status: 'slot_not_yet_eligible' });
        }
      }

      const endsAt = new Date(startsAt.getTime() + parsed.data.duration_seconds * 1000);
      const booked = await stores().scheduleAppointment({
        engagementId: resolved.engagementId,
        startsAt,
        endsAt,
        source: 'candidate_voice',
        // The SYSTEM actor. A candidate speaking on a call is not an operator
        // identity, and 0042 falls back to the recruiter sentinel for a null
        // actor, which would misattribute the booking to a human recruiter.
        actorId: PHONE_SYSTEM_ACTOR,
        now: at,
      });

      // THE LOAD-BEARING LINE. Only these two statuses are a booking. Anything
      // else — including `unknown_status`, which means we never got an answer
      // we understand — is forwarded as a refusal, so the worker says nothing
      // that sounds like a confirmation.
      if (booked.status === 'ok' || booked.status === 'ok_prereqs_pending') {
        return res.json({
          ok: true,
          status: booked.status,
          appointment_id: booked.appointmentId,
          version: booked.version,
        });
      }
      return res.json({ ok: false, status: booked.status });
    } catch {
      return res.status(500).json({ ok: false, status: 'phone_schedule_error' });
    }
  });


  // ── POST /assessment/start ────────────────────────────────────────
  // Binds the session, activates it, snapshots the plan, and hands back
  // everything a resuming leg needs. Idempotent: a reconnecting leg calls the
  // same endpoint and gets its own conversation back.
  router.post('/assessment/start', requireWorkerPhoneAuth, async (req, res) => {
    try {
      if (!config().screeningEnabled) {
        return res.status(503).json({ ok: false, error: 'phone_screening_disabled' });
      }
      const parsed = assessmentStartSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ ok: false, status: 'invalid_request' });
      }
      const state = await stores().startAssessment({
        attemptId: parsed.data.attempt_id,
        sessionId: parsed.data.session_id,
        now: now(),
      });
      if (state.status !== 'ok') {
        // Every refusal is forwarded with its own stable code so the worker can
        // tell "the disclosure was never delivered" from "this session is not
        // yours". None of them is an error the worker should retry blindly.
        return res.json({ ok: false, status: state.status });
      }
      return res.json({ ok: true, status: 'ok', ...sanitizeAssessmentState(state) });
    } catch {
      return res.status(500).json({ ok: false, status: 'phone_assessment_error' });
    }
  });

  // ── POST /assessment/turn ─────────────────────────────────────────
  // One completed question: its ordered turns, its key and its cursor advance,
  // committed atomically. A worker that does not get `ok` here MUST NOT ask
  // the next question and MUST NOT claim a completion.
  router.post('/assessment/turn', requireWorkerPhoneAuth, async (req, res) => {
    try {
      if (!config().screeningEnabled) {
        return res.status(503).json({ ok: false, error: 'phone_screening_disabled' });
      }
      const parsed = assessmentTurnSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ ok: false, status: 'invalid_request' });
      }
      const result = await stores().commitQuestionBoundary({
        sessionId: parsed.data.session_id,
        questionKey: parsed.data.question_key,
        expectedIndex: parsed.data.expected_index,
        sourceEventId: parsed.data.source_event_id,
        turns: parsed.data.turns,
        now: now(),
      });
      // `applied` is read from the RPC's own flag, never inferred from the
      // status string. A boundary the store layer could not fully understand
      // is one the worker must treat as "did not happen".
      return res.json({
        ok: result.applied,
        status: result.status,
        duplicate: result.duplicate,
        cursor: result.cursor ?? null,
        question_count: result.questionCount ?? null,
        plan_complete: result.planComplete ?? false,
        expected_key: result.expectedKey ?? null,
      });
    } catch {
      return res.status(500).json({ ok: false, status: 'phone_assessment_error' });
    }
  });

  // ── POST /assessment/complete ─────────────────────────────────────
  // THE ORDERING THIS PHASE EXISTS FOR:
  //   every plan key durable  ->  session completion CAS  ->  AWAIT scoring
  //   ->  verify the assessment row  ->  only then may anything be claimed.
  //
  // This endpoint never posts `assessment.completed` itself. It reports
  // whether a score exists; the worker posts the event through `/events`, and
  // 0044's `apply_phone_event` refuses that event outright if the row is not
  // there. So the claim is gated twice, and the second gate is in SQL.
  router.post('/assessment/complete', requireWorkerPhoneAuth, async (req, res) => {
    try {
      if (!config().screeningEnabled) {
        return res.status(503).json({ ok: false, error: 'phone_screening_disabled' });
      }
      const parsed = assessmentCompleteSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ ok: false, status: 'invalid_request' });
      }
      const sessionId = parsed.data.session_id;

      const before = await stores().assessmentState({ sessionId });
      if (before.status !== 'ok') {
        return res.json({ ok: false, status: before.status });
      }
      // EVERY key, and therefore every turn that answers one, is durable
      // before anything is completed. A leg that lost a boundary write comes
      // back here with an incomplete plan and is refused.
      if (before.planComplete !== true) {
        return res.json({
          ok: false,
          status: 'plan_incomplete',
          cursor: before.cursor ?? null,
          question_count: before.questionCount ?? null,
        });
      }

      if (before.sessionStatus === 'in_progress') {
        // ── NO `duration_sec`, DELIBERATELY ─────────────────────────
        // A phone session spans every reconnect attempt, and 0042 defers a
        // window-closed reconnect to the NEXT IST DAY — so there is no single
        // elapsed number that is true of the conversation. `started_at` is
        // stamped when the session ROW is created (NOT NULL, defaulted, never
        // updated), so measuring from it would report time-since-provisioning
        // and clamp at 86,400 on a next-day reconnect: a plausible-looking
        // measurement of something nobody asked about. A hardcoded 0 was worse
        // still — it asserted a screening that took no time.
        //
        // Omitting it leaves the column NULL, which is the truthful answer:
        // this path does not measure duration. A phone-specific instant (the
        // attempt's `answered_at`, or the `disclosure.delivered` transition)
        // would be measurable, and that is a deliberate later change with its
        // own migration rather than a number invented here.
        const completed = await completeSession({ sessionId });
        // A CONFLICT is not a failure. Two legs racing to complete is exactly
        // what a reconnect produces, and the loser must still verify — which
        // is what the scoring call and the row check below do. A NON-conflict
        // failure is a real one and stops here.
        if (!completed.ok && !completed.conflict) {
          return res.json({ ok: false, status: 'completion_failed' });
        }
      } else if (before.sessionStatus !== 'completed') {
        // `failed`, `cancelled`, `expired`: the session is terminal for some
        // other reason and no completion is owed.
        return res.json({ ok: false, status: 'session_not_active' });
      }

      // ── SCORING, THEN VERIFICATION — AND THE VERIFICATION RUNS EITHER WAY ──
      // A THROW FROM `scoreSession` IS NOT EVIDENCE THAT NOTHING WAS SCORED.
      // The ordinary reconnect case makes that concrete: the winning leg
      // inserts the assessment, the losing leg's insert hits 23505, and any
      // failure to read the winner's row back — a transient read error, a row
      // with a null `raw` — re-throws. The session IS scored; a leg that
      // returned `scoring_failed` here would report otherwise, and the worker
      // would then post `assessment.aborted` and drive the engagement to
      // terminal `failed` over a screening that exists.
      //
      // So the exception is remembered, not returned on, and the ROW decides.
      let scoringThrew = false;
      try {
        await scoreSession(sessionId);
      } catch {
        // Sanitized deliberately: a scoring error can quote a provider body
        // or a row. Nothing about it is forwarded.
        scoringThrew = true;
      }

      // THE VERIFICATION. Scoring "succeeding" is not the same as an
      // assessment existing, and only the row entitles anything to claim a
      // completed screening.
      const after = await stores().assessmentState({ sessionId });
      if (after.status !== 'ok' || after.assessmentExists !== true) {
        // `scoring_failed` and `assessment_missing` are kept DISTINCT because
        // the worker treats them differently: one is a provider fault it may
        // retry, the other is a state it must not.
        return res.json({
          ok: false,
          status: scoringThrew ? 'scoring_failed' : 'assessment_missing',
        });
      }
      return res.json({ ok: true, status: 'scored' });
    } catch {
      return res.status(500).json({ ok: false, status: 'phone_assessment_error' });
    }
  });

  return router;
}

/**
 * Delete and verify this attempt's engagement recordings, and answer whether
 * the terminal event may be posted.
 *
 * FAILS CLOSED in every ambiguous case. An engagement we cannot resolve, a
 * purge that throws, and a purge that cannot verify deletion all answer
 * `false` — because the only alternative is committing a terminal state and a
 * suppression over audio we did not prove gone.
 */
async function purgeBeforeTerminal(
  attemptId: string,
  deps: PhoneWorkerRouterDeps,
  now: Date,
): Promise<boolean> {
  try {
    const resolved = deps.resolveEngagement ? await deps.resolveEngagement(attemptId) : null;
    if (resolved === null) return false;
    const result = await deps.purgeRecordings?.({
      engagementId: resolved.engagementId,
      now,
    });
    return result?.safeToAcknowledge === true;
  } catch {
    return false;
  }
}

/**
 * Best-effort recording start. Swallows every failure ON PURPOSE — see the
 * call site for why a recording failure must not fail the event that earned
 * it. Nothing about the failure is forwarded to the worker either: the worker
 * cannot act on it, and telling it "recording failed" invites it to say
 * something to the candidate that it has no business saying.
 */
async function startRecordingForAttempt(
  attemptId: string,
  deps: PhoneWorkerRouterDeps,
  now: Date,
): Promise<void> {
  try {
    const resolved = deps.resolveEngagement
      ? await deps.resolveEngagement(attemptId)
      : null;
    if (resolved === null || resolved.sessionId === undefined) return;
    await deps.startRecording?.({
      engagementId: resolved.engagementId,
      attemptId,
      roomName: phoneRoomName(resolved.sessionId),
      now,
    });
  } catch {
    // Deliberately silent to the caller. The keys, if they were bound, are
    // already on the attempt row, so the purge can still find whatever exists.
  }
}

/**
 * PRODUCTION WIRING.
 *
 * Every seam gets a real default, deliberately. A router constructed with an
 * empty deps object would answer `unknown_attempt` to every booking forever and
 * would never start a recording — the feature would ship GREEN and inert, which
 * is a failure mode this project has already paid for.
 *
 * The two seams degrade differently, and both degradations are the safe one:
 *
 *   * `resolveEngagement` reads through the phone READ store. If the read
 *     throws, the booking is refused; it is never invented.
 *   * `startRecording` is supplied ONLY when an egress destination is actually
 *     configured. An unconfigured deployment simply does not record — which is
 *     safe, because recording LESS than we promised harms nobody, while
 *     recording more than promised is the failure this phase exists to prevent.
 */
export const phoneWorkerRouter = createPhoneWorkerRouter({
  async resolveEngagement(attemptId) {
    const context = await createPhoneReadStore(supabase as never).getAttemptContext({
      attemptId,
    });
    if (context === null) return null;
    return {
      engagementId: context.engagementId,
      engagementState: context.engagementState,
      version: context.engagementVersion,
      sessionId: context.sessionId ?? undefined,
    };
  },
  async purgeRecordings(input) {
    return purgePhoneEngagementRecordings(
      { engagementId: input.engagementId, now: input.now },
      {
        stores: createPhoneStores(supabase as never),
        storage: supabaseStorageRecordingStorage(env.recordingsBucket),
        egress: phoneEgressConfigured() ? await createPhoneEgressClient() : undefined,
      },
    );
  },
  startRecording: phoneEgressConfigured()
    ? async (input): Promise<{ status: string; egressStarted: boolean }> =>
        startPhoneAttemptRecording(input, {
          stores: createPhoneStores(supabase as never),
          egress: await createPhoneEgressClient(),
          buildOutput: createPhoneEgressOutput,
        })
    : undefined,
});
