import { supabase } from '../lib/supabase.js';
import { runClaudeJSON } from '../lib/claude.js';
import { env } from '../lib/env.js';
import { buildAssessmentPrompt, formatResumeFacts } from '../lib/prompts.js';
import type { Assessment, TranscriptTurn } from '../lib/types.js';

/**
 * Score a completed screening session and persist the assessment.
 * Idempotent-ish: inserts a new assessment row each call.
 */
export async function runAssessment(sessionId: string): Promise<Assessment & { id: string }> {
  const { data: session, error: sErr } = await supabase
    .from('call_sessions')
    .select('id,candidate_id,role_id')
    .eq('id', sessionId)
    .single();
  if (sErr || !session) throw new Error(`session not found: ${sErr?.message}`);

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

  const assessment = await runClaudeJSON<Assessment>(
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
  };

  let { data: row, error: aErr } = await supabase
    .from('assessments')
    .insert(basePayload)
    .select()
    .single();

  // If optional columns haven't been migrated yet, retry with base columns only
  // (the full object is always preserved in `raw`).
  if (aErr && /(resume_conflicts|communication|motivation)/i.test(aErr.message)) {
    const { resume_conflicts, communication, motivation, ...base } = basePayload;
    ({ data: row, error: aErr } = await supabase
      .from('assessments')
      .insert(base)
      .select()
      .single());
  }
  if (aErr) throw new Error(aErr.message);

  // reflect outcome on candidate
  await supabase
    .from('candidates')
    .update({ status: assessment.recommendation === 'reject' ? 'rejected' : 'screened' })
    .eq('id', session.candidate_id);

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
