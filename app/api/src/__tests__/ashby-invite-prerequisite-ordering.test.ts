/**
 * Lane A regression suite — the live-canary ingestion/delivery ordering repair.
 *
 * Every test here maps to a defect that was live at `b92e590`:
 *
 *   A1  `fileInfo` validated an opaque provider FILE HANDLE with the generic id
 *       validator (256), so the canary's real 270-character handle was rejected
 *       pre-transport as `invalid_request/id_too_long` and ingestion never
 *       reached the network.
 *   A2  That deterministically permanent error was retried five times into the
 *       DLQ because nothing read `AshbyError.retriable`.
 *   A3  A failure before `queued -> fetching` could not reach `failed_review` at
 *       all (the 0029 trigger forbids it), so the durable row stayed `queued`
 *       forever; and an unresolvable presigned URL was reported as job SUCCESS.
 *   B1  The invite operation charged a WAIT against its FAILURE budget: five
 *       claims at a 5-second poll permanently failed the delivery ~25 seconds
 *       after import, on the HEALTHY path, while ingestion was still working.
 *   F-2 "Is this application resume-backed?" was answered by "does an ingestion
 *       row exist", which `runImport` makes always true.
 *   C1  The resume handle was captured only on link CREATION, never backfilled
 *       onto a reused link.
 *
 * Fully deterministic and synthetic: no network, no database, no timers.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AshbyClient,
  MAX_ID_LEN,
  MAX_FILE_HANDLE_LEN,
  extractResumeHandle,
  isPermanentAshbyFailure,
  ingestionFailureReason,
  buildAshbyHandlers,
  ASHBY_INGESTION_QUEUE,
  type AshbyTransport,
  type AshbyTransportResponse,
} from '../integrations/ashby/index.js';
import { AshbyError } from '../integrations/ashby/errors.js';
import {
  evaluateDegradation,
  DEGRADE_THRESHOLDS,
  type BacklogView,
  type SchedulerHealthView,
} from '../integrations/ashby/runtime-health.js';
import {
  runClaimedAshbyOperation,
  PREREQUISITE_DEFER_REASONS,
  DEFAULT_DEFER_SECONDS,
} from '../integrations/ashby/operation-worker.js';
import { runImport } from '../integrations/ashby/orchestration.js';
import type {
  WorkflowLinkRow,
  OperationClaimRow,
  WorkflowStores,
} from '../integrations/ashby/orchestration.js';
import type { MaterializationStore, MaterializationMapping } from '../integrations/ashby/materialize.js';

// ===========================================================================
// A1 - the file handle is a provider TOKEN, not an id
// ===========================================================================

function okTransport(body: unknown): AshbyTransport {
  return vi.fn(async (): Promise<AshbyTransportResponse> => ({
    status: 200, ok: true,
    headers: { get: () => null },
    text: async () => JSON.stringify({ success: true, results: body }),
  }));
}

function clientWith(transport: AshbyTransport): AshbyClient {
  return new AshbyClient({ apiKey: 'k', transport, sleep: async () => {}, random: () => 0.5 });
}

describe('A1 - dedicated file-handle validation', () => {
  it('accepts the LITERAL canary handle of exactly 270 characters and reaches the transport', async () => {
    const transport = okTransport({ url: 'https://files.example/r.pdf' });
    const handle = 'h'.repeat(270);
    await expect(clientWith(transport).fileInfo(handle)).resolves.toBeTruthy();
    expect(transport).toHaveBeenCalledTimes(1);
    // The handle travels in the BODY, never in the URL/query.
    const req = (transport as unknown as { mock: { calls: [{ url: string; body: string }][] } }).mock.calls[0][0];
    expect(req.url).not.toContain(handle);
    expect(JSON.parse(req.body).fileHandle).toBe(handle);
  });

  it.each([511, 512])('accepts a handle of length %i', async (len) => {
    const transport = okTransport({ url: 'https://files.example/r.pdf' });
    await expect(clientWith(transport).fileInfo('h'.repeat(len))).resolves.toBeTruthy();
  });

  it('rejects a 513-character handle pre-transport', async () => {
    const transport = okTransport({});
    await expect(clientWith(transport).fileInfo('h'.repeat(513)))
      .rejects.toMatchObject({ code: 'file_handle_too_long' });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    ['NUL', 'abc\u0000def'],
    ['a C0 control', 'abc\u0001def'],
    ['DEL', 'abc\u007Fdef'],
    ['a newline', 'abc\ndef'],
    ['a tab', 'abc\tdef'],
  ])('rejects a handle containing %s pre-transport', async (_label, handle) => {
    const transport = okTransport({});
    await expect(clientWith(transport).fileInfo(handle))
      .rejects.toMatchObject({ code: 'file_handle_control_char' });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    ['empty', ''],
    ['non-string', 42 as unknown as string],
    ['null', null as unknown as string],
  ])('rejects a %s handle pre-transport', async (_label, handle) => {
    const transport = okTransport({});
    await expect(clientWith(transport).fileInfo(handle))
      .rejects.toMatchObject({ code: 'invalid_file_handle' });
    expect(transport).not.toHaveBeenCalled();
  });

  // THE OVER-REACH GUARD. Giving the handle its own bound must never widen the
  // bound on a real identifier.
  it('leaves the id bound untouched - real ids still reject at 257', async () => {
    const transport = okTransport({});
    const client = clientWith(transport);
    const long = 'a'.repeat(MAX_ID_LEN + 1);
    await expect(client.applicationInfo(long)).rejects.toMatchObject({ code: 'id_too_long' });
    await expect(client.candidateInfo(long)).rejects.toMatchObject({ code: 'id_too_long' });
    await expect(client.applicationList({ cursor: long })).rejects.toMatchObject({ code: 'id_too_long' });
    await expect(client.applicationList({ syncToken: long })).rejects.toMatchObject({ code: 'id_too_long' });
    expect(MAX_ID_LEN).toBe(256);
    expect(transport).not.toHaveBeenCalled();
  });

  it('never leaks any fragment of the handle in the thrown error', async () => {
    const secret = 'SECRET_HANDLE_FRAGMENT_' + 'z'.repeat(600);
    let caught: AshbyError | null = null;
    try {
      await clientWith(okTransport({})).fileInfo(secret);
    } catch (err) {
      caught = err as AshbyError;
    }
    expect(caught).toBeTruthy();
    const serialized =
      JSON.stringify(caught!.toJSON()) + caught!.message + caught!.code + caught!.operation;
    expect(serialized).not.toContain('SECRET_HANDLE_FRAGMENT');
    expect(serialized).not.toContain('zzz');
  });

  // CROSS-LAYER CONSISTENCY. The drift between these three (256 / 512 / 512) is
  // the defect itself. One assertion keeps them from drifting apart again.
  it('the client bound, the extractor bound and the 0029 DB CHECK are all 512', () => {
    expect(MAX_FILE_HANDLE_LEN).toBe(512);
    expect(extractResumeHandle({ resumeFileHandle: 'h'.repeat(512) })).toHaveLength(512);
    expect(extractResumeHandle({ resumeFileHandle: 'h'.repeat(513) })).toBeNull();

    const sql = readFileSync(
      join(process.cwd(), '..', 'supabase', 'migrations', '0029_ashby_integration.sql'),
      'utf8',
    );
    const m = sql.match(
      /chk_ashby_application_links_resume_handle check \(external_resume_file_handle is null or length\(external_resume_file_handle\) between 1 and (\d+)\)/,
    );
    expect(m).toBeTruthy();
    expect(Number(m![1])).toBe(MAX_FILE_HANDLE_LEN);
  });

  it('extractResumeHandle rejects control characters as well as over-long values', () => {
    expect(extractResumeHandle({ resumeFileHandle: 'ok_handle' })).toBe('ok_handle');
    expect(extractResumeHandle({ resume: { fileHandle: { handle: 'nested' } } })).toBe('nested');
    expect(extractResumeHandle({ resumeFileHandle: 'bad\u0000handle' })).toBeNull();
    expect(extractResumeHandle({ resumeFileHandle: 'bad\u0007handle' })).toBeNull();
    expect(extractResumeHandle({ resumeFileHandle: '' })).toBeNull();
  });
});

// ===========================================================================
// A2 - a permanent provider error must not consume a retry budget
// ===========================================================================

describe('A2 - permanent vs transient error classification', () => {
  it.each(['invalid_request', 'http_client_error', 'logical_failure', 'malformed_response', 'output_limit'] as const)(
    'classifies %s as permanent',
    (category) => {
      expect(isPermanentAshbyFailure(new AshbyError(category, { code: 'x', operation: 'file.info' }))).toBe(true);
    },
  );

  it.each(['rate_limited', 'http_server_error', 'timeout', 'network', 'retry_exhausted'] as const)(
    'classifies %s as NOT permanent - the classification must not make everything permanent',
    (category) => {
      expect(isPermanentAshbyFailure(new AshbyError(category, { operation: 'file.info' }))).toBe(false);
    },
  );

  it('treats an explicitly retriable error as transient even in a permanent category', () => {
    expect(
      isPermanentAshbyFailure(new AshbyError('invalid_request', { operation: 'file.info', retriable: true })),
    ).toBe(false);
  });

  it('treats a non-Ashby throw as transient (fail open to the queue bound)', () => {
    expect(isPermanentAshbyFailure(new Error('boom'))).toBe(false);
  });

  it('produces a sanitized, bounded durable reason carrying no payload', () => {
    const reason = ingestionFailureReason(
      new AshbyError('invalid_request', { code: 'file_handle_too_long', operation: 'file.info' }),
    );
    expect(reason).toBe('fetch_invalid_request_file_handle_too_long');
    expect(reason.length).toBeLessThanOrEqual(200);
    expect(ingestionFailureReason(new Error('with a secret inside'))).toBe('fetch_provider_error');
  });
});

// ===========================================================================
// A3 - the ingestion handler leaves a durable, truthful state
// ===========================================================================

interface FakeWorld {
  link: WorkflowLinkRow;
  ingestion: { state: string; attempts: number } | null;
  transitions: Array<{ state: string; reason?: string }>;
}

function baseLink(over: Partial<WorkflowLinkRow> = {}): WorkflowLinkRow {
  return {
    id: 'link_1', externalApplicationId: 'app_1', externalJobId: 'job_1',
    externalResumeFileHandle: 'handle_1', jobMappingId: 'map_1',
    candidateId: null, sessionId: null, inviteId: null,
    lifecycle: 'imported', terminalState: null, ...over,
  };
}

function ingestionRuntime(world: FakeWorld, buildIngestionPorts: unknown) {
  return {
    stores: {
      readLink: async () => world.link,
      readIngestion: async () => world.ingestion,
      advanceIngestion: async (_id: string, state: string, prov?: { failedReason?: string }) => {
        world.transitions.push({ state, reason: prov?.failedReason });
        world.ingestion = { state, attempts: world.ingestion?.attempts ?? 0 };
        return { status: 'ok' };
      },
    },
    buildIngestionPorts,
    resolveMappingForLink: async () => null,
    materialization: {} as MaterializationStore,
  } as never;
}

const ingestionJob = (attempts = 1, maxAttempts = 5) =>
  ({
    name: ASHBY_INGESTION_QUEUE,
    payload: { applicationLinkId: 'link_1' },
    attempts,
    maxAttempts,
  }) as never;

describe('A3 - a provider failure reaches failed_review instead of stranding queued', () => {
  it('leaves queued BEFORE the provider call so failed_review is reachable at all', async () => {
    const world: FakeWorld = { link: baseLink(), ingestion: { state: 'queued', attempts: 0 }, transitions: [] };
    const build = vi.fn(async () => ({ status: 'url_unresolved' as const }));
    const handlers = buildAshbyHandlers(ingestionRuntime(world, build));
    await handlers[ASHBY_INGESTION_QUEUE](ingestionJob());
    // Ordering is the whole point: `fetching` first, and only then the provider.
    expect(world.transitions[0]).toMatchObject({ state: 'fetching' });
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('a PERMANENT fileInfo failure fails the job ONCE and records failed_review', async () => {
    const world: FakeWorld = { link: baseLink(), ingestion: { state: 'queued', attempts: 0 }, transitions: [] };
    const build = vi.fn(async () => {
      throw new AshbyError('invalid_request', { code: 'file_handle_too_long', operation: 'file.info' });
    });
    const handlers = buildAshbyHandlers(ingestionRuntime(world, build));
    // It RESOLVES - a permanent error must not be thrown back into the queue's
    // generic retry path, which is what burned five attempts into the DLQ.
    await expect(handlers[ASHBY_INGESTION_QUEUE](ingestionJob())).resolves.toBeUndefined();
    expect(world.ingestion).toMatchObject({ state: 'failed_review' });
    expect(world.transitions.map((t) => t.state)).toEqual(['fetching', 'failed_review']);
    expect(world.transitions[1].reason).toBe('fetch_invalid_request_file_handle_too_long');
  });

  it('a TRANSIENT fileInfo failure still throws so the queue retries', async () => {
    const world: FakeWorld = { link: baseLink(), ingestion: { state: 'queued', attempts: 0 }, transitions: [] };
    const build = vi.fn(async () => {
      throw new AshbyError('http_server_error', { operation: 'file.info' });
    });
    const handlers = buildAshbyHandlers(ingestionRuntime(world, build));
    await expect(handlers[ASHBY_INGESTION_QUEUE](ingestionJob(1, 5))).rejects.toBeTruthy();
    // Mid-flight, not stranded terminal: further attempts are still expected.
    expect(world.ingestion).toMatchObject({ state: 'fetching' });
  });

  it('a TRANSIENT failure on the LAST attempt records failed_review before dead-lettering', async () => {
    const world: FakeWorld = { link: baseLink(), ingestion: { state: 'queued', attempts: 0 }, transitions: [] };
    const build = vi.fn(async () => {
      throw new AshbyError('http_server_error', { operation: 'file.info' });
    });
    const handlers = buildAshbyHandlers(ingestionRuntime(world, build));
    await expect(handlers[ASHBY_INGESTION_QUEUE](ingestionJob(5, 5))).rejects.toBeTruthy();
    // A dead-lettered job can never leave the ingestion row stranded.
    expect(world.ingestion).toMatchObject({ state: 'failed_review' });
  });

  it('an unresolvable presigned URL records failed_review instead of reporting success', async () => {
    const world: FakeWorld = { link: baseLink(), ingestion: { state: 'queued', attempts: 0 }, transitions: [] };
    const build = vi.fn(async () => ({ status: 'url_unresolved' as const }));
    const handlers = buildAshbyHandlers(ingestionRuntime(world, build));
    await handlers[ASHBY_INGESTION_QUEUE](ingestionJob());
    expect(world.ingestion).toMatchObject({ state: 'failed_review' });
    expect(world.transitions[1].reason).toBe('fetch_url_unresolved');
  });

  // The distinction that must survive the fix: "no resume to fetch" is not
  // "failed to fetch the resume".
  it('a genuinely absent handle is a no-op - no fetching, no failed_review', async () => {
    const world: FakeWorld = {
      link: baseLink({ externalResumeFileHandle: null }),
      ingestion: { state: 'queued', attempts: 0 },
      transitions: [],
    };
    const build = vi.fn(async () => ({ status: 'no_resume' as const }));
    const handlers = buildAshbyHandlers(ingestionRuntime(world, build));
    await handlers[ASHBY_INGESTION_QUEUE](ingestionJob());
    expect(world.transitions).toEqual([]);
    expect(world.ingestion).toMatchObject({ state: 'queued' });
    // It must not even resolve a presigned URL.
    expect(build).not.toHaveBeenCalled();
  });

  it('a terminal link is still a no-op with zero provider calls', async () => {
    const world: FakeWorld = {
      link: baseLink({ terminalState: 'withdrawn' }),
      ingestion: { state: 'queued', attempts: 0 },
      transitions: [],
    };
    const build = vi.fn(async () => ({ status: 'no_resume' as const }));
    const handlers = buildAshbyHandlers(ingestionRuntime(world, build));
    await handlers[ASHBY_INGESTION_QUEUE](ingestionJob());
    expect(world.transitions).toEqual([]);
    expect(build).not.toHaveBeenCalled();
  });

  it('an already-ready ingestion is never re-fetched', async () => {
    const world: FakeWorld = { link: baseLink(), ingestion: { state: 'ready', attempts: 1 }, transitions: [] };
    const build = vi.fn(async () => ({ status: 'no_resume' as const }));
    const handlers = buildAshbyHandlers(ingestionRuntime(world, build));
    await handlers[ASHBY_INGESTION_QUEUE](ingestionJob());
    expect(world.transitions).toEqual([]);
    expect(build).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// B1 - a wait is not a failure (the single most important regression)
// ===========================================================================

const CLAIM: OperationClaimRow = {
  id: 'op_1',
  operationType: 'invite_delivery',
  operationKey: 'ashby:invite:manual:app_1:pending',
  applicationLinkId: 'link_1',
  leaseToken: 'lease_1',
  attempts: 1,
  maxAttempts: 5,
  marker: null,
};

const MAPPING: MaterializationMapping = {
  id: 'map_1',
  roleId: '11111111-1111-4111-8111-111111111111',
  ownerId: '22222222-2222-4222-8222-222222222222',
  deliveryMode: 'manual',
};

function operationDeps(over: Record<string, unknown> = {}) {
  let n = 0;
  // `stores` is merged field-by-field above, so it must NOT be re-applied by
  // the trailing spread — that would drop every default (claimOperation first).
  const { stores: _storesOverride, ...rest } = over;
  return {
    stores: {
      claimOperation: async () => CLAIM,
      readLink: async () => baseLink({ candidateId: 'cand_1' }),
      readIngestion: async () => ({ state: 'ready', attempts: 0 }),
      failOperation: async () => ({ outcome: 'retry' as const }),
      deferOperation: async () => 'ok' as const,
      completeOperation: async () => 'ok' as const,
      parkOperationAwaitingDelivery: async () => 'ok' as const,
      ...((over.stores as Record<string, unknown>) ?? {}),
    },
    materialization: {
      insertResume: async () => ({ id: `r${++n}` }),
      insertCandidate: async () => ({ id: `c${++n}` }),
      bindLinkColumn: async (i: { value: string }) => ({ bound: i.value, wonRace: true }),
      deleteOrphan: async () => {},
      createSession: async () => ({ id: `s${++n}` }),
      findActiveInvite: async () => null,
      insertInvite: async () => ({ id: `i${++n}` }),
    },
    resolveMappingForLink: async () => MAPPING,
    reissuePathFor: (a: string) => `/ashby-mission-control?application=${a}`,
    email: { providerApproved: false, domainVerified: false },
    owner: 'test-worker',
    leaseSeconds: 60,
    ...rest,
  } as never;
}

describe('B1 - an unfinished ingestion never consumes the delivery budget', () => {
  /**
   * THE ASSERTION THAT WOULD HAVE CAUGHT THE CANARY. An ingestion that is
   * legitimately working for far longer than five poll intervals must leave the
   * operation's failure budget untouched, and must never fail it. At the
   * default 5s operation poll, 120 polls is ten minutes of simulated time -
   * roughly twenty-four times the window in which the old code gave up.
   */
  it('120 consecutive polls against a queued ingestion produce ZERO failures', async () => {
    const fail = vi.fn(async () => ({ outcome: 'retry' as const }));
    // Parameters are declared so the recorded calls are a typed 4-tuple: the
    // delay argument is asserted below, and a zero-arg mock records `[]`.
    const defer = vi.fn(
      async (_id: string, _lease: string, _reason: string, _delaySeconds: number) => 'ok' as const,
    );
    for (let i = 0; i < 120; i++) {
      const r = await runClaimedAshbyOperation(
        operationDeps({
          stores: {
            readIngestion: async () => ({ state: 'queued', attempts: 0 }),
            failOperation: fail,
            deferOperation: defer,
          },
        }),
      );
      expect(r).toMatchObject({ claimed: true, committed: false, code: 'ingestion_not_ready' });
    }
    expect(fail).not.toHaveBeenCalled();
    expect(defer).toHaveBeenCalledTimes(120);
    // Every deferral carries a bounded delay - a deferral loop must not be a
    // hot loop, which is the other half of "cannot spin".
    for (const call of defer.mock.calls) {
      expect(call[3]).toBe(DEFAULT_DEFER_SECONDS);
      expect(call[3]).toBeGreaterThan(0);
    }
  });

  it.each(['queued', 'fetching', 'scanning', 'extracting', 'structuring', 'failed_review', 'cancelled'])(
    'defers rather than fails while the ingestion is %s',
    async (state) => {
      const fail = vi.fn(async () => ({ outcome: 'retry' as const }));
      const defer = vi.fn(async () => 'ok' as const);
      const r = await runClaimedAshbyOperation(
        operationDeps({
          stores: {
            readIngestion: async () => ({ state, attempts: 0 }),
            failOperation: fail,
            deferOperation: defer,
          },
        }),
      );
      expect(r).toMatchObject({ code: 'ingestion_not_ready' });
      expect(fail).not.toHaveBeenCalled();
      expect(defer).toHaveBeenCalledTimes(1);
    },
  );

  it('a failed_review ingestion never produces an invite', async () => {
    const park = vi.fn(async () => 'ok' as const);
    const r = await runClaimedAshbyOperation(
      operationDeps({
        stores: {
          readIngestion: async () => ({ state: 'failed_review', attempts: 5 }),
          parkOperationAwaitingDelivery: park,
        },
      }),
    );
    expect(r).toMatchObject({ code: 'ingestion_not_ready' });
    expect(park).not.toHaveBeenCalled();
  });

  it('the instant ingestion reaches ready, exactly ONE claim parks the manual invite', async () => {
    const park = vi.fn(async () => 'ok' as const);
    const defer = vi.fn(async () => 'ok' as const);
    const r = await runClaimedAshbyOperation(
      operationDeps({ stores: { parkOperationAwaitingDelivery: park, deferOperation: defer } }),
    );
    // `awaiting_manual_delivery`, never `succeeded`: succeeded means an
    // authorized human took possession of a usable link.
    expect(r).toMatchObject({ claimed: true, committed: true, code: 'awaiting_manual_delivery' });
    expect(park).toHaveBeenCalledTimes(1);
    expect(defer).not.toHaveBeenCalled();
  });

  it('a paused mapping defers indefinitely and resuming it lets delivery proceed', async () => {
    const fail = vi.fn(async () => ({ outcome: 'retry' as const }));
    const defer = vi.fn(async () => 'ok' as const);
    const park = vi.fn(async () => 'ok' as const);
    let enabled = false;
    const deps = () =>
      operationDeps({
        resolveMappingForLink: async () => (enabled ? MAPPING : null),
        stores: { failOperation: fail, deferOperation: defer, parkOperationAwaitingDelivery: park },
      });
    // Far longer than the five polls that used to kill it.
    for (let i = 0; i < 30; i++) {
      expect(await runClaimedAshbyOperation(deps())).toMatchObject({ code: 'mapping_inactive' });
    }
    expect(fail).not.toHaveBeenCalled();
    expect(park).not.toHaveBeenCalled();
    enabled = true;
    expect(await runClaimedAshbyOperation(deps())).toMatchObject({ code: 'awaiting_manual_delivery' });
    expect(park).toHaveBeenCalledTimes(1);
  });

  it('the deferral allowlist covers exactly the prerequisite reasons', () => {
    expect([...PREREQUISITE_DEFER_REASONS].sort()).toEqual(['ingestion_not_ready', 'mapping_inactive']);
    // Genuine faults in work this operation owns stay attempt-bounded.
    expect(PREREQUISITE_DEFER_REASONS.has('candidate_missing')).toBe(false);
    expect(PREREQUISITE_DEFER_REASONS.has('persist_failed')).toBe(false);
    expect(PREREQUISITE_DEFER_REASONS.has('blocked_provider')).toBe(false);
  });

  it('a terminal application still fails NON-retryably - deferral did not soften it', async () => {
    const fail = vi.fn(async () => ({ outcome: 'failed' as const }));
    const defer = vi.fn(async () => 'ok' as const);
    const r = await runClaimedAshbyOperation(
      operationDeps({
        stores: {
          readLink: async () => baseLink({ terminalState: 'withdrawn' }),
          failOperation: fail,
          deferOperation: defer,
        },
      }),
    );
    expect(r).toMatchObject({ code: 'blocked_terminal' });
    expect(fail).toHaveBeenCalledWith('op_1', 'lease_1', 'terminal_cancel', false);
    expect(defer).not.toHaveBeenCalled();
  });

  it('a stale lease on the deferral path is reported, not swallowed', async () => {
    const r = await runClaimedAshbyOperation(
      operationDeps({
        stores: {
          readIngestion: async () => ({ state: 'queued', attempts: 0 }),
          deferOperation: async () => 'not_owned' as const,
        },
      }),
    );
    expect(r).toMatchObject({ claimed: true, staleLease: true, code: 'ingestion_not_ready' });
  });
});

// ===========================================================================
// C1 - the resume handle is backfilled onto a REUSED link
// ===========================================================================

describe('C1 - handle backfill on link reuse', () => {
  function importStores(existingHandle: string | null, bind?: unknown): WorkflowStores {
    return {
      findLinkByApplicationId: async () => ({
        id: 'link_1',
        externalApplicationId: 'app_1',
        terminalState: null,
        externalResumeFileHandle: existingHandle,
      }),
      createLink: async () => ({ id: 'link_new' }),
      advanceIngestion: async () => ({ status: 'ok' }),
      enqueueOperation: async () => ({ status: 'inserted', id: 'op_1' }),
      completeOperation: async () => 'ok',
      failOperation: async () => ({ outcome: 'retry' }),
      bindLinkResumeHandle: bind as never,
    } as unknown as WorkflowStores;
  }

  const importDeps = (stores: WorkflowStores) => ({
    gates: { enabled: true, email: { providerApproved: false, domainVerified: false } },
    client: {
      applicationInfo: async () => ({
        results: {
          id: 'app_1',
          job: { id: 'job_1' },
          currentInterviewStage: { id: 'stage_ai' },
          resumeFileHandle: 'fresh_handle',
        },
        moreDataAvailable: false,
      }),
    },
    stores,
    resolveMapping: async () => ({
      status: 'enabled' as const,
      aiScreeningStageId: 'stage_ai',
      id: 'map_1',
      deliveryMode: 'manual' as const,
    }),
    readResumeFileHandle: (info: unknown) => extractResumeHandle(info),
  });

  it('backfills the handle when the reused link has none', async () => {
    const bind = vi.fn(async () => {});
    const r = await runImport('app_1', importDeps(importStores(null, bind)) as never);
    expect(r.status).toBe('imported');
    expect(bind).toHaveBeenCalledWith('link_1', 'fresh_handle');
  });

  it('never overwrites a handle the reused link already carries', async () => {
    const bind = vi.fn(async () => {});
    await runImport('app_1', importDeps(importStores('stored_handle', bind)) as never);
    expect(bind).not.toHaveBeenCalled();
  });

  it('is a no-op when the store does not implement the backfill seam', async () => {
    const r = await runImport('app_1', importDeps(importStores(null, undefined)) as never);
    expect(r.status).toBe('imported');
  });
});

// ===========================================================================
// O-1 - a permanently blocked invite must be a VERDICT, not just a counter
// ===========================================================================

// The ordering repair traded a wrong-but-loud signal for a right-but-quiet one:
// before it, a resume-backed link whose ingestion ended `failed_review` surfaced
// (incorrectly) as `operationsFailed` within ~25 seconds. Being recoverable
// instead of budget-burnt is the improvement. Being SILENT would not be — the
// 0029 trigger lets `failed_review` go only to `queued` or `cancelled`, and
// nothing in the runtime does either, so that invite waits until a human acts.

function backlog(over: Partial<BacklogView> = {}): BacklogView {
  return {
    queuePending: 0, dlqDepth: 0, oldestPendingAgeSec: null,
    operationsPending: 0, operationsFailed: 0, operationsAwaitingDelivery: 0,
    operationsBlockedPrerequisite: 0, operationsBlockedFailedIngestion: 0,
    operationsFailedPrerequisite: 0,
    ingestionStuckQueued: 0, ingestionStuckFetching: 0,
    writebackPending: 0, reconcileNoProgressRuns: 0, reconcileLastSuccessAt: null,
    ...over,
  };
}

const LIVE_SCHEDULER: SchedulerHealthView = {
  registeredInThisProcess: false, running: false, loops: [],
};

describe('O-1 - blocked-forever is degraded, blocked-for-now is not', () => {
  it('a TRANSIENTLY blocked invite is healthy — waiting is correct behaviour', () => {
    const v = evaluateDegradation({
      active: true, scheduler: LIVE_SCHEDULER,
      backlog: backlog({ operationsPending: 3, operationsBlockedPrerequisite: 3 }),
    });
    expect(v.status).toBe('healthy');
    expect(v.reasons).toEqual([]);
  });

  it('an invite blocked behind a failed_review ingestion DEGRADES', () => {
    const v = evaluateDegradation({
      active: true, scheduler: LIVE_SCHEDULER,
      backlog: backlog({
        operationsPending: 3,
        operationsBlockedPrerequisite: 3,
        operationsBlockedFailedIngestion: 1,
      }),
    });
    expect(v.status).toBe('degraded');
    expect(v.reasons).toContain('invite_blocked_failed_ingestion');
  });

  it('one blocked invite is already enough — this never needs to pile up', () => {
    expect(DEGRADE_THRESHOLDS.operationsBlockedFailedIngestion).toBe(1);
  });

  it('the permanent count is a SUBSET, so it never contradicts the total', () => {
    const b = backlog({ operationsBlockedPrerequisite: 5, operationsBlockedFailedIngestion: 2 });
    expect(b.operationsBlockedFailedIngestion).toBeLessThanOrEqual(b.operationsBlockedPrerequisite);
    // "Transiently waiting" is the difference, computed by the consumer rather
    // than handed over pre-baked.
    expect(b.operationsBlockedPrerequisite - b.operationsBlockedFailedIngestion).toBe(3);
  });

  it('stuck ingestion and blocked invite are INDEPENDENT signals', () => {
    // A failed_review ingestion is not "stuck" — it reached a durable verdict.
    // Reporting only `ingestion_stuck` would miss it entirely.
    const v = evaluateDegradation({
      active: true, scheduler: LIVE_SCHEDULER,
      backlog: backlog({ operationsBlockedFailedIngestion: 1 }),
    });
    expect(v.reasons).toContain('invite_blocked_failed_ingestion');
    expect(v.reasons).not.toContain('ingestion_stuck');
  });

  it('a disabled integration is idle, not degraded, however blocked it looks', () => {
    const v = evaluateDegradation({
      active: false, scheduler: LIVE_SCHEDULER,
      backlog: backlog({ operationsBlockedFailedIngestion: 9 }),
    });
    expect(v.status).toBe('idle');
    expect(v.reasons).toEqual([]);
  });
});
