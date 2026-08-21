import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { validateQuery, validateParams } from '../lib/validation.js';
import { listCandidatesQuerySchema, candidateIdParamSchema } from '../schemas/candidates.js';
import { requireRole } from '../lib/rbac.js';
import { recordAudit } from '../lib/audit.js';

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

  const enriched = rows.map((row) => {
    // Strip the internal block field; it drives suppression only.
    const { decision_use_blocked_at, ...pub } = row;
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

  res.json({ candidate, sessions: sessions ?? [], assessments: assessments ?? [] });
});
