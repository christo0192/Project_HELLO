import { supabase } from '../lib/supabase.js';
import { runClaudeJSONWithProvenance } from '../lib/claude.js';
import { env } from '../lib/env.js';
import { buildAssessmentPrompt, formatResumeFacts } from '../lib/prompts.js';
import { insertNotificationIntent } from '../lib/notification-intent.js';
import type { Assessment, TranscriptTurn } from '../lib/types.js';
import { scoringProvenance } from '../lib/model-provenance.js';

// ── Scoring eligibility ─────────────────────────────────────────────────

/**
 * VOI-08: stable error code thrown by the technical scoring preflight.
 * The only session state eligible for initial scoring is `completed` with
 * the authoritative `conversation_complete` terminal reason.
 */
export const ERR_SESSION_NOT_COMPLETED = 'ERR_SESSION_NOT_COMPLETED';

// ── Runner abstraction for testability ──────────────────────────────────

export interface AssessmentRunner {
  (sessionId: string): Promise<Assessment & { id: string }>;
}

/**
 * Default runner: connects to real Supabase and Claude CLI.
 * Override in tests via injectAssessmentRunner() to avoid network/CLI calls.
 */
let _runAssessment: AssessmentRunner = runAssessmentImpl;

export function injectAssessmentRunner(fn: AssessmentRunner | null): void {
  _runAssessment = fn ?? runAssessmentImpl;
}

/**
 * Score a completed screening session and persist the assessment.
 * Idempotent-ish: inserts a new assessment row each call.
 * Delegates to the injected runner (default: real implementation).
 * The default provenance-aware inference call uses claude.ts's single circuit
 * breaker; no nested breaker is added here. Provider failures affect that
 * breaker, while invalid JSON is a BusinessError and does not.
 */
export async function runAssessment(sessionId: string): Promise<Assessment & { id: string }> {
  return _runAssessment(sessionId);
}

// ── Real implementation ─────────────────────────────────────────────────

async function runAssessmentImpl(sessionId: string): Promise<Assessment & { id: string }> {
  const { data: session, error: sErr } = await supabase
    .from('call_sessions')
    .select('id,candidate_id,owner_id,role_id,status,terminal_reason')
    .eq('id', sessionId)
    .single();
  if (sErr || !session) throw new Error(`session not found: ${sErr?.message}`);

  // VOI-08: technical scoring eligibility — fail closed unless the session is
  // completed with the authoritative initial scoring reason. Blocks
  // failed/cancelled/expired/in_progress/created/waiting, missing/null or
  // malformed reasons, and the assessment_done repeat path.
  if (
    session.status !== 'completed' ||
    session.terminal_reason !== 'conversation_complete'
  ) {
    throw new Error(ERR_SESSION_NOT_COMPLETED);
  }

  const { data: turns } = await supabase
    .from('transcript_turns')
    .select('speaker,text')
    .eq('session_id', sessionId)
    .order('turn_index', { ascending: true });

  const transcript: TranscriptTurn[] = (turns ?? []).map((t) => ({
    speaker: t.speaker as 'bot' | 'candidate',
    text: t.text,
  }));

  let roleTitle = 'the role';
  let requiredSkills: string[] = [];
  if (session.role_id) {
    const { data: role } = await supabase
      .from('roles')
      .select('title,required_skills')
      .eq('id', session.role_id)
      .single();
    if (role) {
      roleTitle = role.title;
      requiredSkills = (role.required_skills as string[]) ?? [];
    }
  }

  const { data: candidate } = await supabase
    .from('candidates')
    .select('name,parsed')
    .eq('id', session.candidate_id)
    .single();

  // The provenance-aware call uses claude.ts's single breaker-managed runner
  // and returns the configured design-intent model for immutable provenance.
  const { data: assessment, requestedModel: scoringModel } = await runClaudeJSONWithProvenance<Assessment>(
    buildAssessmentPrompt({
      roleTitle,
      requiredSkills,
      candidateName: candidate?.name ?? null,
      transcript,
      resumeFacts: formatResumeFacts((candidate?.parsed as any) ?? null),
    }),
    { model: env.claudeScoringModel },
  );

  // Recompute overall_score + recommendation in code (transparent, tunable).
  // Screening-stage weights: soft skills + motivation dominate; role fit is light.
  const { overall, recommendation } = computeOverall(assessment);
  assessment.overall_score = overall;
  assessment.recommendation = recommendation;

  // Build scoring provenance using the requested model.
  const scoringProvenanceValue = scoringProvenance(scoringModel);

  const basePayload: Record<string, unknown> = {
    session_id: sessionId,
    candidate_id: session.candidate_id,
    english: assessment.english,
    tone: assessment.tone,
    communication: assessment.communication,
    motivation: assessment.motivation,
    role_fit: assessment.role_fit,
    resume_conflicts: assessment.resume_conflicts ?? [],
    overall_score: assessment.overall_score,
    recommendation: assessment.recommendation,
    summary: assessment.summary,
    raw: assessment, // full object (fallback if optional columns absent)
    provenance: scoringProvenanceValue, // LLM-06 provenance — required, fail closed if missing
  };

  let { data: row, error: aErr } = await supabase
    .from('assessments')
    .insert(basePayload)
    .select()
    .single();

  // If optional communication/motivation columns haven't been migrated yet,
  // retry with those columns only.  Provenance is *never* dropped — it must
  // exist in the schema.  If the provenance column itself is missing, the
  // insert fails closed (the migration is a prerequisite).
  if (aErr && /(resume_conflicts|communication|motivation)/i.test(aErr.message)) {
    const { resume_conflicts, communication, motivation, ...base } = basePayload;
    ({ data: row, error: aErr } = await supabase
      .from('assessments')
      .insert(base)
      .select()
      .single());
  }
  if (aErr) throw new Error(aErr.message);

  // Phase 9 L4 (invariant 9): a recruiter notification intent is logged
  // IDEMPOTENTLY and only after the assessment row is successfully persisted.
  // The intent uses bounded IDs only (no contact data) and is a log — no
  // provider send exists. Assessment insert and intent insert are SEPARATE
  // Supabase calls; atomicity is NOT claimed (see phase9-operations.md). An
  // intent-insert failure therefore never fabricates a delivery and never
  // rolls back the already-persisted assessment — it is a documented
  // reconciliation residual (idempotent retry fills the gap).
  try {
    await insertNotificationIntent({
      idempotency_key: `assessment_ready:${row.id}`,
      kind: 'assessment_ready',
      candidate_id: session.candidate_id,
      consent_verified: false,
      payload: { session_id: sessionId, owner_id: session.owner_id ?? null },
    });
  } catch {
    // Best-effort log only — never fabricate delivery, never fail scoring.
  }

  // Phase 9 L4 (invariant 8): honor candidates.decision_use_blocked_at — the
  // assessment row (and its intent) stays truthful, but the candidate status
  // is NOT silently rewritten while an appeal blocks decision use. The status
  // before the appeal remains for human review (runbook documents this).
  const { data: candidateRow } = await supabase
    .from('candidates')
    .select('decision_use_blocked_at')
    .eq('id', session.candidate_id)
    .maybeSingle();
  const decisionBlocked =
    candidateRow?.decision_use_blocked_at != null &&
    candidateRow.decision_use_blocked_at !== '';
  if (!decisionBlocked) {
    await supabase
      .from('candidates')
      .update({ status: assessment.recommendation === 'reject' ? 'rejected' : 'screened' })
      .eq('id', session.candidate_id);
  }

  // VOI-08: best-effort non-concurrent repeat guard — transition the session's
  // terminal_reason from conversation_complete to assessment_done AFTER a
  // successful assessment insert.  Concurrent calls still have a TOCTOU race
  // (no DB-level unique constraint on session_id in the assessments table),
  // but all non-concurrent repeat calls are now rejected by the preflight.
  // This is a bounded safe fix — no destructive migration required.
  await supabase
    .from('call_sessions')
    .update({ terminal_reason: 'assessment_done' })
    .eq('id', sessionId)
    .eq('terminal_reason', 'conversation_complete');

  return { ...assessment, id: row.id };
}

// ── Weighted overall score (screening-stage; tune here) ──────────────
// Soft skills + motivation dominate; role fit is a light signal (depth → R1).
const WEIGHTS = {
  communication: 0.50,
  motivation: 0.20,
  tone: 0.10,
  role_fit: 0.20,
};

function clamp10(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(10, v));
}
function mean(nums: unknown[]): number {
  if (!nums.length) return 0;
  return nums.reduce<number>((a, b) => a + clamp10(b), 0) / nums.length;
}

export function computeOverall(a: Assessment): {
  overall: number;
  recommendation: 'advance' | 'hold' | 'reject';
} {
  const toneScore = mean([a.tone?.clarity, a.tone?.confidence, a.tone?.professionalism]);
  const commScore = clamp10(a.communication?.score);
  const motivScore = clamp10(a.motivation?.score);
  const roleFitScore = clamp10(a.role_fit?.score);

  const weighted =
    commScore * WEIGHTS.communication +
    motivScore * WEIGHTS.motivation +
    toneScore * WEIGHTS.tone +
    roleFitScore * WEIGHTS.role_fit;

  const overall = Math.round(weighted * 10); // 0-10 → 0-100
  const recommendation = overall >= 65 ? 'advance' : overall >= 45 ? 'hold' : 'reject';
  return { overall, recommendation };
}
