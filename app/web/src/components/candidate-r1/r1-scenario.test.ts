import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  discountLadderText,
  formatUsd,
  R1_SCENARIO_COPY,
  R1_SCENARIO_FACTS,
} from './r1-scenario';

/**
 * The role-play card shows three course facts as static copy. The interviewer (the worker's
 * `r1_world.py`) and the scorer (the API's `deck-facts.ts`) hold the same numbers. This is the
 * drift test: if either of those changes a number (or the guide is re-issued), the card must
 * change with it, and this fails until it does. Both files are read as text, so no worker or
 * API code runs here. A missing file fails the test, it does not skip it.
 */

const API_DECK_FACTS = resolve(process.cwd(), '..', 'api', 'src', 'lib', 'r1', 'deck-facts.ts');
const WORKER_WORLD = resolve(process.cwd(), '..', 'voice-livekit', 'r1_world.py');

const deckFacts = readFileSync(API_DECK_FACTS, 'utf8');
const world = readFileSync(WORKER_WORLD, 'utf8');

function numbers(list: string): number[] {
  return [...list.matchAll(/\d+/g)].map((match) => Number(match[0]));
}

function deckNumber(name: string): number {
  const match = new RegExp(`export const ${name}\\s*=\\s*(\\d+)\\s*;`).exec(deckFacts);
  if (!match) throw new Error(`deck-facts.ts no longer defines ${name}`);
  return Number(match[1]);
}

function deckLadder(): number[] {
  const match = /export const R1_DISCOUNT_LADDER_USD[^=]*=\s*\[([^\]]*)\]/.exec(deckFacts);
  if (!match) throw new Error('deck-facts.ts no longer defines R1_DISCOUNT_LADDER_USD');
  return numbers(match[1]);
}

function worldNumber(name: string): number {
  const match = new RegExp(`^${name}\\s*=\\s*(\\d+)\\s*$`, 'm').exec(world);
  if (!match) throw new Error(`r1_world.py no longer defines ${name}`);
  return Number(match[1]);
}

function worldLadder(): number[] {
  const match = /^DISCOUNTS_USD\s*=\s*\(([^)]*)\)/m.exec(world);
  if (!match) throw new Error('r1_world.py no longer defines DISCOUNTS_USD');
  return numbers(match[1]);
}

describe('the scenario card facts are the ones the interviewer and the scorer hold', () => {
  it('reads the numbers it compares from the real files', () => {
    expect(deckNumber('R1_LIST_PRICE_USD')).toBeGreaterThan(0);
    expect(deckLadder().length).toBeGreaterThanOrEqual(2);
    expect(worldNumber('PRICE_USD')).toBeGreaterThan(0);
    expect(worldNumber('DURATION_MONTHS')).toBeGreaterThan(0);
    expect(worldLadder().length).toBeGreaterThanOrEqual(2);
  });

  it('has the list price of the guide', () => {
    expect(R1_SCENARIO_FACTS.listPriceUsd).toBe(deckNumber('R1_LIST_PRICE_USD'));
    expect(R1_SCENARIO_FACTS.listPriceUsd).toBe(worldNumber('PRICE_USD'));
  });

  it('has the discount ladder of the guide, in the same order', () => {
    expect([...R1_SCENARIO_FACTS.discountsUsd]).toEqual(deckLadder());
    expect([...R1_SCENARIO_FACTS.discountsUsd]).toEqual(worldLadder());
    expect(Math.max(...R1_SCENARIO_FACTS.discountsUsd)).toBe(deckNumber('R1_MAX_DISCOUNT_USD'));
  });

  it('has the duration of the guide', () => {
    expect(R1_SCENARIO_FACTS.durationMonths).toBe(worldNumber('DURATION_MONTHS'));
    const stated = /Course duration:\s*(\d+)\s*months/.exec(deckFacts);
    expect(stated, 'deck-facts.ts states the course duration').not.toBeNull();
    expect(R1_SCENARIO_FACTS.durationMonths).toBe(Number(stated![1]));
  });

  it('still says the discounts depend on the payment plan, without saying which is which', () => {
    // The guide's own sentence is split across two string literals in deck-facts.ts.
    expect(deckFacts).toMatch(/depending on the payment/);
    expect(deckFacts).toMatch(/discount belongs to which payment plan/);
    expect(world).toMatch(/depending on the payment/);
  });

  it('shows those numbers, formatted, in the card copy', () => {
    expect(R1_SCENARIO_COPY.price).toBe('$9,000');
    expect(R1_SCENARIO_COPY.duration).toBe('6 months');
    expect(R1_SCENARIO_COPY.discounts).toBe('$500, $1,000 or $1,500, depending on the payment plan');
    const shown = numbers(`${R1_SCENARIO_COPY.price} ${R1_SCENARIO_COPY.discounts}`.replace(/,/g, ''));
    expect(shown).toEqual([
      deckNumber('R1_LIST_PRICE_USD'),
      ...deckLadder(),
    ]);
  });
});

describe('what the card must never say', () => {
  const everything = Object.values(R1_SCENARIO_COPY).join(' \n ');

  it('does not show the learner price anchor the candidate is probed on', () => {
    const anchor = deckNumber('R1_LEARNER_ANCHOR_USD');
    expect(everything).not.toContain(formatUsd(anchor));
    expect(everything).not.toContain(String(anchor));
    expect(everything).not.toMatch(/\b7,?000\b/);
  });

  it('does not show a learner need, budget, timeline or decision-maker', () => {
    expect(everything).not.toMatch(
      /budget|per month|a month|monthly|afford|salary|timeline|deadline|decision|spouse|partner|employer|loan|\bEMI\b/i,
    );
  });

  it('does not map a discount to a payment plan', () => {
    // Each discount is listed once, in one phrase, and no plan is named.
    expect(everything).not.toMatch(/upfront|up-front|instalment|installment|full payment|lump/i);
    expect(everything).not.toMatch(/\$500[^,.]*\b(plan|payment)\b/i);
    expect(R1_SCENARIO_COPY.discounts.match(/\$/g)).toHaveLength(R1_SCENARIO_FACTS.discountsUsd.length);
  });

  it('frames the goal as the advisor’s, not the learner’s', () => {
    expect(R1_SCENARIO_COPY.goal).toMatch(/^Your goal:/);
    expect(R1_SCENARIO_COPY.goal).toMatch(/understand their needs/);
    expect(R1_SCENARIO_COPY.goal).toMatch(/handle their concerns/);
    expect(R1_SCENARIO_COPY.goal).toMatch(/agree a clear next step/);
  });
});

describe('formatting', () => {
  it.each([
    [500, '$500'],
    [1000, '$1,000'],
    [1500, '$1,500'],
    [9000, '$9,000'],
    [12345678, '$12,345,678'],
  ])('writes %d as %s', (amount, text) => {
    expect(formatUsd(amount)).toBe(text);
  });

  it('lists a ladder the way people say it', () => {
    expect(discountLadderText([500, 1000, 1500])).toBe('$500, $1,000 or $1,500');
    expect(discountLadderText([500, 1000])).toBe('$500 or $1,000');
    expect(discountLadderText([500])).toBe('$500');
    expect(discountLadderText([])).toBe('');
  });
});
