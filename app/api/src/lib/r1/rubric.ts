/**
 * The R1 (Sales Program Advisor role-play) scorecard: five hand-written metrics
 * on the 1-4 scale, anchors of at most 500 characters each.
 *
 * SOURCES. The metrics, weights (D6: 25/25/15/15/20, Product knowledge off in v1) and
 * the countable behaviours come from R1-PLAN-final.md 6.1. The sales skills evaluated and
 * the facts an advisor may legitimately use come from the HR prep deck ("Interview
 * Kickstart Sales Mock Preparation Guide": who should opt for the course, career
 * opportunities, curriculum, USPs, the $9,000 price with $500/$1,000/$1,500 discounts
 * depending on the payment plan, and the urgency levers). The deck is the ONLY product
 * source (owner decision 2026-10-06): there is no separate world-facts sheet.
 *
 * ISOLATION. This module is the single definition. `scripts/seed-r1-role.ts` seeds the
 * role scorecard from it and `lib/r1/scorer.ts` reads the evidence phases from it, so the
 * rubric the candidate is scored against cannot drift from the one HR sees. It never
 * touches the phone scorer, its prompt, or `domain.ts`.
 *
 * The anchors are four levels exactly: `scorecard_metric_library` forbids a fifth key
 * (0093 `chk_scorecard_metric_library_rubric_four_level`).
 */

import { createHash } from 'node:crypto';
import type { ScorecardRubric } from '../scorecards/contracts.js';

/**
 * Bump when an anchor, weight or instruction changes in a semantically meaningful way.
 *
 * 10.2: the level-4 negotiation anchor ties a discount to "a payment plan or a prep-guide
 * urgency lever (application deadline, seasonal discount)", the plan 6.1 wording ("a sheet plan
 * or deadline"). The deck lists "upcoming application deadlines" and "seasonal discounts" among
 * its urgency levers, so a ladder discount tied to either must be able to reach level 4.
 * OWNER CONFIRMATION of this wording is pending.
 */
export const R1_RUBRIC_VERSION = 'r1-rubric-2026-10.2';

/**
 * The scoring provenance `prompt_template_version` for every R1 assessment. It is
 * deliberately NOT `SCORING_PROMPT_TEMPLATE_VERSION` (prompts.ts:9 stays unchanged).
 */
export const R1_SCORING_PROMPT_VERSION = 'r1-scoring-2026-10.1';

/** The `transcript_turns.phase` vocabulary (CHECK `chk_transcript_turns_phase`, 0116). */
export const R1_PHASES = [
  'opening',
  'icebreaker',
  'transition',
  'roleplay',
  'aside',
  'roleplay_exit',
  'wrapup',
  'closing',
] as const;
export type R1TurnPhase = (typeof R1_PHASES)[number];

export interface R1MetricDefinition {
  readonly key: string;
  readonly name: string;
  /** Per-role instruction (at most SCORECARD_MAX_INSTRUCTION_LENGTH = 1,000 characters). */
  readonly instruction: string;
  readonly weightBps: number;
  readonly rubric: ScorecardRubric;
  /**
   * The candidate phases an evidence reference for this metric may point into.
   * Probing, objection, urgency and negotiation evidence must come from ROLE-PLAY turns;
   * communication spans the icebreaker, the role-play and the wrap-up.
   */
  readonly evidencePhases: readonly R1TurnPhase[];
}

export const R1_METRIC_KEYS = {
  probing: 'r1_probing_discovery',
  objection: 'r1_objection_handling',
  urgency: 'r1_urgency_close',
  negotiation: 'r1_negotiation_discount',
  communication: 'r1_communication_rapport',
} as const;

const ROLEPLAY_ONLY: readonly R1TurnPhase[] = ['roleplay'];

export const R1_METRICS: readonly R1MetricDefinition[] = [
  {
    key: R1_METRIC_KEYS.probing,
    name: 'Probing & discovery',
    weightBps: 2500,
    evidencePhases: ROLEPLAY_ONLY,
    instruction:
      'Assess ONLY the candidate\'s ROLE-PLAY turns (phase roleplay): the candidate is the ' +
      'Program Advisor and the AI is a prospective learner. Count the open questions asked ' +
      'before the first pitch or price, the follow-ups that build on the learner\'s own ' +
      'answers, whether the advisor summarises the needs back, and whether the pitch refers to ' +
      'needs the learner stated. The trusted administration log shows which deep needs the ' +
      'learner actually revealed and the turn each was probed: treat it as ground truth for ' +
      'what the discovery produced. Who the course suits (recent graduates, current data ' +
      'professionals, career switchers, research scholars, tech enthusiasts) is a discovery ' +
      'topic, not a pitch.',
    rubric: {
      1: 'No discovery; opens with features, curriculum or price.',
      2: 'Mostly closed questions or an early pitch; needs surface only when the learner ' +
        'raises them herself.',
      3: 'At least 2 open questions before pitching, at least 1 follow-up, and at least 1 deep ' +
        'need revealed and linked to the pitch.',
      4: 'At least 4 open questions before the first pitch or price; at least 2 follow-ups that ' +
        'build on the learner\'s answers; at least 2 deep needs revealed (per the administration ' +
        'log); summarises the needs back; the pitch references at least 2 stated needs.',
    },
  },
  {
    key: R1_METRIC_KEYS.objection,
    name: 'Objection handling',
    weightBps: 2500,
    evidencePhases: ROLEPLAY_ONLY,
    instruction:
      'Assess ONLY role-play turns. The learner raises objections at worker-scheduled moments ' +
      '(value versus free alternatives, time, price and the $7,000 anchor, stalling); the ' +
      'administration log lists which were actually raised. Score only objections that were ' +
      'raised. Facts the advisor may use come only from the PREP-GUIDE FACTS block (750+ ' +
      'instructors from Google, Facebook, Amazon and Netflix, the nine modules, personalised ' +
      'mentorship, real-world projects, intensive mock interviews, career support, alumni ' +
      'success, flexible learning options, six months, $9,000). Penalise claims that contradict ' +
      'that block and promises it does not support, such as a guaranteed job, a refund or an ' +
      'undisclosed discount. Specifics the guide does not cover are neutral unless coercive.',
    rubric: {
      1: 'Argues with or dismisses the learner, or promises something the prep guide does not ' +
        'support (a guaranteed job, a refund, an undisclosed discount).',
      2: 'Generic or defensive answers; at least one objection ignored or left unresolved.',
      3: 'Answers most objections with relevant prep-guide facts; sometimes skips clarifying or ' +
        'checking whether the objection is resolved.',
      4: 'For each objection raised: acknowledges it, clarifies or reframes, answers with ' +
        'prep-guide facts tied to a need the learner stated, then checks it is resolved. No ' +
        'false claims.',
    },
  },
  {
    key: R1_METRIC_KEYS.urgency,
    name: 'Urgency & close',
    weightBps: 1500,
    evidencePhases: ROLEPLAY_ONLY,
    instruction:
      'Assess ONLY role-play turns. Legitimate urgency levers come from the prep guide: ' +
      'limited enrollment spots, upcoming application deadlines, seasonal discounts, high ' +
      'industry demand for data scientists, early access to resources, upcoming recruitment ' +
      'cycles, career advancement potential and proven success stories. Urgency must be tied ' +
      'to a need the learner stated and must not be coercive or fabricated. A reasoned "not ' +
      'right now" with a dated next step involving the decision-maker counts as a good close. ' +
      'The learner\'s own commitment response is scripted and masked: it is never evidence.',
    rubric: {
      1: 'Coercive or fabricated pressure, or urgency that contradicts the prep guide.',
      2: 'Vague urgency or no clear ask.',
      3: 'Some relevant urgency and asks for a next step.',
      4: 'Urgency tied to a need the learner stated, using a prep-guide lever without coercion; ' +
        'asks for a commitment or a dated next step with the decision-maker. A reasoned "not ' +
        'right now" with a dated next step also counts.',
    },
  },
  {
    key: R1_METRIC_KEYS.negotiation,
    name: 'Negotiation & discount discipline',
    weightBps: 1500,
    evidencePhases: ROLEPLAY_ONLY,
    instruction:
      'Assess ONLY role-play turns. The prep guide lists the course at $9,000 with discounts ' +
      'of $500, $1,000 and $1,500 depending on the payment plan chosen; the learner anchors at ' +
      '$7,000 and counters once after the advisor\'s first answer. Judge whether value is ' +
      'defended before any discount, whether any discount stays within $1,500, is tied to a ' +
      'payment plan or a prep-guide urgency lever (an application deadline or a seasonal ' +
      'discount) and is traded for a commitment, and how the advisor responds to the counter. ' +
      'Use the discounts detected in the administration log as ground truth for the amounts. ' +
      'The learner accepts any offer happily and never corrects the advisor; an overstep is ' +
      'the advisor\'s, not the learner\'s.',
    rubric: {
      1: 'Goes above $1,500, accepts the learner\'s $7,000 anchor, or invents discounts or ' +
        'freebies.',
      2: 'Offers the maximum discount quickly or unconditionally.',
      3: 'Stays within the $500/$1,000/$1,500 discounts and keeps them conditional, but concedes ' +
        'on the first ask or without getting a commitment in return.',
      4: 'Defends value before any discount and never opens with one; any discount is at most ' +
        '$1,500, tied to a payment plan or a prep-guide urgency lever (application deadline, ' +
        'seasonal discount) and traded for a commitment; holds or trades again after the ' +
        'learner\'s counter.',
    },
  },
  {
    key: R1_METRIC_KEYS.communication,
    name: 'Communication & rapport',
    weightBps: 2000,
    evidencePhases: ['icebreaker', 'roleplay', 'wrapup'],
    instruction:
      'Assess every CANDIDATE turn in the icebreaker, role-play and wrap-up phases. Use the ' +
      'worker-computed communication facts (talk share, longest monologue, barge-ins over the ' +
      'learner, questions, interruptions) as ground truth for the countable items, and judge ' +
      'clarity, structure, rapport and professionalism from the words. Referring back to the ' +
      'learner\'s own words counts. Ignore accent, grammar and speech-to-text artefacts, and ' +
      'any protected information the candidate discloses.',
    rubric: {
      1: 'Rude, incoherent or unprofessional.',
      2: 'Frequent monologues, 3 or more barge-ins over the learner, or disorganised answers.',
      3: 'Clear and polite; one monologue over 90 seconds, or a talk share slightly outside ' +
        '40-65%.',
      4: 'Clear, structured icebreaker answers; refers back to the learner\'s words at least ' +
        'twice; talk share 40-65%; no monologue over 90 seconds; professional throughout.',
    },
  },
];

/** The evidence phases for a configured metric key; an unknown key is role-play only. */
export function r1EvidencePhasesFor(metricKey: string): readonly R1TurnPhase[] {
  return R1_METRICS.find((metric) => metric.key === metricKey)?.evidencePhases ?? ROLEPLAY_ONLY;
}

/**
 * True when a role's active scorecard IS the R1 scorecard: exactly the five R1 metric keys,
 * each with its plan 6.1 weight. A role that still carries the 0089 default (phone) metrics, or
 * a half-seeded one, would otherwise be scored against metrics with no R1 evidence phases and
 * no integrity floor, and the result written to the round. Recruiter-edited instructions and
 * anchors are allowed (the scorecard is recruiter-authored); the key set and weights are not.
 */
export function r1ScorecardMatchesRubric(
  metrics: ReadonlyArray<{ readonly key: string; readonly weightBps: number }>,
): boolean {
  if (metrics.length !== R1_METRICS.length) return false;
  const weightByKey = new Map(metrics.map((metric) => [metric.key, metric.weightBps]));
  if (weightByKey.size !== R1_METRICS.length) return false;
  return R1_METRICS.every(
    (definition) => weightByKey.get(definition.key) === definition.weightBps,
  );
}

/** SHA-256 of the canonical rubric; pinned by a test so a silent edit cannot ship. */
export function r1RubricSha(): string {
  const canonical = R1_METRICS.map((metric) => ({
    key: metric.key,
    name: metric.name,
    instruction: metric.instruction,
    weightBps: metric.weightBps,
    rubric: [metric.rubric[1], metric.rubric[2], metric.rubric[3], metric.rubric[4]],
    evidencePhases: metric.evidencePhases,
  }));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
