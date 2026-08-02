/**
 * Phase 9 L3/L4 — CSV export (scorecard + transcript).
 *
 * Invariant 6 (extended by OPS-07 review repair):
 * - Authenticated GET, ownership-scoped (interviewer owns; admin all).
 * - Exports BOTH the scorecard and the candidate's transcript turns as a
 *   single CSV with a clear `record_type` column (`scorecard`|`transcript`)
 *   and deterministic ordering (scorecard by assessment created_at asc;
 *   transcript by session created_at asc then turn_index asc).
 * - Data minimization: numeric score dimensions + recommendation + bounded
 *   transcript text + opaque IDs + timestamps. NO contact/resume/recording/
 *   object keys/model/provider/raw internals.
 * - RFC4180 quoting + UTF-8 BOM; content-type text/csv; charset=utf-8;
 *   content-disposition uses a safe fixed UUID-derived filename.
 * - Formula-injection cells (first meaningful char = + - @ TAB CR, including
 *   leading whitespace/control-char cases) are apostrophe-prefixed for EVERY
 *   string cell (lib/export-csv.ts). Non-Latin preserved.
 * - No PDF claim (PDF export remains external-pending).
 */

import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { requireInterviewer } from '../lib/rbac.js';
import { validateParams } from '../lib/validation.js';
import { exportCandidateParamSchema } from '../schemas/export.js';
import { CSV_BOM, toCsv, csvFilename } from '../lib/export-csv.js';

export const exportRouter = Router();

const EXPORT_COLUMNS = [
  'record_type',
  'candidate_id',
  'candidate_status',
  'session_id',
  'assessment_id',
  'turn_index',
  'speaker',
  'transcript_text',
  'english',
  'tone',
  'communication',
  'motivation',
  'role_fit',
  'overall_score',
  'recommendation',
  'created_at',
] as const;

function forbiddenBody(): { error: { type: string; message: string } } {
  return { error: { type: 'authorization_error', message: 'Insufficient permissions' } };
}

/** Extract a numeric score from an assessment dimension (score field or mean of numeric sub-scores). */
function extractScore(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.score === 'number' && Number.isFinite(obj.score)) return obj.score;
    const nums = Object.values(obj).filter(
      (v): v is number => typeof v === 'number' && Number.isFinite(v),
    );
    if (nums.length > 0) {
      return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10;
    }
  }
  return null;
}

function toNumberOrEmpty(value: unknown): number | string {
  if (value === null || value === undefined || value === '') return '';
  const n = Number(value);
  return Number.isFinite(n) ? n : String(value);
}

/**
 * GET /api/export/:candidateId/csv
 * Ownership-scoped, data-minimized scorecard + transcript CSV (authenticated).
 * Every string cell is formula-neutralized by toCsv/csvEscape — including
 * transcript text and leading-whitespace/control-char payloads.
 */
exportRouter.get(
  '/:candidateId/csv',
  requireInterviewer,
  validateParams(exportCandidateParamSchema),
  async (req, res, next) => {
    try {
      const candidateId = req.params.candidateId as string;
      const user = req.authUser!;

      const { data: candidate } = await supabase
        .from('candidates')
        .select('owner_id, status')
        .eq('id', candidateId)
        .maybeSingle();
      if (!candidate) return res.status(404).json({ error: 'candidate_not_found' });
      if (user.appRole === 'interviewer' && candidate.owner_id !== user.id) {
        return res.status(403).json(forbiddenBody());
      }

      // Scorecard rows — no transcript/raw/contact data.
      const { data: assessments } = await supabase
        .from('assessments')
        .select(
          'id, session_id, english, tone, communication, motivation, role_fit, overall_score, recommendation, created_at',
        )
        .eq('candidate_id', candidateId)
        .order('created_at', { ascending: true });

      const rows: Array<Record<string, unknown>> = (assessments ?? []).map((a) => ({
        record_type: 'scorecard',
        candidate_id: candidateId,
        candidate_status: candidate.status ?? '',
        session_id: a.session_id ?? '',
        assessment_id: a.id,
        turn_index: '',
        speaker: '',
        transcript_text: '',
        english: extractScore(a.english),
        tone: extractScore(a.tone),
        communication: extractScore(a.communication),
        motivation: extractScore(a.motivation),
        role_fit: extractScore(a.role_fit),
        overall_score: toNumberOrEmpty(a.overall_score),
        recommendation: a.recommendation ?? '',
        created_at: a.created_at ?? '',
      }));

      // Transcript rows — bounded text, opaque session id, speaker allowlist
      // (bot|candidate enforced by DB CHECK). Deterministic order.
      const { data: sessions } = await supabase
        .from('call_sessions')
        .select('id, created_at')
        .eq('candidate_id', candidateId)
        .order('created_at', { ascending: true });
      const sessionIds = (sessions ?? []).map((s) => s.id as string);
      const sessionCreated = new Map((sessions ?? []).map((s) => [s.id as string, s.created_at as string]));

      if (sessionIds.length > 0) {
        const { data: turns } = await supabase
          .from('transcript_turns')
          .select('session_id, turn_index, speaker, text, created_at')
          .in('session_id', sessionIds)
          .order('session_id', { ascending: true })
          .order('turn_index', { ascending: true });

        for (const t of turns ?? []) {
          rows.push({
            record_type: 'transcript',
            candidate_id: candidateId,
            candidate_status: candidate.status ?? '',
            session_id: t.session_id,
            assessment_id: '',
            turn_index: t.turn_index,
            speaker: t.speaker,
            transcript_text: t.text,
            english: '',
            tone: '',
            communication: '',
            motivation: '',
            role_fit: '',
            overall_score: '',
            recommendation: '',
            created_at: sessionCreated.get(t.session_id as string) ?? t.created_at ?? '',
          });
        }
      }

      const csv = CSV_BOM + toCsv(rows, EXPORT_COLUMNS as readonly string[]);
      const filename = csvFilename(candidateId);

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.status(200).send(csv);

      // Best-effort audit (DB-allowlisted export_completed).
      await supabase.from('audit_events').insert({
        actor_id: user.id,
        actor_type: 'recruiter',
        action: 'export_completed',
        target_type: 'candidate',
        target_id: candidateId,
        result: 'success',
        correlation_id: (req as { correlationId?: string | null }).correlationId ?? null,
        metadata: { format: 'csv', record_types: ['scorecard', 'transcript'] },
      });
    } catch (error) {
      next(error);
    }
  },
);
