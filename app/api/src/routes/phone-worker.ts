/**
 * routes/phone-worker.ts — the internal, service-authenticated surface the
 * phone voice worker calls. Two endpoints, both `POST`, neither recruiter
 * facing and neither reachable from a browser session.
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
import {
  PHONE_APPOINTMENT_MAX_SECONDS,
  PHONE_APPOINTMENT_MIN_SECONDS,
  PHONE_SYSTEM_ACTOR,
  createPhoneReadStore,
  createPhoneStores,
  istWindowOpen,
  loadPhoneScreeningConfig,
  type PhoneStores,
} from '../lib/phone-screening/index.js';
import { supabase } from '../lib/supabase.js';
import { phoneRoomName } from '../integrations/livekit-phone-dial/phone-room.js';
import { startPhoneAttemptRecording } from '../integrations/livekit-phone-dial/recording.js';
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
 */
const UTC_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

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
  readonly startRecording?: (input: {
    engagementId: string;
    attemptId: string;
    roomName: string;
    now: Date;
  }) => Promise<{ status: string; egressStarted: boolean }>;
  readonly configSource?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
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

      // Every 0042 verdict is a legitimate answer, including `ignored`. The
      // worker needs to know WHICH, because `stale_epoch` and `terminal` mean
      // "this conversation is over, stop talking" while `applied` does not.
      return res.json({
        ok: result.status === 'applied' || result.status === 'ignored',
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

  return router;
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
  startRecording: phoneEgressConfigured()
    ? async (input): Promise<{ status: string; egressStarted: boolean }> =>
        startPhoneAttemptRecording(input, {
          stores: createPhoneStores(supabase as never),
          egress: await createPhoneEgressClient(),
          buildOutput: createPhoneEgressOutput,
        })
    : undefined,
});
