import { z } from 'zod';
import { zod3Uuid } from '../lib/zod-compat.js';

/**
 * UUID string validation: 8-4-4-4-12 hex, any version/variant (zod 3's
 * `.uuid()` and Postgres `uuid` acceptance; see lib/zod-compat.ts).
 */
export const uuidSchema = zod3Uuid('must be a valid UUID').describe('UUID identifier');

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
