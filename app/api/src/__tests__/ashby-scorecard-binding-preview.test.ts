/**
 * Issue #275 — read-only scorecard binding preview.
 *
 * `previewScorecardBinding` (pure) and the admin route
 * `GET /mappings/:id/scorecard-binding`. The route performs ONE allowlisted
 * READ of the verified form definition plus two injected table reads, writes
 * nothing, and returns form STRUCTURE + metric NAMES only. Audit rows carry
 * counts, never a path or a title.
 */

import { describe, it, expect, vi } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { createAshbyMissionControlRouter } from '../routes/ashby-mission-control.js';
import { setAuditSink, getAuditSink, type AuditEntry } from '../lib/audit.js';
import type { MissionControlStore } from '../integrations/ashby/workflow-stores.js';
import { previewScorecardBinding } from '../integrations/ashby/scorecard-autobind.js';
import { HELLO_CHRISTY_SCORECARD_BINDING } from '../integrations/ashby/scorecard.js';
import type { ProbeFeedbackForm, ProbeFormField } from '../integrations/ashby/probe.js';

const FORM_ID = HELLO_CHRISTY_SCORECARD_BINDING.formDefinitionId!;
const PATHS = HELLO_CHRISTY_SCORECARD_BINDING.fieldPaths!;
const MAPPING_ID = '22222222-2222-4222-8222-222222222222';
const ROLE_ID = '33333333-3333-4333-8333-333333333333';

function field(over: Partial<ProbeFormField> & { id: string }): ProbeFormField {
  return { title: null, path: `path-${over.id}`, type: 'Score', required: false, options: [], optionsTruncated: false, ...over };
}
const FIVE = [1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: `${n}` }));

const FIXED: ProbeFormField[] = [
  field({ id: 'ov', title: 'Overall recommendation', path: PATHS.overall, type: 'ValueSelect', options: [1, 2, 3, 4].map((n) => ({ value: String(n), label: `${n}` })) }),
  field({ id: 'su', title: 'Summary', path: PATHS.summary, type: 'RichText' }),
  field({ id: 'rf', title: 'Red flags', path: PATHS.redFlags!, type: 'String' }),
  field({ id: 'dr', title: 'Detailed report', path: PATHS.detailedReport!, type: 'Url' }),
];

function form(fields: ProbeFormField[], over: Partial<ProbeFeedbackForm> = {}): ProbeFeedbackForm {
  return {
    formDefinitionId: FORM_ID, title: 'Hello Christy AI screen',
    interviewId: null, interviewTitle: null, stageId: null, stageTitle: null,
    sections: [{ id: 's', title: 'All', fields }], fieldCount: fields.length, schemaAvailable: true, ...over,
  };
}

const METRICS = [
  { key: 'profile_relevance', name: 'Profile relevance' },
  { key: 'communication', name: 'Communication' },
  { key: 'stability', name: 'Stability' },
];

describe('previewScorecardBinding', () => {
  it('is ready only when the form matches, every fixed field is present with its type, and every metric binds', () => {
    const good = form([...FIXED,
      field({ id: 'pr', title: 'Profile relevance', options: FIVE }),
      field({ id: 'co', title: 'Communication' }),
      field({ id: 'st', title: 'Stability', options: FIVE }),
      field({ id: 'en', title: 'English' }),
    ]);
    const p = previewScorecardBinding(HELLO_CHRISTY_SCORECARD_BINDING, good, METRICS);
    expect(p.ready).toBe(true);
    expect(p.formMatchesBinding).toBe(true);
    expect(p.fixedFields.map((f) => [f.name, f.status])).toEqual([
      ['overall', 'present'], ['summary', 'present'], ['redFlags', 'present'], ['detailedReport', 'present'],
    ]);
    expect(p.metrics).toEqual([
      { key: 'profile_relevance', name: 'Profile relevance', status: 'bound', fieldPath: 'path-pr', scale: { min: 1, max: 5 } },
      { key: 'communication', name: 'Communication', status: 'bound', fieldPath: 'path-co', scale: { min: 1, max: 4 } },
      { key: 'stability', name: 'Stability', status: 'bound', fieldPath: 'path-st', scale: { min: 1, max: 5 } },
    ]);
    expect(p.unusedScoreFields).toEqual([{ fieldId: 'en', title: 'English' }]);
  });

  it('names every reason a metric or fixed field would not be written', () => {
    const drift = form([
      ...FIXED.filter((f) => f.id !== 'rf'),                              // Red flags removed
      field({ id: 'dr2', title: 'Detailed report', path: PATHS.detailedReport!, type: 'String' }), // duplicate path, first wins → Url still present
      field({ id: 'pr', title: 'Profile relevance', type: 'String' }),
      field({ id: 'co1', title: 'Communication' }),
      field({ id: 'co2', title: 'communication' }),
    ]);
    const p = previewScorecardBinding(HELLO_CHRISTY_SCORECARD_BINDING, drift, METRICS);
    expect(p.ready).toBe(false);
    expect(p.fixedFields.find((f) => f.name === 'redFlags')).toMatchObject({ status: 'missing', actualType: null });
    expect(p.fixedFields.find((f) => f.name === 'detailedReport')).toMatchObject({ status: 'present', actualType: 'Url' });
    expect(p.metrics.map((m) => [m.key, m.status])).toEqual([
      ['profile_relevance', 'not_score_type'], ['communication', 'ambiguous_title'], ['stability', 'no_field'],
    ]);

    const retyped = form([...FIXED.filter((f) => f.id !== 'dr'), field({ id: 'dr', title: 'Detailed report', path: PATHS.detailedReport!, type: 'String' })]);
    expect(previewScorecardBinding(HELLO_CHRISTY_SCORECARD_BINDING, retyped, []).fixedFields.find((f) => f.name === 'detailedReport'))
      .toMatchObject({ status: 'type_mismatch', expectedType: 'Url', actualType: 'String' });
  });

  it('refuses readiness for another form, an archived form, no schema, or no metrics', () => {
    const good = form([...FIXED, field({ id: 'st', title: 'Stability' })]);
    const one = [{ key: 'stability', name: 'Stability' }];
    expect(previewScorecardBinding(HELLO_CHRISTY_SCORECARD_BINDING, good, one).ready).toBe(true);
    expect(previewScorecardBinding(HELLO_CHRISTY_SCORECARD_BINDING, { ...good, formDefinitionId: 'other' }, one)).toMatchObject({ formMatchesBinding: false, ready: false });
    expect(previewScorecardBinding(HELLO_CHRISTY_SCORECARD_BINDING, { ...good, archived: true }, one)).toMatchObject({ archived: true, formMatchesBinding: false, ready: false });
    const noSchema = previewScorecardBinding(HELLO_CHRISTY_SCORECARD_BINDING, { ...good, sections: [], schemaAvailable: false }, one);
    expect(noSchema.ready).toBe(false);
    expect(noSchema.fixedFields.every((f) => f.status === 'missing')).toBe(true);
    expect(previewScorecardBinding(HELLO_CHRISTY_SCORECARD_BINDING, good, []).ready).toBe(false);
  });
});

// ── Route ───────────────────────────────────────────────────────────────────

function fakeStore(): MissionControlStore {
  return {
    listMappings: async () => [], listWorkflows: async () => [],
    setMappingStatus: async () => ({ status: 'ok', mappingStatus: 'paused' }),
    cancelApplication: async () => ({ status: 'ok', cancelledOperations: 0, cancelledIngestion: 0 }),
    retryOperation: async () => ({ status: 'ok' }), retryIngestionParse: async () => ({ status: 'ok' }),
    retryLegacyBadOutput: async () => ({ status: 'ok' }), retryModelDegraded: async () => ({ status: 'ok' }),
    upsertMapping: async () => ({ status: 'ok', id: MAPPING_ID }),
    reissueManualInvite: async () => ({ status: 'ok', inviteId: MAPPING_ID, revokedInvites: 0 }),
  } as unknown as MissionControlStore;
}

function appWith(role: string | null, deps: Parameters<typeof createAshbyMissionControlRouter>[0]) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (role) (req as unknown as { authUser: unknown }).authUser = { id: MAPPING_ID, appRole: role };
    next();
  });
  app.use('/mc', createAshbyMissionControlRouter({ store: fakeStore(), probeReader: null, ...deps }));
  return app;
}

/** The official feedbackFormDefinition.info envelope for the verified form. */
const DEFINITION_PAYLOAD = {
  id: FORM_ID, title: 'Hello Christy AI screen', isArchived: false,
  formDefinition: { sections: [{ id: 'sec', title: 'All', fields: [
    ...FIXED.map((f) => ({ isRequired: f.id === 'ov', field: { id: f.id, type: f.type, path: f.path, title: f.title, selectableValues: f.options } })),
    { field: { id: 'pr', type: 'Score', path: 'path-pr', title: 'Profile relevance', selectableValues: FIVE, submittedValue: 'ANSWER-MUST-NOT-SURFACE' } },
    { field: { id: 'co', type: 'Score', path: 'path-co', title: 'Communication' } },
  ] }] },
};

function previewDeps(over: Partial<NonNullable<Parameters<typeof createAshbyMissionControlRouter>[0]>['scorecardPreview']> = {}) {
  const calls: string[] = [];
  const formDefinitionReader = {
    feedbackFormDefinitionInfo: vi.fn(async (id: string) => { calls.push(`feedbackFormDefinitionInfo:${id}`); return { results: DEFINITION_PAYLOAD }; }),
  };
  const scorecardPreview = {
    readMappingRoleId: async (id: string) => { calls.push(`readMappingRoleId:${id}`); return ROLE_ID; },
    loadMetrics: async (roleId: string) => { calls.push(`loadMetrics:${roleId}`); return METRICS; },
    ...over,
  };
  return { calls, formDefinitionReader: formDefinitionReader as never, scorecardPreview };
}

describe('GET /mappings/:id/scorecard-binding — read-only binding preview', () => {
  it('returns the preview for an admin: one definition read, structure and metric names only', async () => {
    const d = previewDeps();
    const sink = getAuditSink();
    const audits: AuditEntry[] = [];
    setAuditSink(async (e) => { audits.push(e); });
    try {
      const res = await request(appWith('admin', d)).get(`/mc/mappings/${MAPPING_ID}/scorecard-binding`);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.scoringPath).toBe('v2_autobind');
      expect(res.body.preview).toMatchObject({ formDefinitionId: FORM_ID, schemaAvailable: true, archived: false, formMatchesBinding: true, ready: false });
      expect(res.body.preview.metrics).toEqual([
        { key: 'profile_relevance', name: 'Profile relevance', status: 'bound', fieldPath: 'path-pr', scale: { min: 1, max: 5 } },
        { key: 'communication', name: 'Communication', status: 'bound', fieldPath: 'path-co', scale: { min: 1, max: 4 } },
        { key: 'stability', name: 'Stability', status: 'no_field', fieldPath: null, scale: null },
        // The derived Role fit row is always previewed for a v2 role (#282 signal on the kept v1 field).
        { key: 'role_fit', name: 'Role fit', status: 'no_field', fieldPath: null, scale: null },
      ]);
      expect(d.calls).toEqual([`readMappingRoleId:${MAPPING_ID}`, `loadMetrics:${ROLE_ID}`, `feedbackFormDefinitionInfo:${FORM_ID}`]);
      // Structure only: no submitted value, no provider body echo.
      expect(JSON.stringify(res.body)).not.toMatch(/ANSWER-MUST-NOT-SURFACE|submittedValue|isArchived|organizationId/);
      // Audit carries counts only — never a path, title, or metric name.
      const row = audits.find((a) => (a.metadata as Record<string, unknown> | undefined)?.resource === 'ashby_scorecard_binding_preview');
      expect(row).toBeDefined();
      expect(row!.metadata).toEqual({ resource: 'ashby_scorecard_binding_preview', scoring_path: 'v2_autobind', metric_count: 4, bound_count: 2, ready: false });
      expect(JSON.stringify(row)).not.toMatch(/path-pr|Profile relevance|Stability/);
    } finally {
      setAuditSink(sink);
    }
  });

  it('says v1_legacy when the role has no active scorecard and no_role when the mapping has none — still reading the form once', async () => {
    const legacy = previewDeps({ loadMetrics: async () => null });
    const r1 = await request(appWith('admin', legacy)).get(`/mc/mappings/${MAPPING_ID}/scorecard-binding`);
    expect(r1.status).toBe(200);
    expect(r1.body.scoringPath).toBe('v1_legacy');
    expect(r1.body.preview.metrics).toEqual([]);
    expect(r1.body.preview.fixedFields.every((f: { status: string }) => f.status === 'present')).toBe(true);

    const roleless = previewDeps({ readMappingRoleId: async () => null });
    const r2 = await request(appWith('admin', roleless)).get(`/mc/mappings/${MAPPING_ID}/scorecard-binding`);
    expect(r2.status).toBe(200);
    expect(r2.body.scoringPath).toBe('no_role');
    // (The override does not record; only the recording reader appears.)
    expect(roleless.calls).toEqual([`feedbackFormDefinitionInfo:${FORM_ID}`]);
  });

  it('answers 404 for an unknown mapping without touching the provider', async () => {
    const d = previewDeps({ readMappingRoleId: async () => undefined });
    const res = await request(appWith('admin', d)).get(`/mc/mappings/${MAPPING_ID}/scorecard-binding`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('mapping_not_found');
    expect(d.calls).toEqual([]); // no loadMetrics, no provider read
  });

  it('answers 503 when the integration is disabled — no client, no call, no table read', async () => {
    const d = previewDeps();
    const res = await request(appWith('admin', { ...d, formDefinitionReader: null })).get(`/mc/mappings/${MAPPING_ID}/scorecard-binding`);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('integration_disabled');
    expect(d.calls).toEqual([]);
  });

  it('sanitizes a provider failure or an unreadable definition to probe_unavailable', async () => {
    const boom = previewDeps();
    (boom.formDefinitionReader as { feedbackFormDefinitionInfo: unknown }).feedbackFormDefinitionInfo = async () => { throw new Error('403 secret-tenant-detail'); };
    const r1 = await request(appWith('admin', boom)).get(`/mc/mappings/${MAPPING_ID}/scorecard-binding`);
    expect(r1.status).toBe(502);
    expect(r1.body).toEqual({ ok: false, error: 'probe_unavailable' });

    const junk = previewDeps();
    (junk.formDefinitionReader as { feedbackFormDefinitionInfo: unknown }).feedbackFormDefinitionInfo = async () => ({ results: { nothing: true } });
    const r2 = await request(appWith('admin', junk)).get(`/mc/mappings/${MAPPING_ID}/scorecard-binding`);
    expect(r2.status).toBe(502);
    expect(r2.body.error).toBe('probe_unavailable');
  });

  it('reports a table read failure as a sanitized 500', async () => {
    const d = previewDeps({ readMappingRoleId: async () => { throw new Error('pg down'); } });
    const res = await request(appWith('admin', d)).get(`/mc/mappings/${MAPPING_ID}/scorecard-binding`);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('mission_control_read_error');
    expect(JSON.stringify(res.body)).not.toContain('pg down');
  });

  it('validates the mapping id and is admin-only and GET-only', async () => {
    const d = previewDeps();
    expect((await request(appWith('admin', d)).get('/mc/mappings/not-a-uuid/scorecard-binding')).status).toBe(400);
    for (const role of ['interviewer', 'viewer', null]) {
      expect((await request(appWith(role, d)).get(`/mc/mappings/${MAPPING_ID}/scorecard-binding`)).status).toBe(403);
    }
    for (const verb of ['post', 'put', 'patch', 'delete'] as const) {
      expect((await request(appWith('admin', d))[verb](`/mc/mappings/${MAPPING_ID}/scorecard-binding`).send({})).status, verb).toBe(404);
    }
    expect(d.calls).toEqual([]);
  });
});
