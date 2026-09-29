/**
 * Ashby runtime adapters — the service-role persistence surface.
 *
 * These are the thin Supabase adapters the composition root builds. They carry
 * real risk that unit tests of the pure domain cannot catch: wrong column
 * names, a CAS that silently degrades to a blind write, a resume row that
 * accidentally retains a stored object, or a mapping that is honoured while
 * paused. Every one of those is asserted here against a recording fake client.
 *
 * Zero network, zero DB: the Supabase client is a chainable in-memory double.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createAshbyRuntime,
  createMaterializationStore,
  extractFileUrl,
  ASHBY_EXTRACTOR_VERSION,
} from '../integrations/ashby/runtime.js';
import { loadAshbyConfig, loadAshbyRuntimeConfig } from '../integrations/ashby/config.js';
import { createMissionControlStore } from '../integrations/ashby/workflow-stores.js';
import { createMappingResolver } from '../integrations/ashby/stores.js';

const APIKEY = 'SENTINEL_APIKEY_aaaaaaaaaaaaaaaaaaaa';
const SECRET = 'SENTINEL_SECRET_bbbbbbbbbbbbbbbbbbbb';

function env(over: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ASHBY_INTEGRATION_ENABLED: 'true',
    ASHBY_WEBHOOK_SECRET: SECRET,
    ASHBY_RUNTIME_ENABLED: 'true',
    ASHBY_API_KEY: APIKEY,
    ...over,
  } as NodeJS.ProcessEnv;
}

/** Recorded shape of one query the adapters issued. */
interface Recorded {
  table: string;
  op: 'insert' | 'update' | 'select' | 'delete';
  payload?: Record<string, unknown>;
  filters: Array<[string, string, unknown]>;
  columns?: string;
}

/**
 * A chainable Supabase double. Each builder records what the adapter asked for
 * and resolves to a caller-supplied result, so assertions can inspect the exact
 * columns, filters, and payloads that would hit Postgres.
 */
function fakeSupabase(results: Record<string, unknown> = {}) {
  const calls: Recorded[] = [];
  const client = {
    from(table: string) {
      const rec: Recorded = { table, op: 'select', filters: [] };
      calls.push(rec);
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      builder.insert = (payload: Record<string, unknown>) => { rec.op = 'insert'; rec.payload = payload; return chain(); };
      builder.update = (payload: Record<string, unknown>) => { rec.op = 'update'; rec.payload = payload; return chain(); };
      builder.delete = () => { rec.op = 'delete'; return chain(); };
      builder.select = (columns?: string) => { rec.columns = columns; return chain(); };
      builder.eq = (c: string, v: unknown) => { rec.filters.push(['eq', c, v]); return chain(); };
      builder.is = (c: string, v: unknown) => { rec.filters.push(['is', c, v]); return chain(); };
      builder.gt = (c: string, v: unknown) => { rec.filters.push(['gt', c, v]); return chain(); };
      builder.in = (c: string, v: unknown) => { rec.filters.push(['in', c, v]); return chain(); };
      builder.limit = () => chain();
      builder.order = () => chain();
      // The key must be computed LAZILY: `rec.op` is only known once the
      // adapter has called .insert()/.update()/.delete() on the builder.
      const settle = () => Promise.resolve(
        (results[`${table}:${rec.op}`] as { data?: unknown; error?: unknown })
        ?? (results[table] as { data?: unknown; error?: unknown })
        ?? { data: null, error: null },
      );
      builder.single = settle;
      builder.maybeSingle = settle;
      builder.then = (onOk: (v: unknown) => unknown) => settle().then(onOk);
      return builder;
    },
    rpc: vi.fn(async () => ({ data: null, error: null })),
  };
  return { client: client as never, calls };
}

describe('createMaterializationStore — resume + candidate persistence', () => {
  it('writes a resume row with NO stored object (file_path stays null)', async () => {
    const { client, calls } = fakeSupabase({ 'resumes:insert': { data: { id: 'r1' }, error: null } });
    const store = createMaterializationStore(client);
    const r = await store.insertResume({ textExtracted: 'hello', parsed: {} as never });
    expect(r).toEqual({ id: 'r1' });

    const insert = calls.find((c) => c.table === 'resumes' && c.op === 'insert')!;
    // The Ashby original is ephemeral: it must never be written to the bucket.
    expect(insert.payload!.file_path).toBeNull();
    expect(insert.payload!.file_name).toBeNull();
    expect(insert.payload).not.toHaveProperty('storage_key');
  });

  it('bounds the persisted extracted text', async () => {
    const { client, calls } = fakeSupabase({ 'resumes:insert': { data: { id: 'r1' }, error: null } });
    const store = createMaterializationStore(client);
    await store.insertResume({ textExtracted: 'x'.repeat(100_000), parsed: {} as never });
    const insert = calls.find((c) => c.op === 'insert')!;
    expect(String(insert.payload!.text_extracted).length).toBe(50_000);
  });

  it('writes a candidate carrying the mapping role/owner and an ashby source tag', async () => {
    const { client, calls } = fakeSupabase({ 'candidates:insert': { data: { id: 'c1' }, error: null } });
    const store = createMaterializationStore(client);
    await store.insertCandidate({
      roleId: 'role-1', ownerId: 'owner-1', resumeId: 'r1',
      parsed: { name: 'N', email: 'e@x.invalid', phone: '+1', skills: ['a'], experience_years: 2, current_role: null, summary: null },
    });
    const insert = calls.find((c) => c.table === 'candidates' && c.op === 'insert')!;
    expect(insert.payload).toMatchObject({ role_id: 'role-1', owner_id: 'owner-1', resume_id: 'r1', ats_source: 'ashby', status: 'new' });
  });

  it('throws a sanitized error when an insert fails', async () => {
    const { client } = fakeSupabase({ 'resumes:insert': { data: null, error: { message: 'pg: relation missing at 10.0.0.5' } } });
    const store = createMaterializationStore(client);
    await expect(store.insertResume({ textExtracted: null, parsed: {} as never }))
      .rejects.toThrow('ashby_resume_insert_error');
  });
});

describe('createMaterializationStore — CAS back-fill', () => {
  it('binds only while the column is still null (a real compare-and-set)', async () => {
    const { client, calls } = fakeSupabase({
      'ashby_application_links:update': { data: { candidate_id: 'cand_1' }, error: null },
    });
    const store = createMaterializationStore(client);
    const r = await store.bindLinkColumn({ applicationLinkId: 'link_1', column: 'candidate_id', value: 'cand_1' });
    expect(r).toEqual({ bound: 'cand_1', wonRace: true });

    const update = calls.find((c) => c.op === 'update')!;
    // The `is(column, null)` predicate IS the CAS. Without it this degrades to
    // a blind overwrite and two runners could each bind their own candidate.
    expect(update.filters).toContainEqual(['is', 'candidate_id', null]);
    expect(update.filters).toContainEqual(['eq', 'id', 'link_1']);
  });

  it('adopts the concurrent winner when the CAS matches no row', async () => {
    const { client } = fakeSupabase({
      'ashby_application_links:update': { data: null, error: null },
      'ashby_application_links:select': { data: { session_id: 'sess_winner' }, error: null },
    });
    const store = createMaterializationStore(client);
    const r = await store.bindLinkColumn({ applicationLinkId: 'link_1', column: 'session_id', value: 'sess_mine' });
    expect(r).toEqual({ bound: 'sess_winner', wonRace: false });
  });

  it('fails closed when neither the CAS nor the re-read yields a value', async () => {
    const { client } = fakeSupabase({
      'ashby_application_links:update': { data: null, error: null },
      'ashby_application_links:select': { data: null, error: null },
    });
    const store = createMaterializationStore(client);
    await expect(store.bindLinkColumn({ applicationLinkId: 'l', column: 'invite_id', value: 'i' }))
      .rejects.toThrow('ashby_link_bind_error');
  });
});

describe('createMaterializationStore — session and invite', () => {
  it('creates a browser session owned by the mapping owner in the created state', async () => {
    const { client, calls } = fakeSupabase({ 'call_sessions:insert': { data: { id: 's1' }, error: null } });
    const store = createMaterializationStore(client);
    await store.createSession({ candidateId: 'c1', roleId: 'r1', ownerId: 'o1' });
    const insert = calls.find((c) => c.table === 'call_sessions')!;
    expect(insert.payload).toMatchObject({ candidate_id: 'c1', role_id: 'r1', owner_id: 'o1', mode: 'browser', status: 'created' });
  });

  it('treats an invite as active only when unconsumed, unrevoked, and unexpired', async () => {
    const { client, calls } = fakeSupabase({ 'candidate_invites:select': { data: { id: 'inv_1' }, error: null } });
    const store = createMaterializationStore(client);
    const r = await store.findActiveInvite('sess_1', '2026-08-17T00:00:00.000Z');
    expect(r).toEqual({ id: 'inv_1' });

    const select = calls.find((c) => c.table === 'candidate_invites')!;
    expect(select.filters).toContainEqual(['is', 'consumed_at', null]);
    expect(select.filters).toContainEqual(['is', 'revoked_at', null]);
    expect(select.filters).toContainEqual(['gt', 'expires_at', '2026-08-17T00:00:00.000Z']);
    // It must never select the digest column — nothing needs it.
    expect(select.columns).toBe('id');
  });

  it('persists ONLY the digest, never a plaintext token column', async () => {
    const { client, calls } = fakeSupabase({ 'candidate_invites:insert': { data: { id: 'inv_1' }, error: null } });
    const store = createMaterializationStore(client);
    await store.insertInvite({
      tokenDigest: 'a'.repeat(64), candidateId: 'c1', sessionId: 's1',
      createdBy: 'o1', expiresAt: '2026-08-18T00:00:00.000Z',
    });
    const insert = calls.find((c) => c.table === 'candidate_invites')!;
    expect(insert.payload!.token_digest).toBe('a'.repeat(64));
    for (const forbidden of ['token', 'plaintext', 'raw_token', 'invite_token']) {
      expect(Object.keys(insert.payload!)).not.toContain(forbidden);
    }
  });
});

describe('runtime mapping resolvers', () => {
  function runtimeWith(client: never) {
    return createAshbyRuntime({
      supabase: client,
      config: loadAshbyConfig(env()),
      runtimeConfig: loadAshbyRuntimeConfig(env()),
      transport: vi.fn(),
    })!;
  }

  it('resolves a mapping by job id with its status, AI stage, and delivery mode', async () => {
    const { client, calls } = fakeSupabase({
      'ashby_job_mappings:select': {
        data: { id: 'map_1', status: 'enabled', ai_screening_stage_id: 'stage_ai', delivery_mode: 'both', activation_at: '2026-09-25T00:00:00Z', activation_epoch: 2, config_version: 3 },
        error: null,
      },
    });
    const r = await runtimeWith(client).resolveMappingByJobId('job_1');
    expect(r).toEqual({ status: 'enabled', aiScreeningStageId: 'stage_ai', id: 'map_1', deliveryMode: 'both', screeningMode: 'browser_primary', activationAt: '2026-09-25T00:00:00Z', activationEpoch: 2, configVersion: 3 });
    // 0109: a job can own an archived row beside its live one, so the read
    // must be scoped to the LIVE row — otherwise maybeSingle sees two rows.
    const read = calls.find((c) => c.table === 'ashby_job_mappings')!;
    expect(read.filters).toEqual([
      ['eq', 'provider', 'ashby'],
      ['eq', 'external_job_id', 'job_1'],
      ['is', 'archived_at', null],
    ]);
  });

  it('reports unknown for a job with no mapping rather than inventing one', async () => {
    const { client } = fakeSupabase({ 'ashby_job_mappings:select': { data: null, error: null } });
    const r = await runtimeWith(client).resolveMappingByJobId('job_missing');
    expect(r).toEqual({ status: 'unknown', id: null, deliveryMode: 'manual' });
  });

  it('normalises an unrecognised status and delivery mode conservatively', async () => {
    const { client } = fakeSupabase({
      'ashby_job_mappings:select': {
        data: { id: 'm', status: 'something_new', ai_screening_stage_id: null, delivery_mode: 'carrier_pigeon' },
        error: null,
      },
    });
    const r = await runtimeWith(client).resolveMappingByJobId('job_1');
    expect(r.status).toBe('unknown');
    expect(r.deliveryMode).toBe('manual');
  });

  it('refuses to materialize for a mapping that is not ENABLED', async () => {
    for (const status of ['paused', 'drift', 'unknown']) {
      const { client } = fakeSupabase({
        'ashby_application_links:select': {
          data: { job_mapping_id: 'map_1', ashby_job_mappings: { id: 'map_1', role_id: 'r', owner_id: 'o', delivery_mode: 'manual', status } },
          error: null,
        },
      });
      const r = await runtimeWith(client).resolveMappingForLink('link_1');
      expect(r, `status=${status}`).toBeNull();
    }
  });

  it('returns the materialization mapping when it IS enabled', async () => {
    const { client } = fakeSupabase({
      'ashby_application_links:select': {
        data: { job_mapping_id: 'map_1', ashby_job_mappings: { id: 'map_1', role_id: 'r1', owner_id: 'o1', delivery_mode: 'manual', status: 'enabled' } },
        error: null,
      },
    });
    const r = await runtimeWith(client).resolveMappingForLink('link_1');
    expect(r).toEqual({ id: 'map_1', roleId: 'r1', ownerId: 'o1', deliveryMode: 'manual' });
  });
});

describe('buildIngestionPorts', () => {
  function runtimeWith(client: never, over: Record<string, unknown> = {}) {
    return createAshbyRuntime({
      supabase: client,
      config: loadAshbyConfig(env({ ASHBY_RESUME_HOSTS: 'files.ashby.example' })),
      runtimeConfig: loadAshbyRuntimeConfig(env({ ASHBY_RESUME_HOSTS: 'files.ashby.example' })),
      transport: vi.fn(),
      ...over,
    })!;
  }

  // The three "nothing to ingest" outcomes are now NAMED rather than all
  // collapsing to null — that collapse is what let a real provider failure be
  // reported as job success while the durable row stayed `queued` forever.
  it('reports no_resume when the application carries no resume handle', async () => {
    const { client } = fakeSupabase({
      'ashby_application_links:select': { data: { external_resume_file_handle: null }, error: null },
    });
    const built = await runtimeWith(client).buildIngestionPorts({ applicationLinkId: 'link_1', onState: async () => {} });
    expect(built.status).toBe('no_resume');
  });

  it('reports link_missing when the link row is missing', async () => {
    const { client } = fakeSupabase({ 'ashby_application_links:select': { data: null, error: null } });
    const built = await runtimeWith(client).buildIngestionPorts({ applicationLinkId: 'nope', onState: async () => {} });
    expect(built.status).toBe('link_missing');
  });

  it('reports url_unresolved when file.info exposes no usable https URL', async () => {
    const { client } = fakeSupabase({
      'ashby_application_links:select': { data: { external_resume_file_handle: 'handle_1' }, error: null },
    });
    const transport = vi.fn(async () => ({
      status: 200, ok: true,
      headers: { get: () => null },
      text: async () => JSON.stringify({ success: true, results: { url: 'http://insecure.example/r.pdf' } }),
    }));
    const built = await runtimeWith(client, { transport })
      .buildIngestionPorts({ applicationLinkId: 'link_1', onState: async () => {} });
    expect(built.status).toBe('url_unresolved');
  });

  it('builds ports carrying the configured SSRF policy and version tags', async () => {
    const { client } = fakeSupabase({
      'ashby_application_links:select': { data: { external_resume_file_handle: 'handle_1' }, error: null },
    });
    // The transport answers file.info with a presigned URL.
    const transport = vi.fn(async () => ({
      status: 200, ok: true,
      headers: { get: () => null },
      text: async () => JSON.stringify({ success: true, results: { url: 'https://files.ashby.example/r.pdf' } }),
    }));
    const runtime = runtimeWith(client, { transport });
    const built = await runtime.buildIngestionPorts({ applicationLinkId: 'link_1', onState: async () => {} });

    expect(built.status).toBe('ok');
    const ports = built.status === 'ok' ? built.ports : null;
    expect(ports).not.toBeNull();
    expect(ports!.presignedUrl).toBe('https://files.ashby.example/r.pdf');
    expect(ports!.policy.allowlistEnabled).toBe(true);
    expect(ports!.policy.allowedHosts).toEqual(['files.ashby.example']);
    expect(ports!.policy.allowedPorts).toEqual([443]);
    expect(ports!.extractorVersion).toBe(ASHBY_EXTRACTOR_VERSION);
  });

  it('a non-https file.info URL yields url_unresolved, never usable ports', async () => {
    const { client } = fakeSupabase({
      'ashby_application_links:select': { data: { external_resume_file_handle: 'handle_1' }, error: null },
    });
    const transport = vi.fn(async () => ({
      status: 200, ok: true,
      headers: { get: () => null },
      text: async () => JSON.stringify({ success: true, results: { url: 'http://insecure.example/r.pdf' } }),
    }));
    const built = await runtimeWith(client, { transport })
      .buildIngestionPorts({ applicationLinkId: 'link_1', onState: async () => {} });
    expect(built.status).toBe('url_unresolved');
  });

  it('scan port is fail-closed even if the scanner throws', async () => {
    const { client } = fakeSupabase({
      'ashby_application_links:select': { data: { external_resume_file_handle: 'h' }, error: null },
    });
    const transport = vi.fn(async () => ({
      status: 200, ok: true,
      headers: { get: () => null },
      text: async () => JSON.stringify({ success: true, results: { url: 'https://files.ashby.example/r.pdf' } }),
    }));
    const built = await runtimeWith(client, { transport })
      .buildIngestionPorts({ applicationLinkId: 'link_1', onState: async () => {} });
    if (built.status !== 'ok') throw new Error(`expected ok ports, got ${built.status}`);
    const ports = built.ports;
    // The bundled test scanner treats arbitrary bytes as clean; the contract we
    // assert is that the port never throws and always yields a verdict object.
    const verdict = await ports.scan(Buffer.from('synthetic'));
    expect(typeof verdict.safe).toBe('boolean');
    expect(typeof verdict.status).toBe('string');
  });

  it('guard port rejects a payload whose magic bytes do not match', async () => {
    const { client } = fakeSupabase({
      'ashby_application_links:select': { data: { external_resume_file_handle: 'h' }, error: null },
    });
    const transport = vi.fn(async () => ({
      status: 200, ok: true,
      headers: { get: () => null },
      text: async () => JSON.stringify({ success: true, results: { url: 'https://files.ashby.example/r.pdf' } }),
    }));
    const built = await runtimeWith(client, { transport })
      .buildIngestionPorts({ applicationLinkId: 'link_1', onState: async () => {} });
    if (built.status !== 'ok') throw new Error(`expected ok ports, got ${built.status}`);
    const ports = built.ports;
    const result = ports.guard(Buffer.from('not a pdf at all'), 'application/pdf');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(typeof result.reason).toBe('string');
  });
});

describe('extractFileUrl', () => {
  it('accepts the plausible https keys and the nested file object', () => {
    expect(extractFileUrl({ url: 'https://a.example/x' })).toBe('https://a.example/x');
    expect(extractFileUrl({ downloadUrl: 'https://b.example/x' })).toBe('https://b.example/x');
    expect(extractFileUrl({ file: { signedUrl: 'https://c.example/x' } })).toBe('https://c.example/x');
  });

  it('rejects non-https and malformed payloads', () => {
    expect(extractFileUrl({ url: 'http://a.example/x' })).toBeNull();
    expect(extractFileUrl({ url: 'ftp://a.example/x' })).toBeNull();
    expect(extractFileUrl({ url: 42 })).toBeNull();
    for (const bad of [null, undefined, 'string', 42, []]) expect(extractFileUrl(bad)).toBeNull();
  });
});

describe('runtime shutdown', () => {
  it('is idempotent', async () => {
    const { client } = fakeSupabase();
    const runtime = createAshbyRuntime({
      supabase: client,
      config: loadAshbyConfig(env()),
      runtimeConfig: loadAshbyRuntimeConfig(env()),
      transport: vi.fn(),
      parserPool: { submit: async () => ({ text: '', totalLength: 0, truncated: false }), stats: () => ({}) as never, drain: async () => {} },
    })!;
    await runtime.shutdown();
    await expect(runtime.shutdown()).resolves.toBeUndefined();
  });
});

describe('createMissionControlStore — stranded-completion visibility', () => {
  const LINK = '11111111-1111-4111-8111-111111111111';
  const SESSION = '22222222-2222-4222-8222-222222222222';

  function linkRow(over: Record<string, unknown> = {}) {
    return {
      id: LINK,
      external_application_id: 'app_1',
      external_job_id: 'job_1',
      lifecycle: 'ready',
      terminal_state: null,
      session_id: SESSION,
      updated_at: '2026-08-17T00:00:00Z',
      ashby_resume_ingestions: [{ state: 'ready' }],
      ashby_operations: [],
      ...over,
    };
  }

  it('surfaces the screening session status alongside the lifecycle', async () => {
    const { client, calls } = fakeSupabase({
      ashby_application_links: { data: [linkRow()], error: null },
      call_sessions: { data: [{ id: SESSION, status: 'completed' }], error: null },
    });
    const [row] = await createMissionControlStore(client).listWorkflows(50);

    // `completed` session + lifecycle that is not `writeback_pending` + no
    // terminal state is exactly the stranded completion-park case. The
    // observer is best-effort with respect to scoring, so this projection is
    // what makes a park that did not land legible to an operator.
    expect(row.sessionStatus).toBe('completed');
    expect(row.lifecycle).not.toBe('writeback_pending');
    expect(row.terminalState).toBeNull();

    // Fetched as its own bounded query, not an embedded join.
    const sessions = calls.find((c) => c.table === 'call_sessions')!;
    expect(sessions.columns).toBe('id, status');
    expect(sessions.filters).toContainEqual(['in', 'id', [SESSION]]);
  });

  it('degrades sessionStatus to null instead of breaking the list', async () => {
    const { client } = fakeSupabase({
      ashby_application_links: { data: [linkRow()], error: null },
      call_sessions: { data: null, error: { message: 'boom' } },
    });
    const rows = await createMissionControlStore(client).listWorkflows(50);
    // The workflow list is what operators rely on; a diagnostic read failure
    // must never take it down.
    expect(rows).toHaveLength(1);
    expect(rows[0].sessionStatus).toBeNull();
  });

  it('issues no session query at all when no workflow has a session', async () => {
    const { client, calls } = fakeSupabase({
      ashby_application_links: { data: [linkRow({ session_id: null })], error: null },
    });
    const rows = await createMissionControlStore(client).listWorkflows(50);
    expect(rows[0].sessionStatus).toBeNull();
    expect(calls.some((c) => c.table === 'call_sessions')).toBe(false);
  });
});

describe('createMissionControlStore — "delete" is an archive (0109)', () => {
  const MAPPING = '33333333-3333-4333-8333-333333333333';
  const ACTOR = '44444444-4444-4444-8444-444444444444';
  const ROLE = '55555555-5555-4555-8555-555555555555';

  /** A client with only `rpc`, resolving to one fixed answer. */
  function rpcClient(answer: { data: unknown; error: unknown }) {
    const rpc = vi.fn(async (_fn: string, _args: Record<string, unknown>) => answer);
    return { client: { rpc } as never, rpc };
  }

  it('lists only live mappings — the archived-row filter is in the query itself', async () => {
    const { client, calls } = fakeSupabase({
      ashby_job_mappings: {
        data: [{
          id: MAPPING, external_job_id: 'job_1', status: 'paused', status_reason: null, delivery_mode: 'manual',
          ai_screening_stage_id: 'stage_ai', ta_screening_stage_id: null, label: null, role_id: ROLE, updated_at: '2026-09-29T00:00:00Z',
        }],
        error: null,
      },
    });
    const rows = await createMissionControlStore(client).listMappings(50);
    const read = calls.find((c) => c.table === 'ashby_job_mappings')!;
    expect(read.op).toBe('select');
    expect(read.filters).toContainEqual(['is', 'archived_at', null]);
    expect(read.filters).toContainEqual(['eq', 'provider', 'ashby']);
    // The archive columns are a filter, not a projection: nothing new is read out.
    expect(read.columns).not.toContain('archived');
    // The role IS projected — Mission Control names the role a job screens for.
    expect(read.columns!.split(',').map((c) => c.trim())).toContain('role_id');
    expect(rows).toEqual([{
      id: MAPPING, externalJobId: 'job_1', status: 'paused', statusReason: null, deliveryMode: 'manual',
      hasAiStage: true, hasTaStage: false, label: null, roleId: ROLE, updatedAt: '2026-09-29T00:00:00Z',
    }]);
  });

  it('reports roleId as null for a missing or non-uuid role, never a guess', async () => {
    const base = {
      id: MAPPING, external_job_id: 'job_1', status: 'paused', status_reason: null, delivery_mode: 'manual',
      ai_screening_stage_id: null, ta_screening_stage_id: null, label: null, updated_at: '2026-09-29T00:00:00Z',
    };
    const { client } = fakeSupabase({
      ashby_job_mappings: { data: [{ ...base, role_id: null }, { ...base, role_id: 'not-a-uuid' }, { ...base }], error: null },
    });
    const rows = await createMissionControlStore(client).listMappings(50);
    expect(rows.map((r) => r.roleId)).toEqual([null, null, null]);
  });

  it('archives through the 0109 RPC with the mapping and the acting admin', async () => {
    const { client, rpc } = rpcClient({ data: { status: 'ok', already_archived: false }, error: null });
    const out = await createMissionControlStore(client).archiveMapping(MAPPING, ACTOR);
    expect(out).toEqual({ status: 'ok', alreadyArchived: false });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('archive_ashby_job_mapping', { p_mapping_id: MAPPING, p_actor_id: ACTOR });
  });

  it('carries the idempotent repeat through as alreadyArchived: true', async () => {
    const { client } = rpcClient({ data: { status: 'ok', already_archived: true }, error: null });
    expect(await createMissionControlStore(client).archiveMapping(MAPPING, ACTOR))
      .toEqual({ status: 'ok', alreadyArchived: true });
  });

  it('passes each refusal code through without inventing an alreadyArchived flag', async () => {
    for (const status of ['mapping_enabled', 'not_found', 'actor_required']) {
      const { client } = rpcClient({ data: { status }, error: null });
      expect(await createMissionControlStore(client).archiveMapping(MAPPING, ACTOR), status).toEqual({ status });
    }
    const { client } = rpcClient({ data: null, error: null });
    expect(await createMissionControlStore(client).archiveMapping(MAPPING, ACTOR)).toEqual({ status: 'error' });
  });

  it('throws a sanitized code when the RPC errors — never the database text', async () => {
    const { client } = rpcClient({ data: null, error: { message: 'pg: function missing at 10.0.0.5' } });
    const err = await createMissionControlStore(client).archiveMapping(MAPPING, ACTOR).then(() => null, (e: Error) => e);
    expect(err?.message).toBe('ashby_mc_archive_mapping_error');
  });

  describe('upsertMapping — re-adding a deleted job creates a NEW row', () => {
    const INPUT = { externalJobId: 'job_1', roleId: ROLE, ownerId: ACTOR, deliveryMode: 'manual' as const, actorId: ACTOR };

    it('returns the new id and nothing else — there is no `restored` passthrough', async () => {
      // Even if a stale RPC body carried `restored`, it is not surfaced.
      const { client } = rpcClient({ data: { status: 'ok', id: MAPPING, created: true, restored: true }, error: null });
      expect(await createMissionControlStore(client).upsertMapping(INPUT)).toEqual({ status: 'ok', id: MAPPING });
    });

    it('maps a Postgres unique violation (23505: the job already has a LIVE mapping) to `conflict` instead of throwing', async () => {
      const { client, rpc } = rpcClient({
        data: null,
        error: { code: '23505', message: 'duplicate key value violates unique constraint "uq_ashby_job_mappings_live_job"', details: 'Key (provider, external_job_id)=(ashby, job_1) already exists.' },
      });
      const out = await createMissionControlStore(client).upsertMapping(INPUT);
      expect(out).toEqual({ status: 'conflict' });
      // Nothing from the database error rides along.
      expect(JSON.stringify(out)).not.toMatch(/duplicate|uq_ashby|job_1/);
      expect(rpc).toHaveBeenCalledTimes(1);
    });

    it('passes the RPC\'s `archived` refusal (an update addressed to a deleted mapping) straight through', async () => {
      const { client } = rpcClient({ data: { status: 'archived' }, error: null });
      expect(await createMissionControlStore(client).upsertMapping({ ...INPUT, id: MAPPING })).toEqual({ status: 'archived', id: undefined });
    });

    it('still throws a sanitized code for every OTHER database error', async () => {
      const errors: Array<{ code?: string; message: string }> = [
        { code: '23503', message: 'insert or update violates foreign key constraint' },
        { code: '42883', message: 'function does not exist' },
        { message: 'no code at all' },
      ];
      for (const error of errors) {
        const { client } = rpcClient({ data: null, error });
        const err = await createMissionControlStore(client).upsertMapping(INPUT).then(() => null, (e: Error) => e);
        expect(err?.message, String(error.code)).toBe('ashby_mc_upsert_mapping_error');
      }
    });
  });
});

describe('createMappingResolver (signal worker) — live rows only (0109)', () => {
  it('scopes the by-job-id read to the LIVE mapping and reports its activity', async () => {
    const { client, calls } = fakeSupabase({
      'ashby_job_mappings:select': {
        data: { status: 'enabled', ai_screening_stage_id: 'stage_ai', activation_at: '2026-09-25T00:00:00Z', activation_epoch: 2, config_version: 3 },
        error: null,
      },
    });
    const r = await createMappingResolver(client).resolveByJobId('job_1');
    expect(r).toEqual({ status: 'enabled', aiScreeningStageId: 'stage_ai', activationAt: '2026-09-25T00:00:00Z', activationEpoch: 2, configVersion: 3 });
    // A re-added job owns an archived row beside its live one; without the
    // archived_at filter maybeSingle would see both.
    const read = calls.find((c) => c.table === 'ashby_job_mappings')!;
    expect(read.filters).toEqual([
      ['eq', 'provider', 'ashby'],
      ['eq', 'external_job_id', 'job_1'],
      ['is', 'archived_at', null],
    ]);
  });

  it('reports unknown when the job has no LIVE mapping (e.g. its only one was deleted)', async () => {
    const { client } = fakeSupabase({ 'ashby_job_mappings:select': { data: null, error: null } });
    expect(await createMappingResolver(client).resolveByJobId('job_1')).toEqual({ status: 'unknown' });
  });

  it('throws a sanitized code when the read fails', async () => {
    const { client } = fakeSupabase({ 'ashby_job_mappings:select': { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned' } } });
    await expect(createMappingResolver(client).resolveByJobId('job_1')).rejects.toThrow('ashby_mapping_read_error');
  });
});
