/**
 * Ashby scorecard mapper — determinism, redaction, fail-closed binding.
 *
 * Proves: raw model/CoT/transcript/recording/bearer inputs are rejected;
 * absolute review URLs are rejected (relative-only); the overall→scale bucket
 * is deterministic; the idempotency marker is stable and content-sensitive;
 * and feedback-form binding fails closed until a tenant probe verifies field
 * ids, never inventing an Ashby form shape.
 */

import { describe, it, expect } from 'vitest';
import {
  buildScorecard,
  bindFeedbackForm,
  HELLO_CHRISTY_SCORECARD_BINDING,
  mapOverallToScale,
  isScorecardSafe,
  isRelativeReviewPath,
  type ScorecardSource,
  type ScorecardScale,
  type ScorecardFormBinding,
} from '../integrations/ashby/scorecard.js';

const scale: ScorecardScale = { min: 1, max: 4 };

function source(overrides: Partial<ScorecardSource> = {}): ScorecardSource {
  return {
    overallScore: 72,
    recommendation: 'advance',
    dimensions: [
      { key: 'communication', score: 8 },
      { key: 'motivation', score: 6 },
    ],
    summary: 'Strong communicator; relevant background.',
    provenance: { model: 'deepseek-scoring', scoredAt: '2026-08-13T00:00:00Z', version: '1' },
    reviewPath: '/review/sessions/sess_123',
    ...overrides,
  };
}

describe('buildScorecard — happy path + determinism', () => {
  it('produces a normalized redaction-safe scorecard', () => {
    const r = buildScorecard(source(), scale);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.scorecard.provider).toBe('ashby');
      expect(r.scorecard.scaleValue).toBeGreaterThanOrEqual(1);
      expect(r.scorecard.scaleValue).toBeLessThanOrEqual(4);
      expect(r.scorecard.recommendation).toBe('advance');
      expect(r.scorecard.dimensions).toHaveLength(2);
      expect(r.marker).toMatch(/^[a-f0-9]{32}$/);
    }
  });

  it('is deterministic: same source → same marker', () => {
    const a = buildScorecard(source(), scale);
    const b = buildScorecard(source(), scale);
    expect(a.ok && b.ok && a.marker === b.marker).toBe(true);
  });

  it('marker changes when the summary changes', () => {
    const a = buildScorecard(source(), scale);
    const b = buildScorecard(source({ summary: 'Different summary text here.' }), scale);
    expect(a.ok && b.ok && a.marker !== b.marker).toBe(true);
  });
});

describe('buildScorecard — fail closed', () => {
  it('rejects a source carrying a transcript / recording / bearer field', () => {
    for (const bad of [
      { transcript: [{ speaker: 'bot', text: 'hi' }] },
      { recording_url: 'https://x/y' },
      { bearer_token: 'abc' },
      { chain_of_thought: 'because...' },
    ]) {
      const r = buildScorecard(source(bad as Partial<ScorecardSource>), scale);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('unsafe_source');
    }
  });

  it('rejects an absolute review URL (must be site-relative)', () => {
    for (const p of ['https://evil/x', '//evil/x', 'javascript:alert(1)', 'data:text/x']) {
      const r = buildScorecard(source({ reviewPath: p }), scale);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('invalid_review_path');
    }
  });

  it('rejects an empty summary and empty dimensions', () => {
    expect(buildScorecard(source({ summary: '   ' }), scale)).toMatchObject({ ok: false, reason: 'empty_summary' });
    expect(buildScorecard(source({ dimensions: [] }), scale)).toMatchObject({ ok: false, reason: 'no_dimensions' });
  });
});

describe('mapOverallToScale — deterministic bucketing', () => {
  it('maps low/mid/high overall scores into the 1..4 scale monotonically', () => {
    expect(mapOverallToScale(0, scale)).toBe(1);
    expect(mapOverallToScale(100, scale)).toBe(4);
    const low = mapOverallToScale(10, scale);
    const mid = mapOverallToScale(55, scale);
    const high = mapOverallToScale(90, scale);
    expect(low).toBeLessThanOrEqual(mid);
    expect(mid).toBeLessThanOrEqual(high);
  });

  it('clamps out-of-range input and a degenerate scale', () => {
    expect(mapOverallToScale(-5, scale)).toBe(1);
    expect(mapOverallToScale(999, scale)).toBe(4);
    expect(mapOverallToScale(50, { min: 3, max: 3 })).toBe(3);
  });
});

describe('bindFeedbackForm — fails closed until tenant-verified', () => {
  const built = buildScorecard(source(), scale);
  const scorecard = built.ok ? built.scorecard : (null as never);

  it('refuses an unverified binding', () => {
    const binding: ScorecardFormBinding = { verified: false };
    expect(bindFeedbackForm(scorecard, binding)).toEqual({ ok: false, reason: 'binding_unverified' });
  });

  it('refuses a verified-but-incomplete binding (no invented field ids)', () => {
    const binding: ScorecardFormBinding = { verified: true, formDefinitionId: 'form_1' };
    expect(bindFeedbackForm(scorecard, binding)).toEqual({ ok: false, reason: 'binding_incomplete' });
  });

  it('binds the approved Hello Christy form with all fields and an authenticated URL', () => {
    const fullScorecard = buildScorecard(source({
      dimensions: [
        { key: 'english', score: 8 },
        { key: 'tone', score: 7 },
        { key: 'communication', score: 8 },
        { key: 'motivation', score: 6 },
        { key: 'role_fit', score: 5 },
      ],
    }), scale);
    const r = bindFeedbackForm(fullScorecard.ok ? fullScorecard.scorecard : scorecard, HELLO_CHRISTY_SCORECARD_BINDING, 'https://hello.example.com');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.formDefinitionId).toBe(HELLO_CHRISTY_SCORECARD_BINDING.formDefinitionId);
      expect(r.feedbackForm['666cedf5-cbd2-4d51-8e53-213e73fd536f']).toBe('3');
      expect(r.feedbackForm['8a057bef-b7c6-4193-9e47-611c01d5d910']).toEqual({ score: 4 });
      expect(r.feedbackForm['1a943e2f-c1ec-4960-9179-b97ce376392a']).toEqual({
        type: 'PlainText',
        value: expect.stringContaining('https://hello.example.com/review/sessions/sess_123'),
      });
    }
  });

  it('binds only mapped dimensions when fully verified', () => {
    const binding: ScorecardFormBinding = {
      verified: true,
      formDefinitionId: 'form_1',
      overallFieldId: 'f_overall',
      summaryFieldId: 'f_summary',
      dimensionFieldIds: { communication: 'f_comm' }, // motivation intentionally unmapped
    };
    const r = bindFeedbackForm(scorecard, binding);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.formDefinitionId).toBe('form_1');
      expect(r.feedbackForm.f_overall).toBe(String(scorecard.scaleValue));
      expect(r.feedbackForm.f_summary).toEqual({
        type: 'PlainText',
        value: `${scorecard.summary}\n\nDetailed Project_HELLO scorecard: ${scorecard.reviewPath}`,
      });
      expect(r.feedbackForm.f_comm).toEqual({ score: 4 });
      expect(Object.keys(r.feedbackForm)).not.toContain('motivation');
    }
  });
});

describe('helpers', () => {
  it('isScorecardSafe / isRelativeReviewPath', () => {
    expect(isScorecardSafe({ ok: 1, nested: { fine: true } })).toBe(true);
    expect(isScorecardSafe({ audio_url: 'x' })).toBe(false);
    expect(isRelativeReviewPath('/review/1')).toBe(true);
    expect(isRelativeReviewPath('https://x/y')).toBe(false);
  });
});
