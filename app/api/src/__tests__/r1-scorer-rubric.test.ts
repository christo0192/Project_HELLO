/**
 * The R1 rubric (plan 6.1 + the HR prep deck): structure, derivation and pins.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  R1_METRICS,
  R1_METRIC_KEYS,
  R1_PHASES,
  R1_RUBRIC_VERSION,
  R1_SCORING_PROMPT_VERSION,
  r1EvidencePhasesFor,
  r1RubricSha,
  r1ScorecardMatchesRubric,
} from '../lib/r1/rubric.js';
import {
  R1_DECK_FACTS_TEXT,
  R1_DECK_FACTS_VERSION,
  R1_DISCOUNT_LADDER_USD,
  R1_LIST_PRICE_USD,
  R1_MAX_DISCOUNT_USD,
  r1DeckFactsBlock,
  r1DeckFactsSha,
} from '../lib/r1/deck-facts.js';
import {
  SCORECARD_MAX_INSTRUCTION_LENGTH,
  SCORECARD_MAX_NAME_LENGTH,
  SCORECARD_MAX_RUBRIC_DESCRIPTION_LENGTH,
  SCORECARD_WEIGHT_TOTAL_BPS,
} from '../lib/scorecards/contracts.js';
import { validateRoleMetrics, validateRubric } from '../lib/scorecards/domain.js';
import { createProvenance } from '../lib/model-provenance.js';
import { r1Scorecard } from './support/r1-scorer.js';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('R1 rubric structure', () => {
  it('has the five D6 metrics in plan 6.1 order with their weights', () => {
    expect(R1_METRICS.map((metric) => [metric.key, metric.weightBps])).toEqual([
      [R1_METRIC_KEYS.probing, 2500],
      [R1_METRIC_KEYS.objection, 2500],
      [R1_METRIC_KEYS.urgency, 1500],
      [R1_METRIC_KEYS.negotiation, 1500],
      [R1_METRIC_KEYS.communication, 2000],
    ]);
    expect(R1_METRICS.reduce((sum, metric) => sum + metric.weightBps, 0)).toBe(
      SCORECARD_WEIGHT_TOTAL_BPS,
    );
  });

  it('passes the shared scorecard validators unchanged (weights, keys, bounded text)', () => {
    expect(() => validateRoleMetrics(r1Scorecard().metrics)).not.toThrow();
    for (const metric of R1_METRICS) {
      expect(metric.name.length).toBeLessThanOrEqual(SCORECARD_MAX_NAME_LENGTH);
      expect(metric.instruction.length).toBeGreaterThan(0);
      expect(metric.instruction.length).toBeLessThanOrEqual(SCORECARD_MAX_INSTRUCTION_LENGTH);
      expect(metric.key).toMatch(/^[a-z][a-z0-9_]{1,62}$/);
    }
  });

  it('has exactly four anchors per metric, each at most 500 characters (no level 5)', () => {
    for (const metric of R1_METRICS) {
      expect(Object.keys(metric.rubric).sort()).toEqual(['1', '2', '3', '4']);
      expect(() => validateRubric(metric.rubric)).not.toThrow();
      for (const level of [1, 2, 3, 4] as const) {
        const anchor = metric.rubric[level];
        expect(anchor.length, `${metric.key} level ${level}`).toBeGreaterThan(10);
        expect(anchor.length, `${metric.key} level ${level}`)
          .toBeLessThanOrEqual(SCORECARD_MAX_RUBRIC_DESCRIPTION_LENGTH);
      }
    }
  });

  it('routes evidence to ROLE-PLAY turns for four metrics and to three phases for communication', () => {
    for (const key of [
      R1_METRIC_KEYS.probing,
      R1_METRIC_KEYS.objection,
      R1_METRIC_KEYS.urgency,
      R1_METRIC_KEYS.negotiation,
    ]) {
      expect(r1EvidencePhasesFor(key)).toEqual(['roleplay']);
    }
    expect(r1EvidencePhasesFor(R1_METRIC_KEYS.communication)).toEqual(['icebreaker', 'roleplay', 'wrapup']);
    // An unknown key defaults to the strictest reading.
    expect(r1EvidencePhasesFor('some_other_metric')).toEqual(['roleplay']);
    for (const metric of R1_METRICS) {
      for (const phase of metric.evidencePhases) expect(R1_PHASES).toContain(phase);
    }
  });
});

describe('R1 rubric derivation (plan 6.1 + prep deck)', () => {
  const anchors = (key: string) => R1_METRICS.find((metric) => metric.key === key)!.rubric;

  it('keeps the plan 6.1 countable behaviours', () => {
    expect(anchors(R1_METRIC_KEYS.probing)[4]).toMatch(/at least 4 open questions/i);
    expect(anchors(R1_METRIC_KEYS.probing)[4]).toMatch(/at least 2 deep needs/i);
    expect(anchors(R1_METRIC_KEYS.communication)[4]).toMatch(/40-65%/);
    expect(anchors(R1_METRIC_KEYS.communication)[4]).toMatch(/90 seconds/);
    expect(anchors(R1_METRIC_KEYS.communication)[2]).toMatch(/3 or more barge-ins/);
  });

  it('encodes the deck price, the $500/$1,000/$1,500 ladder and the learner anchor', () => {
    const negotiation = anchors(R1_METRIC_KEYS.negotiation);
    expect(negotiation[1]).toMatch(/\$1,500/);
    expect(negotiation[1]).toMatch(/\$7,000/);
    expect(negotiation[3]).toMatch(/\$500\/\$1,000\/\$1,500/);
    expect(negotiation[4]).toMatch(/payment plan/);
    expect(R1_LIST_PRICE_USD).toBe(9000);
    expect([...R1_DISCOUNT_LADDER_USD]).toEqual([500, 1000, 1500]);
    expect(R1_MAX_DISCOUNT_USD).toBe(1500);
  });

  it('lets a discount tied to a deck urgency lever reach level 4 (plan 6.1: "a sheet plan or deadline")', () => {
    // The deck lists "upcoming application deadlines" and "seasonal discounts" as urgency levers,
    // so a ladder discount tied to either is as acceptable as one tied to a payment plan.
    const negotiation = R1_METRICS.find((metric) => metric.key === R1_METRIC_KEYS.negotiation)!;
    expect(negotiation.rubric[4]).toMatch(/payment plan or a prep-guide urgency lever/);
    expect(negotiation.rubric[4]).toMatch(/application deadline/);
    expect(negotiation.rubric[4]).toMatch(/seasonal discount/);
    expect(negotiation.instruction).toMatch(/payment plan or a prep-guide urgency lever/);
    // Every lever the anchor names is one the deck facts list.
    const facts = r1DeckFactsBlock().toLowerCase();
    expect(facts).toContain('upcoming application deadlines');
    expect(facts).toContain('seasonal discounts');
    expect(negotiation.rubric[4].length).toBeLessThanOrEqual(SCORECARD_MAX_RUBRIC_DESCRIPTION_LENGTH);
    expect(negotiation.instruction.length).toBeLessThanOrEqual(SCORECARD_MAX_INSTRUCTION_LENGTH);
  });

  it('names the deck urgency levers and facts in the instructions', () => {
    const byKey = (key: string) => R1_METRICS.find((metric) => metric.key === key)!.instruction;
    const urgency = byKey(R1_METRIC_KEYS.urgency).toLowerCase();
    for (const lever of [
      'limited enrollment spots',
      'upcoming application deadlines',
      'seasonal discounts',
      'high industry demand',
      'early access to resources',
      'upcoming recruitment cycles',
      'career advancement',
      'success stories',
    ]) {
      expect(urgency, lever).toContain(lever);
    }
    const objection = byKey(R1_METRIC_KEYS.objection);
    expect(objection).toMatch(/750\+/);
    expect(objection).toMatch(/nine modules/);
    expect(byKey(R1_METRIC_KEYS.probing)).toMatch(/career switchers/);
  });

  it('never states a fact the deck does not (no cohort dates, hours, formats)', () => {
    const everything = R1_METRICS.map((metric) =>
      [metric.instruction, metric.rubric[1], metric.rubric[2], metric.rubric[3], metric.rubric[4]].join(' '),
    ).join(' ');
    expect(everything).not.toMatch(/cohort|per week|weekly hours|recorded|live classes|refund policy/i);
  });

  it('says the learner commitment response is masked evidence', () => {
    const urgency = R1_METRICS.find((metric) => metric.key === R1_METRIC_KEYS.urgency)!;
    expect(urgency.instruction).toMatch(/commitment response is scripted and masked/);
  });
});

describe('R1 deck facts (owner decision: the deck is the only product source)', () => {
  it('copies the deck facts and flags what the deck does not state', () => {
    const block = r1DeckFactsBlock();
    for (const fact of [
      'founded in 2014',
      '18 engineering domains',
      '750 instructors',
      'Python Fundamentals',
      'Capstone Project',
      '$9,000',
      '$500, $1,000 and $1,500',
      '6 months',
      'recent graduates',
      'Machine Learning Engineer',
      'personalized mentorship',
      'limited enrollment spots',
    ]) {
      expect(block, fact).toContain(fact);
    }
    expect(block).toMatch(/does NOT state/);
    expect(R1_DECK_FACTS_TEXT.length).toBeGreaterThanOrEqual(10);
  });
});

describe('R1 provenance and pins', () => {
  it('uses its own provenance version, accepted by the validator, not the phone template version', () => {
    expect(R1_SCORING_PROMPT_VERSION).toBe('r1-scoring-2026-10.1');
    expect(() => createProvenance({
      provider: 'deepseek',
      requestedModel: 'deepseek-v4-pro',
      workload: 'scoring',
      prompt_template_version: R1_SCORING_PROMPT_VERSION,
    })).not.toThrow();
    const prompts = readFileSync(path.resolve(here, '../lib/prompts.ts'), 'utf8');
    expect(prompts).toContain("SCORING_PROMPT_TEMPLATE_VERSION = '2026-08-05.1'");
    expect(prompts).not.toContain('r1-scoring');
  });

  it('pins the rubric and deck-facts content so a silent edit cannot ship', () => {
    expect(R1_RUBRIC_VERSION).toBe('r1-rubric-2026-10.2');
    expect(R1_DECK_FACTS_VERSION).toBe('r1-deck-facts-2026-10.1');
    expect(r1RubricSha()).toBe('b761b69cd498ea2d737bd669fc5a627ad9c82561bc19d0093ab60a928029605a');
    expect(r1DeckFactsSha()).toBe('58709110831e5a54f373d864403b1d8fcb124cb237cc9bd155784bb2f66f45f5');
  });
});

describe('r1ScorecardMatchesRubric (the scorer only runs against the R1 scorecard)', () => {
  const metrics = () => r1Scorecard().metrics.map(({ key, weightBps }) => ({ key, weightBps }));

  it('accepts the seeded R1 scorecard, in any order, with recruiter-edited text', () => {
    expect(r1ScorecardMatchesRubric(metrics())).toBe(true);
    expect(r1ScorecardMatchesRubric([...metrics()].reverse())).toBe(true);
  });

  it('refuses the 0089 default (phone) metrics: five metrics of 2000 bps each', () => {
    const phoneDefaults = ['accuracy', 'communication', 'tone', 'role_fit', 'professionalism']
      .map((key) => ({ key, weightBps: 2000 }));
    expect(r1ScorecardMatchesRubric(phoneDefaults)).toBe(false);
  });

  it('refuses a missing, extra, duplicated, renamed or re-weighted metric', () => {
    const base = metrics();
    expect(r1ScorecardMatchesRubric(base.slice(1))).toBe(false);
    expect(r1ScorecardMatchesRubric([...base, { key: 'r1_extra', weightBps: 0 }])).toBe(false);
    expect(r1ScorecardMatchesRubric([base[0]!, base[0]!, base[2]!, base[3]!, base[4]!])).toBe(false);
    expect(r1ScorecardMatchesRubric([{ key: 'r1_other', weightBps: 2500 }, ...base.slice(1)])).toBe(false);
    expect(r1ScorecardMatchesRubric(base.map((m, i) => (i === 0 ? { ...m, weightBps: 2000 } : m)))).toBe(false);
    expect(r1ScorecardMatchesRubric([])).toBe(false);
  });
});

describe('seed script', () => {
  it('seeds from the shared rubric module and never writes a level-5 anchor', () => {
    const seed = readFileSync(path.resolve(here, '../../scripts/seed-r1-role.ts'), 'utf8');
    expect(seed).toContain("from '../src/lib/r1/rubric.js'");
    expect(seed).not.toMatch(/'5'\s*:/);
    expect(seed).toContain("'4': rubric[4]");
  });
});
