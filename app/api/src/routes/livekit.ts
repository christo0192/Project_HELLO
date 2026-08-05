import { Router } from 'express';
import multer from 'multer';
import { createHash, randomUUID, timingSafeEqual as cryptoTimingSafeEqual } from 'node:crypto';
import { RoomServiceClient } from 'livekit-server-sdk';
import { supabase } from '../lib/supabase.js';
import { env } from '../lib/env.js';
import {
  requireUploadedFile,
  validateBody,
  validateBodyFields,
  validateParams,
} from '../lib/validation.js';
import {
  livekitStartSchema,
  recordingGrantSchema,
  workerContextSchema,
} from '../schemas/livekit.js';
import {
  recordingUploadParamSchema,
  recordingUploadBodySchema,
  RECORDING_MAX_BYTES_DEFAULT,
  RECORDING_MAX_BYTES_HARD_MAX,
} from '../schemas/recordings.js';
import { guardAudioUpload, UploadGuardError } from '../lib/upload-guard.js';
import { resolveScanner } from '../lib/malware-scanner.js';
import { recordAudit } from '../lib/audit.js';
import { extractBearerToken, resolveFullAuth } from '../lib/auth.js';
import type { AuthUser } from '../lib/auth.js';
import { createSession, transitionSession } from '../lib/session-lifecycle.js';
import { getCorrelationId } from '../lib/correlation.js';
import { handleRecordingGrant } from './invites.js';
import { runAssessment } from '../services/assessment.js';
import { resolveWorkerContext } from '../lib/worker-context.js';
import {
  finalizeAuthoritativeRecording,
  startAuthoritativeRecording,
  type RecordingFinalizeStatus,
} from '../lib/recording-egress.js';
import { createMaintenanceMiddleware } from '../lib/maintenance.js';
import {
  extractIdempotencyKey,
  quotaEnforcementEnabled,
  reserveQuota,
  ResponseSentError,
  runWithQuotaReservation,
} from '../lib/quota.js';

export const livekitRouter = Router();

/**
 * REC-03 (C-3, PROPOSED): reduced bounded browser audio-upload cap.
 * env.recordingMaxBytes = RECORDING_MAX_BYTES (default 25 MiB, hard max 50 MiB)
 * — strictly below the old 100 MB multer cap. Multer rejects oversize with
 * LIMIT_FILE_SIZE → 413 BEFORE the body is fully buffered. This bounds memory;
 * it is NOT constant-memory streaming (the fail-closed scanner + magic-byte
 * validator require the in-memory buffer). PROPOSED: no Product/SRE/Legal
 * sign-off implied.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.recordingMaxBytes,
    fields: 0,
    files: 1,
    parts: 2,
  },
});
// Keep the PROPOSED constants reachable for documentation/tests.
void RECORDING_MAX_BYTES_DEFAULT;
void RECORDING_MAX_BYTES_HARD_MAX;

function requireLiveKit() {
  if (!env.livekitUrl || !env.livekitApiKey || !env.livekitApiSecret) {
    throw new Error(
      'LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET must be set in app/api/.env',
    );
  }
}

// ── Minimal metadata (no PII) ────────────────────────────────────────

function buildMinimalRoomMetadata(sessionId: string, roomName: string): string {
  return JSON.stringify({
    session_id: sessionId,
    room_name: roomName,
    correlation_id: getCorrelationId() ?? undefined,
  });
}

// ── Worker-context bearer credential from env ────────────────────────
// Pending FND-05/FND-06 for operational worker identity.
function workerCredential(): string | null {
  const raw = process.env.WORKER_CONTEXT_SECRET;
  return raw && raw.length >= 32 ? raw : null;
}

function credentialsEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return cryptoTimingSafeEqual(bufA, bufB);
}

/**
 * Require a valid worker bearer credential in Authorization header.
 * Uses timing-safe comparison. Rejects unauthenticated requests.
 */
function requireWorkerAuth(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction): void {
  const configuredCredential = workerCredential();
  if (!configuredCredential) {
    // Credential not configured — deny closed.
    res.status(503).json({ ok: false, error: 'worker_auth_not_configured' });
    return;
  }
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    res.status(401).json({ ok: false, error: 'authentication_required' });
    return;
  }
  const token = auth.slice(7);
  if (!credentialsEqual(token, configuredCredential)) {
    res.status(403).json({ ok: false, error: 'access_denied' });
    return;
  }
  next();
}

// ── POST /api/livekit/start ──────────────────────────────────────────
// SEC-04: Returns room creation result WITHOUT a candidate join token.
//          Candidate join token is only available through successful
//          one-time invite exchange → grant flow.
// The recruiter receives session/room metadata to share the invite.
//
// Phase 9 L2 (invariant 10/11): gated by the fail-closed maintenance guard
// for NEW work, and — when quota enforcement is configured (at least one
// enabled quota_policy) — requires a bounded Idempotency-Key header,
// reserves a slot BEFORE session creation, commits after success, and
// releases on any failure (compensation). When no quota policy is enabled
// (the default), legacy start behavior is preserved. Active-call turn/
// finalization behavior is untouched.

livekitRouter.post(
  '/start',
  validateBody(livekitStartSchema),
  createMaintenanceMiddleware({ allowAdmin: true }),
  async (req, res, next) => {
    try {
      requireLiveKit();
      const candidateId = req.body?.candidate_id as string;
      if (!candidateId) return res.status(400).json({ error: 'candidate_id is required' });

      // Maintenance guard already ran (fail-closed on DB read). Check whether
      // quota enforcement is configured (policies disabled by default).
      const enforcement = await quotaEnforcementEnabled();
      if (!enforcement.ok) {
        // DB read failure → fail closed for new work.
        return res.status(503).json({ error: 'service_unavailable' });
      }

      // Legacy (quota-unconfigured) path: unchanged start behavior.
      const run = async (): Promise<void> => {
        const { data: candidate, error: candErr } = await supabase
          .from('candidates')
          .select('id, name, role_id, owner_id')
          .eq('id', candidateId)
          .single();
        if (candErr || !candidate) throw new Error('candidate not found');

        const recruiter = req.authUser;
        if (!recruiter || (recruiter.appRole !== 'admin' && recruiter.appRole !== 'interviewer')) {
          res.status(403).json({ error: 'access_denied' });
          throw new ResponseSentError();
        }
        if (recruiter.appRole === 'interviewer' && candidate.owner_id && candidate.owner_id !== recruiter.id) {
          res.status(403).json({ error: 'access_denied' });
          throw new ResponseSentError();
        }
        if (recruiter.appRole === 'interviewer' && !candidate.owner_id) {
          const { data: claimed, error: claimErr } = await supabase
            .from('candidates')
            .update({ owner_id: recruiter.id })
            .eq('id', candidate.id)
            .is('owner_id', null)
            .select('id');
          if (claimErr || !claimed || claimed.length !== 1) {
            res.status(409).json({ error: 'candidate_ownership_conflict' });
            throw new ResponseSentError();
          }
        }

        // REL-07: insert in `created` state.
        const { data: session, error: insertErr } = await createSession({
          candidate_id: candidate.id,
          role_id: candidate.role_id,
          mode: 'browser',
          provider: 'livekit',
        });
        if (insertErr || !session) throw new Error('failed to create session');

        const { data: ownedSession, error: ownerErr } = await supabase
          .from('call_sessions')
          .update({ owner_id: recruiter.id })
          .eq('id', session.id)
          .is('owner_id', null)
          .select('id');
        if (ownerErr || !ownedSession || ownedSession.length !== 1) {
          await transitionSession(session.id, 'created', 'failed', 'room_create_error');
          throw new Error('failed to assign session ownership');
        }

        const roomName = `screening-${session.id}`;
        const roomMetadata = buildMinimalRoomMetadata(session.id, roomName);
        const rooms = new RoomServiceClient(env.livekitUrl, env.livekitApiKey, env.livekitApiSecret);

        try {
          try {
            await rooms.createRoom({
              name: roomName,
              emptyTimeout: 10 * 60,
              maxParticipants: 4,
              metadata: roomMetadata,
            });
          } catch {
            await rooms.updateRoomMetadata(roomName, roomMetadata);
          }
          // Start server-authoritative audio capture before anyone joins. In
          // required mode, a storage/egress failure aborts the screening rather
          // than silently creating an unrecorded room.
          await startAuthoritativeRecording(roomName, session.id);
        } catch (roomErr) {
          await rooms.deleteRoom(roomName).catch(() => undefined);
          // REL-07: room/recording creation failed — terminate the row.
          const termResult = await transitionSession(
            session.id, 'created', 'failed', 'room_create_error',
          );
          if (!termResult.ok && !termResult.conflict) {
            throw new Error('room creation failed and session could not be terminated — reconciliation required');
          }
          throw roomErr instanceof Error ? roomErr : new Error('LiveKit room creation failed');
        }

        // REL-07: room is ready — CAS created → waiting.
        const tr = await transitionSession(session.id, 'created', 'waiting', undefined, {
          external_call_id: roomName,
        });
        if (!tr.ok) {
          let cleanupFailed = false;
          try {
            await rooms.deleteRoom(roomName);
          } catch {
            cleanupFailed = true;
          }
          if (tr.conflict) {
            const baseMsg = 'session conflict: already transitioned';
            if (cleanupFailed) throw new Error(baseMsg + ' and orphan room cleanup failed — reconciliation required');
            res.status(409).json({ error: baseMsg });
            throw new ResponseSentError();
          }
          if (cleanupFailed) throw new Error('room created but session could not be transitioned and room cleanup failed — reconciliation required');
          throw new Error('room created but session could not be transitioned — reconciliation required');
        }

        // Candidate status is best-effort.
        {
          const { error: cErr } = await supabase
            .from('candidates')
            .update({ status: 'screening' })
            .eq('id', candidate.id);
          void cErr; // Non-critical
        }

        // SEC-04: NO candidate join token returned here.
        //          Recruiter gets only session/room identifiers.
        res.status(201).json({
          session_id: session.id,
          room_name: roomName,
          url: env.livekitUrl,
        });
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
        requesterId: req.authUser!.id,
        mode: 'live',
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

// ── Recruiter (non-grant) upload auth ────────────────────────────────
// REC-03 (L5): the recording upload route is PUBLIC because grant-token
// uploads carry no bearer credential — the global requireAuth middleware
// therefore never runs for it. For the recruiter path we use the SAME
// shared full-authorization seam as the global middleware
// (resolveFullAuth: bearer token → verified Supabase email → allowlist/
// domain access resolver → server-held role → AAL gate). There is NO
// weaker duplicate implementation — a disabled/missing allowlist entry or
// a non-company email denies here exactly as on every other route.
// The owner check below (admin/viewer any; interviewer must own) is then
// applied against the session row, invariant 5.

type RecruiterAuthResult =
  | { user: AuthUser }
  | { status: 401 | 403; error: string };

async function resolveRecruiterAuth(req: import('express').Request): Promise<RecruiterAuthResult> {
  const token = extractBearerToken(req.headers.authorization);
  if (!token) {
    return { status: 401, error: 'authentication_required' };
  }
  const authResult = await resolveFullAuth(token);
  if (!authResult.ok) {
    return {
      status: authResult.status,
      error: authResult.status === 401 ? 'authentication_required' : 'access_denied',
    };
  }
  return { user: authResult.user };
}

// ── POST /api/livekit/grant/recording ────────────────────────────────
// C-2 route-shadow fix: registered BEFORE POST /:sessionId/recording so the
// literal "grant" segment is never captured by the UUID path-parameter route.
// REC-05/04/06 (L5): a new signed URL is never minted for a deleted (404),
// quarantined (409), or revoked (403) recording — fail-closed, before mint.

livekitRouter.post(
  '/grant/recording',
  validateBody(recordingGrantSchema),
  async (req, res, next) => {
    try {
      const { grant_token, session_id } = req.body as { grant_token: string; session_id: string };

      // ── Revocation/quarantine/deleted gate (REC-05, invariant 7) ──
      // Denies NEW mints within the (short) TTL; existing URLs expire
      // naturally. Never logs object keys/URLs/tokens.
      const { data: session } = await supabase
        .from('call_sessions')
        .select('recording_deleted_at, recording_quarantined, recording_revoked_at')
        .eq('id', session_id)
        .single();
      if (!session) {
        return res.status(404).json({ error: 'not_found' });
      }
      if (session.recording_deleted_at !== null) {
        // REC-06 forward-compat tombstone: erased recordings are gone.
        return res.status(404).json({ error: 'not_found' });
      }
      if (session.recording_quarantined === true) {
        // REC-04: never serve a quarantined object.
        return res.status(409).json({ error: 'recording_quarantined' });
      }
      if (session.recording_revoked_at !== null) {
        // REC-05: revocation denies new mints.
        return res.status(403).json({ error: 'access_denied' });
      }

      const result = await handleRecordingGrant(grant_token, session_id);
      res.json(result);
    } catch (error: any) {
      const statusCode = error.statusCode || 500;
      if (statusCode === 403) {
        return res.status(403).json({ error: 'access_denied' });
      }
      if (statusCode === 404) {
        return res.status(404).json({ error: 'not_found' });
      }
      next(error);
    }
  },
);

async function finalizeRecordingForCompletion(sessionId: string): Promise<RecordingFinalizeStatus> {
  try {
    return await finalizeAuthoritativeRecording(sessionId);
  } catch {
    // A transient provider/storage error is retryable. Do not tell the browser
    // to overwrite an authoritative object that may still be finalizing.
    return 'pending';
  }
}

// ── POST /api/livekit/:sessionId/complete ────────────────────────────
// Candidate grant-authenticated completion path. The browser calls this when
// the candidate leaves the LiveKit room so the session does not remain stuck
// in_progress and the scorecard can be produced.
livekitRouter.post(
  '/:sessionId/complete',
  validateParams(recordingUploadParamSchema),
  async (req, res, next) => {
    try {
      const sessionId = req.params.sessionId;
      const grantHeader = req.headers['x-grant-token'];
      const grantToken = typeof grantHeader === 'string' && /^[a-f0-9]{64}$/.test(grantHeader)
        ? grantHeader
        : undefined;
      if (!grantToken) {
        return res.status(403).json({ error: 'access_denied' });
      }

      const { validateGrant } = await import('../lib/candidate-access.js');
      const validation = await validateGrant(grantToken);
      if (!validation.ok || validation.payload.session_id !== sessionId) {
        return res.status(403).json({ error: 'access_denied' });
      }

      const { data: session, error: sessionErr } = await supabase
        .from('call_sessions')
        .select('status, started_at')
        .eq('id', sessionId)
        .single();
      if (sessionErr || !session) {
        return res.status(404).json({ error: 'not_found' });
      }

      if (session.status === 'completed') {
        const recordingStatus = await finalizeRecordingForCompletion(sessionId);
        return res.status(202).json({
          status: 'already_completed',
          recording_status: recordingStatus,
        });
      }
      if (session.status !== 'in_progress') {
        return res.status(409).json({ error: 'session_not_completable' });
      }

      const startedAt = session.started_at ? new Date(session.started_at).getTime() : Date.now();
      const durationSec = Math.max(0, Math.min(86_400, Math.floor((Date.now() - startedAt) / 1000)));
      const completed = await transitionSession(
        sessionId,
        'in_progress',
        'completed',
        'conversation_complete',
        { duration_sec: durationSec },
      );
      if (!completed.ok && !completed.conflict) {
        return next(new Error('session completion failed'));
      }

      // Best-effort delayed scoring trigger so final worker transcript writes
      // have time to land before assessment. If scoring fails, the completed
      // session remains durable and admin/reconciler can retry.
      if (completed.ok) {
        setTimeout(() => {
          runAssessment(sessionId).catch(() => undefined);
        }, 8_000).unref?.();
      }
      const recordingStatus = await finalizeRecordingForCompletion(sessionId);
      return res.status(202).json({
        status: completed.ok ? 'completed' : 'already_completed',
        recording_status: recordingStatus,
      });
    } catch (error) {
      next(error);
    }
  },
);

// ── POST /api/livekit/:sessionId/recording ───────────────────────────
// REC-03/04/01/05 (L5): hardened secondary browser upload path.
//   - reduced bounded multer cap (C-3) → 413 pre-buffer
//   - grant-token OR recruiter-owner auth (closes the owner TODO)
//   - per-session quota (one recording per session) → 409, upsert:false
//   - guardAudioUpload magic-byte/MIME/extension/polyglot → 415
//   - resolveScanner fail-closed → 422; EICAR always rejected
//   - SHA-256 computed & persisted at upload; at-rest tampering is
//     detected on DOWNLOAD (re-hash vs recording_sha256) → quarantine
//   - recording_integrity_events appended; audit recording.upload

livekitRouter.post(
  '/:sessionId/recording',
  validateParams(recordingUploadParamSchema),
  upload.single('file'),
  validateBodyFields(recordingUploadBodySchema),
  requireUploadedFile,
  async (req, res, next) => {
    try {
      const sessionId = req.params.sessionId;
      const file = req.file!;
      let user = req.authUser;

      // ── Auth: grant-token XOR recruiter-owner (SEC-04/REC-03) ────
      const grantHeader = req.headers['x-grant-token'];
      const grantToken = typeof grantHeader === 'string' && /^[a-f0-9]{64}$/.test(grantHeader)
        ? grantHeader
        : undefined;
      let grantOk = false;
      if (grantToken) {
        const { validateGrant } = await import('../lib/candidate-access.js');
        const validation = await validateGrant(grantToken);
        // Grant binds exactly one session (invariant 4).
        if (!validation.ok || validation.payload.session_id !== sessionId) {
          return res.status(403).json({ error: 'access_denied' });
        }
        grantOk = true;
      }
      if (!grantOk) {
        // Recruiter (non-grant) upload — verify the bearer token in-route
        // (owner check below against the session row, invariant 5).
        const auth = await resolveRecruiterAuth(req);
        if ('status' in auth) {
          return res.status(auth.status).json({ error: auth.error });
        }
        user = auth.user;
      }

      // ── Fetch session for preflight gates in one query (F-D repair) ─
      const { data: session, error: sessionErr } = await supabase
        .from('call_sessions')
        .select('owner_id, recording_object_key, recording_egress_id, recording_egress_status, recording_deleted_at, recording_revoked_at, recording_quarantined')
        .eq('id', sessionId)
        .single();
      if (sessionErr || !session) {
        return res.status(404).json({ error: 'not_found' });
      }

      // Recruiter-owner shape (admin/viewer any; interviewer must own).
      if (!grantOk) {
        const isAdminOrViewer = user!.appRole === 'admin' || user!.appRole === 'viewer';
        const isOwningInterviewer =
          user!.appRole === 'interviewer' &&
          !!session.owner_id &&
          session.owner_id === user!.id;
        if (!isAdminOrViewer && !isOwningInterviewer) {
          return res.status(403).json({ error: 'access_denied' });
        }
      }

      // ── Preflight terminal-state gates (F-D repair) ───────────────
      // Reject BEFORE storage upload to avoid needless orphan work.
      // Order: deleted (404), quarantined (409), revoked (403).
      if (session.recording_deleted_at) {
        return res.status(404).json({ error: 'not_found' });
      }
      if (session.recording_quarantined === true) {
        return res.status(409).json({ error: 'recording_quarantined' });
      }
      if (session.recording_revoked_at) {
        return res.status(403).json({ error: 'access_denied' });
      }

      // ── Egress-precedence gate (I‑2): browser upload is accepted only
      // when the server has declared fallback: egress disabled, no
      // recording_egress_id, or recording_egress_status='failed'.
      // pending is never a licence to upload.
      if (session.recording_egress_id && session.recording_egress_status !== 'failed') {
        await recordAudit(req, 'recording.upload', 409, {
          metadata: { session_id: sessionId, result: 'egress_authoritative' },
        }).catch(() => {/* fail-open */});
        return res.status(409).json({ error: 'authoritative_recording_pending' });
      }

      // ── Quota / replay (invariant 4): one recording per session ──
      if (session.recording_object_key) {
        return res.status(409).json({ error: 'recording_already_exists' });
      }

      // ── Audio content validation (REC-03, invariant 2) ───────────
      let ext: string;
      try {
        const audio = guardAudioUpload(
          file.buffer,
          file.mimetype || 'audio/webm',
          file.originalname,
          env.recordingMaxBytes,
        );
        ext = audio.ext;
      } catch (guardErr) {
        if (guardErr instanceof UploadGuardError) {
          return res.status(415).json({
            error: {
              type: 'unsupported_media_type',
              message: guardErr.message,
              details: [{ field: 'file', code: guardErr.code, message: guardErr.message }],
            },
          });
        }
        throw guardErr;
      }

      // Unique-per-attempt object key so a compensation failure does
      // not block retries (F-A repair). The RPC CAS below ensures at
      // most one attempt is linked to the session.
      const objectKey = `${sessionId}-${randomUUID().slice(0, 8)}.${ext}`;

      // ── Malware scan, fail-closed (REC-03, invariant 3) ──────────
      const scanner = resolveScanner(process.env.NODE_ENV ?? 'development');
      const scan = await scanner.scan(file.buffer);
      if (!scan.safe) {
        await recordAudit(req, 'recording.upload', 422, {
          metadata: { session_id: sessionId, result: 'malware_rejected', scanner: scanner.name },
        }).catch(() => {/* fail-open: denial must not 500 */});
        return res.status(422).json({
          error: { type: 'malware_detected', message: 'Recording failed malware scan' },
        });
      }

      // ── Integrity digest (REC-04, invariant 6) ───────────────────
      // The digest is computed over the bytes about to be stored and
      // persisted with the object. NOTE (F1 repair): a persisted-digest
      // comparison on the UPLOAD path is deliberately NOT attempted — it is
      // unreachable (the quota gate above rejects any session that already
      // has a recording_object_key, so recording_sha256 is always NULL
      // here) and its "expected" value would be uploader-controlled anyway.
      // At-rest tampering is detected on the DOWNLOAD path instead, where
      // the stored bytes are fetched, re-hashed server-side and compared to
      // recording_sha256 before any signed URL is minted (see
      // lib/recording-integrity.ts + routes/recordings.ts).
      const sha256 = createHash('sha256').update(file.buffer).digest('hex');

      // ── Store (upsert:false — unique key per attempt, F-A repair) ─
      // The key includes a random suffix so a compensation failure on
      // the RPC below does not block retries. The RPC CAS is the real
      // guard: at most one upload can be linked per session.
      const { error: upErr } = await supabase.storage
        .from(env.recordingsBucket)
        .upload(objectKey, file.buffer, {
          contentType: file.mimetype || 'audio/webm',
          upsert: false,
        });
      if (upErr) return next(upErr);

      // ── Atomic finalization (F-A repair) ──────────────────────────
      // DB link + exactly-one 'uploaded' integrity event are
      // transactionally atomic via the service-role-only RPC. CAS
      // guarantees exactly one caller wins; the FOR UPDATE lock
      // serialises concurrent uploads.
      const { data: rpcData, error: rpcErr } = await supabase.rpc(
        'finalize_recording_upload',
        {
          p_session_id: sessionId,
          p_object_key: objectKey,
          p_sha256: sha256,
          p_size_bytes: file.buffer.length,
          p_content_type: file.mimetype || 'audio/webm',
          p_provenance: 'browser_upload',
          p_correlation_id: getCorrelationId() ?? null,
        },
      );

      if (rpcErr || !rpcData || (rpcData as any).status !== 'ok') {
        // ── Compensate: delete orphaned storage object ────────────
        // The RPC left the session row untouched; the storage object
        // is orphaned. Delete it so a retry starts clean.
        const { error: removeErr } = await supabase.storage
          .from(env.recordingsBucket)
          .remove([objectKey]);
        if (removeErr) {
          // Compensation failed — record orphan in BACKEND-ONLY table (F-C).
          // NEVER store object_key in recruiter-readable integrity_events;
          // NEVER use event_type='uploaded' (would block retry via unique
          // partial index). The orphan table has zero authenticated/anon
          // policy — service_role only. Unique constraint on object_key
          // makes this idempotent (upsert-safe).
          try {
            await supabase.from('recording_orphaned_objects').upsert(
              {
                session_id: sessionId,
                object_key: objectKey,
                sha256,
                size_bytes: file.buffer.length,
                content_type: file.mimetype || 'audio/webm',
                status: 'pending_cleanup',
                error_detail: `RPC ${(rpcData as any)?.status || rpcErr?.message || 'unknown'}`,
                correlation_id: getCorrelationId() ?? null,
                updated_at: new Date().toISOString(),
              },
              { onConflict: 'object_key' },
            );
          } catch {
            // Orphan-row write also failed — bucket-manifest reconciliation
            // is the residual gate (documented in runbook). No URL minted.
          }
        }
        return next(
          new Error(
            `recording finalization failed: ${(rpcData as any)?.status || rpcErr?.message || 'unknown'}`,
          ),
        );
      }

      // ── Audit (read-adjacent to durable RPC evidence → fail-open) ─
      // The immutable integrity event + RPC link are already durable;
      // a failed audit row must never turn a successful upload into 500.
      await recordAudit(req, 'recording.upload', 200, {
        metadata: {
          session_id: sessionId,
          sha256_prefix: sha256.slice(0, 12),
          size_bytes: file.buffer.length,
          content_type: file.mimetype || 'audio/webm',
          provenance: 'browser_upload',
        },
      }).catch(() => {/* fail-open: immutable evidence already durable */});

      // Return the object key only — no signed URL is ever persisted/logged.
      res.json({ object_key: objectKey });
    } catch (error) {
      next(error);
    }
  },
);

// ── POST /api/livekit/worker-context ─────────────────────────────────
// HIGH SEC-13: Requires worker bearer credential (env var, timing-safe).

livekitRouter.post(
  '/worker-context',
  requireWorkerAuth,
  validateBody(workerContextSchema),
  async (req, res, next) => {
    try {
      const { session_id, room_name } = req.body as { session_id?: string; room_name?: string };
      if (!session_id || !room_name) {
        return res.status(400).json({ ok: false, error: 'session_id and room_name required' });
      }

      const result = await resolveWorkerContext(session_id, room_name);
      if (!result.ok) {
        const statusCode = result.code === 'ERR_BINDING_MISMATCH' ? 403 : 404;
        return res.status(statusCode).json({ ok: false, error: result.code });
      }

      res.json({ ok: true, context: result.context });
    } catch (error) {
      next(error);
    }
  },
);
