import { Router, type Request, type Response, type NextFunction } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { supabase } from '../lib/supabase.js';
import { generateInviteToken, hashInviteToken } from '../lib/invite-token.js';
import { getR1Config } from '../lib/r1/config.js';
import { requireRole } from '../lib/rbac.js';
import { recordAudit } from '../lib/audit.js';

export const r1Router = Router();
export const r1InternalRouter = Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const activePhone = new Set(['pending_prereqs', 'eligible', 'scheduled', 'dialing', 'in_call', 'reconnecting', 'awaiting_retry']);
const terminal = new Set(['completed', 'expired', 'cancelled']);
/** The trusted worker event types r1_admin_log accepts (0122 added session_facts). */
const ADMIN_LOG_EVENTS = ['need_revealed','family_delivered','push_delivered','counter_delivered','discount_detected','guard_hit','time_cue','session_facts'];

function r1Enabled(res: Response): boolean {
  const c = getR1Config();
  if (!c.enabled) { res.status(409).json({ error: 'r1_disabled', r1_status: c.status }); return false; }
  return true;
}
async function candidateAccess(req: Request, res: Response, candidateId: string, write = false): Promise<any | null> {
  const { data: candidate, error } = await supabase.from('candidates').select('id,owner_id,status,decision_use_blocked_at').eq('id', candidateId).maybeSingle();
  if (error || !candidate) { res.status(404).json({ error: 'not_found' }); return null; }
  const actor = req.authUser!;
  if (actor.appRole === 'admin') return candidate;
  if (actor.appRole === 'viewer') { if (write) { res.status(403).json({ error: 'access_denied' }); return null; } return candidate; }
  if (candidate.owner_id === actor.id) return candidate;
  if (write && candidate.owner_id === null) {
    const { data: claimed } = await supabase.from('candidates').update({ owner_id: actor.id }).eq('id', candidate.id).is('owner_id', null).select('id,owner_id,status,decision_use_blocked_at');
    if (claimed?.length === 1) return claimed[0];
    res.status(409).json({ error: 'candidate_ownership_conflict' }); return null;
  }
  res.status(403).json({ error: 'access_denied' }); return null;
}
async function roundAccess(req: Request, res: Response, roundId: string, write = true): Promise<any | null> {
  const { data: round } = await supabase.from('interview_rounds').select('id,candidate_id,created_by,status,attempts_allowed,attempts_counted,expires_at,version').eq('id', roundId).maybeSingle();
  if (!round) { res.status(404).json({ error: 'not_found' }); return null; }
  const actor = req.authUser!;
  if (actor.appRole === 'admin' || (actor.appRole === 'interviewer' && round.created_by === actor.id)) return round;
  if (!write && actor.appRole === 'viewer') return round;
  res.status(403).json({ error: 'access_denied' }); return null;
}
function joinUrl(token: string): string { return `${(process.env.WEB_ORIGIN ?? 'http://localhost:5173').split(',')[0].replace(/\/+$/, '')}/candidate/r1#${token}`; }

r1Router.post('/candidates/:id/interview-rounds', requireRole('interviewer'), async (req, res, next) => {
  try {
    if (!r1Enabled(res)) return;
    if (!UUID.test(req.params.id) || req.body?.india_location_attested !== true) return res.status(400).json({ error: 'india_location_attestation_required' });
    const candidate = await candidateAccess(req, res, req.params.id, true); if (!candidate) return;
    if (candidate.decision_use_blocked_at) return res.status(409).json({ error: 'decision_use_blocked' });
    const { data: role } = await supabase.from('roles').select('id').eq('interview_kind', 'sales_r1').maybeSingle();
    if (!role) return res.status(409).json({ error: 'r1_role_not_configured', message: 'Sales R1 role has not been seeded' });
    const token = generateInviteToken();
    // DB-backed eligibility and the 55-minute reservation are one transaction.
    const { data: created, error } = await supabase.rpc('r1_send_round', { p_candidate_id: candidate.id, p_role_id: role.id, p_created_by: req.authUser!.id, p_link_token_digest: hashInviteToken(token), p_candidate_status_at_send: candidate.status, p_expires_at: new Date(Date.now() + 72 * 3600_000).toISOString() });
    if (error) return res.status(503).json({ error: 'service_unavailable' });
    if (created?.status !== 'ok') { const code = created?.status ?? 'round_create_failed'; return res.status(409).json({ error: ['capacity_exhausted','paused','disabled'].includes(code) ? `r1_${code}` : code }); }
    const round = { id: created.id, status: created.round_status, expires_at: created.expires_at };
    await recordAudit(req, 'resource.create', 201, { metadata: { resource: 'interview_round', round_id: round.id } });
    res.setHeader('Cache-Control', 'no-store'); res.status(201).json({ ...round, join_url: joinUrl(token) });
  } catch (e) { next(e); }
});

r1Router.get('/candidates/:id/interview-rounds', requireRole('viewer'), async (req, res, next) => { try {
  if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'invalid_id' });
  if (!(await candidateAccess(req, res, req.params.id, false))) return;
  const { data, error } = await supabase.from('interview_rounds').select('id,status,expires_at,attempts_allowed,attempts_counted,recommendation,overall,status_write,pending_reject_until,created_at,created_by').eq('candidate_id', req.params.id).order('created_at', { ascending: false });
  if (error) throw error; res.json({ rounds: data ?? [] });
} catch (e) { next(e); } });

for (const action of ['cancel', 'reissue', 'grant-retake'] as const) r1Router.post(`/interview-rounds/:id/${action}`, requireRole('interviewer'), async (req, res, next) => { try {
  if (!r1Enabled(res) || !UUID.test(req.params.id)) return;
  const round = await roundAccess(req, res, req.params.id); if (!round) return;
  const token = action === 'reissue' ? generateInviteToken() : null;
  const { data: transition, error } = await supabase.rpc('r1_transition_round', { p_round_id: round.id, p_action: action, p_expected_version: round.version, p_link_token_digest: token ? hashInviteToken(token) : null, p_expires_at: action === 'reissue' || action === 'grant-retake' ? new Date(Date.now() + 72 * 3600_000).toISOString() : null });
  if (error) return res.status(503).json({ error: 'service_unavailable' });
  // Reissuing a link that had already lapsed re-enters its hold, so it can be refused for capacity (0119).
  if (transition?.status !== 'ok') return res.status(409).json({ error: transition?.status === 'retake_not_allowed' ? 'retake_not_allowed' : transition?.status === 'capacity_exhausted' ? 'r1_capacity_exhausted' : 'round_transition_conflict' });
  if (token) { res.setHeader('Cache-Control', 'no-store'); await recordAudit(req, 'resource.update', 200, { metadata: { resource: 'interview_round_reissue', round_id: round.id } }); return res.json({ id: round.id, join_url: joinUrl(token) }); }
  await recordAudit(req, 'resource.update', 200, { metadata: { resource: `interview_round_${action}`, round_id: round.id } }); res.json({ ok: true });
} catch (e) { next(e); } });

/**
 * HR cancels the 24 h pending reject R1 opened (plan 6.5). Admin or the owning interviewer, like
 * the other round actions. Deliberately NOT gated on R1_ENABLED: cancelling a pending reject is
 * always the safe direction, even while R1 is switched off. The cancellation is an audited
 * override: the RPC records it in audit_events and feeds the override monitor, which switches
 * auto-status off at >10% over a rolling 20.
 */
r1Router.post('/interview-rounds/:id/cancel-pending-reject', requireRole('interviewer'), async (req, res, next) => { try {
  if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'invalid_id' });
  const round = await roundAccess(req, res, req.params.id); if (!round) return;
  const { data, error } = await supabase.rpc('r1_cancel_pending_reject', { p_round_id: round.id, p_actor: req.authUser!.id });
  if (error) return res.status(503).json({ error: 'service_unavailable' });
  if (data?.status === 'not_pending') return res.status(409).json({ error: 'not_pending' });
  if (data?.status !== 'ok') return res.status(409).json({ error: 'round_transition_conflict' });
  await recordAudit(req, 'resource.update', 200, { metadata: { resource: 'interview_round_cancel_pending_reject', round_id: round.id } });
  res.json({ ok: true, auto_status_disabled: data?.override?.disabled === true });
} catch (e) { next(e); } });

r1Router.get('/admin/r1/settings', requireRole('admin'), async (_req, res, next) => { try { const { data, error } = await supabase.from('r1_settings').select('*').eq('singleton', true).single(); if (error) throw error; res.json({ ...data, runtime: getR1Config() }); } catch (e) { next(e); } });
// Settings meaning (0119): `monthly_cap_minutes` is the owner-approved R1 allocation in minutes (sessions x 55)
// and applies in BOTH livekit targets; `pause_line_minutes` is the total Cloud-pool pause line and applies only
// while `livekit_target` is 'cloud'. A dashboard reading is stamped by the database (its own clock and its own
// pool estimate, atomically, via r1_stamp_dashboard_reading): this route never computes either value and a
// client can never supply them.
// 0115 created `monthly_cap_minutes` with a default of 4000, which was the total Cloud-pool pause line. It now means
// the R1 allocation, so an untouched default must never go live by accident: enabling R1 is refused while the stored
// allocation is still that default, it has never been saved (`allocation_set_at` is NULL) and this request does not
// set the allocation itself. `allocation_set_at` is stamped by the database only when a write names
// `monthly_cap_minutes` (a deliberate save of 4000 counts); any other write, including a dashboard reading or an
// empty save, records `updated_by` but does not lift the guard. A client can never supply it.
const R1_DEFAULT_ALLOCATION_MINUTES = 4000;
const R1_SETTINGS_FIELDS = ['enabled', 'paused', 'monthly_cap_minutes', 'pause_line_minutes', 'advance_threshold', 'hold_threshold', 'auto_status_enabled', 'livekit_target'] as const;
const validMinutes = (v: unknown) => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 99999999.99;
r1Router.put('/admin/r1/settings', requireRole('admin'), async (req, res, next) => { try {
  const body = req.body ?? {};
  if ('dashboard_read_at' in body || 'dashboard_estimate_baseline' in body || 'allocation_set_at' in body) return res.status(400).json({ error: 'invalid_r1_settings' });
  const patch: Record<string, unknown> = { updated_by: req.authUser!.id };
  for (const k of R1_SETTINGS_FIELDS) if (k in body) patch[k] = body[k];
  const validInt = (v: unknown) => Number.isInteger(v) && Number(v) > 0;
  const validScore = (v: unknown) => Number.isFinite(v) && Number(v) >= 0 && Number(v) <= 100;
  const dashboard = 'dashboard_minutes' in body;
  if ((patch.monthly_cap_minutes !== undefined && !validInt(patch.monthly_cap_minutes)) || (patch.pause_line_minutes !== undefined && !validInt(patch.pause_line_minutes)) || (dashboard && !validMinutes(body.dashboard_minutes)) || (patch.advance_threshold !== undefined && !validScore(patch.advance_threshold)) || (patch.hold_threshold !== undefined && !validScore(patch.hold_threshold)) || (patch.livekit_target !== undefined && !['cloud', 'r1'].includes(String(patch.livekit_target))) || (patch.enabled !== undefined && typeof patch.enabled !== 'boolean')) return res.status(400).json({ error: 'invalid_r1_settings' });
  if (patch.enabled === true && !('monthly_cap_minutes' in body)) {
    const { data: current, error: currentError } = await supabase.from('r1_settings').select('monthly_cap_minutes,allocation_set_at').eq('singleton', true).single();
    if (currentError || !current) return res.status(503).json({ error: 'service_unavailable' });
    if (current.monthly_cap_minutes === R1_DEFAULT_ALLOCATION_MINUTES && !current.allocation_set_at) return res.status(409).json({ error: 'r1_allocation_not_set' });
  }
  let settings: unknown = null;
  // A body carrying only a dashboard reading has nothing for the table update to do.
  const applied = Object.keys(patch).length > 1 || !dashboard;
  if (applied) {
    const { data, error } = await supabase.from('r1_settings').update(patch).eq('singleton', true).select('*').single();
    if (error) return res.status(400).json({ error: 'invalid_r1_settings' });
    settings = data;
  }
  if (dashboard) {
    const { data: stamped, error } = await supabase.rpc('r1_stamp_dashboard_reading', { p_dashboard_minutes: Number(body.dashboard_minutes), p_updated_by: req.authUser!.id });
    if (error || stamped?.status !== 'ok') {
      // Other validated fields may already be saved: keep the audit trail honest before failing.
      if (applied) await recordAudit(req, 'resource.update', 200, { metadata: { resource: 'r1_settings' } });
      return stamped?.status === 'invalid_request' ? res.status(400).json({ error: 'invalid_r1_settings' }) : res.status(503).json({ error: 'service_unavailable' });
    }
    settings = stamped.settings;
  }
  await recordAudit(req, 'resource.update', 200, { metadata: { resource: 'r1_settings' } });
  res.json(settings);
} catch (e) { next(e); } });

function workerAuth(req: Request, res: Response, next: NextFunction): void { const secret = process.env.WORKER_CONTEXT_SECRET; const token = req.header('authorization')?.replace(/^Bearer /, ''); if (!secret || secret.length < 32) { res.status(503).json({ error: 'worker_auth_not_configured' }); return; } if (!token) { res.status(401).json({ error: 'authentication_required' }); return; } const a = Buffer.from(secret), b = Buffer.from(token); if (a.length !== b.length || !timingSafeEqual(a, b)) { res.status(403).json({ error: 'access_denied' }); return; } next(); }
async function r1Session(req: Request, res: Response): Promise<any | null> { const room = req.body?.room; if (typeof room !== 'string' || !/^screening-[0-9a-f-]{36}$/i.test(room)) { res.status(400).json({ error: 'invalid_r1_room' }); return null; } const { data, error } = await supabase.from('call_sessions').select('id,candidate_id,interview_round_id,status,external_call_id,mode').eq('external_call_id', room).maybeSingle(); if (error) { res.status(503).json({ error: 'service_unavailable' }); return null; } if (!data || data.mode !== 'browser' || !data.interview_round_id || !['waiting','in_progress'].includes(data.status) || data.external_call_id !== room) { res.status(409).json({ error: 'r1_session' }); return null; } return data; }
r1InternalRouter.post('/context', workerAuth, async (req, res, next) => { try { const session = await r1Session(req, res); if (!session) return; const [{ data: candidate }, { data: attempt }, { data: settings }] = await Promise.all([supabase.from('candidates').select('name').eq('id', session.candidate_id).single(), supabase.from('interview_round_attempts').select('round_id,attempt_number,persona_id,persona_version,persona_variant,content_sha').eq('session_id', session.id).single(), supabase.from('r1_settings').select('enabled,paused,advance_threshold,hold_threshold,livekit_target').eq('singleton', true).single()]); const raw = typeof candidate?.name === 'string' ? candidate.name.trim().split(/\s+/)[0] : ''; const first_name = /^[A-Za-z '-]{1,24}$/.test(raw) ? raw : 'there'; res.json({ first_name, round_id: session.interview_round_id, attempt_id: session.id, attempt, settings }); } catch (e) { next(e); } });
r1InternalRouter.post('/usage', workerAuth, async (req, res, next) => { try { const session = await r1Session(req, res); if (!session) return; const body = req.body ?? {}; const key = typeof body.event_key === 'string' ? body.event_key : ''; const max = body.participant_kind === 'preflight' ? 15 : 1830; const occurred = body.occurred_at ? new Date(body.occurred_at).getTime() : Date.now(); if (!['candidate','agent','preflight','manual_test'].includes(body.participant_kind) || !Number.isFinite(body.seconds) || body.seconds < 0 || body.seconds > max || !/^[A-Za-z0-9:_-]{1,128}$/.test(key) || !Number.isFinite(occurred) || Math.abs(Date.now() - occurred) > 120_000) return res.status(400).json({ error: 'invalid_usage' }); const { data, error } = await supabase.rpc('r1_record_usage', { p_session_id: session.id, p_round_id: session.interview_round_id, p_participant_kind: body.participant_kind, p_event: body.event === 'disconnect' ? 'disconnect' : 'connect', p_seconds: body.seconds, p_event_key: key }); if (error) return res.status(503).json({ error: 'service_unavailable' }); res.status(data?.duplicate ? 200 : 201).json({ ok: true, duplicate: !!data?.duplicate }); } catch (e) { next(e); } });
r1InternalRouter.post('/admin-log', workerAuth, async (req, res, next) => { try { const session = await r1Session(req, res); if (!session) return; const body = req.body ?? {}; if (!ADMIN_LOG_EVENTS.includes(body.event_type) || (body.turn_index !== undefined && (!Number.isInteger(body.turn_index) || body.turn_index < 0)) || (body.payload !== undefined && (typeof body.payload !== 'object' || Array.isArray(body.payload)))) return res.status(400).json({ error: 'invalid_admin_log' }); const { error } = await supabase.from('r1_admin_log').insert({ session_id: session.id, round_id: session.interview_round_id, event_type: body.event_type, turn_index: body.turn_index ?? null, family_id: typeof body.family_id === 'string' ? body.family_id.slice(0, 64) : null, payload: body.payload ?? {} }); if (error) throw error; res.status(201).json({ ok: true }); } catch (e) { next(e); } });

/**
 * Worker-reported attempt outcome (PR-3; payload fixed by r1_persistence.py on
 * origin/r1/pr4a-worker-core: `{ attempt_id, outcome }`, posted after the
 * durable terminal write, best-effort).
 *
 * `attempt_id` is the attempt's `session_id`. The count-or-not decision (plan
 * D1: an attempt counts once TRANSITION has started; no-shows, early exits and
 * system failures never count) is made by `r1_settle_attempt` in one
 * transaction with the round's `attempts_counted`, so a retry can neither
 * double-count nor lose a count. The route is deliberately NOT gated on
 * R1_ENABLED: a worker must always be able to settle.
 *
 * The SESSION must be settled too (plan 8.3: the session is an R1 session in an
 * allowed state). `r1_settle_attempt` refuses, atomically with its locks, an
 * outcome for a session that is not a terminal browser session of the attempt's
 * own round, and `complete` for one that is not `completed`. The worker secret
 * is shared with the phone worker, and the R1 worker posts an outcome even when
 * its terminal write failed; counting a live or failed session as complete
 * would close the round with nothing to score. Refused outcomes are 409
 * `r1_session_not_settled` and change nothing, which the worker logs and moves
 * past (fail safe: not counted).
 *
 * 201 first settlement, 200 identical replay, 409 a different outcome for an
 * already-settled attempt or a session that is not settled, 404 unknown attempt
 * (the worker treats it as a logged, non-fatal compatibility condition).
 */
const R1_ATTEMPT_OUTCOMES: ReadonlySet<string> = new Set([
  'complete',
  'candidate_left',
  'no_show',
  'provider_error',
  'residency_timeout',
  'shutdown_forced',
  'configuration_failed',
  'context_failed',
]);

r1InternalRouter.post('/attempt-outcome', workerAuth, async (req, res, next) => {
  try {
    const body = req.body ?? {};
    if (
      typeof body.attempt_id !== 'string'
      || !UUID.test(body.attempt_id)
      || typeof body.outcome !== 'string'
      || !R1_ATTEMPT_OUTCOMES.has(body.outcome)
    ) {
      return res.status(400).json({ error: 'invalid_attempt_outcome' });
    }
    const { data, error } = await supabase.rpc('r1_settle_attempt', {
      p_session_id: body.attempt_id,
      p_outcome: body.outcome,
    });
    if (error || !data) return res.status(503).json({ error: 'service_unavailable' });
    if (data.status === 'ok') {
      return res.status(201).json({ ok: true, counted: data.counted === true, duplicate: false });
    }
    if (data.status === 'duplicate') {
      return res.status(200).json({ ok: true, counted: data.counted === true, duplicate: true });
    }
    if (data.status === 'attempt_not_found') {
      return res.status(404).json({ error: 'r1_attempt_not_found' });
    }
    if (data.status === 'outcome_conflict') {
      return res.status(409).json({ error: 'r1_outcome_conflict' });
    }
    if (data.status === 'session_not_settled') {
      return res.status(409).json({ error: 'r1_session_not_settled' });
    }
    if (data.status === 'invalid_outcome') {
      return res.status(400).json({ error: 'invalid_attempt_outcome' });
    }
    return res.status(503).json({ error: 'service_unavailable' });
  } catch (e) { next(e); }
});
