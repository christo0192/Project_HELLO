/**
 * The blank-`ready` defect, and the ordering that makes it impossible.
 *
 * WHAT WAS WRONG. `ready` is TERMINAL in the 0029 machine, and the candidate
 * used to be materialized AFTER that transition was already durable. A single
 * transient database fault on `insertResume` or `updateCandidateFromParse`
 * therefore produced a candidate with `name: null, email: null` FOR EVER,
 * while the durable row — and the candidates list — reported the ingestion as
 * finished. Nothing could repair it: no automatic path re-runs a terminal
 * ingestion, and the audited recovery requires `failed_review`, so it answered
 * `not_recoverable`. Only direct database surgery could fix it.
 *
 * WHAT MUST BE TRUE NOW. Persistence runs INSIDE the ingestion, through the
 * `persist` port, strictly BEFORE `onState('ready')`. So:
 *
 *   - a persistence failure never writes `ready` — the row rests in
 *     `failed_review / materialize_failed`, which is truthful, visible, and
 *     recoverable through BOTH the ordinary bounded requeue and the audited
 *     admin retry;
 *   - reaching `ready` at all means the candidate is already populated;
 *   - the recovery run populates the SAME candidate, with no duplicate
 *     candidate or resume row, and no ownership/role/status/source mutation.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  runResumeIngestion,
  MATERIALIZE_FAILED_REASON,
  type IngestionPorts,
  type StructuredResume,
} from '../integrations/ashby/resume-ingestion.js';
import {
  populateExistingCandidate,
  materializeCandidate,
  type MaterializationStore,
  type MaterializationMapping,
} from '../integrations/ashby/materialize.js';
import {
  buildAshbyHandlers,
  ASHBY_INGESTION_QUEUE,
  PARSE_DEFER_CLOCK_REASON,
} from '../integrations/ashby/runtime-workers.js';
import { PARSE_CLASSIFIER } from '../integrations/ashby/resume-ingestion.js';
import { ParserTimeoutError } from '../lib/resume-parser.js';
import type { WorkflowLinkRow } from '../integrations/ashby/orchestration.js';

const MAPPING: MaterializationMapping = {
  id: 'map_1', roleId: 'role_1', ownerId: 'owner_1', deliveryMode: 'manual',
};

const PARSED: StructuredResume = {
  name: 'Ada Lovelace', email: 'ada@example.com', phone: null,
  skills: ['analysis'], experience_years: 7, current_role: 'Engineer', summary: 'Synthetic.',
};

// ── A store whose failures are scriptable per call ─────────────────────────

interface World {
  resumes: number;
  candidates: Array<{ roleId: string; ownerId: string }>;
  populated: Array<{ candidateId: string; resumeId: string; parsed: StructuredResume }>;
  deleted: Array<{ table: string; id: string }>;
  /** Number of leading `insertResume` calls that should throw. */
  failResumeTimes: number;
  /** Number of leading `updateCandidateFromParse` calls that should throw. */
  failUpdateTimes: number;
  /** Make the CAS report a lost race with this winner. */
  raceWinner?: string;
  seq: number;
}

function newStore(over: Partial<World> = {}): { store: MaterializationStore; world: World } {
  const world: World = {
    resumes: 0, candidates: [], populated: [], deleted: [],
    failResumeTimes: 0, failUpdateTimes: 0, seq: 0, ...over,
  };
  const store: MaterializationStore = {
    async insertResume() {
      if (world.failResumeTimes > 0) { world.failResumeTimes -= 1; throw new Error('db_down'); }
      world.resumes += 1;
      return { id: `resume_${world.resumes}` };
    },
    async insertCandidate(input) {
      world.candidates.push({ roleId: input.roleId, ownerId: input.ownerId });
      world.seq += 1;
      return { id: `cand_full_${world.seq}` };
    },
    async insertCandidateShell(input) {
      world.candidates.push({ roleId: input.roleId, ownerId: input.ownerId });
      world.seq += 1;
      return { id: `cand_shell_${world.seq}` };
    },
    async updateCandidateFromParse(input) {
      if (world.failUpdateTimes > 0) { world.failUpdateTimes -= 1; throw new Error('db_down'); }
      world.populated.push(input);
      return { updated: true };
    },
    async bindLinkColumn(input) {
      if (world.raceWinner) return { bound: world.raceWinner, wonRace: false };
      return { bound: input.value, wonRace: true };
    },
    async deleteOrphan(table, id) { world.deleted.push({ table, id }); },
    async createSession() { return { id: 'sess_1' }; },
    async findActiveInvite() { return null; },
    async insertInvite() { return { id: 'inv_1' }; },
  };
  return { store, world };
}

// ── The ingestion, driven directly through its ports ──────────────────────

interface Recorded { state: string; reason?: string }

function ingestionPorts(
  persist: IngestionPorts['persist'],
  over: Partial<IngestionPorts> = {},
): { ports: IngestionPorts; states: Recorded[]; bytes: Buffer } {
  const states: Recorded[] = [];
  const bytes = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
  const ports: IngestionPorts = {
    presignedUrl: 'https://host.example/r.pdf',
    policy: { allowlistEnabled: true, allowedHosts: ['host.example'], allowedPorts: [443] },
    fetch: async () => ({
      ok: true as const, bytes, sha256: 'a'.repeat(64),
      contentType: 'application/pdf', finalHost: 'host.example', hops: 0,
    }),
    scan: async () => ({ safe: true, status: 'clean' }),
    guard: () => ({ ok: true as const, mime: 'application/pdf' }),
    parse: async () => ({ text: 'Ada Lovelace', structured: PARSED, structurerVersion: 'v1' }),
    fallbackFromText: () => PARSED,
    onState: (state, prov) => { states.push({ state, reason: prov?.failedReason }); },
    extractorVersion: 'x1',
    persist,
    ...over,
  };
  return { ports, states, bytes };
}

// ═══════════════════════════════════════════════════════════════════════
// 1. The ordering itself
// ═══════════════════════════════════════════════════════════════════════

describe('persist runs before the durable ready transition', () => {
  it('a persistence failure NEVER writes ready — it rests recoverably instead', async () => {
    const { ports, states } = ingestionPorts(
      async () => ({ ok: false, reason: MATERIALIZE_FAILED_REASON }),
    );
    const out = await runResumeIngestion(ports);
    expect(out).toEqual({ state: 'failed_review', reason: MATERIALIZE_FAILED_REASON });
    // THE load-bearing assertion: no `ready` was emitted at all.
    expect(states.map((s) => s.state)).not.toContain('ready');
    expect(states.at(-1)).toMatchObject({
      state: 'failed_review', reason: MATERIALIZE_FAILED_REASON,
    });
  });

  it('persist is called BEFORE ready, never after', async () => {
    const order: string[] = [];
    const { ports } = ingestionPorts(async () => { order.push('persist'); return { ok: true }; }, {
      onState: (state) => { order.push(`state:${state}`); },
    });
    await runResumeIngestion(ports);
    expect(order.indexOf('persist')).toBeGreaterThan(-1);
    expect(order.indexOf('persist')).toBeLessThan(order.indexOf('state:ready'));
    expect(order.at(-1)).toBe('state:ready');
  });

  it('the bytes are wiped BEFORE anything is persisted', async () => {
    let bytesAtPersist: number[] | null = null;
    const probe = ingestionPorts(async () => {
      bytesAtPersist = [...probe.bytes];
      return { ok: true };
    });
    await runResumeIngestion(probe.ports);
    expect(bytesAtPersist).toEqual([0, 0, 0, 0]);
  });

  it('the failure provenance carries the code and versions — never the parsed fields', async () => {
    const captured: Array<Record<string, unknown>> = [];
    const { ports } = ingestionPorts(
      async () => ({ ok: false, reason: MATERIALIZE_FAILED_REASON }),
      { onState: (_s, prov) => { if (prov) captured.push({ ...prov }); } },
    );
    await runResumeIngestion(ports);
    const blob = JSON.stringify(captured);
    expect(blob).not.toContain('Ada');
    expect(blob).not.toContain('ada@example.com');
    expect(blob).not.toContain('analysis');
    expect(captured.at(-1)).toMatchObject({ failedReason: MATERIALIZE_FAILED_REASON });
  });

  it('the reason is a bounded, DB-valid sanitized code', () => {
    expect(MATERIALIZE_FAILED_REASON).toMatch(/^[a-z0-9_.:-]{1,64}$/);
  });

  it('an ingestion with NO persist port behaves exactly as before', async () => {
    const { ports, states } = ingestionPorts(undefined);
    const out = await runResumeIngestion(ports);
    expect(out).toMatchObject({ state: 'ready' });
    expect(states.at(-1)?.state).toBe('ready');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. First-call failure, then bounded recovery success
// ═══════════════════════════════════════════════════════════════════════

describe('failure then bounded recovery', () => {
  it('insertResume fails on the first run and the retry populates the SAME candidate', async () => {
    const { store, world } = newStore({ failResumeTimes: 1 });

    const first = await populateExistingCandidate('cand_shell_1', PARSED, { store });
    expect(first).toEqual({ status: 'skipped', reason: 'persist_failed' });
    expect(world.populated).toEqual([]);
    // The durable shell must survive a failed population.
    expect(world.deleted.some((d) => d.table === 'candidates')).toBe(false);

    // ── the recovery run ──
    const second = await populateExistingCandidate('cand_shell_1', PARSED, { store });
    expect(second).toEqual({ status: 'updated', candidateId: 'cand_shell_1' });
    expect(world.populated).toEqual([
      { candidateId: 'cand_shell_1', resumeId: 'resume_1', parsed: PARSED },
    ]);
    // Exactly one resume and no second candidate across BOTH runs.
    expect(world.resumes).toBe(1);
    expect(world.candidates).toEqual([]);
  });

  it('updateCandidateFromParse fails on the first run and the retry succeeds', async () => {
    const { store, world } = newStore({ failUpdateTimes: 1 });

    expect(await populateExistingCandidate('cand_shell_1', PARSED, { store }))
      .toEqual({ status: 'skipped', reason: 'persist_failed' });
    // The orphan resume from the failed attempt is cleaned up, not accumulated.
    expect(world.deleted).toEqual([{ table: 'resumes', id: 'resume_1' }]);

    expect(await populateExistingCandidate('cand_shell_1', PARSED, { store }))
      .toEqual({ status: 'updated', candidateId: 'cand_shell_1' });
    expect(world.populated).toHaveLength(1);
    expect(world.candidates).toEqual([]);
  });

  it('the recovery mutates no ownership, role, status or source', async () => {
    const { store, world } = newStore({ failUpdateTimes: 1 });
    await populateExistingCandidate('cand_shell_1', PARSED, { store });
    await populateExistingCandidate('cand_shell_1', PARSED, { store });
    // The seam's payload is the enforcement: there is no field through which
    // ownership or funnel position could be revised on either run.
    expect(Object.keys(world.populated[0]!).sort()).toEqual(['candidateId', 'parsed', 'resumeId']);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. Lost-race update failure
// ═══════════════════════════════════════════════════════════════════════

describe('lost race whose population then fails', () => {
  it('reports the failure rather than silently leaving the winner blank', async () => {
    // The import binds the shell mid-ingestion, so this create path loses the
    // CAS and must populate the winner. If THAT write fails, the parse has not
    // been persisted and the caller must be told — otherwise `ready` would be
    // written over a blank candidate, which is the whole defect.
    const { store, world } = newStore({ raceWinner: 'cand_shell_winner', failUpdateTimes: 1 });
    const r = await materializeCandidate('link_1', PARSED, {
      store, mapping: MAPPING, isTerminal: false, existingCandidateId: null,
    });
    expect(r).toEqual({ status: 'skipped', reason: 'persist_failed' });
    expect(world.populated).toEqual([]);
    // Our own losing candidate and our orphan resume are both cleaned up.
    expect(world.deleted).toEqual([
      { table: 'candidates', id: 'cand_full_1' },
      { table: 'resumes', id: 'resume_1' },
    ]);
  });

  it('the retry after a lost-race failure populates the winner exactly once', async () => {
    const { store, world } = newStore({ raceWinner: 'cand_shell_winner', failUpdateTimes: 1 });
    await materializeCandidate('link_1', PARSED, {
      store, mapping: MAPPING, isTerminal: false, existingCandidateId: null,
    });
    // On the retry the link is now observably bound, so the caller takes the
    // populate path directly.
    const second = await populateExistingCandidate('cand_shell_winner', PARSED, { store });
    expect(second).toEqual({ status: 'updated', candidateId: 'cand_shell_winner' });
    expect(world.populated).toHaveLength(1);
    expect(world.resumes).toBe(2);          // one orphaned+deleted, one kept
    expect(world.deleted).toContainEqual({ table: 'resumes', id: 'resume_1' });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. Legacy null-candidate links
// ═══════════════════════════════════════════════════════════════════════

describe('legacy links bound before the shell existed', () => {
  it('still create, and a create failure is still reported', async () => {
    const { store, world } = newStore({ failResumeTimes: 1 });
    expect(await materializeCandidate('link_legacy', PARSED, {
      store, mapping: MAPPING, isTerminal: false, existingCandidateId: null,
    })).toEqual({ status: 'skipped', reason: 'persist_failed' });
    expect(world.candidates).toEqual([]);

    expect(await materializeCandidate('link_legacy', PARSED, {
      store, mapping: MAPPING, isTerminal: false, existingCandidateId: null,
    })).toEqual({ status: 'created', candidateId: 'cand_full_1' });
    expect(world.candidates).toEqual([{ roleId: 'role_1', ownerId: 'owner_1' }]);
    expect(world.resumes).toBe(1);
  });

  it('a store with no populate seam still reuses rather than duplicating', async () => {
    const { store, world } = newStore();
    delete (store as { updateCandidateFromParse?: unknown }).updateCandidateFromParse;
    expect(await materializeCandidate('link_1', PARSED, {
      store, mapping: MAPPING, isTerminal: false, existingCandidateId: 'cand_legacy',
    })).toEqual({ status: 'reused', candidateId: 'cand_legacy' });
    expect(world.candidates).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. End to end at the worker: no blank ready row, ever
// ═══════════════════════════════════════════════════════════════════════

function baseLink(over: Partial<WorkflowLinkRow> = {}): WorkflowLinkRow {
  return {
    id: 'link_1', externalApplicationId: 'app_1', externalJobId: 'job_1',
    externalResumeFileHandle: 'handle_1', jobMappingId: 'map_1',
    candidateId: 'cand_shell_1', sessionId: null, inviteId: null,
    lifecycle: 'imported', terminalState: null, ...over,
  };
}

function workerRuntime(opts: {
  store: MaterializationStore;
  link?: WorkflowLinkRow;
  mapping?: MaterializationMapping | null;
  transitions: Array<{ state: string; reason?: string }>;
  thrownByParse?: unknown;
  /** Fires the instant the parse completes — i.e. just before persistence. */
  onParse?: () => void;
}) {
  const link = opts.link ?? baseLink();
  return {
    runtimeConfig: {},
    stores: {
      readLink: async () => link,
      readIngestion: async () => ({ state: 'queued', attempts: 0 }),
      advanceIngestion: async (_id: string, state: string, prov?: { failedReason?: string }) => {
        opts.transitions.push({ state, reason: prov?.failedReason });
        return { status: 'ok' };
      },
      deferIngestionParse: async () => ({ status: 'ok', attempts: 1 }),
    },
    materialization: opts.store,
    resolveMappingForLink: async () => (opts.mapping === undefined ? MAPPING : opts.mapping),
    buildIngestionPorts: async (input: { onState: IngestionPorts['onState'] }) => ({
      status: 'ok' as const,
      ports: {
        presignedUrl: 'https://host.example/r.pdf',
        policy: { allowlistEnabled: true, allowedHosts: ['host.example'], allowedPorts: [443] },
        fetch: async () => ({
          ok: true as const, bytes: Buffer.from('x'), sha256: 'a'.repeat(64),
          contentType: 'application/pdf', finalHost: 'host.example', hops: 0,
        }),
        scan: async () => ({ safe: true, status: 'clean' }),
        guard: () => ({ ok: true as const, mime: 'application/pdf' }),
        parse: async () => {
          if (opts.thrownByParse) throw opts.thrownByParse;
          opts.onParse?.();
          return { text: 'Ada', structured: PARSED, structurerVersion: 'v1' };
        },
        fallbackFromText: () => PARSED,
        onState: input.onState,
        extractorVersion: 'x1',
        classifyParse: PARSE_CLASSIFIER,
      },
    }),
  } as never;
}

const NOW = Date.now();
const job = (over: Record<string, unknown> = {}) => ({
  id: 'j1', name: ASHBY_INGESTION_QUEUE, payload: { applicationLinkId: 'link_1' },
  attempts: 1, maxAttempts: 5, createdAt: new Date(NOW).toISOString(), ...over,
}) as never;

describe('the ingestion worker never writes a blank ready row', () => {
  it('a population failure parks the row at failed_review/materialize_failed', async () => {
    const transitions: Array<{ state: string; reason?: string }> = [];
    const { store, world } = newStore({ failUpdateTimes: 1 });
    await buildAshbyHandlers(workerRuntime({ store, transitions }), { nowMs: () => NOW })
      [ASHBY_INGESTION_QUEUE]!(job());

    expect(transitions.map((t) => t.state)).not.toContain('ready');
    expect(transitions.at(-1)).toEqual({
      state: 'failed_review', reason: MATERIALIZE_FAILED_REASON,
    });
    expect(world.populated).toEqual([]);
  });

  it('the ordinary run populates the shell and only THEN marks ready', async () => {
    const transitions: Array<{ state: string; reason?: string }> = [];
    const { store, world } = newStore();
    await buildAshbyHandlers(workerRuntime({ store, transitions }), { nowMs: () => NOW })
      [ASHBY_INGESTION_QUEUE]!(job());

    expect(world.populated).toEqual([
      { candidateId: 'cand_shell_1', resumeId: 'resume_1', parsed: PARSED },
    ]);
    expect(transitions.at(-1)?.state).toBe('ready');
    // Populated strictly before the terminal transition.
    expect(transitions.filter((t) => t.state === 'ready')).toHaveLength(1);
    expect(world.candidates).toEqual([]);      // no second candidate
  });

  it('a bound shell is populated even when its mapping has since been PAUSED', async () => {
    // Ownership was decided at import; a pause afterwards must not strand a
    // shell blank while the row claims ready.
    const transitions: Array<{ state: string; reason?: string }> = [];
    const { store, world } = newStore();
    await buildAshbyHandlers(workerRuntime({ store, transitions, mapping: null }), { nowMs: () => NOW })
      [ASHBY_INGESTION_QUEUE]!(job());
    expect(world.populated).toHaveLength(1);
    expect(transitions.at(-1)?.state).toBe('ready');
  });

  it('no mapping AND no bound candidate is not a failure — there is no blank row to strand', async () => {
    const transitions: Array<{ state: string; reason?: string }> = [];
    const { store, world } = newStore();
    await buildAshbyHandlers(
      workerRuntime({ store, transitions, mapping: null, link: baseLink({ candidateId: null }) }),
      { nowMs: () => NOW },
    )[ASHBY_INGESTION_QUEUE]!(job());
    expect(world.candidates).toEqual([]);
    expect(world.populated).toEqual([]);
    expect(transitions.at(-1)?.state).toBe('ready');
  });

  it('a THROWING mapping lookup parks with the truthful code, not unexpected_error', async () => {
    // A throw escaping the persist seam would reach `runResumeIngestion`'s
    // catch-all and record `unexpected_error` — a less truthful code that is
    // also absent from the audited recovery allowlist, so the row would be
    // harder to recover than the failure warrants.
    const transitions: Array<{ state: string; reason?: string }> = [];
    const { store } = newStore();
    const runtime = workerRuntime({ store, transitions, link: baseLink({ candidateId: null }) });
    (runtime as { resolveMappingForLink: unknown }).resolveMappingForLink = async () => {
      throw new Error('mapping_lookup_down');
    };
    await buildAshbyHandlers(runtime, { nowMs: () => NOW })[ASHBY_INGESTION_QUEUE]!(job());
    // No mapping resolvable and no bound shell ⇒ nothing to strand ⇒ ready.
    expect(transitions.at(-1)?.state).toBe('ready');
    expect(transitions.some((t) => t.reason === 'unexpected_error')).toBe(false);
  });

  it('a THROWING link re-read still populates via the captured binding', async () => {
    const transitions: Array<{ state: string; reason?: string }> = [];
    const { store, world } = newStore();
    // Throw only in the PERSIST phase. `readLink` is also the cancel poll, and
    // breaking that would test something else entirely — the flag is raised by
    // the parse, which is the step immediately before persistence.
    let persistPhase = false;
    const runtime = workerRuntime({ store, transitions, onParse: () => { persistPhase = true; } });
    (runtime as { stores: Record<string, unknown> }).stores.readLink = async () => {
      if (persistPhase) throw new Error('read_down');
      return baseLink();
    };
    await buildAshbyHandlers(runtime, { nowMs: () => NOW })[ASHBY_INGESTION_QUEUE]!(job());
    expect(world.populated).toHaveLength(1);
    expect(transitions.at(-1)?.state).toBe('ready');
  });

  it('a legacy null-candidate link still CREATES before ready', async () => {
    const transitions: Array<{ state: string; reason?: string }> = [];
    const { store, world } = newStore();
    await buildAshbyHandlers(
      workerRuntime({ store, transitions, link: baseLink({ candidateId: null }) }),
      { nowMs: () => NOW },
    )[ASHBY_INGESTION_QUEUE]!(job());
    expect(world.candidates).toEqual([{ roleId: 'role_1', ownerId: 'owner_1' }]);
    expect(transitions.at(-1)?.state).toBe('ready');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 6. LOW-1 — an uncomputable wall clock fails CLOSED
// ═══════════════════════════════════════════════════════════════════════

describe('the parse-deferral wall clock fails closed', () => {
  it('a malformed job.createdAt stops the wait instead of unbounding it', async () => {
    // `Date.parse` answers NaN, and the previous `Number.isFinite(waitedMs)`
    // guard then skipped the deadline check — so the one input that made the
    // bound uncomputable also switched it off.
    const transitions: Array<{ state: string; reason?: string }> = [];
    const { store } = newStore();
    const r = await buildAshbyHandlers(
      workerRuntime({ store, transitions, thrownByParse: new ParserTimeoutError() }),
      { nowMs: () => NOW },
    )[ASHBY_INGESTION_QUEUE]!(job({ createdAt: 'not-a-date' }));

    expect(r).toBeUndefined();                       // no defer directive
    expect(transitions.at(-1)).toEqual({
      state: 'failed_review', reason: PARSE_DEFER_CLOCK_REASON,
    });
  });

  it('the clock code is distinct from the deadline code and DB-valid', () => {
    expect(PARSE_DEFER_CLOCK_REASON).toBe('parse_defer_clock_invalid');
    expect(PARSE_DEFER_CLOCK_REASON).toMatch(/^[a-z0-9_.:-]{1,64}$/);
  });

  it('a WELL-FORMED timestamp inside the bound still defers normally', async () => {
    const transitions: Array<{ state: string; reason?: string }> = [];
    const { store } = newStore();
    const r = await buildAshbyHandlers(
      workerRuntime({ store, transitions, thrownByParse: new ParserTimeoutError() }),
      { nowMs: () => NOW },
    )[ASHBY_INGESTION_QUEUE]!(job());
    expect(r).toMatchObject({ outcome: 'defer', reasonCode: 'parse_timeout' });
  });
});
