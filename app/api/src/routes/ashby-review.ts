/**
 * routes/ashby-review.ts — purpose-built read APIs behind the candidate-scoped
 * Ashby review experience (`/ashby/review/:applicationLinkId`).
 *
 * Mounted AFTER the global recruiter-auth + viewer-read-only middleware, so an
 * unauthenticated caller is already rejected with the middleware 401 contract.
 *
 * Design rules (deliberate, security-relevant):
 *   - The opaque `applicationLinkId` is resolved to a candidate/session
 *     SERVER-SIDE. The client never names the candidate id, and no candidate id
 *     or PII rides in the URL.
 *   - The link grants NO new privilege. The exact interviewer ownership + role
 *     rules used by /api/candidates are re-applied here; an interviewer who
 *     does not own the linked candidate is treated exactly like an unknown
 *     link.
 *   - Malformed ids, unknown links, links with no resolved candidate, and
 *     unowned links ALL return the identical 404 body, so the surface cannot be
 *     used to enumerate which application links exist.
 *   - Read-only: no route here mutates anything, mints a token, or contacts
 *     Ashby. Nothing is logged or audited from these reads, so no opaque link
 *     id or candidate identifier reaches a log or audit row.
 */

import { Router, type Request } from 'express';
import { supabase } from '../lib/supabase.js';
import { requireRole } from '../lib/rbac.js';
import { uuidSchema } from '../schemas/common.js';

export const ashbyReviewRouter = Router();

/** The single indistinguishable failure body for every unresolvable link. */
const NOT_FOUND = { error: 'application_link_not_found' } as const;

/** Bounded note page size — matches the recruiter notes list default. */
const NOTE_LIMIT = 100;

/**
 * Resolve `:applicationLinkId` to the linked candidate id, re-applying the
 * caller's role/ownership scope. Returns null for EVERY failure mode
 * (malformed, unknown, unlinked, unowned) so callers cannot tell them apart.
 */
async function resolveScopedCandidateId(req: Request): Promise<string | null> {
  const parsed = uuidSchema.safeParse(req.params.applicationLinkId);
  if (!parsed.success) return null;

  const { data: link } = await supabase
    .from('ashby_application_links')
    .select('candidate_id')
    .eq('provider', 'ashby')
    .eq('id', parsed.data)
    .maybeSingle();
  const candidateId = (link as { candidate_id: string | null } | null)?.candidate_id ?? null;
  if (!candidateId) return null;

  // Re-apply the candidates-route scope: interviewers only own records.
  let q = supabase.from('candidates').select('id').eq('id', candidateId);
  if (req.authUser?.appRole === 'interviewer') {
    q = q.eq('owner_id', req.authUser.id);
  }
  const { data: candidate } = await q.maybeSingle();
  return (candidate as { id: string } | null)?.id ?? null;
}

/**
 * GET /api/integrations/ashby/review/:applicationLinkId
 *
 * The linked candidate's existing Overview + Review payload — the same
 * `{ candidate, sessions, assessments }` envelope as GET /api/candidates/:id,
 * resolved from the opaque application link instead of a candidate id.
 */
ashbyReviewRouter.get('/:applicationLinkId', requireRole('viewer'), async (req, res, next) => {
  try {
    const candidateId = await resolveScopedCandidateId(req);
    if (!candidateId) return res.status(404).json(NOT_FOUND);

    const { data: candidate, error } = await supabase
      .from('candidates')
      .select('*')
      .eq('id', candidateId)
      .single();
    if (error || !candidate) return res.status(404).json(NOT_FOUND);

    const { data: sessions } = await supabase
      .from('call_sessions')
      .select('*')
      .eq('candidate_id', candidateId)
      .order('started_at', { ascending: false });

    const { data: assessments } = await supabase
      .from('assessments')
      .select('*')
      .eq('candidate_id', candidateId)
      .order('created_at', { ascending: false });

    res.json({ candidate, sessions: sessions ?? [], assessments: assessments ?? [] });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/integrations/ashby/review/:applicationLinkId/notes
 *
 * Read-only append-only recruiter notes for the linked candidate. The scoped
 * experience never writes a note — adding one stays on the normal candidate
 * page, which is unchanged.
 */
ashbyReviewRouter.get('/:applicationLinkId/notes', requireRole('viewer'), async (req, res, next) => {
  try {
    const candidateId = await resolveScopedCandidateId(req);
    if (!candidateId) return res.status(404).json(NOT_FOUND);

    const { data, error } = await supabase
      .from('recruiter_notes')
      .select('id, candidate_id, author_id, note, created_at')
      .eq('candidate_id', candidateId)
      .order('created_at', { ascending: true })
      .limit(NOTE_LIMIT);
    if (error) return next(new Error('failed to list notes'));

    res.json({ notes: data ?? [] });
  } catch (error) {
    next(error);
  }
});
