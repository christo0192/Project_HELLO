/**
 * R1 candidate-facing routes: `/api/r1/*` (plan sections 4, 7.8, 7.10, 8.3 and
 * v2 section 8).
 *
 * Authentication is the secret the candidate holds, never a recruiter session:
 *
 *   status, consent, consent/withdraw, preflight, attempts
 *       the LINK token (256 random bits from the HR link fragment; only its
 *       SHA-256 digest is stored, `interview_rounds.link_token_digest`);
 *   attempts (rejoin)    the link token AND the attempt NONCE;
 *   exchange, ready      an ATTEMPT TOKEN AND the NONCE (lib/r1/attempt-token).
 *
 * Invariants:
 *  1. These routes are public in `auth.ts` by exact method+path and perform
 *     their own authentication before any read or write that depends on it.
 *     An unknown link answers one stable 404 and never reveals why. Nor does it
 *     reveal the server's configuration: the kill switch is read only AFTER the
 *     link (or the attempt token and nonce) has authenticated, so a caller with a
 *     made-up token learns nothing about whether R1 is switched on.
 *  2. R1 never creates `candidate_invites` or `candidate_access_grants` and
 *     never reads or writes `consent_records` / `consent_templates`. A held R1
 *     secret therefore cannot reach the legacy consent routes, the legacy
 *     exchange, or the phone consent RPCs by construction.
 *  3. Room creation goes through `provisionRoomForCreatedSession` with
 *     `lane: 'r1'`: the room is marked `lane: r1`, carries R1's limits and
 *     NEVER starts LiveKit egress, on the R1 SFU and on the Cloud fallback.
 *  4. The candidate token grants camera and microphone publishing ONLY, no
 *     data channel, no metadata updates, 10 minute TTL, and is signed with the
 *     secret of the endpoint `browserLiveKitEndpoint()` selected: the R1
 *     secret when `BROWSER_LIVEKIT_TARGET=r1`, otherwise the Cloud secret. It is
 *     minted by `mintCandidateJoin` (lib/r1/candidate-join.ts) with its default
 *     `browser` grant.
 *  5. Withdrawal is never gated by a kill switch, maintenance mode or the
 *     round's state: a candidate can always withdraw. A decline (the
 *     human-interview alternative, D14) is not gated by the kill switch either.
 *     A withdrawal or decline that could not stop a live interview answers 503
 *     `r1_withdraw_incomplete`, never 200, so the page retries.
 *  6. Candidate responses are `Cache-Control: no-store` and never contain a
 *     digest, the persona, the first name or any other candidate data.
 *  7. The notice a person is shown (candidate or staff dry run) is chosen by the
 *     SERVER from `interview_rounds.consent_locale`. No route takes a locale from
 *     the client, so a candidate cannot select, or consent to, the staff notice
 *     (PR-CT audience contract, migration 0123). The template route is therefore
 *     a POST carrying the link token in its body, never a GET with the token in
 *     the URL.
 *  8. Fence 7 (the candidate token requires a dispatched interviewer) holds on the
 *     R1 SFU, where nothing auto-dispatches: with target `r1` and no worker gate
 *     (orchestration off, empty or malformed `BROWSER_AGENT_NAME`) every new-work
 *     route and the exchange of a `waiting` attempt answer 503 `r1_unavailable`
 *     BEFORE admission, provisioning or any room, and a `disabled` gate verdict is
 *     a 202 `preparing`, never a token. Cloud keeps the unnamed auto-dispatching
 *     worker. Cloud as the R1 SFU is also refused while the legacy browser lane is
 *     enabled: that worker must run `R1_LANE_MODE=off` and would delete every
 *     marked room after a start and capacity were spent.
 *  9. A `waiting` attempt re-asserts its marked room on EVERY exchange, before the
 *     worker gate: R1 sessions stay `waiting` for the whole interview, the room
 *     lapses after 180 s empty or is deleted by a refusing worker, and on the R1 SFU
 *     (no auto-create) a missing room is otherwise a permanent `preparing` loop (on
 *     Cloud the join would auto-create an UNMARKED room). `in_progress` is left
 *     alone: the candidate is already in the room.
 * 10. The "I'm ready" button (`POST /api/r1/ready`) is a SERVER relay, because the candidate
 *     token cannot publish data (invariant 4). The route authenticates like the exchange (attempt
 *     token and nonce), derives the room from the VERIFIED attempt's own session (the body names
 *     nothing but the two secrets, so one attempt can never signal another's room), and sends one
 *     fixed, pinned message (`R1_READY_PAYLOAD` on `R1_READY_TOPIC`) to the room's interviewer
 *     with the server SDK. Nothing the caller sends is relayed.
 * 11. A Meet round (`interview_rounds.channel = meet`, migration 0142) never takes the browser
 *     path: it is held in Google Meet at the booked time. `/status` and `/attempts` (admission
 *     and the nonce rejoin alike) answer 409 `round_channel_meet` as soon as the link is
 *     recognised, BEFORE the kill switch, maintenance or the settings are read, so no switch
 *     (the Meet flag included) changes that answer. `/exchange` and `/ready` answer it right
 *     after the attempt's session and round are known to belong together (a Meet session's
 *     nonce never leaves the server, so there this is defence in depth). Nothing is admitted,
 *     provisioned, dispatched, audited or written. `/preflight`, `/consent`,
 *     `/consent-template` and `/consent/withdraw` are NOT guarded: a Meet round's link digest
 *     is unusable (0142), a withdrawal is never gated (invariant 5), and the device check and
 *     the notice start nothing. The channel is never returned: the guard compares it only with
 *     `meet` (a row without it reads as browser), so every browser answer is byte-identical.
 * 12. The Meet bridge (`POST /api/r1/meet/exchange`, M034, dark behind R1_MEET_ENABLED) is the one
 *     route a Meet round takes. Its secret is a single-use BRIDGE TICKET (32 random bytes in the
 *     bridge page's URL fragment; the database holds only its HMAC digest in the domain
 *     `hello:r1:meet-bridge:v1`, keyed from WORKER_CONTEXT_SECRET). Flag off answers 503
 *     `meet_disabled` before the body is parsed or anything is read. Otherwise, in order: strict
 *     body; the keys; a READ-ONLY peek of the booking by digest, which decides unknown (404),
 *     already claimed (409 + alert), not live (409), too early (425) and too late (410) without
 *     spending the ticket and before any configuration is read (invariant 1); then the kill
 *     switch, the round (a live Meet round), maintenance, `laneForNewWork` (fence 7 inside),
 *     DeepSeek health and consent (HR-attested rows count); only then `r1_meet_claim_ticket`,
 *     authoritative under the booking row lock, so no transient refusal burns the ticket. The
 *     round's own live session, bound to this booking or not (an admission whose bind or answer
 *     was lost), is continued; with none, the server admits through `r1_admit_attempt` (the nonce
 *     is generated and hashed here and never leaves the server) and binds the session with
 *     `r1_meet_bind_session` right away. A FIRST call never waits for a worker: unless the session
 *     is already `in_progress` (a token at once) it answers 202 here, so every slow step runs on a
 *     call that can be repeated. The resumed call mirrors the browser exchange: marked room (with
 *     the bridge identity mirrored in its metadata), `runR1JoinGate` with the Meet dispatch values
 *     (fail closed on every endpoint), consent again, and the token from the lib preset
 *     `meet_bridge` (microphone only, no data channel, no metadata updates, identity
 *     `meet-<first 8 of the session id>`, no candidate id, 10 minutes). Every 202 carries a FRESH
 *     stateless resume token (`hello:r1:meet-resume:v1`, 5 minutes) that continues the same
 *     booking and session with no second claim or admission. A 503 that has spent nothing (before
 *     the claim, or on a resume) carries `retry_after_sec`; one after the claim of a fresh ticket
 *     never does. A refusal of an authenticated ticket is one closed log line. Nothing in an answer
 *     or a log names the candidate, the round, the booking, the session, the ticket or its digest.
 */

import { randomUUID } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { DataPacket_Kind, TrackSource } from 'livekit-server-sdk';
import { z } from 'zod';
import { supabase } from '../lib/supabase.js';
import { validateBody } from '../lib/validation.js';
import { createLogger } from '../lib/logger.js';
import { minimizeIp, recordAudit, type AuditEvent } from '../lib/audit.js';
import { maintenanceBlockedBody, readMaintenanceState } from '../lib/maintenance.js';
import { transitionSession } from '../lib/session-lifecycle.js';
import {
  provisionRoomForCreatedSession,
  roomNameForSession,
  type RoomServiceClientLike,
} from '../lib/room-provisioning.js';
import {
  accessTokenFor,
  agentDispatchClientFor,
  requireBrowserLiveKitConfigured,
  roomServiceClientFor,
  type LiveKitEndpoint,
} from '../lib/livekit-endpoints.js';
import { browserOrchestrationGate, type BrowserWorkerGate } from '../lib/browser-orchestration.js';
import { env } from '../lib/env.js';
import { legacyBrowserScreeningEnabled } from '../lib/legacy-browser-screening.js';
import { BROWSER_FLY_APP } from '../lib/worker-orchestration-runtime.js';
import { getR1Config } from '../lib/r1/config.js';
import {
  generateNonce,
  hashNonce,
  attemptTokensConfigured,
  mintAttemptToken,
  nonceMatchesDigest,
  peekAttemptToken,
  verifyAttemptToken,
} from '../lib/r1/attempt-token.js';
import {
  loadLiveConsent,
  loadNewestTemplate,
  readRoundConsent,
  recheckRoundConsent,
  type ConsentTemplate,
  type Read,
} from '../lib/r1/consent.js';
import {
  LIVE_SESSION_STATUSES,
  effectiveRoundStatus,
  loadAttempt,
  loadLiveSession,
  loadRoleTitle,
  loadRoundById,
  loadRoundByLink,
  loadSession,
  loadSettings,
  roundIsActive,
  type RoundRow,
  type SessionRow,
} from '../lib/r1/candidate-store.js';
import {
  R1_CANDIDATE_LOCALE,
  R1_STAFF_LOCALE,
  r1ConsentItems,
} from '../lib/r1/consent-items.js';
import { r1DeepSeekHealth } from '../lib/r1/deepseek-health.js';
import { createReadyLimiter, type ReadyLimiter } from '../lib/r1/ready-limiter.js';
import type { DispatchListerLike } from '../lib/r1/worker-gate.js';
import { candidateJoinIdentity, mintCandidateJoin } from '../lib/r1/candidate-join.js';
import { provisionMarkedRoom } from '../lib/r1/marked-room.js';
import { r1WorkerGateMissing, runR1JoinGate, type R1JoinGateDeps } from '../lib/r1/join-gate.js';
import { getR1MeetConfig } from '../lib/r1/meet/config.js';
import { getR1MeetProfile, type R1MeetObjectiveProfile } from '../lib/r1/meet/profiles.js';
import {
  R1_MEET_TICKET_PATTERN,
  r1MeetBridgeKeysConfigured,
  r1MeetTicketDigest,
} from '../lib/r1/meet/ticket.js';
import {
  R1_MEET_RESUME_TOKEN_PATTERN,
  mintR1MeetResumeToken,
  verifyR1MeetResumeToken,
} from '../lib/r1/meet/resume-token.js';
import {
  R1_MEET_CLAIMABLE_STATUSES,
  bindR1MeetSession,
  claimR1MeetTicket,
  peekR1MeetTicket,
  type R1MeetClaimBinding,
  type R1MeetClaimRefusal,
  type R1MeetTicketBooking,
} from '../lib/r1/meet/bridge-store.js';

const log = createLogger('r1-candidate');

// ── Contract constants ───────────────────────────────────────────────

/** Unknown, expired and cancelled links are indistinguishable (invariant 1). */
export const STABLE_LINK_ERROR = 'r1_link_invalid_or_expired';
export const STABLE_ATTEMPT_ERROR = 'r1_attempt_invalid';
export { CANDIDATE_TOKEN_TTL_SEC } from '../lib/r1/candidate-join.js';
/** The preflight token only has to survive one connection attempt. */
export const PREFLIGHT_TOKEN_TTL_SEC = 30;
/** Plan 4 step 5 / 3.3: the A/V check lasts at most 10 s; the room is cut at 12 s. */
export const PREFLIGHT_HARD_STOP_MS = 12_000;
export const PREFLIGHT_POLICY = {
  version: 'r1-av-v1',
  max_seconds: 10,
  min_audio_packets: 50,
  min_video_frames: 45,
} as const;
/**
 * Plan 4 step 6: "another interview is finishing, try again in about 30 minutes" (an R1 interview
 * runs about 30 minutes since the 20-minute role-play). This is the busy answer while admission
 * runs one live R1 at a time, the default.
 */
export const BUSY_RETRY_AFTER_SEC = 30 * 60;
/**
 * The busy answer once admission runs several live R1 sessions at once (0131,
 * `max_concurrent_sessions` above 1 on the self-hosted target): one of many slots frees far
 * sooner than one interview's length, so the candidate is told about 5 minutes.
 */
export const BUSY_SLOTS_RETRY_AFTER_SEC = 5 * 60;
/**
 * The `busy_reason` a 409 `r1_busy` carries ONLY when several slots exist; the page then says
 * "all interview slots are in use". Absent, the body is exactly today's single-slot answer.
 */
export const R1_BUSY_SLOTS_FULL = 'slots_full';
/**
 * The `busy_reason` a 409 `r1_busy` carries when admission said `round_live`: this candidate's
 * OWN round already has a live session (a second tab or device without the rejoin nonce). It is
 * not a full pool, so the page says the interview is open on another device or tab.
 */
export const R1_BUSY_OWN_SESSION_LIVE = 'own_session_live';
export const PREPARING_RETRY_AFTER_SEC = 3;
/** A withdrawal whose room could not be cut is safe to retry at once. */
export const WITHDRAW_RETRY_AFTER_SEC = 3;
/** DeepSeek is unhealthy: the probe is cached for 60 s, so retry after half that. */
export const UNHEALTHY_RETRY_AFTER_SEC = 30;
/**
 * The hint a Meet bridge 503 carries while nothing is spent (before the ticket claim, or on a
 * resume). The bridge page asks again after a hinted 503, inside its own bound, and gives up on one
 * without (contracts section 9, S07 review entry item 1), so a hint after the claim of a fresh
 * ticket would make it replay a spent ticket.
 */
export const MEET_RETRY_AFTER_SEC = 3;
const STARTS_PER_LINK = 3;
/**
 * The "I'm ready" relay (R1-Q cross-PR contract, IMPLEMENTER-RULES.md). The topic and the exact
 * message are pinned on both ends: the worker (`r1_session.READY_TOPIC` / `ready_payload_ok`)
 * accepts nothing else, and a test in each language reads the other's source for them.
 */
export const R1_READY_TOPIC = 'r1ready';
export const R1_READY_PAYLOAD = { v: 1, kind: 'ready' } as const;
/** `{"v":1,"kind":"ready"}`: the only bytes this route ever sends. */
const READY_BYTES = new TextEncoder().encode(JSON.stringify(R1_READY_PAYLOAD));
/** Each LiveKit server call of the relay is bounded, so a stuck call cannot hold the request. */
export const READY_RELAY_TIMEOUT_MS = 4_000;

/** What the landing page tells the candidate about the interview (plan 4 step 3). */
export const R1_FORMAT = {
  duration_minutes: 30,
  camera_required: true,
  microphone_required: true,
  interviewer: 'ai',
  includes_role_play: true,
} as const;

/** `r1_admit_attempt` refusals, mapped to the stable codes the page switches on. */
const ADMISSION_REFUSALS: Readonly<Record<string, { status: number; error: string }>> = {
  disabled: { status: 409, error: 'r1_disabled' },
  paused: { status: 409, error: 'r1_paused' },
  capacity_exhausted: { status: 409, error: 'r1_capacity_exhausted' },
  consent_missing: { status: 409, error: 'consent_required' },
  r1_in_flight: { status: 409, error: 'r1_busy' },
  cloud_capacity_exhausted: { status: 409, error: 'r1_busy' },
  // 0131: the round already has a live session (a second tab without the rejoin nonce). Only
  // answered above a limit of 1; the body carries busy_reason own_session_live (not
  // slots_full), and the page explains it as the candidate's own open interview.
  round_live: { status: 409, error: 'r1_busy' },
  round_not_admissible: { status: 409, error: 'round_not_admissible' },
  round_expired: { status: 409, error: 'round_expired' },
  starts_exhausted: { status: 409, error: 'starts_exhausted' },
  attempts_exhausted: { status: 409, error: 'attempts_exhausted' },
  round_not_found: { status: 404, error: STABLE_LINK_ERROR },
  r1_role_invalid: { status: 503, error: 'r1_unavailable' },
};

/**
 * The same refusals for the Meet bridge's server-side admission (invariant 12, M034 S05 D-S05-10):
 * a round that is missing, lapsed or not admissible is one `round_not_live` (the bridge page tells
 * nothing else apart), and a busy answer carries no `Retry-After` and no `busy_reason`, because
 * every refusal is terminal on the page (it retries only a 202). Frozen.
 */
export const MEET_ADMISSION_REFUSALS: Readonly<Record<string, { status: number; error: string }>> =
  Object.freeze({
    ...ADMISSION_REFUSALS,
    round_not_found: { status: 409, error: 'round_not_live' },
    round_expired: { status: 409, error: 'round_not_live' },
    round_not_admissible: { status: 409, error: 'round_not_live' },
  });

/**
 * The admission refusals this round's OWN live session can cause (0131): it blocks a second start
 * (`round_live`, or `r1_in_flight` at a limit of one), or it spent the last start. The Meet bridge
 * then looks for that session and continues it instead of refusing.
 */
const MEET_OWN_SESSION_REFUSALS: ReadonlySet<string> = new Set(['round_live', 'r1_in_flight', 'starts_exhausted']);

/**
 * `r1_meet_claim_ticket` refusals (migration 0142 section 17) as the bridge page's codes. Null is a
 * server fault (the digest and the clock are checked before the call), answered 503
 * `service_unavailable` with the `r1_meet_claim_failed` alert.
 */
const MEET_CLAIM_REFUSALS: Readonly<Record<R1MeetClaimRefusal, { status: number; error: string } | null>> = {
  invalid_ticket: null,
  invalid_request: null,
  ticket_unknown: { status: 404, error: 'ticket_unknown' },
  ticket_already_claimed: { status: 409, error: 'ticket_already_claimed' },
  booking_not_claimable: { status: 409, error: 'round_not_live' },
  ticket_not_yet_valid: { status: 425, error: 'ticket_not_yet_valid' },
  ticket_expired: { status: 410, error: 'ticket_expired' },
  round_not_live: { status: 409, error: 'round_not_live' },
};

// ── Request schemas ──────────────────────────────────────────────────

const linkToken = z.string().regex(/^[a-f0-9]{64}$/, 'link token is invalid');
const nonceField = z.string().regex(/^[a-f0-9]{64}$/, 'nonce is invalid');
const consentType = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, 'consent type is invalid');

/** The notice audiences a round may carry; the same two values migration 0120 allows. */
const CONSENT_AUDIENCES: ReadonlySet<string> = new Set([R1_CANDIDATE_LOCALE, R1_STAFF_LOCALE]);

export const r1StatusSchema = z.object({ token: linkToken }).strict();
// No `locale`: the notice is chosen by the server from the round (invariant 7), and
// `.strict()` answers 400 to a client that tries to name one.
export const r1ConsentTemplateSchema = z.object({ token: linkToken }).strict();
export const r1ConsentSchema = z
  .object({
    token: linkToken,
    template_version: z.string().min(1).max(64),
    consents: z.array(consentType).max(16),
    status: z.enum(['granted', 'declined']),
  })
  .strict();
export const r1WithdrawSchema = z.object({ token: linkToken }).strict();
export const r1PreflightSchema = z.object({ token: linkToken }).strict();
export const r1AttemptsSchema = z
  .object({ token: linkToken, nonce: nonceField.optional() })
  .strict();
export const r1ExchangeSchema = z
  .object({ attempt_token: z.string().min(1).max(160), nonce: nonceField })
  .strict();
/** The ready relay takes the exchange's two secrets and nothing else (no room, no payload). */
export const r1ReadySchema = z
  .object({ attempt_token: z.string().min(1).max(160), nonce: nonceField })
  .strict();
/**
 * The Meet bridge exchange (invariant 12): the single-use ticket from the page URL fragment, and on
 * a retry after a 202 the resume token that 202 carried. Parsed INSIDE the handler, so any failure
 * is the bridge page's own `invalid_request` (contracts section 9, S07 item 5).
 */
export const r1MeetExchangeSchema = z
  .object({
    ticket: z.string().regex(R1_MEET_TICKET_PATTERN),
    resume_token: z.string().regex(R1_MEET_RESUME_TOKEN_PATTERN).optional(),
  })
  .strict();

// ── Dependencies (injectable for tests) ──────────────────────────────

/** The slice of the LiveKit room API these routes use. */
export interface R1RoomClient extends RoomServiceClientLike {
  createRoom(options: {
    name: string;
    emptyTimeout: number;
    maxParticipants: number;
    metadata: string;
    departureTimeout?: number;
  }): Promise<unknown>;
  /** The ready relay: who is in the room (to find the interviewer), then one data message. */
  listParticipants(room: string): Promise<unknown[]>;
  sendData(
    room: string,
    data: Uint8Array,
    kind: DataPacket_Kind,
    options: { topic?: string; destinationIdentities?: string[] },
  ): Promise<void>;
}

export interface R1CandidateDeps {
  db?: typeof supabase;
  now?: () => number;
  uuid?: () => string;
  provisionRoom?: typeof provisionRoomForCreatedSession;
  /** The browser worker gate, or null when on-demand orchestration is off. */
  resolveGate?: () => BrowserWorkerGate | null;
  /**
   * Is the legacy browser screening lane still enabled (PR-L's
   * `legacyBrowserScreeningEnabled`, read at call time)? Only the Cloud-fallback
   * guard in `laneForNewWork` reads it.
   */
  legacyBrowserEnabled?: () => boolean;
  rooms?: (endpoint: LiveKitEndpoint) => R1RoomClient;
  dispatches?: (endpoint: LiveKitEndpoint) => DispatchListerLike;
  /** DeepSeek health verdict (cached 60 s inside the default probe). */
  health?: () => Promise<boolean>;
  maintenance?: typeof readMaintenanceState;
  /** Runs `work` once after `delayMs`; the default timer never keeps the process alive. */
  schedule?: (work: () => void, delayMs: number) => void;
  /** The per-attempt limiter of `POST /api/r1/ready` (a fresh one per router by default). */
  readyLimiter?: ReadyLimiter;
  /** Bound on each LiveKit server call of the ready relay (`READY_RELAY_TIMEOUT_MS` by default). */
  readyRelayTimeoutMs?: number;
  /** BROWSER_REQUIRE_MACHINE_AGENT_NAME (env, off by default); read before an R1 dispatch. */
  requireMachineAgentName?: () => boolean;
  /**
   * R1_MEET_ENABLED (M034, dark): `getR1MeetConfig().enabled`, read on every Meet bridge exchange
   * and nowhere else. Off, that route answers 503 `meet_disabled` before anything is read. Test seam.
   */
  meetEnabled?: () => boolean;
}

/**
 * What one Meet exchange call (invariant 12) keeps on `res.locals.meetCall`, so the refusals it
 * shares with the browser routes are worded and logged in one place. Set by that route only.
 */
interface MeetCall {
  /** Nothing is spent yet (before the claim, or on a resume): a 503 says when to ask again. */
  unspent: boolean;
  /** The refusal code this call answered, or null (the maintenance envelope has no code). */
  refusal: string | null;
}

function defaultSchedule(work: () => void, delayMs: number): void {
  const timer = setTimeout(work, delayMs);
  timer.unref();
}

/** `ParticipantInfo_Kind.AGENT` (number), or its JSON spelling (see lib/browser-orchestration.ts). */
function agentIdentities(participants: unknown): string[] {
  if (!Array.isArray(participants)) return [];
  const identities: string[] = [];
  for (const participant of participants) {
    const { kind, identity } = (participant ?? {}) as { kind?: unknown; identity?: unknown };
    if ((kind === 4 || kind === 'AGENT') && typeof identity === 'string' && identity !== '') {
      identities.push(identity);
    }
  }
  return identities;
}

/** A LiveKit Twirp answer for a room that does not exist (any more). */
function roomIsMissing(error: unknown): boolean {
  const { code, status } = (error ?? {}) as { code?: unknown; status?: unknown };
  return code === 'not_found' || status === 404;
}

function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('r1_ready_relay_timeout')), ms);
    timer.unref();
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

// ── Router ───────────────────────────────────────────────────────────

export function createR1CandidateRouter(deps: R1CandidateDeps = {}): Router {
  const router = Router();
  const db = deps.db ?? supabase;
  const now = deps.now ?? Date.now;
  const uuid = deps.uuid ?? randomUUID;
  const provisionRoom = deps.provisionRoom ?? provisionRoomForCreatedSession;
  const resolveGate = deps.resolveGate ?? (() => browserOrchestrationGate());
  const requireMachineAgentName = deps.requireMachineAgentName ?? (() => env.browserRequireMachineAgentName);
  const legacyBrowserEnabled = deps.legacyBrowserEnabled ?? legacyBrowserScreeningEnabled;
  const roomsFor = deps.rooms
    ?? ((endpoint: LiveKitEndpoint) => roomServiceClientFor(endpoint) as unknown as R1RoomClient);
  const dispatchesFor = deps.dispatches
    ?? ((endpoint: LiveKitEndpoint) => agentDispatchClientFor(endpoint) as DispatchListerLike);
  const healthy = deps.health ?? (() => r1DeepSeekHealth.check());
  const readMaintenance = deps.maintenance ?? readMaintenanceState;
  const schedule = deps.schedule ?? defaultSchedule;
  const readyLimiter = deps.readyLimiter ?? createReadyLimiter();
  const readyTimeoutMs = deps.readyRelayTimeoutMs ?? READY_RELAY_TIMEOUT_MS;
  const meetEnabled = deps.meetEnabled ?? (() => getR1MeetConfig().enabled);
  const joinGateDeps: R1JoinGateDeps = { db, now, resolveGate, dispatches: dispatchesFor, requireMachineAgentName, log };

  // Tokens, nonces and consent state must never be cached by a proxy or browser.
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  function route(handler: (req: Request, res: Response) => Promise<unknown>) {
    return (req: Request, res: Response, next: NextFunction): void => {
      handler(req, res).catch(next);
    };
  }

  function refuse(
    res: Response,
    status: number,
    error: string,
    extra: Record<string, unknown> = {},
  ): void {
    const meet = res.locals.meetCall as MeetCall | undefined;
    if (meet) {
      meet.refusal = error;
      if (meet.unspent && status === 503 && extra.retry_after_sec === undefined) {
        res.setHeader('Retry-After', String(MEET_RETRY_AFTER_SEC));
        res.status(status).json({ error, ...extra, retry_after_sec: MEET_RETRY_AFTER_SEC });
        return;
      }
    }
    res.status(status).json({ error, ...extra });
  }

  /**
   * Best-effort audit. These routes are candidate-initiated and have already
   * committed their state change; a failing audit sink must not strand the
   * candidate with a lost nonce or a half-reported consent, so it is logged
   * rather than thrown (the privileged recruiter routes stay fail-closed).
   */
  async function audit(
    req: Request,
    event: AuditEvent,
    status: number,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    try {
      await recordAudit(req, event, status, { metadata });
    } catch {
      log.error('unknown_event', { error_category: 'r1_candidate_audit_failed' });
    }
  }

  /** DeepSeek is unhealthy: no LiveKit object and no admission may be created. */
  function refuseUnhealthy(res: Response): void {
    res.setHeader('Retry-After', String(UNHEALTHY_RETRY_AFTER_SEC));
    refuse(res, 503, 'r1_unavailable', { retry_after_sec: UNHEALTHY_RETRY_AFTER_SEC });
  }

  /**
   * The master switch. Never applied to withdrawal or decline (invariant 5), and
   * called only once the caller has authenticated (invariant 1). It answers the
   * bare code: the reason the switch is off (`config.status`, which also says
   * whether the setting is merely unset or malformed) is operator information.
   */
  function enabledOr409(res: Response): boolean {
    if (getR1Config().enabled) return true;
    refuse(res, 409, 'r1_disabled');
    return false;
  }

  async function roundFor(req: Request, res: Response): Promise<RoundRow | null> {
    const found = await loadRoundByLink(db, (req.body as { token: string }).token);
    if (!found.ok) {
      refuse(res, 503, 'service_unavailable');
      return null;
    }
    if (!found.value) {
      refuse(res, 404, STABLE_LINK_ERROR);
      return null;
    }
    return found.value;
  }

  /**
   * The Meet-channel guard (invariant 11): true, with the 409 written, when the round is held in
   * Google Meet, so the caller stops before any switch, admission, room or token.
   */
  function meetRound(res: Response, round: RoundRow): boolean {
    if (round.channel !== 'meet') return false;
    refuse(res, 409, 'round_channel_meet');
    return true;
  }

  /**
   * The locale of the notice this round is shown, or null for a value outside
   * the two audiences (the database check makes that unreachable; failing
   * closed here keeps a drifted row from reaching a template lookup).
   */
  function audienceLocale(round: RoundRow): string | null {
    return CONSENT_AUDIENCES.has(round.consent_locale) ? round.consent_locale : null;
  }

  /** The consent re-check (lib/r1/consent.ts `recheckRoundConsent`); true when granted, else the refusal is written. */
  async function consentStillGranted(res: Response, round: RoundRow): Promise<boolean> {
    const standing = await recheckRoundConsent(db, round);
    if (standing.ok) return true;
    if (standing.reason === 'unreadable') refuse(res, 503, 'service_unavailable');
    else refuse(res, 409, 'consent_required');
    return false;
  }

  /**
   * Does admission run more than one live R1 session at once? 0131's limit, read only to word a
   * busy answer: on the self-hosted target it is least(max_concurrent_sessions, browser worker
   * pool, floor 1); on Cloud it is 1. Any failed or odd read answers false, today's single-slot
   * answer, so an older database (no column yet) words it exactly as before.
   */
  async function admitsSeveralLive(): Promise<boolean> {
    try {
      const settings = await db
        .from('r1_settings')
        .select('livekit_target, max_concurrent_sessions')
        .eq('singleton', true)
        .maybeSingle();
      const row = settings.data as { livekit_target?: unknown; max_concurrent_sessions?: unknown } | null;
      if (settings.error || !row || row.livekit_target !== 'r1') return false;
      const max = row.max_concurrent_sessions;
      if (typeof max !== 'number' || !Number.isInteger(max) || max <= 1) return false;
      const pool = await db
        .from('voice_worker_leases')
        .select('machine_id')
        .eq('app', BROWSER_FLY_APP)
        .eq('pipeline', 'browser');
      if (pool.error || !Array.isArray(pool.data)) return false;
      return Math.min(max, Math.max(pool.data.length, 1)) > 1;
    } catch {
      return false;
    }
  }

  /** New-work gate: maintenance blocks new joins (503); a read failure fails closed. */
  async function maintenanceClear(res: Response): Promise<boolean> {
    const state = await readMaintenance();
    if (state.ok && !state.enabled) return true;
    res.status(503).json(maintenanceBlockedBody());
    return false;
  }

  /**
   * Gate for work that starts R1 compute: settings allow it AND the browser
   * endpoint the API would use is configured AND it is the endpoint the
   * settings (and so admission's phone-capacity rule) assume.
   */
  async function laneForNewWork(res: Response): Promise<LiveKitEndpoint | null> {
    const settings = await loadSettings(db);
    if (!settings.ok) {
      refuse(res, 503, 'service_unavailable');
      return null;
    }
    if (!settings.value || !settings.value.enabled) {
      refuse(res, 409, 'r1_disabled');
      return null;
    }
    if (settings.value.paused) {
      refuse(res, 409, 'r1_paused');
      return null;
    }
    let endpoint: LiveKitEndpoint;
    try {
      endpoint = requireBrowserLiveKitConfigured();
    } catch {
      log.error('unknown_event', { error_category: 'r1_endpoint_not_configured' });
      refuse(res, 503, 'r1_unavailable');
      return null;
    }
    if (settings.value.livekit_target !== endpoint.target) {
      // Admission skips the phone-capacity check when the SFU is R1's. If the
      // API would still use Cloud, R1 would spend phone minutes unguarded.
      log.error('unknown_event', { error_category: 'r1_endpoint_target_mismatch' });
      refuse(res, 503, 'r1_endpoint_mismatch');
      return null;
    }
    if (endpoint.target === 'cloud' && legacyBrowserEnabled()) {
      // Cloud fallback while the legacy browser lane lives: that worker must stay in
      // R1_LANE_MODE=off, so it would refuse and delete every marked R1 room AFTER
      // a start and capacity were spent. Refuse before admission spends anything.
      log.error('unknown_event', { error_category: 'r1_cloud_fallback_legacy_browser_enabled' });
      refuse(res, 503, 'r1_unavailable');
      return null;
    }
    if (r1WorkerGateMissing(endpoint, joinGateDeps)) {
      refuse(res, 503, 'r1_unavailable');
      return null;
    }
    return endpoint;
  }

  // ── POST /api/r1/status ────────────────────────────────────────────
  router.post('/status', validateBody(r1StatusSchema), route(async (req, res) => {
    const round = await roundFor(req, res);
    if (!round) return;
    if (meetRound(res, round)) return;
    const at = now();
    const [settings, consent, live, roleTitle] = await Promise.all([
      loadSettings(db),
      readRoundConsent(db, round.id, round.consent_locale),
      loadLiveSession(db, round.id),
      loadRoleTitle(db, round.role_id),
    ]);
    if (!settings.ok || !consent.ok || !live.ok) {
      refuse(res, 503, 'service_unavailable');
      return;
    }
    const config = getR1Config();
    const availability = !config.enabled || !settings.value?.enabled
      ? 'disabled'
      : settings.value.paused ? 'paused' : 'open';
    const attemptsRemaining = Math.max(0, round.attempts_allowed - round.attempts_counted);
    const startsRemaining = Math.max(0, STARTS_PER_LINK - round.starts_used);
    const hasLive = live.value !== null;
    res.json({
      round_status: effectiveRoundStatus(round, at),
      expires_at: round.expires_at,
      availability,
      attempts_allowed: round.attempts_allowed,
      attempts_remaining: attemptsRemaining,
      starts_remaining: startsRemaining,
      consent: { state: consent.value.state, template_version: consent.value.templateVersion },
      live_attempt: hasLive,
      can_start: roundIsActive(round, at)
        && availability === 'open'
        && attemptsRemaining > 0
        && startsRemaining > 0
        && consent.value.state === 'granted'
        && !hasLive,
      role_title: roleTitle,
      format: R1_FORMAT,
      // Whom the page is talking to: it words the closing screens for the project team
      // (staff dry run) or the hiring team (candidate). Anything but the staff notice
      // reads `candidate`, the stricter wording.
      audience: round.consent_locale === R1_STAFF_LOCALE ? 'staff' : 'candidate',
    });
  }));

  /**
   * The newest template of `locale`, but only when it is ALSO the one admission
   * accepts. Admission (`r1_admit_attempt`) and `readRoundConsent` take
   * `max(version)` ACROSS locales, so a grant against a locale whose newest
   * version is older than another locale's can never become valid: the page
   * would record it, be told "required" again and loop. Such a locale has, for
   * consent purposes, no usable template until its copy catches up.
   */
  async function loadUsableTemplate(locale: string): Promise<Read<ConsentTemplate | null>> {
    const localized = await loadNewestTemplate(db, locale);
    const authoritative = await loadNewestTemplate(db);
    if (!localized.ok || !authoritative.ok) return { ok: false };
    if (
      !localized.value
      || !authoritative.value
      || localized.value.version !== authoritative.value.version
    ) {
      return { ok: true, value: null };
    }
    return { ok: true, value: localized.value };
  }

  /** A decline needs some notice to attach to: the locale's, else the one in force. */
  async function loadDeclineTemplate(locale: string): Promise<Read<ConsentTemplate | null>> {
    const localized = await loadNewestTemplate(db, locale);
    if (!localized.ok || localized.value) return localized;
    return loadNewestTemplate(db);
  }

  // ── POST /api/r1/consent-template ──────────────────────────────────
  // A POST so the link token travels in the body (never a URL or query string),
  // and so the notice can be the one this round's audience is owed.
  router.post('/consent-template', validateBody(r1ConsentTemplateSchema), route(
    async (req, res) => {
      const round = await roundFor(req, res);
      if (!round) return;
      const locale = audienceLocale(round);
      if (!locale) {
        refuse(res, 503, 'consent_template_unavailable');
        return;
      }
      const found = await loadUsableTemplate(locale);
      if (!found.ok) {
        refuse(res, 503, 'service_unavailable');
        return;
      }
      // Absence fails closed: never pretend Legal-approved copy exists, and
      // never serve a notice a grant could not be valid against. 503, like the
      // same condition on POST /consent: a 404 here would read as a bad link.
      if (!found.value) {
        refuse(res, 503, 'consent_template_unavailable');
        return;
      }
      const { id: _id, ...publicFields } = found.value;
      // The wording each agreement carries at the point of consent, per audience.
      // Omitted (the page then uses its own fallback) when any required key has none.
      const items = r1ConsentItems(publicFields.locale, publicFields.required_consents);
      res.json(items ? { ...publicFields, consent_items: items } : publicFields);
    },
  ));

  // ── POST /api/r1/consent ───────────────────────────────────────────
  router.post('/consent', validateBody(r1ConsentSchema), route(async (req, res) => {
    const body = req.body as z.infer<typeof r1ConsentSchema>;
    const round = await roundFor(req, res);
    if (!round) return;
    // The master switch stops new consent, never a decline: a candidate who
    // wants the human-interview alternative (D14) must always be able to record
    // it, exactly as withdrawal is always possible (invariant 5).
    if (body.status !== 'declined' && !enabledOr409(res)) return;
    if (!roundIsActive(round, now())) {
      refuse(res, 409, 'round_not_admissible');
      return;
    }
    const locale = audienceLocale(round);
    if (!locale) {
      refuse(res, 503, 'consent_template_unavailable');
      return;
    }
    const declining = body.status === 'declined';
    const found = declining
      ? await loadDeclineTemplate(locale)
      : await loadUsableTemplate(locale);
    if (!found.ok) {
      refuse(res, 503, 'service_unavailable');
      return;
    }
    const template = found.value;
    // A template that requires nothing cannot carry the separate purpose
    // consents the notice promises; treat it as not configured.
    if (!template || (!declining && template.required_consents.length === 0)) {
      refuse(res, 503, 'consent_template_unavailable');
      return;
    }
    // A grant must name the exact notice the candidate read. A decline names
    // none: it is recorded against the current template whatever the page held.
    if (!declining && template.version !== body.template_version) {
      refuse(res, 409, 'consent_template_stale', { template_version: template.version });
      return;
    }
    const at = new Date(now()).toISOString();
    const granted = [...new Set(body.consents)];
    const proof = {
      captured_at: at,
      template_version: template.version,
      locale: template.locale,
      ip_prefix: minimizeIp(req.ip) ?? null,
      user_agent: String(req.headers['user-agent'] ?? '').slice(0, 256) || null,
    };

    if (declining) {
      // Declining after granting is a withdrawal, stored as `declined`. The
      // call is idempotent and always made: it also re-reports (and so re-stops)
      // a live session an earlier, partly failed decline left behind.
      const outcome = await withdrawRound(round.id, req, 'declined');
      if (!outcome.ok) {
        refuse(res, 503, 'service_unavailable');
        return;
      }
      if (!outcome.withdrawn) {
        // No consent was in force: record the decline itself, once.
        const latest = await readRoundConsent(db, round.id, locale);
        if (!latest.ok) {
          refuse(res, 503, 'service_unavailable');
          return;
        }
        if (latest.value.state !== 'declined') {
          const inserted = await db.from('interview_round_consents').insert({
            round_id: round.id,
            template_id: template.id,
            consents: [],
            proof: { ...proof, decision: 'declined' },
            granted_at: at,
            withdrawn_at: at,
          });
          if (inserted.error) {
            refuse(res, 503, 'service_unavailable');
            return;
          }
        }
      }
      await audit(req, 'resource.create', 201, {
        resource: 'interview_round_consent',
        round_id: round.id,
        consent_status: 'declined',
        template_version: template.version,
        sessions_live: outcome.live,
        sessions_stopped: outcome.stopped,
      });
      if (outcome.stopped < outcome.live) {
        refuseIncompleteWithdrawal(res, outcome);
        return;
      }
      res.status(201).json({
        status: 'declined',
        consents: [],
        template_version: template.version,
        locale: template.locale,
        created_at: at,
      });
      return;
    }

    const missing = template.required_consents.filter((type) => !granted.includes(type));
    if (missing.length > 0) {
      refuse(res, 400, 'required_consents_missing', { missing_consents: missing });
      return;
    }
    const current = await readRoundConsent(db, round.id, locale);
    if (!current.ok) {
      refuse(res, 503, 'service_unavailable');
      return;
    }
    if (current.value.state === 'granted' && current.value.templateVersion === template.version) {
      res.status(200).json({
        status: 'granted',
        consents: granted,
        template_version: template.version,
        locale: template.locale,
        created_at: at,
        already_granted: true,
      });
      return;
    }
    // A live consent for an older template is superseded, never edited in place.
    const live = await loadLiveConsent(db, round.id);
    if (!live.ok) {
      refuse(res, 503, 'service_unavailable');
      return;
    }
    if (live.value) {
      const superseded = await db
        .from('interview_round_consents')
        .update({
          withdrawn_at: at,
          proof: { ...(live.value.proof ?? {}), decision: 'superseded', superseded_at: at },
        })
        .eq('id', live.value.id)
        .is('withdrawn_at', null);
      if (superseded.error) {
        refuse(res, 503, 'service_unavailable');
        return;
      }
    }
    const inserted = await db
      .from('interview_round_consents')
      .insert({
        round_id: round.id,
        template_id: template.id,
        consents: granted,
        proof: { ...proof, decision: 'granted' },
        granted_at: at,
      })
      .select('id')
      .single();
    if (inserted.error || !inserted.data) {
      // 23505 is a concurrent grant that won the live-consent unique index.
      const raced = (inserted.error as { code?: string } | null)?.code === '23505';
      refuse(res, raced ? 409 : 503, raced ? 'consent_conflict' : 'service_unavailable');
      return;
    }
    await audit(req, 'resource.create', 201, {
      resource: 'interview_round_consent',
      round_id: round.id,
      consent_status: 'granted',
      template_version: template.version,
    });
    res.status(201).json({
      id: inserted.data.id,
      status: 'granted',
      consents: granted,
      template_version: template.version,
      locale: template.locale,
      created_at: at,
    });
  }));

  // ── POST /api/r1/consent/withdraw ──────────────────────────────────

  interface LiveSession {
    session_id: string;
    status: string;
  }

  /** Stop one live session: cut its room, and cancel it if no worker owns it yet. */
  async function stopSession(session: LiveSession): Promise<boolean> {
    const roomName = roomNameForSession(session.session_id);
    let roomCut = false;
    try {
      await roomsFor(requireBrowserLiveKitConfigured()).deleteRoom(roomName);
      roomCut = true;
    } catch {
      log.error('unknown_event', { error_category: 'r1_withdraw_room_delete_failed' });
    }
    // A worker owns an in-progress session: deleting the room ends its job and
    // it settles its own terminal state. A created/waiting session has no
    // worker, so cancel it here to free its R1 slot at once.
    if (session.status === 'created' || session.status === 'waiting') {
      const moved = await transitionSession(
        session.session_id,
        session.status,
        'cancelled',
        'recruiter_cancelled',
      );
      return roomCut || moved.ok;
    }
    return roomCut;
  }

  interface WithdrawOutcome {
    ok: true;
    /** A live consent was withdrawn by THIS call. */
    withdrawn: boolean;
    /** Sessions that were live when the consent was withdrawn. */
    live: number;
    /** Of those, how many were stopped. */
    stopped: number;
  }

  /**
   * Withdraw the round's consent (stored as `decision`) and stop every live
   * session. Idempotent: `r1_withdraw_consent` changes nothing the second time
   * but still reports the sessions that are live, so a retry re-attempts any
   * room that could not be cut.
   */
  async function withdrawRound(
    roundId: string,
    req: Request,
    decision: 'withdrawn' | 'declined',
  ): Promise<WithdrawOutcome | { ok: false }> {
    const { data, error } = await db.rpc('r1_withdraw_consent', {
      p_round_id: roundId,
      p_proof: {
        ip_prefix: minimizeIp(req.ip) ?? null,
        user_agent: String(req.headers['user-agent'] ?? '').slice(0, 256) || null,
      },
      p_decision: decision,
    });
    if (error || !data || data.status !== 'ok') return { ok: false };
    const sessions: LiveSession[] = Array.isArray(data.live_sessions) ? data.live_sessions : [];
    let stopped = 0;
    for (const session of sessions) {
      if (await stopSession(session)) stopped += 1;
    }
    return { ok: true, withdrawn: Number(data.withdrawn) > 0, live: sessions.length, stopped };
  }

  /**
   * The consent is withdrawn but a live interview could not be stopped (LiveKit
   * unreachable, R1 endpoint misconfigured). Never answer 200 here: the page
   * could not tell "nothing was live" from "failed to stop", and nothing else
   * retries. The retry is safe and re-attempts the room delete.
   */
  function refuseIncompleteWithdrawal(res: Response, outcome: WithdrawOutcome): void {
    res.setHeader('Retry-After', String(WITHDRAW_RETRY_AFTER_SEC));
    refuse(res, 503, 'r1_withdraw_incomplete', {
      withdrawn: outcome.withdrawn,
      sessions_live: outcome.live,
      sessions_stopped: outcome.stopped,
      retry_after_sec: WITHDRAW_RETRY_AFTER_SEC,
    });
  }

  router.post('/consent/withdraw', validateBody(r1WithdrawSchema), route(async (req, res) => {
    // Deliberately no kill-switch, maintenance or round-state gate (invariant 5).
    const round = await roundFor(req, res);
    if (!round) return;
    const result = await withdrawRound(round.id, req, 'withdrawn');
    if (!result.ok) {
      refuse(res, 503, 'service_unavailable');
      return;
    }
    await audit(req, 'resource.update', 200, {
      resource: 'interview_round_consent',
      round_id: round.id,
      consent_status: 'withdrawn',
      sessions_live: result.live,
      sessions_stopped: result.stopped,
    });
    if (result.stopped < result.live) {
      refuseIncompleteWithdrawal(res, result);
      return;
    }
    res.json({ ok: true, withdrawn: result.withdrawn, sessions_stopped: result.stopped });
  }));

  // ── POST /api/r1/preflight ─────────────────────────────────────────
  router.post('/preflight', validateBody(r1PreflightSchema), route(async (req, res) => {
    const round = await roundFor(req, res);
    if (!round) return;
    if (!enabledOr409(res)) return;
    if (!roundIsActive(round, now())) {
      refuse(res, 409, 'round_not_admissible');
      return;
    }
    if (!(await consentStillGranted(res, round))) return;
    if (!(await maintenanceClear(res))) return;
    const endpoint = await laneForNewWork(res);
    if (!endpoint) return;

    // The cap is reserved BEFORE the room exists, atomically per link.
    const reserved = await db.rpc('r1_reserve_preflight', {
      p_round_id: round.id,
      p_event_key: `preflight:${uuid()}`,
    });
    if (reserved.error || !reserved.data) {
      refuse(res, 503, 'service_unavailable');
      return;
    }
    const verdict = String(reserved.data.status);
    if (verdict === 'preflight_limit') {
      refuse(res, 429, 'r1_preflight_limit');
      return;
    }
    if (verdict === 'preflight_rate_limited') {
      res.setHeader('Retry-After', '20');
      refuse(res, 429, 'r1_preflight_rate_limited', { retry_after_sec: 20 });
      return;
    }
    if (verdict === 'round_not_admissible' || verdict === 'round_not_found') {
      refuse(res, 409, 'round_not_admissible');
      return;
    }
    if (verdict !== 'ok') {
      refuse(res, 503, 'service_unavailable');
      return;
    }

    const rooms = roomsFor(endpoint);
    const roomName = `preflight-${uuid()}`;
    try {
      await rooms.createRoom({
        name: roomName,
        emptyTimeout: 15,
        departureTimeout: 5,
        maxParticipants: 1,
        // The worker refuses exactly this marker, so no interviewer is dispatched.
        metadata: JSON.stringify({ channel: 'preflight', schema: 1 }),
      });
      const token = accessTokenFor(endpoint, {
        identity: `preflight-${uuid()}`,
        ttl: PREFLIGHT_TOKEN_TTL_SEC,
      });
      token.addGrant({
        room: roomName,
        roomJoin: true,
        canPublish: true,
        canPublishSources: [TrackSource.MICROPHONE, TrackSource.CAMERA],
        canSubscribe: false,
        canPublishData: false,
        canUpdateOwnMetadata: false,
      });
      // LiveKit only bounds the initial connection, so the 10 s limit is
      // enforced by deleting the room.
      schedule(() => {
        rooms.deleteRoom(roomName).catch(() => undefined);
      }, PREFLIGHT_HARD_STOP_MS);
      res.json({
        url: endpoint.url,
        livekit_token: await token.toJwt(),
        expires_at: new Date(now() + PREFLIGHT_TOKEN_TTL_SEC * 1000).toISOString(),
        policy_version: PREFLIGHT_POLICY.version,
        max_seconds: PREFLIGHT_POLICY.max_seconds,
        min_audio_packets: PREFLIGHT_POLICY.min_audio_packets,
        min_video_frames: PREFLIGHT_POLICY.min_video_frames,
      });
    } catch {
      // The reservation above is spent: a failed room is not refunded, which
      // keeps the per-link cap a hard bound on LiveKit work.
      await rooms.deleteRoom(roomName).catch(() => undefined);
      log.error('unknown_event', { error_category: 'r1_preflight_room_failed' });
      refuse(res, 503, 'r1_room_unavailable');
    }
  }));

  // ── POST /api/r1/attempts ──────────────────────────────────────────

  interface AttemptBody {
    attempt_id: string;
    attempt_number: number;
    attempt_token: string;
    attempt_token_expires_at: string;
  }

  function attemptResponse(
    sessionId: string,
    attemptNumber: number,
    nonceDigest: string,
  ): AttemptBody | null {
    const minted = mintAttemptToken({ sessionId, nonceDigest }, now());
    if (!minted) return null;
    return {
      attempt_id: sessionId,
      attempt_number: attemptNumber,
      attempt_token: minted.token,
      attempt_token_expires_at: minted.expiresAt.toISOString(),
    };
  }

  router.post('/attempts', validateBody(r1AttemptsSchema), route(async (req, res) => {
    if (!attemptTokensConfigured()) {
      refuse(res, 503, 'r1_unavailable');
      return;
    }
    const round = await roundFor(req, res);
    if (!round) return;
    // Both branches (admission and the nonce rejoin), before any switch (invariant 11).
    if (meetRound(res, round)) return;
    if (!enabledOr409(res)) return;
    if (!roundIsActive(round, now())) {
      refuse(res, 409, effectiveRoundStatus(round, now()) === 'expired'
        ? 'round_expired'
        : 'round_not_admissible');
      return;
    }
    const body = req.body as z.infer<typeof r1AttemptsSchema>;

    if (body.nonce !== undefined) {
      // Rejoin: link + nonce re-mint a token for the attempt that is still live.
      const live = await loadLiveSession(db, round.id);
      if (!live.ok) {
        refuse(res, 503, 'service_unavailable');
        return;
      }
      if (!live.value) {
        refuse(res, 409, 'r1_attempt_not_live');
        return;
      }
      const attempt = await loadAttempt(db, live.value.id);
      if (!attempt.ok) {
        refuse(res, 503, 'service_unavailable');
        return;
      }
      if (!attempt.value || !nonceMatchesDigest(body.nonce, attempt.value.nonce_digest)) {
        refuse(res, 404, STABLE_ATTEMPT_ERROR);
        return;
      }
      if (!(await consentStillGranted(res, round))) return;
      const reissued = attemptResponse(
        live.value.id,
        attempt.value.attempt_number,
        attempt.value.nonce_digest,
      );
      if (!reissued) {
        refuse(res, 503, 'r1_unavailable');
        return;
      }
      res.status(200).json({ ...reissued, rejoin: true });
      return;
    }

    if (!(await maintenanceClear(res))) return;
    if (!(await laneForNewWork(res))) return;
    // Admission spends one of the link's three starts and moves 65 minutes into
    // the month's used capacity for good, and the orphan `created` session it
    // makes holds an R1 slot (with the default limit of one, all of R1) until it lapses. The exchange refuses the same way
    // while DeepSeek is down, so refuse BEFORE admission (the probe is cached):
    // an outage must not burn starts and capacity on interviews that cannot run.
    if (!(await healthy())) {
      refuseUnhealthy(res);
      return;
    }

    // Admission checks that a live consent exists and is current, but it cannot tell
    // the candidate notice from the staff dry-run notice (both ship at one version),
    // so the audience the consent was given under is checked here, before a start
    // is spent. The rejoin branch and the exchange re-check it the same way.
    if (!(await consentStillGranted(res, round))) return;

    const nonce = generateNonce();
    const nonceDigest = hashNonce(nonce);
    const admitted = await db.rpc('r1_admit_attempt', {
      p_round_id: round.id,
      p_nonce_digest: nonceDigest,
    });
    if (admitted.error || !admitted.data) {
      refuse(res, 503, 'service_unavailable');
      return;
    }
    if (admitted.data.status !== 'ok') {
      const refusal = ADMISSION_REFUSALS[String(admitted.data.status)]
        ?? { status: 503, error: 'service_unavailable' };
      if (refusal.error === 'r1_busy') {
        // round_live is only ever answered above a limit of 1 (0131), so it needs no read; it is
        // the candidate's own live session, not a full pool, and says so.
        const ownLive = admitted.data.status === 'round_live';
        const slots = ownLive || (await admitsSeveralLive());
        const retryAfter = slots ? BUSY_SLOTS_RETRY_AFTER_SEC : BUSY_RETRY_AFTER_SEC;
        res.setHeader('Retry-After', String(retryAfter));
        const reason = ownLive ? R1_BUSY_OWN_SESSION_LIVE : slots ? R1_BUSY_SLOTS_FULL : null;
        refuse(res, refusal.status, refusal.error, {
          retry_after_sec: retryAfter,
          ...(reason ? { busy_reason: reason } : {}),
        });
        return;
      }
      refuse(res, refusal.status, refusal.error);
      return;
    }
    const created = attemptResponse(
      String(admitted.data.session_id),
      Number(admitted.data.attempt_number),
      nonceDigest,
    );
    if (!created) {
      refuse(res, 503, 'r1_unavailable');
      return;
    }
    await audit(req, 'resource.create', 201, {
      resource: 'interview_round_attempt',
      round_id: round.id,
      attempt_number: created.attempt_number,
    });
    res.status(201).json({ ...created, nonce, rejoin: false });
  }));

  // ── POST /api/r1/exchange ──────────────────────────────────────────

  /** Provision (or re-assert) the attempt's marked room (lib/r1/marked-room.ts); true when it is there, else the refusal is written. */
  async function markedRoomReady(
    res: Response,
    session: { id: string; interview_round_id: string | null },
    endpoint: LiveKitEndpoint,
  ): Promise<boolean> {
    const room = await provisionMarkedRoom(session, endpoint, { provisionRoom, ...(deps.rooms ? { rooms: roomsFor } : {}) });
    if (room.ok) return true;
    if (room.reason === 'provider_failed') {
      refuse(res, 503, 'r1_room_unavailable');
      return false;
    }
    refuse(res, 409, 'r1_attempt_ended');
    return false;
  }

  /**
   * A `waiting` rejoin is the candidate's own activity: count it. The orphan lapse
   * (`lib/r1/orphan-lapse.ts`) expires a `waiting` row that has been idle for 20
   * minutes, so without this a same-tab retry made late in that window would have a
   * worker dispatched into a session the next 60 s tick then expires under it. The
   * write changes nothing else and only matches a row that is still `waiting`; the
   * database stamps `updated_at` on every write (trigger 0004), which is what the
   * lapse reads (and what its compare-and-set re-checks). Best effort: a failed
   * touch must not turn a join into a failure, and the lapse's dispatch check still
   * spares a row whose worker is already live.
   */
  async function touchWaitingSession(sessionId: string): Promise<void> {
    try {
      const { error } = await db
        .from('call_sessions')
        .update({ updated_at: new Date(now()).toISOString() })
        .eq('id', sessionId)
        .eq('status', 'waiting');
      if (error) log.warn('unknown_event', { error_category: 'r1_waiting_touch_failed' });
    } catch {
      log.warn('unknown_event', { error_category: 'r1_waiting_touch_failed' });
    }
  }

  router.post('/exchange', validateBody(r1ExchangeSchema), route(async (req, res) => {
    if (!attemptTokensConfigured()) {
      refuse(res, 503, 'r1_unavailable');
      return;
    }
    const body = req.body as z.infer<typeof r1ExchangeSchema>;
    const named = peekAttemptToken(body.attempt_token);
    if (!named) {
      refuse(res, 404, STABLE_ATTEMPT_ERROR);
      return;
    }
    const attempt = await loadAttempt(db, named.sessionId);
    if (!attempt.ok) {
      refuse(res, 503, 'service_unavailable');
      return;
    }
    // One stable answer for: unknown attempt, wrong/expired token, wrong nonce.
    if (
      !attempt.value
      || !verifyAttemptToken(body.attempt_token, attempt.value.nonce_digest, now())
      || !nonceMatchesDigest(body.nonce, attempt.value.nonce_digest)
    ) {
      refuse(res, 404, STABLE_ATTEMPT_ERROR);
      return;
    }
    // Authenticated (attempt token and nonce): only now may the switch be reported.
    if (!enabledOr409(res)) return;

    const loaded = await loadSession(db, attempt.value.session_id);
    const roundRead = await loadRoundById(db, attempt.value.round_id);
    if (!loaded.ok || !roundRead.ok) {
      refuse(res, 503, 'service_unavailable');
      return;
    }
    const session = loaded.value;
    const round = roundRead.value;
    if (
      !session
      || !round
      || session.mode !== 'browser'
      || session.interview_round_id !== round.id
    ) {
      refuse(res, 404, STABLE_ATTEMPT_ERROR);
      return;
    }
    if (meetRound(res, round)) return;
    if (!(['created', 'waiting', 'in_progress'] as string[]).includes(session.status)) {
      refuse(res, 409, 'r1_attempt_ended');
      return;
    }
    if (!roundIsActive(round, now())) {
      refuse(res, 409, 'round_not_admissible');
      return;
    }
    // Consent is re-checked on EVERY exchange: a withdrawal or a newer
    // template stops a join that admission already allowed (plan 7.8).
    if (!(await consentStillGranted(res, round))) return;
    const roomName = roomNameForSession(session.id);
    if (session.external_call_id !== null && session.external_call_id !== roomName) {
      refuse(res, 404, STABLE_ATTEMPT_ERROR);
      return;
    }

    let endpoint: LiveKitEndpoint;
    if (session.status === 'created') {
      // A NEW start: every gate that guards new R1 compute applies, in the
      // order that spends the least first. Nothing below creates a LiveKit
      // object until the DeepSeek probe has passed.
      if (!(await maintenanceClear(res))) return;
      const lane = await laneForNewWork(res);
      if (!lane) return;
      endpoint = lane;
      if (!(await healthy())) {
        refuseUnhealthy(res);
        return;
      }
      // The attempt stays `created` on a provider failure: nothing was consumed and
      // a retry converges.
      if (!(await markedRoomReady(res, session, endpoint))) return;
    } else {
      // Rejoin or retry of an attempt that already has a room.
      try {
        endpoint = requireBrowserLiveKitConfigured();
      } catch {
        refuse(res, 503, 'r1_unavailable');
        return;
      }
      if (session.status === 'waiting') {
        // Fence 7, BEFORE anything is provisioned: no gate on the R1 SFU, no token.
        if (r1WorkerGateMissing(endpoint, joinGateDeps)) {
          refuse(res, 503, 'r1_unavailable');
          return;
        }
        // The candidate is here: restart the orphan lapse's idle window before the
        // gate below spends up to ~2 minutes readying a worker.
        await touchWaitingSession(session.id);
        // R1 sessions stay `waiting` for the whole interview, so this is every
        // refresh and retry. The room lapses after 180 s empty and a refusing
        // worker deletes it; on the R1 SFU (no auto-create) a missing room would be
        // a permanent `preparing` loop, on Cloud the join would auto-create an
        // UNMARKED room. Re-assert the marked room first: idempotent (createRoom
        // converges the marker and limits on an existing room; a lost
        // `created` -> `waiting` CAS is `adopted: true`, which is success).
        if (session.external_call_id === roomName) {
          if (!(await markedRoomReady(res, session, endpoint))) return;
        }
      }
    }

    if (session.status !== 'in_progress') {
      const gate = await runR1JoinGate({ endpoint, sessionId: session.id, roomName }, joinGateDeps);
      if (gate === 'preparing') {
        res.setHeader('Retry-After', String(PREPARING_RETRY_AFTER_SEC));
        res.status(202).json({ status: 'preparing', retry_after_sec: PREPARING_RETRY_AFTER_SEC });
        return;
      }
      // Booting a worker can take tens of seconds. A withdrawal that landed in
      // that window must still stop the join: re-check before the token exists.
      if (!(await consentStillGranted(res, round))) return;
    }

    const join = await mintCandidateJoin(endpoint, session, roomName, { now });
    res.status(200).json({
      url: endpoint.url,
      livekit_token: join.jwt,
      expires_at: join.expiresAt,
      attempt_id: session.id,
    });
  }));

  // ── POST /api/r1/ready ─────────────────────────────────────────────

  type ReadyRelay = 'sent' | 'no_room' | 'failed';

  /**
   * Tell the room's interviewer the candidate pressed "I'm ready": one fixed message on the
   * pinned topic, addressed to the agent participant(s) found in THIS room. When the room lists no
   * agent (or cannot be listed) the message is broadcast instead, which is harmless: it carries
   * nothing but the pinned `{"v":1,"kind":"ready"}`, and only the worker acts on it.
   */
  async function relayReady(endpoint: LiveKitEndpoint, roomName: string): Promise<ReadyRelay> {
    const rooms = roomsFor(endpoint);
    let identities: string[] = [];
    try {
      identities = agentIdentities(
        await bounded(rooms.listParticipants(roomName), readyTimeoutMs),
      );
    } catch (error) {
      if (roomIsMissing(error)) return 'no_room';
      log.warn('unknown_event', { error_category: 'r1_ready_agent_lookup_failed' });
    }
    try {
      await bounded(
        rooms.sendData(roomName, READY_BYTES, DataPacket_Kind.RELIABLE, {
          topic: R1_READY_TOPIC,
          ...(identities.length > 0 ? { destinationIdentities: identities } : {}),
        }),
        readyTimeoutMs,
      );
      return 'sent';
    } catch (error) {
      if (roomIsMissing(error)) return 'no_room';
      log.error('unknown_event', { error_category: 'r1_ready_send_failed' });
      return 'failed';
    }
  }

  router.post('/ready', validateBody(r1ReadySchema), route(async (req, res) => {
    if (!attemptTokensConfigured()) {
      refuse(res, 503, 'r1_unavailable');
      return;
    }
    const body = req.body as z.infer<typeof r1ReadySchema>;
    const named = peekAttemptToken(body.attempt_token);
    if (!named) {
      refuse(res, 404, STABLE_ATTEMPT_ERROR);
      return;
    }
    const attempt = await loadAttempt(db, named.sessionId);
    if (!attempt.ok) {
      refuse(res, 503, 'service_unavailable');
      return;
    }
    // The same one stable answer as the exchange: unknown attempt, wrong or expired token,
    // wrong nonce. The token lives five minutes, so the page re-mints one (a rejoin with the
    // link and its nonce) when the one it holds is old.
    if (
      !attempt.value
      || !verifyAttemptToken(body.attempt_token, attempt.value.nonce_digest, now())
      || !nonceMatchesDigest(body.nonce, attempt.value.nonce_digest)
    ) {
      refuse(res, 404, STABLE_ATTEMPT_ERROR);
      return;
    }
    // Authenticated: only now may the switch be reported, and the attempt be charged.
    if (!enabledOr409(res)) return;
    const allowance = readyLimiter.hit(attempt.value.session_id, now());
    if (!allowance.ok) {
      res.setHeader('Retry-After', String(allowance.retryAfterSec));
      refuse(res, 429, 'r1_ready_rate_limited', { retry_after_sec: allowance.retryAfterSec });
      return;
    }

    const loaded = await loadSession(db, attempt.value.session_id);
    const roundRead = await loadRoundById(db, attempt.value.round_id);
    if (!loaded.ok || !roundRead.ok) {
      refuse(res, 503, 'service_unavailable');
      return;
    }
    const session = loaded.value;
    const round = roundRead.value;
    if (
      !session
      || !round
      || session.mode !== 'browser'
      || session.interview_round_id !== round.id
    ) {
      refuse(res, 404, STABLE_ATTEMPT_ERROR);
      return;
    }
    if (meetRound(res, round)) return;
    // The room is the one this attempt's own session names, never anything the caller sent.
    const roomName = roomNameForSession(session.id);
    if (session.external_call_id !== null && session.external_call_id !== roomName) {
      refuse(res, 404, STABLE_ATTEMPT_ERROR);
      return;
    }
    // Live: the room exists (`waiting`: provisioned, `in_progress`: the worker owns it).
    // `created` has no room yet, and an ended attempt has nobody to tell.
    if (
      session.external_call_id === null
      || !(['waiting', 'in_progress'] as string[]).includes(session.status)
    ) {
      refuse(res, 409, 'not_live');
      return;
    }
    if (!roundIsActive(round, now())) {
      refuse(res, 409, 'round_not_admissible');
      return;
    }
    // A withdrawal stops the relay as it stops the join.
    if (!(await consentStillGranted(res, round))) return;
    let endpoint: LiveKitEndpoint;
    try {
      endpoint = requireBrowserLiveKitConfigured();
    } catch {
      refuse(res, 503, 'r1_unavailable');
      return;
    }

    const relayed = await relayReady(endpoint, roomName);
    if (relayed === 'no_room') {
      refuse(res, 409, 'not_live');
      return;
    }
    if (relayed === 'failed') {
      refuse(res, 503, 'r1_room_unavailable');
      return;
    }
    await audit(req, 'resource.update', 200, {
      resource: 'interview_round_attempt_ready',
      round_id: round.id,
      attempt_number: attempt.value.attempt_number,
    });
    res.status(200).json({ ok: true });
  }));

  // ── POST /api/r1/meet/exchange (M034, dark; invariant 12) ──────────

  /** R1_MEET_ENABLED off: 503 `meet_disabled` before the body is parsed or anything is read. */
  function meetExchangeOn(_req: Request, res: Response, next: NextFunction): void {
    if (meetEnabled()) {
      next();
      return;
    }
    refuse(res, 503, 'meet_disabled');
  }

  /**
   * One closed line for a refusal the holder of a real ticket was given (or a peek that failed): in a
   * Meet nobody reads the tile, and such a refusal moves no booking. The answered code only, never
   * the ticket or an id.
   */
  function meetRefused(res: Response): void {
    const call = res.locals.meetCall as MeetCall | undefined;
    log.warn('unknown_event', {
      error_category: 'r1_meet_exchange_refused',
      error_type: call?.refusal ?? 'maintenance_mode',
    });
  }

  /** `refuse`, with the line above. */
  function meetRefuse(res: Response, status: number, error: string): void {
    refuse(res, status, error);
    meetRefused(res);
  }

  /**
   * A claimed ticket was presented again: a replayed or shared ticket, or a first answer the page
   * lost. Alert (a closed category, never the ticket, its digest or an id) and refuse.
   */
  function meetTicketReplayed(res: Response): void {
    log.error('unknown_event', { error_category: 'r1_meet_ticket_already_claimed' });
    refuse(res, 409, 'ticket_already_claimed');
  }

  /** The booking's round, when it is a live Meet round; else the refusal is written. */
  async function liveMeetRound(res: Response, roundId: string): Promise<RoundRow | null> {
    const read = await loadRoundById(db, roundId);
    if (!read.ok) {
      refuse(res, 503, 'service_unavailable');
      return null;
    }
    const round = read.value;
    if (!round || round.channel !== 'meet' || !roundIsActive(round, now())) {
      refuse(res, 409, 'round_not_live');
      return null;
    }
    return round;
  }

  /** The booking's objective profile; an id this build does not know fails closed (503 + alert). */
  function meetProfileFor(res: Response, id: string): R1MeetObjectiveProfile | null {
    const profile = getR1MeetProfile(id);
    if (profile) return profile;
    log.error('unknown_event', { error_category: 'r1_meet_profile_unknown' });
    refuse(res, 503, 'service_unavailable');
    return null;
  }

  /**
   * Every gate that guards new R1 compute, plus one for the Meet join: with no worker gate, on any
   * endpoint, nothing would dispatch the Meet values (the browser's Cloud excuse, an unnamed worker
   * that auto-dispatches, does not hold here). The endpoint, or null with the refusal written.
   */
  async function meetNewWork(res: Response): Promise<LiveKitEndpoint | null> {
    if (!(await maintenanceClear(res))) return null;
    const endpoint = await laneForNewWork(res);
    if (!endpoint) return null;
    if (r1WorkerGateMissing(endpoint, joinGateDeps, { meet: true })) {
      refuse(res, 503, 'r1_unavailable');
      return null;
    }
    if (!(await healthy())) {
      refuseUnhealthy(res);
      return null;
    }
    return endpoint;
  }

  /** A live browser-mode session of `round` whose room, if any, is its own marked room. */
  function meetSessionUsable(session: SessionRow | null, round: RoundRow): session is SessionRow {
    return session !== null
      && (LIVE_SESSION_STATUSES as readonly string[]).includes(session.status)
      && session.interview_round_id === round.id
      && session.mode === 'browser'
      && (session.external_call_id === null || session.external_call_id === roomNameForSession(session.id));
  }

  /**
   * The round's live session, when the bridge can continue it. A failed read reads as none:
   * admission then decides under its own locks, so no second session can start.
   */
  async function meetLiveSession(round: RoundRow): Promise<SessionRow | null> {
    const live = await loadLiveSession(db, round.id);
    return live.ok && meetSessionUsable(live.value, round) ? live.value : null;
  }

  /** `r1_meet_bind_session` (D-S05-6); true when bound, else the refusal is written. */
  async function meetBind(res: Response, bookingId: string, sessionId: string): Promise<boolean> {
    const bound = await bindR1MeetSession(db, bookingId, sessionId, new Date(now()).toISOString());
    if (bound.kind === 'ok' || bound.kind === 'duplicate') return true;
    if (bound.kind === 'refused' && (bound.reason === 'not_in_call' || bound.reason === 'not_found')) {
      refuse(res, 409, 'round_not_live');
      return false;
    }
    log.error('unknown_event', {
      error_category: 'r1_meet_bind_failed',
      error_type: bound.kind === 'refused' ? bound.reason : 'error',
    });
    refuse(res, 503, 'service_unavailable');
    return false;
  }

  /** The session a claim continues or starts; `row` is null for one this call just admitted. */
  interface MeetStart {
    id: string;
    row: SessionRow | null;
  }

  /**
   * Continue the round's live session, binding it first when the booking does not hold it yet. That
   * is safe: a Meet round's sessions come only from this route (invariant 11 keeps the browser off
   * it), a round has at most one live session (0116) and one live booking (0142), and the nonce of
   * that session never left the server.
   */
  async function meetContinue(
    res: Response,
    binding: R1MeetClaimBinding,
    live: SessionRow,
  ): Promise<MeetStart | null> {
    if (live.id !== binding.sessionId) {
      if (!(await meetBind(res, binding.bookingId, live.id))) return null;
      log.warn('unknown_event', { error_category: 'r1_meet_session_adopted' });
    }
    return { id: live.id, row: live };
  }

  /**
   * Server-side admission for the bridge (D-S05-10, D-S05-22). The nonce exists only because
   * admission stores its digest: it is generated, hashed and dropped here, never answered, logged or
   * audited, so the bridge session can never take the browser exchange. `status` is null when no
   * answer came back; the admission may have committed all the same.
   */
  async function meetAdmit(
    round: RoundRow,
  ): Promise<{ status: string | null; sessionId: string; attemptNumber: number }> {
    try {
      const { data, error } = await db.rpc('r1_admit_attempt', {
        p_round_id: round.id,
        p_nonce_digest: hashNonce(generateNonce()),
      });
      if (!error && data) {
        return {
          status: String(data.status),
          sessionId: String(data.session_id),
          attemptNumber: Number(data.attempt_number),
        };
      }
    } catch {
      /* a rejected call is a lost answer: below */
    }
    return { status: null, sessionId: '', attemptNumber: 0 };
  }

  /**
   * The session of a claimed booking, or null with the refusal written: the round's live session
   * when there is one (D-S05-7, and an admission whose bind or answer was lost, so a re-arm always
   * recovers it), else admission and the bind right after it, with nothing in between (the audit
   * follows). An admission that this round's own session refused, or whose answer never came, looks
   * for that session once more: two pages can race here (a re-posted output_media), and admission
   * itself serialises them.
   */
  async function meetStart(
    req: Request,
    res: Response,
    binding: R1MeetClaimBinding,
    round: RoundRow,
  ): Promise<MeetStart | null> {
    const live = await meetLiveSession(round);
    if (live) return meetContinue(res, binding, live);

    const { status, sessionId, attemptNumber } = await meetAdmit(round);
    if (status === 'ok') {
      const bound = await meetBind(res, binding.bookingId, sessionId);
      await audit(req, 'resource.create', 201, {
        resource: 'interview_round_attempt',
        round_id: round.id,
        attempt_number: attemptNumber,
      });
      return bound ? { id: sessionId, row: null } : null;
    }
    if (status === null || MEET_OWN_SESSION_REFUSALS.has(status)) {
      const own = await meetLiveSession(round);
      if (own) return meetContinue(res, binding, own);
    }
    const known = status !== null && Object.prototype.hasOwnProperty.call(MEET_ADMISSION_REFUSALS, status);
    const refusal = known ? MEET_ADMISSION_REFUSALS[status]! : { status: 503, error: 'service_unavailable' };
    log.error('unknown_event', {
      error_category: 'r1_meet_admission_refused',
      error_type: known ? status : status === null ? 'no_answer' : 'unexpected_status',
    });
    refuse(res, refusal.status, refusal.error);
    return null;
  }

  /**
   * The bridge's marked room (lib/r1/marked-room.ts, with the room mirror of the bridge identity).
   * A provider failure is `retry` (the caller answers 202 with a resume token: the attempt stays
   * `created` and a retry converges, D-S05-9); a session that can no longer be joined is 409
   * `round_not_live`. `markedRoomReady` stays the browser exchange's, unchanged.
   */
  async function meetRoomReady(
    res: Response,
    session: { id: string; interview_round_id: string | null },
    endpoint: LiveKitEndpoint,
    meet: { candidateIdentity: string },
  ): Promise<'ready' | 'retry' | 'refused'> {
    const room = await provisionMarkedRoom(session, endpoint, {
      provisionRoom,
      ...(deps.rooms ? { rooms: roomsFor } : {}),
      meet,
    });
    if (room.ok) return 'ready';
    if (room.reason === 'provider_failed') return 'retry';
    refuse(res, 409, 'round_not_live');
    return 'refused';
  }

  /** 202 `preparing` with a FRESH resume token for this booking and session (D-S05-8); false when refused. */
  function meetPreparing(res: Response, bookingId: string, sessionId: string): boolean {
    const resumeToken = mintR1MeetResumeToken({ bookingId, sessionId }, now());
    if (!resumeToken) {
      refuse(res, 503, 'r1_unavailable');
      return false;
    }
    res.setHeader('Retry-After', String(PREPARING_RETRY_AFTER_SEC));
    res.status(202).json({
      status: 'preparing',
      retry_after_sec: PREPARING_RETRY_AFTER_SEC,
      resume_token: resumeToken,
    });
    return true;
  }

  interface MeetJoin {
    bookingId: string;
    round: RoundRow;
    session: SessionRow;
    profile: R1MeetObjectiveProfile;
    /** The endpoint this request's new-work gates resolved, or null (a resume of a started session). */
    endpoint: LiveKitEndpoint | null;
  }

  /**
   * The join, by session status, mirroring the browser exchange (D-S05-11): `created` provisions the
   * marked room, `waiting` re-asserts it, then the worker gate (always `runR1JoinGate`, never the
   * bare gate), consent again, and the token from the lib preset `meet_bridge`. `in_progress` mints
   * at once. A missing worker gate is asked about before any room. False: the refusal is written.
   */
  async function meetJoin(res: Response, join: MeetJoin): Promise<boolean> {
    const { bookingId, round, session, profile } = join;
    let endpoint = join.endpoint;
    if (endpoint === null) {
      try {
        endpoint = requireBrowserLiveKitConfigured();
      } catch {
        refuse(res, 503, 'r1_unavailable');
        return false;
      }
    }
    const roomName = roomNameForSession(session.id);
    const identity = candidateJoinIdentity('meet_bridge', session);
    if (session.status !== 'in_progress') {
      if (r1WorkerGateMissing(endpoint, joinGateDeps, { meet: true })) {
        refuse(res, 503, 'r1_unavailable');
        return false;
      }
      if (session.status === 'waiting') await touchWaitingSession(session.id);
      if (session.status === 'created' || session.external_call_id === roomName) {
        const room = await meetRoomReady(res, session, endpoint, { candidateIdentity: identity });
        if (room === 'refused') return false;
        if (room === 'retry') return meetPreparing(res, bookingId, session.id);
      }
      const gate = await runR1JoinGate(
        { endpoint, sessionId: session.id, roomName, meet: { candidateIdentity: identity, profile: profile.id } },
        joinGateDeps,
      );
      if (gate === 'preparing') return meetPreparing(res, bookingId, session.id);
      if (!(await consentStillGranted(res, round))) return false;
    }
    const minted = await mintCandidateJoin(endpoint, session, roomName, { now, grant: 'meet_bridge' });
    res.status(200).json({ url: endpoint.url, livekit_token: minted.jwt, expires_at: minted.expiresAt });
    return true;
  }

  /**
   * Everything a first call decides before the single-use claim (D-S05-5), from the read-only peek
   * and the new-work gates, so a transient refusal costs neither the ticket nor a start and boots no
   * worker. Null: the refusal is written.
   */
  async function meetBeforeClaim(
    res: Response,
    booking: R1MeetTicketBooking,
  ): Promise<{ round: RoundRow; endpoint: LiveKitEndpoint } | null> {
    const nowMs = now();
    if (!(R1_MEET_CLAIMABLE_STATUSES as readonly string[]).includes(booking.status)) {
      refuse(res, 409, 'round_not_live');
      return null;
    }
    if (nowMs < booking.ticketNotBeforeMs) {
      refuse(res, 425, 'ticket_not_yet_valid');
      return null;
    }
    if (nowMs >= booking.ticketExpiresAtMs) {
      refuse(res, 410, 'ticket_expired');
      return null;
    }
    // The ticket authenticated: only now may the switches be reported (invariant 1).
    if (!enabledOr409(res)) return null;
    const round = await liveMeetRound(res, booking.roundId);
    if (!round) return null;
    if (!meetProfileFor(res, booking.objectiveProfile)) return null;
    const endpoint = await meetNewWork(res);
    if (!endpoint) return null;
    if (!(await consentStillGranted(res, round))) return null;
    return { round, endpoint };
  }

  /**
   * A first call: the gates, the claim, the session (continued or admitted) and its bind. It never
   * waits for a worker: a session that is not `in_progress` yet is answered 202 here, because the
   * ticket is now spent and an answer lost on the wire could only be repeated with the resume token
   * this 202 carries. The room, the worker gate and the token follow on the resumed call.
   */
  async function meetFirstExchange(
    req: Request,
    res: Response,
    call: MeetCall,
    booking: R1MeetTicketBooking,
    digest: string,
  ): Promise<void> {
    if (booking.ticketClaimedAtMs !== null) {
      meetTicketReplayed(res);
      return;
    }
    const open = await meetBeforeClaim(res, booking);
    if (!open) {
      meetRefused(res);
      return;
    }
    const { round, endpoint } = open;

    // From here on a 503 carries no hint: a page that asked again would present a spent ticket.
    call.unspent = false;
    const claimed = await claimR1MeetTicket(db, digest, new Date(now()).toISOString());
    if (claimed.kind === 'refused') {
      if (claimed.reason === 'ticket_already_claimed') {
        meetTicketReplayed(res);
        return;
      }
      const refusal = MEET_CLAIM_REFUSALS[claimed.reason];
      if (refusal) {
        meetRefuse(res, refusal.status, refusal.error);
        return;
      }
    }
    if (claimed.kind !== 'ok' || claimed.binding.bookingId !== booking.id || claimed.binding.roundId !== round.id) {
      log.error('unknown_event', { error_category: 'r1_meet_claim_failed' });
      refuse(res, 503, 'service_unavailable');
      return;
    }
    const binding = claimed.binding;
    const profile = meetProfileFor(res, binding.objectiveProfile);
    if (!profile) return;

    const started = await meetStart(req, res, binding, round);
    if (!started) return;
    if (started.row?.status === 'in_progress') {
      await meetJoin(res, { bookingId: binding.bookingId, round, session: started.row, profile, endpoint });
      return;
    }
    meetPreparing(res, binding.bookingId, started.id);
  }

  /** The gates of a resume, for the session the booking holds. Null: the refusal is written. */
  async function meetBeforeResume(
    res: Response,
    booking: R1MeetTicketBooking,
    sessionId: string,
  ): Promise<MeetJoin | null> {
    if (!enabledOr409(res)) return null;
    const round = await liveMeetRound(res, booking.roundId);
    if (!round) return null;
    const profile = meetProfileFor(res, booking.objectiveProfile);
    if (!profile) return null;
    const loaded = await loadSession(db, sessionId);
    if (!loaded.ok) {
      refuse(res, 503, 'service_unavailable');
      return null;
    }
    if (!meetSessionUsable(loaded.value, round)) {
      refuse(res, 409, 'round_not_live');
      return null;
    }
    const session = loaded.value;
    let endpoint: LiveKitEndpoint | null = null;
    if (session.status === 'created') {
      // Still a new start: every gate that guards new R1 compute applies again.
      endpoint = await meetNewWork(res);
      if (!endpoint) return null;
    }
    if (!(await consentStillGranted(res, round))) return null;
    return { bookingId: booking.id, round, session, profile, endpoint };
  }

  /**
   * A retry after a 202 (D-S05-8): `{ ticket, resume_token }` continues the SAME booking and its
   * bound session. No claim and no admission: the gates again by session status (S04 review
   * entry), then the join. The token names no id; it is verified against the booking the ticket
   * digest found and the session that booking holds.
   */
  async function meetResume(res: Response, booking: R1MeetTicketBooking, resumeToken: string): Promise<void> {
    if (booking.ticketClaimedAtMs === null || booking.sessionId === null) {
      refuse(res, 404, 'ticket_unknown');
      return;
    }
    if (booking.status !== 'in_call') {
      meetRefuse(res, 409, 'round_not_live');
      return;
    }
    const verdict = verifyR1MeetResumeToken(
      resumeToken,
      { bookingId: booking.id, sessionId: booking.sessionId },
      now(),
    );
    if (verdict === 'invalid') {
      log.warn('unknown_event', { error_category: 'r1_meet_resume_invalid' });
      refuse(res, 404, 'ticket_unknown');
      return;
    }
    if (verdict === 'expired' || now() >= booking.ticketExpiresAtMs) {
      meetRefuse(res, 410, 'ticket_expired');
      return;
    }
    const join = await meetBeforeResume(res, booking, booking.sessionId);
    if (!join || !(await meetJoin(res, join))) meetRefused(res);
  }

  router.post('/meet/exchange', meetExchangeOn, route(async (req, res) => {
    const call: MeetCall = { unspent: true, refusal: null };
    res.locals.meetCall = call;
    const parsed = r1MeetExchangeSchema.safeParse(req.body);
    if (!parsed.success) {
      refuse(res, 400, 'invalid_request');
      return;
    }
    const body = parsed.data;
    // The ticket digest and the resume token are keyed from the worker secret: none, no bridge.
    if (!r1MeetBridgeKeysConfigured()) {
      refuse(res, 503, 'r1_unavailable');
      return;
    }
    const digest = r1MeetTicketDigest(body.ticket);
    if (digest === null) {
      refuse(res, 503, 'r1_unavailable');
      return;
    }
    const peeked = await peekR1MeetTicket(db, digest);
    if (peeked.kind === 'error') {
      meetRefuse(res, 503, 'service_unavailable');
      return;
    }
    if (peeked.kind === 'unknown') {
      refuse(res, 404, 'ticket_unknown');
      return;
    }
    if (body.resume_token !== undefined) await meetResume(res, peeked.booking, body.resume_token);
    else await meetFirstExchange(req, res, call, peeked.booking, digest);
  }));

  return router;
}

/** The mounted router, with production dependencies. */
export const r1CandidateRouter = createR1CandidateRouter();
