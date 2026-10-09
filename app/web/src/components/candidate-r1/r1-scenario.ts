/**
 * What the role-play card tells the candidate about the call they are about to make.
 *
 * The course facts are the ones the owner fixed in the HR preparation guide, and the interviewer
 * (the worker's `r1_world.py`) and the scorer (the API's `deck-facts.ts`) hold the same three
 * numbers. They are static copy here, and `r1-scenario.test.ts` fails the build when any of the
 * three files stops agreeing with the others.
 *
 * What the card must NOT say, because it is what the candidate is assessed on finding out:
 *   - which discount belongs to which payment plan (the guide does not state it);
 *   - the learner's own budget or price anchor, their needs, their timeline or who decides.
 * The goal on the card is the ADVISOR's (the candidate's), never the learner's.
 */

export const R1_SCENARIO_FACTS = Object.freeze({
  course: 'Data Science',
  listPriceUsd: 9000,
  durationMonths: 6,
  /** The discounts the guide lists, "depending on the payment plan chosen". Not mapped to plans. */
  discountsUsd: Object.freeze([500, 1000, 1500]) as readonly number[],
});

/** 9000 -> "$9,000". Written out so the result never depends on the browser's locale data. */
export function formatUsd(amount: number): string {
  return `$${String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

/** "$500, $1,000 or $1,500", the ladder in the order the guide lists it. */
export function discountLadderText(discounts: readonly number[] = R1_SCENARIO_FACTS.discountsUsd): string {
  const amounts = discounts.map(formatUsd);
  if (amounts.length <= 1) return amounts.join('');
  return `${amounts.slice(0, -1).join(', ')} or ${amounts[amounts.length - 1]}`;
}

export const R1_SCENARIO_COPY = Object.freeze({
  heading: 'Your role-play',
  /** Shown until the interviewer has published the learner's name. */
  unnamedLearner: 'A prospective learner',
  intro:
    `Filled in a form about the ${R1_SCENARIO_FACTS.course} course. `
    + 'You are the Program Advisor, calling back.',
  priceLabel: 'List price',
  durationLabel: 'Duration',
  discountsLabel: 'Discounts',
  price: formatUsd(R1_SCENARIO_FACTS.listPriceUsd),
  duration: `${R1_SCENARIO_FACTS.durationMonths} months`,
  discounts: `${discountLadderText()}, depending on the payment plan`,
  goal:
    'Your goal: understand their needs, handle their concerns, and agree a clear next step.',
  inCharacter:
    'The interviewer stays in character until they say, “Let’s pause the role-play here.”',
});
