import { z } from 'zod';

export const livekitStartSchema = z
  .object({
    candidate_id: z.string().uuid('candidate_id must be a valid UUID'),
  })
  .strict();

export type LivekitStartInput = z.infer<typeof livekitStartSchema>;

export const livekitRecordingParamSchema = z
  .object({
    sessionId: z.string().uuid('sessionId must be a valid UUID'),
  })
  .strict();

export const livekitRecordingBodySchema = z.object({}).strict();

/**
 * POST /api/livekit/grant/recording
 * Request a short-lived signed URL for a recording object.
 * Requires a valid candidate access grant or recruiter auth.
 */
export const workerContextSchema = z
  .object({
    session_id: z.string().uuid('session_id must be a valid UUID'),
    room_name: z.string().regex(/^screening-[0-9a-f-]{36}$/i).max(64),
  })
  .strict();

export const recordingGrantSchema = z
  .object({
    grant_token: z.string().regex(/^[a-f0-9]{64}$/, 'grant_token is invalid'),
    session_id: z.string().uuid('session_id must be a valid UUID'),
  })
  .strict();

export type RecordingGrantInput = z.infer<typeof recordingGrantSchema>;
