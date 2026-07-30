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
