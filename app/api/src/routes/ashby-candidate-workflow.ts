/**
 * routes/ashby-candidate-workflow.ts — the candidate-scoped, read-only Ashby
 * workflow status API behind the CandidateDetail Overview card.
 *
 * Mounted at /api/candidates (alongside candidatesRouter, which owns `/:id`
 * and never matches `/:id/ashby-workflow`), so it inherits the same global
 * recruiter-auth + viewer-read-only middleware and the same rate limiter as
 * every other candidate read.
 *
 * Access rules are the EXISTING ones, re-applied verbatim — this route grants
 * no new privilege:
 *   - viewer role or above (viewers read everything, as they do on /api/candidates);
 *   - an interviewer sees only candidates they own (`owner_id = auth user`);
 *   - a malformed id, an unknown candidate and an unowned candidate all return
 *     one identical 404 body, so the surface cannot be used to learn that a
 *     candidate — or an Ashby workflow — exists. (The body matches the miss
 *     body of GET /api/candidates/:id; that route answers a MALFORMED id with
 *     a 400 validation error instead, which this route deliberately does not —
 *     collapsing all four outcomes into one is the stronger contract.)
 *
 * A candidate who simply has no Ashby application link is NOT an error: the
 * route answers 200 with `workflow: null` and the web card renders nothing.
 * That distinction is safe because the caller has already been proven able to
 * see the candidate; it reveals only whether a candidate they already read is
 * Ashby-linked.
 *
 * Read-only by construction: nothing here mutates, mints a token, or contacts
 * Ashby, and there is no retry/cancel/stage control anywhere on this surface.
 * Mission Control remains the only place those actions exist.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { supabase } from '../lib/supabase.js';
import { requireRole } from '../lib/rbac.js';
import { uuidSchema } from '../schemas/common.js';
import {
  createCandidateWorkflowStore,
  type CandidateAshbyWorkflowStore,
  type CandidateAshbyWorkflowView,
} from '../integrations/ashby/candidate-workflow.js';

/** Identical to the GET /api/candidates/:id *miss* body — deliberately. */
export const CANDIDATE_NOT_FOUND = { error: 'Candidate not found' } as const;

export interface AshbyCandidateWorkflowDeps {
  /** Injected projection store (tests). Production builds it from the service client. */
  store?: CandidateAshbyWorkflowStore;
}

/**
 * Shared response body builder for BOTH scoped surfaces (candidate id and
 * Ashby application link).
 *
 * `load` is the caller's already-scoped read — a candidate-addressed surface
 * passes the candidate read, a link-addressed one passes the link read, so
 * each reports the workflow it was actually addressed with. Every caller must
 * have resolved access under the same role/ownership rules FIRST; this helper
 * performs no authorization.
 */
export async function respondCandidateWorkflow(
  load: () => Promise<CandidateAshbyWorkflowView | null>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const workflow = await load();
    res.json({ ok: true, workflow });
  } catch {
    // Sanitized, retryable 500 — never "removed or no access", which would
    // misreport a database blip as an authorization outcome.
    next(new Error('failed to load ashby workflow'));
  }
}

export function createAshbyCandidateWorkflowRouter(deps: AshbyCandidateWorkflowDeps = {}): Router {
  const router = Router();
  let cached: CandidateAshbyWorkflowStore | undefined = deps.store;
  const store = (): CandidateAshbyWorkflowStore => {
    if (!cached) cached = createCandidateWorkflowStore(supabase as never);
    return cached;
  };

  router.get(
    '/:id/ashby-workflow',
    requireRole('viewer'),
    async (req: Request, res: Response, next: NextFunction) => {
      const parsed = uuidSchema.safeParse(req.params.id);
      if (!parsed.success) {
        res.status(404).json(CANDIDATE_NOT_FOUND);
        return;
      }

      // Re-apply the candidates-route scope: interviewers only own records.
      let q = supabase.from('candidates').select('id').eq('id', parsed.data);
      if (req.authUser?.appRole === 'interviewer') {
        q = q.eq('owner_id', req.authUser.id);
      }
      const { data: candidate, error } = await q.maybeSingle();
      if (error) {
        next(new Error('failed to resolve candidate'));
        return;
      }
      if (!(candidate as { id?: string } | null)?.id) {
        res.status(404).json(CANDIDATE_NOT_FOUND);
        return;
      }

      await respondCandidateWorkflow(() => store().getForCandidate(parsed.data), res, next);
    },
  );

  return router;
}

/** Production instance. */
export const ashbyCandidateWorkflowRouter = createAshbyCandidateWorkflowRouter();
