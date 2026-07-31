import { z } from 'zod';

/**
 * MIG-06: Recorder download route parameter schema.
 * Validates the sessionId path parameter as a UUID.
 */
export const recordingDownloadParamSchema = z
  .object({
    sessionId: z.string().uuid('sessionId must be a valid UUID'),
  })
  .strict();

export type RecordingDownloadParams = z.infer<typeof recordingDownloadParamSchema>;

/**
 * REC-03: browser recording upload path-parameter schema (L5).
 * Mirrors the download param contract: sessionId must be a UUID.
 */
export const recordingUploadParamSchema = z
  .object({
    sessionId: z.string().uuid('sessionId must be a valid UUID'),
  })
  .strict();

export type RecordingUploadParams = z.infer<typeof recordingUploadParamSchema>;

/**
 * REC-03: browser recording upload body schema.
 * The audio file itself is carried as a single multipart `file` part that
 * multer streams into memory; there are no JSON body fields. Multipart
 * field-count limits are enforced by multer (fields:0, files:1, parts:2).
 */
export const recordingUploadBodySchema = z.object({}).strict();

export type RecordingUploadBody = z.infer<typeof recordingUploadBodySchema>;

/**
 * REC-05 (F2): recording revocation route path-parameter schema.
 * Mirrors the download/upload param contract: sessionId must be a UUID.
 */
export const recordingRevokeParamSchema = z
  .object({
    sessionId: z.string().uuid('sessionId must be a valid UUID'),
  })
  .strict();

export type RecordingRevokeParams = z.infer<typeof recordingRevokeParamSchema>;

/**
 * REC-05 (F2): recording revocation request body schema.
 * Optional bounded human-readable reason (<= 200 chars after trim).
 * Strict: no unknown fields are accepted.
 */
export const recordingRevokeBodySchema = z
  .object({
    reason: z.string().trim().max(200, 'reason must be at most 200 characters').optional(),
  })
  .strict();

export type RecordingRevokeBody = z.infer<typeof recordingRevokeBodySchema>;

/**
 * REC-03 (PROPOSED): reduced bounded audio upload cap — DEFAULT 25 MiB.
 * PROPOSED: no Product/SRE/Legal sign-off implied. Strictly below the old
 * 100 MB multer cap (C-3). This is NOT constant-memory streaming: the
 * fail-closed scanner + magic-byte validator require the buffer, so the cap
 * bounds memory instead (oversize is rejected pre-buffer by multer → 413).
 * Hard ceiling 50 MiB is enforced by env.ts (RECORDING_MAX_BYTES range).
 */
export const RECORDING_MAX_BYTES_DEFAULT = 25 * 1024 * 1024;
export const RECORDING_MAX_BYTES_HARD_MAX = 50 * 1024 * 1024;
