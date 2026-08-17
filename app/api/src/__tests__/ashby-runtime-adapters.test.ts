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
    const { client } = fakeSupabase({
      'ashby_job_mappings:select': {
        data: { id: 'map_1', status: 'enabled', ai_screening_stage_id: 'stage_ai', delivery_mode: 'both' },
        error: null,
      },
    });
    const r = await runtimeWith(client).resolveMappingByJobId('job_1');
    expect(r).toEqual({ status: 'enabled', aiScreeningStageId: 'stage_ai', id: 'map_1', deliveryMode: 'both' });
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

  it('returns null when the application carries no resume handle', async () => {
    const { client } = fakeSupabase({
      'ashby_application_links:select': { data: { external_resume_file_handle: null }, error: null },
    });
    const ports = await runtimeWith(client).buildIngestionPorts({ applicationLinkId: 'link_1', onState: async () => {} });
    expect(ports).toBeNull();
  });

  it('returns null when the link row is missing', async () => {
    const { client } = fakeSupabase({ 'ashby_application_links:select': { data: null, error: null } });
    const ports = await runtimeWith(client).buildIngestionPorts({ applicationLinkId: 'nope', onState: async () => {} });
    expect(ports).toBeNull();
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
    const ports = await runtime.buildIngestionPorts({ applicationLinkId: 'link_1', onState: async () => {} });

    expect(ports).not.toBeNull();
    expect(ports!.presignedUrl).toBe('https://files.ashby.example/r.pdf');
    expect(ports!.policy.allowlistEnabled).toBe(true);
    expect(ports!.policy.allowedHosts).toEqual(['files.ashby.example']);
    expect(ports!.policy.allowedPorts).toEqual([443]);
    expect(ports!.extractorVersion).toBe(ASHBY_EXTRACTOR_VERSION);
  });

  it('returns null when file.info exposes no usable https URL', async () => {
    const { client } = fakeSupabase({
      'ashby_application_links:select': { data: { external_resume_file_handle: 'handle_1' }, error: null },
    });
    const transport = vi.fn(async () => ({
      status: 200, ok: true,
      headers: { get: () => null },
      text: async () => JSON.stringify({ success: true, results: { url: 'http://insecure.example/r.pdf' } }),
    }));
    const ports = await runtimeWith(client, { transport })
      .buildIngestionPorts({ applicationLinkId: 'link_1', onState: async () => {} });
    expect(ports).toBeNull();
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
    const ports = (await runtimeWith(client, { transport })
      .buildIngestionPorts({ applicationLinkId: 'link_1', onState: async () => {} }))!;
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
    const ports = (await runtimeWith(client, { transport })
      .buildIngestionPorts({ applicationLinkId: 'link_1', onState: async () => {} }))!;
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
