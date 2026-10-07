/**
 * Shared fixtures for the R1 scorer suites: the R1 scorecard, a complete phase-labelled
 * interview, the trusted administration log that passes the gate, and a model answer builder
 * whose evidence references are valid by construction.
 */
import {
  R1_METRICS,
  R1_METRIC_KEYS,
  r1EvidencePhasesFor,
} from '../../lib/r1/rubric.js';
import type { RoleScorecardMetric, RoleScorecardVersion } from '../../lib/scorecards/contracts.js';
import type { R1AdminLogRow } from '../../lib/r1/admin-log.js';
import type { R1TurnRow } from '../../lib/r1/transcript.js';

export const METRIC_IDS: Record<string, string> = Object.fromEntries(
  R1_METRICS.map((metric, index) => [
    metric.key,
    `00000000-0000-4000-8000-0000000000${String(index + 1).padStart(2, '0')}`,
  ]),
);

export function r1Scorecard(): RoleScorecardVersion {
  const metrics: RoleScorecardMetric[] = R1_METRICS.map((metric, index) => ({
    id: METRIC_IDS[metric.key] as string,
    libraryMetricId: `10000000-0000-4000-8000-0000000000${String(index + 1).padStart(2, '0')}`,
    key: metric.key,
    name: metric.name,
    instruction: metric.instruction,
    rubric: metric.rubric,
    weightBps: metric.weightBps,
    displayOrder: index,
  }));
  return {
    id: '20000000-0000-4000-8000-000000000001',
    roleId: '30000000-0000-4000-8000-000000000001',
    version: 1,
    configurationHash: 'a'.repeat(64),
    metrics,
  };
}

const ROLEPLAY_CANDIDATE_LINES = [
  'Hi Meera, thanks for taking my call. What got you interested in data science?',
  'What does your current role look like, and what would you like to change about it?',
  'How did the free course go, and what stopped you from continuing with it?',
  'When you say evenings only, how many hours a week could you realistically give?',
  'So if I have this right, you want a structured path and a data role within a year.',
  'Our curriculum has nine modules, from Python fundamentals through to a capstone project.',
  'Free courses are great for starting, but personalized mentorship keeps you on track.',
  'We have flexible learning options, so the six months can fit around your family.',
  'The listed price is nine thousand dollars, with discounts depending on the payment plan.',
  'I can offer a discount on the monthly plan if we can pick a start date today.',
  'Would you like to talk to your husband this week so we can decide on Thursday?',
];

/** A complete, normal interview: icebreaker, role-play (learner lines are `bot`), wrap-up. */
export function interviewRows(): R1TurnRow[] {
  const rows: R1TurnRow[] = [];
  let index = 0;
  const push = (speaker: 'bot' | 'candidate', phase: string, text: string, interrupted = false) => {
    index += 1;
    rows.push({ turn_index: index, speaker, phase, text, interrupted });
  };
  push('bot', 'opening', 'Hi Ava, I am Christy, an AI interviewer from Interview Kickstart.');
  push('candidate', 'icebreaker', 'Hello, I am Ava O\'Neil and I have five years in customer success at an edtech company.');
  push('bot', 'icebreaker', 'Thank you. What did you enjoy most about that work?');
  push('candidate', 'icebreaker', 'I enjoy helping learners find the right path and watching them succeed.');
  push('bot', 'transition', 'We will now move to the role-play. You are the Program Advisor.');
  push('candidate', 'transition', 'Ready');
  push('bot', 'roleplay', 'Hello? Yes, this is Meera speaking.');
  for (const [i, line] of ROLEPLAY_CANDIDATE_LINES.entries()) {
    push('candidate', 'roleplay', line);
    push('bot', 'roleplay', i === 3 ? 'Okay, that is helpful. Let me think about it.' : 'Mm-hm, go on.', i === 5);
  }
  push('bot', 'roleplay', 'Okay, let\'s do it. Send me the enrolment link for that plan and I\'ll pay the deposit today.');
  push('bot', 'roleplay_exit', 'Let us pause the role-play here. Thank you.');
  push('candidate', 'wrapup', 'No questions from my side, thank you for your time today.');
  push('bot', 'closing', 'Thank you. The hiring team will be in touch. Goodbye.');
  return rows;
}

let logClock = 0;
function logRow(
  event_type: string,
  payload: Record<string, unknown>,
  extra: { turn_index?: number; family_id?: string } = {},
): R1AdminLogRow {
  logClock += 1;
  return {
    event_type,
    turn_index: extra.turn_index ?? null,
    family_id: extra.family_id ?? null,
    payload,
    created_at: new Date(Date.UTC(2026, 9, 6, 10, 0, logClock)).toISOString(),
  };
}

/** The trusted administration log of a clean session: everything the gate needs is present. */
export function cleanLogRows(): R1AdminLogRow[] {
  const rows: R1AdminLogRow[] = [];
  for (const [need, probed, revealed] of [['H1', 10, 12], ['H2', 14, 16], ['H3', 18, 20]] as const) {
    rows.push(logRow('need_revealed', { need, probed_turn: probed }, { turn_index: revealed }));
  }
  for (const [n, family] of ['F1', 'F2', 'F3', 'F4'].entries()) {
    rows.push(logRow('family_delivered', { slip_seconds: 5 }, { turn_index: 12 + n, family_id: family }));
    rows.push(logRow('push_delivered', { slip_seconds: 0 }, { turn_index: 14 + n, family_id: family }));
  }
  rows.push(logRow('counter_delivered', { slip_seconds: 2 }, { turn_index: 20, family_id: 'F1' }));
  rows.push(logRow('discount_detected', { amount_usd: 500, conditional: true, value_before: true }, { turn_index: 19 }));
  rows.push(logRow('time_cue', { roleplay_seconds: 660 }));
  rows.push(logRow('session_facts', {
    roleplay_seconds: 740,
    talk_share_pct: 52,
    longest_monologue_seconds: 40,
    barge_in_count: 0,
    question_count: 9,
    interruption_count: 0,
    first_audio_p95_ms: 2100,
  }));
  return rows;
}

type Scores = Partial<Record<string, number | null>>;

/**
 * A model answer for the R1 scorecard. A `null` score is `insufficient_evidence`. Evidence refs
 * cite a real candidate turn in an allowed phase, with a verbatim excerpt, so they validate.
 */
export function modelAnswer(
  rows: readonly R1TurnRow[],
  scores: Scores,
  options: { refs?: (key: string) => string[] } = {},
): { results: Array<Record<string, unknown>> } {
  const results = R1_METRICS.map((metric) => {
    const score = scores[metric.key] === undefined ? 3 : scores[metric.key];
    const phases = r1EvidencePhasesFor(metric.key);
    const turn = rows.find((row) => row.speaker === 'candidate'
      && row.phase !== null && (phases as readonly string[]).includes(row.phase)
      && row.text.length > 70);
    // Past the candidate's name (masked in the prompt), so the excerpt is verbatim either way.
    const defaultRefs = turn ? [`T${turn.turn_index}: ${turn.text.slice(30, 70)}`] : [];
    return {
      configMetricId: METRIC_IDS[metric.key],
      score,
      evidenceStatus: score === null ? 'insufficient_evidence' : 'scored',
      rationale: score === null
        ? 'Not enough evidence in the scored phases.'
        : `The advisor handled this at level ${score}, citing the cited turn.`,
      evidenceRefs: options.refs ? options.refs(metric.key) : defaultRefs,
    };
  });
  return { results };
}

export { R1_METRIC_KEYS };
