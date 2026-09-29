/**
 * The fake HELLO API: one table row per endpoint in `src/api.ts`.
 *
 * WHY A TABLE AND NOT A CATCH-ALL. A permissive `**` → `[]` stub renders
 * every page "successfully" and hides exactly the bugs this harness exists to
 * find: a page that silently shows an empty state because it called an
 * endpoint nobody mocked. Here a request that matches no row is answered 500
 * with the method and path in the body, recorded, and fails the test (see
 * harness.ts). Adding an endpoint to the app therefore means adding a row
 * here — which is the point.
 *
 * Reads come from the per-page `Dataset`; writes return the typed success the
 * real route returns and, where it is cheap and visible, mutate the dataset so
 * a reload shows the change. No write ever reaches anything real: the API
 * origin is an `.invalid` host (see env.ts).
 *
 * Row ORDER matters only where a static segment could also match a `:param`
 * (e.g. `/api/candidates/summary` must precede `/api/candidates/:id`).
 */

import type {
  AshbyManualInviteResponse,
  Assessment,
  CandidatesSummary,
  Note,
  PhoneAppointmentWriteResponse,
  PhoneCalendarResponse,
  PhoneSlotsResponse,
  Recommendation,
  Role,
  RoleDraftJob,
  RoleScorecardMetric,
  ScorecardMetricTemplate,
} from '../../src/types';
import { ADMIN_USER_ID, PHONE_WINDOW, SCOPED_REVIEW_LINK_ID, STAR_CANDIDATE_ID, funnelSummary, phoneSlots, type Dataset } from './data';
import { FROZEN_NOW_MS } from './env';

export interface MockRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  params: Record<string, string>;
  /** Parsed JSON body, or null for no body / multipart. */
  body: Record<string, unknown> | null;
}

export interface MockResponse {
  status: number;
  json?: unknown;
  text?: string;
  contentType?: string;
}

type Handler = (req: MockRequest, db: Dataset) => MockResponse;

const ok = (json: unknown): MockResponse => ({ status: 200, json });
const created = (json: unknown): MockResponse => ({ status: 201, json });
const notFound = (what: string): MockResponse => ({ status: 404, json: { error: `not_found: ${what}` } });

const nowIso = () => new Date(FROZEN_NOW_MS).toISOString();
let seq = 1;
/** Ids minted by write handlers; distinct from every seeded id prefix. */
const mintId = () => `e2e00000-0000-4000-8000-${String(seq++).padStart(12, '0')}`;

/**
 * A 0.2 s silent WAV as a data URI. Recording "downloads" point here so a
 * test that presses Play gets a real, playable, fully offline media element.
 */
const SILENT_WAV = (() => {
  const samples = 1600;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(8000, 24);
  buf.writeUInt32LE(16000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples * 2, 40);
  return `data:audio/wav;base64,${buf.toString('base64')}`;
})();

function summaryOf(db: Dataset): CandidatesSummary {
  const assessed = db.candidates.filter((c) => c.latest_score != null);
  const dist: Record<Recommendation, number> = { advance: 0, hold: 0, reject: 0 };
  for (const c of assessed) if (c.latest_recommendation) dist[c.latest_recommendation] += 1;
  return {
    assessed_count: assessed.length,
    average_score: assessed.length ? Math.round(assessed.reduce((s, c) => s + (c.latest_score ?? 0), 0) / assessed.length) : null,
    recommendation_distribution: dist,
  };
}

function phoneWrite(engagementState = 'scheduled'): PhoneAppointmentWriteResponse {
  return { ok: true, appointment_id: mintId(), version: 1, engagement_state: engagementState, prereqs_pending: false, superseded_appointment_id: null };
}

/** Proportional re-spread of the other metrics' weights so the total stays 10 000 bps. */
function redistribute(metrics: RoleScorecardMetric[], editedId: string, newWeight: number): RoleScorecardMetric[] {
  const others = metrics.filter((m) => m.id !== editedId);
  const remaining = 10_000 - newWeight;
  const otherTotal = others.reduce((s, m) => s + m.weightBps, 0) || 1;
  let assigned = 0;
  return metrics.map((m, i) => {
    if (m.id === editedId) return { ...m, weightBps: newWeight };
    const isLastOther = others[others.length - 1]?.id === m.id;
    const w = isLastOther ? remaining - assigned : Math.round((m.weightBps / otherTotal) * remaining);
    assigned += isLastOther ? 0 : w;
    return { ...m, weightBps: w, displayOrder: i };
  });
}

const ASHBY = '/api/integrations/ashby/mission-control';

/** [METHOD, pattern, handler]. `:name` matches exactly one path segment. */
const ROUTES: Array<[string, string, Handler]> = [
  // ── Platform + identity ────────────────────────────────────────────
  ['GET', '/api/health', () => ok({ ok: true })],
  ['GET', '/api/status', (_r, db) => ok(db.status)],
  ['GET', '/api/me', (_r, db) => ok(db.me)],

  // ── Roles + Ask Hello drafting ─────────────────────────────────────
  ['GET', '/api/roles', (_r, db) => ok(db.roles)],
  ['POST', '/api/roles', ({ body }, db) => {
    const role = { ...(body as unknown as Role), id: mintId(), is_active: true, created_at: nowIso() };
    db.roles.unshift(role);
    return created(role);
  }],
  ['GET', '/api/roles/draft', () => ok({ active: null })],
  ['POST', '/api/roles/draft', ({ body }) => ok({ id: mintId(), job_role: String(body?.job_role ?? ''), status: 'running', phase: { phase: 'drafting', attempt: 1, maxAttempts: 3 }, draft: null, attempts: 1, repaired: [], error_reason: null, error_message: null, max_attempts: 3, created_at: nowIso() } satisfies RoleDraftJob)],
  ['GET', '/api/roles/draft/:id', ({ params }, db) => {
    const sample = db.roles[0];
    return ok({ id: params.id, job_role: sample.title, status: 'succeeded', phase: null, draft: { jd: sample.jd, required_skills: sample.required_skills, screening_template: sample.screening_template }, attempts: 1, repaired: [], error_reason: null, error_message: null, max_attempts: 3, created_at: nowIso() } satisfies RoleDraftJob);
  }],
  ['POST', '/api/roles/draft/:id/cancel', () => ok({ cancelled: true })],
  ['POST', '/api/roles/questions/rephrase', ({ body }) => ok({ question: `Could you tell me ${String(body?.question ?? '').replace(/[?.!]+$/, '').toLowerCase()}?` })],
  ['GET', '/api/roles/:id', ({ params }, db) => {
    const role = db.roles.find((r) => r.id === params.id);
    return role ? ok(role) : notFound('role');
  }],
  ['PUT', '/api/roles/:id', ({ params, body }, db) => {
    const role = db.roles.find((r) => r.id === params.id);
    if (!role) return notFound('role');
    Object.assign(role, body);
    return ok(role);
  }],
  ['DELETE', '/api/roles/:id', ({ params }, db) => {
    const role = db.roles.find((r) => r.id === params.id);
    if (!role) return notFound('role');
    const candidates = db.candidates.filter((c) => c.role_id === role.id).length;
    if (candidates === 0) {
      db.roles = db.roles.filter((r) => r.id !== role.id);
      return ok({ outcome: 'deleted' });
    }
    role.is_active = false;
    return ok({ outcome: 'archived', candidates, sessions: candidates });
  }],

  // ── Candidates ─────────────────────────────────────────────────────
  ['POST', '/api/resumes', (_r, db) => {
    const candidate = { ...db.candidates[0], id: mintId(), name: 'Uploaded Candidate', email: 'uploaded.candidate@example.com', status: 'new', created_at: nowIso(), latest_score: null, latest_recommendation: null };
    db.candidates.unshift(candidate);
    return created({ candidate, resume: { id: mintId(), candidate_id: candidate.id, created_at: nowIso() }, phone: { raw: '(202) 555-0199', e164: '+12025550199', valid: true } });
  }],
  ['GET', '/api/candidates/summary', (_r, db) => ok(summaryOf(db))],
  ['GET', '/api/candidates', ({ query }, db) => {
    const roleId = query.get('role_id');
    return ok(roleId ? db.candidates.filter((c) => c.role_id === roleId) : db.candidates);
  }],
  ['GET', '/api/candidates/:id', ({ params }, db) => {
    const detail = db.candidateDetail(params.id);
    return detail ? ok(detail) : notFound('candidate');
  }],
  ['POST', '/api/candidates/:id/phone-call', () => ok({ ok: true, status: 'requested' })],
  ['GET', '/api/candidates/:id/phone-cycles', ({ params }, db) => {
    const c = db.candidates.find((x) => x.id === params.id);
    if (!c) return notFound('candidate');
    const cycles = db.phoneCycles(c);
    return ok({ ok: true, enabled: true, cycles, current_cycle: cycles[0]?.cycle_number ?? null });
  }],
  ['POST', '/api/candidates/:id/phone-appointments', () => ok(phoneWrite())],
  ['PATCH', '/api/candidates/:id/phone-appointments/:appointmentId', () => ok(phoneWrite())],
  ['DELETE', '/api/candidates/:id/phone-appointments/:appointmentId', ({ params }) => ok({ ok: true, appointment_id: params.appointmentId, version: 3, already_cancelled: false })],
  ['POST', '/api/candidates/:id/phone-rescreens', () => ok({ ok: true, status: 'ok', cycle_number: 2 })],
  ['POST', '/api/candidates/:id/phone-number-verification', () => ok({ ok: true })],
  ['GET', '/api/candidates/:id/phone-attempts', ({ params }, db) => {
    const c = db.candidates.find((x) => x.id === params.id);
    return c ? ok({ attempts: db.phoneAttempts(c), next_cursor: null }) : notFound('candidate');
  }],
  ['GET', '/api/candidates/:id/ashby-workflow', ({ params }, db) => ok({ ok: true, workflow: db.ashbyWorkflowFor(params.id) })],

  // ── Screening sessions, recordings, assessment ─────────────────────
  ['POST', '/api/screening/start', () => ok({ session_id: mintId(), message: 'Hello! Could you walk me through your current role?', done: false })],
  ['POST', '/api/screening/:id/turn', () => ok({ message: 'Thank you. What is your notice period?', done: false, assessment: null })],
  ['GET', '/api/screening/:id', ({ params }, db) => {
    const detail = db.sessionDetails[params.id];
    return detail ? ok(detail) : notFound('session');
  }],
  ['POST', '/api/assess/:id', ({ params }, db) => {
    const assessment: Assessment | null = db.sessionDetails[params.id]?.assessment ?? null;
    return assessment ? ok(assessment) : notFound('assessment');
  }],
  ['GET', '/api/recordings/attempts/:id/download', () => ok({ url: SILENT_WAV, content_type: 'audio/wav' })],
  ['GET', '/api/recordings/:id/download', () => ok({ url: SILENT_WAV, content_type: 'audio/wav' })],

  // ── LiveKit browser screening (candidate + recruiter "call now") ───
  ['POST', '/api/livekit/start', () => ok({ session_id: mintId(), room_name: 'e2e-room', url: 'ws://livekit.e2e.invalid' })],
  ['POST', '/api/livekit/invite', () => ok({ token: 'e2e-invite-token', expires_at: new Date(FROZEN_NOW_MS + 86_400_000).toISOString() })],
  ['POST', '/api/livekit/exchange', () => ok({ status: 'preparing' })],
  ['POST', '/api/livekit/preflight', () => ok({ url: 'ws://livekit.e2e.invalid', livekit_token: 'e2e-livekit-token', expires_at: new Date(FROZEN_NOW_MS + 600_000).toISOString(), policy_version: 'voice-v1' })],
  ['POST', '/api/livekit/:id/complete', () => ok({ status: 'completed', recording_status: 'ready' })],
  ['POST', '/api/livekit/:id/recording', () => ok({ ok: true, object_key: 'e2e/recording.webm', sha256: '0'.repeat(64) })],

  // ── Consent (recruiter-side + candidate pre-join) ──────────────────
  ['POST', '/api/consent/submit', ({ body }) => ok({ id: mintId(), candidate_id: String(body?.candidate_id ?? ''), status: 'granted', consents: body?.consents ?? [], version: 'v3', created_at: nowIso() })],
  ['POST', '/api/consent/check', () => ok({ ok: true, missing: [] })],
  ['POST', '/api/consent/withdraw', () => ok({ id: mintId(), status: 'withdrawn', updated_at: nowIso() })],
  ['GET', '/api/consent/templates', () => ok([{ id: mintId(), version: 'v3', locale: 'en-IN', title: 'Screening privacy notice', body_md: '# Screening privacy notice\n\nThis synthetic notice exists only in the offline test harness.', required_consents: ['ai_interview', 'recording'], is_active: true }])],
  ['GET', '/api/consent/:id/status', ({ params }) => ok({ candidate_id: params.id, has_consent: true, has_ai_consent: true, has_recording_consent: true, latest_consent: { id: mintId(), status: 'granted', consents: ['ai_interview', 'recording'], version: 'v3', created_at: nowIso() } })],
  ['POST', '/api/candidate-consent/status', () => ok({ has_consent: false, template_version: 'v3', locale: 'en-IN', required_consents: ['ai_interview', 'recording'], role_title: 'Senior Backend Engineer' })],
  ['GET', '/api/candidate-consent/template', () => ok({ version: 'v3', locale: 'en-IN', title: 'Before your screening', body_md: 'This synthetic consent text exists only in the offline test harness.', required_consents: ['ai_interview', 'recording'] })],
  ['POST', '/api/candidate-consent/submit', ({ body }) => ok({ id: mintId(), status: body?.status ?? 'granted', consents: body?.consents ?? [], template_version: 'v3', locale: 'en-IN', created_at: nowIso() })],

  // ── Notes, status transitions, notifications, export, appeals ──────
  ['GET', '/api/notes', ({ query }, db) => ok({ notes: db.notes.filter((n) => n.candidate_id === query.get('candidate_id')) })],
  ['POST', '/api/notes', ({ body }, db) => {
    const note: Note = { id: mintId(), candidate_id: String(body?.candidate_id ?? ''), author_id: ADMIN_USER_ID, note: String(body?.note ?? ''), created_at: nowIso() };
    db.notes.push(note);
    return created(note);
  }],
  ['POST', '/api/notes/:id/status', ({ params, body }, db) => {
    const c = db.candidates.find((x) => x.id === params.id);
    if (!c) return notFound('candidate');
    const from = c.status;
    c.status = String(body?.status ?? from);
    return ok({ ok: true, from, to: c.status });
  }],
  ['GET', '/api/notifications', (_r, db) => ok({ intents: db.intents })],
  ['GET', '/api/export/:id/csv', ({ params }) => ({ status: 200, contentType: 'text/csv', text: `candidate_id,metric,score\n${params.id},communication_clarity,4\n` })],
  ['GET', '/api/appeals', ({ query }, db) => ok({ appeals: db.appeals.filter((a) => a.candidate_id === query.get('candidate_id')) })],
  ['POST', '/api/appeals/grants', () => ok({ appeal_grant_token: 'e2e-appeal-grant', expires_at: new Date(FROZEN_NOW_MS + 72 * 3_600_000).toISOString() })],
  ['POST', '/api/appeals', () => ok({ ok: true, appeal_id: mintId() })],
  ['POST', '/api/appeals/:id/review', () => ok({ ok: true })],

  // ── Admin (Mission Control) ────────────────────────────────────────
  ['GET', '/api/admin/members', (_r, db) => ok(db.members)],
  ['PATCH', '/api/admin/members/:id', () => ok({ ok: true })],
  ['POST', '/api/admin/maintenance', ({ body }, db) => {
    const enabled = body?.enabled === true;
    db.status = { ...db.status, status: enabled ? 'maintenance' : 'ok', maintenance: { enabled, reason: enabled ? String(body?.reason ?? '') : null, updated_at: nowIso() } };
    return ok({ ok: true, enabled });
  }],
  ['POST', '/api/admin/sessions/:id/override', ({ params }, db) => ok({ ok: true, prior_status: db.adminSessions.find((s) => s.id === params.id)?.status ?? null })],
  ['GET', '/api/admin/audit', ({ query }, db) => {
    const limit = Number(query.get('limit') ?? 50);
    const offset = Number(query.get('offset') ?? 0);
    return ok({ audit: db.audit.slice(offset, offset + limit) });
  }],
  ['GET', '/api/admin/sessions', ({ query }, db) => {
    const status = query.get('status');
    return ok({ sessions: status ? db.adminSessions.filter((s) => s.status === status) : db.adminSessions });
  }],
  ['GET', '/api/admin/quotas', (_r, db) => ok({ policies: db.quotas })],
  ['POST', '/api/admin/quotas', () => ok({ ok: true, id: mintId(), created: true })],
  ['PATCH', '/api/admin/quotas/:id', ({ params }) => ok({ ok: true, id: params.id })],
  ['GET', '/api/funnel/summary', ({ query }) => ok(funnelSummary(query.get('from'), query.get('to'), query.get('role_id'), true))],
  ['GET', '/api/admin/funnel/summary', ({ query }) => ok(funnelSummary(query.get('from'), query.get('to'), query.get('role_id'), false))],
  ['GET', '/api/admin/funnel/failures', (_r, db) => ok(db.funnelFailures)],
  ['GET', '/api/admin/funnel/candidates', ({ query }, db) => {
    const limit = Number(query.get('limit') ?? 50);
    const offset = Number(query.get('offset') ?? 0);
    return ok({ candidates: db.funnelCandidates.slice(offset, offset + limit), limit, offset });
  }],
  ['POST', '/api/admin/funnel/refresh', () => ok({ ok: true, result: { refreshed_days: 30 } })],
  ['GET', '/api/admin/allowlist', (_r, db) => ok({ entries: db.allowlist })],
  ['POST', '/api/admin/allowlist', ({ body }, db) => {
    const id = mintId();
    db.allowlist.push({ id, email: String(body?.email ?? ''), role: (body?.role as 'viewer') ?? 'viewer', active: true, linked_user_id: null, linked_at: null });
    return ok({ ok: true, id });
  }],
  ['PATCH', '/api/admin/allowlist/:id', ({ params, body }, db) => {
    const entry = db.allowlist.find((e) => e.id === params.id);
    if (!entry) return notFound('allowlist entry');
    Object.assign(entry, body);
    return ok({ ok: true });
  }],

  // ── Ashby Mission Control ──────────────────────────────────────────
  ['GET', `${ASHBY}/mappings`, (_r, db) => ok({ ok: true, mappings: db.ashby.mappings })],
  ['POST', `${ASHBY}/mappings`, ({ body }, db) => {
    const id = mintId();
    db.ashby.mappings.push({ id, externalJobId: String(body?.external_job_id ?? ''), status: 'paused', statusReason: null, deliveryMode: String(body?.delivery_mode ?? 'email'), hasAiStage: true, hasTaStage: true, label: (body?.label as string | null) ?? null, roleId: String(body?.role_id ?? ''), updatedAt: nowIso() });
    return ok({ ok: true, id, status: 'paused' });
  }],
  ['POST', `${ASHBY}/mappings/:id/pause`, ({ params }, db) => {
    const m = db.ashby.mappings.find((x) => x.id === params.id);
    if (m) m.status = 'paused';
    return ok({ ok: true, status: 'paused' });
  }],
  ['POST', `${ASHBY}/mappings/:id/resume`, ({ params }, db) => {
    const m = db.ashby.mappings.find((x) => x.id === params.id);
    if (m) m.status = 'enabled';
    return ok({ ok: true, status: 'enabled' });
  }],
  ['POST', `${ASHBY}/mappings/:id/archive`, ({ params }, db) => {
    db.ashby.mappings = db.ashby.mappings.filter((x) => x.id !== params.id);
    return ok({ ok: true });
  }],
  ['POST', `${ASHBY}/mappings/:id/backlog/preview`, ({ params }, db) => {
    const m = db.ashby.mappings.find((x) => x.id === params.id);
    if (!m) return notFound('mapping');
    return ok({ ok: true, preview: { runId: mintId(), mappingId: m.id, externalJobId: m.externalJobId, stageId: 'e2e-stage-ai-screening', expectedCount: 14, cap: 200, expiresAt: new Date(FROZEN_NOW_MS + 15 * 60_000).toISOString(), configVersion: 3, activationEpoch: 2 } });
  }],
  ['POST', `${ASHBY}/mappings/:id/backlog/confirm`, ({ body }) => ok({ ok: true, status: 'queued', run_id: String(body?.run_id ?? ''), queued_count: Number(body?.expected_count ?? 0) })],
  ['GET', `${ASHBY}/mappings/:id/scorecard-binding`, (_r, db) => ok(db.ashby.bindingPreview)],
  ['GET', `${ASHBY}/workflows`, (_r, db) => ok({ ok: true, workflows: db.ashby.workflows })],
  ['POST', `${ASHBY}/workflows/:id/cancel`, () => ok({ ok: true, status: 'cancelled', cancelled_operations: 1, cancelled_ingestion: 0 })],
  ['POST', `${ASHBY}/workflows/:id/invite`, () => ok({ ok: true, invite_id: mintId(), join_url: 'https://hello.example.com/candidate/join#invite=e2e-one-time-token', expires_at: new Date(FROZEN_NOW_MS + 24 * 3_600_000).toISOString(), ttl_hours: 24, revoked_invites: 0 } satisfies AshbyManualInviteResponse)],
  ['GET', `${ASHBY}/jobs`, (_r, db) => ok({ ok: true, jobs: db.ashby.jobs, truncated: false, withheld: db.ashby.withheld })],
  ['GET', `${ASHBY}/jobs/:jobId/feedback-form`, (_r, db) => ok({ ok: true, forms: [db.ashby.feedbackForm], empty: false, truncated: false })],
  ['POST', `${ASHBY}/operations/:id/retry`, () => ok({ ok: true, status: 'pending' })],

  // ── Ashby candidate-scoped review (opaque application link) ────────
  ['GET', '/api/integrations/ashby/review/:linkId', ({ params }, db) => {
    const detail = params.linkId === SCOPED_REVIEW_LINK_ID ? db.candidateDetail(STAR_CANDIDATE_ID) : null;
    return detail ? ok(detail) : notFound('application link');
  }],
  ['GET', '/api/integrations/ashby/review/:linkId/notes', ({ params }, db) => ok({ notes: params.linkId === SCOPED_REVIEW_LINK_ID ? db.notes.filter((n) => n.candidate_id === STAR_CANDIDATE_ID) : [] })],
  ['GET', '/api/integrations/ashby/review/:linkId/workflow', ({ params }, db) => ok({ ok: true, workflow: params.linkId === SCOPED_REVIEW_LINK_ID ? db.ashbyWorkflowFor(STAR_CANDIDATE_ID) : null })],

  // ── Phone calendar ─────────────────────────────────────────────────
  ['GET', '/api/phone/calendar', ({ query }, db) => {
    const from = Date.parse(query.get('from') ?? '');
    const to = Date.parse(query.get('to') ?? '');
    const appointments = db.appointments.filter((a) => {
      const t = Date.parse(a.starts_at);
      return t >= from && t < to;
    });
    return ok({ ok: true, enabled: true, range: { from: query.get('from') ?? '', to: query.get('to') ?? '' }, window: PHONE_WINDOW, count: appointments.length, truncated: false, appointments } satisfies PhoneCalendarResponse);
  }],
  ['GET', '/api/phone/calendar/slots', ({ query }, db) => {
    const date = query.get('date') ?? '';
    const slots = phoneSlots(date, db.appointments);
    return ok({ ok: true, enabled: true, date, window: PHONE_WINDOW, slot_seconds: 1800, max_concurrent: 2, booked_total: slots.reduce((s, x) => s + x.booked, 0), occupancy_truncated: false, slots } satisfies PhoneSlotsResponse);
  }],
  ['POST', '/api/phone/appointments', () => ok(phoneWrite())],
  ['PATCH', '/api/phone/appointments/:id', () => ok(phoneWrite())],
  ['DELETE', '/api/phone/appointments/:id', ({ params }) => ok({ ok: true, appointment_id: params.id, version: 3, already_cancelled: false })],

  // ── Scorecards: metric library ("Scorebar") + role scorecards ──────
  ['GET', '/api/scorecards/metrics', (_r, db) => ok(db.metrics)],
  ['POST', '/api/scorecards/metrics', ({ body }, db) => {
    const name = String(body?.name ?? 'New metric');
    const metric: ScorecardMetricTemplate = { id: mintId(), key: String(body?.key ?? name.toLowerCase().replace(/[^a-z0-9]+/g, '_')), name, description: (body?.description as string | null) ?? null, default_instruction: String(body?.default_instruction ?? ''), rubric: body?.rubric as ScorecardMetricTemplate['rubric'], archived_at: null, version: 1, created_at: nowIso(), updated_at: nowIso(), created_by: ADMIN_USER_ID };
    db.metrics.push(metric);
    return created(metric);
  }],
  ['PATCH', '/api/scorecards/metrics/:id', ({ params, body }, db) => {
    const metric = db.metrics.find((m) => m.id === params.id);
    if (!metric) return notFound('metric');
    Object.assign(metric, body, { version: metric.version + 1, updated_at: nowIso() });
    return ok(metric);
  }],
  ['POST', '/api/scorecards/metrics/:id/archive', ({ params }, db) => {
    const metric = db.metrics.find((m) => m.id === params.id);
    if (!metric) return notFound('metric');
    db.metrics = db.metrics.filter((m) => m.id !== params.id);
    return ok({ ...metric, archived_at: nowIso() });
  }],
  ['GET', '/api/scorecards/roles/:roleId/scorecard', ({ params }, db) => ok({ scorecard: db.roleScorecards[params.roleId] ?? null })],
  ['PUT', '/api/scorecards/roles/:roleId/scorecard', ({ params }, db) => ok({ scorecard: db.roleScorecards[params.roleId] ?? null })],
  ['POST', '/api/scorecards/roles/:roleId/scorecard/redistribute', ({ body }) => {
    const metrics = (body?.metrics ?? []) as RoleScorecardMetric[];
    return ok({ metrics: redistribute(metrics, String(body?.editedMetricId ?? ''), Number(body?.newWeightBps ?? 0)) });
  }],
];

interface CompiledRoute {
  method: string;
  pattern: string;
  regex: RegExp;
  keys: string[];
  handler: Handler;
}

const COMPILED: CompiledRoute[] = ROUTES.map(([method, pattern, handler]) => {
  const keys: string[] = [];
  const source = pattern
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':')) return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      keys.push(segment.slice(1));
      return '([^/]+)';
    })
    .join('/');
  return { method, pattern, regex: new RegExp(`^${source}$`), keys, handler };
});

/** Every `METHOD pattern` the router answers — handy when reporting a gap. */
export const KNOWN_ENDPOINTS = COMPILED.map((r) => `${r.method} ${r.pattern}`);

/**
 * Resolve one request. `null` means "no row matches": the caller must treat
 * that as a harness gap, never as an empty success.
 */
export function routeApi(method: string, url: URL, body: Record<string, unknown> | null, db: Dataset): MockResponse | null {
  for (const route of COMPILED) {
    if (route.method !== method) continue;
    const match = route.regex.exec(url.pathname);
    if (!match) continue;
    const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(match[i + 1])]));
    return route.handler({ method, path: url.pathname, query: url.searchParams, params, body }, db);
  }
  return null;
}
