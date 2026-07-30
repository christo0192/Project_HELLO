/**
 * MIG-06: Recruiter recording download route.
 *
 * GET /api/recordings/:sessionId/download
 *
 * Authorization (mirrors the Phase 1 scoped-read RLS policy on
 * call_sessions — migration 0007 "scoped recruiter read call_sessions"):
 *   - Active admin/viewer may read any session's recording.
 *   - Interviewer may read only sessions they own (owner_id === user.id).
 *   - Inactive/revoked membership and lost ownership deny.
 *
 * NOTE: this route uses the service-role Supabase client, which BYPASSES
 * RLS. Access control is therefore enforced here in code, not by the DB
 * policy. The code below intentionally reproduces the 0007 policy shape.
 *
 * Behavior:
 *   - Reads `owner_id` + `recording_object_key` from call_sessions.
 *   - Mints a fresh short-lived signed URL from the private recordings bucket.
 *   - Never persists/logs the URL, token, or object identity.
 *   - Returns stable errors and audits access without sensitive payload.
 *   - Non-privileged roles receive a uniform 403 whether the session is
 *     missing or simply not owned (no existence enumeration).
 *
 * Candidate `POST /api/livekit/grant/recording` behavior is preserved unchanged.
 */

import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { env } from '../lib/env.js';
import { validateParams } from '../lib/validation.js';
import { authErrorBody } from '../lib/auth.js';
import { recordingDownloadParamSchema } from '../schemas/recordings.js';
import { recordAudit, auditAccessDenied } from '../lib/audit.js';

export const recordingsRouter = Router();

// ── GET /api/recordings/:sessionId/download ──────────────────────────
// MIG-06: Recruiter on-demand recording download.
// Protected by bearer auth, membership, viewer-read semantics (global
// middleware), plus the in-code role/ownership gate below. Never public.

recordingsRouter.get(
  '/:sessionId/download',
  validateParams(recordingDownloadParamSchema),
  async (req, res, next) => {
    try {
      const user = req.authUser;

      // Belt-and-suspenders: global requireAuth already guarantees an
      // active authenticated user for this non-public route.
      if (!user || !user.active) {
        return res.status(403).json(authErrorBody(403));
      }

      const sessionId = req.params.sessionId;

      // ── Fetch owner + object key in a single query ───────────────
      // Service-role bypasses RLS, so authorization is enforced below.
      const { data: session, error: sessionErr } = await supabase
        .from('call_sessions')
        .select('owner_id, recording_object_key')
        .eq('id', sessionId)
        .single();

      // ── Access control (mirrors 0007 scoped-read policy) ─────────
      // admin/viewer read all; interviewer must own the session.
      const isAdminOrViewer = user.appRole === 'admin' || user.appRole === 'viewer';
      const isOwningInterviewer =
        user.appRole === 'interviewer' &&
        !!session?.owner_id &&
        session.owner_id === user.id;

      if (!isAdminOrViewer && !isOwningInterviewer) {
        // Uniform denial for non-privileged roles: do NOT distinguish
        // "not found" from "not owned" (prevents session enumeration).
        await auditAccessDenied(req, 'recording_access_denied').catch(() => {/* fail-open */});
        return res.status(403).json(authErrorBody(403));
      }

      // ── Recording presence check (privileged roles only reach here) ─
      if (sessionErr || !session || !session.recording_object_key) {
        return res
          .status(404)
          .json({ error: { type: 'not_found', message: 'Recording not found' } });
      }

      // ── Mint short-lived signed URL ─────────────────────────────
      const ttlSec = env.recordingDownloadTtlSec;
      const { data: signedData, error: signErr } = await supabase.storage
        .from(env.recordingsBucket)
        .createSignedUrl(session.recording_object_key as string, ttlSec);

      if (signErr || !signedData?.signedUrl) {
        // Redacted stable error — never expose signing failure details.
        return res
          .status(500)
          .json({ error: { type: 'internal_error', message: 'Failed to generate download URL' } });
      }

      // ── Audit access (no sensitive payload; read → fail-open) ────
      // recording.download is a read event: an audit-sink failure must
      // never turn a successful download into a 500 (see FAIL_OPEN_EVENTS).
      await recordAudit(req, 'recording.download', 200, {
        metadata: {
          session_id: sessionId,
          requested_by: user.id,
          role: user.appRole,
          ttl_sec: ttlSec,
        },
      }).catch(() => {/* fail-open */});

      // Return signed URL — never persisted or logged.
      res.json({ url: signedData.signedUrl });
    } catch (error) {
      next(error);
    }
  },
);
