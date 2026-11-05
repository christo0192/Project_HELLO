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
import { validateBody, validateParams } from '../lib/validation.js';
import { exportCandidateParamSchema, exportReportAuditBodySchema } from '../schemas/export.js';
import { CSV_BOM, toCsv, csvFilename } from '../lib/export-csv.js';
import { chunkIds, readAllPages } from '../lib/id-batches.js';

export const exportRouter = Router();

/**
 * Hard ceiling on pages per read for one candidate: 20 pages of
 * POSTGREST_MAX_ROWS is 20,000 rows. Past it the export fails rather than
 * leaving rows out.
 */
const EXPORT_MAX_PAGES = 20;

interface TranscriptTurnRow {
  session_id: string;
  turn_index: number;
  speaker: string;
  text: string;
  created_at: string | null;
}

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
  // v2 scorecard columns (Phase 6). Appended so the v1 column order/values are
  // byte-identical for existing consumers; empty on v1 scorecard rows and on
  // every transcript row. `schema_version` is the discriminator (1|2);
  // `metric_scores` is the compact per-metric representation (see below).
  'schema_version',
  'weighted_score_5',
  'scoring_status',
  'metric_scores',
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
 * Compact, spreadsheet-safe rendering of a v2 assessment's per-metric scores:
 * a `metric_key=score` list joined by "; ". `score` is the 1..5 integer, or
 * `n/a` when a metric was left unscored (insufficient_evidence → null score).
 * Metric keys match ^[a-z][a-z0-9_]{1,62}$ and values are 1..5/n/a, so no cell
 * begins with a formula trigger and no value contains a comma — but each cell
 * still flows through toCsv's formula/RFC4180 neutralization regardless.
 *
 * Only the numeric per-metric scores are exported (never the model's free-text
 * rationale or evidence refs), which keeps this column aligned with the export's
 * existing data-minimization: v1 exports numeric dimensions + recommendation
 * only, no notes. `metric_results` is the persisted jsonb array of
 * ScorecardMetricResult (each element carries `metric.key`, falling back to the
 * opaque `configMetricId` if a snapshot is ever absent).
 */
function formatMetricScores(metricResults: unknown): string {
  if (!Array.isArray(metricResults)) return '';
  const parts: string[] = [];
  for (const entry of metricResults) {
    if (!entry || typeof entry !== 'object') continue;
    const r = entry as Record<string, unknown>;
    const metric = r.metric && typeof r.metric === 'object' ? (r.metric as Record<string, unknown>) : null;
    const key =
      typeof metric?.key === 'string'
        ? metric.key
        : typeof r.configMetricId === 'string'
          ? r.configMetricId
          : null;
    if (!key) continue;
    const score = typeof r.score === 'number' && Number.isFinite(r.score) ? String(r.score) : 'n/a';
    parts.push(`${key}=${score}`);
  }
  return parts.join('; ');
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

      // Scorecard rows — no transcript/raw/contact data. The SELECT now also
      // pulls the v2 scorecard columns so a schema_version=2 assessment is not
      // silently dropped; v1 rows leave those DB columns null (metric_results /
      // weighted_score_5) or defaulted (scoring_status='complete'), so the v2
      // cells are gated on schema_version to keep v1 rows unchanged.
      //
      // Every read below is paged past PostgREST's 1000-row cap, which
      // truncates WITHOUT an error (M026), and a failed read fails the export:
      // a CSV missing its scorecards or transcript would read as complete.
      const assessmentsRead = await readAllPages<Record<string, unknown>>((from, to) => supabase
        .from('assessments')
        .select(
          'id, session_id, english, tone, communication, motivation, role_fit, overall_score, recommendation, created_at, schema_version, weighted_score_5, scoring_status, metric_results',
        )
        .eq('candidate_id', candidateId)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to), EXPORT_MAX_PAGES);
      if (!assessmentsRead.ok) return next(new Error('failed to export candidate'));

      const rows: Array<Record<string, unknown>> = assessmentsRead.rows.map((a) => {
        const isV2 = Number(a.schema_version) === 2;
        return {
          record_type: 'scorecard',
          candidate_id: candidateId,
          candidate_status: candidate.status ?? '',
          session_id: a.session_id ?? '',
          assessment_id: a.id,
          turn_index: '',
          speaker: '',
          transcript_text: '',
          // v1 SCORING dimensions: populated for v1 rows; empty for v2 rows, which
          // invent no v1 sub-scores.
          english: extractScore(a.english),
          tone: extractScore(a.tone),
          communication: extractScore(a.communication),
          motivation: extractScore(a.motivation),
          // role_fit is populated for BOTH versions: the v1 dimension for v1 rows,
          // and (since the scorer was extended) the supplementary integrity fit
          // score 0–10 for v2 rows. It is a SEPARATE signal from the v2 weighted
          // verdict, which rides in overall_score / recommendation / weighted_score_5.
          role_fit: extractScore(a.role_fit),
          // Populated for BOTH schema versions (the v2 scorer writes overall_score
          // and recommendation too).
          overall_score: toNumberOrEmpty(a.overall_score),
          recommendation: a.recommendation ?? '',
          created_at: a.created_at ?? '',
          // schema_version is the discriminator, always emitted (1 or 2). The
          // three v2-specific cells stay empty for v1 rows.
          schema_version: toNumberOrEmpty(a.schema_version),
          weighted_score_5: isV2 ? toNumberOrEmpty(a.weighted_score_5) : '',
          scoring_status: isV2 ? (a.scoring_status ?? '') : '',
          metric_scores: isV2 ? formatMetricScores(a.metric_results) : '',
        };
      });

      // Transcript rows — bounded text, opaque session id, speaker allowlist
      // (bot|candidate enforced by DB CHECK). Deterministic order.
      const sessionsRead = await readAllPages<{ id: string; created_at: string }>((from, to) => supabase
        .from('call_sessions')
        .select('id, created_at')
        .eq('candidate_id', candidateId)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to), EXPORT_MAX_PAGES);
      if (!sessionsRead.ok) return next(new Error('failed to export candidate'));
      const sessions = sessionsRead.rows;
      const sessionIds = sessions.map((s) => s.id);
      const sessionCreated = new Map(sessions.map((s) => [s.id, s.created_at]));

      if (sessionIds.length > 0) {
        // In batches of ID_BATCH_SIZE sessions, each paged in the unique
        // (session_id, turn_index) order, then merged into the export's order:
        // session created_at, session id on a tie, then turn_index. The sessions
        // read above already returned that session order, compared by Postgres
        // at full timestamp precision, so a turn sorts by its session's position
        // in that read.
        const sessionPosition = new Map(sessionIds.map((id, i) => [id, i]));
        const positionOf = (sessionId: string) => sessionPosition.get(sessionId) ?? sessionIds.length;
        const turns: TranscriptTurnRow[] = [];
        for (const chunk of chunkIds(sessionIds)) {
          const turnsRead = await readAllPages<TranscriptTurnRow>((from, to) => supabase
            .from('transcript_turns')
            .select('session_id, turn_index, speaker, text, created_at')
            .in('session_id', chunk)
            .order('session_id', { ascending: true })
            .order('turn_index', { ascending: true })
            .range(from, to), EXPORT_MAX_PAGES);
          if (!turnsRead.ok) return next(new Error('failed to export candidate'));
          turns.push(...turnsRead.rows);
        }
        turns.sort((a, b) => positionOf(a.session_id) - positionOf(b.session_id) || a.turn_index - b.turn_index);

        for (const t of turns) {
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
            created_at: sessionCreated.get(t.session_id) ?? t.created_at ?? '',
            // Scorecard-only columns are empty on transcript rows.
            schema_version: '',
            weighted_score_5: '',
            scoring_status: '',
            metric_scores: '',
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

/**
 * POST /api/export/:candidateId/report-audit
 *
 * The stakeholder report (one self-contained HTML file with the call audio
 * embedded) is generated in the browser from the data the signed-in user is
 * already allowed to read, so no server route sees it being built. This route
 * records that it happened: same `export_completed` audit action and the same
 * ownership scope as the CSV route (interviewer owns; admin all). The body is
 * counts and a flag only (`exportReportAuditBodySchema`); no content is stored.
 * Each recording the report embeds is separately audited as `recording.download`.
 */
exportRouter.post(
  '/:candidateId/report-audit',
  requireInterviewer,
  validateParams(exportCandidateParamSchema),
  validateBody(exportReportAuditBodySchema),
  async (req, res, next) => {
    try {
      const candidateId = req.params.candidateId as string;
      const user = req.authUser!;
      const body = req.body as { format: 'html'; planned_recordings: number; transcript: boolean };

      const { data: candidate } = await supabase
        .from('candidates')
        .select('owner_id')
        .eq('id', candidateId)
        .maybeSingle();
      if (!candidate) return res.status(404).json({ error: 'candidate_not_found' });
      if (user.appRole === 'interviewer' && candidate.owner_id !== user.id) {
        return res.status(403).json(forbiddenBody());
      }

      const { error } = await supabase.from('audit_events').insert({
        actor_id: user.id,
        actor_type: 'recruiter',
        action: 'export_completed',
        target_type: 'candidate',
        target_id: candidateId,
        result: 'success',
        correlation_id: (req as { correlationId?: string | null }).correlationId ?? null,
        metadata: { format: body.format, planned_recordings: body.planned_recordings, transcript: body.transcript },
      });
      if (error) return next(error);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  },
);
