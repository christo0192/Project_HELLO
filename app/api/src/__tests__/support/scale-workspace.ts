/**
 * scale-workspace.ts — a whole workspace at real scale, for scale-guard.test.ts.
 *
 * M026 root cause 1: every check the project ran used a 26-candidate fixture,
 * so reads that break past about 390 ids, or past PostgREST's 1000-row cap,
 * passed every check and failed in production. This seeds `n` candidates and
 * related rows in proportion, into the tables of a support/scale-db.ts engine,
 * and returns what a complete answer looks like.
 *
 * Per candidate i (owner: the interviewer when i is even, else the admin):
 *   - one Ashby application link (resume ready; writeback pending unless i % 4 = 0),
 *     on job mapping i % M (M = n / 20), whose job is wired for HR tracking;
 *   - one phone call session and one phone engagement with one dial;
 *   - two notification intents;
 *   - an assessment on the phone session when i % 3 = 0 (evidence insufficient
 *     when i % 6 = 0), an older rescore before it in storage when i % 9 = 0,
 *     and a NEWER R1 practice assessment when i % 30 = 0, which every
 *     recruiter view must leave out;
 *   - a callback appointment when i % 10 = 0, inside the calendar window;
 *   - a dial failure when i is odd, inside the failure window;
 *   - one count in the funnel rollup row for (day i % 365, role i % 12), so
 *     the rollup grows with the workspace up to 4,380 rows a year.
 */
import type { Row } from './scale-db.js';

export const SCALE_ADMIN_ID = '0a000000-0000-4000-8000-000000000001';
export const SCALE_INTERVIEWER_ID = '0b000000-0000-4000-8000-000000000002';

const pad = (i: number): string => String(i).padStart(12, '0');

export const scaleIds = {
  candidate: (i: number) => `00000000-0000-4000-8000-${pad(i)}`,
  assessment: (i: number, k = 0) => `a0000000-0000-4000-8000-${pad(i * 10 + k)}`,
  session: (i: number) => `5e000000-0000-4000-8000-${pad(i)}`,
  r1Session: (i: number) => `51000000-0000-4000-8000-${pad(i)}`,
  link: (i: number) => `11000000-0000-4000-8000-${pad(i)}`,
  engagement: (i: number) => `e0000000-0000-4000-8000-${pad(i)}`,
  appointment: (i: number) => `ab000000-0000-4000-8000-${pad(i)}`,
  intent: (i: number, k: number) => `1e000000-0000-4000-8000-${pad(i * 2 + k)}`,
  mapping: (m: number) => `3a000000-0000-4000-8000-${pad(m)}`,
  role: (r: number) => `10000000-0000-4000-8000-${pad(r)}`,
  rollup: (k: number) => `f0000000-0000-4000-8000-${pad(k)}`,
  failure: (i: number) => `fa000000-0000-4000-8000-${pad(i)}`,
  round: (i: number) => `20000000-0000-4000-8000-${pad(i)}`,
  roundSession: (i: number) => `52000000-0000-4000-8000-${pad(i)}`,
};

export const SCALE_ROLES = 12;
const BASE_MS = Date.UTC(2026, 9, 1);
/** Candidate i was created i minutes after 2026-10-01T00:00Z. */
export const scaleIso = (i: number, plusSeconds = 0): string => new Date(BASE_MS + i * 60_000 + plusSeconds * 1000).toISOString();

/** The funnel window the guard reads: 365 days ending here. */
export const FUNNEL_TO = '2026-10-31';
export const FUNNEL_FROM = '2025-11-01';
/** The failure window the guard reads: 30 days ending at FUNNEL_TO. */
export const FAILURES_FROM = '2026-10-02';
/** The calendar window the guard reads (30 days, inside the 31-day bound). */
export const CALENDAR_FROM = '2026-11-10T00:00:00Z';
export const CALENDAR_TO = '2026-12-10T00:00:00Z';

const dayBefore = (ymd: string, days: number): string =>
  new Date(Date.parse(`${ymd}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

const REC = ['advance', 'hold', 'reject'] as const;

export interface ScaleWorkspace {
  n: number;
  /** Ids the interviewer owns. */
  owned: Set<string>;
  /** Each assessed candidate's latest phone assessment, by candidate id. */
  latest: Map<string, { score: number; recommendation: string }>;
  /** Intents newest first: [id, candidate_id, created_at]. */
  intentsNewestFirst: Array<{ id: string; candidate_id: string; created_at: string }>;
  mappings: number;
  /** Is link i held for evidence (parked, newest phone grade insufficient)? */
  heldForEvidence: (i: number) => boolean;
  appointments: number;
  failures: number;
  rollupRows: number;
}

export function seedScaleWorkspace(tables: Record<string, Row[]>, n: number): ScaleWorkspace {
  const t = (name: string): Row[] => (tables[name] ??= []);
  const mappings = Math.max(10, Math.ceil(n / 20));
  const owned = new Set<string>();
  const latest = new Map<string, { score: number; recommendation: string }>();
  const intents: Array<{ id: string; candidate_id: string; created_at: string }> = [];
  const rollup = new Map<string, Row>();
  let appointments = 0;
  let failures = 0;

  for (let r = 0; r < SCALE_ROLES; r += 1) {
    t('roles').push({ id: scaleIds.role(r), title: `Role ${r}`, owner_id: SCALE_ADMIN_ID, created_at: scaleIso(r) });
  }
  for (let m = 0; m < mappings; m += 1) {
    t('ashby_job_mappings').push({
      id: scaleIds.mapping(m), provider: 'ashby', external_job_id: `job_${m}`, status: 'enabled', status_reason: null,
      delivery_mode: 'manual', ai_screening_stage_id: `stage_ai_${m}`, ta_screening_stage_id: null,
      reference_check_stage_id: `stage_ref_${m}`, label: `Job ${m}`, role_id: scaleIds.role(m % SCALE_ROLES),
      updated_at: scaleIso(m), archived_at: null,
    });
  }

  for (let i = 0; i < n; i += 1) {
    const id = scaleIds.candidate(i);
    const owner = i % 2 === 0 ? SCALE_INTERVIEWER_ID : SCALE_ADMIN_ID;
    if (owner === SCALE_INTERVIEWER_ID) owned.add(id);
    const mapping = i % mappings;

    t('candidates').push({
      id, name: `Candidate ${i}`, email: null, phone_e164: null, phone_valid: false, skills: [],
      experience_years: null, status: 'screened', role_id: scaleIds.role(i % SCALE_ROLES), created_at: scaleIso(i),
      decision_use_blocked_at: null, resume_id: null, owner_id: owner, ats_external_id: `ashby_${i}`,
    });
    t('call_sessions').push({
      id: scaleIds.session(i), candidate_id: id, role_id: scaleIds.role(i % SCALE_ROLES), owner_id: owner,
      status: i % 3 === 0 ? 'completed' : 'expired', interview_round_id: null,
      created_at: scaleIso(i), updated_at: scaleIso(i), started_at: null, ended_at: null,
    });
    t('ashby_application_links').push({
      id: scaleIds.link(i), provider: 'ashby', candidate_id: id, updated_at: scaleIso(i),
      job_mapping_id: scaleIds.mapping(mapping), intake_type: 'resume_parsing',
      ashby_resume_ingestions: [{ state: 'ready' }], ashby_operations: [],
      external_application_id: `app_${i}`, external_job_id: `job_${mapping}`,
      lifecycle: i % 4 === 0 ? 'ready' : 'writeback_pending', terminal_state: null,
      session_id: scaleIds.session(i), profile_outcome: null,
      // One mapping in sixty has had its stage observed (HR tracking is on).
      stage_synced_at: mapping % 60 === 59 ? scaleIso(i) : null,
      external_stage_id: mapping % 60 === 59 ? `stage_ref_${mapping}` : null,
    });
    t('phone_engagements').push({
      id: scaleIds.engagement(i), candidate_id: id, application_link_id: scaleIds.link(i),
      session_id: scaleIds.session(i), role_id: scaleIds.role(i % SCALE_ROLES), cycle_number: 1,
      state: 'completed', state_reason: null, epoch: 1, version: 1, no_answer_attempts: 0, reconnects_used: 0,
      provider_failures: 0, next_eligible_at: null, last_attempt_at: scaleIso(i), terminal_at: scaleIso(i),
      created_at: scaleIso(i), updated_at: scaleIso(i),
      phone_call_attempts: [{ state: 'ended', abandon_reason: null, outcome_class: 'completed', admitted_at: scaleIso(i), answered_at: scaleIso(i) }],
    });
    for (let k = 0; k < 2; k += 1) {
      const intent = { id: scaleIds.intent(i, k), candidate_id: id, created_at: scaleIso(i, 10 + k) };
      intents.push(intent);
      t('notification_intents').push({ ...intent, kind: 'assessment_ready', consent_verified: k === 0, idempotency_key: `intent:${i}:${k}` });
    }

    if (i % 9 === 0) {
      // An older rescore, stored FIRST: only the read's ORDER BY can pick the newest.
      t('assessments').unshift({
        id: scaleIds.assessment(i, 1), candidate_id: id, session_id: scaleIds.session(i), overall_score: 5,
        recommendation: 'reject', evidence_grade: 'decision', created_at: scaleIso(i, -30), source: 'phone',
      });
    }
    if (i % 3 === 0) {
      const score = 40 + (i % 50);
      const recommendation = REC[(i / 3) % 3];
      latest.set(id, { score, recommendation });
      t('assessments').push({
        id: scaleIds.assessment(i), candidate_id: id, session_id: scaleIds.session(i), overall_score: score,
        recommendation, evidence_grade: i % 6 === 0 ? 'insufficient' : 'decision', created_at: scaleIso(i, 30), source: 'phone',
      });
    }
    if (i % 30 === 0) {
      t('call_sessions').push({
        id: scaleIds.r1Session(i), candidate_id: id, role_id: null, owner_id: owner, status: 'completed',
        interview_round_id: `r1-round-${i}`, created_at: scaleIso(i, 40), updated_at: scaleIso(i, 40),
        started_at: null, ended_at: null,
      });
      t('assessments').push({
        id: scaleIds.assessment(i, 2), candidate_id: id, session_id: scaleIds.r1Session(i), overall_score: 99,
        recommendation: 'advance', evidence_grade: 'decision', created_at: scaleIso(i, 50), source: 'r1',
      });
    }
    if (i % 10 === 0) {
      const startMs = Date.parse(CALENDAR_FROM) + (i / 10) * 60 * 60_000;
      const startsAt = new Date(startMs).toISOString();
      t('phone_appointments').push({
        id: scaleIds.appointment(i), engagement_id: scaleIds.engagement(i), starts_at: startsAt,
        ends_at: new Date(startMs + 30 * 60_000).toISOString(),
        ist_date: new Date(startMs + 330 * 60_000).toISOString().slice(0, 10),
        status: 'scheduled', source: 'hr_manual', confirmed_at: null, cancel_reason: null, version: 1,
        created_at: scaleIso(i), updated_at: scaleIso(i),
      });
      appointments += 1;
    }
    if (i % 2 === 1) {
      t('v_funnel_failures').push({
        id: scaleIds.failure(i), stage: 'dial', code: i % 4 === 1 ? 'provider_error' : 'no_answer', entity_id: id,
        occurred_at: `${dayBefore(FUNNEL_TO, i % 30)}T12:00:00.000Z`,
      });
      failures += 1;
    }

    const day = dayBefore(FUNNEL_TO, i % 365);
    const role = scaleIds.role(i % SCALE_ROLES);
    const key = `${day}|${role}`;
    let row = rollup.get(key);
    if (!row) {
      row = {
        id: scaleIds.rollup(rollup.size), cohort_day: day, role_id: role, entered_parse: 0, parsed_ok: 0, dialed: 0,
        connected: 0, candidates_total: 0, connects_total: 0, refreshed_at: '2026-10-31T23:00:00.000Z',
        median_ttfc_sec: null, p95_ttfc_sec: null,
      };
      rollup.set(key, row);
    }
    for (const f of ['entered_parse', 'parsed_ok', 'dialed', 'connected', 'candidates_total', 'connects_total']) {
      (row[f] as number) += 1;
    }
  }
  t('funnel_stage_daily').push(...rollup.values());
  t('funnel_rollup_runs').push({ id: 1, ran_at: '2026-10-31T23:00:00.000Z' });

  const parked = (i: number) => i % 4 !== 0;
  return {
    n,
    owned,
    latest,
    intentsNewestFirst: [...intents].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0)),
    mappings,
    heldForEvidence: (i) => parked(i) && i % 6 === 0,
    appointments,
    failures,
    rollupRows: rollup.size,
  };
}

export interface ScaleRounds {
  /** Round ids by the view they sit in, in sent order. */
  toReview: string[];
  inProgress: string[];
  reviewed: string[];
  /** Every round but the staff dry runs. */
  all: string[];
}

/**
 * An R1 round for every candidate of a seeded workspace, so the rounds pass both the row cap and the id
 * batch size. Kept out of seedScaleWorkspace: its sessions would change what the phone routes read.
 * Round i sits by i % 5: invited, running, completed and held, completed and advanced, completed with
 * auto-status off. A round is a staff dry run when i % 50 = 2. Decision use is blocked for candidate i
 * when i % 100 = 4, which takes the round out of To review.
 */
export function seedScaleRounds(tables: Record<string, Row[]>, n: number): ScaleRounds {
  const t = (name: string): Row[] => (tables[name] ??= []);
  const views: ScaleRounds = { toReview: [], inProgress: [], reviewed: [], all: [] };
  const STATES = [['invited', null], ['in_progress', null], ['completed', 'hold_flag'], ['completed', 'advanced'], ['completed', 'flag_off']] as const;
  t('interview_round_consents');

  for (let i = 0; i < n; i += 1) {
    const candidate = t('candidates')[i];
    const id = scaleIds.round(i);
    const [status, statusWrite] = STATES[i % 5];
    const dryRun = i % 50 === 2;
    const blocked = i % 100 === 4;
    if (blocked) candidate.decision_use_blocked_at = scaleIso(i);
    t('interview_rounds').push({
      id, candidate_id: candidate.id, status, status_write: statusWrite, expires_at: scaleIso(i, 3600), attempts_allowed: 2,
      attempts_counted: status === 'completed' ? 1 : 0, recommendation: status === 'completed' ? 'hold' : null, overall: status === 'completed' ? 58 : null,
      pending_reject_until: null, consent_locale: dryRun ? 'en-IN-x-staff' : 'en-IN', created_at: scaleIso(i), created_by: SCALE_ADMIN_ID,
    });
    if (status !== 'invited') {
      const session = scaleIds.roundSession(i);
      t('interview_round_attempts').push({ session_id: session, round_id: id, attempt_number: 1, counted: status === 'completed', outcome: null, created_at: scaleIso(i) });
      t('call_sessions').push({
        id: session, candidate_id: candidate.id, interview_round_id: id, status: status === 'completed' ? 'completed' : 'in_progress',
        created_at: scaleIso(i), updated_at: scaleIso(i), started_at: null, ended_at: status === 'completed' ? scaleIso(i, 1800) : null,
      });
      t('interview_round_recordings').push({
        session_id: session, round_id: id, status: status === 'completed' ? 'ready' : 'uploading', layout: 'combined', has_video: true,
        started_at_ms: 1_800_000_000_000, duration_ms: 1_500_000, camera_off_ms: 0, degraded_at_ms: null, degraded_reason: null, failure_reason: null,
        delete_after: '2027-02-01T00:00:00Z', delete_requested_at: null, delete_reason: null, deleted_at: null, updated_at: scaleIso(i),
      });
    }
    if (dryRun) continue;
    views.all.push(id);
    if (status !== 'completed') views.inProgress.push(id);
    else if (blocked) continue;
    else if (statusWrite === 'advanced') views.reviewed.push(id);
    else views.toReview.push(id);
  }
  return views;
}
