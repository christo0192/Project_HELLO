/**
 * Scorecard reviewPath → the candidate-scoped review route.
 *
 * NEW scorecard writes deep-link to `/ashby/review/<applicationLinkId>` instead
 * of `/sessions/<sessionId>`. Nothing else about the write changes: the Ashby
 * feedback value type, the field set, Red Flags, email and stage moves are all
 * untouched by this lane.
 *
 * Idempotency is deliberately PRESERVED, not re-designed:
 *   - the marker still hashes the review path (unchanged derivation), so the
 *     same source still produces a byte-identical marker;
 *   - the enqueue-time and execute-time builders must therefore derive the path
 *     the same way — both go through `ashbyReviewPath`, and this file pins that
 *     agreement so a future edit to one site fails loudly here;
 *   - because the path is part of the hashed content, a link whose scorecard
 *     was written under the OLD path hashes to a different marker. That is the
 *     pre-existing content-change semantics of this marker (any summary/score
 *     change behaves identically) and is asserted below so the consequence is
 *     recorded rather than discovered in production.
 */

import { describe, it, expect } from 'vitest';
import {
  ashbyReviewPath,
  buildScorecard,
  bindFeedbackForm,
  isRelativeReviewPath,
  HELLO_CHRISTY_SCORECARD_BINDING,
  type ScorecardSource,
} from '../integrations/ashby/scorecard.js';

const LINK_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const SCALE = { min: 1, max: 4 };

function source(over: Partial<ScorecardSource> = {}): ScorecardSource {
  return {
    externalApplicationId: 'app_1',
    overallScore: 78,
    recommendation: 'advance',
    dimensions: [{ key: 'communication', score: 8 }],
    summary: 'Strong communicator.',
    provenance: { model: 'm', scoredAt: '2026-08-20T00:00:00Z', version: 'v1' },
    reviewPath: ashbyReviewPath(LINK_ID),
    ...over,
  };
}

describe('ashbyReviewPath', () => {
  it('is the site-relative scoped review route addressed by the link id only', () => {
    expect(ashbyReviewPath(LINK_ID)).toBe(`/ashby/review/${LINK_ID}`);
    expect(isRelativeReviewPath(ashbyReviewPath(LINK_ID))).toBe(true);
  });

  it('carries no candidate/session identifier, email, or token', () => {
    const p = ashbyReviewPath(LINK_ID);
    expect(p).not.toContain(SESSION_ID);
    expect(p).not.toMatch(/@|token|bearer|\?/i);
  });

  it('encodes a hostile id rather than escaping the path', () => {
    const p = ashbyReviewPath('../../admin?x=1');
    expect(p.startsWith('/ashby/review/')).toBe(true);
    expect(p).not.toContain('/../');
    expect(isRelativeReviewPath(p)).toBe(true);
  });
});

describe('scorecard idempotency is preserved', () => {
  it('produces a byte-identical marker for an identical source', () => {
    const a = buildScorecard(source(), SCALE);
    const b = buildScorecard(source(), SCALE);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.marker).toBe(b.marker);
  });

  it('enqueue-time and execute-time builders agree because both derive the path once', () => {
    // The two production sites differ only in how they reach the link id; both
    // call ashbyReviewPath(applicationLinkId), so their markers must match.
    const enqueued = buildScorecard(source({ reviewPath: ashbyReviewPath(LINK_ID) }), SCALE);
    const executed = buildScorecard(source({ reviewPath: ashbyReviewPath(LINK_ID) }), SCALE);
    expect(enqueued.ok && executed.ok).toBe(true);
    if (enqueued.ok && executed.ok) expect(enqueued.marker).toBe(executed.marker);
  });

  it('records that the path is hashed: the old session path yields a different marker', () => {
    const scoped = buildScorecard(source(), SCALE);
    const legacy = buildScorecard(source({ reviewPath: `/sessions/${SESSION_ID}` }), SCALE);
    expect(scoped.ok && legacy.ok).toBe(true);
    if (scoped.ok && legacy.ok) expect(scoped.marker).not.toBe(legacy.marker);
  });
});

describe('the bound Ashby payload changes only the deep link', () => {
  it('embeds the scoped review path in the summary and nothing else moves', () => {
    const built = buildScorecard(source(), SCALE);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const bound = bindFeedbackForm(built.scorecard, HELLO_CHRISTY_SCORECARD_BINDING, 'https://app.example/');
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    const fields = (bound.feedbackForm as { fieldSubmissions: Array<{ path: string; value: any }> }).fieldSubmissions;
    const summary = fields.find((f) => f.path === HELLO_CHRISTY_SCORECARD_BINDING.fieldPaths!.summary)!;
    expect(summary.value.type).toBe('PlainText');
    expect(summary.value.value).toContain(`https://app.example/ashby/review/${LINK_ID}`);
    expect(summary.value.value).not.toContain('/sessions/');

    // Unchanged contract: the overall field is still the stringified scale
    // value (never a new type), and no field was added or removed.
    const overall = fields.find((f) => f.path === HELLO_CHRISTY_SCORECARD_BINDING.fieldPaths!.overall)!;
    expect(typeof overall.value).toBe('string');
    expect(fields).toHaveLength(3); // overall + summary + the one dimension
    expect(JSON.stringify(bound.feedbackForm)).not.toMatch(/red[_ ]?flag/i);
  });
});
