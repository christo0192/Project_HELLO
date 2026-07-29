import { Router } from 'express';
import multer from 'multer';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { supabase } from '../lib/supabase.js';
import { env } from '../lib/env.js';
import { formatResumeFacts } from '../lib/prompts.js';
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
} from '../schemas/livekit.js';
import type { ScreeningQuestion } from '../lib/types.js';
import { createSession, transitionSession } from '../lib/session-lifecycle.js';
import { getCorrelationId } from '../lib/correlation.js';

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

async function loadCandidateContext(candidateId: string) {
  const { data: candidate, error } = await supabase
    .from('candidates')
    .select('id,name,role_id,skills,parsed')
    .eq('id', candidateId)
    .single();
  if (error || !candidate) throw new Error(`candidate not found: ${error?.message}`);

  let role = null as null | {
    title: string;
    jd: string | null;
    required_skills: string[] | null;
    screening_template: ScreeningQuestion[] | null;
  };
  if (candidate.role_id) {
    const { data } = await supabase
      .from('roles')
      .select('title,jd,required_skills,screening_template')
      .eq('id', candidate.role_id)
      .single();
    role = data as typeof role;
  }

  const parsed = (candidate.parsed as any) ?? {};
  return {
    candidate,
    role,
    metadata: {
      provider: 'livekit',
      candidate_id: candidate.id,
      role_id: candidate.role_id,
      candidate_name: candidate.name,
      role_title: role?.title ?? 'the role',
      role_focus: role?.jd ?? (role?.required_skills ?? []).join(', '),
      resume_facts: formatResumeFacts(parsed),
      screening_template: role?.screening_template ?? [],
    },
  };
}

// POST /api/livekit/start { candidate_id }
livekitRouter.post('/start', validateBody(livekitStartSchema), async (req, res, next) => {
  try {
    requireLiveKit();
    const candidateId = req.body?.candidate_id as string;
    if (!candidateId) return res.status(400).json({ error: 'candidate_id is required' });

    const { candidate, metadata } = await loadCandidateContext(candidateId);

    // REL-07: insert in `created` state.
    const { data: session, error: insertErr } = await createSession({
      candidate_id: candidate.id,
      role_id: candidate.role_id,
      mode: 'browser',
      provider: 'livekit',
    });
    if (insertErr || !session) return next(insertErr ?? new Error('failed to create session'));

    const roomName = `screening-${session.id}`;
    const roomMetadata = JSON.stringify({
      ...metadata,
      session_id: session.id,
      room_name: roomName,
      // Opaque UUID v4 only; worker validates before accepting it.
      correlation_id: getCorrelationId() ?? undefined,
    });
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
        session.id,
        'created',
        'failed',
        'room_create_error',
      );
      if (!termResult.ok && !termResult.conflict) {
        return next(
          new Error('room creation failed and session could not be terminated — reconciliation required'),
        );
      }
      return next(roomErr instanceof Error ? roomErr : new Error('LiveKit room creation failed'));
    }

    // Build token BEFORE activation — token construction can fail (e.g., bad keys)
    // and we don't want to leave a waiting session stranded.
    let tokenJwt: string;
    try {
      const token = new AccessToken(env.livekitApiKey, env.livekitApiSecret, {
        identity: `candidate-${candidate.id}-${session.id.slice(0, 8)}`,
        name: candidate.name ?? 'Candidate',
        metadata: JSON.stringify({ candidate_id: candidate.id, session_id: session.id }),
      });
      token.addGrant({
        room: roomName,
        roomJoin: true,
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
      });
      tokenJwt = await token.toJwt();
    } catch {
      // Token construction or toJwt() failed. Terminate the 'created' row
      // and do NOT create a room (we haven't created one yet at this point).
      const termResult = await transitionSession(
        session.id, 'created', 'failed', 'room_create_error',
      );
      if (!termResult.ok && !termResult.conflict) {
        return next(new Error('token construction failed and session could not be terminated — reconciliation required'));
      }
      return next(new Error('LiveKit token construction failed'));
    }

    // REL-07: room is ready — CAS created → waiting.
    const tr = await transitionSession(session.id, 'created', 'waiting', undefined, {
      external_call_id: roomName,
    });
    if (!tr.ok) {
      // DB error or conflict — surface reconciliation-required.
      // Room cleanup is best-effort.
      let cleanupFailed = false;
      try {
        await rooms.deleteRoom(roomName);
      } catch {
        cleanupFailed = true;
      }

      if (tr.conflict) {
        const baseMsg = 'session conflict: already transitioned';
        if (cleanupFailed) {
          return next(new Error(baseMsg + ' and orphan room cleanup failed — reconciliation required'));
        }
        return res.status(409).json({ error: baseMsg });
      }

      // DB error — unknown state.
      if (cleanupFailed) {
        return next(new Error('room created but session could not be transitioned and room cleanup failed — reconciliation required'));
      }
      return next(new Error('room created but session could not be transitioned — reconciliation required'));
    }

    // Candidate status is best-effort — await+check, not .catch().
    {
      const { error: candErr } = await supabase
        .from('candidates')
        .update({ status: 'screening' })
        .eq('id', candidate.id);
      if (candErr) {
        // Non-critical; documented as best-effort in runbook.
      }
    }

    res.status(201).json({
      session_id: session.id,
      room_name: roomName,
      url: env.livekitUrl,
      token: tokenJwt,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/livekit/:sessionId/recording multipart field "file"
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

      const extension = file.mimetype.includes('mpeg')
        ? 'mp3'
        : file.mimetype.includes('mp4')
          ? 'mp4'
          : 'webm';
      const path = `${sessionId}.${extension}`;
      const { error: upErr } = await supabase.storage
        .from(env.recordingsBucket)
        .upload(path, file.buffer, {
          contentType: file.mimetype || 'audio/webm',
          upsert: true,
        });
      if (upErr) return next(upErr);

      const { data, error: signErr } = await supabase.storage
        .from(env.recordingsBucket)
        .createSignedUrl(path, 60 * 60 * 24 * 365);
      if (signErr || !data?.signedUrl) return next(signErr ?? new Error('sign failed'));

      // Await+check, no .catch()
      const { data: updateData, error: updateErr } = await supabase
        .from('call_sessions')
        .update({ recording_url: data.signedUrl })
        .eq('id', sessionId)
        .select('id');
      if (updateErr) return next(updateErr);
      // If zero rows matched, the session_id is invalid or session was deleted
      if (!updateData || updateData.length === 0) {
        return next(new Error('session not found — recording not linked'));
      }

      res.json({ recording_url: data.signedUrl });
    } catch (error) {
      next(error);
    }
  },
);
