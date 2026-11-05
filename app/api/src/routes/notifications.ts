/**
 * Phase 9 L3 — notification intents (recruiter status query only).
 *
 * Invariant 5:
 * - The service helper (lib/notification-intent.ts) inserts pending intents
 *   idempotently (unique key) and never sends.
 * - This recruiter query returns ONLY the caller's own/authorized bounded
 *   intents: admins see all; interviewers see intents for candidates they
 *   own. No contact endpoint, no token material, no idempotency keys.
 * - Candidate-facing delivery is rejected unless channel/template approval
 *   AND consent are explicit — with no approved provider/template it stays
 *   disabled (lib-level gate; no candidate endpoint exists here).
 */

import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { requireInterviewer } from '../lib/rbac.js';
import { chunkIds, mapChunks, readAllPages } from '../lib/id-batches.js';
import type {
  NotificationIntentListResponse,
  NotificationIntentResponse,
} from '../schemas/notifications.js';

export const notificationsRouter = Router();

/** The list is the newest this many intents. */
const INTENT_LIMIT = 100;

/**
 * Hard ceiling on pages of the interviewer's own candidates: 50 pages of
 * POSTGREST_MAX_ROWS is 50,000. Past it the request fails rather than
 * silently leaving out the candidates it could not read.
 */
const OWNED_MAX_PAGES = 50;

const INTENT_COLUMNS = 'id, kind, candidate_id, consent_verified, created_at';

interface IntentRow {
  id: string;
  kind: NotificationIntentResponse['kind'];
  candidate_id: string | null;
  consent_verified: boolean | null;
  created_at: string;
}

/** Newest first; `id` breaks a tie on `created_at` so the order is total. */
function newestFirst(a: IntentRow, b: IntentRow): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The newest INTENT_LIMIT intents for these candidates, or null when any read
 * failed.
 *
 * M026: one `.in('candidate_id', ids)` over every candidate the interviewer
 * owns failed past about 390 ids (lib/id-batches.ts says why). So the ids are
 * read in batches of ID_BATCH_SIZE, each batch answers its own newest
 * INTENT_LIMIT (the overall newest INTENT_LIMIT are always among them), and
 * the batches are merged, sorted newest first and cut to INTENT_LIMIT. The
 * first failed batch stops new ones and fails the request: a partial list
 * would read as "no notifications" for the candidates it left out.
 */
async function newestIntentsFor(candidateIds: readonly string[]): Promise<IntentRow[] | null> {
  const batches = await mapChunks(
    chunkIds(candidateIds),
    async (chunk): Promise<IntentRow[] | null> => {
      try {
        const { data, error } = await supabase
          .from('notification_intents')
          .select(INTENT_COLUMNS)
          .in('candidate_id', chunk)
          .order('created_at', { ascending: false })
          .order('id', { ascending: true })
          .limit(INTENT_LIMIT);
        if (error) return null;
        return (Array.isArray(data) ? data : []) as IntentRow[];
      } catch {
        return null;
      }
    },
    { stopWhen: (rows) => rows === null },
  );
  if (batches.some((rows) => !rows)) return null;
  return (batches as IntentRow[][]).flat().sort(newestFirst).slice(0, INTENT_LIMIT);
}

/**
 * GET /api/notifications
 * Recruiter status query — own/authorized intents only, bounded to the
 * latest 100. Internal identifiers (idempotency_key) and contact material
 * are never exposed.
 */
notificationsRouter.get('/', requireInterviewer, async (req, res, next) => {
  try {
    const user = req.authUser!;
    let data: IntentRow[];

    if (user.appRole === 'interviewer') {
      // Every candidate the interviewer owns, paged past PostgREST's row cap
      // (which would otherwise drop owners' candidates past the first 1000
      // without an error). `id` gives the pages a total order.
      const owned = await readAllPages<{ id: string }>((from, to) => supabase
        .from('candidates')
        .select('id')
        .eq('owner_id', user.id)
        .order('id', { ascending: true })
        .range(from, to), OWNED_MAX_PAGES);
      if (!owned.ok) return next(new Error('failed to load candidate scope'));
      const ids = [...new Set(owned.rows.map((r) => r.id))];
      if (ids.length === 0) {
        const empty: NotificationIntentListResponse = { intents: [] };
        return res.json(empty);
      }
      const newest = await newestIntentsFor(ids);
      if (!newest) return next(new Error('failed to list notification intents'));
      data = newest;
    } else {
      const { data: rows, error } = await supabase
        .from('notification_intents')
        .select(INTENT_COLUMNS)
        .order('created_at', { ascending: false })
        .order('id', { ascending: true })
        .limit(INTENT_LIMIT);
      if (error) return next(new Error('failed to list notification intents'));
      data = (rows ?? []) as IntentRow[];
    }

    const intents: NotificationIntentResponse[] = data.map((i) => ({
      id: i.id,
      kind: i.kind,
      candidate_id: i.candidate_id,
      consent_verified: i.consent_verified === true,
      created_at: i.created_at,
    }));
    const body: NotificationIntentListResponse = { intents };
    res.json(body);
  } catch (error) {
    next(error);
  }
});
