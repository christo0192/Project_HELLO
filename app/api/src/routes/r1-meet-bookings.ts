/**
 * The HR read of R1-over-Meet bookings (M034 S05, dark): what S10's page lists.
 *
 *   GET /api/interview-rounds/meet-bookings        one keyset page, by slot start
 *   GET /api/interview-rounds/meet-bookings/:id    one booking
 *
 * DARK. While Meet is off (`r1MeetActive`: R1_ENABLED and a valid R1_MEET_ENABLED configuration)
 * nothing is read: the list answers 200 `{ meet_enabled: false, bookings: [], next_cursor: null }`
 * and the detail 404 `not_found`. A 200 rather than an error, so the page can show a calm "Meet
 * scheduling is off" with no error handling and a polled page raises no 503 noise; the detail is a
 * 404 because, as far as this API is concerned, no booking exists while Meet is off. The checks that
 * need no database (the caller's account, the query, the id) still answer first.
 *
 * WHO SEES WHAT. Viewer and above (`requireRole('viewer')`), by the rule of the R1 video, applied as
 * a filter on the read (`lib/r1/meet/bookings-read.ts`): admin and viewer every booking, an
 * interviewer only one whose candidate they own, an inactive account nobody (403 `access_denied`,
 * recorded like the R1 queue's refusal). A list read, so a successful read is not audited, as the
 * queue is not.
 *
 * WHAT LEAVES. Ten fields: id, candidate_id, round_id, status, reason, start_at, end_at, created_at,
 * updated_at, version. Never the Meet URL, a ticket field, an Ashby id, the attester, the Recall bot,
 * the session or the profile. Every answer is `Cache-Control: no-store`.
 *
 * WHY NOT UNDER /api/r1. `/api/r1/*` is the public candidate surface by repo contract: every route
 * there is mounted on the candidate router and public by exact path (`r1-openapi-contract.test.ts`),
 * and the candidate per-IP limiter covers all of it. These are staff reads, so they sit with the R1
 * queue under `/api/interview-rounds`, behind recruiter authentication and that prefix's per-user
 * limiter.
 */

import { Router, type Request, type Response } from 'express';
import { supabase } from '../lib/supabase.js';
import { requireRole } from '../lib/rbac.js';
import { auditAccessDenied } from '../lib/audit.js';
import { getR1Config } from '../lib/r1/config.js';
import { getR1MeetConfig, r1MeetActive } from '../lib/r1/meet/config.js';
import {
  parseR1MeetBookingsQuery,
  readR1MeetBooking,
  readR1MeetBookings,
} from '../lib/r1/meet/bookings-read.js';
import type { R1StaffActor } from '../lib/r1/recording/access.js';
import { toCanonicalUuid } from '../lib/r1/recording/keys.js';

export interface R1MeetBookingsRouterDeps {
  /** The service-role client. Tests pass a double. */
  readonly db?: typeof supabase;
  /** Whether Meet is active. Defaults to `r1MeetActive(getR1Config(), getR1MeetConfig())`, read per request. */
  readonly meetActive?: () => boolean;
}

function staffActor(req: Request): R1StaffActor {
  const user = req.authUser!;
  return { id: user.id, appRole: user.appRole, active: user.active };
}

async function refuseInactive(req: Request, res: Response): Promise<void> {
  await auditAccessDenied(req, 'r1_meet_bookings_access_denied').catch(() => undefined);
  res.status(403).json({ error: 'access_denied' });
}

export function createR1MeetBookingsRouter(deps: R1MeetBookingsRouterDeps = {}): Router {
  const router = Router();
  const db = (): typeof supabase => deps.db ?? supabase;
  const meetActive = deps.meetActive ?? (() => r1MeetActive(getR1Config(), getR1MeetConfig()));

  router.get('/interview-rounds/meet-bookings', requireRole('viewer'), async (req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      const actor = staffActor(req);
      if (!actor.active) return refuseInactive(req, res);
      const query = parseR1MeetBookingsQuery(req.query);
      if (!query) return void res.status(400).json({ error: 'invalid_query' });
      if (!meetActive()) return void res.json({ meet_enabled: false, bookings: [], next_cursor: null });
      const result = await readR1MeetBookings(db(), actor, query);
      if (result.kind === 'forbidden') return refuseInactive(req, res);
      if (result.kind === 'unavailable') return void res.status(503).json({ error: 'service_unavailable' });
      res.json({ meet_enabled: true, bookings: result.bookings, next_cursor: result.nextCursor });
    } catch (error) {
      next(error);
    }
  });

  router.get('/interview-rounds/meet-bookings/:id', requireRole('viewer'), async (req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      const actor = staffActor(req);
      if (!actor.active) return refuseInactive(req, res);
      const bookingId = toCanonicalUuid(req.params.id);
      if (!bookingId) return void res.status(400).json({ error: 'invalid_id' });
      if (!meetActive()) return void res.status(404).json({ error: 'not_found' });
      const result = await readR1MeetBooking(db(), actor, bookingId);
      if (result.kind === 'forbidden') return refuseInactive(req, res);
      if (result.kind === 'not_found') return void res.status(404).json({ error: 'not_found' });
      if (result.kind === 'unavailable') return void res.status(503).json({ error: 'service_unavailable' });
      res.json(result.booking);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export const r1MeetBookingsRouter = createR1MeetBookingsRouter();
