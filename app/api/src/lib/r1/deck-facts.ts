/**
 * The product and sales facts the R1 scorer treats as ground truth.
 *
 * OWNER DECISION (2026-10-06, final): there is no separate world-facts sheet. Product facts
 * come ONLY from the HR prep deck "Interview Kickstart (IK) Sales Mock Preparation Guide".
 * Anything the deck does not state is unknown: the scorer neither rewards nor penalises a
 * plausible specific the deck does not cover (a cohort date, a class format) unless it is
 * coercive or contradicts the deck. This block is shown to the SCORER only. It is never
 * given to the learner model.
 *
 * Every number below is copied from the deck; do not add a fact the deck does not state.
 */

import { createHash } from 'node:crypto';

export const R1_DECK_FACTS_VERSION = 'r1-deck-facts-2026-10.1';

/** Deck page 2: "Listed Price Details: $9000", "Applicable Discounts: $500, $1000, $1500". */
export const R1_LIST_PRICE_USD = 9000;
export const R1_DISCOUNT_LADDER_USD: readonly number[] = [500, 1000, 1500];
export const R1_MAX_DISCOUNT_USD = 1500;
/** The learner's scripted price anchor (plan 5.5, F1). Not a deck fact: a persona line. */
export const R1_LEARNER_ANCHOR_USD = 7000;

export const R1_DECK_FACTS_TEXT = [
  'Interview Kickstart (IK) was founded in 2014 to help tech professionals succeed in career ' +
    'transitions and interview preparation.',
  'Products: interview prep courses across 18 engineering domains, designed to help engineers ' +
    'in the US clear interviews with top-tier tech companies; and career-transition courses in ' +
    'Machine Learning and Data Science for non-ML/DS engineers.',
  'USP: over 750 instructors from leading Silicon Valley companies such as Google, Facebook, ' +
    'Amazon and Netflix.',
  'Data Science course modules: Python Fundamentals; Database & SQL Programming; Math for Data ' +
    'Science & Machine Learning; Exploratory Data Analysis; Classical Machine Learning; Advanced ' +
    'Machine Learning & Deep Learning; Big Data Analysis; Data Visualization & Storytelling; ' +
    'Capstone Project.',
  'Listed price $9,000. Applicable discounts: $500, $1,000 and $1,500, depending on the payment ' +
    'plan chosen. Course duration: 6 months.',
  'Who should opt for the Data Science course: recent graduates, current data professionals, ' +
    'career switchers, research scholars, tech enthusiasts.',
  'Career opportunities in data science: Data Scientist, Machine Learning Engineer, Data ' +
    'Analyst, Business Intelligence Analyst, AI Research Scientist.',
  'Key USPs of the course and IK: expertly designed curriculum by industry leaders; ' +
    'personalized mentorship; real-world projects; intensive mock interviews; comprehensive ' +
    'career support; proven track record of alumni success; in-depth curriculum coverage; ' +
    'flexible learning options.',
  'Pricing message in the guide: transparency and flexibility; fair pricing that reflects the ' +
    'value of the program; open to discussing customised options for individual circumstances.',
  'Urgency levers listed in the guide: limited enrollment spots; upcoming application ' +
    'deadlines; seasonal discounts; high industry demand for data scientists; early access to ' +
    'resources; upcoming recruitment cycles; career advancement potential; proven success ' +
    'stories.',
];

/** What the guide does NOT state; the scorer must treat these as unknown, never as facts. */
export const R1_DECK_UNSTATED_TEXT =
  'The guide does NOT state: cohort start dates, enrollment deadlines or seat counts, which ' +
  'discount belongs to which payment plan, weekly hours, class format (live versus recorded), ' +
  'refund policy, or any job guarantee. Treat these as unknown. A plausible specific the ' +
  'guide does not cover is neutral unless it is coercive or contradicts the guide; a claim that ' +
  'contradicts the guide, a discount above $1,500 or outside $500/$1,000/$1,500, a guarantee ' +
  'of a job or refund, or an invented freebie is a violation.';

/** The block embedded in the scorer prompt. */
export function r1DeckFactsBlock(): string {
  return [
    ...R1_DECK_FACTS_TEXT.map((fact) => `- ${fact}`),
    '',
    R1_DECK_UNSTATED_TEXT,
  ].join('\n');
}

export function r1DeckFactsSha(): string {
  return createHash('sha256').update(r1DeckFactsBlock()).digest('hex');
}
