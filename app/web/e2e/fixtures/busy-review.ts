/**
 * A screening shaped like a real one, for what the star's short mock data cannot show: six metrics, one
 * with a long name and one with too little evidence, so provisional; five red flags; three quotes on
 * the weakest metric, and a call that dropped. Every word is invented for this file.
 *
 * It rewrites one test's private copy of the world, so no other spec sees it. Call it before `app.goto`.
 */

import type { Assessment, CandidatePhoneAttempt, Session, TranscriptLine } from '../../src/types';
import { STAR_CANDIDATE_ID, V2_SESSION_ID, type Dataset } from './data';

const CALL_START_MS = Date.parse('2026-10-12T05:44:00.000Z');
const CALL_LENGTH_SEC = 263;

const say = (speaker: TranscriptLine['speaker'], sec: number, text: string, is_gate = false): TranscriptLine => ({
  speaker,
  text,
  start_offset_sec: null,
  started_at_ms: CALL_START_MS + sec * 1000,
  is_gate,
});

const TRANSCRIPT: TranscriptLine[] = [
  say('bot', 1, 'Hello, this is Christy, an AI interviewer. This call is recorded and assessed. Is now a good time?', true),
  say('candidate', 7, 'Who is this please?', true),
  say('bot', 9, 'Christy, calling about your application. Do you consent to this call being recorded and assessed?', true),
  say('candidate', 14, 'Yes.', true),
  say('bot', 16, 'Thank you. Can I confirm your consent to continue?', true),
  say('candidate', 19, 'Yes, I consent.', true),
  say('bot', 28, 'Thanks for sharing that. Could you tell me how your last role was structured? That helps.'),
  say('candidate', 34, 'I have worked in inside sales for most of my career. I mostly spoke with working professionals about upskilling. My last role had around forty calls a day. Yes, that is right.'),
  say('bot', 53, 'Thanks for sharing that. Could you tell me how your last role was structured? What was your team measured on? That helps.'),
  say('candidate', 66, 'Follow-ups took most of the afternoon. Targets were monthly and set on revenue. I kept a simple tracker of every lead. My manager reviewed a sample of calls each week.'),
  say('bot', 84, 'Understood. When a prospect pushed back on price, what did you say?'),
  say('candidate', 92, 'When price came up, I asked what they were comparing it with. Then I explained what the program includes.'),
  say('bot', 106, 'How did that conversation usually end?'),
  say('candidate', 111, 'Most conversions came from second-week follow-ups. Some people simply wanted more time.'),
  say('bot', 124, 'How did your numbers compare with your targets?'),
  say('candidate', 130, 'Most quarters I was close to the number. Two quarters I went past it by a small margin.'),
  say('bot', 143, 'What is your current notice period?'),
  say('candidate', 149, 'I can start once my notice period ends. It is thirty days and can come down a little.'),
  say('bot', 161, 'Could you work from the office five days a week?'),
  say('candidate', 167, 'Working from the office is fine for me.'),
  say('bot', 176, 'Why are you looking to move now?'),
  say('candidate', 181, 'I want to stay somewhere I can grow into a team lead role. The last company was shrinking.'),
  say('bot', 196, 'What would make you stay for several years?'),
  say('candidate', 203, 'A clear path, and a manager who reviews calls with me. That is what kept me at my last place.'),
  say('bot', 221, 'Could you tell me what you expect to earn in this role?'),
  say('candidate', 229, 'Sorry, you are breaking up. Can you say that'),
];

const REASONING =
  'Sample reasoning, invented for this fixture. It wraps the way the real reasoning does. No part of it comes from a screening. It says what was heard, what was missing and how the two compare, and it runs on for a good while before it stops. It goes on to name the part of the rubric it used and what would have moved the rating up one step.';

const METRICS: { id: string; name: string; weightBps: number; score: 1 | 2 | 3 | 4 | null; quotes: string[] }[] = [
  {
    id: 'm-communication',
    name: 'Communication',
    weightBps: 6000,
    score: 2,
    quotes: ['My last role had around forty calls a day', 'Follow-ups took most of the afternoon', 'Targets were monthly and set on revenue'],
  },
  { id: 'm-compensation', name: 'Compensation fit', weightBps: 1000, score: null, quotes: [] },
  {
    id: 'm-relevance',
    name: 'Profile relevance',
    weightBps: 500,
    score: 3,
    quotes: ['I have worked in inside sales for most of my career', 'I mostly spoke with working professionals'],
  },
  {
    id: 'm-objections',
    name: 'Objection handling on price',
    weightBps: 1000,
    score: 3,
    quotes: ['When price came up, I asked what they were comparing it with', 'Then I explained what the program includes'],
  },
  {
    id: 'm-stability',
    name: 'Stability',
    weightBps: 500,
    score: 3,
    quotes: ['I want to stay somewhere I can grow into a team lead role', 'A clear path, and a manager who reviews calls with me'],
  },
  {
    id: 'm-logistics',
    name: 'Notice and location',
    weightBps: 1000,
    score: 4,
    quotes: ['I can start once my notice period ends', 'Working from the office is fine for me'],
  },
];

const RED_FLAGS = [
  'Example flag, invented for this fixture',
  'Second example flag, invented for this fixture',
  'Third example flag, invented for this fixture',
  'Fourth example flag, invented for this fixture',
  'Fifth example flag, invented for this fixture, and long enough to wrap onto a second line of the list',
];

function busyAssessment(base: Assessment, redFlags: number): Assessment {
  const metricResults = METRICS.map((metric) => ({
    configMetricId: metric.id,
    score: metric.score,
    evidenceStatus: metric.score === null ? ('insufficient_evidence' as const) : ('scored' as const),
    rationale: metric.score === null ? 'The call dropped before this topic was covered.' : REASONING,
    evidenceRefs: metric.quotes,
    metric: { id: metric.id, name: metric.name, weightBps: metric.weightBps },
  }));
  return {
    ...base,
    scoring_status: 'incomplete_evidence',
    overall_score: 43,
    recommendation: 'reject',
    role_fit: { score: 0, matched_skills: [], gaps: [], red_flags: RED_FLAGS.slice(-redFlags), notes: '' },
    metric_results: metricResults.map(({ metric: _metric, ...rest }) => rest),
    raw: { ...(base.raw as object), status: 'incomplete_evidence', metricResults, overallScore: 43, recommendation: 'reject' },
  } as Assessment;
}

/** One call, cut off mid-sentence, its end found by our check rather than seen. */
function droppedCall(): CandidatePhoneAttempt {
  const end = new Date(CALL_START_MS + CALL_LENGTH_SEC * 1000).toISOString();
  return {
    id: '77777777-7777-4777-8777-777777777701',
    attempt_seq: 1,
    admitted_at: new Date(CALL_START_MS - 12_000).toISOString(),
    answered_at: new Date(CALL_START_MS).toISOString(),
    ended_at: end,
    state: 'completed',
    abandon_reason: null,
    outcome_class: 'disconnected',
    duration_sec: CALL_LENGTH_SEC,
    connected_from: new Date(CALL_START_MS).toISOString(),
    connected_to: end,
    connected_to_source: 'detected',
    connected_sec: CALL_LENGTH_SEC,
    recorded_sec: CALL_LENGTH_SEC,
    recorded_sec_estimated: false,
    recording_started_at_ms: CALL_START_MS,
    tail_may_be_missing: false,
    session_ref: V2_SESSION_ID,
    recording: { state: 'ready' },
    consent_stage: 'after_consent',
    transcript: { href: `/sessions/${V2_SESSION_ID}`, scope: 'session', kind: 'session', shared_session: false },
  };
}

/**
 * The star's scored session becomes the busy one. `redFlags` counts the AI's flags: the insufficient
 * evidence line is one more, so the owner's measured sheet, which shows five lines in Check before
 * deciding, is `redFlags: 4`.
 */
export function makeReviewBusy(db: Dataset, { redFlags = RED_FLAGS.length }: { redFlags?: number } = {}): void {
  const detail = db.sessionDetails[V2_SESSION_ID];
  const assessment = busyAssessment(detail.assessment!, redFlags);
  const session: Session = { ...detail.session, recorded_total_sec: CALL_LENGTH_SEC, recorded_legs: 1 };
  detail.assessment = assessment;
  detail.session = session;
  detail.transcript = TRANSCRIPT;
  const roleId = db.candidates.find((candidate) => candidate.id === STAR_CANDIDATE_ID)!.role_id;
  db.roles.find((role) => role.id === roleId)!.title = 'Sales Program Advisor';

  const readCandidate = db.candidateDetail;
  db.candidateDetail = (id) => {
    const candidate = readCandidate(id);
    if (!candidate || id !== STAR_CANDIDATE_ID) return candidate;
    candidate.sessions = candidate.sessions.map((row) => (row.id === session.id ? session : row));
    candidate.assessments = candidate.assessments.map((row) => (row.id === assessment.id ? assessment : row));
    return candidate;
  };

  const readAttempts = db.phoneAttempts;
  db.phoneAttempts = (candidate) => (candidate.id === STAR_CANDIDATE_ID ? [droppedCall()] : readAttempts(candidate));

  const readWorkflow = db.ashbyWorkflowFor;
  db.ashbyWorkflowFor = (id) => {
    const workflow = readWorkflow(id);
    if (!workflow || id !== STAR_CANDIDATE_ID) return workflow;
    return {
      ...workflow,
      operations: [
        { type: 'scorecard_write', state: 'succeeded', errorCode: null, sessionCreatedAt: session.created_at, updatedAt: session.created_at },
      ],
    };
  };
}
