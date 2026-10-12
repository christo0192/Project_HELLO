/**
 * Legal-hold lookups for the R1 recording lane (retention, withdrawal, DSAR, purge).
 *
 * A recording is protected by a hold on its CANDIDATE, its SESSION (= the attempt's `session_id`) or the
 * RECORDING itself (entity id = `session_id`; `legal_holds.entity_type = 'recording'`). A hold is active
 * while `released_at` is NULL, exactly like `retention.ts` `isUnderLegalHold`.
 *
 * Unlike that helper this one FAILS CLOSED: a read error throws instead of answering "no hold".
 * Erasing is irreversible, so an unreadable hold table must stop the erase (the job retries) rather
 * than let it proceed. The legal-hold check for the DSAR candidate/session gates still runs in
 * `dsar.ts`; this adds the `recording` entity type for R1 rows and re-checks the rest per recording.
 */

import type { LegalHold } from '../../retention.js';
import type { R1DbClient } from '../../../services/r1-assessment.js';
import { R1RecordingDbError } from './service.js';

export type R1HoldEntity = { readonly type: 'candidate' | 'session' | 'recording'; readonly id: string };

export interface R1ActiveHold {
  readonly id: string;
  readonly entity_type: R1HoldEntity['type'];
  readonly entity_id: string;
  readonly hold_reason: string;
  readonly hold_source: LegalHold['holdSource'];
  readonly placed_by: string;
  readonly placed_at: string;
  readonly expires_at: string | null;
  readonly metadata: Record<string, unknown> | null;
}

/** Active holds on any of `entities` (one small query each). Throws {@link R1RecordingDbError} on a read error. */
export async function findActiveHolds(db: R1DbClient, entities: readonly R1HoldEntity[]): Promise<R1ActiveHold[]> {
  const out: R1ActiveHold[] = [];
  for (const entity of entities) {
    const { data, error } = await db
      .from('legal_holds')
      .select('id,entity_type,entity_id,hold_reason,hold_source,placed_by,placed_at,expires_at,metadata')
      .eq('entity_type', entity.type)
      .eq('entity_id', entity.id)
      .is('released_at', null);
    if (error) throw new R1RecordingDbError();
    for (const row of Array.isArray(data) ? data : []) out.push(row as R1ActiveHold);
  }
  return out;
}

/** The `LegalHold` shape the DSAR route answers with. */
export function toLegalHold(hold: R1ActiveHold): LegalHold {
  return {
    id: hold.id,
    entityType: hold.entity_type,
    entityId: hold.entity_id,
    holdReason: hold.hold_reason,
    holdSource: hold.hold_source,
    placedBy: hold.placed_by,
    placedAt: hold.placed_at,
    releasedAt: null,
    releasedBy: null,
    releaseReason: null,
    expiresAt: hold.expires_at ?? null,
    metadata: hold.metadata ?? null,
  };
}
