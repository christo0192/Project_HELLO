import { supabase } from '../lib/supabase.js';
import { runClaudeJSONWithProvenance } from '../lib/claude.js';
import { env } from '../lib/env.js';
import { observeAshbyCompletion } from '../integrations/ashby/completion-observer.js';
import { createAshbyLinkLookup, createWorkflowStores } from '../integrations/ashby/workflow-stores.js';
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

/**
 * 0044: the phone path needs an EXPLICIT source, and the browser path must not
 * change at all. So the option is optional, its absence means `browser`, and
 * the browser insert payload is byte-identical to what it was before — the
 * column is simply not passed and the database default applies.
 */
export interface RunAssessmentOptions {
  /**
   * Which screening channel is asking. Omit and the source is DERIVED from
   * the session itself — see `runAssessmentImpl`. Passing `'phone'` forces it;
   * passing `'browser'` cannot force a phone session into the browser
   * partition, because the caller does not get to decide what a session is.
   */
  readonly source?: 'browser' | 'phone';
}

export interface AssessmentRunner {
  (sessionId: string, options?: RunAssessmentOptions): Promise<Assessment & { id: string }>;
}

/**
 * Default runner: connects to real Supabase and the configured HTTP LLM provider.
 * Override in tests via injectAssessmentRunner() to avoid network/CLI calls.
 */
let _runAssessment: AssessmentRunner = runAssessmentImpl;

export function injectAssessmentRunner(fn: AssessmentRunner | null): void {
  _runAssessment = fn ?? runAssessmentImpl;
}

/**
 * Score a completed screening session and persist the assessment.
 *
 * BROWSER: unchanged from before 0044 — inserts a new assessment row each
 * call, guarded only by the non-concurrent `terminal_reason` preflight.
 * PHONE (`{ source: 'phone' }`): idempotent for real. The partial unique index
 * `uq_assessments_phone_session` admits exactly one row per session, and a
 * caller that loses the race REUSES the winner's row without repeating the
 * notification intent, the candidate status update or the Ashby writeback.
 * Delegates to the injected runner (default: real implementation).
 * The default provenance-aware inference call uses the configured provider's
 * single circuit breaker; no nested breaker is added here. Provider failures
 * affect that breaker, while invalid JSON is a BusinessError and does not.
 */
export async function runAssessment(
  sessionId: string,
  options?: RunAssessmentOptions,
): Promise<Assessment & { id: string }> {
  return _runAssessment(sessionId, options);
}

// ── Real implementation ─────────────────────────────────────────────────

async function runAssessmentImpl(
  sessionId: string,
  options?: RunAssessmentOptions,
): Promise<Assessment & { id: string }> {
  const { data: session, error: sErr } = await supabase
    .from('call_sessions')
    .select('id,candidate_id,owner_id,role_id,status,terminal_reason,external_call_id')
    .eq('id', sessionId)
    .single();
  if (sErr || !session) throw new Error(`session not found: ${sErr?.message}`);

  // ── THE SOURCE IS DERIVED, NOT TRUSTED ──────────────────────────────
  // Four callers reach this function — the phone completion endpoint, the
  // worker scoring callback, the admin re-score route and the screening
  // queue — and only one of them knows it is holding a phone session. If the
  // source came from the caller, an admin re-scoring a phone session would
  // write `source = 'browser'`: false provenance, outside
  // `uq_assessments_phone_session` (so insertable repeatedly, re-firing the
  // notification intent, the candidate status rewrite and the Ashby
  // writeback each time), and invisible to `apply_phone_event`'s existence
  // check — which would then refuse the completion of a screening that IS
  // scored.
  //
  // `external_call_id` is the deterministic phone room name the dialer
  // provisions and `start_phone_assessment` verifies, so the session itself
  // is the authority on what channel it belongs to. An explicit `'phone'`
  // still forces the phone partition; an explicit `'browser'` cannot force a
  // phone session out of it.
  const isPhone =
    options?.source === 'phone' || isPhoneSession(session.external_call_id as unknown);

  // VOI-08: technical scoring eligibility — fail closed unless the session is
  // completed with the authoritative initial scoring reason. Blocks
  // failed/cancelled/expired/in_progress/created/waiting, missing/null or
  // malformed reasons, and the assessment_done repeat path.
  if (
    session.status !== 'completed' ||
    session.terminal_reason !== 'conversation_complete'
  ) {
    // 0044: for the PHONE path only, an already-scored session is a SUCCESS,
    // not a refusal. Two legs racing a completion is the ordinary case a
    // reconnect creates: the winner scores and flips `terminal_reason` to
    // `assessment_done`, and the loser arrives here. Throwing would make the
    // loser report a scoring failure for a screening that is, in fact,
    // scored — and the worker would then decline to claim a completion that
    // is legitimately owed.
    //
    // The reuse is read from the DATABASE, never assumed from the status: if
    // there is no phone assessment row, this still throws.
    if (isPhone) {
      const existing = await loadPhoneAssessment(sessionId);
      if (existing) return existing;
    }
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

  // The provenance-aware call uses the configured provider's single
  // breaker-managed runner and returns the configured design-intent model for
  // immutable provenance.
  const { data: assessment, requestedModel: scoringModel } = await runClaudeJSONWithProvenance<Assessment>(
    buildAssessmentPrompt({
      roleTitle,
      requiredSkills,
      candidateName: candidate?.name ?? null,
      transcript,
      resumeFacts: formatResumeFacts((candidate?.parsed as any) ?? null),
    }),
    { model: env.deepseekScoringModel },
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
  // 0044: passed ONLY for the phone path. The browser payload therefore has
  // exactly the keys it had before this migration, and the column default
  // (`browser`) applies to it — so `uq_assessments_phone_session`, which is
  // partial over `source = 'phone'`, cannot touch a browser row.
  if (isPhone) {
    basePayload.source = 'phone';
  }

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
  // ── 0044: EXACTLY ONE phone assessment per session ──────────────────
  // `uq_assessments_phone_session` is the authority. Two concurrent phone
  // completions both reach this insert; one wins and one gets 23505, and the
  // loser must REUSE the winner's row rather than fail. That is what makes
  // "scored exactly once, and one writeback" true under concurrency, which
  // the pre-0044 `terminal_reason` flip could not manage — it ran AFTER the
  // insert and admitted its own TOCTOU race.
  //
  // The loser returns HERE, before the notification intent, the candidate
  // status update, the `terminal_reason` flip and the Ashby completion
  // observer — so none of those runs twice.
  if (aErr && isPhone && isUniqueViolation(aErr)) {
    const existing = await loadPhoneAssessment(sessionId);
    if (existing) return existing;
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

  // ── Ashby completion observer ─────────────────────────────────────────
  // This is the authoritative terminal path: we only reach here after the
  // eligibility guard above (status='completed' AND terminal_reason=
  // 'conversation_complete') and after the assessment row is durably
  // inserted, so a failed/cancelled/expired/in-flight session can never be
  // parked. For an Ashby-originated session the application link becomes
  // `writeback_pending` — screened, awaiting manual publication, because no
  // tenant-verified Ashby result sink exists. It publishes NOTHING: no
  // scorecard write, no stage move, no auto-reject.
  //
  // Deliberately best-effort with respect to scoring: `observeAshbyCompletion`
  // never throws, so a bookkeeping failure cannot discard a scored assessment.
  await observeAshbyCompletion(sessionId, {
    lookup: createAshbyLinkLookup(supabase as never),
    stores: createWorkflowStores(supabase as never),
  });

  return { ...assessment, id: row.id };
}

/**
 * True when this session belongs to the PHONE channel, decided from the
 * deterministic room name `phone-<sessionId>` that the dialer provisions and
 * `start_phone_assessment` verifies before it will bind anything.
 *
 * Matched on the prefix only. A UUID check would be a second copy of a format
 * rule that already lives in two places, and this is not a security boundary —
 * the binding is enforced in SQL; this decides which partition a row lands in.
 */
function isPhoneSession(externalCallId: unknown): boolean {
  return typeof externalCallId === 'string' && externalCallId.startsWith('phone-');
}

/**
 * A PostgREST unique-violation, identified by SQLSTATE rather than by message
 * text. Matching on the message would also match a driver string that merely
 * mentions the constraint, and would stop matching the moment the constraint
 * is renamed.
 */
function isUniqueViolation(error: { code?: string | null } | null | undefined): boolean {
  return error?.code === '23505';
}

/**
 * Read back the phone assessment that already exists for this session.
 *
 * Returns `null` when there is none — the caller must then fail rather than
 * invent a success. `maybeSingle()` is deliberate: with the partial unique
 * index in place there can be at most one, and a second row would be a
 * schema failure that should surface rather than be silently picked from.
 */
async function loadPhoneAssessment(
  sessionId: string,
): Promise<(Assessment & { id: string }) | null> {
  const { data, error } = await supabase
    .from('assessments')
    .select('id,raw')
    .eq('session_id', sessionId)
    .eq('source', 'phone')
    .maybeSingle();
  if (error || !data?.id) return null;
  const raw = (data.raw ?? null) as Assessment | null;
  if (!raw) return null;
  return { ...raw, id: data.id as string };
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
