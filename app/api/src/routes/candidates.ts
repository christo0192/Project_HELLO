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

  const enriched = rows.map((row) => {
    // Strip the internal block field; it drives suppression only.
    const { decision_use_blocked_at, ...pub } = row;
    const blocked = decision_use_blocked_at != null;
    const la = latest.get(row.id);
    return {
      ...pub,
      latest_recommendation: blocked ? null : la?.recommendation ?? null,
      latest_score: blocked ? null : la?.overall_score ?? null,
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
