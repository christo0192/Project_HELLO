/**
 * GOV-04 / GOV-05: DSAR (Data Subject Access Request) and legal hold routes.
 *
 * Endpoints:
 *   POST   /api/dsar                       — Create a new DSAR request
 *   GET    /api/dsar/:dsarId               — Get DSAR status (optionally with export data)
 *   GET    /api/dsar/candidate/:candidateId — List DSARs for a candidate
 *   POST   /api/dsar/:dsarId/fulfill       — Fulfill/reject/cancel a DSAR
 *   POST   /api/dsar/:dsarId/export        — Execute DSAR data export
 *   POST   /api/dsar/:dsarId/delete        — Execute DSAR data deletion
 *   POST   /api/dsar/:dsarId/correct       — Apply DSAR corrections
 *
 *   POST   /api/dsar/legal-holds           — Create a legal hold
 *   POST   /api/dsar/legal-holds/:holdId/release — Release a legal hold
 *   GET    /api/dsar/legal-holds/check     — Check legal hold status for an entity
 *
 * Authorization:
 *   - admin/interviewer: full access
 *   - viewer: read-only access (GET only)
 *   - All routes require bearer auth + active membership (enforced by middleware)
 *   - Ownership scope: interviewer must own the candidate (checked in route)
 */

import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { validateBody, validateParams, validateQuery } from '../lib/validation.js';
import { requireRole } from '../lib/rbac.js';
import { recordAudit } from '../lib/audit.js';
import {
  createDSAR,
  getDSAR,
  listCandidateDSARs,
  updateDSARStatus,
  exportDSAR,
  deleteDSAR,
  correctDSAR,
} from '../lib/dsar.js';
import {
  createLegalHold,
  releaseLegalHold,
  isUnderLegalHold,
  getActiveLegalHolds,
  isErasureBlocked,
} from '../lib/retention.js';
import {
  dsarIdParamSchema,
  candidateIdParamSchema,
  createDSARBodySchema,
  getDSARQuerySchema,
  listCandidateDSARsQuerySchema,
  fulfillDSARBodySchema,
  correctDSARBodySchema,
  createLegalHoldBodySchema,
  releaseLegalHoldBodySchema,
} from '../schemas/dsar.js';
import type { Request, Response, NextFunction } from 'express';

export const dsarRouter = Router();

// ── Auth error body helper ───────────────────────────────────────────

function forbiddenBody(): Record<string, unknown> {
  return {
    error: {
      type: 'authorization_error',
      message: 'Insufficient permissions',
    },
  };
}

function notFoundBody(message: string): Record<string, unknown> {
  return {
    error: { type: 'not_found', message },
  };
}

function conflictBody(message: string): Record<string, unknown> {
  return {
    error: { type: 'conflict', message },
  };
}

// ── Ownership check helper ───────────────────────────────────────────

/**
 * Check that the requesting user (if interviewer) owns the given candidate.
 * Admins bypass this check. Returns true if authorized.
 */
async function checkCandidateOwnership(
  candidateId: string,
  req: Request,
  res: Response,
): Promise<boolean> {
  const user = req.authUser;
  if (!user) {
    res.status(403).json(forbiddenBody());
    return false;
  }

  // Admin bypasses ownership check
  if (user.appRole === 'admin') return true;

  // Interviewer must own the candidate
  if (user.appRole === 'interviewer') {
    const { data: candidate } = await supabase
      .from('candidates')
      .select('owner_id')
      .eq('id', candidateId)
      .single();

    if (!candidate || candidate.owner_id !== user.id) {
      await recordAudit(req, 'rbac.ownership_denied', 403, {
        metadata: { candidate_id: candidateId },
      }).catch(() => {});
      res.status(403).json(forbiddenBody());
      return false;
    }
    return true;
  }

  // Viewer cannot mutate
  if (user.appRole === 'viewer') {
    res.status(403).json(forbiddenBody());
    return false;
  }

  res.status(403).json(forbiddenBody());
  return false;
}

// ── POST /api/dsar — Create DSAR request ─────────────────────────────

dsarRouter.post(
  '/',
  requireRole('interviewer'),
  validateBody(createDSARBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as Record<string, unknown>;
      const user = req.authUser!;

      // Check ownership
      const authorized = await checkCandidateOwnership(
        body.candidate_id as string,
        req,
        res,
      );
      if (!authorized) return;

      const dsar = await createDSAR(
        body.candidate_id as string,
        body.request_type as any,
        user.id,
        body.notes as string | undefined,
        body.metadata as Record<string, unknown> | undefined,
      );

      if (!dsar) {
        res.status(500).json({
          error: { type: 'internal_error', message: 'Failed to create DSAR request' },
        });
        return;
      }

      await recordAudit(req, 'resource.create', 201, {
        metadata: {
          dsar_id: dsar.id,
          candidate_id: body.candidate_id as string,
          request_type: body.request_type as string,
        },
      }).catch(() => {});

      res.status(201).json({ data: dsar });
    } catch (error) {
      next(error);
    }
  },
);

// ── GET /api/dsar/:dsarId — Get DSAR status ──────────────────────────

dsarRouter.get(
  '/:dsarId',
  requireRole('viewer'),
  validateParams(dsarIdParamSchema),
  validateQuery(getDSARQuerySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const dsarId = req.params.dsarId;
      const query = req.query as any;

      const dsar = await getDSAR(dsarId);
      if (!dsar) {
        res.status(404).json(notFoundBody('DSAR request not found'));
        return;
      }

      // Check candidate ownership (interviewer must own)
      const authorized = await checkCandidateOwnership(dsar.candidateId, req, res);
      if (!authorized) return;

      // If include_export=true and status is fulfilled, include export data
      const includeExport = query.include_export === 'true';
      if (includeExport && dsar.requestStatus === 'fulfilled' && dsar.requestType === 'export') {
        const exportData = await exportDSAR(dsarId);
        res.json({ data: dsar, export: exportData });
        return;
      }

      res.json({ data: dsar });
    } catch (error) {
      next(error);
    }
  },
);

// ── GET /api/dsar/candidate/:candidateId — List DSARs ────────────────

dsarRouter.get(
  '/candidate/:candidateId',
  requireRole('viewer'),
  validateParams(candidateIdParamSchema),
  validateQuery(listCandidateDSARsQuerySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const candidateId = req.params.candidateId;

      // Check ownership for interviewers
      const authorized = await checkCandidateOwnership(candidateId, req, res);
      if (!authorized) return;

      const dsars = await listCandidateDSARs(candidateId);

      // Filter by status/type if provided
      let filtered = dsars;
      if (req.query.status) {
        filtered = filtered.filter((d) => d.requestStatus === req.query.status);
      }
      if (req.query.type) {
        filtered = filtered.filter((d) => d.requestType === req.query.type);
      }

      res.json({ data: filtered });
    } catch (error) {
      next(error);
    }
  },
);

// ── POST /api/dsar/:dsarId/fulfill — Fulfill/reject/cancel ──────────

dsarRouter.post(
  '/:dsarId/fulfill',
  requireRole('interviewer'),
  validateParams(dsarIdParamSchema),
  validateBody(fulfillDSARBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const dsarId = req.params.dsarId;
      const body = req.body as Record<string, unknown>;
      const user = req.authUser!;

      // Get the DSAR to verify ownership
      const dsar = await getDSAR(dsarId);
      if (!dsar) {
        res.status(404).json(notFoundBody('DSAR request not found'));
        return;
      }

      // Check ownership
      const authorized = await checkCandidateOwnership(dsar.candidateId, req, res);
      if (!authorized) return;

      const updated = await updateDSARStatus(
        dsarId,
        body.status as any,
        user.id,
        body.rejection_reason as string | undefined,
      );

      if (!updated) {
        res.status(500).json({
          error: { type: 'internal_error', message: 'Failed to update DSAR status' },
        });
        return;
      }

      await recordAudit(req, 'resource.update', 200, {
        metadata: {
          dsar_id: dsarId,
          status: body.status as string,
          candidate_id: dsar.candidateId,
        },
      }).catch(() => {});

      res.json({ data: updated });
    } catch (error) {
      next(error);
    }
  },
);

// ── POST /api/dsar/:dsarId/export — Execute DSAR export ─────────────

dsarRouter.post(
  '/:dsarId/export',
  requireRole('interviewer'),
  validateParams(dsarIdParamSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const dsarId = req.params.dsarId;
      const user = req.authUser!;

      // Get the DSAR
      const dsar = await getDSAR(dsarId);
      if (!dsar) {
        res.status(404).json(notFoundBody('DSAR request not found'));
        return;
      }

      if (dsar.requestType !== 'export') {
        res.status(400).json({
          error: { type: 'validation_error', message: 'DSAR request is not an export type' },
        });
        return;
      }

      // Check ownership
      const authorized = await checkCandidateOwnership(dsar.candidateId, req, res);
      if (!authorized) return;

      // Check consent boundary: job_application consent cannot unlock recording/outbound
      const { data: candidate } = await supabase
        .from('candidates')
        .select('consent_source')
        .eq('id', dsar.candidateId)
        .single();

      if (candidate) {
        const consentSource = candidate.consent_source as string | null;
        const { canAccessRecordingData } = await import('../lib/dsar.js');
        if (!canAccessRecordingData(consentSource)) {
          // Recording data will be excluded — log this
          await recordAudit(req, 'resource.read', 200, {
            metadata: {
              dsar_id: dsarId,
              note: 'Recording/outbound data excluded: insufficient consent',
              consent_source: consentSource ?? 'none',
            },
          }).catch(() => {});
        }
      }

      const exportResult = await exportDSAR(dsarId);

      if (!exportResult) {
        res.status(500).json({
          error: { type: 'internal_error', message: 'Failed to export data' },
        });
        return;
      }

      await recordAudit(req, 'resource.read', 200, {
        metadata: {
          dsar_id: dsarId,
          candidate_id: dsar.candidateId,
          recording_data_included: exportResult.recordingDataIncluded,
        },
      }).catch(() => {});

      res.json({ data: exportResult });
    } catch (error) {
      next(error);
    }
  },
);

// ── POST /api/dsar/:dsarId/delete — Execute DSAR deletion ───────────

dsarRouter.post(
  '/:dsarId/delete',
  requireRole('interviewer'),
  validateParams(dsarIdParamSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const dsarId = req.params.dsarId;
      const user = req.authUser!;

      // Get the DSAR
      const dsar = await getDSAR(dsarId);
      if (!dsar) {
        res.status(404).json(notFoundBody('DSAR request not found'));
        return;
      }

      if (dsar.requestType !== 'delete') {
        res.status(400).json({
          error: { type: 'validation_error', message: 'DSAR request is not a delete type' },
        });
        return;
      }

      // Check ownership
      const authorized = await checkCandidateOwnership(dsar.candidateId, req, res);
      if (!authorized) return;

      const result = await deleteDSAR(dsarId, user.id);

      if (!result.success && result.blockedByLegalHolds.length > 0) {
        // Blocked by legal hold — return 409 Conflict
        await recordAudit(req, 'resource.delete', 409, {
          metadata: {
            dsar_id: dsarId,
            candidate_id: dsar.candidateId,
            blocked_by: result.blockedByLegalHolds.length,
            hold_ids: result.blockedByLegalHolds.map(h => h.id),
          },
        }).catch(() => {});

        res.status(409).json({
          error: {
            type: 'conflict',
            message: 'Deletion blocked by active legal hold(s)',
            holds: result.blockedByLegalHolds.map(h => ({
              id: h.id,
              hold_reason: h.holdReason,
              hold_source: h.holdSource,
              placed_at: h.placedAt,
            })),
          },
        });
        return;
      }

      if (!result.success) {
        res.status(500).json({
          error: { type: 'internal_error', message: 'Failed to execute DSAR deletion' },
        });
        return;
      }

      await recordAudit(req, 'resource.delete', 200, {
        metadata: {
          dsar_id: dsarId,
          candidate_id: dsar.candidateId,
          deleted_entities: result.deletedEntities.length,
        },
      }).catch(() => {});

      res.json({
        data: {
          success: true,
          deleted_entities: result.deletedEntities,
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

// ── POST /api/dsar/:dsarId/correct — Apply DSAR corrections ─────────

dsarRouter.post(
  '/:dsarId/correct',
  requireRole('interviewer'),
  validateParams(dsarIdParamSchema),
  validateBody(correctDSARBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const dsarId = req.params.dsarId;
      const body = req.body as { corrections: Array<{ field: string; value: unknown }> };
      const user = req.authUser!;

      // Get the DSAR
      const dsar = await getDSAR(dsarId);
      if (!dsar) {
        res.status(404).json(notFoundBody('DSAR request not found'));
        return;
      }

      if (dsar.requestType !== 'correct') {
        res.status(400).json({
          error: { type: 'validation_error', message: 'DSAR request is not a correct type' },
        });
        return;
      }

      // Check ownership
      const authorized = await checkCandidateOwnership(dsar.candidateId, req, res);
      if (!authorized) return;

      const result = await correctDSAR(dsarId, body.corrections, user.id);

      if (!result.success) {
        res.status(500).json({
          error: { type: 'internal_error', message: 'Failed to apply corrections' },
        });
        return;
      }

      await recordAudit(req, 'resource.update', 200, {
        metadata: {
          dsar_id: dsarId,
          candidate_id: dsar.candidateId,
          corrections_applied: result.corrections.length,
        },
      }).catch(() => {});

      res.json({ data: result });
    } catch (error) {
      next(error);
    }
  },
);

// ══════════════════════════════════════════════════════════════════════
// Legal Hold Routes (GOV-04)
// ══════════════════════════════════════════════════════════════════════

// ── POST /api/dsar/legal-holds — Create legal hold ───────────────────

dsarRouter.post(
  '/legal-holds',
  requireRole('admin'),
  validateBody(createLegalHoldBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as Record<string, unknown>;
      const user = req.authUser!;

      const hold = await createLegalHold(
        body.entity_type as any,
        body.entity_id as string,
        body.hold_reason as string,
        body.hold_source as any,
        user.id,
        body.expires_at as string | undefined,
        body.metadata as Record<string, unknown> | undefined,
      );

      await recordAudit(req, 'resource.create', 201, {
        metadata: {
          hold_id: hold.id,
          entity_type: body.entity_type as string,
          entity_id: body.entity_id as string,
          hold_source: body.hold_source as string,
        },
      }).catch(() => {});

      res.status(201).json({ data: hold });
    } catch (error) {
      next(error);
    }
  },
);

// ── POST /api/dsar/legal-holds/:holdId/release — Release legal hold ─

dsarRouter.post(
  '/legal-holds/:holdId/release',
  requireRole('admin'),
  validateBody(releaseLegalHoldBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const holdId = req.params.holdId;
      const body = req.body as Record<string, unknown>;
      const user = req.authUser!;

      const hold = await releaseLegalHold(
        holdId,
        user.id,
        body.release_reason as string,
      );

      if (!hold) {
        res.status(404).json(notFoundBody('Legal hold not found or already released'));
        return;
      }

      await recordAudit(req, 'resource.update', 200, {
        metadata: {
          hold_id: holdId,
          released_by: user.id,
        },
      }).catch(() => {});

      res.json({ data: hold });
    } catch (error) {
      next(error);
    }
  },
);

// ── GET /api/dsar/legal-holds/check — Check legal hold status ───────

dsarRouter.get(
  '/legal-holds/check',
  requireRole('viewer'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const entityType = req.query.entity_type as string | undefined;
      const entityId = req.query.entity_id as string | undefined;

      if (!entityType || !entityId) {
        res.status(400).json({
          error: {
            type: 'validation_error',
            message: 'entity_type and entity_id query parameters are required',
          },
        });
        return;
      }

      const validTypes = ['candidate', 'session', 'transcript', 'recording', 'assessment', 'resume'];
      if (!validTypes.includes(entityType)) {
        res.status(400).json({
          error: {
            type: 'validation_error',
            message: `entity_type must be one of: ${validTypes.join(', ')}`,
          },
        });
        return;
      }

      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entityId)) {
        res.status(400).json({
          error: { type: 'validation_error', message: 'entity_id must be a valid UUID' },
        });
        return;
      }

      const underHold = await isUnderLegalHold(entityType as any, entityId);
      const holds = underHold ? await getActiveLegalHolds(entityType as any, entityId) : [];
      const erasureBlocked = await isErasureBlocked(entityType, entityId);

      res.json({
        data: {
          entity_type: entityType,
          entity_id: entityId,
          under_legal_hold: underHold,
          erasure_blocked: erasureBlocked,
          active_holds: holds.map(h => ({
            id: h.id,
            hold_reason: h.holdReason,
            hold_source: h.holdSource,
            placed_at: h.placedAt,
            expires_at: h.expiresAt,
          })),
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

// ── GET /api/dsar/legal-holds/:holdId — Get legal hold details ──────

dsarRouter.get(
  '/legal-holds/:holdId',
  requireRole('viewer'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const holdId = req.params.holdId;

      const { data, error } = await supabase
        .from('legal_holds')
        .select('*')
        .eq('id', holdId)
        .single();

      if (error || !data) {
        res.status(404).json(notFoundBody('Legal hold not found'));
        return;
      }

      res.json({ data });
    } catch (error) {
      next(error);
    }
  },
);
