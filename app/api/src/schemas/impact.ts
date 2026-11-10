/**
 * Query parameters of the business-impact reads (M031 S5, API-CONTRACT.md).
 *
 * Every parameter is optional on the summary; the list needs exactly one
 * selector. Anything the contract does not name, a repeated parameter, a date
 * that is not a real IST calendar day, or a window that runs backwards is
 * refused before the database is asked (400 `invalid_filter`).
 */
import { z } from 'zod';
import { uuidSchema } from './common.js';
import {
  IMPACT_MAX_PAGE_SIZE,
  IMPACT_OUTCOMES,
  IMPACT_STEPS,
  IMPACT_VERDICTS,
} from '../lib/impact.js';

/** A real calendar day, YYYY-MM-DD (2026-02-30 is refused). */
function isCalendarDay(value: string): boolean {
  const [y, m, d] = value.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d && y >= 2000 && y <= 2100;
}

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isCalendarDay);
const flag = z.enum(['true', 'false']);
/** Ashby's opaque id rule, as the Mission Control routes use it. */
const stageId = z.string().min(1).max(256).regex(/^[A-Za-z0-9_.:-]+$/);
const positive = (max: number) => z.string().regex(/^[1-9][0-9]{0,6}$/).transform(Number).refine((n) => n <= max);

const windowShape = {
  from: day.optional(),
  to: day.optional(),
  job: uuidSchema.optional(),
};

function windowInOrder(q: { from?: string; to?: string }, ctx: z.RefinementCtx): void {
  if (q.from && q.to && q.from > q.to) ctx.addIssue({ code: 'custom', message: 'from_after_to' });
}

export const impactSummaryQuerySchema = z.object(windowShape).strict().superRefine(windowInOrder);
export type ImpactSummaryQuery = z.infer<typeof impactSummaryQuerySchema>;

export const impactCandidatesQuerySchema = z
  .object({
    ...windowShape,
    step: z.enum(IMPACT_STEPS).optional(),
    verdict: z.enum(IMPACT_VERDICTS).optional(),
    outcome: z.enum(IMPACT_OUTCOMES).optional(),
    leaveStageId: stageId.optional(),
    reachedOnly: flag.optional(),
    dropped: flag.optional(),
    page: positive(1_000_000).optional(),
    pageSize: positive(IMPACT_MAX_PAGE_SIZE).optional(),
  })
  .strict()
  .superRefine((q, ctx) => {
    windowInOrder(q, ctx);
    const selectors = Number(q.step !== undefined)
      + Number(q.verdict !== undefined || q.outcome !== undefined)
      + Number(q.leaveStageId !== undefined);
    if (selectors !== 1) ctx.addIssue({ code: 'custom', message: 'one_selector' });
    if ((q.verdict === undefined) !== (q.outcome === undefined)) ctx.addIssue({ code: 'custom', message: 'verdict_and_outcome' });
    const dropped = q.dropped === 'true';
    // reachedOnly (the default) and dropped are the two halves of one choice.
    if (dropped && q.reachedOnly === 'true') ctx.addIssue({ code: 'custom', message: 'reached_or_dropped' });
    if (q.reachedOnly === 'false' && !dropped) ctx.addIssue({ code: 'custom', message: 'reached_or_dropped' });
    if ((dropped || q.reachedOnly !== undefined) && q.step === undefined) ctx.addIssue({ code: 'custom', message: 'step_only' });
    // Hired is the end: nothing drops from it.
    if (dropped && q.step === 'hired') ctx.addIssue({ code: 'custom', message: 'hired_has_no_drop' });
  });
export type ImpactCandidatesQuery = z.infer<typeof impactCandidatesQuerySchema>;

export const impactExclusionParamsSchema = z.object({ mappingId: uuidSchema }).strict();

/** `excluded`: true leaves the mapping out, false counts it even archived, null is the default. */
export const impactExclusionBodySchema = z.object({ excluded: z.boolean().nullable() }).strict();
