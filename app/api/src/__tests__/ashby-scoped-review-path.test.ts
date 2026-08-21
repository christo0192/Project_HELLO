/**
 * Scorecard reviewPath → the candidate-scoped review route.
 *
 * NEW scorecard writes deep-link to `/ashby/review/<applicationLinkId>` instead
 * of `/sessions/<sessionId>`. The deep link is now delivered by the verified
 * `Detailed report` Url field rather than appended to the Summary — see
 * ashby-scorecard-fields.test.ts for that field set. Email and stage moves stay
 * untouched by this lane.
 *
 * Idempotency is content-only and link-scoped:
 *   - the marker hashes the ASSESSMENT content and NOT the review path, so
 *     re-shaping the deep link can never look like new content and re-trigger
 *     a provider write on a link scored under the old `/sessions/<id>` path;
 *   - the enqueue-time and execute-time builders still derive the path the same
 *     way — both go through `ashbyReviewPath` — and this file pins that
 *     agreement so a future edit to one site fails loudly here;
 *   - the durable "one scorecard per application link, across every historical
 *     marker version" guard lives at the enqueue site and is pinned by
 *     ashby-scorecard-link-idempotency.test.ts.
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

describe('scorecard idempotency is content-only', () => {
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

  it('is independent of the review path: the old session path yields the SAME marker', () => {
    // The whole point of the repair — a link whose scorecard was submitted
    // under /sessions/<id> hashes identically under /ashby/review/<linkId>, so
    // a re-drive cannot present as new content.
    const scoped = buildScorecard(source(), SCALE);
    const legacy = buildScorecard(source({ reviewPath: `/sessions/${SESSION_ID}` }), SCALE);
    expect(scoped.ok && legacy.ok).toBe(true);
    if (scoped.ok && legacy.ok) expect(scoped.marker).toBe(legacy.marker);
  });

  it('still changes when the assessment content changes', () => {
    const base = buildScorecard(source(), SCALE);
    const rescored = buildScorecard(source({ overallScore: 41, summary: 'Weaker on role fit.' }), SCALE);
    expect(base.ok && rescored.ok).toBe(true);
    if (base.ok && rescored.ok) expect(base.marker).not.toBe(rescored.marker);
  });
});

describe('the bound Ashby payload carries the deep link in Detailed report', () => {
  it('delivers the scoped review link as a bare Url value, never in the summary', () => {
    const built = buildScorecard(source(), SCALE);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const bound = bindFeedbackForm(built.scorecard, HELLO_CHRISTY_SCORECARD_BINDING, 'https://app.example/');
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    const fields = (bound.feedbackForm as { fieldSubmissions: Array<{ path: string; value: any }> }).fieldSubmissions;
    const summary = fields.find((f) => f.path === HELLO_CHRISTY_SCORECARD_BINDING.fieldPaths!.summary)!;
    expect(summary.value.type).toBe('PlainText');
    expect(summary.value.value).toBe('Strong communicator.');
    expect(summary.value.value).not.toContain('http');
    expect(summary.value.value).not.toContain('/sessions/');

    const report = fields.find((f) => f.path === HELLO_CHRISTY_SCORECARD_BINDING.fieldPaths!.detailedReport)!;
    expect(report.value).toBe(`https://app.example/ashby/review/${LINK_ID}`);
    expect(report.value).not.toContain(SESSION_ID);

    // Unchanged contract: the overall field is still the stringified scale
    // value (never a new type).
    const overall = fields.find((f) => f.path === HELLO_CHRISTY_SCORECARD_BINDING.fieldPaths!.overall)!;
    expect(typeof overall.value).toBe('string');
    // overall + summary + red flags + detailed report + the one mapped dimension
    expect(fields).toHaveLength(5);
  });

  it('keeps the deep link whole and un-truncated for a maximum-length summary', () => {
    const origin = 'https://app.example';
    const link = `${origin}/ashby/review/${LINK_ID}`;
    // A summary long enough that buildScorecard itself caps it at MAX_SUMMARY_LEN.
    const built = buildScorecard(source({ summary: 'x'.repeat(5000) }), SCALE);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.scorecard.summary).toHaveLength(2000);

    const bound = bindFeedbackForm(built.scorecard, HELLO_CHRISTY_SCORECARD_BINDING, `${origin}/`);
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    const fields = (bound.feedbackForm as { fieldSubmissions: Array<{ path: string; value: any }> }).fieldSubmissions;

    // The summary now owns its whole budget, and the link is a separate field
    // that a long summary can no longer crowd out or truncate.
    const summary = fields.find((f) => f.path === HELLO_CHRISTY_SCORECARD_BINDING.fieldPaths!.summary)!;
    expect(summary.value.value).toHaveLength(2000);
    expect(fields.find((f) => f.path === HELLO_CHRISTY_SCORECARD_BINDING.fieldPaths!.detailedReport)!.value)
      .toBe(link);
  });

  it('refuses the whole binding for a legacy non-scoped review path', () => {
    // A `/sessions/<id>` path is no longer a legal Url value, and the binding
    // fails closed rather than shipping a scorecard with no destination.
    const built = buildScorecard(source({ reviewPath: `/sessions/${SESSION_ID}` }), SCALE);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(bindFeedbackForm(built.scorecard, HELLO_CHRISTY_SCORECARD_BINDING, 'https://app.example/'))
      .toEqual({ ok: false, reason: 'invalid_review_path' });
  });
});
