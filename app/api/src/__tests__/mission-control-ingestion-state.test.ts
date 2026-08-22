/**
 * Mission Control's `ingestionState` was `null` for every workflow.
 *
 * WHAT WENT WRONG. PostgREST decides an embed's SHAPE from the relationship's
 * cardinality: to-many arrives as an ARRAY, to-one as a plain OBJECT.
 * `ashby_resume_ingestions` carries `unique (application_link_id)` (0029), so
 * it is to-one and arrives as an object — but the projection indexed it as
 * `[0]`, which on an object is always `undefined`. Every workflow therefore
 * reported `ingestionState: null`, including rows demonstrably rested in
 * `failed_review`, so an operator working the Mission Control list could never
 * see a parse failure there. It stayed visible only through the health surface
 * (`invite_blocked_failed_ingestion`), which is why it went unnoticed — and it
 * was found only because a production canary had to fall back to a different
 * discriminator to locate the very row it was about to act on.
 *
 * The sibling `ashby_operations` embed has NO unique constraint, so it is
 * genuinely to-many; its array handling is correct and is asserted here to be
 * unchanged.
 *
 * These tests drive the real store against a fake Supabase client, so the
 * projection — not a mock of it — is what is under test.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createMissionControlStore,
  readEmbeddedIngestionState,
} from '../integrations/ashby/workflow-stores.js';

const LINK = '11111111-1111-4111-8111-111111111111';
const OP = '22222222-2222-4222-8222-222222222222';

interface Captured { table: string; select: string; limit?: number; order?: unknown; eq?: unknown[] }

/**
 * Minimal Supabase-shaped stub. Records every call so the test can assert the
 * query was not altered and that no extra round-trip was introduced.
 */
function fakeClient(linkRows: Array<Record<string, unknown>>, sessionRows: Array<Record<string, unknown>> = []) {
  const calls: Captured[] = [];
  const from = vi.fn((table: string) => {
    const cap: Captured = { table, select: '' };
    calls.push(cap);
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    builder.select = (sel: string) => { cap.select = sel; return chain(); };
    builder.eq = (...a: unknown[]) => { cap.eq = a; return chain(); };
    builder.order = (...a: unknown[]) => { cap.order = a; return chain(); };
    builder.in = () => chain();
    builder.limit = (n: number) => {
      cap.limit = n;
      return Promise.resolve({ data: linkRows, error: null });
    };
    // `call_sessions` resolves without .limit()
    (builder as { then?: unknown }).then = (res: (v: unknown) => unknown) =>
      res({ data: sessionRows, error: null });
    return builder;
  });
  return { client: { from } as never, calls, from };
}

function linkRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: LINK,
    external_application_id: 'app_ext',
    external_job_id: 'job_ext',
    lifecycle: 'imported',
    terminal_state: null,
    session_id: null,
    updated_at: '2026-08-22T00:00:00.000Z',
    ashby_resume_ingestions: { state: 'failed_review' },
    ashby_operations: [{ id: OP, operation_type: 'invite_delivery', state: 'pending', error_code: null }],
    ...over,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// 1. The unit the defect lived in
// ═══════════════════════════════════════════════════════════════════════

describe('readEmbeddedIngestionState', () => {
  it('reads the OBJECT shape PostgREST actually returns for a to-one embed', () => {
    // This is the case that was always undefined before.
    expect(readEmbeddedIngestionState({ state: 'failed_review' })).toBe('failed_review');
    expect(readEmbeddedIngestionState({ state: 'ready' })).toBe('ready');
  });

  it('still reads the ARRAY shape, defensively', () => {
    expect(readEmbeddedIngestionState([{ state: 'queued' }])).toBe('queued');
    expect(readEmbeddedIngestionState([{ state: 'ready' }, { state: 'queued' }])).toBe('ready');
  });

  it('degrades to null for absent, null, empty or malformed embeds', () => {
    for (const empty of [undefined, null, [], {}, [null], 'nonsense', 42]) {
      expect(readEmbeddedIngestionState(empty as unknown)).toBeNull();
    }
    // A present-but-unusable `state` is null, never a coerced string.
    expect(readEmbeddedIngestionState({ state: null })).toBeNull();
    expect(readEmbeddedIngestionState({ state: '' })).toBeNull();
    expect(readEmbeddedIngestionState({ state: 7 })).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. The projection, end to end through the real store
// ═══════════════════════════════════════════════════════════════════════

describe('listWorkflows — ingestionState projection', () => {
  it('reports the state for the object embed (the regression)', async () => {
    const { client } = fakeClient([linkRow()]);
    const [w] = await createMissionControlStore(client).listWorkflows(50);
    expect(w.ingestionState).toBe('failed_review');
  });

  it('reports each row independently across mixed shapes and absences', async () => {
    const { client } = fakeClient([
      linkRow({ id: LINK, ashby_resume_ingestions: { state: 'ready' } }),
      linkRow({ id: LINK, ashby_resume_ingestions: [{ state: 'queued' }] }),
      linkRow({ id: LINK, ashby_resume_ingestions: null }),
      (() => { const r = linkRow(); delete r.ashby_resume_ingestions; return r; })(),
    ]);
    const out = await createMissionControlStore(client).listWorkflows(50);
    expect(out.map((w) => w.ingestionState)).toEqual(['ready', 'queued', null, null]);
  });

  it('leaves the to-many operations projection exactly as it was', async () => {
    const { client } = fakeClient([linkRow({
      ashby_operations: [
        { id: OP, operation_type: 'invite_delivery', state: 'awaiting_manual_delivery', error_code: null },
        { id: OP, operation_type: 'scorecard_write', state: 'failed', error_code: 'sanitized_code' },
      ],
    })]);
    const [w] = await createMissionControlStore(client).listWorkflows(50);
    expect(w.operations).toEqual([
      { id: OP, type: 'invite_delivery', state: 'awaiting_manual_delivery', errorCode: null },
      { id: OP, type: 'scorecard_write', state: 'failed', errorCode: 'sanitized_code' },
    ]);
  });

  it('keeps every other field of the response shape unchanged', async () => {
    const { client } = fakeClient([linkRow()]);
    const [w] = await createMissionControlStore(client).listWorkflows(50);
    expect(Object.keys(w).sort()).toEqual([
      'applicationLinkId', 'externalApplicationId', 'externalJobId', 'ingestionState',
      'lifecycle', 'operations', 'sessionId', 'sessionStatus', 'terminalState', 'updatedAt',
    ]);
    expect(w).toMatchObject({
      applicationLinkId: LINK,
      lifecycle: 'imported',
      terminalState: null,
      sessionStatus: null,
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. The query is untouched — no N+1, no widened read
// ═══════════════════════════════════════════════════════════════════════

describe('listWorkflows — the read itself is unchanged', () => {
  it('issues ONE list query, with the caller\'s limit, ordered as before', async () => {
    const { client, calls } = fakeClient([linkRow({ session_id: null })]);
    await createMissionControlStore(client).listWorkflows(37);

    const list = calls.filter((c) => c.table === 'ashby_application_links');
    expect(list).toHaveLength(1);
    expect(list[0].limit).toBe(37);
    expect(list[0].order).toEqual(['updated_at', { ascending: false }]);
    expect(list[0].eq).toEqual(['provider', 'ashby']);
    // No per-row follow-up read was introduced for the ingestion.
    expect(calls.filter((c) => c.table === 'ashby_resume_ingestions')).toHaveLength(0);
  });

  it('selects the same columns — the fix reads the embed, it does not widen it', async () => {
    const { client, calls } = fakeClient([linkRow()]);
    await createMissionControlStore(client).listWorkflows(50);
    const sel = calls.find((c) => c.table === 'ashby_application_links')!.select;
    expect(sel).toContain('ashby_resume_ingestions ( state )');
    expect(sel).toContain('ashby_operations ( id, operation_type, state, error_code )');
    // Nothing candidate-bearing or provider-bearing was added to the read.
    for (const forbidden of [
      'external_resume_file_handle', 'candidate', 'resume_id', 'content_sha256',
      'failed_reason', 'provenance', 'invite', 'token',
    ]) {
      expect(sel).not.toContain(forbidden);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. Sanitization — the fix must not become a leak
// ═══════════════════════════════════════════════════════════════════════

describe('listWorkflows — sanitization', () => {
  it('emits no failure reason, handle, provenance, token or raw error', async () => {
    const { client } = fakeClient([linkRow({
      // A realistic embed carries more than `state`; only `state` may surface.
      ashby_resume_ingestions: {
        state: 'failed_review',
        failed_reason: 'parse_bad_output',
        content_sha256: 'a'.repeat(64),
        provenance: { note: 'internal' },
      },
      external_resume_file_handle: 'h'.repeat(64),
    })]);
    const [w] = await createMissionControlStore(client).listWorkflows(50);

    expect(w.ingestionState).toBe('failed_review');
    const blob = JSON.stringify(w);
    for (const forbidden of [
      'parse_bad_output', 'a'.repeat(64), 'h'.repeat(64), 'provenance', 'internal',
      'failed_reason', 'content_sha256',
    ]) {
      expect(blob).not.toContain(forbidden);
    }
  });
});
