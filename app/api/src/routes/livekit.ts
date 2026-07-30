import { Router } from 'express';
import multer from 'multer';
import { timingSafeEqual as cryptoTimingSafeEqual } from 'node:crypto';
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
  livekitRecordingBodySchema,
  livekitRecordingParamSchema,
  recordingGrantSchema,
  workerContextSchema,
} from '../schemas/livekit.js';
import { createSession, transitionSession } from '../lib/session-lifecycle.js';
import { getCorrelationId } from '../lib/correlation.js';
import { handleRecordingGrant } from './invites.js';
import { resolveWorkerContext } from '../lib/worker-context.js';

export const livekitRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024, fields: 0, files: 1, parts: 2 },
});

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

livekitRouter.post('/start', validateBody(livekitStartSchema), async (req, res, next) => {
  try {
    requireLiveKit();
    const candidateId = req.body?.candidate_id as string;
    if (!candidateId) return res.status(400).json({ error: 'candidate_id is required' });

    const { data: candidate, error: candErr } = await supabase
      .from('candidates')
      .select('id, name, role_id, owner_id')
      .eq('id', candidateId)
      .single();
    if (candErr || !candidate) return next(new Error('candidate not found'));

    const recruiter = req.authUser;
    if (!recruiter || (recruiter.appRole !== 'admin' && recruiter.appRole !== 'interviewer')) {
      return res.status(403).json({ error: 'access_denied' });
    }
    if (recruiter.appRole === 'interviewer' && candidate.owner_id && candidate.owner_id !== recruiter.id) {
      return res.status(403).json({ error: 'access_denied' });
    }
    if (recruiter.appRole === 'interviewer' && !candidate.owner_id) {
      const { data: claimed, error: claimErr } = await supabase
        .from('candidates')
        .update({ owner_id: recruiter.id })
        .eq('id', candidate.id)
        .is('owner_id', null)
        .select('id');
      if (claimErr || !claimed || claimed.length !== 1) {
        return res.status(409).json({ error: 'candidate_ownership_conflict' });
      }
    }

    // REL-07: insert in `created` state.
    const { data: session, error: insertErr } = await createSession({
      candidate_id: candidate.id,
      role_id: candidate.role_id,
      mode: 'browser',
      provider: 'livekit',
    });
    if (insertErr || !session) return next(insertErr ?? new Error('failed to create session'));

    const { data: ownedSession, error: ownerErr } = await supabase
      .from('call_sessions')
      .update({ owner_id: recruiter.id })
      .eq('id', session.id)
      .is('owner_id', null)
      .select('id');
    if (ownerErr || !ownedSession || ownedSession.length !== 1) {
      await transitionSession(session.id, 'created', 'failed', 'room_create_error');
      return next(new Error('failed to assign session ownership'));
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
    } catch (roomErr) {
      // REL-07: room creation failed — terminate the row.
      const termResult = await transitionSession(
        session.id, 'created', 'failed', 'room_create_error',
      );
      if (!termResult.ok && !termResult.conflict) {
        return next(new Error('room creation failed and session could not be terminated — reconciliation required'));
      }
      return next(roomErr instanceof Error ? roomErr : new Error('LiveKit room creation failed'));
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
        if (cleanupFailed) return next(new Error(baseMsg + ' and orphan room cleanup failed — reconciliation required'));
        return res.status(409).json({ error: baseMsg });
      }
      if (cleanupFailed) return next(new Error('room created but session could not be transitioned and room cleanup failed — reconciliation required'));
      return next(new Error('room created but session could not be transitioned — reconciliation required'));
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
  } catch (error) {
    next(error);
  }
});

// ── POST /api/livekit/:sessionId/recording ───────────────────────────
// SEC-04: Requires recruiter owner or candidate grant bound to session.
//          Uses upsert: false to reject overwrite/replay.

livekitRouter.post(
  '/:sessionId/recording',
  validateParams(livekitRecordingParamSchema),
  upload.single('file'),
  validateBodyFields(livekitRecordingBodySchema),
  requireUploadedFile,
  async (req, res, next) => {
    try {
      const sessionId = req.params.sessionId;
      const file = req.file!;

      // TODO: Integrate recruiter-owner check via injected middleware (Codex).
      // For now, only grant-authenticated uploads are accepted.
      // Cross-session/replay: the grant token binds to exactly one session.
      const grantHeader = req.headers['x-grant-token'];
      const grantToken = typeof grantHeader === 'string' && /^[a-f0-9]{64}$/.test(grantHeader)
        ? grantHeader
        : undefined;
      if (grantToken) {
        const { validateGrant } = await import('../lib/candidate-access.js');
        const validation = await validateGrant(grantToken);
        if (!validation.ok || validation.payload.session_id !== sessionId) {
          return res.status(403).json({ error: 'access_denied' });
        }
      }
      // When no grant AND no recruiter auth → fail closed.
      if (!grantToken) {
        return res.status(401).json({ error: 'authentication_required' });
      }

      const extension = file.mimetype.includes('mpeg')
        ? 'mp3'
        : file.mimetype.includes('mp4')
          ? 'mp4'
          : 'webm';
      const objectKey = `${sessionId}.${extension}`;

      // upsert: false — reject overwrite of existing recordings
      const { error: upErr } = await supabase.storage
        .from(env.recordingsBucket)
        .upload(objectKey, file.buffer, {
          contentType: file.mimetype || 'audio/webm',
          upsert: false,
        });
      if (upErr) return next(upErr);

      // Store object key only — no signed URL persisted
      const { data: updateData, error: updateErr } = await supabase
        .from('call_sessions')
        .update({ recording_object_key: objectKey })
        .eq('id', sessionId)
        .select('id');
      if (updateErr) return next(updateErr);
      if (!updateData || updateData.length === 0) {
        return next(new Error('session not found — recording not linked'));
      }

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

// ── POST /api/livekit/grant/recording ────────────────────────────────

livekitRouter.post(
  '/grant/recording',
  validateBody(recordingGrantSchema),
  async (req, res, next) => {
    try {
      const { grant_token, session_id } = req.body as { grant_token: string; session_id: string };
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
