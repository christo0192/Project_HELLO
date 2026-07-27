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
