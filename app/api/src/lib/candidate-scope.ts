/**
 * Which candidates a staff member may open: the candidate page's rule, in one place.
 *
 * `GET /api/candidates/:id` (routes/candidates.ts) has always scoped its read the
 * same way: an interviewer opens only the candidates whose `owner_id` is theirs,
 * and every other role that reaches the route opens every candidate. Any other
 * surface that lists candidates by name must follow exactly that rule, so it
 * cannot show a name the candidate page would refuse (M031 D-M031-5: the
 * business-impact list). Both call this function; neither restates the rule.
 *
 * Pure: no I/O. It answers who may be opened, never whether the caller may use
 * the route at all; that stays with the route's own role guard.
 */
import type { AppRole } from './rbac.js';

export type CandidateScope =
  | { kind: 'all' }
  | { kind: 'owner'; ownerId: string };

export function candidateScope(user: { id: string; appRole: AppRole } | null | undefined): CandidateScope {
  if (user?.appRole === 'interviewer') return { kind: 'owner', ownerId: user.id };
  return { kind: 'all' };
}
