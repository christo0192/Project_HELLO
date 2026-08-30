/**
 * Post-call callback BACKSTOP — `runAssessmentImpl`'s best-effort booking from
 * the scorer's extraction. Three properties are pinned here:
 *
 *   1. PHONE + wants_callback + a resolvable time + NO existing live
 *      appointment → book once via `schedule_phone_appointment` with
 *      `source = 'system_deferral'`.
 *   2. IDEMPOTENT: an existing live appointment for the engagement (the in-call
 *      booking, or a prior backstop) → skip, never double-book.
 *   3. NEVER fails the assessment: a booking error is swallowed and the scored
 *      row is still returned; the browser path never runs any of this.
 *
 * Offline and deterministic: Supabase (`from` + `rpc`) and the provider are the
 * only mocked boundaries, and the real `runAssessmentImpl` runs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runAssessment, injectAssessmentRunner } from '../services/assessment.js';
import type { Assessment } from '../lib/types.js';

const { mockFrom, mockRpc, runClaudeJSONWithProvenance, insertNotificationIntent, observeAshbyCompletion } =
  vi.hoisted(() => ({
    mockFrom: vi.fn(),
    mockRpc: vi.fn(),
    runClaudeJSONWithProvenance: vi.fn(),
    insertNotificationIntent: vi.fn(),
    observeAshbyCompletion: vi.fn(),
  }));

vi.mock('../lib/supabase.js', () => ({
  supabase: {
    from: (...args: unknown[]) => mockFrom(...args),
    rpc: (...args: unknown[]) => mockRpc(...args),
  },
}));
vi.mock('../lib/claude.js', () => ({ runClaudeJSONWithProvenance }));
vi.mock('../lib/notification-intent.js', () => ({ insertNotificationIntent }));
vi.mock('../integrations/ashby/completion-observer.js', () => ({ observeAshbyCompletion }));

const CHAIN = [
  'select', 'insert', 'update', 'upsert', 'delete',
  'eq', 'neq', 'in', 'order', 'limit', 'single', 'maybeSingle',
] as const;

interface Call { table: string; method: string; args: unknown[] }

let calls: Call[] = [];
let queues = new Map<string, Array<{ data: unknown; error: unknown }>>();
let defaults = new Map<string, { data: unknown; error: unknown }>();

function enqueue(table: string, ...values: Array<{ data: unknown; error: unknown }>): void {
  queues.set(table, [...(queues.get(table) ?? []), ...values]);
}
function setDefault(table: string, value: { data: unknown; error: unknown }): void {
  defaults.set(table, value);
}
function ok(data: unknown) { return { data, error: null }; }
function callsFor(table: string, method?: string): Call[] {
  return calls.filter((c) => c.table === table && (method === undefined || c.method === method));
}

mockFrom.mockImplementation((table: string) => {
  const queue = queues.get(table);
  const cfg = (queue && queue.length > 0 ? queue.shift()! : defaults.get(table))
    ?? { data: null, error: null };
  const builder: Record<string, unknown> = {};
  for (const m of CHAIN) {
    builder[m] = (...args: unknown[]) => {
      calls.push({ table, method: m, args });
      return builder;
    };
  }
  builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve(cfg).then(resolve);
  builder.catch = (reject: (e: unknown) => unknown) => Promise.resolve(cfg).catch(reject);
  return builder;
});

const SESSION_ID = '00000000-0000-4000-8000-000000000001';
const CANDIDATE_ID = '00000000-0000-4000-8000-000000000002';
const ENGAGEMENT_ID = '00000000-0000-4000-8000-00000000000e';
const PHONE_ROOM = `phone-${SESSION_ID}`;
const CALL_STARTED = '2026-09-01T09:00:00.000Z';
const REQUESTED = '2026-09-02T09:30:00Z';

function baseAssessment(): Assessment {
  return {
    english: { band: 'C1', grammar: 8, vocabulary: 8, fluency: 8, coherence: 8, notes: 'clear' },
    tone: { clarity: 8, confidence: 8, professionalism: 8, sentiment: 'positive', notes: 'ok' },
    communication: {
      score: 8, clarity: 8, structure: 8, listening: 8, rapport: 8,
      english_proficiency: { band: 'C1', grammar: 8, vocabulary: 8, fluency: 8, coherence: 8, notes: 'c' },
      filler_usage: { level: 'low', impact_score: 8, examples: [], notes: '' },
      native_language_usage: { level: 'none', examples: [], impact_score: 9, notes: '' },
      notes: 'good',
    },
    motivation: { score: 8, notes: 'interested' },
    role_fit: { score: 8, matched_skills: [], gaps: [], red_flags: [], notes: 'fit' },
    overall_score: 0,
    recommendation: 'advance',
    summary: 'Strong candidate',
    resume_conflicts: [],
  };
}

function phoneSession() {
  return {
    id: SESSION_ID,
    candidate_id: CANDIDATE_ID,
    owner_id: null,
    role_id: null,
    status: 'completed',
    terminal_reason: 'conversation_complete',
    external_call_id: PHONE_ROOM,
    started_at: CALL_STARTED,
  };
}

let assessmentWith: Assessment;

beforeEach(() => {
  vi.clearAllMocks();
  injectAssessmentRunner(null);
  calls = [];
  queues = new Map();
  defaults = new Map();
  setDefault('call_sessions', ok(phoneSession()));
  setDefault('transcript_turns', ok([{ speaker: 'candidate', text: 'call me tomorrow at 3pm' }]));
  setDefault('candidates', ok({ name: 'Asha', parsed: null, decision_use_blocked_at: null }));
  setDefault('roles', ok({ title: 'Advisor', required_skills: [] }));
  setDefault('assessments', ok({ id: 'fresh-row' }));
  // The engagement the backstop resolves from the session.
  setDefault('phone_engagements', ok({ id: ENGAGEMENT_ID, version: 3 }));
  // The read-store idempotency probe reads `phone_appointments`; default = none.
  setDefault('phone_appointments', ok([]));
  assessmentWith = baseAssessment();
  assessmentWith.callback = { wants_callback: true, requested_at_iso: REQUESTED };
  runClaudeJSONWithProvenance.mockImplementation(async () => ({
    data: JSON.parse(JSON.stringify(assessmentWith)),
    requestedModel: 'sonnet',
  }));
  insertNotificationIntent.mockResolvedValue(undefined);
  observeAshbyCompletion.mockResolvedValue(undefined);
  // Default: booking succeeds.
  mockRpc.mockResolvedValue({ data: { status: 'ok', appointment_id: 'appt-x', version: 1 }, error: null });
});

afterEach(() => {
  injectAssessmentRunner(null);
});

describe('post-call callback backstop', () => {
  it('books a system_deferral callback when the candidate asked and none exists', async () => {
    const result = await runAssessment(SESSION_ID, { source: 'phone' });
    expect(result.id).toBeDefined();
    expect(mockRpc).toHaveBeenCalledWith(
      'schedule_phone_appointment',
      expect.objectContaining({
        p_engagement_id: ENGAGEMENT_ID,
        p_source: 'system_deferral',
        p_starts_at: expect.stringContaining('2026-09-02'),
      }),
    );
    // Resolved the engagement from the session.
    const engSelect = callsFor('phone_engagements', 'eq');
    expect(engSelect.some((c) => c.args[0] === 'session_id' && c.args[1] === SESSION_ID)).toBe(true);
  });

  it('is idempotent: skips when a live appointment already exists', async () => {
    // The in-call booking already produced a live row for this engagement.
    setDefault('phone_appointments', ok([
      { id: 'existing', engagement_id: ENGAGEMENT_ID, starts_at: REQUESTED, ends_at: REQUESTED,
        ist_date: '2026-09-02', status: 'confirmed', source: 'candidate_voice', version: 1,
        created_at: CALL_STARTED, updated_at: CALL_STARTED },
    ]));
    await runAssessment(SESSION_ID, { source: 'phone' });
    // No booking RPC — the callback is already owned.
    expect(mockRpc).not.toHaveBeenCalledWith('schedule_phone_appointment', expect.anything());
  });

  it('does nothing when wants_callback is false', async () => {
    assessmentWith.callback = { wants_callback: false, requested_at_iso: null };
    await runAssessment(SESSION_ID, { source: 'phone' });
    expect(mockRpc).not.toHaveBeenCalledWith('schedule_phone_appointment', expect.anything());
  });

  it('does nothing when there is no requested time', async () => {
    assessmentWith.callback = { wants_callback: true, requested_at_iso: null };
    await runAssessment(SESSION_ID, { source: 'phone' });
    expect(mockRpc).not.toHaveBeenCalledWith('schedule_phone_appointment', expect.anything());
  });

  it('a booking failure NEVER fails the assessment', async () => {
    mockRpc.mockRejectedValue(new Error('rpc exploded'));
    const result = await runAssessment(SESSION_ID, { source: 'phone' });
    // The scored row is still returned despite the booking blowing up.
    expect(result.id).toBeDefined();
    expect(result.recommendation).toBe('advance');
  });

  it('the browser path never runs the backstop', async () => {
    // A browser session (no phone room) with a callback field present must not
    // book anything — the block is gated on `isPhone`.
    setDefault('call_sessions', ok({
      ...phoneSession(),
      external_call_id: 'room-browser-1',
    }));
    await runAssessment(SESSION_ID); // no source → derived browser
    expect(mockRpc).not.toHaveBeenCalledWith('schedule_phone_appointment', expect.anything());
    expect(callsFor('phone_engagements')).toHaveLength(0);
  });
});
