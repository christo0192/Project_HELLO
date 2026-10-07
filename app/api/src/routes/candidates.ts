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
  candidatePhoneAttemptsQuerySchema,
} from '../schemas/candidates.js';
import { phoneAppointmentCancelSchema } from '../schemas/phone-api.js';
import { idParamSchema, uuidSchema } from '../schemas/common.js';
import { requireRole } from '../lib/rbac.js';
import { recordAudit } from '../lib/audit.js';
import { redactCandidatePhone } from '../lib/candidate-phone.js';
import { loadCandidatePhoneProgress, phoneProgressFields } from '../lib/candidate-phone-progress.js';
import { attemptConsentStage, loadLegConsentFacts, NO_LEG_CONSENT_FACTS } from '../lib/attempt-consent-stage.js';
import {
  attemptLegTiming,
  sessionRecordedFacts,
  withoutRecordingFacts,
  type AttemptLegTiming,
  type AttemptLegTimingRow,
  type SessionRecordedFacts,
} from '../lib/attempt-leg-timing.js';
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

// 0114 (C6): request_phone_rescreen's `prerequisite_status` (the status
// ensure_ashby_phone_engagement returned for the child). A stable code, never
// PII. null when absent or not a string: a replay that evaluated nothing, or a
// database that predates 0114.
function prerequisiteStatus(data: unknown): string | null {
  const v = data && typeof data === 'object'
    ? (data as { prerequisite_status?: unknown }).prerequisite_status
    : undefined;
  return typeof v === 'string' ? v : null;
}

// The ensure statuses that leave a child gate-armable (0081 arms only
// `eligible` or a due `scheduled` engagement).
const TEST_GATE_ARMABLE_PREREQUISITES: ReadonlySet<string> = new Set([
  'eligible',
  'scheduled_next_window',
]);

// 0114 (C8). This route module deliberately does not import the phone screening
// package (a structural boundary), so the two §6 vocabularies it acts on are
// restated here and pinned to the domain rpc-contract module
// (`PHONE_DUPLICATE_APPLICATION_STATUS`, `RELEASE_PHONE_IDENTITY_HOLD_STATUSES`)
// and to the 0114 bodies by phone-0114-identity-api.test.ts.
const PHONE_DUPLICATE_APPLICATION_STATUS = 'duplicate_application';
const RELEASE_PHONE_IDENTITY_HOLD_STATUSES: readonly string[] = [
  'ok', 'actor_required', 'invalid_request', 'not_found', 'not_held',
];

const PHONE_ATTEMPT_HISTORY_MAX = 50;

type AttemptHistoryCursor = { admitted_at: string; id: string };

function encodeAttemptHistoryCursor(cursor: AttemptHistoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeAttemptHistoryCursor(value: string | undefined): AttemptHistoryCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<AttemptHistoryCursor>;
    if (typeof parsed.admitted_at !== 'string') return null;
    const admittedAt = new Date(parsed.admitted_at);
    // Cursors are produced by this route. Requiring the canonical UTC form
    // prevents Date.parse-accepted text from being interpolated into a
    // PostgREST filter as raw syntax.
    if (!Number.isFinite(admittedAt.getTime()) || admittedAt.toISOString() !== parsed.admitted_at) return null;
    if (typeof parsed.id !== 'string' || !uuidSchema.safeParse(parsed.id).success) return null;
    return { admitted_at: admittedAt.toISOString(), id: parsed.id };
  } catch {
    return null;
  }
}

/**
 * The attempt columns the per-leg timing reads (0125). Selected by the history
 * and by the candidate detail's session roll-up so both state the same facts.
 * `egress_id` only tells a worker recording apart, and `lease_expires_at` only
 * whether a completed session's end bounds a later-reclaimed leg; neither is
 * ever returned.
 */
const ATTEMPT_LEG_TIMING_COLUMNS =
  'observed_ended_at,recording_started_at_ms,recording_duration_ms,recording_tail_flushed,egress_id,lease_expires_at';

/**
 * At most this many legs are read for one candidate's session roll-up. A read
 * that returns more may be truncated, so the roll-up is reported as unknown
 * (null) rather than a confident short total.
 */
const SESSION_LEG_READ_CAP = 500;

const NULL_SESSION_RECORDED_FACTS: SessionRecordedFacts = Object.freeze({
  recorded_total_sec: null,
  recorded_legs: null,
  recorded_unknown_legs: null,
  connected_complete: null,
  connected_total_sec: null,
  connected_unobserved_legs: null,
  connected_detected_legs: null,
  connected_open_legs: null,
});

/**
 * M013 S02 (T07): the per-session header facts, from the session's phone legs
 * (`session_id` or `recording_session_id` = the session). ONE bounded read for
 * every session of the candidate, plus the legs' ledger facts (a reconciler-
 * detected end is not an exact end) and the sessions' recording lifecycle.
 * A leg whose audio was erased, revoked, quarantined or latched failed adds
 * nothing to the recorded total (review, S02): the header must never count
 * audio the Review tab cannot play. Never rejects: a failed or possibly
 * truncated read returns null, and every session then reports the facts as
 * unknown rather than a confident short total. A session with no legs (a
 * browser session) gets all-null facts.
 */
async function loadSessionRecordedFacts(sessionIds: readonly string[]): Promise<Map<string, SessionRecordedFacts> | null> {
  const ids = sessionIds.filter((id) => uuidSchema.safeParse(id).success);
  const facts = new Map<string, SessionRecordedFacts>();
  if (ids.length === 0) return facts;
  try {
    const list = ids.join(',');
    const { data, error } = await supabase
      .from('phone_call_attempts')
      .select(`id,session_id,recording_session_id,admitted_at,answered_at,ended_at,state,abandon_reason,outcome_class,recording_object_key,recording_ready,recording_size_bytes,recording_content_type,recording_quarantined,recording_deleted_at,egress_status,${ATTEMPT_LEG_TIMING_COLUMNS}`)
      .or(`session_id.in.(${list}),recording_session_id.in.(${list})`)
      .order('admitted_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(SESSION_LEG_READ_CAP + 1);
    if (error || !Array.isArray(data) || data.length > SESSION_LEG_READ_CAP) return null;
    const rows = data as Array<AttemptLegTimingRow & {
      id?: string;
      session_id?: string | null;
      recording_session_id?: string | null;
      recording_quarantined?: boolean | null;
      recording_deleted_at?: string | null;
    }>;
    const legFacts = await loadLegConsentFacts(
      rows.map((raw) => raw.id).filter((id): id is string => typeof id === 'string'),
    );
    if (!legFacts) return null;
    // The sessions' recording lifecycle: erased, revoked or quarantined audio
    // is not counted. A failed read is unknown, never a confident total.
    const blockedSessions = new Set<string>();
    // A completed session's end bounds its legs (0125 §3a): every leg end is
    // capped at it, a leg answered after it is left out, and a leg the reclaim
    // ended only after it counts up to it when the worker completed the
    // session (see attempt-leg-timing.ts for the one stricter case).
    const completedSessionEnd = new Map<string, string>();
    const lifecycle = await supabase
      .from('call_sessions')
      .select('id,status,ended_at,recording_revoked_at,recording_quarantined,recording_deleted_at')
      .in('id', ids)
      .limit(ids.length);
    if (lifecycle.error) return null;
    for (const raw of (Array.isArray(lifecycle.data) ? lifecycle.data : []) as Array<Record<string, unknown>>) {
      if (typeof raw.id !== 'string') continue;
      if (typeof raw.recording_revoked_at === 'string'
        || typeof raw.recording_deleted_at === 'string'
        || raw.recording_quarantined === true) {
        blockedSessions.add(raw.id);
      }
      if (raw.status === 'completed' && typeof raw.ended_at === 'string') {
        completedSessionEnd.set(raw.id, raw.ended_at);
      }
    }
    const legsBySession = new Map<string, AttemptLegTiming[]>();
    for (const raw of rows) {
      const ref = raw.session_id ?? raw.recording_session_id;
      if (typeof ref !== 'string') continue;
      const legs = legsBySession.get(ref) ?? [];
      const timing = attemptLegTiming({
        ...raw,
        end_detected_by_sweep: typeof raw.id === 'string' && legFacts.get(raw.id)?.endDetectedBySweep === true,
        session_ended_at: completedSessionEnd.get(ref) ?? null,
      });
      const audioWithheld = blockedSessions.has(ref)
        || raw.recording_quarantined === true
        || typeof raw.recording_deleted_at === 'string';
      legs.push(audioWithheld ? withoutRecordingFacts(timing) : timing);
      legsBySession.set(ref, legs);
    }
    for (const id of ids) facts.set(id, sessionRecordedFacts(legsBySession.get(id) ?? []));
    return facts;
  } catch {
    return null;
  }
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
  const loadResumeReview = async (): Promise<void> => {
    if (ids.length === 0) return;
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
  };

  // Phone progress (dial count, latest engagement state, allowlisted reason,
  // last dial), alongside the links read. One query per 100 ids, over the
  // SAME authorized candidate set, so interviewer owner-scoping is inherited.
  // It never rejects: a failed or possibly-truncated read reports
  // `dial_count: null` (unknown), never a confident 0. Not read at all while
  // PHONE_SCREENING_ENABLED is off, like every other phone route.
  const [, phoneProgress] = await Promise.all([loadResumeReview(), loadCandidatePhoneProgress(ids)]);

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
      // dial_count / phone_state / phone_state_reason / last_dialed_at.
      // null dial_count = unknown; 0 = never dialled. The reason is
      // interviewer+ only (same floor as /:id/phone-cycles).
      ...phoneProgressFields(phoneProgress, row.id, role),
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
      // 0114 (C8): the same person already has a live or completed screen for
      // this role on another candidate row, so ensure HELD this engagement in
      // pending_prereqs. A distinct error code (not phone_request_refused) so
      // the client can offer the release action; the other row is never named.
      if (status === PHONE_DUPLICATE_APPLICATION_STATUS) {
        res.status(409).json({ ok: false, error: PHONE_DUPLICATE_APPLICATION_STATUS, status });
        return;
      }
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

/**
 * Candidate-scoped phone attempt history. This is a separate read boundary
 * from the legacy candidate detail payload: explicit columns prevent lease,
 * provider, phone and storage metadata from crossing into the UI.
 */
candidatesRouter.get(
  '/:id/phone-attempts',
  requireRole('viewer'),
  validateParams(candidateIdParamSchema),
  validateQuery(candidatePhoneAttemptsQuerySchema),
  async (req, res) => {
    const user = req.authUser;
    const candidateId = req.params.id;
    if (!user || !(await candidateVisibleToRecruiter(candidateId, user))) {
      return res.status(404).json({ error: 'Candidate not found' });
    }
    const query = req.query as unknown as { limit: number; before?: string; session_id?: string };
    const limit = Math.min(Math.max(Number(query.limit) || 25, 1), PHONE_ATTEMPT_HISTORY_MAX);
    const cursor = decodeAttemptHistoryCursor(query.before);
    if (query.before && !cursor) {
      return res.status(400).json({ error: 'Invalid attempt history cursor' });
    }
    // M013 S02 (T07): the legs of ONE session, oldest first ("Call 1 of 2").
    // Validated as a uuid by the query schema; re-checked here because it is
    // interpolated into a PostgREST filter. The candidate scope below still
    // applies, so another candidate's session lists nothing.
    const sessionFilter = typeof query.session_id === 'string' && uuidSchema.safeParse(query.session_id).success
      ? query.session_id
      : null;
    if (query.session_id !== undefined && !sessionFilter) {
      return res.status(400).json({ error: 'Invalid session filter' });
    }
    const ascending = sessionFilter !== null;

    try {
      // Fetch engagement ids in stable pages. A candidate can have more than
      // the PostgREST default page size after rescreen cycles; truncating at
      // 500 silently dropped older attempt legs from the history.
      const engagementIds: string[] = [];
      for (let offset = 0; ; offset += 500) {
        const { data: engagements, error: engagementError } = await supabase
          .from('phone_engagements')
          .select('id')
          .eq('candidate_id', candidateId)
          .order('id', { ascending: true })
          .range(offset, offset + 499);
        if (engagementError) return res.status(503).json({ error: 'Phone attempt history unavailable' });
        const page = (engagements ?? [])
          .map((row) => (row as { id?: unknown }).id)
          .filter((id): id is string => typeof id === 'string');
        engagementIds.push(...page);
        if (page.length < 500) break;
      }
      if (engagementIds.length === 0) return res.json({ attempts: [], next_cursor: null });

      let attemptQuery = supabase
        .from('phone_call_attempts')
        .select(`id,attempt_seq,admitted_at,answered_at,ended_at,state,abandon_reason,outcome_class,session_id,recording_session_id,recording_object_key,recording_sha256,recording_size_bytes,recording_content_type,recording_ready,recording_quarantined,recording_deleted_at,egress_status,${ATTEMPT_LEG_TIMING_COLUMNS}`)
        .in('engagement_id', engagementIds)
        .order('admitted_at', { ascending })
        .order('id', { ascending })
        .limit(limit + 1);
      // ONE `or` filter: the keyset cursor (direction follows the order) and
      // the session filter are combined into a single logic tree rather than
      // two `or` parameters.
      const op = ascending ? 'gt' : 'lt';
      const cursorFilter = cursor
        ? `admitted_at.${op}.${cursor.admitted_at},and(admitted_at.eq.${cursor.admitted_at},id.${op}.${cursor.id})`
        : null;
      const sessionFilterTree = sessionFilter
        ? `session_id.eq.${sessionFilter},recording_session_id.eq.${sessionFilter}`
        : null;
      if (cursorFilter && sessionFilterTree) {
        attemptQuery = attemptQuery.or(`and(or(${sessionFilterTree}),or(${cursorFilter}))`);
      } else if (cursorFilter ?? sessionFilterTree) {
        attemptQuery = attemptQuery.or((cursorFilter ?? sessionFilterTree) as string);
      }
      const { data: rows, error: attemptError } = await attemptQuery;
      if (attemptError) return res.status(503).json({ error: 'Phone attempt history unavailable' });
      const allRows = (rows ?? []) as Array<AttemptLegTimingRow & {
        id: string;
        attempt_seq: number;
        admitted_at: string;
        answered_at: string | null;
        ended_at: string | null;
        state: string;
        abandon_reason?: string | null;
        outcome_class: string | null;
        session_id: string | null;
        recording_session_id: string | null;
        recording_object_key: string | null;
        recording_sha256: string | null;
        recording_size_bytes: number | null;
        recording_content_type: string | null;
        recording_ready: boolean;
        recording_quarantined: boolean;
        recording_deleted_at: string | null;
        egress_status: string | null;
      }>;
      const hasNext = allRows.length > limit;
      const shown = hasNext ? allRows.slice(0, limit) : allRows;

      // D8: what each leg's own ledger facts say (opt-out / in-call deferral
      // / booked callback on a CONSENTED leg; a reconciler-detected end on
      // any leg). ONE batched read for the page, keyed by attempt id — never
      // one query per row, never the engagement's state. The download audit
      // loads the same facts through the same helper.
      const legConsentFacts = await loadLegConsentFacts(shown.map((row) => row.id));
      if (!legConsentFacts) return res.status(503).json({ error: 'Phone attempt history unavailable' });
      const sessionIds = [...new Set(shown.map((row) => row.session_id ?? row.recording_session_id).filter((id): id is string => !!id))];
      const sessionLifecycle = new Map<string, {
        ownerId: string | null;
        status: string | null;
        endedAt: string | null;
        revokedAt: string | null;
        quarantined: boolean;
        deletedAt: string | null;
      }>();
      if (sessionIds.length > 0) {
        const { data: sessionRows, error: sessionError } = await supabase
          .from('call_sessions')
          .select('id,owner_id,status,ended_at,recording_revoked_at,recording_quarantined,recording_deleted_at')
          .in('id', sessionIds)
          .limit(sessionIds.length);
        if (sessionError) return res.status(503).json({ error: 'Phone attempt history unavailable' });
        for (const session of sessionRows ?? []) {
          const row = session as {
            id?: unknown;
            owner_id?: unknown;
            status?: unknown;
            ended_at?: unknown;
            recording_revoked_at?: unknown;
            recording_quarantined?: unknown;
            recording_deleted_at?: unknown;
          };
          if (typeof row.id === 'string') {
            sessionLifecycle.set(row.id, {
              ownerId: typeof row.owner_id === 'string' ? row.owner_id : null,
              status: typeof row.status === 'string' ? row.status : null,
              endedAt: typeof row.ended_at === 'string' ? row.ended_at : null,
              revokedAt: typeof row.recording_revoked_at === 'string' ? row.recording_revoked_at : null,
              quarantined: row.recording_quarantined === true,
              deletedAt: typeof row.recording_deleted_at === 'string' ? row.recording_deleted_at : null,
            });
          }
        }
      }

      // The existing transcript route is deliberately admin-only. Only admins
      // receive a link that the current route can actually open; other roles
      // still get the complete attempt history without a false link.
      const transcriptKind = new Map<string, 'none' | 'gate_only' | 'session'>();
      if (user.appRole === 'admin' && sessionIds.length > 0) {
        const sawTurn = new Set<string>();
        const sawInterviewTurn = new Set<string>();
        // The classification only needs one row of each kind. Per-session
        // bounded probes avoid a 1,000-row cap misclassifying a long session
        // when its interview turns occur after its gate turns.
        const transcriptProbes = await Promise.all(sessionIds.map(async (sessionId) => {
          const [anyTurns, interviewTurns] = await Promise.all([
            supabase.from('transcript_turns').select('session_id').eq('session_id', sessionId).limit(1),
            supabase.from('transcript_turns').select('session_id').eq('session_id', sessionId).eq('is_gate', false).limit(1),
          ]);
          return { sessionId, anyTurns, interviewTurns };
        }));
        for (const probe of transcriptProbes) {
          if (probe.anyTurns.error || probe.interviewTurns.error) {
            return res.status(503).json({ error: 'Phone attempt history unavailable' });
          }
          if ((probe.anyTurns.data ?? []).length > 0) sawTurn.add(probe.sessionId);
          if ((probe.interviewTurns.data ?? []).length > 0) sawInterviewTurn.add(probe.sessionId);
        }
        for (const sessionId of sessionIds) {
          transcriptKind.set(
            sessionId,
            !sawTurn.has(sessionId) ? 'none' : sawInterviewTurn.has(sessionId) ? 'session' : 'gate_only',
          );
        }
      }

      return res.json({
        attempts: shown.map((row) => {
          const evidenceSessionId = row.session_id ?? row.recording_session_id;
          const kind = evidenceSessionId ? (transcriptKind.get(evidenceSessionId) ?? 'none') : 'none';
          const parent = evidenceSessionId ? sessionLifecycle.get(evidenceSessionId) : undefined;
          const interviewerCanReadSession = user.appRole !== 'interviewer'
            || (parent !== undefined && parent.ownerId === user.id);
          const parentLifecycleBlocked = parent === undefined
            || Boolean(parent.revokedAt || parent.deletedAt || parent.quarantined);
          const recordingState = !interviewerCanReadSession || parentLifecycleBlocked || row.recording_quarantined || row.recording_deleted_at || row.egress_status === 'failed'
            ? 'unavailable'
            : row.recording_ready && row.recording_object_key && row.recording_sha256
                && row.recording_size_bytes && row.recording_content_type
              ? 'ready'
              : row.recording_object_key
                ? 'processing'
                : 'unavailable';
          // M013 S02 (T07): the leg's connected window and recording facts.
          // The recording facts follow the `recording.reason` rule: a caller
          // who may not read the session learns nothing about its audio.
          // A reconciler-detected end is the sweep's detection time (`detected`),
          // not an exact end. A leg whose audio cannot be played (erased,
          // revoked, quarantined, failed, or not yet uploaded) states no
          // recorded length or tail note, as the Overview list does.
          // A completed session's end bounds the leg (0125 §3a): its end is
          // capped there, and a leg the reclaim ended only after it counts up
          // to it when the worker completed the session.
          const timing: AttemptLegTiming = attemptLegTiming({
            ...row,
            end_detected_by_sweep: legConsentFacts.get(row.id)?.endDetectedBySweep === true,
            session_ended_at: parent?.status === 'completed' ? parent.endedAt : null,
          });
          const recordingFacts = interviewerCanReadSession && recordingState !== 'unavailable'
            ? {
                recorded_sec: timing.recorded_sec,
                recorded_sec_estimated: timing.recorded_sec_estimated,
                recording_started_at_ms: timing.recording_started_at_ms,
                tail_may_be_missing: timing.tail_may_be_missing,
              }
            : {
                recorded_sec: null,
                recorded_sec_estimated: false,
                recording_started_at_ms: null,
                tail_may_be_missing: false,
              };
          return {
            id: row.id,
            attempt_seq: row.attempt_seq,
            admitted_at: row.admitted_at,
            answered_at: row.answered_at,
            ended_at: row.ended_at,
            state: row.state,
            // Why an `abandoned` attempt was abandoned (0083). Only
            // 'infra_deferred' (never placed: no carrier contacted) is a
            // member of the CHECK; NULL on an abandoned row means the lease
            // was reclaimed mid-call. Projected through that one-value
            // allowlist so nothing else can ever be echoed.
            abandon_reason: row.abandon_reason === 'infra_deferred' ? 'infra_deferred' : null,
            outcome_class: row.outcome_class,
            // Kept for existing clients, and now the SAME figure as
            // `connected_sec`: the observed end is preferred, and a leg ended
            // only by the lease reclaim has no length (null), never the
            // minutes between the hang-up and the sweep.
            duration_sec: timing.connected_sec,
            connected_from: timing.connected_from,
            connected_to: timing.connected_to,
            connected_to_source: timing.connected_to_source,
            connected_sec: timing.connected_sec,
            ...recordingFacts,
            // The session this leg belongs to: the consent binding, else the
            // evidence-only binding (0107). Reconnect legs share it.
            session_ref: evidenceSessionId ?? null,
            recording: {
              state: recordingState,
              // access_unavailable first: a caller who may not read the
              // session learns nothing about its recording's lifecycle.
              reason: !interviewerCanReadSession
                ? 'access_unavailable'
                : row.recording_deleted_at || parent?.deletedAt
                  ? 'deleted'
                  // Consent to the recording was withdrawn on the parent: the
                  // audio may still exist, but it is not "no recording".
                  : parent?.revokedAt
                    ? 'revoked'
                  : row.recording_quarantined || parent?.quarantined
                    ? 'quarantined'
                    : row.egress_status === 'failed'
                      ? 'recording_failed'
                      : recordingState === 'unavailable' ? 'no_recording' : undefined,
            },
            // Same rule as `recording.reason`: a caller who may not read the
            // session learns nothing about how its audio was captured.
            consent_stage: interviewerCanReadSession
              ? attemptConsentStage(
                  row,
                  evidenceSessionId ? (parent ? parent.status : undefined) : undefined,
                  row.session_id ? (legConsentFacts.get(row.id) ?? NO_LEG_CONSENT_FACTS) : null,
                )
              : null,
            transcript: user.appRole === 'admin' && evidenceSessionId && kind !== 'none'
              ? {
                  href: `/sessions/${evidenceSessionId}`,
                  scope: 'session',
                  kind: kind === 'gate_only' ? 'gate_only' : 'session',
                  // This link is to the reusable SESSION transcript, never an
                  // exact attempt transcript. The warning stays true even if
                  // pagination happens to show only one leg for this session.
                  shared_session: true,
                }
              : null,
          };
        }),
        next_cursor: hasNext
          ? encodeAttemptHistoryCursor({ admitted_at: shown[shown.length - 1].admitted_at, id: shown[shown.length - 1].id })
          : null,
      });
    } catch {
      return res.status(503).json({ error: 'Phone attempt history unavailable' });
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
      // 0114 (C8): schedule_candidate_phone_appointment books nothing for a
      // same-role duplicate application held in pending_prereqs. Named
      // explicitly (it would also fall through below) because the web client
      // keys its release action on this exact code.
      if (status === PHONE_DUPLICATE_APPLICATION_STATUS) {
        res.status(409).json({ ok: false, error: PHONE_DUPLICATE_APPLICATION_STATUS });
        return;
      }
      res.status(409).json({ ok: false, error: status === 'unknown_status' ? 'phone_rpc_unknown_status' : status });
    } catch {
      res.status(503).json({ ok: false, error: 'phone_schedule_unavailable' });
    }
  },
);

// 0114 (C8-C). Release a same-role duplicate-application hold. The same authz
// as the manual phone request (interviewer, owner-scoped; admin unrestricted),
// because releasing the hold is what lets that request's engagement proceed.
// The engagement is resolved SERVER-SIDE from the candidate: the browser never
// names one. A candidate row is one application, so normally exactly one held
// engagement exists; more than one is refused rather than guessed. The SQL
// re-checks the hold under the link and engagement locks, records the
// release, writes its own `phone_identity_hold_release` audit row, and re-runs
// the prerequisite evaluator. It never creates an attempt or a queue job — the
// due pass and admit_phone_attempt remain the only dial path.
candidatesRouter.post(
  '/:id/phone/release-duplicate-hold',
  requireRole('interviewer'),
  validateParams(candidateIdParamSchema),
  validateBody(manualPhoneCallBodySchema),
  async (req, res) => {
    if (process.env.PHONE_SCREENING_ENABLED !== 'true') {
      res.status(503).json({ ok: false, error: 'phone_screening_disabled' });
      return;
    }
    const actorId = req.authUser?.id;
    if (!actorId) {
      res.status(403).json({ ok: false, error: 'actor_required' });
      return;
    }
    if (!(await candidateVisibleToRecruiter(req.params.id, req.authUser))) {
      res.status(404).json({ ok: false, error: 'candidate_not_found' });
      return;
    }
    try {
      const { data: rows, error: readError } = await supabase
        .from('phone_engagements')
        .select('id')
        .eq('candidate_id', req.params.id)
        .eq('state', 'pending_prereqs')
        .eq('state_reason', PHONE_DUPLICATE_APPLICATION_STATUS)
        .is('terminal_at', null)
        .limit(2);
      if (readError) {
        res.status(503).json({ ok: false, error: 'phone_release_unavailable' });
        return;
      }
      const held = (Array.isArray(rows) ? rows : [])
        .map((row) => (row as { id?: unknown }).id)
        .filter((id): id is string => typeof id === 'string');
      if (held.length === 0) {
        res.status(409).json({ ok: false, error: 'phone_hold_not_held' });
        return;
      }
      if (held.length > 1) {
        res.status(409).json({ ok: false, error: 'phone_hold_ambiguous' });
        return;
      }

      const { data, error } = await supabase.rpc('release_phone_identity_hold', {
        p_engagement_id: held[0],
        p_actor_id: actorId,
        p_now: new Date().toISOString(),
      });
      if (error) {
        res.status(503).json({ ok: false, error: 'phone_release_unavailable' });
        return;
      }
      const raw = rpcStatus(data);
      const status = RELEASE_PHONE_IDENTITY_HOLD_STATUSES.includes(raw)
        ? raw : 'unknown_status';
      await recordAudit(req, 'resource.update', status === 'ok' ? 200 : 409, {
        metadata: { resource: 'phone_identity_hold', outcome: status },
      });
      if (status === 'ok') {
        res.json({
          ok: true,
          status: 'released',
          engagement_id: held[0],
          // What the prerequisite evaluator said once the hold was lifted
          // (eligible, scheduled_next_window, or a stable pending reason).
          prerequisite_status: prerequisiteStatus(data),
        });
        return;
      }
      if (status === 'not_held') {
        // Lost a race: another operator released it, or it moved on.
        res.status(409).json({ ok: false, error: 'phone_hold_not_held' });
        return;
      }
      if (status === 'not_found') {
        res.status(404).json({ ok: false, error: 'phone_hold_not_found' });
        return;
      }
      if (status === 'actor_required') {
        res.status(403).json({ ok: false, error: 'actor_required' });
        return;
      }
      res.status(500).json({ ok: false, error: 'phone_rpc_unknown_status' });
    } catch {
      res.status(503).json({ ok: false, error: 'phone_release_unavailable' });
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
          // 0114 (C6): what the prerequisite evaluator said about the new
          // cycle (eligible, scheduled_next_window, or a stable reason it is
          // still pending). null on a replay that evaluated nothing.
          prerequisite_status: prerequisiteStatus(data),
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
      const cycleNumber = rescreen && typeof rescreen === 'object' && 'cycle_number' in rescreen
        ? (rescreen as { cycle_number?: unknown }).cycle_number : null;
      // 0114 (C6): request_phone_rescreen now runs the prerequisite evaluator
      // and reports its verdict. Only an `eligible` or `scheduled_next_window`
      // child is an owner-test target; anything else (consent, mapping,
      // ingestion, duplicate hold, ...) would only be refused by the arm as
      // not armable, so answer with the real reason and do NOT arm.
      // NOTE: the rescreen cycle is already COMMITTED at this point (the RPC
      // is its own transaction). It consumes one of the 3 cycle slots and
      // stays pending_prereqs; a retry with the same request_id replays it
      // (and self-heals it once the prerequisite is met) instead of minting
      // another. A null status (a replay that evaluated nothing, or a pre-0114
      // database) falls through to the arm, which re-checks the state itself.
      const prereq = prerequisiteStatus(rescreen);
      if (prereq !== null && !TEST_GATE_ARMABLE_PREREQUISITES.has(prereq)) {
        res.status(409).json({
          ok: false,
          error: 'phone_test_gate_prereqs_unmet',
          status: prereq,
          engagement_id: engagementId,
          cycle_number: typeof cycleNumber === 'number' ? cycleNumber : null,
        });
        return;
      }
      await armGate(engagementId, cycleNumber);
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

  // The same four phone-progress fields the list carries, from the same
  // helper, read only for the candidate just authorized above. Started now and
  // awaited at the end; it never rejects and degrades to unknown (all null).
  const candidateId = (candidate as { id?: unknown } | null)?.id;
  const authorizedId = typeof candidateId === 'string' ? candidateId : req.params.id;
  const phoneProgressPromise = loadCandidatePhoneProgress([authorizedId]);

  const { data: sessions } = await supabase
    .from('call_sessions')
    .select('*')
    .eq('candidate_id', req.params.id)
    .order('started_at', { ascending: false });

  /**
   * How many words the CANDIDATE said, per session.
   *
   * `duration_sec` is wall clock from session start to finalize
   * (agent.py:9775) — the bot's speech, the candidate's, the ring and every
   * silence. It is NOT talk time, and reading it as engagement inverts the
   * truth on exactly the calls that matter: Praveetha's 2026-09-10 screen had
   * 8 of 8 bot turns barged-in and truncated, and its wall clock reads as a
   * long healthy conversation.
   *
   * Real talk time is not derivable from what is stored. `transcript_turns`
   * DOES carry a turn-start anchor — `turn_started_at_ms`, added by 0026 and
   * used by the seekable transcript to derive `start_offset_sec` — so the
   * earlier claim here of "no audio offsets" was wrong; the conclusion
   * happened to survive its reason. What is missing is a speech-END anchor.
   * Differencing consecutive starts would charge each answer with the
   * endpointing pause that follows it (0.4-2.5s, a 50% error on a
   * five-second answer), give the final turn nothing at all, and return null
   * for every legacy row. `created_at` is worse still: the writes are batched,
   * so differencing it would look precise and be fiction. Words the candidate actually said are
   * derivable, honest, and separate a talkative candidate from a silent one.
   *
   * Counted here rather than in the client because the turns are not in this
   * payload and fetching them per session would be one round trip per call.
   */
  const sessionIds = (sessions ?? []).map((s) => (s as { id: string }).id);
  /** Candidate words per session. */
  const wordsBySession = new Map<string, number>();
  /**
   * Sessions that have ANY transcript row, whoever spoke.
   *
   * This is what separates "the candidate said nothing" from "we hold no
   * transcript for this call". Both produce zero candidate turns, and only the
   * first is a fact about the candidate — so a count is reported only for a
   * session that demonstrably has a transcript.
   */
  const transcribedSessions = new Set<string>();
  /**
   * Cleared if the turn read fails. A partial count is WORSE than no count: it
   * renders as a confident low number against a real candidate, and nothing on
   * screen would say it came from a failed read.
   */
  let wordCountsUsable = true;

  if (sessionIds.length > 0) {
    // PAGINATED, AND THE PAGE IS DELIBERATELY SMALLER THAN THE CAP.
    //
    // PostgREST truncates a response at `max_rows` and signals it in no way
    // the client can see — it simply returns fewer rows. This loop stops when
    // a page comes back short, so a PAGE equal to the cap is a trap: every
    // page would come back short, the loop would stop after the first, and the
    // count would be silently low for exactly the talkative candidates this
    // figure exists to identify. `app/supabase/config.toml` sets max_rows to
    // 1000, so 500 leaves the terminator meaningful with room for that value
    // to be halved before anyone has to think about it again.
    //
    // A hard iteration cap sits underneath: if the data ever outgrows it, the
    // count is marked unusable rather than reported short. A missing badge is
    // recoverable; a confident wrong number is not.
    const PAGE = 500;
    const MAX_PAGES = 200;
    let pages = 0;
    for (let from = 0; ; from += PAGE) {
      if (pages >= MAX_PAGES) {
        wordCountsUsable = false;
        break;
      }
      pages += 1;
      const { data: turns, error } = await supabase
        .from('transcript_turns')
        .select('session_id, speaker, text, is_gate')
        .in('session_id', sessionIds)
        // CONSENT-GATE TURNS ARE NOT THE INTERVIEW. 0067 added `is_gate` to
        // separate the identity-and-consent handshake from the screening
        // itself, and the scorer excludes it. Counting "yes" and "yes, this
        // is <name>" as words the candidate spoke put this badge on a
        // different population from every other number on the page — most
        // visibly on a call that DIED at the gate, where it would report a
        // word count for an interview that never started.
        //
        // `is not true` rather than `= false`: the column is nullable and
        // every row written before 0067 carries null.
        .not('is_gate', 'is', true)
        // Ordered on the (session_id, turn_index) index this table already
        // carries: pagination needs a TOTAL order to not skip or repeat rows,
        // and the uuid primary key would give one only by sorting every match.
        .order('session_id', { ascending: true })
        .order('turn_index', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) {
        wordCountsUsable = false;
        break;
      }
      const rows = (turns ?? []) as Array<{
        session_id: string;
        speaker: string | null;
        text: string | null;
      }>;
      for (const turn of rows) {
        transcribedSessions.add(turn.session_id);
        if (turn.speaker !== 'candidate') continue;
        const words = (turn.text ?? '').trim().split(/\s+/).filter(Boolean).length;
        wordsBySession.set(turn.session_id, (wordsBySession.get(turn.session_id) ?? 0) + words);
      }
      if (rows.length < PAGE) break;
    }
  }

  const { data: assessments } = await supabase
    .from('assessments')
    .select('*')
    .eq('candidate_id', req.params.id)
    .order('created_at', { ascending: false });

  // M013 S02 (T07): recorded / connected facts per session, from its legs.
  // These replace `duration_sec` as the header's call length: for a phone
  // session that column summed every leg up to the lease reclaim (9f60523d:
  // 443 s for 53 s + 18 s of audio).
  const recordedFacts = await loadSessionRecordedFacts(sessionIds);
  const viewerRole = req.authUser?.appRole;
  const viewerId = req.authUser?.id;

  // `select('*')` returns `phone_raw`, `phone_e164` AND the `parsed` blob, all
  // three of which carry the same number. One helper covers all three so a
  // future column cannot be redacted in one route and forgotten in another.
  const phoneProgress = await phoneProgressPromise;
  res.json({
    candidate: {
      ...redactCandidatePhone(candidate as Record<string, unknown>, req.authUser?.appRole),
      ...phoneProgressFields(phoneProgress, authorizedId, req.authUser?.appRole),
    },
    sessions: (sessions ?? []).map((session) => {
      const row = session as Record<string, unknown>;
      const id = row.id as string;
      // NULL, not 0, when the number cannot be stood behind. 0 is a claim
      // about the candidate — "they said nothing" — and is made only for a
      // session that has a transcript, read in full.
      const words =
        wordCountsUsable && transcribedSessions.has(id) ? (wordsBySession.get(id) ?? 0) : null;
      const sessionFacts = recordedFacts?.get(id) ?? NULL_SESSION_RECORDED_FACTS;
      // The recording rule of the attempt history: an interviewer who does
      // not own the session learns nothing about its audio. The connected
      // facts are call facts, like duration_sec, and stay.
      const mayReadRecording = viewerRole !== 'interviewer'
        || (typeof row.owner_id === 'string' && row.owner_id === viewerId);
      return {
        ...row,
        candidate_words: words,
        recorded_total_sec: mayReadRecording ? sessionFacts.recorded_total_sec : null,
        recorded_legs: mayReadRecording ? sessionFacts.recorded_legs : null,
        recorded_unknown_legs: mayReadRecording ? sessionFacts.recorded_unknown_legs : null,
        connected_complete: sessionFacts.connected_complete,
        connected_total_sec: sessionFacts.connected_total_sec,
        connected_unobserved_legs: sessionFacts.connected_unobserved_legs,
        connected_detected_legs: sessionFacts.connected_detected_legs,
        connected_open_legs: sessionFacts.connected_open_legs,
      };
    }),
    assessments: assessments ?? [],
  });
});
