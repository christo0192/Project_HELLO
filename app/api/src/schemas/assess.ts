import { z } from 'zod';

// ── POST /api/assess/:sessionId ───────────────────────────────────

export const assessSessionIdParamSchema = z
  .object({
    sessionId: z.string().uuid('sessionId must be a valid UUID'),
  })
  .strict();

// ── POST /api/assess/:sessionId/rescore ───────────────────────────────
//
// Phase 4: the explicit immutable rescore. `rescore_request_id` is the caller's
// idempotency key — the `uq_assessments_rescore_request` index stores it as a
// `uuid`, so it must be a valid UUID (a repeat of the same id returns the
// existing revision without re-scoring). Required and non-empty; `.strict()`
// rejects any stray keys.
export const rescoreBodySchema = z
  .object({
    rescore_request_id: z.string().uuid('rescore_request_id must be a valid UUID'),
  })
  .strict();
