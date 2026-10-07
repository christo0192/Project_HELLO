/**
 * services/r1-assessment.ts: score ONE completed R1 session (plan 6.1-6.7).
 *
 * Selected only for sessions with `interview_round_id IS NOT NULL`; the phone path
 * (`services/assessment.ts`) answers 409/throws `r1_session` for those. Flow:
 *
 *   load session, attempt, scorecard, thresholds, phase-labelled turns, administration log
 *   -> mask (commitment lines, candidate name) -> three-run scoring -> coverage/fidelity gate
 *   -> insert the v2 assessment -> r1_attach_assessment (round + audit)
 *   -> r1_apply_status_effect (the audited CAS; the flag ships OFF).
 *
 * IDEMPOTENT. A re-run for a session that already has a scored assessment skips the model
 * entirely and only re-drives the two RPCs, each of which is an idempotent no-op once done.
 * `uq_assessments_v2_session_revision` makes a concurrent double insert answer 23505, which
 * adopts the winner's row.
 *
 * FAIL CLOSED TO human_review. Every path that cannot produce a trustworthy score ends in a
 * recommendation of `human_review`, which has no status effect: a gate failure, a run
 * disagreement, an evidence violation, an incomplete scorecard, a role whose active scorecard
 * is not the R1 scorecard (`r1_scorecard_mismatch`: no model call, no retry, because retrying
 * cannot fix configuration), and (on the FINAL queue attempt) a provider or validation
 * failure, which records a placeholder assessment so HR sees "needs human review" instead of
 * nothing, then rethrows so the job lands in the DLQ (`v_funnel_failures`, M3) as the
 * Mission Control alert. A final-attempt failure AFTER a scored row was stored (the round
 * settlement threw) records no placeholder: the scored row stays the truth and a DLQ replay
 * re-drives the settlement through the adopt path.
 *
 * No candidate text is logged or audited; audit metadata carries versions, thresholds and
 * stable codes only.
 */

import { supabase } from '../lib/supabase.js';
import { createLogger } from '../lib/logger.js';
import { DeepseekError } from '../lib/deepseek.js';
import { BusinessError, ProviderError } from '../lib/provider-resilience.js';
import { createProvenance } from '../lib/model-provenance.js';
import { loadActiveRoleScorecard } from '../lib/scorecards/store.js';
import { SCORE_MAX, type RoleScorecardVersion } from '../lib/scorecards/contracts.js';
import { ScorecardValidationError } from '../lib/scorecards/domain.js';
import { parseR1AdministrationLog, type R1AdminLogRow } from '../lib/r1/admin-log.js';
import { R1_DECK_FACTS_VERSION, r1DeckFactsBlock } from '../lib/r1/deck-facts.js';
import { createR1Infer, r1ScoringModel } from '../lib/r1/deepseek-runner.js';
import { parseEvidenceRef } from '../lib/r1/evidence.js';
import {
  describeAdministrationQuality,
  evaluateR1Gate,
  type R1GateInput,
} from '../lib/r1/gate.js';
import {
  R1_RUBRIC_VERSION,
  R1_SCORING_PROMPT_VERSION,
  r1ScorecardMatchesRubric,
} from '../lib/r1/rubric.js';
import {
  parseR1Thresholds,
  scoreR1Transcript,
  type R1Recommendation,
  type R1ScoreOutcome,
  type R1Thresholds,
} from '../lib/r1/scorer.js';
import {
  computeTranscriptStats,
  maskR1Turns,
  toR1Turns,
  type R1TurnRow,
} from '../lib/r1/transcript.js';

const r1Log = createLogger('r1-assessment');

/** The slice of the Supabase client this service needs (the real singleton satisfies it). */
export interface R1DbClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

export interface R1AssessmentOptions {
  readonly client?: R1DbClient;
  /** The model boundary (tests inject; production uses the R1-only runner). */
  readonly infer?: (prompt: string) => Promise<unknown>;
  readonly now?: () => Date;
  /** True on the last queue attempt: a failure then records a human_review placeholder. */
  readonly finalAttempt?: boolean;
  /** Test seam: a fixed prompt sentinel. */
  readonly sentinel?: string;
}

export interface R1AssessmentResult {
  readonly sessionId: string;
  readonly roundId: string;
  readonly assessmentId: string;
  readonly recommendation: R1Recommendation;
  /** True when a valid, gated score decided the round (gate + agreement + evidence all held). */
  readonly valid: boolean;
  /** True when an existing assessment was adopted and the model was not called. */
  readonly reused: boolean;
  /** r1_attach_assessment status. */
  readonly attach: string;
  /** r1_apply_status_effect `status_write`, or the RPC status when it did not apply. */
  readonly statusWrite: string | null;
}

interface SessionRow {
  readonly id: string;
  readonly candidate_id: string;
  readonly role_id: string | null;
  readonly status: string;
  readonly terminal_reason: string | null;
  readonly interview_round_id: string | null;
  readonly mode: string;
}

interface StoredAssessment {
  readonly id: string;
  readonly revision: number;
  readonly recommendation: string | null;
  readonly overall_score: number | string | null;
  readonly raw: unknown;
}

function fail(code: string): never {
  throw new Error(code);
}

function rawR1(raw: unknown): Record<string, unknown> {
  const r1 = (raw as { r1?: unknown } | null)?.r1;
  return r1 !== null && typeof r1 === 'object' ? (r1 as Record<string, unknown>) : {};
}

async function loadSession(client: R1DbClient, sessionId: string): Promise<SessionRow> {
  const { data, error } = await client
    .from('call_sessions')
    .select('id,candidate_id,role_id,status,terminal_reason,interview_round_id,mode')
    .eq('id', sessionId)
    .maybeSingle();
  if (error) fail('r1_session_read_error');
  if (!data) fail('r1_session_not_found');
  const session = data as SessionRow;
  if (!session.interview_round_id || session.mode !== 'browser') fail('r1_session_invalid');
  if (session.status !== 'completed') fail('r1_session_not_completed');
  return session;
}

async function loadLatestAssessment(
  client: R1DbClient,
  sessionId: string,
): Promise<StoredAssessment | null> {
  const { data, error } = await client
    .from('assessments')
    .select('id,revision,recommendation,overall_score,raw')
    .eq('session_id', sessionId)
    .eq('schema_version', 2)
    .order('revision', { ascending: false })
    .limit(1);
  if (error) fail('r1_assessment_read_error');
  const rows = (data ?? []) as StoredAssessment[];
  return rows[0] ?? null;
}

function recommendationOf(value: string | null): R1Recommendation {
  return value === 'advance' || value === 'hold' || value === 'reject' ? value : 'human_review';
}

/** The stored assessment is a failure placeholder (no score); a re-run supersedes it. */
function isPlaceholder(stored: StoredAssessment): boolean {
  const outcome = rawR1(stored.raw).outcome;
  return outcome === 'scoring_failed' || outcome === 'no_candidate_speech';
}

type AuditMeta = Record<string, unknown>;

function buildAuditMeta(
  thresholds: R1Thresholds,
  settingsUpdatedAt: string | null,
  gate: { passed: boolean; failures: readonly string[] },
  outcome: string,
  extra: { runsAgree?: boolean } = {},
): AuditMeta {
  return {
    scorer_version: R1_SCORING_PROMPT_VERSION,
    rubric_version: R1_RUBRIC_VERSION,
    deck_facts_version: R1_DECK_FACTS_VERSION,
    model: r1ScoringModel(),
    outcome,
    thresholds: {
      advance: thresholds.advance,
      hold: thresholds.hold,
      settings_updated_at: settingsUpdatedAt ?? 'unknown',
    },
    gate_passed: gate.passed,
    gate_failures: gate.failures.slice(0, 8),
    ...(extra.runsAgree === undefined ? {} : { runs_agree: extra.runsAgree }),
  };
}

function provenance(now: Date): ReturnType<typeof createProvenance> {
  return createProvenance({
    provider: 'deepseek',
    requestedModel: r1ScoringModel(),
    workload: 'scoring',
    prompt_template_version: R1_SCORING_PROMPT_VERSION,
    timestamp: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
  });
}

interface PlaceholderInput {
  readonly sessionId: string;
  readonly candidateId: string;
  readonly scorecard: RoleScorecardVersion | null;
  readonly outcome: 'scoring_failed' | 'no_candidate_speech';
  readonly code: string;
  readonly revision: number;
  readonly supersedes: string | null;
  readonly gateFailures: readonly string[];
  readonly now: Date;
}

/** A human_review row with every metric `insufficient_evidence`: the shape the HR card renders. */
function buildPlaceholderPayload(input: PlaceholderInput): Record<string, unknown> {
  const reason = input.outcome === 'no_candidate_speech'
    ? 'The candidate said too little in the scored phases to assess; human review is required.'
    : `R1 scoring could not be completed (${input.code}); human review is required.`;
  const metricResults = (input.scorecard?.metrics ?? []).map((metric) => ({
    configMetricId: metric.id,
    score: null,
    evidenceStatus: 'insufficient_evidence',
    rationale: reason,
    evidenceRefs: [],
    metric,
  }));
  return {
    session_id: input.sessionId,
    candidate_id: input.candidateId,
    schema_version: 2,
    revision: input.revision,
    ...(input.supersedes ? { supersedes_assessment_id: input.supersedes } : {}),
    scorecard_version_id: input.scorecard?.id ?? null,
    metric_results: metricResults,
    score_scale_max: SCORE_MAX,
    weighted_score_5: null,
    scoring_status: 'incomplete_evidence',
    overall_score: null,
    recommendation: null,
    raw: {
      schemaVersion: 2,
      scorecardVersionId: input.scorecard?.id ?? null,
      revision: input.revision,
      status: 'incomplete_evidence',
      metricResults,
      scoreScaleMax: SCORE_MAX,
      weightedScore5: null,
      overallScore: null,
      recommendation: 'human_review',
      r1: {
        outcome: input.outcome,
        valid: false,
        code: input.code,
        gate: { passed: false, failures: input.gateFailures.slice(0, 16) },
        versions: {
          scorer: R1_SCORING_PROMPT_VERSION,
          rubric: R1_RUBRIC_VERSION,
          deck_facts: R1_DECK_FACTS_VERSION,
        },
      },
    },
    provenance: provenance(input.now),
  };
}

interface ScoredPayloadInput {
  readonly sessionId: string;
  readonly candidateId: string;
  readonly scorecard: RoleScorecardVersion;
  readonly outcome: R1ScoreOutcome;
  readonly recommendation: R1Recommendation;
  readonly valid: boolean;
  readonly gate: { passed: boolean; failures: readonly string[] };
  readonly quality: unknown;
  readonly thresholds: R1Thresholds;
  readonly revision: number;
  readonly supersedes: string | null;
  readonly now: Date;
}

function buildScoredPayload(input: ScoredPayloadInput): Record<string, unknown> {
  const { outcome } = input;
  const metricResults = outcome.metricResults.map((result) => ({
    ...result,
    // The shared panel renders `evidenceRefs` strings; `evidence` carries them structured so
    // the player can seek to the turn.
    evidence: result.evidenceRefs.flatMap((ref) => {
      const parsed = parseEvidenceRef(ref);
      return parsed ? [{ turn_index: parsed.turnIndex, quote: parsed.quote }] : [];
    }),
  }));
  return {
    session_id: input.sessionId,
    candidate_id: input.candidateId,
    schema_version: 2,
    revision: input.revision,
    ...(input.supersedes ? { supersedes_assessment_id: input.supersedes } : {}),
    scorecard_version_id: input.scorecard.id,
    metric_results: metricResults,
    score_scale_max: SCORE_MAX,
    weighted_score_5: outcome.weightedScore5,
    scoring_status: outcome.scoringStatus,
    overall_score: outcome.overallScore,
    // chk_assessments_recommendation admits only advance|hold|reject; human_review is stored
    // NULL and preserved truthfully in `raw`.
    recommendation: input.recommendation === 'human_review' ? null : input.recommendation,
    raw: {
      schemaVersion: 2,
      scorecardVersionId: input.scorecard.id,
      revision: input.revision,
      status: outcome.scoringStatus,
      metricResults,
      scoreScaleMax: SCORE_MAX,
      weightedScore5: outcome.weightedScore5,
      overallScore: outcome.overallScore,
      recommendation: input.recommendation,
      r1: {
        outcome: 'scored',
        valid: input.valid,
        scored_recommendation: outcome.scoredRecommendation,
        gate: { passed: input.gate.passed, failures: input.gate.failures.slice(0, 16) },
        administration_quality: input.quality,
        agreement: { runs_agree: outcome.runsAgree, disagreement: outcome.disagreement },
        runs: outcome.runs,
        thresholds: { advance: input.thresholds.advance, hold: input.thresholds.hold },
        versions: {
          scorer: R1_SCORING_PROMPT_VERSION,
          rubric: R1_RUBRIC_VERSION,
          deck_facts: R1_DECK_FACTS_VERSION,
          model: r1ScoringModel(),
        },
      },
    },
    provenance: provenance(input.now),
  };
}

async function insertAssessment(
  client: R1DbClient,
  payload: Record<string, unknown>,
  sessionId: string,
): Promise<StoredAssessment> {
  const { data, error } = await client.from('assessments').insert(payload).select().single();
  if (!error && data) return data as StoredAssessment;
  // A concurrent run won the (session_id, revision) slot: adopt its row, never fail.
  if ((error as { code?: string } | null)?.code === '23505') {
    const winner = await loadLatestAssessment(client, sessionId);
    if (winner) return winner;
  }
  return fail('r1_assessment_insert_failed');
}

async function rpc(
  client: R1DbClient,
  fn: string,
  args: Record<string, unknown>,
  errorCode: string,
): Promise<Record<string, unknown>> {
  const { data, error } = await client.rpc(fn, args);
  if (error) fail(errorCode);
  return (data ?? {}) as Record<string, unknown>;
}

/** Drive the two RPCs for an assessment. Both are idempotent once applied. */
async function settleRound(
  client: R1DbClient,
  args: {
    readonly roundId: string;
    readonly sessionId: string;
    readonly assessmentId: string;
    readonly recommendation: R1Recommendation;
    readonly overall: number | null;
    readonly valid: boolean;
    readonly audit: AuditMeta;
    readonly now: Date;
  },
): Promise<{ attach: string; statusWrite: string | null }> {
  const attached = await rpc(client, 'r1_attach_assessment', {
    p_round_id: args.roundId,
    p_session_id: args.sessionId,
    p_assessment_id: args.assessmentId,
    p_recommendation: args.recommendation,
    p_overall: args.overall,
    p_valid: args.valid,
    p_audit: args.audit,
    p_now: args.now.toISOString(),
  }, 'r1_attach_failed');
  const attachStatus = String(attached.status ?? 'unknown');
  if (attachStatus === 'superseded_by_newer') return { attach: attachStatus, statusWrite: null };
  if (attachStatus !== 'ok') fail(`r1_attach_${attachStatus}`.slice(0, 60));
  const applied = await rpc(client, 'r1_apply_status_effect', {
    p_round_id: args.roundId,
    p_assessment_id: args.assessmentId,
    p_recommendation: args.recommendation,
    p_audit: args.audit,
    p_now: args.now.toISOString(),
  }, 'r1_status_effect_failed');
  const appliedStatus = String(applied.status ?? 'unknown');
  if (appliedStatus === 'ok') {
    return { attach: attachStatus, statusWrite: String(applied.status_write ?? 'unknown') };
  }
  if (appliedStatus === 'already_applied') {
    return { attach: attachStatus, statusWrite: String(applied.status_write ?? 'unknown') };
  }
  // `superseded`: a newer attempt took the round between the two calls; nothing to apply.
  if (appliedStatus === 'superseded') return { attach: attachStatus, statusWrite: null };
  return fail(`r1_status_${appliedStatus}`.slice(0, 60));
}

/** A stable, sanitized code for the queue/DLQ; never provider text, never candidate text. */
export function r1ErrorCode(err: unknown): string {
  if (err instanceof ScorecardValidationError) return err.code;
  if (err instanceof DeepseekError) return `deepseek_${err.category}`;
  if (err instanceof ProviderError) return `provider_${err.message}`.slice(0, 63);
  if (err instanceof BusinessError) return 'deepseek_parse_error';
  const message = err instanceof Error ? err.message : '';
  return /^[a-z][a-z0-9_.:-]{2,63}$/.test(message) ? message : 'r1_assessment_failed';
}

export async function runR1Assessment(
  sessionId: string,
  options: R1AssessmentOptions = {},
): Promise<R1AssessmentResult> {
  const client = options.client ?? (supabase as unknown as R1DbClient);
  const now = options.now ?? ((): Date => new Date());
  const session = await loadSession(client, sessionId);
  const roundId = session.interview_round_id as string;

  const existing = await loadLatestAssessment(client, sessionId);
  const settings = await loadSettings(client);
  if (existing && !isPlaceholder(existing)) {
    // Adopt: the model is never called again for a scored session.
    return adoptStored({ client, sessionId, roundId, stored: existing, settings, now });
  }

  const revision = (existing?.revision ?? 0) + 1;
  const supersedes = existing?.id ?? null;
  let scorecard: RoleScorecardVersion | null = null;
  let scoredInserted = false;

  try {
    const attempt = await loadAttempt(client, sessionId);
    scorecard = session.role_id ? await loadActiveRoleScorecard(client, session.role_id) : null;
    if (!scorecard) fail('r1_scorecard_missing');
    if (!r1ScorecardMatchesRubric(scorecard.metrics)) {
      // The role kept another scorecard (the 0089 default phone metrics, or a half-seeded R1
      // one). Scoring against it would write a gated recommendation from metrics that have no
      // R1 evidence phases and no integrity floor. No model call; HR reviews; never retried.
      if (existing && rawR1(existing.raw).code === SCORECARD_MISMATCH_CODE) {
        return await adoptStored({ client, sessionId, roundId, stored: existing, settings, now });
      }
      r1Log.warn('unknown_event', {
        error_category: 'r1_assessment_failed',
        rejection_reason: SCORECARD_MISMATCH_CODE,
      });
      return await persistPlaceholder({
        client, session, roundId, scorecard: null, existing, revision, supersedes,
        outcome: 'scoring_failed', code: SCORECARD_MISMATCH_CODE, settings,
        gateFailures: [SCORECARD_MISMATCH_CODE], now: now(),
      });
    }
    const loaded = await loadScoringInputs(client, session);
    const stats = computeTranscriptStats(loaded.turns);
    if (stats.evidenceEligibleCandidateTurns === 0) {
      // Nothing the candidate said can be scored: no model call, a human reviews the session.
      return await persistPlaceholder({
        client, session, roundId, scorecard, existing, revision, supersedes,
        outcome: 'no_candidate_speech', code: 'no_candidate_speech', settings,
        gateFailures: ['no_candidate_speech'], now: now(),
      });
    }
    const outcome = await scoreR1Transcript(
      { infer: options.infer ?? createR1Infer(), sentinel: options.sentinel },
      {
        scorecard,
        roleTitle: loaded.roleTitle,
        turns: loaded.turns,
        log: loaded.log,
        stats,
        deckFacts: r1DeckFactsBlock(),
        thresholds: settings.thresholds,
      },
    );
    const gateInput: R1GateInput = {
      transcript: stats,
      log: loaded.log,
      terminalReason: session.terminal_reason,
      attemptOutcome: attempt.outcome,
      scoring: {
        complete: outcome.complete,
        runsAgree: outcome.runsAgree,
        evidenceValid: outcome.evidenceValid,
      },
    };
    const gate = evaluateR1Gate(gateInput);
    const quality = describeAdministrationQuality(gateInput, gate);
    const valid = gate.passed && outcome.recommendation !== 'human_review';
    const recommendation: R1Recommendation = valid ? outcome.recommendation : 'human_review';
    const stored = await insertAssessment(client, buildScoredPayload({
      sessionId,
      candidateId: session.candidate_id,
      scorecard,
      outcome,
      recommendation,
      valid,
      gate,
      quality,
      thresholds: settings.thresholds,
      revision,
      supersedes,
      now: now(),
    }), sessionId);
    // From here the scored row is the truth. A settlement failure must not stack a placeholder
    // over it on the final attempt (see the catch).
    scoredInserted = true;
    const settled = await settleRound(client, {
      roundId,
      sessionId,
      assessmentId: stored.id,
      recommendation,
      overall: outcome.overallScore,
      valid,
      audit: buildAuditMeta(settings.thresholds, settings.updatedAt, gate, 'scored', {
        runsAgree: outcome.runsAgree,
      }),
      now: now(),
    });
    return {
      sessionId,
      roundId,
      assessmentId: stored.id,
      recommendation,
      valid,
      reused: false,
      attach: settled.attach,
      statusWrite: settled.statusWrite,
    };
  } catch (err) {
    const code = r1ErrorCode(err);
    r1Log.warn('unknown_event', { error_category: 'r1_assessment_failed', rejection_reason: code });
    if (options.finalAttempt === true) {
      // Last attempt: leave HR a "needs human review" record before the job dead-letters,
      // unless a scored row already exists (its settlement failed): that row stays the truth
      // and a DLQ replay re-drives the settlement. Best effort: a failure here must not mask
      // the original code.
      try {
        if (!existing && !scoredInserted) {
          await persistPlaceholder({
            client, session, roundId, scorecard, existing, revision, supersedes,
            outcome: 'scoring_failed', code, settings,
            gateFailures: ['scoring_failed'], now: now(),
          });
        }
      } catch {
        r1Log.warn('unknown_event', { error_category: 'r1_placeholder_failed' });
      }
    }
    throw new Error(code, { cause: err });
  }
}

const SCORECARD_MISMATCH_CODE = 'r1_scorecard_mismatch';

/**
 * Re-drive the two RPCs for a stored assessment without calling the model. Both are
 * idempotent once applied, so this is safe to repeat (a retry, a DLQ replay, a duplicate job).
 */
async function adoptStored(args: {
  readonly client: R1DbClient;
  readonly sessionId: string;
  readonly roundId: string;
  readonly stored: StoredAssessment;
  readonly settings: Settings;
  readonly now: () => Date;
}): Promise<R1AssessmentResult> {
  const { stored } = args;
  const r1 = rawR1(stored.raw);
  const recommendation = recommendationOf(stored.recommendation);
  const valid = r1.valid === true;
  const overall = stored.overall_score === null ? null : Number(stored.overall_score);
  const settled = await settleRound(args.client, {
    roundId: args.roundId,
    sessionId: args.sessionId,
    assessmentId: stored.id,
    recommendation,
    overall: overall !== null && Number.isFinite(overall) ? overall : null,
    valid,
    audit: buildAuditMeta(
      args.settings.thresholds,
      args.settings.updatedAt,
      { passed: valid, failures: [] },
      'reused',
    ),
    now: args.now(),
  });
  return {
    sessionId: args.sessionId,
    roundId: args.roundId,
    assessmentId: stored.id,
    recommendation,
    valid,
    reused: true,
    attach: settled.attach,
    statusWrite: settled.statusWrite,
  };
}

interface Settings {
  readonly thresholds: R1Thresholds;
  readonly updatedAt: string | null;
}

async function loadSettings(client: R1DbClient): Promise<Settings> {
  const { data, error } = await client
    .from('r1_settings')
    .select('advance_threshold,hold_threshold,updated_at')
    .eq('singleton', true)
    .maybeSingle();
  if (error || !data) fail('r1_settings_read_error');
  const row = data as {
    advance_threshold: unknown;
    hold_threshold: unknown;
    updated_at: string | null;
  };
  return {
    thresholds: parseR1Thresholds(row.advance_threshold, row.hold_threshold),
    updatedAt: typeof row.updated_at === 'string' ? row.updated_at : null,
  };
}

async function loadAttempt(
  client: R1DbClient,
  sessionId: string,
): Promise<{ outcome: string | null }> {
  const { data, error } = await client
    .from('interview_round_attempts')
    .select('round_id,attempt_number,outcome')
    .eq('session_id', sessionId)
    .maybeSingle();
  if (error) fail('r1_attempt_read_error');
  if (!data) fail('r1_attempt_missing');
  const outcome = (data as { outcome: unknown }).outcome;
  return { outcome: typeof outcome === 'string' ? outcome : null };
}

async function loadScoringInputs(client: R1DbClient, session: SessionRow) {
  const { data: turnRows, error: turnError } = await client
    .from('transcript_turns')
    .select('turn_index,speaker,text,phase,interrupted')
    .eq('session_id', session.id)
    .eq('is_gate', false)
    .order('turn_index', { ascending: true });
  if (turnError) fail('r1_transcript_read_error');
  const { data: logRows, error: logError } = await client
    .from('r1_admin_log')
    .select('event_type,turn_index,family_id,payload,created_at')
    .eq('session_id', session.id)
    .order('created_at', { ascending: true })
    .limit(2000);
  if (logError) fail('r1_admin_log_read_error');
  const { data: candidate } = await client
    .from('candidates')
    .select('name')
    .eq('id', session.candidate_id)
    .maybeSingle();
  const { data: role } = session.role_id
    ? await client.from('roles').select('title').eq('id', session.role_id).maybeSingle()
    : { data: null };
  const candidateName = typeof (candidate as { name?: unknown } | null)?.name === 'string'
    ? ((candidate as { name: string }).name)
    : null;
  return {
    turns: maskR1Turns(toR1Turns((turnRows ?? []) as R1TurnRow[]), candidateName),
    log: parseR1AdministrationLog((logRows ?? []) as R1AdminLogRow[]),
    roleTitle: typeof (role as { title?: unknown } | null)?.title === 'string'
      ? ((role as { title: string }).title)
      : 'the role',
  };
}

async function persistPlaceholder(args: {
  readonly client: R1DbClient;
  readonly session: SessionRow;
  readonly roundId: string;
  readonly scorecard: RoleScorecardVersion | null;
  readonly existing: StoredAssessment | null;
  readonly revision: number;
  readonly supersedes: string | null;
  readonly outcome: 'scoring_failed' | 'no_candidate_speech';
  readonly code: string;
  readonly settings: Settings;
  readonly gateFailures: readonly string[];
  readonly now: Date;
}): Promise<R1AssessmentResult> {
  const stored = await insertAssessment(args.client, buildPlaceholderPayload({
    sessionId: args.session.id,
    candidateId: args.session.candidate_id,
    scorecard: args.scorecard,
    outcome: args.outcome,
    code: args.code,
    revision: args.revision,
    supersedes: args.supersedes,
    gateFailures: args.gateFailures,
    now: args.now,
  }), args.session.id);
  const settled = await settleRound(args.client, {
    roundId: args.roundId,
    sessionId: args.session.id,
    assessmentId: stored.id,
    recommendation: 'human_review',
    overall: null,
    valid: false,
    audit: buildAuditMeta(
      args.settings.thresholds,
      args.settings.updatedAt,
      { passed: false, failures: args.gateFailures },
      args.outcome,
    ),
    now: args.now,
  });
  return {
    sessionId: args.session.id,
    roundId: args.roundId,
    assessmentId: stored.id,
    recommendation: 'human_review',
    valid: false,
    reused: false,
    attach: settled.attach,
    statusWrite: settled.statusWrite,
  };
}
