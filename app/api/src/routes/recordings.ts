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
import { validateBody, validateParams } from '../lib/validation.js';
import { authErrorBody } from '../lib/auth.js';
import { recordingDownloadParamSchema, recordingRevokeParamSchema, recordingRevokeBodySchema } from '../schemas/recordings.js';
import { recordAudit, auditAccessDenied } from '../lib/audit.js';
import { requireRole } from '../lib/rbac.js';
import { revokeRecording } from '../lib/retention.js';
import {
  verifyRecordingBytes,
  supabaseRecordingBytesStorage,
  RECORDING_INTEGRITY_ALGORITHM,
  RECORDING_INTEGRITY_SHA256_HEX_LENGTH,
} from '../lib/recording-integrity.js';
import { getCorrelationId } from '../lib/correlation.js';
import { finalizeAuthoritativeRecording } from '../lib/recording-egress.js';

// ── LANE L6 (REC-01 buildable half) — pinned constants ──────────────
// LiveKit Egress MP3 primary path is external-pending (runbook); this is
// ONLY the buildable half: the SHA-256 integrity primitive used to persist
// recording_sha256 and the secondary/degraded browser-upload reduced size
// cap. PROPOSED values — no Product/SRE/Legal sign-off implied. These agree
// with schemas/recordings.ts (RECORDING_MAX_BYTES_DEFAULT) and env.ts. The
// digest constants are imported from lib/recording-integrity.ts (F1 repair
// home of the download-time re-verification primitive).
/** Secondary/degraded browser-upload cap (PROPOSED 25 MiB). */
export const RECORDING_SECONDARY_DEGRADED_MAX_BYTES = 25 * 1024 * 1024;
// Keep the pinned constants referenced so the buildable half is importable
// by a future Egress/erasure consumer without dead-code churn.
void RECORDING_INTEGRITY_ALGORITHM;
void RECORDING_INTEGRITY_SHA256_HEX_LENGTH;
void RECORDING_SECONDARY_DEGRADED_MAX_BYTES;

/**
 * REC-04 (F1 repair): download-time SHA-256 re-verification gate.
 * Returns the quarantine reason string when verification failed (the caller
 * quarantines + returns 409) and null when the object is safe to mint.
 * Fail-closed: on storage read failure returns 'storage_unavailable' so the
 * caller NEVER mints a URL (500). Bounds resource use via the recorded size
 * (pre-download) and the downloaded byte length (post-download) against
 * RECORDING_MAX_BYTES.
 *
 * On digest mismatch, also returns the actual SHA-256 (F-E repair) so the
 * caller can forward it to the atomic quarantine RPC for complete evidence.
 */
async function reverifyRecordingIntegrity(
  session: {
    recording_object_key: string;
    recording_sha256: string | null;
    recording_size_bytes: number | null;
  },
  sessionId: string,
): Promise<
  | { status: 'ok' }
  | { status: 'storage_unavailable' }
  | { status: 'integrity_failed'; actualSha256: string }
  | { status: 'oversize' }
> {
  // Truthful legacy behavior: no persisted digest ⇒ no re-verification, no
  // download — mint proceeds exactly as before 0014.
  if (!session.recording_sha256) return { status: 'ok' };
  const verify = await verifyRecordingBytes(
    {
      objectKey: session.recording_object_key,
      expectedSha256: session.recording_sha256,
      knownSizeBytes: session.recording_size_bytes ?? null,
      maxBytes: env.recordingMaxBytes,
    },
    supabaseRecordingBytesStorage(env.recordingsBucket),
  );
  if (verify.ok) return { status: 'ok' };
  if (verify.reason === 'storage_download_failed') return { status: 'storage_unavailable' };
  if (verify.reason === 'object_too_large') return { status: 'oversize' };
  return { status: 'integrity_failed', actualSha256: verify.actualSha256 };
}

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

      // ── Fetch owner + object key + integrity columns in one query ──
      // Service-role bypasses RLS, so authorization is enforced below.
      // REC-04/05/06 (L5): the integrity/revocation/tombstone columns feed
      // the fail-closed gate before createSignedUrl. recording_sha256 +
      // recording_size_bytes feed the F1 download-time re-verification.
      let { data: session, error: sessionErr } = await supabase
        .from('call_sessions')
        .select('owner_id, status, mode, recording_object_key, recording_sha256, recording_size_bytes, recording_quarantined, recording_revoked_at, recording_deleted_at, recording_egress_id, recording_egress_status')
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

      if (sessionErr || !session) {
        return res
          .status(404)
          .json({ error: { type: 'not_found', message: 'Recording not found' } });
      }

      // ── REC-05/REC-04/REC-06 fail-closed gate (order matters) ──────
      // Runs BEFORE createSignedUrl so a revoked/quarantined/deleted
      // recording can never be re-minted. Existing signed URLs expire
      // naturally within their (short) TTL.
      // 1. Deleted tombstone (REC-06 forward-compat): erased → 404.
      if (session.recording_deleted_at) {
        return res
          .status(404)
          .json({ error: { type: 'not_found', message: 'Recording not found' } });
      }
      // 2. Quarantined (REC-04): never serve a quarantined object.
      if (session.recording_quarantined === true) {
        return res.status(409).json({
          error: { type: 'recording_quarantined', message: 'Recording is quarantined' },
        });
      }
      // 3. Revoked (REC-05): revocation denies new mints within the TTL.
      if (session.recording_revoked_at) {
        return res.status(403).json(authErrorBody(403));
      }

      // A candidate browser can disappear while LiveKit Egress is still
      // settling. Recover on the recruiter's explicit playback request instead
      // of returning a permanent false 404. This keeps Egress authoritative:
      // no browser upload is accepted and no URL is minted until the normal
      // finalizer has linked and integrity-stamped the object.
      if (
        !session.recording_object_key
        && session.status === 'completed'
        && session.recording_egress_id
        && session.recording_egress_status !== 'failed'
      ) {
        let finalization: Awaited<ReturnType<typeof finalizeAuthoritativeRecording>>;
        try {
          finalization = await finalizeAuthoritativeRecording(sessionId);
        } catch {
          return res.status(503).json({
            error: { type: 'recording_processing', message: 'Recording is still processing. Try again shortly.' },
          });
        }
        if (finalization === 'pending') {
          return res.status(409).json({
            error: { type: 'recording_processing', message: 'Recording is still processing. Try again shortly.' },
          });
        }
        if (finalization === 'ready') {
          const refreshed = await supabase
            .from('call_sessions')
            .select('owner_id, status, mode, recording_object_key, recording_sha256, recording_size_bytes, recording_quarantined, recording_revoked_at, recording_deleted_at, recording_egress_id, recording_egress_status')
            .eq('id', sessionId)
            .single();
          if (!refreshed.error && refreshed.data) session = refreshed.data;
        }
      }

      if (!session.recording_object_key) {
        return res
          .status(404)
          .json({ error: { type: 'not_found', message: 'Recording not found' } });
      }

      // ── REC-04 download-time re-verification (F1 repair) ──────────
      // The upload path persists recording_sha256 (computed at upload); the
      // upload-time mismatch check was unreachable, so at-rest tampering is
      // detected HERE instead: the stored object bytes are fetched through
      // the injectable storage seam, hashed server-side, and compared to the
      // persisted digest BEFORE any signed URL is minted. Storage read
      // failure is fail-closed (500, never a URL). A mismatch or an object
      // whose size exceeds the upload cap quarantines the session
      // (convergence-safe guarded update) and returns 409 — the object is
      // never served. All audit metadata stays key/URL/token-free.
      const reverify = await reverifyRecordingIntegrity(session, sessionId);
      if (reverify.status === 'storage_unavailable') {
        // Fail-closed: never mint a URL when the object cannot be read back.
        return res
          .status(500)
          .json({ error: { type: 'internal_error', message: 'Failed to verify recording integrity' } });
      }
      if (reverify.status !== 'ok') {
        const mismatch = reverify.status === 'integrity_failed';
        const actualSha256: string | null = mismatch ? reverify.actualSha256 : null;
        const expectedPrefix = (session.recording_sha256 ?? '').slice(0, 16);
        const reason = mismatch
          ? `download_reverify_mismatch: stored ${expectedPrefix}… vs actual bytes differ`
          : 'download_reverify_oversize: object exceeds the recording size cap';

        // ── Atomic quarantine (F-B repair) ───────────────────────────
        // The flag flip + exactly-one mismatch event are transactionally
        // atomic via the service-role-only RPC. CAS + FOR UPDATE lock
        // ensure at most one caller flips the flag and the unique partial
        // index uq_v2_recording_integrity_events_mismatch_once is the
        // DB-level convergence guard. On RPC failure NO URL is minted;
        // the prior clean state is retryable.
        // F-E: actual digest observed at download is forwarded as
        // evidence; stays inside the service-role-only RPC, never in
        // audit metadata or API response.
        const { data: qData, error: qErr } = await supabase.rpc(
          'quarantine_recording',
          {
            p_session_id: sessionId,
            p_reason: reason,
            p_expected_sha256: session.recording_sha256,
            p_actual_sha256: actualSha256,
            p_size_bytes: session.recording_size_bytes ?? null,
            p_correlation_id: getCorrelationId() ?? null,
          },
        );
        if (qErr) {
          // RPC failure — leave prior state intact, no URL.
          return res
            .status(500)
            .json({ error: { type: 'internal_error', message: 'Failed to verify recording integrity' } });
        }
        const qStatus = (qData as any)?.status;
        if (qStatus !== 'quarantined' && qStatus !== 'already_quarantined') {
          return res
            .status(500)
            .json({ error: { type: 'internal_error', message: 'Failed to verify recording integrity' } });
        }

        // Audit (fail-open: denial, not a write — immutable event already durable).
        if (qStatus === 'quarantined') {
          await recordAudit(req, 'recording.quarantined', 409, {
            metadata: {
              session_id: sessionId,
              reason: mismatch ? 'download_reverify_mismatch' : 'download_reverify_oversize',
              sha256_prefix: (session.recording_sha256 ?? '').slice(0, 12),
            },
          }).catch(() => {/* fail-open: denial + event already durable */});
        }
        return res.status(409).json({
          error: { type: 'recording_quarantined', message: 'Recording integrity verification failed' },
        });
      }

      // ── LANE L6 (REC-01 buildable half + erasure entry seam) ─────
      // L6 owns (lib/retention.ts, NOT this file):
      //   - SHA-256 integrity primitive + reduced-WebM-limit constants
      //     (REC-01 buildable half; LiveKit Egress MP3 primary path stays
      //     external-pending — see docs/runbooks/phase7-recording.md). The
      //     constants live at module scope below (RECORDING_INTEGRITY_* /
      //     RECORDING_SECONDARY_DEGRADED_MAX_BYTES) so a future Egress path
      //     can consume them without touching this L5-owned gate.
      //   - Erasure entry hook: eraseRecording() in lib/retention.ts is the
      //     ONLY entry point for recording-object erasure. It is legal-hold /
      //     erasure-exception aware (fail-closed, reusing the existing
      //     exported helpers) and tombstones via recording_deleted_at +
      //     NULL recording_object_key against SYNTHETIC storage. The gate
      //     above (L5-owned) already honours that tombstone with a 404, so
      //     an erased recording can never be re-minted or re-downloaded.
      //     No erasure HTTP endpoint is wired here — the hook is the
      //     exported lib seam an operator/worker would call.
      // ───────────────────────────────────────────────────────────────

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

// ── POST /api/recordings/:sessionId/revoke ───────────────────────────
// REC-05 (F2 repair): authenticated ADMIN-ONLY revocation trigger.
//   - Sets recording_revoked_at (CAS-guarded: only the first caller flips it),
//     appends EXACTLY ONE 'revoked' integrity event (unique partial index
//     enforces exactly-once; a retry backfills a missing event), and the
//     route audits recording.revoked ONLY on the transition — a retry that
//     converges to already_revoked creates no duplicate success evidence.
//   - Both mint paths (recruiter download + candidate grant) already return
//     403 before createSignedUrl while recording_revoked_at is set — no
//     route change needed there; this endpoint is the write path that makes
//     REC-05 buildable-now.
//   - Anti-enumeration/RBAC mirrors the legal-hold routes: non-admins get a
//     uniform 403; unknown sessions 404; body reason is bounded (<=200).

recordingsRouter.post(
  '/:sessionId/revoke',
  requireRole('admin'),
  validateParams(recordingRevokeParamSchema),
  validateBody(recordingRevokeBodySchema),
  async (req, res, next) => {
    try {
      const sessionId = req.params.sessionId;
      const user = req.authUser!;
      const reason =
        typeof (req.body as { reason?: unknown } | undefined)?.reason === 'string'
          ? (req.body as { reason: string }).reason
          : null;

      const result = await revokeRecording(sessionId, user.id, {
        reason: reason ?? undefined,
      });

      if (result.status === 'not_found') {
        return res.status(404).json({ error: { type: 'not_found', message: 'Recording not found' } });
      }
      if (result.status === 'failed_update' || result.status === 'failed_event') {
        // Fail-closed: the mutation did not converge; caller retries.
        return next(new Error('recording revocation failed'));
      }

      // Security-relevant write audit — only on the transition/backfill, so a
      // retry that sees already_revoked never duplicates success evidence.
      if (result.status === 'revoked') {
        await recordAudit(req, 'recording.revoked', 200, {
          metadata: {
            session_id: sessionId,
            revoked_at: result.revokedAt ?? undefined,
            reason: reason ?? undefined,
            backfilled: result.backfilled ?? false,
          },
        }).catch(() => {/* sink failure logged; revocation already durable */});
      }

      return res.json({
        ok: true,
        status: result.status,
        revoked_at: result.revokedAt,
      });
    } catch (error) {
      next(error);
    }
  },
);
