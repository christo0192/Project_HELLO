import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { validateQuery, validateParams, validateBody } from '../lib/validation.js';
import {
  listCandidatesQuerySchema,
  candidateIdParamSchema,
  manualPhoneCallBodySchema,
  phoneRescreenBodySchema,
  phoneVerificationBodySchema,
} from '../schemas/candidates.js';
import { requireRole } from '../lib/rbac.js';
import { recordAudit } from '../lib/audit.js';
import { redactCandidatePhone } from '../lib/candidate-phone.js';
import { createLogger } from '../lib/logger.js';

const candidateLogger = createLogger('candidates');

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
            .select('engagement_id,starts_at,ends_at,status,source,version')
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
