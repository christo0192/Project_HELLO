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
    const { data: session, error: sErr } = await supabase
      .from('call_sessions')
      .insert({
        candidate_id: candidate.id,
        role_id: candidate.role_id,
        mode: 'browser',
        provider: 'livekit',
        status: 'in_progress',
      })
      .select()
      .single();
    if (sErr || !session) return next(sErr ?? new Error('failed to create session'));

    const roomName = `screening-${session.id}`;
    const roomMetadata = JSON.stringify({
      ...metadata,
      session_id: session.id,
      room_name: roomName,
    });
    const rooms = new RoomServiceClient(env.livekitUrl, env.livekitApiKey, env.livekitApiSecret);
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

    await supabase
      .from('call_sessions')
      .update({ external_call_id: roomName })
      .eq('id', session.id);
    await supabase.from('candidates').update({ status: 'screening' }).eq('id', candidate.id);

    res.status(201).json({
      session_id: session.id,
      room_name: roomName,
      url: env.livekitUrl,
      token: await token.toJwt(),
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

      await supabase
        .from('call_sessions')
        .update({ recording_url: data.signedUrl })
        .eq('id', sessionId);
      res.json({ recording_url: data.signedUrl });
    } catch (error) {
      next(error);
    }
  },
);
