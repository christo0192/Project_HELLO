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
import { createLogger } from '../lib/logger.js';
import { z } from 'zod';
import { runAssessment } from '../services/assessment.js';
import { transitionSession } from '../lib/session-lifecycle.js';
import {
  PHONE_APPOINTMENT_MAX_SECONDS,
  PHONE_APPOINTMENT_MIN_SECONDS,
  PHONE_SYSTEM_ACTOR,
  PHONE_MAX_CONCURRENT,
  PHONE_VOICE_CALLBACK_DURATION_SECONDS,
  PHONE_VOICE_CALLBACK_MIN_LEAD_SECONDS,
  createPhoneReadStore,
  createPhoneStores,
  istDate,
  istWindowOpen,
  istWallClock,
  istDayInstantRange,
  buildPhoneSlotGrid,
  parseIstCalendarDate,
  loadPhoneScreeningConfig,
  type PhoneAssessmentState,
  type PhoneReadStore,
  type PhoneStores,
  type PhoneSlot,
} from '../lib/phone-screening/index.js';
import { supabase } from '../lib/supabase.js';
import { Queue } from '../lib/queue/index.js';
import { PgAdapter } from '../lib/queue/pg-adapter.js';
import { PHONE_ASSESSMENT_QUEUE, phoneAssessmentDedupKey } from '../lib/phone-runtime/assessment-handler.js';
import { phoneRoomName } from '../integrations/livekit-phone-dial/phone-room.js';
import { createPlivoBounceStore } from '../integrations/plivo-phone/stores.js';
import { startPhoneAttemptRecording } from '../integrations/livekit-phone-dial/recording.js';
import {
  prepareWorkerRecording,
  type WorkerRecordingUploadSigner,
} from '../integrations/livekit-phone-dial/worker-recording.js';
import { finalizeAuthoritativeRecording } from '../lib/recording-egress.js';
import { purgePhoneEngagementRecordings } from '../integrations/livekit-phone-dial/recording-purge.js';
import { supabaseStorageRecordingStorage } from '../lib/retention.js';
import { env } from '../lib/env.js';
import {
  createPhoneEgressClient,
  createPhoneEgressOutput,
  phoneEgressConfigured,
} from '../integrations/livekit-phone-dial/egress-output.js';

const phoneWorkerLog = createLogger('phone-worker');

/**
 * The CLOSED set of events the worker may post.
 *
 * `sip.originate_*` are absent on purpose: those are the PROVIDER's verdicts
 * and arrive through the signed webhook, which is a different trust boundary.
 * A worker that could post them could manufacture a no-answer for a call that
 * was answered — and that charges a real candidate's anti-harassment budget.
 */
/**
 * The events after which a recording may exist but MUST be destroyed before the
 * event posts. The posture since 0067 is "record from answer, keep only if
 * consented": the egress now starts at `call.answered`, BEFORE consent, so every
 * exit that ends the engagement without consent — a refusal, an opt-out, a wrong
 * number, a machine pickup, or a pre-disclosure deferral — must delete and
 * verify the pre-consent audio in the SAME step, before the terminal (or
 * deferral) event's transition and any suppression it carries commits.
 *
 * The purge is idempotent and fails closed: an attempt that has recordings but
 * whose egress never finalized is still enumerated and cleared, and a purge that
 * cannot verify deletion leaves the request unacknowledged and retryable.
 */
export const PURGE_BEFORE_EVENTS: ReadonlySet<string> = new Set([
  'disclosure.refused',
  'candidate.opt_out',
  'candidate.wrong_number',
  // 0067: recordings may now exist pre-consent, so these two non-consenting
  // exits must destroy them before the event posts, exactly like the refusals.
  'classify.machine',
  'candidate.deferred_pre_disclosure',
]);

export const WORKER_PHONE_EVENTS = [
  // Parity 2 (0067): a leg was answered. Stamps the attempt's answered_at and
  // moves the engagement nowhere — it is not consent. Added to the closed
  // vocabulary so the new first-class event can reach apply_phone_event.
  'call.answered',
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
    // The SESSION HINT (recording ordering fix, 2026-08-26). The recording
    // egress starts when `disclosure.delivered` is applied, but the session is
    // bound to the attempt row only at /assessment/start — later — so the
    // disclosure-time DB read found no session and the start silently skipped
    // on EVERY call. The worker has the session from its dispatch metadata /
    // room name and forwards it here; it is used ONLY as the fallback for
    // deriving the room to record, never written to any row (0044's bind at
    // /assessment/start remains the sole writer and re-verifies the binding).
    session_id: z.string().regex(UUID_RE).nullable().optional(),
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

const voiceCallbackSchema = z
  .object({
    attempt_id: z.string().regex(UUID_RE),
    starts_at: z.string().regex(UTC_ISO_RE),
  })
  .strict();

/** A single ordered exchange inside one question boundary. */
const boundaryTurnSchema = z
  .object({
    speaker: z.enum(['bot', 'candidate']),
    text: z.string().trim().min(1).max(8_000),
    // Optional epoch-ms speech-start anchor. Legacy workers may omit it;
    // current workers pass the SDK's ChatMessage.metrics anchor through the
    // durable boundary so the dashboard can align it with the egress.
    turn_started_at_ms: z.number().int().positive().lt(4_102_444_800_000).nullable().optional(),
  })
  .strict();

const assessmentStartSchema = z
  .object({
    attempt_id: z.string().regex(UUID_RE),
    session_id: z.string().regex(UUID_RE),
  })
  .strict();

// The read-only state probe a re-dispatched leg makes BEFORE the gate speaks,
// so it can tell an already-consented conversation apart from a fresh one. Takes
// only the session id — it writes nothing and starts nothing.
const assessmentStateSchema = z
  .object({
    session_id: z.string().regex(UUID_RE),
  })
  .strict();

const assessmentProbeSchema = z
  .object({
    session_id: z.string().regex(UUID_RE),
    question_key: z.string().trim().regex(/^[A-Za-z0-9_.:-]{1,100}$/),
    expected_index: z.number().int().min(0).max(99),
    source_event_id: z.string().trim().regex(/^[A-Za-z0-9_.:-]{1,200}$/),
  })
  .strict();

const consentStartSchema = z
  .object({
    attempt_id: z.string().regex(UUID_RE),
    session_id: z.string().regex(UUID_RE),
    epoch: z.number().int().min(0).max(1_000_000),
  })
  .strict();

/**
 * The attempt heartbeat (0045).
 *
 * Three keys and `.strict()`. `epoch` is the fence: the worker names which
 * attempt AND which generation of it, and the database looks the lease token
 * up itself.
 *
 * THERE IS NO `lease_token` FIELD AND THERE MUST NEVER BE ONE. The
 * conversation runs in the LiveKit agent, not in the process that admitted the
 * attempt, so a token-fenced renewal would mean shipping the token to the
 * agent — onto dispatch metadata and through every log line that ever printed
 * a request body. 0045 added a second, epoch-fenced door precisely so this
 * schema can stay this shape.
 *
 * `epoch` accepts 0: 0042 starts an engagement at epoch 0 and bumps on
 * `disclosure.delivered`. The epoch a beat carries is normally ONE BEHIND
 * the attempt row — admission mints it onto the dispatch metadata and the
 * bump happens before the heartbeat ever starts — which is why the RPC
 * fences on `epoch >= p_epoch`. An equality there answered `lease_lost` to
 * the first beat of every consented call.
 */
const attemptHeartbeatSchema = z
  .object({
    attempt_id: z.string().regex(UUID_RE),
    session_id: z.string().regex(UUID_RE),
    epoch: z.number().int().min(0).max(1_000_000),
  })
  .strict();

const assessmentTurnSchema = z
  .object({
    session_id: z.string().regex(UUID_RE),
    question_key: z.string().trim().regex(/^[A-Za-z0-9_.:-]{1,100}$/),
    expected_index: z.number().int().min(0).max(99),
    source_event_id: z.string().trim().regex(/^[A-Za-z0-9_.:-]{1,200}$/),
    turns: z.array(boundaryTurnSchema).min(2).max(12),
    covered_question_keys: z.array(
      z.string().trim().regex(/^[A-Za-z0-9_.:-]{1,100}$/),
    ).max(3).default([]),
  })
  .strict();

const assessmentCompleteSchema = z
  .object({
    attempt_id: z.string().regex(UUID_RE),
    session_id: z.string().regex(UUID_RE),
  })
  .strict();

/**
 * 0067 — the PRE-CONSENT (gate) transcript.
 *
 * The bounds MIRROR `commit_phone_gate_turns` exactly: 1..6 turns, text trimmed
 * and 1..8,000 chars, `source_event_id` `^[A-Za-z0-9_.:-]{1,200}$`. The RPC
 * enforces every one of these itself and answers `invalid_turns` — this schema
 * refuses the same shapes a round trip earlier, so a malformed body is a flat
 * 400 rather than a database call. The turn shape reuses `boundaryTurnSchema`,
 * the SAME shape `/assessment/turn` validates, so the two cannot drift.
 */
const gateTurnsSchema = z
  .object({
    session_id: z.string().regex(UUID_RE),
    source_event_id: z.string().trim().regex(/^[A-Za-z0-9_.:-]{1,200}$/),
    turns: z.array(boundaryTurnSchema).min(1).max(6),
  })
  .strict();

/**
 * 0071 / X4 — the per-item transcript writer.
 *
 * ONE turn, persisted the moment the worker sees it, so a mid-call crash
 * between question boundaries no longer loses everything since the last one
 * (live call 22, 2026-08-29: 4 of a 6.5-minute transcript survived). Bounds
 * MIRROR `commit_phone_item_turn`: speaker bot|candidate, text 1..8,000 after
 * trim, `source_item_id` `^[A-Za-z0-9_.:-]{1,200}$` (the per-item idempotency
 * key), optional epoch-ms anchor. The RPC re-enforces every one, so a
 * malformed body is a flat 400 rather than a database round trip.
 */
const itemTurnSchema = z
  .object({
    session_id: z.string().regex(UUID_RE),
    speaker: z.enum(['bot', 'candidate']),
    text: z.string().trim().min(1).max(8_000),
    source_item_id: z.string().trim().regex(/^[A-Za-z0-9_.:-]{1,200}$/),
    turn_started_at_ms: z.number().int().positive().lt(4_102_444_800_000).nullable().optional(),
  })
  .strict();

/**
 * PR A — `POST /recording/prepare` body.
 *
 * The worker names the attempt, its session, and the engagement it belongs to.
 * All three are UUID-shaped by schema; the server re-derives nothing it can
 * read, and the consent gate (`attach_phone_attempt_recording`) is what
 * actually authorizes a binding. Active ONLY when `RECORDING_PROVIDER=worker`.
 */
const recordingPrepareSchema = z
  .object({
    attempt_id: z.string().regex(UUID_RE),
    session_id: z.string().regex(UUID_RE),
    engagement_id: z.string().regex(UUID_RE),
  })
  .strict();

/**
 * PR A — `POST /recording/complete` body.
 *
 * The worker reports the SHA-256, byte size and duration of the MP3 it uploaded
 * to the presigned PUT. These are advisory to the worker's own logging; the
 * finalizer RE-DOWNLOADS and RE-HASHES the object itself and never trusts the
 * worker's numbers for the integrity columns. Active ONLY when
 * `RECORDING_PROVIDER=worker`.
 */
const recordingCompleteSchema = z
  .object({
    attempt_id: z.string().regex(UUID_RE),
    session_id: z.string().regex(UUID_RE),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size_bytes: z.number().int().positive().max(52_428_800),
    duration_ms: z.number().int().positive().lt(4_102_444_800_000).nullable().optional(),
  })
  .strict();

export interface PhoneWorkerRouterDeps {
  readonly stores?: PhoneStores;
  /** Read-only appointment/attempt seam for proposal validation. */
  readonly readStore?: PhoneReadStore;
  /** Resolves an attempt to its engagement. Injected so tests need no DB. */
  readonly resolveEngagement?: (attemptId: string) => Promise<{
    engagementId: string;
    engagementState: string;
    version: number;
    /** Needed only to derive the room name when a recording is started. */
    sessionId?: string;
  } | null>;
  /**
   * Server-side association check for the worker's SESSION HINT (independent
   * review of the recording ordering fix): a hint is only a room-derivation
   * fallback, and a stale, mismatched or hostile hint must not be able to
   * point the egress at another conversation's room. True iff the hinted
   * session belongs to the SAME CANDIDATE as the attempt's engagement — the
   * binding `ensureSession` established at dial time and 0044 re-verifies at
   * /assessment/start. FAIL-CLOSED: when this seam is absent, a hint is
   * unusable and the recording is skipped (and logged), never trusted.
   */
  readonly verifySessionHint?: (input: {
    sessionId: string;
    engagementId: string;
  }) => Promise<boolean>;
  /**
   * Starts THIS attempt's recording. Since 0067 it is called on `call.answered`
   * (the recording now begins at answer, capturing the greeting/consent
   * exchange) and again, idempotently, on `disclosure.delivered` as a fallback —
   * and on no other event. Both callers run only when the event was APPLIED.
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
    /** For the 0051 session-level egress stamp (the read path is session-keyed). */
    sessionId: string;
    now: Date;
  }) => Promise<{ status: string; egressStarted: boolean }>;
  /**
   * PR A — the recording PROVIDER for THIS router. Defaults to
   * `env.recordingProvider` ('egress'). The two `/recording/*` endpoints are
   * ACTIVE only when this is `'worker'`; on `'egress'` they 404, so the egress
   * path is byte-for-byte unaffected. Injected so a test can flip the provider
   * without mocking the env module.
   */
  readonly recordingProvider?: 'egress' | 'worker';
  /**
   * PR A — mints the presigned PUT the worker uploads the MP3 to (worker
   * provider only). Injected so a test needs no Supabase Storage. In production
   * it is supplied ONLY when an S3 destination is configured; an unconfigured
   * deployment simply cannot prepare a worker upload, which is the safe
   * direction (recording less than promised harms nobody).
   */
  readonly uploadSigner?: WorkerRecordingUploadSigner;
  /**
   * PR A — finalizes a worker-inband recording (download + hash + size-check +
   * manifest + link). Injected so a test can observe the call without a DB;
   * production defaults to `finalizeAuthoritativeRecording`, which dispatches to
   * its worker branch on the synthetic `EG_worker_` egress id.
   */
  readonly finalizeRecording?: (sessionId: string) => Promise<'ready' | 'fallback_required' | 'pending'>;
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
  /** Existing durable queue seam; production uses the phone runtime queue. */
  readonly assessmentQueue?: Pick<Queue, 'enqueue'>;
  /**
   * Answer-first ("bounce") state read for the worker poll. In bounce mode the
   * worker polls `GET /attempt/:attemptId/answered` before speaking the
   * disclosure, because the Plivo bridge means the LiveKit participant is
   * present (the bounce endpoint) BEFORE the candidate has actually answered.
   * Injected so a test needs no DB; production reads the bounce store.
   * FAIL-CLOSED: an absent seam reports not-answered.
   */
  readonly readAnsweredState?: (attemptId: string) => Promise<{
    answered: boolean;
    terminal: boolean;
  }>;
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
      role_title: state.roleTitle ?? null,
      role_focus: state.roleFocus ?? null,
      role_required_skills: [...(state.roleRequiredSkills ?? [])],
      interviewer_instructions: state.interviewerInstructions ?? null,
      candidate_evidence: state.resumeFacts ?? {},
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
    // The durable-consent signal a re-dispatched leg reads to skip the gate:
    // gate turns already recorded ⇒ disclosure+consent already ran. A boolean,
    // never a turn text, so nothing of the gate transcript itself crosses.
    gate_recorded: state.gateRecorded === true,
    assessment_exists: state.assessmentExists === true,
    already_scored: state.alreadyScored === true,
  };
}

/** One offered fallback slot, projected from the same occupancy the refusal used. */
interface CallbackAlternative {
  readonly starts_at: string;
  readonly ends_at: string;
  readonly ist_time: string;
  readonly weekday: string;
}

/** How many alternatives the worker is offered on `slot_full`. The bot offers
 *  at most two of these; three is a small deterministic pool it can pick from. */
const CALLBACK_ALTERNATIVES_MAX = 3;

/** Grid occupancy read bound for the alternatives projection. Mirrors the
 *  `GET /calendar/slots` cap so the two projections read the same shape of the
 *  day; a fuller day than this simply yields fewer confidently-free offers. */
const PHONE_CALLBACK_ALTERNATIVES_OCCUPANCY_LIMIT = 400;

/**
 * Nearest FREE slots to a requested instant, for the `slot_full` refusal.
 *
 * Deterministic and bounded. The grid is the SAME projection `GET
 * /calendar/slots` builds — `buildPhoneSlotGrid` over the day's live occupancy
 * — so an offered alternative is `bookable` under exactly the rule that just
 * refused the requested one. A slot is eligible only when it is `bookable`
 * (not in the past, projected capacity remaining) AND still respects the same
 * minimum lead the proposal enforces, so an alternative is never a slot the
 * subsequent propose/confirm would itself refuse. Ordered by absolute distance
 * from the requested start (earlier wins ties, so the nearest slot before is
 * preferred to an equidistant one after), truncated to `CALLBACK_ALTERNATIVES_MAX`.
 *
 * Occupancy is read once, in the caller, and passed in — this function does no
 * IO and reads no clock; every input is a parameter, exactly like the grid it
 * calls.
 */
function nearestFreeAlternatives(input: {
  readonly requestedStart: Date;
  readonly istDateStr: string;
  readonly slotSeconds: number;
  readonly now: Date;
  readonly minLeadSeconds: number;
  readonly occupancy: readonly { startsAt: string; endsAt: string }[];
}): CallbackAlternative[] {
  let grid: readonly PhoneSlot[];
  try {
    grid = buildPhoneSlotGrid({
      date: parseIstCalendarDate(input.istDateStr),
      slotSeconds: input.slotSeconds,
      now: input.now,
      occupancy: input.occupancy,
    });
  } catch {
    // A malformed date or an out-of-envelope step is not worth failing the
    // whole refusal over: the worker still gets `slot_full`, just with no
    // suggestions. Never throw out of the refusal path.
    return [];
  }
  const requestedMs = input.requestedStart.getTime();
  const earliestBookableMs = input.now.getTime() + input.minLeadSeconds * 1000;
  const eligible = grid.filter(
    (s) => s.bookable && Date.parse(s.startsAt) >= earliestBookableMs,
  );
  eligible.sort((a, b) => {
    const da = Math.abs(Date.parse(a.startsAt) - requestedMs);
    const db = Math.abs(Date.parse(b.startsAt) - requestedMs);
    if (da !== db) return da - db;
    // Deterministic tie-break: the earlier instant first.
    return Date.parse(a.startsAt) - Date.parse(b.startsAt);
  });
  return eligible.slice(0, CALLBACK_ALTERNATIVES_MAX).map((s) => ({
    starts_at: s.startsAt,
    ends_at: s.endsAt,
    ist_time: s.istStart,
    weekday: new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      weekday: 'long',
    }).format(new Date(s.startsAt)),
  }));
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
  const readStore = (): PhoneReadStore => deps.readStore ?? createPhoneReadStore(supabase as never);
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
  const assessmentQueue = deps.assessmentQueue
    ?? new Queue(new PgAdapter(supabase as never), { defaultMaxAttempts: 5 });
  // Test routers that inject scoreSession retain the synchronous contract;
  // production's default route uses the durable phone.assessment queue.
  const queueAssessment = deps.scoreSession === undefined && deps.assessmentQueue !== undefined;

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
      // ── WHY THERE IS NO EARLY LEASE RENEWAL HERE ────────────────────
      // A draft of 0045 renewed the attempt lease on `classify.human` and
      // `disclosure.delivered`, to cover the window between "a human
      // answered" and "the agent's own heartbeat has beaten once". At the
      // then-default 60 s lease a candidate who answered on the last ring
      // arrived with roughly half a minute left, and the opening gate could
      // spend most of it.
      //
      // It was removed when the SESSION became part of the heartbeat fence.
      // Since the recording ordering fix (2026-08-26) this route's payload MAY
      // carry a `session_id` — but it is a HINT whose one consumer is the
      // recording starter below, and it must never become the renewal's
      // session: the worker names it for room derivation, not as a fence
      // credential, and a fence satisfied by a field the same caller supplies
      // for another purpose is a fence a reviewer stops trusting. Renewal
      // still requires the /attempt/heartbeat door and its epoch fence, and
      // the route test pins that no event — session hint or not — reaches the
      // renewal seam.
      //
      // AND THE WINDOW IS NOW CLOSED WHERE IT BELONGED — at the lease, not
      // with a second renewal path. `PHONE_BOUNDS.leaseSeconds` defaults to
      // 180, which covers `ringTimeoutSeconds` at its MAXIMUM plus a full
      // `PHONE_OPENING_GATE_SECONDS`, and `dialPhoneAttempt` REFUSES
      // `lease_too_short_for_gate` before it contacts the provider if a
      // deployment configures less. So this route deliberately does nothing
      // about it, and that is now a closed question rather than an accepted
      // residual.
      //
      // Should the lease ever lapse in that window anyway, the failure stays
      // LOUD rather than silent: the agent's first heartbeat answers
      // `lease_lost` and halts the call. B-1 was bad because it was silent.

      // ── The place a recording may begin — now at ANSWER ─────────────
      // 0067 moves the recording start to the earliest lawful point: the
      // moment a leg is ANSWERED (`call.answered`), so the greeting and consent
      // exchange are captured. The SAME shared seam still runs on
      // `disclosure.delivered` as an idempotent FALLBACK — if the answered-time
      // attach failed or the answered event never arrived, the disclosure path
      // still attaches. Both are gated on the event being APPLIED (not merely
      // posted, and not on duplicate/ignored). 0067's
      // `attach_phone_attempt_recording` binds only while the engagement is
      // `dialing` OR `in_call` and the attempt is answered_unclassified/human,
      // and both attach + egress + the 0051 session stamp REFUSE a second start,
      // so re-running on the disclosure fallback is safe and needs no dedup
      // state of our own.
      //
      // A recording failure does NOT undo the event. The transition is durable;
      // failing the request would ask the worker to re-run a step the candidate
      // has already moved past. The asymmetry is deliberate and safe in this
      // direction: the candidate may be recorded slightly less than promised,
      // which harms nobody. The session-hint verification below applies to the
      // `call.answered` path EXACTLY as it does to disclosure.
      if (
        (parsed.data.event_type === 'call.answered'
          || parsed.data.event_type === 'disclosure.delivered')
        && result.status === 'applied'
        // NOT on a duplicate re-post. `apply_phone_event` is idempotent, so a
        // redelivery returns `applied` with `duplicate: true`; the recording is
        // driven on the FIRST application only. The attach/egress/stamp are
        // idempotent too, so this is belt-and-braces rather than the sole
        // guard — but it keeps a worker retry from re-contacting the egress.
        && result.duplicate !== true
        && deps.startRecording !== undefined
      ) {
        await startRecordingForAttempt(
          parsed.data.attempt_id,
          deps,
          now(),
          parsed.data.session_id ?? undefined,
        );
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

  // Proposal is deliberately read-only. The bot may speak a normalized
  // server-derived read-back, but no appointment exists until confirmation.
  router.post('/callbacks/propose', requireWorkerPhoneAuth, async (req, res) => {
    try {
      if (!config().screeningEnabled) {
        return res.status(503).json({ ok: false, error: 'phone_screening_disabled' });
      }
      const parsed = voiceCallbackSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ ok: false, status: 'invalid_request' });
      const startsAt = new Date(parsed.data.starts_at);
      const at = now();
      if (Number.isNaN(startsAt.getTime())) {
        return res.status(400).json({ ok: false, status: 'invalid_request' });
      }
      const resolved = deps.resolveEngagement
        ? await deps.resolveEngagement(parsed.data.attempt_id)
        : null;
      if (!resolved) {
        phoneWorkerLog.info('unknown_event', { schema: 'callback_proposal', error_category: 'unknown_attempt' });
        return res.json({ ok: false, status: 'unknown_attempt' });
      }
      if (resolved.engagementState === 'scheduled') {
        return res.json({ ok: false, status: 'attempt_in_flight' });
      }
      if (startsAt.getTime() < at.getTime() + PHONE_VOICE_CALLBACK_MIN_LEAD_SECONDS * 1000) {
        return res.json({ ok: false, status: 'lead_time_too_short' });
      }
      if (!istWindowOpen(startsAt)) return res.json({ ok: false, status: 'window_closed' });
      const endsAt = new Date(
        startsAt.getTime() + PHONE_VOICE_CALLBACK_DURATION_SECONDS * 1000,
      );
      if (istDate(startsAt) !== istDate(endsAt)) {
        return res.json({ ok: false, status: 'slot_straddles_ist_midnight' });
      }
      if (resolved.engagementState === 'dialing' || resolved.engagementState === 'in_call') {
        const attempts = await readStore().listAttemptsForEngagement({
          engagementId: resolved.engagementId,
          limit: 20,
        });
        if (attempts.some((attempt) =>
          attempt.istDate === istDate(startsAt) &&
          ['initial', 'no_answer_retry', 'scheduled'].includes(attempt.kind)
        )) {
          return res.json({ ok: false, status: 'slot_not_yet_eligible' });
        }
      }
      const day = istDayInstantRange({
        year: Number(istDate(startsAt).slice(0, 4)),
        month: Number(istDate(startsAt).slice(5, 7)),
        day: Number(istDate(startsAt).slice(8, 10)),
      });
      const live = await readStore().listLiveAppointmentsByStart({
        fromIso: day.fromIso,
        toIso: day.toIso,
        limit: PHONE_MAX_CONCURRENT + 1,
      });
      const overlapping = live.filter((appointment) =>
        new Date(appointment.startsAt).getTime() < endsAt.getTime() &&
        new Date(appointment.endsAt).getTime() > startsAt.getTime() &&
        appointment.engagementId !== resolved.engagementId,
      ).length;
      if (overlapping >= PHONE_MAX_CONCURRENT) {
        phoneWorkerLog.info('unknown_event', { schema: 'callback_proposal', error_category: 'slot_full' });
        // Offer nearest free slots so the bot has a bounded, deterministic set
        // to propose next. Read the day's occupancy again with a grid-sized
        // limit (the overlap probe above fetched only MAX_CONCURRENT+1, which is
        // enough to DECIDE `slot_full` but not to project a whole-day grid). Any
        // failure here degrades to no alternatives — never to a thrown refusal.
        let alternatives: CallbackAlternative[] = [];
        try {
          const dayOccupancy = await readStore().listLiveAppointmentsByStart({
            fromIso: day.fromIso,
            toIso: day.toIso,
            limit: PHONE_CALLBACK_ALTERNATIVES_OCCUPANCY_LIMIT,
          });
          alternatives = nearestFreeAlternatives({
            requestedStart: startsAt,
            istDateStr: istDate(startsAt),
            slotSeconds: config().slotSeconds,
            now: at,
            minLeadSeconds: PHONE_VOICE_CALLBACK_MIN_LEAD_SECONDS,
            occupancy: dayOccupancy.map((a) => ({ startsAt: a.startsAt, endsAt: a.endsAt })),
          });
        } catch {
          alternatives = [];
        }
        return res.json({ ok: false, status: 'slot_full', alternatives });
      }
      const wall = istWallClock(startsAt);
      phoneWorkerLog.info('unknown_event', { schema: 'callback_proposal', error_category: 'proposal_valid' });
      return res.json({
        ok: true,
        status: 'proposal_valid',
        starts_at: startsAt.toISOString(),
        ends_at: endsAt.toISOString(),
        ist_date: istDate(startsAt),
        weekday: new Intl.DateTimeFormat('en-IN', {
          timeZone: 'Asia/Kolkata', weekday: 'long',
        }).format(startsAt),
        ist_time: `${String(wall.hour).padStart(2, '0')}:${String(wall.minute).padStart(2, '0')}`,
        time_zone: 'Asia/Kolkata',
        duration_seconds: PHONE_VOICE_CALLBACK_DURATION_SECONDS,
      });
    } catch {
      return res.status(503).json({ ok: false, status: 'phone_callback_proposal_error' });
    }
  });

  router.post('/callbacks/confirm', requireWorkerPhoneAuth, async (req, res) => {
    try {
      if (!config().screeningEnabled) {
        return res.status(503).json({ ok: false, error: 'phone_screening_disabled' });
      }
      const parsed = voiceCallbackSchema.safeParse(req.body);
      const confirm = stores().confirmCandidateVoiceCallback;
      if (!parsed.success || typeof confirm !== 'function') {
        return res.status(400).json({ ok: false, status: 'invalid_request' });
      }
      const result = await confirm({
        attemptId: parsed.data.attempt_id,
        startsAt: new Date(parsed.data.starts_at),
        now: now(),
      });
      if (result.status === 'ok' || result.status === 'already_confirmed') {
        phoneWorkerLog.info('unknown_event', { schema: 'callback_confirmation', error_category: result.status });
        return res.json({
          ok: true,
          status: result.status,
          appointment_id: result.appointmentId,
          version: result.version,
        });
      }
      phoneWorkerLog.info('unknown_event', { schema: 'callback_confirmation', error_category: result.status });
      return res.json({ ok: false, status: result.status });
    } catch {
      phoneWorkerLog.warn('unknown_event', { schema: 'callback_confirmation', error_category: 'phone_callback_confirmation_error' });
      return res.status(503).json({ ok: false, status: 'phone_callback_confirmation_error' });
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


  // ── POST /attempt/heartbeat ───────────────────────────────────────
  // 0045. The renewal that keeps a CONCURRENCY lease alive for the length of
  // a conversation — the fleet-slot lease, not the 0028 queue lease.
  //
  // Why this route exists at all: the lease is minted by admission and
  // extended just far enough to cover the originate. A screening runs for
  // minutes, so without renewal the lease expired mid-call on every answered
  // call, the slot was handed to somebody else while the candidate was still
  // talking, the reclaim sweep marked a live conversation `abandoned`, and the
  // agent's eventual `assessment.completed` was ignored because that edge is
  // gated on `in_call`. A screening that was conducted and SCORED was lost,
  // silently.
  //
  // The response carries no lease token and no absolute expiry — only the
  // cadence the worker should beat at next. The SERVER owns that number, so
  // the lease length stays a server-side knob and a worker cannot drift off it.
  router.post('/attempt/heartbeat', requireWorkerPhoneAuth, async (req, res) => {
    try {
      if (!config().screeningEnabled) {
        return res.status(503).json({ ok: false, error: 'phone_screening_disabled' });
      }
      const parsed = attemptHeartbeatSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ ok: false, status: 'invalid_request' });
      }
      const cfg = config();
      const result = await stores().heartbeatAttemptByEpoch({
        attemptId: parsed.data.attempt_id,
        epoch: parsed.data.epoch,
        sessionId: parsed.data.session_id,
        leaseSeconds: cfg.leaseSeconds,
        now: now(),
      });
      // `lease_lost` is forwarded ONLY when the RPC actually said it. It is
      // the one answer that means "stop the conversation, the slot is gone,
      // do not retry" — so collapsing every non-`ok` status into it would let
      // an `unknown` reply from a future RPC revision silently terminate live
      // calls. `OrUnknown` exists precisely because that can happen, and an
      // answer we did not understand is not evidence the lease was lost.
      if (result.status === 'lease_lost') {
        return res.json({ ok: true, status: 'lease_lost' });
      }
      if (result.status !== 'ok') {
        // Retryable and NOT terminal. The worker keeps beating; if the lease
        // really has gone, the next beat says so in a word we recognise.
        return res.status(500).json({ ok: false, status: 'phone_heartbeat_error' });
      }
      // A THIRD of the lease, the same ratio `lib/queue/runner.ts` uses for
      // the queue lease. Under a half is the requirement; a third leaves room
      // for one beat to be lost entirely without the lease lapsing.
      return res.json({
        ok: true,
        status: 'ok',
        next_heartbeat_seconds: Math.max(1, Math.floor(cfg.leaseSeconds / 3)),
      });
    } catch {
      return res.status(500).json({ ok: false, status: 'phone_heartbeat_error' });
    }
  });

  // ── GET /attempt/:attemptId/answered ──────────────────────────────
  // The answer-first ("bounce") readiness poll. In bounce mode LiveKit dials a
  // Plivo endpoint that answers INSTANTLY, so the LiveKit participant is present
  // before the CANDIDATE has answered — the worker must not speak the disclosure
  // to a leg that is really just the bounce endpoint. It polls this until
  // `answered` (the attempt's `answered_at` is set OR its state is in the
  // answered family) or `terminal` (the engagement is terminal, so stop).
  //
  // Tiny and PII-free: two booleans derived from the attempt/engagement rows.
  // Same worker auth as every other endpoint. A malformed id is a flat 400; an
  // absent read seam fails closed to `answered:false, terminal:false`.
  router.get('/attempt/:attemptId/answered', requireWorkerPhoneAuth, async (req, res) => {
    try {
      if (!config().screeningEnabled) {
        return res.status(503).json({ ok: false, error: 'phone_screening_disabled' });
      }
      const attemptId = req.params.attemptId;
      if (typeof attemptId !== 'string' || !UUID_RE.test(attemptId)) {
        return res.status(400).json({ ok: false, error: 'invalid_request' });
      }
      if (deps.readAnsweredState === undefined) {
        // No seam wired: the safe answer is "not answered, not terminal" so the
        // worker keeps polling rather than speaking prematurely.
        return res.json({ ok: true, answered: false, terminal: false });
      }
      const state = await deps.readAnsweredState(attemptId);
      return res.json({ ok: true, answered: state.answered === true, terminal: state.terminal === true });
    } catch {
      return res.status(500).json({ ok: false, error: 'phone_answered_state_error' });
    }
  });

  // ── POST /assessment/probe ───────────────────────────────────────
  router.post('/assessment/probe', requireWorkerPhoneAuth, async (req, res) => {
    try {
      if (!config().screeningEnabled) return res.status(503).json({ ok: false, error: 'phone_screening_disabled' });
      const parsed = assessmentProbeSchema.safeParse(req.body);
      const recordProbe = stores().recordProbe;
      if (!parsed.success || typeof recordProbe !== 'function') return res.status(400).json({ ok: false, status: 'invalid_request' });
      const result = await recordProbe({
        sessionId: parsed.data.session_id,
        questionKey: parsed.data.question_key,
        expectedIndex: parsed.data.expected_index,
        sourceEventId: parsed.data.source_event_id,
        now: now(),
      });
      return res.json({ ok: result.status === 'probe_recorded' || result.status === 'duplicate', status: result.status, duplicate: result.duplicate === true });
    } catch {
      return res.status(500).json({ ok: false, status: 'phone_assessment_error' });
    }
  });

  // ── POST /assessment/consent-start ────────────────────────────────
  // The only consent-to-assessment boundary. The SQL RPC applies the
  // deterministic human/disclosure events and starts the assessment in one
  // transaction; recording begins asynchronously after that commit.
  router.post('/assessment/consent-start', requireWorkerPhoneAuth, async (req, res) => {
    try {
      if (!config().screeningEnabled) {
        return res.status(503).json({ ok: false, error: 'phone_screening_disabled' });
      }
      const parsed = consentStartSchema.safeParse(req.body);
      const consentAndStart = stores().consentAndStart;
      if (!parsed.success || typeof consentAndStart !== 'function') {
        return res.status(400).json({ ok: false, status: 'invalid_request' });
      }
      const result = await consentAndStart({
        attemptId: parsed.data.attempt_id,
        sessionId: parsed.data.session_id,
        epoch: parsed.data.epoch,
        now: now(),
      });
      if (result.status !== 'ok' || result.state === undefined) {
        return res.json({ ok: false, status: result.status });
      }
      // This is deliberately detached from the consent transaction. A slow
      // egress provider must not delay the first authorized question; the
      // recording reconciler owns one audited retry for the pending marker.
      void startRecordingForAttempt(parsed.data.attempt_id, deps, now());
      return res.json({ ok: true, status: 'ok', ...sanitizeAssessmentState(result.state) });
    } catch {
      return res.status(500).json({ ok: false, status: 'phone_consent_start_error' });
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
        //
        // `already_scored` is the one that is not really a refusal at all: it
        // says the screening is FINISHED and its acknowledgement was lost. The
        // worker's only legitimate action on it is to post
        // `assessment.completed` — which 0044 accepts precisely because the
        // row the RPC just found is there. It is forwarded verbatim, like the
        // rest; this route decides nothing the database has already decided.
        return res.json({ ok: false, status: state.status });
      }
      return res.json({ ok: true, status: 'ok', ...sanitizeAssessmentState(state) });
    } catch {
      return res.status(500).json({ ok: false, status: 'phone_assessment_error' });
    }
  });

  // ── POST /assessment/state ────────────────────────────────────────
  // READ-ONLY. A re-dispatched leg (worker deploy/crash mid-call) calls this
  // before the gate speaks, so it can tell an already-consented conversation
  // apart from a fresh one and NOT ask for consent a second time (2026-08-29).
  // It binds nothing, activates nothing and writes nothing — it forwards
  // `get_phone_assessment_state`, whose `gate_recorded` flag is the durable
  // proof that the gate already ran. A fresh call has no plan yet, so this
  // returns `plan_missing` and the worker runs the full gate as before.
  router.post('/assessment/state', requireWorkerPhoneAuth, async (req, res) => {
    try {
      if (!config().screeningEnabled) {
        return res.status(503).json({ ok: false, error: 'phone_screening_disabled' });
      }
      const parsed = assessmentStateSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ ok: false, status: 'invalid_request' });
      }
      const state = await stores().assessmentState({ sessionId: parsed.data.session_id });
      if (state.status !== 'ok') {
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
        ...(parsed.data.covered_question_keys.length > 0
          ? { coveredQuestionKeys: parsed.data.covered_question_keys }
          : {}),
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

  // ── POST /assessment/item-turn ────────────────────────────────────
  // 0071 / X4. Persists ONE transcript turn AS IT HAPPENS, so a mid-call
  // crash between question boundaries no longer loses every turn since the
  // last boundary. Deduped on `source_item_id`, so a redelivered item does not
  // double-insert. This is best-effort by contract: a failure here must NEVER
  // fail a live call — the boundary path remains the resume authority — so the
  // worker logs and continues on any non-2xx. `applied` (fresh) and `applied`
  // with `duplicate:true` are both success; the two live-session refusals are
  // 409 (state the worker cannot fix by retrying) and a store throw is 503.
  router.post('/assessment/item-turn', requireWorkerPhoneAuth, async (req, res) => {
    try {
      if (!config().screeningEnabled) {
        return res.status(503).json({ ok: false, error: 'phone_screening_disabled' });
      }
      const parsed = itemTurnSchema.safeParse(req.body);
      const commitItemTurn = stores().commitItemTurn;
      if (!parsed.success || typeof commitItemTurn !== 'function') {
        return res.status(400).json({ ok: false, status: 'invalid_request' });
      }
      const result = await commitItemTurn({
        sessionId: parsed.data.session_id,
        speaker: parsed.data.speaker,
        text: parsed.data.text,
        sourceItemId: parsed.data.source_item_id,
        turnStartedAtMs: parsed.data.turn_started_at_ms ?? null,
        now: now(),
      });
      if (result.status === 'applied') {
        return res.json({
          ok: result.applied,
          status: result.status,
          duplicate: result.duplicate,
        });
      }
      // A refusal the DB decided — bad shape, unknown session, or a session no
      // longer live. 409 so the worker can tell it from a transport fault.
      return res.status(409).json({ ok: false, status: result.status });
    } catch {
      // A store throw is an RPC transport fault. Sanitized 503: a driver
      // message here could quote a transcript row.
      return res.status(503).json({ ok: false, status: 'phone_item_turn_error' });
    }
  });

  // ── POST /assessment/gate-turns ───────────────────────────────────
  // 0067. Persists the PRE-CONSENT (gate) transcript — the greeting and
  // consent exchange that happens before `disclosure.delivered`. These turns
  // are written with `is_gate = true` and are DISTINCT from the scored
  // assessment turns `/assessment/turn` commits: the scorer excludes them, and
  // the recruiter transcript view includes them.
  //
  // Idempotent at the gate: a session that already carries any gate row answers
  // `already_recorded`, which is a SUCCESS. `ok` and `already_recorded` are
  // 200; the refusals (`invalid_turns`, `unknown_session`, `session_not_active`)
  // are 409, because none of them is a transport fault the worker should retry
  // blindly. An RPC transport error is 503. The turn TEXT is never echoed back.
  router.post('/assessment/gate-turns', requireWorkerPhoneAuth, async (req, res) => {
    try {
      if (!config().screeningEnabled) {
        return res.status(503).json({ ok: false, error: 'phone_screening_disabled' });
      }
      const parsed = gateTurnsSchema.safeParse(req.body);
      const commitGateTurns = stores().commitGateTurns;
      if (!parsed.success || typeof commitGateTurns !== 'function') {
        return res.status(400).json({ ok: false, status: 'invalid_request' });
      }
      const result = await commitGateTurns({
        sessionId: parsed.data.session_id,
        sourceEventId: parsed.data.source_event_id,
        turns: parsed.data.turns,
        now: now(),
      });
      // `ok` and `already_recorded` are both success — the gate transcript is
      // durable either way. `turns_written` is intentionally NOT returned: the
      // worker does not act on the count, and echoing it back tells it nothing
      // it needs. The turn text is never in the response at all.
      if (result.status === 'ok' || result.status === 'already_recorded') {
        return res.json({ ok: true, status: result.status });
      }
      // A refusal the DB decided — the shape was bad, the session was unknown,
      // or the session was not live. Forwarded as a 409 so the worker can tell
      // it apart from a transport fault (503) it may retry.
      return res.status(409).json({ ok: false, status: result.status });
    } catch {
      // A store throw is an RPC transport fault. 503, bare and sanitized: a
      // driver message here could quote a transcript row.
      return res.status(503).json({ ok: false, status: 'phone_gate_turns_error' });
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
      // ── ALREADY SCORED: ADOPT, NEVER RE-SCORE ─────────────────────
      // The row is already there, so there is nothing to compute and nothing
      // to write. Short-circuiting here is not an optimisation: it is what
      // makes "no rescore, no duplicate writeback" STRUCTURAL rather than a
      // property of how `runAssessment` happens to behave on a second call.
      // Falling through would reach the scorer, which would adopt the same
      // row — correct today, and one refactor away from not being.
      //
      // It sits ABOVE the plan-completeness check on purpose. A scored
      // screening is finished whatever the cursor says; refusing it
      // `plan_incomplete` because a boundary write was lost after the score
      // landed would strand exactly the case this branch exists for.
      if (before.alreadyScored === true) {
        return res.json({ ok: true, status: 'scored', adopted: true });
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

      if (queueAssessment) {
        try {
          await assessmentQueue.enqueue(
            PHONE_ASSESSMENT_QUEUE,
            { session_id: sessionId, attempt_id: parsed.data.attempt_id },
            { dedupKey: phoneAssessmentDedupKey(sessionId), maxAttempts: 5 },
          );
          // The queue worker owns scoring and the terminal event. Returning
          // immediately prevents the PSTN worker from timing out while Gemini
          // scores a completed transcript.
          return res.json({ ok: true, status: 'scoring_queued' });
        } catch {
          return res.json({ ok: false, status: 'completion_failed' });
        }
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
      return res.json({ ok: true, status: 'scored', adopted: false });
    } catch {
      return res.status(500).json({ ok: false, status: 'phone_assessment_error' });
    }
  });

  // ── PR A: the WORKER-INBAND recording endpoints ───────────────────────
  // Additive and flag-gated. `recordingProvider` defaults to
  // `env.recordingProvider` ('egress'), and on 'egress' BOTH routes 404 as if
  // they did not exist — the egress recording path is untouched. They activate
  // only on `RECORDING_PROVIDER=worker`.
  const recordingProvider = deps.recordingProvider ?? env.recordingProvider;
  const workerRecordingActive = recordingProvider === 'worker';

  // ── POST /recording/prepare ───────────────────────────────────────
  // Runs the SAME consent gate the egress path uses (attach + role decision),
  // stamps `worker_inband` provenance + `active` egress status, and mints a
  // presigned PUT for the DERIVED attempt object key. A refusal (role
  // undecidable, attach refused, pre-disclosure) returns NO uploadUrl and binds
  // nothing.
  router.post('/recording/prepare', requireWorkerPhoneAuth, async (req, res) => {
    try {
      if (!config().screeningEnabled) {
        return res.status(503).json({ ok: false, error: 'phone_screening_disabled' });
      }
      // On the egress provider this endpoint does not exist.
      if (!workerRecordingActive) {
        return res.status(404).json({ ok: false, error: 'not_found' });
      }
      const parsed = recordingPrepareSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ ok: false, status: 'invalid_request' });
      }
      // No signer wired ⇒ the deployment cannot record inband. Refuse cleanly;
      // never pretend to have bound something the worker cannot upload to.
      if (deps.uploadSigner === undefined) {
        return res.status(503).json({ ok: false, status: 'recording_unavailable' });
      }
      const result = await prepareWorkerRecording(
        {
          engagementId: parsed.data.engagement_id,
          attemptId: parsed.data.attempt_id,
          sessionId: parsed.data.session_id,
          now: now(),
        },
        { stores: stores(), signer: deps.uploadSigner },
      );
      // An unstamped recording is unfindable by the session-keyed read path;
      // say so out loud here (the dialer package is console-free by pin).
      if (result.boundForUpload && result.sessionStamped !== true) {
        phoneWorkerLog.warn('unknown_event', {
          schema: 'worker_recording_prepare',
          error_category: `session_egress_stamp_missed:${result.stampStatus ?? 'unknown'}`,
        });
      }
      if (result.status === 'prepared' || result.status === 'already_prepared') {
        return res.json({
          ok: true,
          status: result.status,
          object_key: result.objectKey,
          upload_url: result.uploadUrl,
        });
      }
      // Every refusal is forwarded WITHOUT an upload_url, so the worker cannot
      // upload audio for a binding that was refused.
      return res.json({
        ok: false,
        status: result.status,
        reason: result.refusal ?? null,
      });
    } catch {
      return res.status(500).json({ ok: false, status: 'phone_recording_prepare_error' });
    }
  });

  // ── POST /recording/complete ──────────────────────────────────────
  // The worker has PUT the MP3 to the presigned URL. Mark the session egress
  // `complete` and run the finalizer's worker branch (download + hash +
  // size-check + manifest + link). The finalizer re-hashes the object itself;
  // the worker's reported sha/size are advisory only.
  router.post('/recording/complete', requireWorkerPhoneAuth, async (req, res) => {
    try {
      if (!config().screeningEnabled) {
        return res.status(503).json({ ok: false, error: 'phone_screening_disabled' });
      }
      if (!workerRecordingActive) {
        return res.status(404).json({ ok: false, error: 'not_found' });
      }
      const parsed = recordingCompleteSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ ok: false, status: 'invalid_request' });
      }
      const finalize = deps.finalizeRecording ?? finalizeAuthoritativeRecording;
      const status = await finalize(parsed.data.session_id);
      // `ready` = linked and servable; `pending` = a bounded deferral (transient
      // storage) the finalize convergence will retry; `fallback_required` =
      // latched (oversize / no egress). All are forwarded truthfully.
      return res.json({ ok: status === 'ready', status });
    } catch {
      return res.status(500).json({ ok: false, status: 'phone_recording_complete_error' });
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
  sessionIdHint?: string,
): Promise<void> {
  try {
    const resolved = deps.resolveEngagement
      ? await deps.resolveEngagement(attemptId)
      : null;
    if (resolved === null) return;
    // The DB binding is the authority when it exists; the worker's hint covers
    // the window before /assessment/start binds it (which is exactly when the
    // disclosure fires). Without the hint, this skipped SILENTLY on every call
    // — the console.warn below is the tripwire that must never let that class
    // of nothing-happened hide again. Sanitized: a stable code and a uuid.
    let sessionId = resolved.sessionId;
    if (sessionId === undefined && sessionIdHint !== undefined) {
      // The hint is worker-supplied and only UUID-shaped by schema. Before it
      // may name the room to record, the server verifies the association the
      // DB can already prove: the hinted session was provisioned for this
      // attempt's candidate (`ensureSession` at dial time). Absent seam or
      // failed check both refuse — a recording of the wrong room is the exact
      // harm this phase exists to prevent, so the default direction is closed.
      const verified = deps.verifySessionHint !== undefined
        && await deps.verifySessionHint({
          sessionId: sessionIdHint,
          engagementId: resolved.engagementId,
        });
      if (verified) {
        sessionId = sessionIdHint;
      } else {
        console.warn(JSON.stringify({
          level: 'warn',
          component: 'phone-worker',
          event: 'phone_recording_skipped',
          error_category: 'session_hint_unverified',
          attempt_id: attemptId,
        }));
        return;
      }
    }
    if (sessionId === undefined) {
      console.warn(JSON.stringify({
        level: 'warn',
        component: 'phone-worker',
        event: 'phone_recording_skipped',
        error_category: 'no_session_for_attempt',
        attempt_id: attemptId,
      }));
      return;
    }
    const started = await deps.startRecording?.({
      engagementId: resolved.engagementId,
      attemptId,
      roomName: phoneRoomName(sessionId),
      sessionId,
      now,
    });
    // The dialer package is console-free by structural pin, so the stamp
    // outcome is reported HERE. An unstamped recording is unfindable by the
    // session-keyed read path — silence is how the first live MP3 stayed
    // "not found", and that class does not get to be quiet again.
    if (started !== undefined && started.egressStarted === true
        && (started as { sessionStamped?: boolean }).sessionStamped !== true) {
      console.warn(JSON.stringify({
        level: 'warn',
        component: 'phone-worker',
        event: 'phone_session_egress_stamp_missed',
        error_category: String((started as { stampStatus?: string }).stampStatus ?? 'unknown'),
        attempt_id: attemptId,
      }));
    }
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
  // Explicit production wiring enables durable post-call scoring. Test routers
  // that intentionally inject only the legacy scoring seam remain synchronous.
  assessmentQueue: new Queue(new PgAdapter(supabase as never), { defaultMaxAttempts: 5 }),
  async readAnsweredState(attemptId) {
    return createPlivoBounceStore(supabase as never).readAnsweredState(attemptId);
  },
  async verifySessionHint({ sessionId, engagementId }) {
    // Two narrow reads, both by primary key, both fail-closed: any error, any
    // missing row, any null candidate refuses the hint. The predicate is the
    // one `ensureSession` established at dial time — the session was
    // provisioned/adopted FOR THIS CANDIDATE — so a hint that names any other
    // conversation's session cannot pass it.
    try {
      const eng = await (supabase as never as {
        from(t: string): {
          select(c: string): {
            eq(k: string, v: string): { maybeSingle(): Promise<{ data: { candidate_id?: string } | null; error: unknown }> };
          };
        };
      }).from('phone_engagements').select('candidate_id').eq('id', engagementId).maybeSingle();
      if (eng.error || !eng.data?.candidate_id) return false;
      const ses = await (supabase as never as {
        from(t: string): {
          select(c: string): {
            eq(k: string, v: string): { maybeSingle(): Promise<{ data: { candidate_id?: string } | null; error: unknown }> };
          };
        };
      }).from('call_sessions').select('candidate_id').eq('id', sessionId).maybeSingle();
      if (ses.error || !ses.data?.candidate_id) return false;
      return ses.data.candidate_id === eng.data.candidate_id;
    } catch {
      return false;
    }
  },
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
  // PR A. The presigned-PUT signer is supplied ONLY on the worker provider with
  // a configured storage destination; otherwise `/recording/prepare` refuses
  // `recording_unavailable`. On the default egress provider the two
  // `/recording/*` routes 404 regardless, so this is inert.
  uploadSigner: env.recordingProvider === 'worker' && phoneEgressConfigured()
    ? {
        async createUploadUrl(objectKey: string): Promise<{ uploadUrl: string } | null> {
          try {
            const { data, error } = await supabase.storage
              .from(env.recordingsBucket)
              .createSignedUploadUrl(objectKey);
            if (error || !data?.signedUrl) return null;
            return { uploadUrl: data.signedUrl };
          } catch {
            return null;
          }
        },
      }
    : undefined,
});
