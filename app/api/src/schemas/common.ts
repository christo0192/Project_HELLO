import { z } from 'zod';

/** RFC 4122 UUID string validation. */
export const uuidSchema = z.string().uuid('must be a valid UUID').describe('UUID identifier');

/** Reusable path-param schema for `:id` patterns. */
export const idParamSchema = z.object({ id: uuidSchema }).strict();

/** Reusable path-param schema for `:sessionId` patterns. */
export const sessionIdParamSchema = z.object({ sessionId: uuidSchema }).strict();

/** Schema for optional role_id query parameter. */
export const roleIdQuerySchema = z
  .object({
    role_id: uuidSchema.optional(),
  })
  .strict();
