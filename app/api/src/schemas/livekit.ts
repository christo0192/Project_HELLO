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
    // Browser rooms are `screening-<uuid>`; phone rooms are `phone-<uuid>`.
    // PR #186 made the PHONE worker resolve its prompt context through this
    // route, but the schema still admitted only browser rooms — every phone
    // lookup 400'd at validation, the worker mapped it to context_not_found
    // and failed closed, and the candidate answered to dead silence
    // (2026-08-30, call 26). Both shapes are exact: a prefix and one UUID.
    room_name: z.string().regex(/^(screening|phone)-[0-9a-f-]{36}$/i).max(64),
  })
  .strict();

export const recordingGrantSchema = z
  .object({
    grant_token: z.string().regex(/^[a-f0-9]{64}$/, 'grant_token is invalid'),
    session_id: z.string().uuid('session_id must be a valid UUID'),
  })
  .strict();

export type RecordingGrantInput = z.infer<typeof recordingGrantSchema>;
