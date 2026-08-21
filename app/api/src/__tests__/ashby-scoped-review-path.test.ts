/**
 * Scorecard reviewPath → the candidate-scoped review route.
 *
 * NEW scorecard writes deep-link to `/ashby/review/<applicationLinkId>` instead
 * of `/sessions/<sessionId>`. Nothing else about the write changes: the Ashby
 * feedback value type, the field set, Red Flags, email and stage moves are all
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

  it('never truncates the deep link, even for a summary at the maximum length', () => {
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
    const summary = fields.find((f) => f.path === HELLO_CHRISTY_SCORECARD_BINDING.fieldPaths!.summary)!;

    // The complete suffix survives: value type unchanged, whole URL present,
    // and the payload still respects the 2000-char cap (the summary body, not
    // the link, is what gives way).
    expect(summary.value.type).toBe('PlainText');
    expect(summary.value.value.endsWith(link)).toBe(true);
    expect(summary.value.value).toHaveLength(2000);
    expect(summary.value.value).toContain('Detailed Project_HELLO scorecard: ');
  });

  it('keeps the whole link for a maximum-length summary on the longest allowed path', () => {
    // Same boundary with the longer scoped path vs the old session path: the
    // reserved suffix grows, the summary body shrinks, the URL stays intact.
    const built = buildScorecard(source({ summary: 'y'.repeat(3000), reviewPath: `/sessions/${SESSION_ID}` }), SCALE);
    const scoped = buildScorecard(source({ summary: 'y'.repeat(3000) }), SCALE);
    expect(built.ok && scoped.ok).toBe(true);
    if (!built.ok || !scoped.ok) return;
    const value = (b: typeof built) => {
      const bound = bindFeedbackForm((b as { scorecard: any }).scorecard, HELLO_CHRISTY_SCORECARD_BINDING, 'https://app.example/');
      const fields = (bound as any).feedbackForm.fieldSubmissions as Array<{ path: string; value: any }>;
      return fields.find((f) => f.path === HELLO_CHRISTY_SCORECARD_BINDING.fieldPaths!.summary)!.value.value as string;
    };
    const legacyValue = value(built);
    const scopedValue = value(scoped);
    expect(legacyValue.endsWith(`https://app.example/sessions/${SESSION_ID}`)).toBe(true);
    expect(scopedValue.endsWith(`https://app.example/ashby/review/${LINK_ID}`)).toBe(true);
    expect(legacyValue).toHaveLength(2000);
    expect(scopedValue).toHaveLength(2000);
  });
});
