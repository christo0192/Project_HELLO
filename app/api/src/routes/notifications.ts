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
import type {
  NotificationIntentListResponse,
  NotificationIntentResponse,
} from '../schemas/notifications.js';

export const notificationsRouter = Router();

/**
 * GET /api/notifications
 * Recruiter status query — own/authorized intents only, bounded to the
 * latest 100. Internal identifiers (idempotency_key) and contact material
 * are never exposed.
 */
notificationsRouter.get('/', requireInterviewer, async (req, res, next) => {
  try {
    const user = req.authUser!;
    let q = supabase
      .from('notification_intents')
      .select('id, kind, candidate_id, consent_verified, created_at')
      .order('created_at', { ascending: false })
      .limit(100);

    if (user.appRole === 'interviewer') {
      const { data: owned, error: ownedErr } = await supabase
        .from('candidates')
        .select('id')
        .eq('owner_id', user.id);
      if (ownedErr) return next(new Error('failed to load candidate scope'));
      const ids = (owned ?? []).map((r) => r.id as string);
      if (ids.length === 0) {
        const empty: NotificationIntentListResponse = { intents: [] };
        return res.json(empty);
      }
      q = q.in('candidate_id', ids);
    }

    const { data, error } = await q;
    if (error) return next(new Error('failed to list notification intents'));

    const intents: NotificationIntentResponse[] = (data ?? []).map((i) => ({
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
