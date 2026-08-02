import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { runClaudeJSON } from '../lib/claude.js';
import { env } from '../lib/env.js';
import {
  buildConversationPrompt,
  buildOpeningMessage,
  formatResumeFacts,
  SCREENING_SYSTEM,
  type ConversationContext,
} from '../lib/prompts.js';
import type { ScreeningQuestion, TranscriptTurn } from '../lib/types.js';
import { runAssessment } from '../services/assessment.js';
import { validateBody, validateParams } from '../lib/validation.js';
import {
  startScreeningSchema,
  screeningTurnSchema,
  screeningSessionIdParamSchema,
} from '../schemas/screening.js';
import { createSession, transitionSession, ERR_INSERT_FAILED, ERR_DB_FAILED } from '../lib/session-lifecycle.js';
import { screeningProvenance } from '../lib/model-provenance.js';
import { requireRole } from '../lib/rbac.js';
import { recordAudit } from '../lib/audit.js';
import { createMaintenanceMiddleware } from '../lib/maintenance.js';
import {
  extractIdempotencyKey,
  quotaEnforcementEnabled,
  reserveQuota,
  runWithQuotaReservation,
} from '../lib/quota.js';

export const screeningRouter = Router();

// SEC-03: Screening sessions cannot be safely scoped by owner_id because
// sessions are candidate-centric, not interviewer-owned. Interviewer access
// is currently denied pending future scoping via candidate owner_id.
// Only admin may initiate and manage screening sessions.
screeningRouter.use(requireRole('admin'));

interface BotReply {
  message: string;
  done: boolean;
}

async function loadContext(candidateId: string): Promise<{
  ctxBase: Omit<ConversationContext, 'transcript'>;
  roleId: string | null;
}> {
  const { data: candidate, error } = await supabase
    .from('candidates')
    .select('id,name,role_id,skills,parsed')
    .eq('id', candidateId)
    .single();
  if (error || !candidate) throw new Error(`candidate not found: ${error?.message}`);

  let roleTitle = 'the role';
  let jd: string | null = null;
  let requiredSkills: string[] = [];
  let template: ScreeningQuestion[] = [];
  if (candidate.role_id) {
    const { data: role } = await supabase
      .from('roles')
      .select('title,jd,required_skills,screening_template')
      .eq('id', candidate.role_id)
      .single();
    if (role) {
      roleTitle = role.title;
      jd = role.jd;
      requiredSkills = (role.required_skills as string[]) ?? [];
      template = (role.screening_template as ScreeningQuestion[]) ?? [];
    }
  }

  const parsed = (candidate.parsed as any) ?? {};
  return {
    roleId: candidate.role_id,
    ctxBase: {
      company: env.companyName,
      roleTitle,
      jd,
      requiredSkills,
      candidateName: candidate.name,
      candidateSummary: parsed.summary ?? null,
      candidateSkills: (candidate.skills as string[]) ?? [],
      resumeFacts: formatResumeFacts(parsed),
      template,
    },
  };
}

async function getTranscript(sessionId: string): Promise<TranscriptTurn[]> {
  const { data } = await supabase
    .from('transcript_turns')
    .select('speaker,text')
    .eq('session_id', sessionId)
    .order('turn_index', { ascending: true });
  return (data ?? []).map((t) => ({ speaker: t.speaker as 'bot' | 'candidate', text: t.text }));
}

/** Insert a transcript turn. Throws on Supabase error. */
async function appendTurn(
  sessionId: string,
  index: number,
  speaker: 'bot' | 'candidate',
  text: string,
): Promise<void> {
  const { error } = await supabase
    .from('transcript_turns')
    .insert({ session_id: sessionId, turn_index: index, speaker, text });
  if (error) throw new Error('ERR_TRANSCRIPT_INSERT_FAILED');
}

// POST /api/screening/start  { candidate_id }
// Phase 9 L2 (invariant 10/11): gated by the fail-closed maintenance guard
// for NEW work, and — when quota enforcement is configured (at least one
// enabled quota_policy) — requires a bounded Idempotency-Key header,
// reserves a slot BEFORE session creation, commits the reservation after
// success, and releases it on any failure (compensation). When no quota
// policy is enabled (the default), legacy start behavior is preserved and
// no reservation is made. Active-turn/finalization behavior is untouched.
screeningRouter.post(
  '/start',
  validateBody(startScreeningSchema),
  createMaintenanceMiddleware({ allowAdmin: true }),
  async (req, res, next) => {
    try {
      const candidateId = req.body?.candidate_id as string;
      if (!candidateId) return res.status(400).json({ error: 'candidate_id is required' });

      // ── Maintenance guard already ran (fail-closed on DB read). Now check
      // whether quota enforcement is configured (policies disabled by default).
      const enforcement = await quotaEnforcementEnabled();
      if (!enforcement.ok) {
        // DB read failure → fail closed for new work.
        return res.status(503).json({ error: 'service_unavailable' });
      }

      // Legacy (quota-unconfigured) path: unchanged start behavior.
      const run = async (): Promise<void> => {
        const { ctxBase, roleId } = await loadContext(candidateId);

        // REL-07: create in `created` state. LLM-06 records the configured
        // design-intent model for this API-owned simulation inference path.
        // SEC-03: screening sessions are admin-only (cannot be safely scoped by owner_id).
        const { data: session, error: insertErr } = await createSession({
          candidate_id: candidateId,
          role_id: roleId,
          mode: 'simulation',
          provenance: screeningProvenance(env.claudeModel),
        });
        if (insertErr || !session) throw new Error(ERR_INSERT_FAILED);

        const opening = buildOpeningMessage({
          candidateName: ctxBase.candidateName,
          roleTitle: ctxBase.roleTitle,
          company: env.companyName,
        });

        // Write opening turn; on failure, attempt to terminate the row.
        // appendTurn throws on Supabase error now (detected via {error}).
        try {
          await appendTurn(session.id, 0, 'bot', opening);
        } catch {
          const termResult = await transitionSession(
            session.id, 'created', 'failed', 'worker_crash',
          );
          if (!termResult.ok && !termResult.conflict) {
            throw new Error('opening turn failed and session could not be terminated — reconciliation required');
          }
          throw new Error('opening turn insert failed');
        }

        // Candidate status is best-effort — use await+check, not .catch().
        {
          const { error: candErr } = await supabase
            .from('candidates')
            .update({ status: 'screening' })
            .eq('id', candidateId);
          void candErr; // Non-critical; documented in runbook as best-effort.
        }

        // CAS: created → in_progress
        const tr = await transitionSession(session.id, 'created', 'in_progress');
        if (!tr.ok) {
          throw new Error('session transition conflict: could not activate session');
        }

        res.status(201).json({ session_id: session.id, message: opening, done: false });
      };

      if (!enforcement.enabled) {
        await run();
        return;
      }

      // ── Quota enforcement: bounded Idempotency-Key required, reserve
      // before create, commit after success, release on failure. Never
      // double-reserves: a repeated key returns the SAME stable reservation.
      const key = extractIdempotencyKey(req);
      if (!key) {
        return res.status(400).json({
          error: { type: 'validation_error', message: 'Idempotency-Key header is required' },
        });
      }

      const reservation = await reserveQuota({
        scopeId: candidateId,
        mode: 'simulation',
        idempotencyKey: key,
      });

      if (reservation.status === 'rpc_error') {
        return res.status(503).json({ error: 'quota_service_error' });
      }
      if (reservation.status === 'no_policy') {
        return res.status(503).json({ error: 'quota_not_configured' });
      }
      if (reservation.status === 'quota_exceeded') {
        return res.status(409).json({
          error: 'quota_exceeded',
          remaining_sessions: reservation.remainingSessions,
          remaining_cost_units: reservation.remainingCostUnits,
        });
      }
      if (reservation.status === 'duplicate') {
        // Truthful retry semantics: existing-session response is NOT
        // implemented (residual documented) — a repeated key returns a
        // stable conflict and never double-reserves.
        if (reservation.reservationStatus === 'committed') {
          return res.status(409).json({ error: 'idempotency_replay' });
        }
        if (reservation.reservationStatus === 'reserved') {
          return res.status(409).json({ error: 'request_in_flight' });
        }
        return res.status(409).json({ error: 'idempotency_key_exhausted' });
      }

      // reservation.status === 'ok' — proceed, commit after success, release
      // on failure (compensates failed session creation).
      const outcome = await runWithQuotaReservation(reservation, run);
      if (outcome.handled) return; // response already sent by run()
    } catch (error) {
      next(error);
    }
  },
);

// POST /api/screening/:id/turn  { text }
screeningRouter.post(
  '/:id/turn',
  validateParams(screeningSessionIdParamSchema),
  validateBody(screeningTurnSchema),
  async (req, res, next) => {
    try {
      const sessionId = req.params.id;
      const text = (req.body?.text as string)?.trim();
      if (!text) return res.status(400).json({ error: 'text is required' });

      const { data: session, error: sErr } = await supabase
        .from('call_sessions')
        .select('id,candidate_id,status')
        .eq('id', sessionId)
        .single();
      if (sErr || !session) return res.status(404).json({ error: 'session not found' });
      if (session.status !== 'in_progress')
        return res.status(409).json({ error: 'session already completed' });

      const { ctxBase } = await loadContext(session.candidate_id);
      const transcript = await getTranscript(sessionId);

      await appendTurn(sessionId, transcript.length, 'candidate', text);
      transcript.push({ speaker: 'candidate', text });

      const reply = await runClaudeJSON<BotReply>(
        buildConversationPrompt({ ...ctxBase, transcript }),
        { system: SCREENING_SYSTEM },
      );
      await appendTurn(sessionId, transcript.length, 'bot', reply.message);

      let assessment = null;
      let scoringStatus: 'pending' | 'done' | 'error' = reply.done ? 'pending' : 'done';

      if (reply.done) {
        // REL-07: CAS to completed FIRST (ownership), THEN assess.
        // Only the CAS winner triggers assessment.
        // Assessment failure does NOT rewrite completed → failed.
        // Instead, scoringStatus='error' is returned so the caller knows
        // the session completed but scoring needs retry.
        const tr = await transitionSession(
          session.id, 'in_progress', 'completed', 'conversation_complete',
        );

        if (tr.ok) {
          // This caller won the CAS — owns post-session work.
          try {
            assessment = await runAssessment(sessionId);
            scoringStatus = 'done';
          } catch {
            scoringStatus = 'error';
            assessment = null;
          }
        } else if (tr.conflict) {
          // Another writer already completed this session.
          // Fetch the current terminal state to verify what happened.
          const { data: curSession } = await supabase
            .from('call_sessions')
            .select('status')
            .eq('id', sessionId)
            .single();
          if (curSession && curSession.status !== 'completed') {
            // Another terminal state (failed/cancelled/expired) — not completed.
            scoringStatus = 'error';
            assessment = null;
          } else {
            // Already completed by another writer — safe.
            scoringStatus = 'pending';
            assessment = null;
          }
        } else {
          // CAS returned ERROR or DISABLED — must not return HTTP 200 with done:true.
          // The session may be in an unknown state; fail closed.
          return next(new Error('ERR_DB_FAILED — session transition failed'));
        }
      }

      res.json({ message: reply.message, done: reply.done, assessment, scoringStatus });
    } catch (error) {
      next(error);
    }
  },
);

// GET /api/screening/:id  -> session + transcript + assessment
screeningRouter.get('/:id', validateParams(screeningSessionIdParamSchema), async (req, res) => {
  const sessionId = req.params.id;
  const { data: session, error } = await supabase
    .from('call_sessions')
    .select('*')
    .eq('id', sessionId)
    .single();
  if (error) return res.status(404).json({ error: 'Screening session not found' });
  const transcript = await getTranscript(sessionId);
  const { data: assessment } = await supabase
    .from('assessments')
    .select('*')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  res.json({ session, transcript, assessment });
});
