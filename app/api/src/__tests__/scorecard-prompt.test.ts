/**
 * prompt.ts — the scorecard scoring prompt presents each configured metric
 * (name + per-role instruction + all five rubric levels) and demands the
 * results-array / configMetricId output contract.
 */

import { describe, it, expect } from 'vitest';
import { buildScorecardPrompt } from '../lib/scorecards/prompt.js';
import type { RoleScorecardMetric } from '../lib/scorecards/contracts.js';
import type { TranscriptTurn } from '../lib/types.js';

const metrics: RoleScorecardMetric[] = [
  {
    id: 'cfg-comm',
    libraryMetricId: 'lib-comm',
    key: 'communication',
    name: 'Customer Communication',
    instruction: 'Judge how clearly the candidate explains ideas to a customer.',
    rubric: {
      1: 'RUBRIC-COMM-ONE incoherent',
      2: 'RUBRIC-COMM-TWO hard to follow',
      3: 'RUBRIC-COMM-THREE adequate',
      4: 'RUBRIC-COMM-FOUR clear',
      5: 'RUBRIC-COMM-FIVE outstanding',
    },
    weightBps: 6000,
    displayOrder: 0,
  },
  {
    id: 'cfg-motiv',
    libraryMetricId: 'lib-motiv',
    key: 'motivation',
    name: 'Role Motivation',
    instruction: 'Judge genuine interest in this specific role and company.',
    rubric: {
      1: 'RUBRIC-MOTIV-ONE none',
      2: 'RUBRIC-MOTIV-TWO weak',
      3: 'RUBRIC-MOTIV-THREE some',
      4: 'RUBRIC-MOTIV-FOUR strong',
      5: 'RUBRIC-MOTIV-FIVE compelling',
    },
    weightBps: 4000,
    displayOrder: 1,
  },
];

const transcript: TranscriptTurn[] = [
  { speaker: 'candidate', text: 'CANDIDATE-TRANSCRIPT-MARKER I really want this job.' },
];

describe('buildScorecardPrompt', () => {
  const prompt = buildScorecardPrompt({
    metrics,
    roleTitle: 'Program Advisor',
    candidateName: 'Asha',
    transcript,
    resumeFacts: 'RESUME-FACTS-MARKER',
  });

  it('presents each metric name and its per-role instruction', () => {
    for (const metric of metrics) {
      expect(prompt).toContain(metric.name);
      expect(prompt).toContain(metric.instruction);
      // The exact configMetricId the model must key its result on.
      expect(prompt).toContain(metric.id);
    }
  });

  it('presents all five rubric levels for every metric', () => {
    for (const metric of metrics) {
      for (const level of [1, 2, 3, 4, 5] as const) {
        expect(prompt).toContain(metric.rubric[level]);
      }
    }
  });

  it('demands the results-array / configMetricId output contract', () => {
    expect(prompt).toContain('"results"');
    expect(prompt).toContain('configMetricId');
    expect(prompt).toContain('"scored"');
    expect(prompt).toContain('insufficient_evidence');
    // Must forbid inventing scores for gaps.
    expect(prompt).toMatch(/never invent|NEVER invent/i);
    // Exactly-one-per-metric accounting.
    expect(prompt).toMatch(/exactly one result|EXACTLY ONE result/i);
  });

  it('carries the resume facts and fenced transcript', () => {
    expect(prompt).toContain('RESUME-FACTS-MARKER');
    expect(prompt).toContain('CANDIDATE-TRANSCRIPT-MARKER I really want this job.');
    expect(prompt).toContain('Program Advisor');
  });

  it('lists the full exhaustive id set so no id can be dropped or invented', () => {
    expect(prompt).toContain('cfg-comm, cfg-motiv');
  });
});
