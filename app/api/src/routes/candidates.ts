import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { validateQuery, validateParams, validateBody } from '../lib/validation.js';
import {
  listCandidatesQuerySchema,
  candidateIdParamSchema,
  manualPhoneCallBodySchema,
  phoneRescreenBodySchema,
  phoneTestGateBodySchema,
  phoneVerificationBodySchema,
  phoneCandidateAppointmentCreateSchema,
  phoneCandidateAppointmentPatchSchema,
} from '../schemas/candidates.js';
import { phoneAppointmentCancelSchema } from '../schemas/phone-api.js';
import { idParamSchema, uuidSchema } from '../schemas/common.js';
import { requireRole } from '../lib/rbac.js';
import { recordAudit } from '../lib/audit.js';
import { redactCandidatePhone } from '../lib/candidate-phone.js';
import { createLogger } from '../lib/logger.js';

const candidateLogger = createLogger('candidates');

/** Resolve visibility before any phone-cycle or appointment read. */
async function candidateVisibleToRecruiter(
  candidateId: string,
  user: { id: string; appRole: 'admin' | 'interviewer' | 'viewer' } | undefined,
): Promise<boolean> {
  let query = supabase.from('candidates').select('id,owner_id').eq('id', candidateId);
  if (user?.appRole === 'interviewer') query = query.eq('owner_id', user.id);
  const { data, error } = await query.maybeSingle();
  return !error && Boolean(data);
}

function rpcStatus(data: unknown): string {
  return data && typeof data === 'object' && 'status' in data
    ? String((data as { status?: unknown }).status)
    : 'unknown_status';
}

export const candidatesRouter = Router();

type Recommendation = 'advance' | 'hold' | 'reject';
const RECOMMENDATIONS: readonly Recommendation[] = ['advance', 'hold', 'reject'];

interface LatestAssessment {
  overall_score: number | null;
  recommendation: Recommendation | null;
}

/**
 * Reduce an assessments result set (ordered created_at DESC) to the latest
 * assessment per candidate. Single pass, no N+1 — the caller fetches all
 * assessments for the candidate set in one query.
 */
function latestAssessmentByCandidate(
  rows: Array<{
    candidate_id: string;
    overall_score: number | string | null;
    recommendation: string | null;
    created_at: string;
  }> | null,
): Map<string, LatestAssessment> {
  const map = new Map<string, LatestAssessment>();
  for (const row of rows ?? []) {
    if (map.has(row.candidate_id)) continue; // first seen = latest (DESC order)
    const score =
      row.overall_score == null || Number.isNaN(Number(row.overall_score))
        ? null
        : Number(row.overall_score);
    const rec = RECOMMENDATIONS.includes(row.recommendation as Recommendation)
      ? (row.recommendation as Recommendation)
      : null;
    map.set(row.candidate_id, { overall_score: score, recommendation: rec });
  }
  return map;
}

/**
 * The ONE sanitized resume-review enum a candidate row may carry.
 *
 * `null` for every non-Ashby candidate, and for an Ashby candidate whose
 * ingestion row cannot be read. Nothing else about the integration crosses
 * this boundary: no application link id, no external Ashby id, no file handle,
 * no `failed_reason` text, no attempt counter.
 */
export type ResumeReview = 'ready' | 'processing' | 'needs_review' | 'cancelled';

/**
 * Project a durable 0029 ingestion state onto that enum.
 *
 * `failed_review` becomes `needs_review` deliberately: the list says a HUMAN
 * needs to look, and says nothing whatsoever about why. The nine parse causes,
 * the scan verdicts and the guard rejections are all operator information and
 * live in Mission Control, which is admin-gated; a recruiter list is not the
 * place to disclose that a particular document was rejected by a malware
 * scanner.
 *
 * An unknown state maps to null rather than being guessed at.
 */
export function projectResumeReview(state: unknown): ResumeReview | null {
  switch (state) {
    case 'ready': return 'ready';
    case 'cancelled': return 'cancelled';
    case 'failed_review': return 'needs_review';
    case 'queued':
    case 'fetching':
    case 'scanning':
    case 'extracting':
    case 'structuring':
      return 'processing';
    default: return null;
  }
}

interface RawLinkRow {
  candidate_id?: unknown;
  updated_at?: unknown;
  ashby_resume_ingestions?: Array<{ state?: unknown }> | { state?: unknown } | null;
}

/**
 * Reduce link rows (ordered `updated_at` DESC) to one resume-review value per
 * candidate — first seen wins, the same idiom `latestAssessmentByCandidate`
 * uses. A candidate holding more than one Ashby application reports its most
 * recently updated one rather than a list the list view cannot disambiguate.
 */
function resumeReviewByCandidate(rows: RawLinkRow[] | null): Map<string, ResumeReview | null> {
  const map = new Map<string, ResumeReview | null>();
  for (const row of rows ?? []) {
    const id = row.candidate_id;
    if (typeof id !== 'string' || map.has(id)) continue;
    const embedded = row.ashby_resume_ingestions;
    const ingestion = Array.isArray(embedded) ? embedded[0] : embedded ?? undefined;
    map.set(id, projectResumeReview(ingestion?.state));
  }
  return map;
}

// List candidates (optionally by role) — viewer and above.
// Interviewer sees only own records; admin/viewer see all. Each row is
// enriched with the latest assessment recommendation + score (nullable),
// suppressed to null while the candidate is under a decision-use block.
candidatesRouter.get('/', requireRole('viewer'), validateQuery(listCandidatesQuerySchema), async (req, res, next) => {
  let q = supabase
    .from('candidates')
    .select(
      'id,name,email,phone_e164,phone_valid,skills,experience_years,status,role_id,created_at,decision_use_blocked_at',
    )
    .order('created_at', { ascending: false });

  if (req.query.role_id) q = q.eq('role_id', req.query.role_id as string);
  if (req.authUser?.appRole === 'interviewer') {
    q = q.eq('owner_id', req.authUser.id);
  }

  const { data, error } = await q;
  if (error) return next(error);

  const rows = (data ?? []) as Array<Record<string, unknown> & {
    id: string;
    decision_use_blocked_at: string | null;
  }>;

  // One query for all latest assessments across the returned candidate set.
  let latest = new Map<string, LatestAssessment>();
  const ids = rows.map((r) => r.id);
  if (ids.length > 0) {
    const { data: assessments } = await supabase
      .from('assessments')
      .select('candidate_id, overall_score, recommendation, created_at')
      .in('candidate_id', ids)
      .order('created_at', { ascending: false });
    latest = latestAssessmentByCandidate(assessments as never);
  }

  // ONE additional bounded query for the whole page — an `in (...)` over the
  // same candidate set the assessments query already uses, with the ingestion
  // state embedded. Not a per-row lookup: a list of 50 candidates issues one
  // extra query, not 50.
  //
  // A failure here degrades to `null` rather than failing the list: the
  // resume-review column is strictly additive diagnostic information, and the
  // candidate list must not stop working because the Ashby tables are
  // unavailable.
  let resumeReview = new Map<string, ResumeReview | null>();
  if (ids.length > 0) {
    try {
      const { data: links, error: linkErr } = await supabase
        .from('ashby_application_links')
        .select('candidate_id, updated_at, ashby_resume_ingestions ( state )')
        .eq('provider', 'ashby')
        .in('candidate_id', ids)
        .order('updated_at', { ascending: false })
        .limit(1, { foreignTable: 'ashby_resume_ingestions' });
      if (!linkErr) resumeReview = resumeReviewByCandidate(links as RawLinkRow[] | null);
    } catch { /* additive only — never fails the list */ }
  }

  // The role this list is being rendered for. `phone_e164` is admin-only —
  // see `redactCandidatePhone`. This endpoint has always SELECTED the column;
  // what changed is that it can now hold a real number, which makes an
  // untouched `requireRole('viewer')` route a disclosure the diff would never
  // show. The boolean `phone_valid` is deliberately left visible to everyone.
  const role = req.authUser?.appRole;

  const enriched = rows.map((row) => {
    // Strip the internal block field; it drives suppression only.
    const { decision_use_blocked_at, ...pub } = redactCandidatePhone(row, role);
    const blocked = decision_use_blocked_at != null;
    const la = latest.get(row.id);
    return {
      ...pub,
      latest_recommendation: blocked ? null : la?.recommendation ?? null,
      latest_score: blocked ? null : la?.overall_score ?? null,
      // Nullable by design, and truthfully so: a PII-minimal shell created at
      // import has null `name`/`email` and this is the only field that says
      // anything about it at all.
      resume_review: resumeReview.get(row.id) ?? null,
    };
  });

  res.json(enriched);
});

// Aggregate pipeline assessment metrics — viewer and above, owner-scoped for
// interviewers. Truthful and efficient (two bounded queries, no N+1):
//   - average_score: mean of each candidate's latest assessment score across
//     the assessed, non-suppressed cohort; null when none.
//   - recommendation_distribution: deterministic per-recommendation counts.
// Decision-use-blocked candidates are excluded (their automated
// recommendations are suppressed everywhere).
candidatesRouter.get('/summary', requireRole('viewer'), async (req, res, next) => {
  let cq = supabase.from('candidates').select('id, decision_use_blocked_at');
  if (req.authUser?.appRole === 'interviewer') {
    cq = cq.eq('owner_id', req.authUser.id);
  }
  const { data: candidates, error } = await cq;
  if (error) return next(error);

  const eligibleIds = ((candidates ?? []) as Array<{ id: string; decision_use_blocked_at: string | null }>)
    .filter((c) => c.decision_use_blocked_at == null)
    .map((c) => c.id);

  const distribution: Record<Recommendation, number> = { advance: 0, hold: 0, reject: 0 };
  let scoreSum = 0;
  let scoreCount = 0;

  if (eligibleIds.length > 0) {
    const { data: assessments } = await supabase
      .from('assessments')
      .select('candidate_id, overall_score, recommendation, created_at')
      .in('candidate_id', eligibleIds)
      .order('created_at', { ascending: false });
    const latest = latestAssessmentByCandidate(assessments as never);
    for (const { overall_score, recommendation } of latest.values()) {
      if (recommendation) distribution[recommendation] += 1;
      if (overall_score != null) {
        scoreSum += overall_score;
        scoreCount += 1;
      }
    }
  }

  res.json({
    assessed_count: scoreCount,
    average_score: scoreCount > 0 ? Math.round((scoreSum / scoreCount) * 10) / 10 : null,
    recommendation_distribution: distribution,
  });
});

// Manual phone request — interviewer/admin. This route only creates/adopts the
// application-scoped engagement. The due pass and `admit_phone_attempt` remain
// the only path that can originate a call, so an HTTP retry cannot dial twice.
candidatesRouter.post(
  '/:id/phone-call',
  requireRole('interviewer'),
  validateParams(candidateIdParamSchema),
  validateBody(manualPhoneCallBodySchema),
  async (req, res) => {
    if (process.env.PHONE_SCREENING_ENABLED !== 'true') {
      res.status(503).json({ ok: false, error: 'phone_screening_disabled' });
      return;
    }

    try {
      let query = supabase
        .from('candidates')
        .select('id, owner_id')
        .eq('id', req.params.id);
      if (req.authUser?.appRole === 'interviewer') {
        query = query.eq('owner_id', req.authUser.id);
      }
      const { data: candidate, error: candidateError } = await query.maybeSingle();
      if (candidateError || !candidate) {
        res.status(404).json({ ok: false, error: 'candidate_not_found' });
        return;
      }

      const { data, error } = await supabase.rpc('request_candidate_phone_call', {
        p_candidate_id: req.params.id,
        p_now: new Date().toISOString(),
      });
      if (error) {
        candidateLogger.warn('unknown_event', {
          error_category: 'manual_phone_request',
          error_type: 'rpc_failed',
        });
        res.status(503).json({ ok: false, error: 'phone_request_unavailable' });
        return;
      }

      const status = data && typeof data === 'object' && 'status' in data
        ? String((data as { status: unknown }).status)
        : 'unknown';
      const accepted = status === 'eligible' || status === 'scheduled_next_window'
        || status === 'already_requested';
      await recordAudit(req, 'resource.create', accepted ? 202 : 409, {
        metadata: { resource: 'phone_call_request', status },
      });
      if (!accepted) {
        res.status(409).json({ ok: false, error: 'phone_request_refused', status });
        return;
      }
      res.status(202).json({ ok: true, status: status === 'already_requested' ? 'already_requested' : 'requested' });
    } catch {
      res.status(503).json({ ok: false, error: 'phone_request_unavailable' });
    }
  },
);

// Candidate-profile appointment booking resolves the active cycle and slot in
// one SQL transaction. There is no raw engagement-id input and no provider
// operation; the normal due loop remains the only dial path.
candidatesRouter.post(
  '/:id/phone-appointments',
  requireRole('interviewer'),
  validateParams(candidateIdParamSchema),
  validateBody(phoneCandidateAppointmentCreateSchema),
  async (req, res) => {
    if (process.env.PHONE_SCREENING_ENABLED !== 'true') {
      res.status(503).json({ ok: false, error: 'phone_screening_disabled' });
      return;
    }
    if (!(await candidateVisibleToRecruiter(req.params.id, req.authUser))) {
      res.status(404).json({ ok: false, error: 'candidate_not_found' });
      return;
    }
    const body = req.body as { starts_at: string; ends_at: string };
    try {
      const { data, error } = await supabase.rpc('schedule_candidate_phone_appointment', {
        p_candidate_id: req.params.id,
        p_starts_at: body.starts_at,
        p_ends_at: body.ends_at,
        p_actor_id: req.authUser?.id ?? null,
        p_now: new Date().toISOString(),
      });
      if (error) {
        res.status(503).json({ ok: false, error: 'phone_schedule_unavailable' });
        return;
      }
      const status = rpcStatus(data);
      if (status === 'ok' || status === 'ok_prereqs_pending') {
        await recordAudit(req, 'resource.create', 201, {
          metadata: { resource: 'phone_appointment', outcome: status },
        });
        const row = data as Record<string, unknown>;
        res.status(201).json({
          ok: true,
          appointment_id: typeof row.appointment_id === 'string' ? row.appointment_id : null,
          version: typeof row.version === 'number' ? row.version : null,
          engagement_state: typeof row.engagement_state === 'string' ? row.engagement_state : null,
          prereqs_pending: status === 'ok_prereqs_pending',
          superseded_appointment_id: null,
        });
        return;
      }
      res.status(409).json({ ok: false, error: status === 'unknown_status' ? 'phone_rpc_unknown_status' : status });
    } catch {
      res.status(503).json({ ok: false, error: 'phone_schedule_unavailable' });
    }
  },
);

// Reschedule/cancel from a candidate profile. The appointment id is checked
// against the candidate before the mutation, and the SQL RPC re-checks its
// version under the engagement lock.
candidatesRouter.patch(
  '/:id/phone-appointments/:appointmentId',
  requireRole('interviewer'),
  validateParams(idParamSchema.extend({ appointmentId: uuidSchema })),
  validateBody(phoneCandidateAppointmentPatchSchema.omit({ appointment_id: true })),
  async (req, res) => {
    if (process.env.PHONE_SCREENING_ENABLED !== 'true') {
      res.status(503).json({ ok: false, error: 'phone_screening_disabled' });
      return;
    }
    if (!(await candidateVisibleToRecruiter(req.params.id, req.authUser))) {
      res.status(404).json({ ok: false, error: 'candidate_not_found' });
      return;
    }
    try {
      const { data: appointment, error: appointmentError } = await supabase
        .from('phone_appointments')
        .select('id,engagement_id,status,version')
        .eq('id', req.params.appointmentId)
        .maybeSingle();
      if (appointmentError || !appointment) {
        res.status(404).json({ ok: false, error: 'appointment_not_found' });
        return;
      }
      const { data: engagement, error: engagementError } = await supabase
        .from('phone_engagements')
        .select('candidate_id')
        .eq('id', appointment.engagement_id)
        .maybeSingle();
      if (engagementError || !engagement || engagement.candidate_id !== req.params.id) {
        res.status(404).json({ ok: false, error: 'appointment_not_found' });
        return;
      }
      const body = req.body as { starts_at: string; ends_at: string; version: number };
      const { data, error } = await supabase.rpc('schedule_phone_appointment', {
        p_engagement_id: appointment.engagement_id,
        p_starts_at: body.starts_at,
        p_ends_at: body.ends_at,
        p_source: 'hr_manual',
        p_actor_id: req.authUser?.id ?? null,
        p_expected_version: body.version,
        p_now: new Date().toISOString(),
      });
      if (error) {
        res.status(503).json({ ok: false, error: 'phone_schedule_unavailable' });
        return;
      }
      const status = rpcStatus(data);
      const row = data as Record<string, unknown>;
      if ((status === 'ok' || status === 'ok_prereqs_pending') && 'superseded_appointment_id' in row) {
        if (row.superseded_appointment_id === null) {
          // A concurrent cancel won between the read and the RPC. Undo the
          // create that schedule_phone_appointment necessarily performed when
          // it found no live row, then report the lost update.
          if (typeof row.appointment_id === 'string' && typeof row.version === 'number') {
            await supabase.rpc('cancel_phone_appointment', {
              p_appointment_id: row.appointment_id,
              p_reason: 'hr_cancelled',
              p_actor_id: req.authUser?.id ?? null,
              p_expected_version: row.version,
              p_now: new Date().toISOString(),
            });
          }
          res.status(409).json({ ok: false, error: 'version_conflict' });
          return;
        }
        await recordAudit(req, 'resource.update', 200, {
          metadata: { resource: 'phone_appointment', outcome: status },
        });
        res.json({
          ok: true,
          appointment_id: typeof row.appointment_id === 'string' ? row.appointment_id : null,
          version: typeof row.version === 'number' ? row.version : null,
          engagement_state: typeof row.engagement_state === 'string' ? row.engagement_state : null,
          prereqs_pending: status === 'ok_prereqs_pending',
          superseded_appointment_id: typeof row.superseded_appointment_id === 'string'
            ? row.superseded_appointment_id : null,
        });
        return;
      }
      res.status(409).json({ ok: false, error: status === 'unknown_status' ? 'phone_rpc_unknown_status' : status });
    } catch {
      res.status(503).json({ ok: false, error: 'phone_schedule_unavailable' });
    }
  },
);

candidatesRouter.delete(
  '/:id/phone-appointments/:appointmentId',
  requireRole('interviewer'),
  validateParams(idParamSchema.extend({ appointmentId: uuidSchema })),
  validateBody(phoneAppointmentCancelSchema),
  async (req, res) => {
    if (process.env.PHONE_SCREENING_ENABLED !== 'true') {
      res.status(503).json({ ok: false, error: 'phone_screening_disabled' });
      return;
    }
    if (!(await candidateVisibleToRecruiter(req.params.id, req.authUser))) {
      res.status(404).json({ ok: false, error: 'candidate_not_found' });
      return;
    }
    try {
      const { data: appointment, error: appointmentError } = await supabase
        .from('phone_appointments')
        .select('id,engagement_id,status')
        .eq('id', req.params.appointmentId)
        .maybeSingle();
      if (appointmentError || !appointment) {
        res.status(404).json({ ok: false, error: 'appointment_not_found' });
        return;
      }
      const { data: engagement, error: engagementError } = await supabase
        .from('phone_engagements')
        .select('candidate_id')
        .eq('id', appointment.engagement_id)
        .maybeSingle();
      if (engagementError || !engagement || engagement.candidate_id !== req.params.id) {
        res.status(404).json({ ok: false, error: 'appointment_not_found' });
        return;
      }
      const body = req.body as { reason: string; version: number };
      const { data, error } = await supabase.rpc('cancel_phone_appointment', {
        p_appointment_id: req.params.appointmentId,
        p_reason: body.reason,
        p_actor_id: req.authUser?.id ?? null,
        p_expected_version: body.version,
        p_now: new Date().toISOString(),
      });
      if (error) {
        res.status(503).json({ ok: false, error: 'phone_schedule_unavailable' });
        return;
      }
      const status = rpcStatus(data);
      if (status === 'ok' || status === 'already_cancelled') {
        await recordAudit(req, 'resource.delete', 200, {
          metadata: { resource: 'phone_appointment', outcome: status },
        });
        const row = data as Record<string, unknown>;
        res.json({
          ok: true,
          appointment_id: typeof row.appointment_id === 'string' ? row.appointment_id : req.params.appointmentId,
          version: typeof row.version === 'number' ? row.version : null,
          already_cancelled: status === 'already_cancelled',
        });
        return;
      }
      res.status(409).json({ ok: false, error: status === 'unknown_status' ? 'phone_rpc_unknown_status' : status });
    } catch {
      res.status(503).json({ ok: false, error: 'phone_schedule_unavailable' });
    }
  },
);

// Phone-cycle history is deliberately a separate, bounded projection. It is
// candidate-owned rather than a generic phone-calendar read, so the interviewer
// ownership check happens before any service-role phone query.
candidatesRouter.get(
  '/:id/phone-cycles',
  requireRole('interviewer'),
  validateParams(candidateIdParamSchema),
  async (req, res) => {
    if (process.env.PHONE_SCREENING_ENABLED !== 'true') {
      res.json({ ok: true, enabled: false, cycles: [], current_cycle: null });
      return;
    }

    let candidateQuery = supabase
      .from('candidates')
      .select('id,owner_id')
      .eq('id', req.params.id);
    if (req.authUser?.appRole === 'interviewer') {
      candidateQuery = candidateQuery.eq('owner_id', req.authUser.id);
    }
    const { data: candidate, error: candidateError } = await candidateQuery.maybeSingle();
    if (candidateError || !candidate) {
      res.status(404).json({ ok: false, error: 'candidate_not_found' });
      return;
    }

    try {
      const { data: rows, error } = await supabase
        .from('phone_engagements')
        .select('id,cycle_number,state,state_reason,version,no_answer_attempts,no_answer_limit,reconnects_used,provider_failures,next_eligible_at,last_attempt_at,terminal_at,created_at,updated_at,session_id')
        .eq('candidate_id', req.params.id)
        .order('cycle_number', { ascending: false })
        .limit(10);
      if (error) {
        res.status(503).json({ ok: false, error: 'phone_read_error' });
        return;
      }

      const engagements = (rows ?? []) as Array<Record<string, unknown>>;
      const engagementIds = engagements
        .map((row) => typeof row.id === 'string' ? row.id : null)
        .filter((id): id is string => id !== null);
      const sessionIds = engagements
        .map((row) => typeof row.session_id === 'string' ? row.session_id : null)
        .filter((id): id is string => id !== null);

      const [appointmentsResult, assessmentsResult] = await Promise.all([
        engagementIds.length === 0
          ? Promise.resolve({ data: [], error: null })
          : supabase
            .from('phone_appointments')
            .select('id,engagement_id,starts_at,ends_at,status,source,version')
            .in('engagement_id', engagementIds)
            .in('status', ['scheduled', 'confirmed'])
            .order('starts_at', { ascending: true })
            .limit(10),
        sessionIds.length === 0
          ? Promise.resolve({ data: [], error: null })
          : supabase
            .from('assessments')
            .select('session_id')
            .in('session_id', sessionIds)
            .eq('source', 'phone')
            .limit(10),
      ]);
      if (appointmentsResult.error || assessmentsResult.error) {
        res.status(503).json({ ok: false, error: 'phone_read_error' });
        return;
      }

      const appointments = (appointmentsResult.data ?? []) as Array<Record<string, unknown>>;
      const appointmentByEngagement = new Map<string, Record<string, unknown>>();
      for (const appointment of appointments) {
        if (typeof appointment.engagement_id === 'string') {
          appointmentByEngagement.set(appointment.engagement_id, appointment);
        }
      }
      const scoredSessions = new Set(
        ((assessmentsResult.data ?? []) as Array<Record<string, unknown>>)
          .map((row) => typeof row.session_id === 'string' ? row.session_id : null)
          .filter((id): id is string => id !== null),
      );

      const cycles = engagements.map((row) => {
        const id = typeof row.id === 'string' ? row.id : '';
        const appointment = appointmentByEngagement.get(id);
        return {
          cycle_number: typeof row.cycle_number === 'number' ? row.cycle_number : null,
          state: typeof row.state === 'string' ? row.state : 'unknown',
          state_reason: typeof row.state_reason === 'string' ? row.state_reason : null,
          version: typeof row.version === 'number' ? row.version : null,
          no_answer_attempts: typeof row.no_answer_attempts === 'number' ? row.no_answer_attempts : null,
          no_answer_limit: typeof row.no_answer_limit === 'number' ? row.no_answer_limit : null,
          reconnects_used: typeof row.reconnects_used === 'number' ? row.reconnects_used : null,
          provider_failures: typeof row.provider_failures === 'number' ? row.provider_failures : null,
          next_eligible_at: typeof row.next_eligible_at === 'string' ? row.next_eligible_at : null,
          last_attempt_at: typeof row.last_attempt_at === 'string' ? row.last_attempt_at : null,
          terminal_at: typeof row.terminal_at === 'string' ? row.terminal_at : null,
          created_at: typeof row.created_at === 'string' ? row.created_at : null,
          updated_at: typeof row.updated_at === 'string' ? row.updated_at : null,
          has_session: typeof row.session_id === 'string',
          has_assessment: typeof row.session_id === 'string' && scoredSessions.has(row.session_id),
          appointment: appointment ? {
            appointment_id: typeof appointment.id === 'string' ? appointment.id : null,
            starts_at: typeof appointment.starts_at === 'string' ? appointment.starts_at : null,
            ends_at: typeof appointment.ends_at === 'string' ? appointment.ends_at : null,
            status: typeof appointment.status === 'string' ? appointment.status : null,
            source: typeof appointment.source === 'string' ? appointment.source : null,
            version: typeof appointment.version === 'number' ? appointment.version : null,
          } : null,
        };
      });
      const current = cycles.find((cycle) => cycle.terminal_at === null) ?? cycles[0] ?? null;
      await recordAudit(req, 'resource.read', 200, {
        metadata: { resource: 'phone_screening_cycles', cycle_count: cycles.length },
      });
      res.json({ ok: true, enabled: true, cycles, current_cycle: current?.cycle_number ?? null });
    } catch {
      res.status(503).json({ ok: false, error: 'phone_read_error' });
    }
  },
);

// Request a new immutable phone cycle. The browser supplies only a bounded
// reason and idempotency key; the database resolves the application link and
// enforces the terminal-state, consent, cooldown and cycle-limit policy.
candidatesRouter.post(
  '/:id/phone-rescreens',
  requireRole('interviewer'),
  validateParams(candidateIdParamSchema),
  validateBody(phoneRescreenBodySchema),
  async (req, res) => {
    if (process.env.PHONE_SCREENING_ENABLED !== 'true') {
      res.status(503).json({ ok: false, error: 'phone_screening_disabled' });
      return;
    }
    let candidateQuery = supabase
      .from('candidates')
      .select('id,owner_id')
      .eq('id', req.params.id);
    if (req.authUser?.appRole === 'interviewer') {
      candidateQuery = candidateQuery.eq('owner_id', req.authUser.id);
    }
    const { data: candidate, error: candidateError } = await candidateQuery.maybeSingle();
    if (candidateError || !candidate) {
      res.status(404).json({ ok: false, error: 'candidate_not_found' });
      return;
    }

    const body = req.body as { request_id: string; reason: string };
    try {
      const { data, error } = await supabase.rpc('request_phone_rescreen', {
        p_candidate_id: req.params.id,
        p_reason: body.reason,
        p_request_id: body.request_id,
        p_source: 'hr_manual',
        p_actor_id: req.authUser?.id ?? null,
        p_now: new Date().toISOString(),
      });
      if (error) {
        res.status(503).json({ ok: false, error: 'phone_rescreen_unavailable' });
        return;
      }
      const status = data && typeof data === 'object' && 'status' in data
        ? String((data as { status?: unknown }).status)
        : 'unknown_status';
      if (status === 'ok' || status === 'already_requested') {
        await recordAudit(req, 'resource.create', 202, {
          metadata: { resource: 'phone_rescreen', outcome: status },
        });
        res.status(202).json({
          ok: true,
          status,
          cycle_number: typeof (data as { cycle_number?: unknown })?.cycle_number === 'number'
            ? (data as { cycle_number: number }).cycle_number : null,
        });
        return;
      }
      await recordAudit(req, 'resource.create', 409, {
        metadata: { resource: 'phone_rescreen', outcome: status },
      });
      res.status(409).json({ ok: false, error: 'phone_rescreen_refused', status });
    } catch {
      res.status(503).json({ ok: false, error: 'phone_rescreen_unavailable' });
    }
  },
);

// Arm a single candidate-scoped production test while the global operator
// pause remains raised. If the candidate already has a live non-terminal
// engagement (0081: `eligible` or a `scheduled` due appointment), the exclusive
// ten-minute gate is armed on THAT existing cycle — no new rescreen cycle is
// minted. Only a candidate with no active cycle takes the original path, which
// creates the immutable rescreen intent first and then arms. Either way,
// admission (admit_phone_attempt) consumes the gate atomically and re-checks
// every consent/allowlist/number/window/lease/capacity/cap prerequisite.
candidatesRouter.post(
  '/:id/phone-test-gate',
  requireRole('admin'),
  validateParams(candidateIdParamSchema),
  validateBody(phoneTestGateBodySchema),
  async (req, res) => {
    if (process.env.PHONE_SCREENING_ENABLED !== 'true') {
      res.status(503).json({ ok: false, error: 'phone_screening_disabled' });
      return;
    }
    const candidateId = req.params.id;
    const actorId = req.authUser?.id;
    if (!actorId) {
      res.status(403).json({ ok: false, error: 'admin_identity_required' });
      return;
    }
    const { request_id: requestId } = req.body as { request_id: string };
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 10 * 60 * 1000);

    // Helper: arm the exclusive gate on a resolved engagement and answer with
    // the shared 202 shape. Both the existing-engagement branch and the
    // fresh-rescreen branch below funnel through this so the arm status matrix,
    // the audit call and the response contract stay identical. The new
    // `test_gate_appointment_not_due` refusal (a `scheduled` engagement whose
    // slot is not currently due, 0081) is mapped exactly like the other gate
    // refusals: a 409 carrying its status, mirroring `phone_test_gate_refused`.
    const armGate = async (
      engagementId: string,
      cycleNumber: unknown,
    ): Promise<boolean> => {
      const { data: gate, error: gateError } = await supabase.rpc('arm_phone_test_gate', {
        p_candidate_id: candidateId,
        p_engagement_id: engagementId,
        p_actor_id: actorId,
        p_request_id: requestId,
        p_expires_at: expiresAt.toISOString(),
        p_now: now.toISOString(),
      });
      if (gateError) {
        res.status(503).json({ ok: false, error: 'phone_test_gate_unavailable' });
        return true;
      }
      const status = rpcStatus(gate);
      if (status !== 'ok' && status !== 'already_armed') {
        res.status(409).json({ ok: false, error: 'phone_test_gate_refused', status });
        return true;
      }
      await recordAudit(req, 'resource.update', 202, {
        metadata: { resource: 'phone_test_gate', outcome: status },
      });
      res.status(202).json({
        ok: true,
        status: 'armed',
        engagement_id: engagementId,
        cycle_number: typeof cycleNumber === 'number' ? cycleNumber : null,
      });
      return true;
    };

    try {
      // Owner-test the EXISTING engagement when one is live. Minting a fresh
      // rescreen cycle refuses with `active_cycle` whenever the candidate
      // already has a non-terminal cycle (e.g. a `scheduled` due appointment),
      // which is exactly the legitimate owner-test case.
      //
      // SECURITY: this gate is a bypass of the global operator pause, so the
      // engagement it arms MUST be unambiguous. A candidate can hold MULTIPLE
      // non-terminal engagements — `cycle_number` is unique only PER
      // application_link (0057 uq_phone_engagements_application_cycle), and a
      // candidate can have several ashby_application_links — so an
      // order-by-cycle_number-limit-1 could arm the pause-bypass on the WRONG
      // application's engagement. We therefore fetch ALL non-terminal
      // engagements and FAIL CLOSED on ambiguity:
      //   * 0 non-terminal          -> fresh rescreen->arm path (below).
      //   * exactly 1, armable       -> arm THAT engagement in place.
      //   * exactly 1, non-armable   -> 409, never fall through to rescreen.
      //   * more than 1              -> 409, never guess which one.
      const { data: liveRows, error: existingError } = await supabase
        .from('phone_engagements')
        .select('id,state,application_link_id,cycle_number')
        .eq('candidate_id', candidateId)
        .is('terminal_at', null);
      if (existingError) {
        res.status(503).json({ ok: false, error: 'phone_test_gate_unavailable' });
        return;
      }
      const nonTerminal = (Array.isArray(liveRows) ? liveRows : []) as Array<{
        id?: unknown; state?: unknown; application_link_id?: unknown; cycle_number?: unknown;
      }>;

      if (nonTerminal.length > 1) {
        // Ambiguous: an owner test must never arm a pause-bypass on a guessed
        // engagement. Report the count and states, not identifiers.
        res.status(409).json({
          ok: false,
          error: 'phone_test_gate_ambiguous_engagement',
          count: nonTerminal.length,
          states: nonTerminal.map((r) => (typeof r.state === 'string' ? r.state : 'unknown')),
        });
        return;
      }

      if (nonTerminal.length === 1) {
        const only = nonTerminal[0];
        const onlyId = typeof only.id === 'string' ? only.id : null;
        const onlyState = typeof only.state === 'string' ? only.state : null;
        if (!onlyId) {
          res.status(503).json({ ok: false, error: 'phone_test_gate_unavailable' });
          return;
        }
        // `eligible` and `scheduled` are the only gate-armable non-terminal
        // states (0081). Any other live state (dialing, in_call, reconnecting,
        // awaiting_retry, pending_prereqs, …) is not an owner-test target, and
        // we refuse rather than minting a SECOND cycle for the same live
        // engagement (which would re-trigger the very `active_cycle` bug this
        // route fixes).
        if (onlyState === 'eligible' || onlyState === 'scheduled') {
          await armGate(onlyId, only.cycle_number);
          return;
        }
        res.status(409).json({
          ok: false,
          error: 'phone_test_gate_engagement_not_armable',
          state: onlyState ?? 'unknown',
        });
        return;
      }

      // Zero non-terminal engagements: a genuinely fresh candidate. Keep the
      // original rescreen->arm path unchanged.
      const { data: rescreen, error: rescreenError } = await supabase.rpc('request_phone_rescreen', {
        p_candidate_id: candidateId,
        p_reason: 'technical_issue',
        p_request_id: requestId,
        p_source: 'hr_manual',
        p_actor_id: actorId,
        p_now: now.toISOString(),
      });
      if (rescreenError) {
        res.status(503).json({ ok: false, error: 'phone_test_gate_unavailable' });
        return;
      }
      const rescreenStatus = rpcStatus(rescreen);
      if (rescreenStatus !== 'ok' && rescreenStatus !== 'already_requested') {
        res.status(409).json({ ok: false, error: 'phone_rescreen_refused', status: rescreenStatus });
        return;
      }
      const engagementId = rescreen && typeof rescreen === 'object' && 'engagement_id' in rescreen
        ? (rescreen as { engagement_id?: unknown }).engagement_id : undefined;
      if (typeof engagementId !== 'string') {
        res.status(503).json({ ok: false, error: 'phone_test_gate_unavailable' });
        return;
      }
      await armGate(
        engagementId,
        rescreen && typeof rescreen === 'object' && 'cycle_number' in rescreen
          ? (rescreen as { cycle_number?: unknown }).cycle_number : null,
      );
    } catch {
      res.status(503).json({ ok: false, error: 'phone_test_gate_unavailable' });
    }
  },
);

// A wrong-number cycle may be resumed only after an administrator verifies a
// replacement number. The value is sent to the SQL boundary and never echoed,
// logged or placed in an audit payload.
candidatesRouter.post(
  '/:id/phone-number-verification',
  requireRole('admin'),
  validateParams(candidateIdParamSchema),
  validateBody(phoneVerificationBodySchema),
  async (req, res) => {
    if (process.env.PHONE_SCREENING_ENABLED !== 'true') {
      res.status(503).json({ ok: false, error: 'phone_screening_disabled' });
      return;
    }
    const body = req.body as { phone_e164: string };
    try {
      const { data, error } = await supabase.rpc('verify_candidate_phone', {
        p_candidate_id: req.params.id,
        p_phone_e164: body.phone_e164,
        p_actor_id: req.authUser?.id ?? null,
        p_now: new Date().toISOString(),
      });
      if (error) {
        res.status(503).json({ ok: false, error: 'phone_verification_unavailable' });
        return;
      }
      const status = data && typeof data === 'object' && 'status' in data
        ? String((data as { status?: unknown }).status)
        : 'unknown_status';
      if (status === 'ok') {
        res.json({ ok: true });
        return;
      }
      res.status(status === 'candidate_not_found' ? 404 : 409).json({
        ok: false,
        error: 'phone_verification_refused',
        status,
      });
    } catch {
      res.status(503).json({ ok: false, error: 'phone_verification_unavailable' });
    }
  },
);

// Candidate detail incl. latest assessment + session list — viewer and above.
// Interviewer sees only own records; admin sees all.
candidatesRouter.get('/:id', requireRole('viewer'), validateParams(candidateIdParamSchema), async (req, res) => {
  let q = supabase
    .from('candidates')
    .select('*')
    .eq('id', req.params.id);

  if (req.authUser?.appRole === 'interviewer') {
    q = q.eq('owner_id', req.authUser.id);
  }

  const { data: candidate, error } = await q.single();
  if (error) return res.status(404).json({ error: 'Candidate not found' });

  const { data: sessions } = await supabase
    .from('call_sessions')
    .select('*')
    .eq('candidate_id', req.params.id)
    .order('started_at', { ascending: false });

  const { data: assessments } = await supabase
    .from('assessments')
    .select('*')
    .eq('candidate_id', req.params.id)
    .order('created_at', { ascending: false });

  // `select('*')` returns `phone_raw`, `phone_e164` AND the `parsed` blob, all
  // three of which carry the same number. One helper covers all three so a
  // future column cannot be redacted in one route and forgotten in another.
  res.json({
    candidate: redactCandidatePhone(candidate as Record<string, unknown>, req.authUser?.appRole),
    sessions: sessions ?? [],
    assessments: assessments ?? [],
  });
});
