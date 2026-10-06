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
    const { data: settings } = await supabase.from('r1_settings').select('*').eq('singleton', true).maybeSingle();
    if (!settings?.enabled || settings.paused) return res.status(409).json({ error: settings?.paused ? 'r1_paused' : 'r1_disabled' });
    const { data: role } = await supabase.from('roles').select('id').eq('interview_kind', 'sales_r1').maybeSingle();
    if (!role) return res.status(409).json({ error: 'r1_role_not_configured', message: 'Sales R1 role has not been seeded' });
    const { data: existing } = await supabase.from('interview_rounds').select('id').eq('candidate_id', candidate.id).in('status', ['invited', 'in_progress']).maybeSingle();
    if (existing) return res.status(409).json({ error: 'r1_round_active' });
    const { data: engagements } = await supabase.from('phone_engagements').select('state').eq('candidate_id', candidate.id);
    if (engagements?.some((e: any) => activePhone.has(e.state))) return res.status(409).json({ error: 'phone_engagement_active' });
    const { data: phoneSessions } = await supabase.from('call_sessions').select('id').eq('candidate_id', candidate.id).eq('mode', 'live');
    if (phoneSessions?.length) {
      const ids = phoneSessions.map((s: any) => s.id);
      const { data: jobs } = await supabase.from('job_queue').select('payload,status').eq('name', 'phone.assessment').in('status', ['pending', 'active', 'delayed']);
      if (jobs?.some((j: any) => ids.includes(j.payload?.session_id))) return res.status(409).json({ error: 'phone_assessment_pending' });
    }
    const month = new Date().toISOString().slice(0, 7) + '-01';
    const { data: budget } = await supabase.from('r1_budget_month').select('minutes_used,minutes_reserved').eq('month_start', month).maybeSingle();
    const used = Math.max(Number(budget?.minutes_used ?? 0) + Number(budget?.minutes_reserved ?? 0), Number(settings.dashboard_minutes ?? 0));
    if (used + 55 > Math.min(Number(settings.monthly_cap_minutes), Number(settings.pause_line_minutes))) return res.status(409).json({ error: 'r1_capacity_exhausted' });
    const token = generateInviteToken();
    const { data: round, error } = await supabase.from('interview_rounds').insert({ candidate_id: candidate.id, role_id: role.id, kind: 'sales_r1', link_token_digest: hashInviteToken(token), expires_at: new Date(Date.now() + 72 * 3600_000).toISOString(), candidate_status_at_send: candidate.status, created_by: req.authUser!.id }).select('id,status,expires_at').single();
    if (error || !round) return res.status(409).json({ error: 'r1_round_create_failed' });
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
  if (action === 'cancel') { if (terminal.has(round.status)) return res.status(409).json({ error: 'round_terminal' }); await supabase.from('interview_rounds').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('id', round.id); }
  if (action === 'reissue') { if (terminal.has(round.status)) return res.status(409).json({ error: 'round_terminal' }); const token = generateInviteToken(); await supabase.from('interview_rounds').update({ link_token_digest: hashInviteToken(token), expires_at: new Date(Date.now() + 72 * 3600_000).toISOString(), version: (round.version ?? 1) + 1 }).eq('id', round.id); res.setHeader('Cache-Control', 'no-store'); await recordAudit(req, 'resource.update', 200, { metadata: { resource: 'interview_round_reissue', round_id: round.id } }); return res.json({ id: round.id, join_url: joinUrl(token) }); }
  if (action === 'grant-retake') { if (round.attempts_counted >= round.attempts_allowed) return res.status(409).json({ error: 'retake_not_allowed' }); await supabase.from('interview_rounds').update({ status: 'invited', expires_at: new Date(Date.now() + 72 * 3600_000).toISOString() }).eq('id', round.id); }
  await recordAudit(req, 'resource.update', 200, { metadata: { resource: `interview_round_${action}`, round_id: round.id } }); res.json({ ok: true });
} catch (e) { next(e); } });

r1Router.get('/admin/r1/settings', requireRole('admin'), async (_req, res, next) => { try { const { data, error } = await supabase.from('r1_settings').select('*').eq('singleton', true).single(); if (error) throw error; res.json({ ...data, runtime: getR1Config() }); } catch (e) { next(e); } });
r1Router.put('/admin/r1/settings', requireRole('admin'), async (req, res, next) => { try { const allowed = ['enabled','paused','monthly_cap_minutes','pause_line_minutes','advance_threshold','hold_threshold','auto_status_enabled','livekit_target','dashboard_minutes','dashboard_read_at']; const patch: Record<string, unknown> = { updated_by: req.authUser!.id }; for (const k of allowed) if (k in (req.body ?? {})) patch[k] = req.body[k]; const { data, error } = await supabase.from('r1_settings').update(patch).eq('singleton', true).select('*').single(); if (error) return res.status(400).json({ error: 'invalid_r1_settings' }); await recordAudit(req, 'resource.update', 200, { metadata: { resource: 'r1_settings' } }); res.json(data); } catch (e) { next(e); } });

function workerAuth(req: Request, res: Response, next: NextFunction): void { const secret = process.env.WORKER_CONTEXT_SECRET; const token = req.header('authorization')?.replace(/^Bearer /, ''); if (!secret || secret.length < 32) { res.status(503).json({ error: 'worker_auth_not_configured' }); return; } if (!token) { res.status(401).json({ error: 'authentication_required' }); return; } const a = Buffer.from(secret), b = Buffer.from(token); if (a.length !== b.length || !timingSafeEqual(a, b)) { res.status(403).json({ error: 'access_denied' }); return; } next(); }
async function r1Session(req: Request, res: Response): Promise<any | null> { const room = req.body?.room; if (typeof room !== 'string' || !/^screening-[0-9a-f-]{36}$/i.test(room)) { res.status(400).json({ error: 'invalid_r1_room' }); return null; } const { data } = await supabase.from('call_sessions').select('id,candidate_id,interview_round_id,status,external_call_id,mode').eq('external_call_id', room).maybeSingle(); if (!data || data.mode !== 'browser' || !data.interview_round_id || !['waiting','in_progress'].includes(data.status) || data.external_call_id !== room) { res.status(409).json({ error: 'r1_session' }); return null; } return data; }
r1InternalRouter.post('/context', workerAuth, async (req, res, next) => { try { const session = await r1Session(req, res); if (!session) return; const [{ data: candidate }, { data: attempt }, { data: settings }] = await Promise.all([supabase.from('candidates').select('name').eq('id', session.candidate_id).single(), supabase.from('interview_round_attempts').select('round_id,attempt_number,persona_id,persona_version,persona_variant,content_sha').eq('session_id', session.id).single(), supabase.from('r1_settings').select('enabled,paused,advance_threshold,hold_threshold,livekit_target').eq('singleton', true).single()]); const raw = typeof candidate?.name === 'string' ? candidate.name.trim().split(/\s+/)[0] : ''; const first_name = /^[A-Za-z '-]{1,24}$/.test(raw) ? raw : 'there'; res.json({ first_name, round_id: session.interview_round_id, attempt_id: session.id, attempt, settings }); } catch (e) { next(e); } });
r1InternalRouter.post('/usage', workerAuth, async (req, res, next) => { try { const session = await r1Session(req, res); if (!session) return; const body = req.body ?? {}; if (!['candidate','agent','preflight','manual_test'].includes(body.participant_kind) || !Number.isFinite(body.seconds) || body.seconds < 0) return res.status(400).json({ error: 'invalid_usage' }); const { error } = await supabase.from('r1_usage_ledger').insert({ session_id: session.id, round_id: session.interview_round_id, participant_kind: body.participant_kind, event: body.event === 'disconnect' ? 'disconnect' : 'connect', seconds: body.seconds, occurred_at: body.occurred_at ?? new Date().toISOString() }); if (error) throw error; res.status(201).json({ ok: true }); } catch (e) { next(e); } });
r1InternalRouter.post('/admin-log', workerAuth, async (req, res, next) => { try { const session = await r1Session(req, res); if (!session) return; const body = req.body ?? {}; if (!['need_revealed','family_delivered','push_delivered','counter_delivered','discount_detected','guard_hit','time_cue'].includes(body.event_type) || (body.turn_index !== undefined && (!Number.isInteger(body.turn_index) || body.turn_index < 0)) || (body.payload !== undefined && (typeof body.payload !== 'object' || Array.isArray(body.payload)))) return res.status(400).json({ error: 'invalid_admin_log' }); const { error } = await supabase.from('r1_admin_log').insert({ session_id: session.id, round_id: session.interview_round_id, event_type: body.event_type, turn_index: body.turn_index ?? null, family_id: typeof body.family_id === 'string' ? body.family_id.slice(0, 64) : null, payload: body.payload ?? {} }); if (error) throw error; res.status(201).json({ ok: true }); } catch (e) { next(e); } });
