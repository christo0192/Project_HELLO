/**
 * routes/ashby-mission-control.ts — authorized HR/admin Mission Control for the
 * Ashby screening workflow.
 *
 * Mounted AFTER the global recruiter-auth + viewer-read-only middleware, so an
 * unauthenticated or candidate caller is already rejected (401/403). Reads
 * require interviewer+ (HR reviewers); state-changing actions require admin.
 *
 * Surfaces (sanitized — opaque ids + lifecycle/operation/ingestion states +
 * sanitized codes only; NEVER candidate PII, invite tokens, presigned URLs,
 * transcripts, or recordings):
 *   GET  /mappings                 — job mappings incl. paused/drift + completeness
 *   GET  /workflows                — application workflows incl. pending/expired/
 *                                    failed_review/cancelled/withdrawn/delivery/
 *                                    writeback states
 *   POST /mappings/:id/pause       — admin: pause a mapping
 *   POST /mappings/:id/resume      — admin: resume (enable) a complete, non-drift mapping
 *   POST /workflows/:id/cancel     — admin: atomic terminal cancellation
 *   POST /operations/:id/retry     — admin: retry a failed safe operation
 *
 * Every mutation is race-safe + audited inside its RPC (0031). Candidate results
 * are never exposed here.
 */

import { Router, type Request, type Response } from 'express';
import { supabase } from '../lib/supabase.js';
import { requireRole } from '../lib/rbac.js';
import { recordAudit } from '../lib/audit.js';
import { createMissionControlStore, type MissionControlStore } from '../integrations/ashby/workflow-stores.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TERMINAL_STATES = new Set(['withdrawn', 'deleted', 'manual_stage_cancel']);
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

function boundedLimit(raw: unknown): number {
  const n = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, n));
}

function sanitizedReason(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().slice(0, 200);
  return trimmed.length > 0 ? trimmed : null;
}

export interface AshbyMissionControlDeps {
  store?: MissionControlStore;
}

export function createAshbyMissionControlRouter(deps: AshbyMissionControlDeps = {}): Router {
  const router = Router();
  let cached: MissionControlStore | undefined = deps.store;
  const store = (): MissionControlStore => {
    if (!cached) cached = createMissionControlStore(supabase as never);
    return cached;
  };

  // ── Reads (interviewer+) ──────────────────────────────────────────────────
  router.get('/mappings', requireRole('interviewer'), async (req: Request, res: Response) => {
    try {
      const mappings = await store().listMappings(boundedLimit(req.query.limit));
      await recordAudit(req, 'resource.list', 200, { metadata: { resource: 'ashby_mapping', count: mappings.length } });
      res.json({ ok: true, mappings });
    } catch {
      res.status(500).json({ ok: false, error: 'mission_control_read_error' });
    }
  });

  router.get('/workflows', requireRole('interviewer'), async (req: Request, res: Response) => {
    try {
      const workflows = await store().listWorkflows(boundedLimit(req.query.limit));
      await recordAudit(req, 'resource.list', 200, { metadata: { resource: 'ashby_workflow', count: workflows.length } });
      res.json({ ok: true, workflows });
    } catch {
      res.status(500).json({ ok: false, error: 'mission_control_read_error' });
    }
  });

  // ── Actions (admin) ───────────────────────────────────────────────────────
  async function setStatus(req: Request, res: Response, next: 'paused' | 'enabled'): Promise<void> {
    const id = req.params.id;
    if (!UUID_RE.test(id)) {
      res.status(400).json({ ok: false, error: 'invalid_mapping_id' });
      return;
    }
    try {
      const actorId = req.authUser?.id ?? null;
      if (!actorId) { res.status(403).json({ ok: false, error: 'forbidden' }); return; }
      const result = await store().setMappingStatus(id, next, sanitizedReason(req.body?.reason), actorId);
      if (result.status === 'ok') {
        res.json({ ok: true, status: result.mappingStatus ?? next });
        return;
      }
      if (result.status === 'not_found') { res.status(404).json({ ok: false, error: 'not_found' }); return; }
      // incomplete_cannot_enable / drifted_cannot_enable / invalid_status → 409.
      res.status(409).json({ ok: false, error: result.status });
    } catch {
      res.status(500).json({ ok: false, error: 'mission_control_action_error' });
    }
  }

  router.post('/mappings/:id/pause', requireRole('admin'), (req, res) => { void setStatus(req, res, 'paused'); });
  router.post('/mappings/:id/resume', requireRole('admin'), (req, res) => { void setStatus(req, res, 'enabled'); });

  router.post('/workflows/:id/cancel', requireRole('admin'), async (req: Request, res: Response) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) { res.status(400).json({ ok: false, error: 'invalid_workflow_id' }); return; }
    const terminalState = typeof req.body?.terminal_state === 'string' ? req.body.terminal_state : 'manual_stage_cancel';
    if (!TERMINAL_STATES.has(terminalState)) { res.status(400).json({ ok: false, error: 'invalid_terminal_state' }); return; }
    try {
      const actorId = req.authUser?.id ?? null;
      if (!actorId) { res.status(403).json({ ok: false, error: 'forbidden' }); return; }
      const result = await store().cancelApplication(id, terminalState, sanitizedReason(req.body?.reason), actorId);
      if (result.status === 'ok') {
        res.json({ ok: true, cancelled_operations: result.cancelledOperations ?? 0, cancelled_ingestion: result.cancelledIngestion ?? 0 });
        return;
      }
      if (result.status === 'already_terminal') { res.status(409).json({ ok: false, error: 'already_terminal' }); return; }
      if (result.status === 'not_found') { res.status(404).json({ ok: false, error: 'not_found' }); return; }
      res.status(409).json({ ok: false, error: result.status });
    } catch {
      res.status(500).json({ ok: false, error: 'mission_control_action_error' });
    }
  });

  router.post('/operations/:id/retry', requireRole('admin'), async (req: Request, res: Response) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) { res.status(400).json({ ok: false, error: 'invalid_operation_id' }); return; }
    try {
      const actorId = req.authUser?.id ?? '';
      const result = await store().retryOperation(id, actorId);
      if (result.status === 'ok') { res.json({ ok: true }); return; }
      res.status(409).json({ ok: false, error: result.status });
    } catch {
      res.status(500).json({ ok: false, error: 'mission_control_action_error' });
    }
  });

  return router;
}

/** Default router instance (production wiring). */
export const ashbyMissionControlRouter = createAshbyMissionControlRouter();
