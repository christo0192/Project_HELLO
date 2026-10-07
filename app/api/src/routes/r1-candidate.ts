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
 *   exchange             an ATTEMPT TOKEN AND the NONCE (lib/r1/attempt-token).
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
 *     secret when `BROWSER_LIVEKIT_TARGET=r1`, otherwise the Cloud secret.
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
 */

import { randomUUID } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { TrackSource } from 'livekit-server-sdk';
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
import { legacyBrowserScreeningEnabled } from '../lib/legacy-browser-screening.js';
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
  type ConsentTemplate,
  type Read,
} from '../lib/r1/consent.js';
import {
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
} from '../lib/r1/candidate-store.js';
import {
  R1_CANDIDATE_LOCALE,
  R1_STAFF_LOCALE,
  r1ConsentItems,
} from '../lib/r1/consent-items.js';
import { r1DeepSeekHealth } from '../lib/r1/deepseek-health.js';
import { runR1WorkerGate, type DispatchListerLike } from '../lib/r1/worker-gate.js';

const log = createLogger('r1-candidate');

// ── Contract constants ───────────────────────────────────────────────

/** Unknown, expired and cancelled links are indistinguishable (invariant 1). */
export const STABLE_LINK_ERROR = 'r1_link_invalid_or_expired';
export const STABLE_ATTEMPT_ERROR = 'r1_attempt_invalid';
/** Plan 7.10: LiveKit token expiry only bounds the initial connection. */
export const CANDIDATE_TOKEN_TTL_SEC = 10 * 60;
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
/** Plan 4 step 6: "another interview is finishing, try again in about 20 minutes". */
export const BUSY_RETRY_AFTER_SEC = 20 * 60;
export const PREPARING_RETRY_AFTER_SEC = 3;
/** A withdrawal whose room could not be cut is safe to retry at once. */
export const WITHDRAW_RETRY_AFTER_SEC = 3;
/** DeepSeek is unhealthy: the probe is cached for 60 s, so retry after half that. */
export const UNHEALTHY_RETRY_AFTER_SEC = 30;
const STARTS_PER_LINK = 3;

/** What the landing page tells the candidate about the interview (plan 4 step 3). */
export const R1_FORMAT = {
  duration_minutes: 20,
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
  round_not_admissible: { status: 409, error: 'round_not_admissible' },
  round_expired: { status: 409, error: 'round_expired' },
  starts_exhausted: { status: 409, error: 'starts_exhausted' },
  attempts_exhausted: { status: 409, error: 'attempts_exhausted' },
  round_not_found: { status: 404, error: STABLE_LINK_ERROR },
  r1_role_invalid: { status: 503, error: 'r1_unavailable' },
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
}

function defaultSchedule(work: () => void, delayMs: number): void {
  const timer = setTimeout(work, delayMs);
  timer.unref();
}

// ── Router ───────────────────────────────────────────────────────────

export function createR1CandidateRouter(deps: R1CandidateDeps = {}): Router {
  const router = Router();
  const db = deps.db ?? supabase;
  const now = deps.now ?? Date.now;
  const uuid = deps.uuid ?? randomUUID;
  const provisionRoom = deps.provisionRoom ?? provisionRoomForCreatedSession;
  const resolveGate = deps.resolveGate ?? (() => browserOrchestrationGate());
  const legacyBrowserEnabled = deps.legacyBrowserEnabled ?? legacyBrowserScreeningEnabled;
  const roomsFor = deps.rooms
    ?? ((endpoint: LiveKitEndpoint) => roomServiceClientFor(endpoint) as unknown as R1RoomClient);
  const dispatchesFor = deps.dispatches
    ?? ((endpoint: LiveKitEndpoint) => agentDispatchClientFor(endpoint) as DispatchListerLike);
  const healthy = deps.health ?? (() => r1DeepSeekHealth.check());
  const readMaintenance = deps.maintenance ?? readMaintenanceState;
  const schedule = deps.schedule ?? defaultSchedule;

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
   * The locale of the notice this round is shown, or null for a value outside
   * the two audiences (the database check makes that unreachable; failing
   * closed here keeps a drifted row from reaching a template lookup).
   */
  function audienceLocale(round: RoundRow): string | null {
    return CONSENT_AUDIENCES.has(round.consent_locale) ? round.consent_locale : null;
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
    if (r1GateMissing(endpoint)) {
      refuse(res, 503, 'r1_unavailable');
      return null;
    }
    return endpoint;
  }

  /**
   * Fence 7 on the R1 SFU. Nothing auto-dispatches there, so with no worker gate
   * (orchestration off, `BROWSER_AGENT_NAME` empty or malformed) a candidate token
   * would be minted for a room no interviewer will ever join. True means "refuse
   * with 503 r1_unavailable", and it must be asked BEFORE anything is provisioned.
   * Cloud is never affected: its unnamed worker auto-dispatches (legacy behaviour).
   * A gate that cannot even be built counts as missing.
   */
  function r1GateMissing(endpoint: LiveKitEndpoint): boolean {
    if (endpoint.target !== 'r1') return false;
    try {
      if (resolveGate() !== null) return false;
    } catch {
      /* unbuildable gate: fail closed below */
    }
    log.error('unknown_event', { error_category: 'r1_worker_gate_missing' });
    return true;
  }

  // ── POST /api/r1/status ────────────────────────────────────────────
  router.post('/status', validateBody(r1StatusSchema), route(async (req, res) => {
    const round = await roundFor(req, res);
    if (!round) return;
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
    // worker, so cancel it here to free the single R1 slot at once.
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
    const consent = await readRoundConsent(db, round.id, round.consent_locale);
    if (!consent.ok) {
      refuse(res, 503, 'service_unavailable');
      return;
    }
    if (consent.value.state !== 'granted') {
      refuse(res, 409, 'consent_required');
      return;
    }
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
      const consent = await readRoundConsent(db, round.id, round.consent_locale);
      if (!consent.ok) {
        refuse(res, 503, 'service_unavailable');
        return;
      }
      if (consent.value.state !== 'granted') {
        refuse(res, 409, 'consent_required');
        return;
      }
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
    // Admission spends one of the link's three starts and moves 55 minutes into
    // the month's used capacity for good, and the orphan `created` session it
    // makes blocks all of R1 until it lapses. The exchange refuses the same way
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
    const standing = await readRoundConsent(db, round.id, round.consent_locale);
    if (!standing.ok) {
      refuse(res, 503, 'service_unavailable');
      return;
    }
    if (standing.value.state !== 'granted') {
      refuse(res, 409, 'consent_required');
      return;
    }

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
        res.setHeader('Retry-After', String(BUSY_RETRY_AFTER_SEC));
        refuse(res, refusal.status, refusal.error, { retry_after_sec: BUSY_RETRY_AFTER_SEC });
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

  async function mintCandidateJoin(
    endpoint: LiveKitEndpoint,
    session: { id: string; candidate_id: string },
    roomName: string,
  ): Promise<{ jwt: string; expiresAt: string }> {
    const token = accessTokenFor(endpoint, {
      identity: `candidate-${session.candidate_id.slice(0, 8)}-${session.id.slice(0, 8)}`,
      ttl: CANDIDATE_TOKEN_TTL_SEC,
    });
    // Camera and microphone only. SCREEN_SHARE is reserved for future rounds.
    token.addGrant({
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canPublishSources: [TrackSource.MICROPHONE, TrackSource.CAMERA],
      canSubscribe: true,
      canPublishData: false,
      canUpdateOwnMetadata: false,
    });
    return {
      jwt: await token.toJwt(),
      expiresAt: new Date(now() + CANDIDATE_TOKEN_TTL_SEC * 1000).toISOString(),
    };
  }

  /**
   * Provision (or re-assert) the egress-free, `lane: r1`-marked room for an R1
   * round session. True means the room is there; otherwise the refusal has been
   * written: a provider failure is 503 `r1_room_unavailable` (the attempt stays
   * retryable), anything else means the attempt is no longer joinable. An
   * `adopted: true` answer (a concurrent exchange won the `created` -> `waiting`
   * CAS, or the session was already `waiting`) is success.
   */
  async function provisionMarkedRoom(
    res: Response,
    session: { id: string; interview_round_id: string | null },
    endpoint: LiveKitEndpoint,
  ): Promise<boolean> {
    const provisioned = await provisionRoom(session.id, 'existing_session', {
      endpoint,
      lane: 'r1',
      interviewRoundId: session.interview_round_id,
      ...(deps.rooms ? { rooms: roomsFor(endpoint) } : {}),
    });
    if (provisioned.ok) return true;
    if (provisioned.code === 'provider_failed') {
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
    const consent = await readRoundConsent(db, round.id, round.consent_locale);
    if (!consent.ok) {
      refuse(res, 503, 'service_unavailable');
      return;
    }
    if (consent.value.state !== 'granted') {
      refuse(res, 409, 'consent_required');
      return;
    }
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
      if (!(await provisionMarkedRoom(res, session, endpoint))) return;
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
        if (r1GateMissing(endpoint)) {
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
          if (!(await provisionMarkedRoom(res, session, endpoint))) return;
        }
      }
    }

    if (session.status !== 'in_progress') {
      const gate = await runR1WorkerGate({
        gate: resolveGate(),
        sessionId: session.id,
        roomName,
        dispatches: () => dispatchesFor(endpoint),
        now,
        // The R1 SFU has no unnamed worker to auto-dispatch: a null gate or a
        // `disabled` verdict defers instead of minting a token (fence 7).
        failClosed: endpoint.target === 'r1',
      });
      if (gate === 'preparing') {
        res.setHeader('Retry-After', String(PREPARING_RETRY_AFTER_SEC));
        res.status(202).json({ status: 'preparing', retry_after_sec: PREPARING_RETRY_AFTER_SEC });
        return;
      }
      // Booting a worker can take tens of seconds. A withdrawal that landed in
      // that window must still stop the join: re-check before the token exists.
      const settled = await readRoundConsent(db, round.id, round.consent_locale);
      if (!settled.ok) {
        refuse(res, 503, 'service_unavailable');
        return;
      }
      if (settled.value.state !== 'granted') {
        refuse(res, 409, 'consent_required');
        return;
      }
    }

    const join = await mintCandidateJoin(endpoint, session, roomName);
    res.status(200).json({
      url: endpoint.url,
      livekit_token: join.jwt,
      expires_at: join.expiresAt,
      attempt_id: session.id,
    });
  }));

  return router;
}

/** The mounted router, with production dependencies. */
export const r1CandidateRouter = createR1CandidateRouter();
