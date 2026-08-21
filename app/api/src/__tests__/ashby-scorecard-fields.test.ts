/**
 * Verified `Detailed report` (Url) + `Red flags` (String) scorecard fields.
 *
 * The Hello Christy feedback form carries two optional fields beyond the
 * approved recommendation / five dimensions / Summary set. This file is the
 * executable contract for adding them:
 *
 *   - the payload is EXACTLY nine field submissions, with pinned paths, types
 *     and value shapes — a `Url`/`String` field takes a bare string, never a
 *     PlainText envelope, and no tenth field may appear;
 *   - `Detailed report` is a bare absolute HTTPS deep link composed only from
 *     the server's validated dashboard origin plus the canonical
 *     `/ashby/review/<uuid>` path — no PII, token, query, fragment, userinfo,
 *     external Ashby id, or open-redirect input;
 *   - a dashboard origin we cannot trust, or a review path that is not the
 *     canonical scoped one, fails the WHOLE binding closed: no relative path
 *     ever enters a Url field, and the worker makes zero provider calls;
 *   - Summary keeps the approved text and no longer carries the raw link;
 *   - `Red flags` is normalized ONLY from the persisted `role_fit.red_flags`
 *     array — ordered, control-free, bounded — and is exactly
 *     `None identified` when nothing survives;
 *   - link-scoped one-scorecard-per-application-link idempotency is unchanged:
 *     the marker moves with red flags (they are assessment content) and that
 *     still enqueues nothing on a link that already has a scorecard operation.
 *
 * Zero network anywhere in this file.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  ashbyReviewPath,
  buildScorecard,
  bindFeedbackForm,
  dashboardOriginOf,
  detailedReportUrl,
  isScopedReviewPath,
  normalizeRedFlags,
  renderRedFlags,
  NO_RED_FLAGS_TEXT,
  MAX_RED_FLAG_ITEMS,
  MAX_RED_FLAG_ITEM_LEN,
  MAX_RED_FLAGS_TOTAL_LEN,
  HELLO_CHRISTY_SCORECARD_BINDING,
  type NormalizedScorecard,
  type ScorecardSource,
} from '../integrations/ashby/scorecard.js';
import { runClaimedAshbyOperation } from '../integrations/ashby/operation-worker.js';
import {
  enqueueScorecard,
  type RuntimeWorkflowStores,
  type SagaDeps,
  type OperationClaimRow,
} from '../integrations/ashby/orchestration.js';

const LINK_ID = '44444444-4444-4444-8444-444444444444';
const SESSION_ID = '55555555-5555-4555-8555-555555555555';
const ORIGIN = 'https://hello.example.com';
const SCALE = { min: 1, max: 4 };
const B = HELLO_CHRISTY_SCORECARD_BINDING;

function source(over: Partial<ScorecardSource> = {}): ScorecardSource {
  return {
    externalApplicationId: 'app_ext_1',
    overallScore: 72,
    recommendation: 'advance',
    dimensions: [
      { key: 'english', score: 8 },
      { key: 'tone', score: 7 },
      { key: 'communication', score: 8 },
      { key: 'motivation', score: 6 },
      { key: 'role_fit', score: 5 },
    ],
    summary: 'Strong communicator; relevant background.',
    provenance: { model: 'synthetic-model', scoredAt: '2026-08-21T00:00:00.000Z', version: '1' },
    reviewPath: ashbyReviewPath(LINK_ID),
    ...over,
  };
}

function scorecardOf(over: Partial<ScorecardSource> = {}): NormalizedScorecard {
  const built = buildScorecard(source(over), SCALE);
  if (!built.ok) throw new Error(`fixture: ${built.reason}`);
  return built.scorecard;
}

function bind(over: Partial<ScorecardSource> = {}, origin = ORIGIN) {
  return bindFeedbackForm(scorecardOf(over), B, origin);
}

function fieldsOf(over: Partial<ScorecardSource> = {}, origin = ORIGIN) {
  const bound = bind(over, origin);
  if (!bound.ok) throw new Error(`fixture: ${bound.reason}`);
  return (bound.feedbackForm as { fieldSubmissions: Array<{ path: string; value: unknown }> })
    .fieldSubmissions;
}

/** A claim row + stores pair that drives the worker's scorecard branch only. */
function workerFixture(over: Partial<ScorecardSource> = {}) {
  const failures: string[] = [];
  const claim: OperationClaimRow = {
    id: 'op_1',
    operationType: 'scorecard_write',
    operationKey: `ashby:scorecard:link:${LINK_ID}`,
    applicationLinkId: LINK_ID,
    leaseToken: 'lease_1',
    attempts: 1,
    maxAttempts: 5,
    marker: 'marker_1',
  };
  const stores = {
    claimOperation: async () => claim,
    readLink: async () => ({
      id: LINK_ID,
      externalApplicationId: 'app_ext_1',
      externalJobId: null,
      externalResumeFileHandle: null,
      jobMappingId: null,
      candidateId: null,
      sessionId: SESSION_ID,
      inviteId: null,
      lifecycle: 'scored',
      terminalState: null,
    }),
    readScorecardSource: async () => source(over),
    failOperation: async (_id: string, _token: string, reason: string) => {
      failures.push(reason);
      return { outcome: 'failed' as const };
    },
    completeOperation: async () => 'ok' as const,
  } as unknown as RuntimeWorkflowStores;
  return { stores, failures };
}

// ── 1. The exact approved field set ─────────────────────────────────────────

describe('the bound payload is exactly the nine approved field submissions', () => {
  it('pins every path, in a deterministic order, with no extras', () => {
    const fields = fieldsOf();
    expect(fields.map((f) => f.path)).toEqual([
      'overall_recommendation',
      'b5778d87-0be5-4ca3-8727-88dc8dd6eba0', // Summary (RichText)
      'a9127af9-fc4d-474d-b3ce-95c57052e840', // Red flags (String)
      '81b04084-d7a0-40f1-9d30-7eccaa62798d', // Detailed report (Url)
      '46ee47b9-71a7-42bd-844c-c279c0e8bebf', // english
      'bba47eac-b0f4-43c2-a931-d1fe00a24d03', // tone
      'ee3ca034-ea9c-451a-85de-1e22b1bce180', // communication
      '6d8d9ff3-43c9-44e5-bba3-d3ae4dce0eef', // motivation
      'd1220462-1d8a-43b9-a56f-c5635cdd5e2f', // role_fit
    ]);
    expect(fields).toHaveLength(9);
    expect(new Set(fields.map((f) => f.path)).size).toBe(9);
  });

  it('binds the two verified submission paths read from the tenant form', () => {
    expect(B.fieldPaths?.redFlags).toBe('a9127af9-fc4d-474d-b3ce-95c57052e840');
    expect(B.fieldPaths?.detailedReport).toBe('81b04084-d7a0-40f1-9d30-7eccaa62798d');
    expect(B.fieldTypes).toEqual({ redFlags: 'String', detailedReport: 'Url' });
    expect(B.formDefinitionId).toBe('1c9a92c0-c18f-4bf1-898f-c29e71d7d303');
  });

  it('pins the value SHAPE per field type: only RichText is enveloped', () => {
    const fields = fieldsOf();
    const at = (p: string) => fields.find((f) => f.path === p)!.value;
    expect(typeof at('overall_recommendation')).toBe('string');
    expect(at('b5778d87-0be5-4ca3-8727-88dc8dd6eba0')).toEqual({
      type: 'PlainText',
      value: 'Strong communicator; relevant background.',
    });
    // String + Url fields are BARE strings, never { type: 'PlainText', ... }.
    expect(typeof at('a9127af9-fc4d-474d-b3ce-95c57052e840')).toBe('string');
    expect(typeof at('81b04084-d7a0-40f1-9d30-7eccaa62798d')).toBe('string');
    expect(at('81b04084-d7a0-40f1-9d30-7eccaa62798d')).toBe(`${ORIGIN}/ashby/review/${LINK_ID}`);
    for (const p of Object.values(B.fieldPaths!.dimensions)) {
      expect(at(p)).toEqual({ score: expect.any(Number) });
    }
  });

  it('leaves the legacy recommendation, dimensions and Summary semantics unchanged', () => {
    const fields = fieldsOf();
    const at = (p: string) => fields.find((f) => f.path === p)!.value;
    expect(at('overall_recommendation')).toBe('3');
    expect(at('46ee47b9-71a7-42bd-844c-c279c0e8bebf')).toEqual({ score: 4 }); // english 8/10
    expect(at('d1220462-1d8a-43b9-a56f-c5635cdd5e2f')).toEqual({ score: 3 }); // role_fit 5/10
    expect(B.dimensionScale).toEqual({ min: 1, max: 4 });
  });
});

// ── 2. Detailed report is a bare, PII-free HTTPS URL ────────────────────────

describe('Detailed report — a bare absolute HTTPS URL and nothing else', () => {
  it('carries no PII, token, query, fragment, userinfo or external Ashby id', () => {
    const url = fieldsOf().find((f) => f.path === B.fieldPaths!.detailedReport)!.value as string;
    expect(url).toBe(`${ORIGIN}/ashby/review/${LINK_ID}`);
    const parsed = new URL(url);
    expect(parsed.protocol).toBe('https:');
    expect(parsed.username).toBe('');
    expect(parsed.password).toBe('');
    expect(parsed.search).toBe('');
    expect(parsed.hash).toBe('');
    expect(url).not.toContain('app_ext_1');
    expect(url).not.toContain(SESSION_ID);
    expect(url).not.toMatch(/@|token|bearer|secret|email|[?#]/i);
  });

  it('the Summary no longer carries the raw dashboard URL or a link label', () => {
    const summary = fieldsOf().find((f) => f.path === B.fieldPaths!.summary)!.value as {
      value: string;
    };
    expect(summary.value).toBe('Strong communicator; relevant background.');
    expect(summary.value).not.toMatch(/https?:/i);
    expect(summary.value).not.toMatch(/detailed .*scorecard/i);
    expect(summary.value).not.toContain(LINK_ID);
  });

  it('accepts only a bare HTTPS origin', () => {
    expect(dashboardOriginOf('https://a.example')).toBe('https://a.example');
    expect(dashboardOriginOf('https://a.example/')).toBe('https://a.example');
    expect(dashboardOriginOf('https://a.example:8443/')).toBe('https://a.example:8443');
    expect(dashboardOriginOf('  https://a.example/  ')).toBe('https://a.example');
    for (const bad of [
      '',
      '   ',
      'http://a.example',
      'http://localhost:5173',
      '//a.example',
      '/ashby/review',
      'a.example',
      'https://user:pw@a.example/',
      'https://user@a.example/',
      'https://a.example/dashboard',
      'https://a.example/?x=1',
      'https://a.example/#f',
      'ftp://a.example',
      'javascript:alert(1)',
      'data:text/html,x',
      `https://${'a'.repeat(300)}.example/`,
      null,
      undefined,
      42,
      {},
    ] as unknown[]) {
      expect(dashboardOriginOf(bad)).toBeNull();
    }
  });

  it('accepts only the canonical scoped review path', () => {
    expect(isScopedReviewPath(ashbyReviewPath(LINK_ID))).toBe(true);
    for (const bad of [
      `/sessions/${SESSION_ID}`,
      '/ashby/review/',
      '/ashby/review/app_ext_1',
      '/ashby/review/not-a-uuid',
      `/ashby/review/${LINK_ID}/edit`,
      `/ashby/review/${LINK_ID}?x=1`,
      `/ashby/review/${LINK_ID}#f`,
      `https://evil.example/ashby/review/${LINK_ID}`,
      `//evil.example/ashby/review/${LINK_ID}`,
      '/ashby/review/../../admin',
      `/ashby/review/${LINK_ID}\n`,
      '',
      null,
      undefined,
      7,
    ] as unknown[]) {
      expect(isScopedReviewPath(bad)).toBe(false);
    }
  });

  it('refuses to compose a URL from an untrusted origin or path', () => {
    expect(detailedReportUrl(ORIGIN, ashbyReviewPath(LINK_ID)))
      .toBe(`${ORIGIN}/ashby/review/${LINK_ID}`);
    expect(detailedReportUrl('http://a.example', ashbyReviewPath(LINK_ID))).toBeNull();
    expect(detailedReportUrl('https://user:pw@a.example', ashbyReviewPath(LINK_ID))).toBeNull();
    expect(detailedReportUrl(ORIGIN, `/sessions/${SESSION_ID}`)).toBeNull();
    expect(detailedReportUrl(ORIGIN, 'https://evil.example/x')).toBeNull();
  });
});

// ── 3. Fail-closed binding ──────────────────────────────────────────────────

describe('an untrusted dashboard origin or review path fails the whole binding closed', () => {
  const origins: Array<[string, string]> = [
    ['missing', ''],
    ['whitespace', '   '],
    ['plain http', 'http://hello.example.com'],
    ['loopback http', 'http://localhost:5173'],
    ['userinfo', 'https://user:pw@hello.example.com/'],
    ['pathful', 'https://hello.example.com/app'],
    ['query-bearing', 'https://hello.example.com/?next=https://evil.example'],
    ['fragment-bearing', 'https://hello.example.com/#/x'],
    ['protocol-relative', '//hello.example.com'],
    ['unparseable', 'not a url'],
  ];

  for (const [name, origin] of origins) {
    it(`refuses a ${name} dashboard origin — no field is emitted at all`, () => {
      expect(bind({}, origin)).toEqual({ ok: false, reason: 'dashboard_origin_invalid' });
    });
  }

  it('never lets a relative path reach the Url field', () => {
    // Fail-closed, NOT "fall back to the relative path": nothing is emitted.
    const bound = bind({}, '');
    expect(bound.ok).toBe(false);
    expect(JSON.stringify(bound)).not.toContain('/ashby/review/');
  });

  for (const bad of [
    `/sessions/${SESSION_ID}`,
    '/ashby/review/app_ext_1',
    '/ashby/review/not-a-uuid',
  ]) {
    it(`refuses the malformed review path ${bad}`, () => {
      expect(bind({ reviewPath: bad })).toEqual({ ok: false, reason: 'invalid_review_path' });
    });
  }

  it('refuses an absolute review path at build time, before binding', () => {
    expect(buildScorecard(source({ reviewPath: 'https://evil.example/ashby/review/x' }), SCALE))
      .toEqual({ ok: false, reason: 'invalid_review_path' });
  });

  it('refuses a binding whose declared field type no longer matches the form', () => {
    const scorecard = scorecardOf();
    expect(bindFeedbackForm(
      scorecard,
      { ...B, fieldTypes: { redFlags: 'RichText', detailedReport: 'Url' } },
      ORIGIN,
    )).toEqual({ ok: false, reason: 'binding_field_type_mismatch' });
    expect(bindFeedbackForm(
      scorecard,
      { ...B, fieldTypes: { redFlags: 'String', detailedReport: 'String' } },
      ORIGIN,
    )).toEqual({ ok: false, reason: 'binding_field_type_mismatch' });
  });

  it('makes ZERO provider calls when the origin cannot be trusted', async () => {
    const submit = vi.fn(async () => ({}));
    const { stores, failures } = workerFixture();

    const outcome = await runClaimedAshbyOperation({
      stores,
      materialization: {} as never,
      scorecard: { submit, dashboardOrigin: 'http://localhost:5173' },
      resolveMappingForLink: async () => null,
      reissuePathFor: () => '/x',
      email: { providerApproved: false, domainVerified: false },
      owner: 'w1',
      leaseSeconds: 30,
    });

    expect(submit).not.toHaveBeenCalled();
    expect(failures).toEqual(['dashboard_origin_invalid']);
    expect(outcome).toMatchObject({
      claimed: true,
      committed: false,
      code: 'dashboard_origin_invalid',
    });
  });

  it('submits the nine approved fields once when the origin IS trusted', async () => {
    const submit = vi.fn(async () => ({}));
    const { stores } = workerFixture({ redFlags: ['Gap in employment'] });

    await runClaimedAshbyOperation({
      stores,
      materialization: {} as never,
      scorecard: { submit, dashboardOrigin: ORIGIN },
      resolveMappingForLink: async () => null,
      reissuePathFor: () => '/x',
      email: { providerApproved: false, domainVerified: false },
      owner: 'w1',
      leaseSeconds: 30,
    });

    expect(submit).toHaveBeenCalledTimes(1);
    const req = (submit.mock.calls as unknown as unknown[][])[0]![0] as {
      applicationId: string;
      formDefinitionId: string;
      feedbackForm: { fieldSubmissions: Array<{ path: string; value: unknown }> };
    };
    expect(req.applicationId).toBe('app_ext_1');
    expect(req.formDefinitionId).toBe('1c9a92c0-c18f-4bf1-898f-c29e71d7d303');
    expect(req.feedbackForm.fieldSubmissions).toHaveLength(9);
    expect(req.feedbackForm.fieldSubmissions.find((f) => f.path === B.fieldPaths!.redFlags)!.value)
      .toBe('- Gap in employment');
    expect(
      req.feedbackForm.fieldSubmissions.find((f) => f.path === B.fieldPaths!.detailedReport)!.value,
    ).toBe(`${ORIGIN}/ashby/review/${LINK_ID}`);
    // The request body still carries no sensitive key fragment.
    expect(JSON.stringify(req)).not.toMatch(/transcript|recording|bearer|presigned|secret|apikey/i);
  });

  it('keeps a provider failure sanitized and attempt-bounded', async () => {
    const submit = vi.fn(async () => {
      throw new Error('Ashby 500: SENTINEL_APIKEY_should_never_surface');
    });
    const { stores, failures } = workerFixture({ redFlags: ['Gap in employment'] });

    const outcome = await runClaimedAshbyOperation({
      stores,
      materialization: {} as never,
      scorecard: { submit, dashboardOrigin: ORIGIN },
      resolveMappingForLink: async () => null,
      reissuePathFor: () => '/x',
      email: { providerApproved: false, domainVerified: false },
      owner: 'w1',
      leaseSeconds: 30,
    });

    expect(submit).toHaveBeenCalledTimes(1); // one attempt, charged against max_attempts
    expect(failures).toEqual(['operation_error']);
    expect(outcome).toMatchObject({ claimed: true, committed: false, code: 'operation_error' });
    for (const blob of [JSON.stringify(outcome), JSON.stringify(failures)]) {
      expect(blob).not.toContain('SENTINEL_APIKEY');
      expect(blob).not.toContain('Ashby 500');
    }
  });
});

// ── 4. Red flags normalization ──────────────────────────────────────────────

describe('Red flags — ordered, control-free, bounded normalization', () => {
  it('preserves the scored order', () => {
    expect(normalizeRedFlags(['first', 'second', 'third'])).toEqual(['first', 'second', 'third']);
  });

  it('strips control characters and collapses the resulting whitespace', () => {
    expect(normalizeRedFlags(['a b\tc\r\nd e'])).toEqual(['a b c d e']);
    expect(normalizeRedFlags(['\u0000nul\u0007bell\u001bescape\u007fdel'])).toEqual(['nul bell escape del']);
    expect(normalizeRedFlags(['\u0085next\u009fline'])).toEqual(['next line']);
    expect(normalizeRedFlags(['\u0000\u0007\u001b'])).toEqual([]);
  });

  it('drops non-strings, blanks and control-only entries without reordering', () => {
    expect(
      normalizeRedFlags(['keep', '', '   ', '\u0000', 42, null, undefined, {}, ['x'], 'also']),
    ).toEqual(['keep', 'also']);
  });

  it('bounds a single item, the item count, and the rendered total', () => {
    expect(normalizeRedFlags(['x'.repeat(5000)])[0]).toHaveLength(MAX_RED_FLAG_ITEM_LEN);
    // A cut that lands inside a surrogate pair must not leave a lone half.
    const emoji = normalizeRedFlags(['a'.repeat(MAX_RED_FLAG_ITEM_LEN - 1) + '\u{1F6A9}'])[0]!;
    expect(emoji).toBe('a'.repeat(MAX_RED_FLAG_ITEM_LEN - 1));
    expect(emoji).not.toMatch(/[\uD800-\uDFFF]/);
    expect(normalizeRedFlags(['ok \uD83D lone high', 'ok \uDE80 lone low']))
      .toEqual(['ok lone high', 'ok lone low']);
    expect(normalizeRedFlags(Array.from({ length: 200 }, (_, i) => `flag ${i}`)))
      .toHaveLength(MAX_RED_FLAG_ITEMS);
    const long = normalizeRedFlags(
      Array.from({ length: MAX_RED_FLAG_ITEMS }, () => 'y'.repeat(MAX_RED_FLAG_ITEM_LEN)),
    );
    expect(renderRedFlags(long).length).toBeLessThanOrEqual(MAX_RED_FLAGS_TOTAL_LEN);
    // Truncation drops WHOLE items — never half a sentence.
    for (const item of long) expect(item).toBe('y'.repeat(MAX_RED_FLAG_ITEM_LEN));
  });

  it('returns exactly `None identified` for an empty or invalid list', () => {
    expect(NO_RED_FLAGS_TEXT).toBe('None identified');
    for (const bad of [
      [],
      ['', '   '],
      [1, null],
      'not-an-array',
      null,
      undefined,
      {},
    ] as unknown[]) {
      expect(renderRedFlags(normalizeRedFlags(bad))).toBe(NO_RED_FLAGS_TEXT);
    }
  });

  it('renders one bounded bullet per flag', () => {
    expect(renderRedFlags(normalizeRedFlags(['No notice period', 'Location mismatch'])))
      .toBe('- No notice period\n- Location mismatch');
  });

  it('reads ONLY role_fit.red_flags — a look-alike key is never picked up', () => {
    expect(fieldsOf({ redFlags: ['Real flag'] })
      .find((f) => f.path === B.fieldPaths!.redFlags)!.value).toBe('- Real flag');
    // A source that carries no redFlags submits the explicit "screened, none".
    expect(fieldsOf().find((f) => f.path === B.fieldPaths!.redFlags)!.value).toBe(NO_RED_FLAGS_TEXT);
    // A look-alike payload key cannot substitute for the declared array.
    const built = buildScorecard(
      { ...source(), redFlags: undefined, ...({ role_fit: { red_flags: ['injected'] } } as object) },
      SCALE,
    );
    expect(built.ok).toBe(true);
    if (built.ok) expect(built.scorecard.redFlags).toEqual([]);
  });
});

// ── 5. Link-scoped idempotency is untouched ─────────────────────────────────

describe('link-scoped idempotency survives the new fields', () => {
  function sagaStores(over: Partial<RuntimeWorkflowStores> = {}): RuntimeWorkflowStores {
    return {
      findLinkByApplicationId: async () => null,
      createLink: async () => ({ id: LINK_ID }),
      advanceIngestion: async () => ({ status: 'ok' }),
      enqueueOperation: async () => ({ status: 'inserted', id: 'op_1' }),
      findScorecardWriteOperation: async () => null,
      completeOperation: async () => 'ok',
      failOperation: async () => ({ outcome: 'retry' }),
      deferOperation: async () => 'ok' as const,
      claimOperation: async () => null,
      parkOperationAwaitingDelivery: async () => 'ok',
      readIngestion: async () => ({ state: 'ready', attempts: 0 }),
      readLink: async () => null,
      markWritebackPending: async () => ({ status: 'ok' }),
      ...over,
    } as RuntimeWorkflowStores;
  }

  function deps(over: Partial<SagaDeps> = {}): SagaDeps {
    return {
      gates: { enabled: true, email: { providerApproved: false, domainVerified: false } },
      stores: sagaStores(),
      client: { applicationInfo: async () => ({ results: {}, moreDataAvailable: false }) as never },
      scale: SCALE,
      applicationLinkId: LINK_ID,
      externalApplicationId: 'app_ext_1',
      aiScreeningStageId: 'stage_ai',
      ...over,
    };
  }

  it('the marker moves with the red flags — deliberately, they are content', () => {
    const none = buildScorecard(source(), SCALE);
    const some = buildScorecard(source({ redFlags: ['Gap in employment'] }), SCALE);
    const other = buildScorecard(source({ redFlags: ['Location mismatch'] }), SCALE);
    expect(none.ok && some.ok && other.ok).toBe(true);
    if (!none.ok || !some.ok || !other.ok) return;
    expect(none.marker).not.toBe(some.marker);
    expect(some.marker).not.toBe(other.marker);
    // ...but it is still deterministic, and still blind to the deep link.
    expect(buildScorecard(source({ redFlags: ['Gap in employment'] }), SCALE)).toEqual(some);
    const shaped = buildScorecard(source({ redFlags: ['  Gap in employment  '] }), SCALE);
    expect(shaped.ok && shaped.marker).toBe(some.marker); // normalization, not raw text
  });

  it('an existing scorecard operation blocks the enqueue whatever the red flags are', async () => {
    const enqueued: unknown[] = [];
    const stores = sagaStores({
      findScorecardWriteOperation: async () => ({ id: 'op_existing' }),
      enqueueOperation: async (req: unknown) => {
        enqueued.push(req);
        return { status: 'inserted', id: 'op_2' };
      },
    });
    for (const redFlags of [undefined, ['Gap in employment'], ['Different flag', 'And another']]) {
      const r = await enqueueScorecard(source({ redFlags }), deps({ stores }));
      expect(r.status).toBe('scorecard_duplicate');
    }
    expect(enqueued).toEqual([]);
  });

  it('a failing admission read is blocked, never a second provider write', async () => {
    const stores = sagaStores({
      findScorecardWriteOperation: async () => {
        throw new Error('db down');
      },
    });
    const r = await enqueueScorecard(source({ redFlags: ['x'] }), deps({ stores }));
    expect(r).toEqual({ status: 'blocked_scorecard', reason: 'scorecard_admission_error' });
  });

  it('concurrent initial enqueues collapse on the link-derived operation key', async () => {
    const keys: string[] = [];
    let first = true;
    const stores = sagaStores({
      enqueueOperation: async (req: { operationKey: string }) => {
        keys.push(req.operationKey);
        if (first) {
          first = false;
          return { status: 'inserted', id: 'op_1' };
        }
        return { status: 'duplicate' };
      },
    });
    const results = await Promise.all([
      enqueueScorecard(source({ redFlags: ['a'] }), deps({ stores })),
      enqueueScorecard(source({ redFlags: ['b'] }), deps({ stores })),
      enqueueScorecard(source(), deps({ stores })),
    ]);
    // Different markers, ONE key, exactly one insertion.
    expect(new Set(keys)).toEqual(new Set([`ashby:scorecard:link:${LINK_ID}`]));
    expect(results.filter((r) => r.status === 'scorecard_enqueued')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'scorecard_duplicate')).toHaveLength(2);
  });

  it('an initial link still enqueues exactly once', async () => {
    const r = await enqueueScorecard(
      source({ redFlags: ['Gap in employment'] }),
      deps({ stores: sagaStores() }),
    );
    expect(r.status).toBe('scorecard_enqueued');
  });
});
