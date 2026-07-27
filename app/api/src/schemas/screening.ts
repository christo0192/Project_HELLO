import { z } from 'zod';
import { idParamSchema } from './common.js';

export const screeningSessionIdParamSchema = idParamSchema;

export const startScreeningSchema = z
  .object({
    candidate_id: z.string().uuid('candidate_id must be a valid UUID'),
  })
  .strict();

export type StartScreeningInput = z.infer<typeof startScreeningSchema>;

export const screeningTurnSchema = z
  .object({
    text: z.string().trim().min(1, 'text is required').max(20_000),
  })
  .strict();

export type ScreeningTurnInput = z.infer<typeof screeningTurnSchema>;
