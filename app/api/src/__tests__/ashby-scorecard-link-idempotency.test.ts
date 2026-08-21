/**
 * Scorecard write idempotency is LINK-SCOPED, not marker-shaped.
 *
 * An Ashby scorecard cannot be retracted, so a second `scorecard_write` on an
 * application link that already has one is an unrecoverable defect. Before this
 * repair the only guards were the operation_key (which embedded the content
 * marker) and `uq_ashby_operations_marker` — so ANY change to the hashed
 * content, including the purely presentational review path, could let an old
 * link be written a second time on a re-drive.
 *
 * These tests pin the two halves of the fix:
 *   1. `enqueueScorecardWrite` refuses when the link already has a
 *      scorecard_write operation — whatever marker (or marker version) that
 *      historical row carries — and fails closed if it cannot find out;
 *   2. the operation_key it enqueues is derived from the LINK alone, so the
 *      existing `uq_ashby_operations_key` constraint is itself the durable,
 *      concurrency-safe one-scorecard-per-link guard.
 */

import { describe, it, expect, vi } from 'vitest';
import { createWorkflowStores } from '../integrations/ashby/workflow-stores.js';

const LINK_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const FORM_ID = '1c9a92c0-c18f-4bf1-898f-c29e71d7d303';

interface TableResult { data: unknown; error: unknown }

/** Chainable Supabase double recording which tables were queried. */
function fakeClient(results: Record<string, TableResult>) {
  const tables: string[] = [];
  const rpc = vi.fn(async () => ({ data: { status: 'inserted' }, error: null }));
  const client = {
    from(table: string) {
      tables.push(table);
      const result = results[table] ?? { data: null, error: null };
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      for (const m of ['select', 'eq', 'order', 'limit', 'in', 'is']) builder[m] = chain;
      const settle = () => Promise.resolve(result);
      builder.maybeSingle = settle;
      builder.single = settle;
      builder.then = (onOk: (v: unknown) => unknown) => settle().then(onOk);
      return builder;
    },
    rpc,
  };
  return { client, tables, rpc };
}

const ACTIVE_LINK: TableResult = {
  data: {
    external_application_id: 'app_1',
    external_job_id: 'job_1',
    job_mapping_id: 'map_1',
    ashby_job_mappings: { status: 'enabled', feedback_form_id: FORM_ID },
  },
  error: null,
};

const ASSESSMENT: TableResult = {
  data: {
    id: 'assess_1',
    english: { grammar: 8, vocabulary: 8, fluency: 8, coherence: 8 },
    tone: { clarity: 7, confidence: 7, professionalism: 7 },
    communication: { score: 8 },
    motivation: { score: 7 },
    role_fit: { score: 9 },
    overall_score: 80,
    recommendation: 'advance',
    summary: 'Strong communicator with relevant experience.',
    provenance: { requestedModel: 'm', prompt_template_version: 'v1' },
    created_at: '2026-08-20T00:00:00Z',
  },
  error: null,
};

describe('enqueueScorecardWrite — one scorecard per application link, ever', () => {
  it('refuses when the link already has a scorecard_write under a LEGACY marker', async () => {
    // The historical row was written when the marker still hashed
    // /sessions/<id>; its marker no longer matches anything we would compute.
    const { client, tables, rpc } = fakeClient({
      ashby_operations: { data: { id: 'op_legacy' }, error: null },
      ashby_application_links: ACTIVE_LINK,
      assessments: ASSESSMENT,
    });
    const stores = createWorkflowStores(client as never);

    const result = await stores.enqueueScorecardWrite!(LINK_ID, SESSION_ID);

    expect(result).toEqual({ status: 'duplicate' });
    expect(rpc).not.toHaveBeenCalled();
    // Short-circuits before any further read — the guard is the first thing.
    expect(tables).toEqual(['ashby_operations']);
  });

  it('fails closed when the existing-operation lookup errors', async () => {
    const { client, rpc } = fakeClient({
      ashby_operations: { data: null, error: { message: 'connection reset' } },
      ashby_application_links: ACTIVE_LINK,
      assessments: ASSESSMENT,
    });
    const stores = createWorkflowStores(client as never);

    await expect(stores.enqueueScorecardWrite!(LINK_ID, SESSION_ID)).rejects.toThrow(
      'ashby_scorecard_enqueue_error',
    );
    expect(rpc).not.toHaveBeenCalled();
  });

  it('still performs the INITIAL write, keyed by the link alone', async () => {
    const { client, rpc } = fakeClient({
      ashby_operations: { data: null, error: null },
      ashby_application_links: ACTIVE_LINK,
      assessments: ASSESSMENT,
    });
    const stores = createWorkflowStores(client as never);

    const result = await stores.enqueueScorecardWrite!(LINK_ID, SESSION_ID);

    expect(result).toEqual({ status: 'inserted' });
    expect(rpc).toHaveBeenCalledTimes(1);
    const [fn, args] = rpc.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(fn).toBe('enqueue_ashby_operation');
    expect(args.p_operation_type).toBe('scorecard_write');
    expect(args.p_operation_key).toBe(`ashby:scorecard:link:${LINK_ID}`);
    // The key must NOT carry the content marker: a marker change must never
    // mint a second operation_key and slip past uq_ashby_operations_key.
    expect(String(args.p_operation_key)).not.toContain(String(args.p_marker));
    expect(String(args.p_marker)).toMatch(/^[a-f0-9]{32}$/);
  });

  it('keeps the mapping and assessment gates ahead of any enqueue', async () => {
    const paused = fakeClient({
      ashby_operations: { data: null, error: null },
      ashby_application_links: {
        data: { external_application_id: 'app_1', ashby_job_mappings: { status: 'paused', feedback_form_id: FORM_ID } },
        error: null,
      },
      assessments: ASSESSMENT,
    });
    const pausedStores = createWorkflowStores(paused.client as never);
    expect(await pausedStores.enqueueScorecardWrite!(LINK_ID, SESSION_ID)).toEqual({ status: 'mapping_inactive' });
    expect(paused.rpc).not.toHaveBeenCalled();

    const noAssessment = fakeClient({
      ashby_operations: { data: null, error: null },
      ashby_application_links: ACTIVE_LINK,
      assessments: { data: null, error: null },
    });
    const noAssessmentStores = createWorkflowStores(noAssessment.client as never);
    expect(await noAssessmentStores.enqueueScorecardWrite!(LINK_ID, SESSION_ID)).toEqual({ status: 'assessment_missing' });
    expect(noAssessment.rpc).not.toHaveBeenCalled();
  });
});
