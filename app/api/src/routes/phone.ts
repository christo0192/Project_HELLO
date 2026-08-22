/**
 * routes/phone.ts — the internal phone screening calendar, engagement,
 * health and control API.
 *
 * Mounted AFTER the global recruiter-auth and viewer-read-only middleware, so
 * an unauthenticated caller is already rejected with 401 and a viewer is
 * already rejected on every non-GET. Reads then require interviewer+; every
 * mutation additionally requires admin.
 *
 *   GET    /calendar?from=&to=        interviewer+  internal appointments in a range
 *   GET    /calendar/slots?date=      interviewer+  one IST day's slot grid
 *   GET    /engagements/:id           interviewer+  one engagement, sanitized
 *   GET    /health                    interviewer+  backlog, halt, window, concurrency
 *   POST   /appointments              admin         book a slot
 *   PATCH  /appointments/:id          admin         reschedule (atomic supersede)
 *   DELETE /appointments/:id          admin         cancel
 *   POST   /halt                      admin         raise the kill switch
 *   POST   /halt/clear                admin         lower it
 *
 * ── THIS IS AN OPERATOR SURFACE, NOT A CANDIDATE ONE ──────────────────
 * Nothing here is reachable by a candidate, and nothing here contacts a
 * candidate. There is no Google Calendar call, no email, no stage move and no
 * scorecard write — and no dialing: not one route can cause a call to be
 * placed. Booking a slot records an intention; `admit_phone_attempt` remains
 * the only thing that dials, and it is not mounted.
 *
 * ── WHAT MAY CROSS THIS BOUNDARY ──────────────────────────────────────
 * Opaque ids, closed-vocabulary states, bounded integers, instants, and the
 * candidate's display name, reference and pipeline status. NOT: a phone number
 * in any form, a suppression digest, a SIP call id, a room name, a participant
 * identity, an egress id, a lease token or owner, a provider event id, provider
 * metadata, or a transcript. Most of those cannot leak because the read store
 * never selects them — omission, not redaction, is the control. See
 * `lib/phone-screening/read-stores.ts`.
 *
 * ── THE DATABASE DECIDES, THE ROUTE AUTHORIZES ────────────────────────
 * Every mutation delegates to a 0042 SECURITY DEFINER RPC and writes nothing
 * directly. Slot legality, the 09:00-21:00 IST window, the IST-midnight
 * straddle, optimistic versions and the atomic supersede all live inside those
 * RPCs under a row lock. This route contributes authentication, the role gate,
 * shape validation, the audit record and the status-to-HTTP mapping — and
 * nothing else that could disagree with the schema.
 *
 * ── DISABLED BY DEFAULT ───────────────────────────────────────────────
 * `PHONE_SCREENING_ENABLED` defaults to false. While it is off, every READ
 * answers 200 with `enabled: false` and an empty projection, having performed
 * ZERO database work, and every WRITE is refused with 503. Reporting "the
 * feature is off" is safe; performing a mutation for a feature nobody has
 * turned on is not.
 */

import { Router, type Request, type Response } from 'express';
import { supabase } from '../lib/supabase.js';
import { requireRole } from '../lib/rbac.js';
import { recordAudit } from '../lib/audit.js';
import { validateBody, validateParams, validateQuery } from '../lib/validation.js';
import { idParamSchema } from '../schemas/common.js';
import {
  phoneAppointmentCancelSchema,
  phoneAppointmentCreateSchema,
  phoneAppointmentPatchSchema,
  phoneCalendarQuerySchema,
  phoneHaltClearSchema,
  phoneHaltSchema,
  phoneSlotsQuerySchema,
} from '../schemas/phone-api.js';
import {
  IST_TIME_ZONE,
  PHONE_BUDGET_CEILINGS,
  PHONE_IST_WINDOW_CLOSE_AT,
  PHONE_IST_WINDOW_OPEN_AT,
  PHONE_SUBSTRATE_RESIDUALS,
  buildPhoneSlotGrid,
  createPhoneReadStore,
  createPhoneStores,
  describePhoneScreeningConfig,
  istDayInstantRange,
  istWallClock,
  loadPhoneScreeningConfig,
  parseIstCalendarDate,
  type PhoneAppointmentRow,
  type PhoneCandidateRow,
  type PhoneEngagementRow,
  type PhoneHaltReason,
  type PhoneReadStore,
  type PhoneStores,
} from '../lib/phone-screening/index.js';

// ═══════════════════════════════════════════════════════════════════════
// Bounds
// ═══════════════════════════════════════════════════════════════════════

/** Rows one calendar request may return. Asking for one more detects truncation. */
const CALENDAR_ROW_LIMIT = 200;

/**
 * Live appointments one IST day's capacity projection will consider.
 *
 * A cap that silently truncated would make `booked` and `remaining` quietly
 * WRONG in the unsafe direction — fewer bookings seen means more capacity
 * claimed. So the read asks for one more than this and the response says
 * plainly when the day held more, which turns the projection into a stated
 * lower bound instead of a confident under-count.
 */
const SLOT_OCCUPANCY_LIMIT = 400;

/** Attempts shown on one engagement. 0042 bounds an engagement's budgets to
 *  three no-answers, three reconnects and five provider failures, so a healthy
 *  engagement has far fewer; the cap is a guard, not a page size. */
const ATTEMPT_LIMIT = 50;

// ═══════════════════════════════════════════════════════════════════════
// Small helpers
// ═══════════════════════════════════════════════════════════════════════

/** `HH:MM` in IST for a UTC ISO instant, or null if it is unparseable. */
function istClock(iso: string | null): string | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const w = istWallClock(new Date(ms));
  return `${String(w.hour).padStart(2, '0')}:${String(w.minute).padStart(2, '0')}`;
}

/** The window block every read echoes, so no client re-derives the time zone. */
function windowBlock(): Record<string, unknown> {
  return {
    time_zone: IST_TIME_ZONE,
    open_ist: PHONE_IST_WINDOW_OPEN_AT,
    close_ist: PHONE_IST_WINDOW_CLOSE_AT,
  };
}

/** The four P1 residuals, serialized. See `lib/phone-screening/residuals.ts`. */
function residualBlock(): Array<Record<string, unknown>> {
  return PHONE_SUBSTRATE_RESIDUALS.map((r) => ({
    code: r.code,
    writer: r.writer,
    appointment_status: r.appointmentStatus,
    owner: r.owner,
  }));
}

function candidateBlock(row: PhoneCandidateRow | undefined): Record<string, unknown> | null {
  if (!row) return null;
  return { id: row.id, name: row.name, status: row.status, reference: row.reference };
}

function appointmentBlock(row: PhoneAppointmentRow): Record<string, unknown> {
  return {
    id: row.id,
    engagement_id: row.engagementId,
    starts_at: row.startsAt,
    ends_at: row.endsAt,
    ist_date: row.istDate,
    ist_start: istClock(row.startsAt),
    ist_end: istClock(row.endsAt),
    status: row.status,
    source: row.source,
    // Always null today: nothing in 0042 writes it. Reported rather than
    // dropped so the residual stays visible instead of looking like an
    // absent feature. See `residualBlock()`.
    confirmed_at: row.confirmedAt,
    cancel_reason: row.cancelReason,
    version: row.version,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

/**
 * The three budgets, each as used/ceiling/exhausted.
 *
 * The ceilings are `PHONE_BUDGET_CEILINGS`, which mirror the 0042 CHECK
 * constraints and are drift-tested against the migration text. They are not
 * re-decided here, and `exhausted` uses `>=` so a row that somehow exceeded a
 * ceiling still reads as exhausted rather than as having room left.
 */
function budgetBlock(row: PhoneEngagementRow): Record<string, unknown> {
  const one = (used: number, ceiling: number): Record<string, unknown> => ({
    used,
    ceiling,
    exhausted: used >= ceiling,
  });
  return {
    no_answer: one(row.noAnswerAttempts, PHONE_BUDGET_CEILINGS.noAnswer),
    reconnect: one(row.reconnectsUsed, PHONE_BUDGET_CEILINGS.reconnect),
    provider_failure: one(row.providerFailures, PHONE_BUDGET_CEILINGS.providerFailure),
  };
}

// ── Status → HTTP, written down once per RPC ──────────────────────────

/**
 * Every RPC refusal maps to 409 with the refusal's own status as the error
 * code — the Ashby Mission Control precedent, and the reason each HTTP status
 * on this surface carries exactly ONE response shape.
 *
 * `slot_in_past` and `window_closed` are conflicts rather than bad requests:
 * the payload was well formed and correctly typed, and what refused it was the
 * state of the world at the instant the RPC ran. Reporting them as 400 would
 * also make 400 ambiguous between a Zod shape failure and a substrate refusal,
 * which is a distinction a client must be able to make without guessing.
 *
 * Only three answers escape that rule: `ok`-shaped successes, `not_found`
 * (404), and `unknown_status` — which is not a refusal at all but "we never got
 * an answer", and is therefore a 500.
 */
function refusalStatusCode(status: string): number {
  if (status === 'not_found') return 404;
  if (status === 'unknown_status') return 500;
  return 409;
}

/** The one place a refusal becomes a response. */
function sendRefusal(res: Response, status: string): void {
  const code = refusalStatusCode(status);
  res.status(code).json({
    ok: false,
    error: code === 500 ? 'phone_rpc_unknown_status' : status,
  });
}

export interface PhoneApiDeps {
  /** Injected read projection store. Production builds one lazily. */
  readStore?: PhoneReadStore;
  /** Injected 0042 RPC store. Production builds one lazily. */
  stores?: PhoneStores;
  /** Injected env map for deterministic feature-flag tests. */
  configSource?: NodeJS.ProcessEnv;
  /** Injected clock. Every RPC is handed `p_now` explicitly. */
  now?: () => Date;
}

export function createPhoneApiRouter(deps: PhoneApiDeps = {}): Router {
  const router = Router();

  let cachedRead: PhoneReadStore | undefined = deps.readStore;
  const readStore = (): PhoneReadStore => {
    if (!cachedRead) cachedRead = createPhoneReadStore(supabase as never);
    return cachedRead;
  };

  let cachedWrite: PhoneStores | undefined = deps.stores;
  const writeStore = (): PhoneStores => {
    if (!cachedWrite) cachedWrite = createPhoneStores(supabase as never);
    return cachedWrite;
  };

  const config = () => loadPhoneScreeningConfig(deps.configSource ?? process.env);
  const now = (): Date => deps.now?.() ?? new Date();

  /**
   * Refuse a mutation while the feature is off. Returns true when the caller
   * must stop. No store is touched, so a disabled deployment cannot write.
   */
  function refuseIfDisabled(res: Response): boolean {
    if (config().screeningEnabled) return false;
    res.status(503).json({ ok: false, error: 'phone_screening_disabled' });
    return true;
  }

  /**
   * A mutation's audit is fail-closed: `resource.create`/`update`/`delete` are
   * in `FAIL_CLOSED_EVENTS`, so `recordAudit` THROWS when the sink fails and
   * the caller must not report success.
   *
   * `compensate` runs before the 500 when the mutation is reversible. Only the
   * two halt routes pass one: raising and lowering a kill switch are exactly
   * invertible, and leaving an unaudited halt state in place is precisely the
   * thing an auditor would need. An appointment supersede is NOT reversible —
   * the previous row is already `superseded` and re-creating it would be a
   * second, differently-shaped mutation — so those routes report the failure
   * honestly with `rolled_back: false` and the client re-reads.
   */
  async function auditOrFail(
    req: Request,
    res: Response,
    event: 'resource.create' | 'resource.update' | 'resource.delete',
    statusCode: number,
    metadata: Record<string, unknown>,
    compensate?: () => Promise<boolean>,
  ): Promise<boolean> {
    try {
      await recordAudit(req, event, statusCode, { metadata });
      return true;
    } catch {
      let rolledBack = false;
      if (compensate) {
        try {
          rolledBack = await compensate();
        } catch {
          rolledBack = false;
        }
      }
      res.status(500).json({
        ok: false,
        error: 'phone_audit_write_failed',
        rolled_back: rolledBack,
      });
      return false;
    }
  }

  // ══════════════════════════════════════════════════════════════════
  //  GET /calendar — the internal appointment calendar
  // ══════════════════════════════════════════════════════════════════

  router.get(
    '/calendar',
    requireRole('interviewer'),
    validateQuery(phoneCalendarQuerySchema),
    async (req: Request, res: Response) => {
      const { from, to } = req.query as unknown as { from: string; to: string };
      const base = {
        ok: true as const,
        range: { from, to },
        window: windowBlock(),
      };
      if (!config().screeningEnabled) {
        res.json({ ...base, enabled: false, count: 0, truncated: false, appointments: [] });
        return;
      }
      try {
        // THREE bounded queries, whatever the row count: the appointments, then
        // their engagements in one `in()`, then those engagements' candidates in
        // one `in()`. Resolving a candidate per appointment would be the N+1
        // this shape makes impossible.
        const rows = await readStore().listAppointmentsByStart({
          fromIso: from,
          toIso: to,
          limit: CALENDAR_ROW_LIMIT + 1,
        });
        const truncated = rows.length > CALENDAR_ROW_LIMIT;
        const shown = truncated ? rows.slice(0, CALENDAR_ROW_LIMIT) : rows;

        const engagements = await readStore().listEngagementsByIds(
          shown.map((a) => a.engagementId),
        );
        const engagementById = new Map(engagements.map((e) => [e.id, e]));
        const candidates = await readStore().listCandidatesByIds(
          engagements.map((e) => e.candidateId),
        );
        const candidateById = new Map(candidates.map((c) => [c.id, c]));

        const appointments = shown.map((a) => {
          const engagement = engagementById.get(a.engagementId);
          return {
            ...appointmentBlock(a),
            // Null only if the parent row vanished between the two reads. The
            // FK cascades, so this is a torn read, not a missing relationship —
            // reported as null rather than guessed at.
            engagement_state: engagement?.state ?? null,
            candidate: candidateBlock(
              engagement ? candidateById.get(engagement.candidateId) : undefined,
            ),
          };
        });

        await recordAudit(req, 'resource.list', 200, {
          metadata: {
            resource: 'phone_appointment',
            count: appointments.length,
            truncated,
          },
        });
        res.json({ ...base, enabled: true, count: appointments.length, truncated, appointments });
      } catch {
        res.status(500).json({ ok: false, error: 'phone_read_error' });
      }
    },
  );

  // ══════════════════════════════════════════════════════════════════
  //  GET /calendar/slots — one IST day, capacity-projected
  // ══════════════════════════════════════════════════════════════════

  router.get(
    '/calendar/slots',
    requireRole('interviewer'),
    validateQuery(phoneSlotsQuerySchema),
    async (req: Request, res: Response) => {
      const { date } = req.query as unknown as { date: string };
      const cfg = config();
      const base = {
        ok: true as const,
        date,
        window: windowBlock(),
        slot_seconds: cfg.slotSeconds,
      };
      if (!cfg.screeningEnabled) {
        res.json({
          ...base,
          enabled: false,
          max_concurrent: null,
          booked_total: 0,
          occupancy_truncated: false,
          slots: [],
        });
        return;
      }
      try {
        const calendarDate = parseIstCalendarDate(date);
        // The whole IST DAY, not only the window: an appointment that legally
        // begins at 20:45 runs past the 21:00 close and still occupies its slot.
        const range = istDayInstantRange(calendarDate);
        const live = await readStore().listLiveAppointmentsByStart({
          fromIso: range.fromIso,
          toIso: range.toIso,
          limit: SLOT_OCCUPANCY_LIMIT + 1,
        });
        const occupancyTruncated = live.length > SLOT_OCCUPANCY_LIMIT;
        const counted = occupancyTruncated ? live.slice(0, SLOT_OCCUPANCY_LIMIT) : live;
        const slots = buildPhoneSlotGrid({
          date: calendarDate,
          slotSeconds: cfg.slotSeconds,
          now: now(),
          occupancy: counted.map((a) => ({ startsAt: a.startsAt, endsAt: a.endsAt })),
        });
        await recordAudit(req, 'resource.list', 200, {
          metadata: {
            resource: 'phone_slot',
            count: slots.length,
            booked_total: counted.length,
            occupancy_truncated: occupancyTruncated,
          },
        });
        res.json({
          ...base,
          enabled: true,
          // The fleet cap, mirrored from `phone_max_concurrent()`. Identical on
          // every slot, so it is reported once rather than twenty-four times.
          max_concurrent: slots[0]?.maxConcurrent ?? null,
          booked_total: counted.length,
          // True when the IST day held more live appointments than the
          // projection counted. `booked` is then a LOWER bound and `remaining`
          // an UPPER one; saying so is the difference between a bounded read
          // and a wrong answer.
          occupancy_truncated: occupancyTruncated,
          slots: slots.map((s) => ({
            starts_at: s.startsAt,
            ends_at: s.endsAt,
            ist_start: s.istStart,
            ist_end: s.istEnd,
            booked: s.booked,
            remaining: s.remaining,
            bookable: s.bookable,
            refusals: s.refusals,
          })),
        });
      } catch {
        res.status(500).json({ ok: false, error: 'phone_read_error' });
      }
    },
  );

  // ══════════════════════════════════════════════════════════════════
  //  GET /engagements/:id
  // ══════════════════════════════════════════════════════════════════

  router.get(
    '/engagements/:id',
    requireRole('interviewer'),
    validateParams(idParamSchema),
    async (req: Request, res: Response) => {
      const id = req.params.id as string;
      if (!config().screeningEnabled) {
        res.json({
          ok: true,
          enabled: false,
          engagement: null,
          candidate: null,
          appointment: null,
          attempts: [],
          attempts_truncated: false,
        });
        return;
      }
      try {
        const engagement = await readStore().getEngagement(id);
        if (!engagement) {
          res.status(404).json({ ok: false, error: 'not_found' });
          return;
        }
        // Three further bounded reads, none of them per-row.
        const [candidates, appointment, attempts] = await Promise.all([
          readStore().listCandidatesByIds([engagement.candidateId]),
          readStore().getLiveAppointmentForEngagement(engagement.id),
          readStore().listAttemptsForEngagement({
            engagementId: engagement.id,
            limit: ATTEMPT_LIMIT + 1,
          }),
        ]);
        const attemptsTruncated = attempts.length > ATTEMPT_LIMIT;
        const shownAttempts = attemptsTruncated ? attempts.slice(0, ATTEMPT_LIMIT) : attempts;

        await recordAudit(req, 'resource.read', 200, {
          metadata: {
            resource: 'phone_engagement',
            engagement_id: engagement.id,
            attempt_count: shownAttempts.length,
          },
        });
        res.json({
          ok: true,
          enabled: true,
          engagement: {
            id: engagement.id,
            state: engagement.state,
            state_reason: engagement.stateReason,
            epoch: engagement.epoch,
            version: engagement.version,
            terminal: engagement.terminalAt !== null,
            terminal_at: engagement.terminalAt,
            next_eligible_at: engagement.nextEligibleAt,
            next_eligible_ist: istClock(engagement.nextEligibleAt),
            last_attempt_at: engagement.lastAttemptAt,
            created_at: engagement.createdAt,
            updated_at: engagement.updatedAt,
            budgets: budgetBlock(engagement),
          },
          candidate: candidateBlock(candidates[0]),
          appointment: appointment ? appointmentBlock(appointment) : null,
          attempts: shownAttempts.map((a) => ({
            id: a.id,
            attempt_seq: a.attemptSeq,
            epoch: a.epoch,
            kind: a.kind,
            state: a.state,
            outcome_class: a.outcomeClass,
            ist_date: a.istDate,
            prior_engagement_state: a.priorEngagementState,
            admitted_at: a.admittedAt,
            answered_at: a.answeredAt,
            classified_at: a.classifiedAt,
            ended_at: a.endedAt,
          })),
          attempts_truncated: attemptsTruncated,
        });
      } catch {
        res.status(500).json({ ok: false, error: 'phone_read_error' });
      }
    },
  );

  // ══════════════════════════════════════════════════════════════════
  //  GET /health
  // ══════════════════════════════════════════════════════════════════

  router.get('/health', requireRole('interviewer'), async (req: Request, res: Response) => {
    const cfg = config();
    const configBlock = describePhoneScreeningConfig(cfg);
    if (!cfg.screeningEnabled) {
      res.json({
        ok: true,
        enabled: false,
        status: 'disabled',
        reasons: ['phone_screening_disabled'],
        config: configBlock,
        window: { ...windowBlock(), open_now: null, ist_date: null },
        admission: null,
        concurrency: null,
        engagements_by_state: null,
        appointments: null,
        ingress: null,
        backlog_unavailable: false,
        residuals: residualBlock(),
      });
      return;
    }

    // A backlog read failure must not take the surface down — and must not be
    // reported as a healthy zero either. Every count block becomes NULL rather
    // than 0, because "we could not read it" and "there is none" are different
    // answers and only one of them means everything is fine.
    let backlog: Awaited<ReturnType<PhoneStores['backlog']>> | null = null;
    try {
      const result = await writeStore().backlog({ now: now() });
      backlog = result.status === 'ok' ? result : null;
    } catch {
      backlog = null;
    }

    if (!backlog || !backlog.admission || !backlog.attempts || !backlog.appointments
        || !backlog.events) {
      res.json({
        ok: true,
        enabled: true,
        status: 'degraded',
        reasons: ['backlog_unavailable'],
        config: configBlock,
        window: { ...windowBlock(), open_now: null, ist_date: null },
        admission: null,
        concurrency: null,
        engagements_by_state: null,
        appointments: null,
        ingress: null,
        backlog_unavailable: true,
        residuals: residualBlock(),
      });
      return;
    }

    const reasons: string[] = [];
    // A MISSING control singleton reads as halted — 0042 fails closed on an
    // unreadable kill switch and so does this surface.
    if (!backlog.admission.controlPresent) reasons.push('halt_unreadable');
    if (backlog.admission.halted) reasons.push('admission_halted');
    // Live attempts whose lease has lapsed are holding a fleet slot that no
    // worker is heartbeating; they are waiting for the reclaim sweep.
    if (backlog.attempts.live > backlog.attempts.liveWithUnexpiredLease) {
      reasons.push('attempt_leases_expired');
    }
    if (
      backlog.attempts.maxConcurrent > 0 &&
      backlog.attempts.liveWithUnexpiredLease >= backlog.attempts.maxConcurrent
    ) {
      reasons.push('fleet_at_capacity');
    }
    // Overdue slots are the honest signal that no expiry sweep has run: nothing
    // in this phase calls `expire_phone_appointments`, so the status column
    // cannot catch up on its own. See the `appointment_missed_*` residual.
    if (backlog.appointments.overdue > 0) reasons.push('appointments_overdue');

    await recordAudit(req, 'resource.read', 200, {
      metadata: { resource: 'phone_health', reason_count: reasons.length },
    });

    res.json({
      ok: true,
      enabled: true,
      status: reasons.length === 0 ? 'ok' : 'degraded',
      reasons,
      config: configBlock,
      window: {
        ...windowBlock(),
        open_now: backlog.windowOpen ?? null,
        ist_date: backlog.istDate ?? null,
      },
      admission: {
        control_present: backlog.admission.controlPresent,
        halted: backlog.admission.halted,
        halt_reason: backlog.admission.haltReason,
      },
      concurrency: {
        live: backlog.attempts.live,
        live_with_unexpired_lease: backlog.attempts.liveWithUnexpiredLease,
        max_concurrent: backlog.attempts.maxConcurrent,
        oldest_live_age_seconds: backlog.attempts.oldestLiveAgeSeconds,
      },
      engagements_by_state: backlog.engagementsByState ?? {},
      appointments: {
        live: backlog.appointments.live,
        overdue: backlog.appointments.overdue,
      },
      // The ingress verdicts stay SPLIT. Collapsing them into one "ignored"
      // number would hide the difference between a stale epoch (fencing working
      // as designed) and an unknown attempt (an ingress talking about a call we
      // have no record of), which are opposite operational signals.
      ingress: {
        ignored_last_24h: backlog.events.ignoredLast24h,
        unknown_attempt_last_24h: backlog.events.unknownAttemptLast24h,
        stale_epoch_last_24h: backlog.events.staleEpochLast24h,
        terminal_last_24h: backlog.events.terminalLast24h,
        unexpected_event_last_24h: backlog.events.unexpectedEventLast24h,
      },
      backlog_unavailable: false,
      residuals: residualBlock(),
    });
  });

  // ══════════════════════════════════════════════════════════════════
  //  POST /appointments — book
  // ══════════════════════════════════════════════════════════════════

  router.post(
    '/appointments',
    requireRole('admin'),
    validateBody(phoneAppointmentCreateSchema),
    async (req: Request, res: Response) => {
      if (refuseIfDisabled(res)) return;
      const body = req.body as { engagement_id: string; starts_at: string; ends_at: string };
      const actorId = req.authUser?.id ?? null;
      try {
        const result = await writeStore().scheduleAppointment({
          engagementId: body.engagement_id,
          startsAt: new Date(body.starts_at),
          endsAt: new Date(body.ends_at),
          // Always `hr_manual`. This route is the manual channel by definition;
          // the other two sources describe events that did not happen here.
          source: 'hr_manual',
          actorId,
          // Null means "refuse if a live appointment already exists". Creating
          // is not rescheduling, and a POST must never silently supersede.
          expectedVersion: null,
          now: now(),
        });
        const status = result.status;
        if (status === 'ok' || status === 'ok_prereqs_pending') {
          const ok = await auditOrFail(req, res, 'resource.create', 201, {
            resource: 'phone_appointment',
            engagement_id: body.engagement_id,
            appointment_id: result.appointmentId ?? null,
            outcome: status,
          });
          if (!ok) return;
          res.status(201).json({
            ok: true,
            appointment_id: result.appointmentId ?? null,
            version: result.version ?? null,
            engagement_state: result.engagementState ?? null,
            // `ok_prereqs_pending` is a SUCCESS with a warning: the slot is
            // real and HR can see it, but the engagement's prerequisites are
            // unmet so nothing will dial it. Collapsing it into `ok` would let
            // an operator believe a call is going to happen at that time.
            prereqs_pending: status === 'ok_prereqs_pending',
            superseded_appointment_id: result.supersededAppointmentId ?? null,
          });
          return;
        }
        // `unknown_status` means the RPC could not be reached or answered with
        // something outside its vocabulary — "we do not know whether it
        // happened", never "it was refused".
        sendRefusal(res, status);
      } catch {
        res.status(500).json({ ok: false, error: 'phone_action_error' });
      }
    },
  );

  // ══════════════════════════════════════════════════════════════════
  //  PATCH /appointments/:id — reschedule
  // ══════════════════════════════════════════════════════════════════

  /**
   * Rescheduling is `schedule_phone_appointment` with an expected version: it
   * supersedes the live row and inserts the new one inside ONE transaction,
   * under the engagement's row lock. There is no cancel-then-book here, because
   * that pair has a window in which the candidate has no slot at all.
   *
   * The RPC addresses the ENGAGEMENT's live appointment, not an appointment id,
   * so this route resolves `:id` first to find the engagement and to refuse a
   * request aimed at a row that is no longer live. That pre-read is for routing
   * and 404s only — the RPC re-checks the version under the lock and remains
   * the authority. `superseded_appointment_id` is therefore returned VERBATIM
   * from the RPC rather than echoed back from the path: if a concurrent write
   * changed which appointment was live, the response says which row was
   * actually superseded instead of asserting the one the caller assumed.
   */
  router.patch(
    '/appointments/:id',
    requireRole('admin'),
    validateParams(idParamSchema),
    validateBody(phoneAppointmentPatchSchema),
    async (req: Request, res: Response) => {
      if (refuseIfDisabled(res)) return;
      const id = req.params.id as string;
      const body = req.body as { starts_at: string; ends_at: string; version: number };
      const actorId = req.authUser?.id ?? null;
      try {
        const existing = await readStore().getAppointment(id);
        if (!existing) {
          res.status(404).json({ ok: false, error: 'not_found' });
          return;
        }
        if (existing.status !== 'scheduled' && existing.status !== 'confirmed') {
          res.status(409).json({ ok: false, error: 'not_live' });
          return;
        }
        const result = await writeStore().scheduleAppointment({
          engagementId: existing.engagementId,
          startsAt: new Date(body.starts_at),
          endsAt: new Date(body.ends_at),
          source: 'hr_manual',
          actorId,
          expectedVersion: body.version,
          now: now(),
        });
        const status = result.status;
        if (status === 'ok' || status === 'ok_prereqs_pending') {
          const ok = await auditOrFail(req, res, 'resource.update', 200, {
            resource: 'phone_appointment',
            engagement_id: existing.engagementId,
            appointment_id: result.appointmentId ?? null,
            superseded_appointment_id: result.supersededAppointmentId ?? null,
            outcome: status,
          });
          if (!ok) return;
          res.json({
            ok: true,
            appointment_id: result.appointmentId ?? null,
            version: result.version ?? null,
            engagement_state: result.engagementState ?? null,
            prereqs_pending: status === 'ok_prereqs_pending',
            superseded_appointment_id: result.supersededAppointmentId ?? null,
          });
          return;
        }
        sendRefusal(res, status);
      } catch {
        res.status(500).json({ ok: false, error: 'phone_action_error' });
      }
    },
  );

  // ══════════════════════════════════════════════════════════════════
  //  DELETE /appointments/:id — cancel
  // ══════════════════════════════════════════════════════════════════

  router.delete(
    '/appointments/:id',
    requireRole('admin'),
    validateParams(idParamSchema),
    validateBody(phoneAppointmentCancelSchema),
    async (req: Request, res: Response) => {
      if (refuseIfDisabled(res)) return;
      const id = req.params.id as string;
      const body = req.body as { reason: string; version: number };
      const actorId = req.authUser?.id ?? null;
      try {
        const result = await writeStore().cancelAppointment({
          appointmentId: id,
          reason: body.reason as never,
          actorId,
          // Required on the wire. The RPC treats null as "cancel regardless",
          // which is precisely the lost update the version column prevents.
          expectedVersion: body.version,
          now: now(),
        });
        const status = result.status;
        // `already_cancelled` is IDEMPOTENT, not an error: the caller asked for
        // a state the row is already in. Reporting 409 would make a retry after
        // a dropped response look like a conflict.
        if (status === 'ok' || status === 'already_cancelled') {
          const ok = await auditOrFail(req, res, 'resource.delete', 200, {
            resource: 'phone_appointment',
            appointment_id: id,
            reason: body.reason,
            outcome: status,
          });
          if (!ok) return;
          res.json({
            ok: true,
            appointment_id: result.appointmentId ?? id,
            version: result.version ?? null,
            already_cancelled: status === 'already_cancelled',
          });
          return;
        }
        sendRefusal(res, status);
      } catch {
        res.status(500).json({ ok: false, error: 'phone_action_error' });
      }
    },
  );

  // ══════════════════════════════════════════════════════════════════
  //  POST /halt — raise the kill switch
  // ══════════════════════════════════════════════════════════════════

  router.post(
    '/halt',
    requireRole('admin'),
    validateBody(phoneHaltSchema),
    async (req: Request, res: Response) => {
      if (refuseIfDisabled(res)) return;
      const reason = (req.body as { reason: PhoneHaltReason }).reason;
      const actorId = req.authUser?.id ?? null;
      try {
        const result = await writeStore().setHalt({ reason, actorId, now: now() });
        if (result.status !== 'ok') {
          sendRefusal(res, result.status);
          return;
        }
        const alreadyHalted = result.alreadyHalted === true;
        const ok = await auditOrFail(
          req,
          res,
          'resource.update',
          200,
          {
            resource: 'phone_control',
            action: 'halt_set',
            reason,
            already_halted: alreadyHalted,
          },
          async () => {
            // Roll back ONLY the transition we caused. A halt that was already
            // in force is not ours to lift: 0042 preserves the original
            // instant, reason and actor across repeated halts, so our call
            // changed nothing and clearing would undo somebody else's decision.
            if (alreadyHalted) return false;
            const undo = await writeStore().clearHalt({ actorId, now: now() });
            return undo.status === 'ok';
          },
        );
        if (!ok) return;
        res.json({ ok: true, halted: true, already_halted: alreadyHalted, reason });
      } catch {
        res.status(500).json({ ok: false, error: 'phone_action_error' });
      }
    },
  );

  // ══════════════════════════════════════════════════════════════════
  //  POST /halt/clear — lower it
  // ══════════════════════════════════════════════════════════════════

  /**
   * The reason on the body must NAME the halt currently in force.
   *
   * 0042 defines no "why I am resuming" vocabulary and this phase may not add
   * one; a second, API-owned vocabulary would have nothing keeping it honest.
   * Requiring the EXISTING reason instead makes the field an interlock rather
   * than a formality — an admin who has not looked at why the dialer was
   * stopped cannot restart it — and it gives the audit-failure path a reason it
   * VERIFIED rather than one it guessed, so the compensating re-halt restores
   * the state that was actually there.
   */
  router.post(
    '/halt/clear',
    requireRole('admin'),
    validateBody(phoneHaltClearSchema),
    async (req: Request, res: Response) => {
      if (refuseIfDisabled(res)) return;
      const reason = (req.body as { reason: PhoneHaltReason }).reason;
      const actorId = req.authUser?.id ?? null;
      try {
        // Read the control state BEFORE clearing. A halt we cannot describe is
        // a halt we must not lift.
        const before = await writeStore().backlog({ now: now() });
        if (before.status !== 'ok' || !before.admission) {
          res.status(503).json({ ok: false, error: 'halt_state_unavailable' });
          return;
        }
        if (!before.admission.controlPresent) {
          // The singleton is missing. 0042 reads that as halted and refuses to
          // invent a cleared row; so does this route.
          res.status(503).json({ ok: false, error: 'halt_unreadable' });
          return;
        }
        const priorReason = before.admission.haltReason;
        if (before.admission.halted && priorReason !== reason) {
          res.status(409).json({ ok: false, error: 'halt_reason_mismatch' });
          return;
        }

        const result = await writeStore().clearHalt({ actorId, now: now() });
        if (result.status !== 'ok') {
          // A missing singleton is an operational unavailability, not a client
          // error — 0042 refuses to invent a cleared row and so does this.
          if (result.status === 'halt_unreadable') {
            res.status(503).json({ ok: false, error: 'halt_unreadable' });
            return;
          }
          sendRefusal(res, result.status);
          return;
        }
        const wasHalted = result.wasHalted === true;
        const ok = await auditOrFail(
          req,
          res,
          'resource.update',
          200,
          {
            resource: 'phone_control',
            action: 'halt_cleared',
            previous_reason: priorReason,
            was_halted: wasHalted,
          },
          async () => {
            // Restore the halt we just lifted, with the reason we verified
            // against the control row. If it was not halted, our clear was a
            // no-op and there is nothing to put back.
            if (!wasHalted) return false;
            const undo = await writeStore().setHalt({ reason, actorId, now: now() });
            return undo.status === 'ok';
          },
        );
        if (!ok) return;
        res.json({ ok: true, halted: false, was_halted: wasHalted, previous_reason: priorReason });
      } catch {
        res.status(500).json({ ok: false, error: 'phone_action_error' });
      }
    },
  );

  return router;
}

/** Default router instance (production wiring). */
export const phoneApiRouter = createPhoneApiRouter();
