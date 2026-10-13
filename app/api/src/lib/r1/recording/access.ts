/**
 * Who may play an R1 recording (IMPLEMENTER-RULES C6): exactly the people who could open the
 * candidate's detail page.
 *
 *   admin, viewer   any candidate
 *   interviewer     only a candidate they own (`candidates.owner_id = user.id`)
 *   inactive user   nobody (refused here as well as by `requireAuth`)
 *
 * This deliberately mirrors `candidateAccess(write=false)` in `routes/r1.ts` and the candidate-detail
 * visibility rule, and NOT `roundAccess` (creator-based, stricter): an interviewer who owns the
 * candidate but did not send the round must be able to play what the rounds list shows them. The
 * logic is copied, not imported, because `candidates.ts` and `r1.ts` are hot shared files.
 */

import type { R1DbClient } from '../../../services/r1-assessment.js';

export interface R1StaffActor {
  readonly id: string;
  readonly appRole: 'admin' | 'interviewer' | 'viewer';
  readonly active: boolean;
}

export type R1StaffAccess = 'allowed' | 'denied' | 'unavailable';

/** Roles that see every candidate. */
export function seesEveryCandidate(actor: Pick<R1StaffActor, 'appRole'>): boolean {
  return actor.appRole === 'admin' || actor.appRole === 'viewer';
}

/** May this actor read recordings of `candidateId`? `unavailable` = the ownership lookup failed (never guess). */
export async function staffMayReadCandidate(db: R1DbClient, actor: R1StaffActor, candidateId: string): Promise<R1StaffAccess> {
  if (!actor.active) return 'denied';
  if (seesEveryCandidate(actor)) return 'allowed';
  if (actor.appRole !== 'interviewer') return 'denied';
  const { data, error } = await db.from('candidates').select('owner_id').eq('id', candidateId).maybeSingle();
  if (error) return 'unavailable';
  const owner = (data as { owner_id?: unknown } | null)?.owner_id;
  return typeof owner === 'string' && owner === actor.id ? 'allowed' : 'denied';
}
