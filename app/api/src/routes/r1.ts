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
  const { data, error } = await supabase.from('interview_rounds').select('id,status,expires_at,attempts_allowed,attempts_counted,recommendation,overall,created_at,created_by').eq('candidate_id', req.params.id).order('created_at', { ascending: false });
  if (error) throw error; res.json({ rounds: data ?? [] });
} catch (e) { next(e); } });

for (const action of ['cancel', 'reissue', 'grant-retake'] as const) r1Router.post(`/interview-rounds/:id/${action}`, requireRole('interviewer'), async (req, res, next) => { try {
  if (!r1Enabled(res) || !UUID.test(req.params.id)) return;
  const round = await roundAccess(req, res, req.params.id); if (!round) return;
  const token = action === 'reissue' ? generateInviteToken() : null;
  const { data: transition, error } = await supabase.rpc('r1_transition_round', { p_round_id: round.id, p_action: action, p_expected_version: round.version, p_link_token_digest: token ? hashInviteToken(token) : null, p_expires_at: action === 'reissue' || action === 'grant-retake' ? new Date(Date.now() + 72 * 3600_000).toISOString() : null });
  if (error) return res.status(503).json({ error: 'service_unavailable' });
  if (transition?.status !== 'ok') return res.status(409).json({ error: transition?.status === 'retake_not_allowed' ? 'retake_not_allowed' : 'round_transition_conflict' });
  if (token) { res.setHeader('Cache-Control', 'no-store'); await recordAudit(req, 'resource.update', 200, { metadata: { resource: 'interview_round_reissue', round_id: round.id } }); return res.json({ id: round.id, join_url: joinUrl(token) }); }
  await recordAudit(req, 'resource.update', 200, { metadata: { resource: `interview_round_${action}`, round_id: round.id } }); res.json({ ok: true });
} catch (e) { next(e); } });

r1Router.get('/admin/r1/settings', requireRole('admin'), async (_req, res, next) => { try { const { data, error } = await supabase.from('r1_settings').select('*').eq('singleton', true).single(); if (error) throw error; res.json({ ...data, runtime: getR1Config() }); } catch (e) { next(e); } });
r1Router.put('/admin/r1/settings', requireRole('admin'), async (req, res, next) => { try { const allowed = ['enabled','paused','monthly_cap_minutes','pause_line_minutes','advance_threshold','hold_threshold','auto_status_enabled','livekit_target','dashboard_minutes','dashboard_read_at']; const body = req.body ?? {}; const patch: Record<string, unknown> = { updated_by: req.authUser!.id }; for (const k of allowed) if (k in body) patch[k] = body[k]; const validInt = (v: unknown) => Number.isInteger(v) && Number(v) > 0; const validScore = (v: unknown) => Number.isFinite(v) && Number(v) >= 0 && Number(v) <= 100; if ((patch.monthly_cap_minutes !== undefined && !validInt(patch.monthly_cap_minutes)) || (patch.pause_line_minutes !== undefined && !validInt(patch.pause_line_minutes)) || (patch.dashboard_minutes !== undefined && (!Number.isFinite(Number(patch.dashboard_minutes)) || Number(patch.dashboard_minutes) < 0)) || (patch.advance_threshold !== undefined && !validScore(patch.advance_threshold)) || (patch.hold_threshold !== undefined && !validScore(patch.hold_threshold)) || (patch.livekit_target !== undefined && !['cloud','r1'].includes(String(patch.livekit_target)))) return res.status(400).json({ error: 'invalid_r1_settings' }); const { data, error } = await supabase.from('r1_settings').update(patch).eq('singleton', true).select('*').single(); if (error) return res.status(400).json({ error: 'invalid_r1_settings' }); await recordAudit(req, 'resource.update', 200, { metadata: { resource: 'r1_settings' } }); res.json(data); } catch (e) { next(e); } });

function workerAuth(req: Request, res: Response, next: NextFunction): void { const secret = process.env.WORKER_CONTEXT_SECRET; const token = req.header('authorization')?.replace(/^Bearer /, ''); if (!secret || secret.length < 32) { res.status(503).json({ error: 'worker_auth_not_configured' }); return; } if (!token) { res.status(401).json({ error: 'authentication_required' }); return; } const a = Buffer.from(secret), b = Buffer.from(token); if (a.length !== b.length || !timingSafeEqual(a, b)) { res.status(403).json({ error: 'access_denied' }); return; } next(); }
async function r1Session(req: Request, res: Response): Promise<any | null> { const room = req.body?.room; if (typeof room !== 'string' || !/^screening-[0-9a-f-]{36}$/i.test(room)) { res.status(400).json({ error: 'invalid_r1_room' }); return null; } const { data, error } = await supabase.from('call_sessions').select('id,candidate_id,interview_round_id,status,external_call_id,mode').eq('external_call_id', room).maybeSingle(); if (error) { res.status(503).json({ error: 'service_unavailable' }); return null; } if (!data || data.mode !== 'browser' || !data.interview_round_id || !['waiting','in_progress'].includes(data.status) || data.external_call_id !== room) { res.status(409).json({ error: 'r1_session' }); return null; } return data; }
r1InternalRouter.post('/context', workerAuth, async (req, res, next) => { try { const session = await r1Session(req, res); if (!session) return; const [{ data: candidate }, { data: attempt }, { data: settings }] = await Promise.all([supabase.from('candidates').select('name').eq('id', session.candidate_id).single(), supabase.from('interview_round_attempts').select('round_id,attempt_number,persona_id,persona_version,persona_variant,content_sha').eq('session_id', session.id).single(), supabase.from('r1_settings').select('enabled,paused,advance_threshold,hold_threshold,livekit_target').eq('singleton', true).single()]); const raw = typeof candidate?.name === 'string' ? candidate.name.trim().split(/\s+/)[0] : ''; const first_name = /^[A-Za-z '-]{1,24}$/.test(raw) ? raw : 'there'; res.json({ first_name, round_id: session.interview_round_id, attempt_id: session.id, attempt, settings }); } catch (e) { next(e); } });
r1InternalRouter.post('/usage', workerAuth, async (req, res, next) => { try { const session = await r1Session(req, res); if (!session) return; const body = req.body ?? {}; const key = typeof body.event_key === 'string' ? body.event_key : ''; const max = body.participant_kind === 'preflight' ? 15 : 1830; const occurred = body.occurred_at ? new Date(body.occurred_at).getTime() : Date.now(); if (!['candidate','agent','preflight','manual_test'].includes(body.participant_kind) || !Number.isFinite(body.seconds) || body.seconds < 0 || body.seconds > max || !/^[A-Za-z0-9:_-]{1,128}$/.test(key) || !Number.isFinite(occurred) || Math.abs(Date.now() - occurred) > 120_000) return res.status(400).json({ error: 'invalid_usage' }); const { data, error } = await supabase.rpc('r1_record_usage', { p_session_id: session.id, p_round_id: session.interview_round_id, p_participant_kind: body.participant_kind, p_event: body.event === 'disconnect' ? 'disconnect' : 'connect', p_seconds: body.seconds, p_event_key: key }); if (error) return res.status(503).json({ error: 'service_unavailable' }); res.status(data?.duplicate ? 200 : 201).json({ ok: true, duplicate: !!data?.duplicate }); } catch (e) { next(e); } });
r1InternalRouter.post('/admin-log', workerAuth, async (req, res, next) => { try { const session = await r1Session(req, res); if (!session) return; const body = req.body ?? {}; if (!['need_revealed','family_delivered','push_delivered','counter_delivered','discount_detected','guard_hit','time_cue'].includes(body.event_type) || (body.turn_index !== undefined && (!Number.isInteger(body.turn_index) || body.turn_index < 0)) || (body.payload !== undefined && (typeof body.payload !== 'object' || Array.isArray(body.payload)))) return res.status(400).json({ error: 'invalid_admin_log' }); const { error } = await supabase.from('r1_admin_log').insert({ session_id: session.id, round_id: session.interview_round_id, event_type: body.event_type, turn_index: body.turn_index ?? null, family_id: typeof body.family_id === 'string' ? body.family_id.slice(0, 64) : null, payload: body.payload ?? {} }); if (error) throw error; res.status(201).json({ ok: true }); } catch (e) { next(e); } });
