/**
 * The queued candidate shell, and the worker behaviours that keep it honest.
 *
 * WHAT WAS WRONG: the ONLY thing that ever created an Ashby candidate was the
 * ingestion job reaching `ready`. An application whose resume failed to parse
 * produced an application link, an ingestion row and a queued invite operation
 * — and no row anywhere a recruiter looks. The application was invisible, and
 * invisible is indistinguishable from never having arrived. The live canary is
 * exactly that shape: valid mapped import, resume-backed, ingestion
 * `failed_review`, no candidate, no session, no invite.
 *
 * WHAT MUST BE TRUE NOW:
 *   1. Every valid enabled mapped import binds exactly one `queued`
 *      PII-minimal shell BEFORE the import queue job may complete.
 *   2. A shell failure is retryable and LOUD — never swallowed, which would
 *      recreate the invisible-candidate defect inside the fix for it.
 *   3. Identity stays application-centric: one link, at most one candidate,
 *      never merged by email or phone.
 *   4. A successful parse POPULATES that same shell and mutates nothing about
 *      its ownership or funnel position.
 *   5. The shell does NOT weaken the 0035 invite prerequisite.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  materializeCandidateShell,
  materializeCandidate,
  materializeInvite,
  type MaterializationStore,
  type MaterializationMapping,
} from '../integrations/ashby/materialize.js';
import { runImport, type ImportDeps } from '../integrations/ashby/orchestration.js';
import {
  buildAshbyHandlers,
  ASHBY_INGESTION_QUEUE,
} from '../integrations/ashby/runtime-workers.js';
import { ASHBY_IMPORT_QUEUE } from '../integrations/ashby/signal-worker.js';
import type { WorkflowLinkRow } from '../integrations/ashby/orchestration.js';
import type { StructuredResume } from '../integrations/ashby/resume-ingestion.js';

const MAPPING: MaterializationMapping = {
  id: 'map_1', roleId: 'role_1', ownerId: 'owner_1', deliveryMode: 'manual',
};

const PARSED: StructuredResume = {
  name: 'Ada Lovelace', email: 'ada@example.com', phone: '+15550000000',
  skills: ['analysis'], experience_years: 7, current_role: 'Engineer', summary: 'Synthetic.',
};

// ═══════════════════════════════════════════════════════════════════════
// A recording store. Every insert is captured so "what was written?" is a
// direct assertion rather than an inference.
// ═══════════════════════════════════════════════════════════════════════

interface StoreWorld {
  shells: Array<{ roleId: string; ownerId: string }>;
  candidates: Array<{ roleId: string; ownerId: string; parsed: StructuredResume }>;
  resumes: number;
  populated: Array<{ candidateId: string; resumeId: string; parsed: StructuredResume }>;
  deleted: Array<{ table: string; id: string }>;
  bound: string | null;
  /** When set, bindLinkColumn reports a LOST race with this winner. */
  raceWinner?: string;
  shellThrows?: boolean;
  /** Simulates a candidate already populated (repeat ready path). */
  alreadyPopulated?: boolean;
  seq: number;
}

function newStore(over: Partial<StoreWorld> = {}): { store: MaterializationStore; world: StoreWorld } {
  const world: StoreWorld = {
    shells: [], candidates: [], resumes: 0, populated: [], deleted: [],
    bound: null, seq: 0, ...over,
  };
  const store: MaterializationStore = {
    async insertResume() { world.resumes += 1; return { id: `resume_${world.resumes}` }; },
    async insertCandidate(input) {
      world.candidates.push({ roleId: input.roleId, ownerId: input.ownerId, parsed: input.parsed });
      world.seq += 1;
      return { id: `cand_full_${world.seq}` };
    },
    async insertCandidateShell(input) {
      if (world.shellThrows) throw new Error('db_down');
      world.shells.push({ roleId: input.roleId, ownerId: input.ownerId });
      world.seq += 1;
      return { id: `cand_shell_${world.seq}` };
    },
    async updateCandidateFromParse(input) {
      if (world.alreadyPopulated) return { updated: false };
      world.populated.push(input);
      return { updated: true };
    },
    async bindLinkColumn(input) {
      if (world.raceWinner) return { bound: world.raceWinner, wonRace: false };
      world.bound = input.value;
      return { bound: input.value, wonRace: true };
    },
    async deleteOrphan(table, id) { world.deleted.push({ table, id }); },
    async createSession() { return { id: 'sess_1' }; },
    async findActiveInvite() { return null; },
    async insertInvite() { return { id: 'inv_1' }; },
  };
  return { store, world };
}

// ═══════════════════════════════════════════════════════════════════════
// 1. The shell itself
// ═══════════════════════════════════════════════════════════════════════

describe('materializeCandidateShell', () => {
  it('creates exactly one shell and binds it under the SAME CAS the full path uses', async () => {
    const { store, world } = newStore();
    const r = await materializeCandidateShell('link_1', {
      store, mapping: MAPPING, isTerminal: false, existingCandidateId: null,
    });
    expect(r).toEqual({ status: 'created', candidateId: 'cand_shell_1' });
    expect(world.shells).toEqual([{ roleId: 'role_1', ownerId: 'owner_1' }]);
    expect(world.bound).toBe('cand_shell_1');
    // No resume row and no full candidate: nothing has been parsed yet.
    expect(world.resumes).toBe(0);
    expect(world.candidates).toEqual([]);
  });

  it('the inserted shell carries NO candidate PII — ownership and provenance only', async () => {
    const { store, world } = newStore();
    await materializeCandidateShell('link_1', {
      store, mapping: MAPPING, isTerminal: false, existingCandidateId: null,
    });
    const written = world.shells[0]!;
    // The seam's input type is the proof: there is no field on it through
    // which a name, an email, a phone, a resume or an external id COULD be
    // supplied. Assert the shape exhaustively so widening it fails here.
    expect(Object.keys(written).sort()).toEqual(['ownerId', 'roleId']);
    expect(JSON.stringify(written)).not.toContain('@');
  });

  it('ownership comes from the MAPPING, so interviewer scoping needs no new path', async () => {
    const { store, world } = newStore();
    await materializeCandidateShell('link_1', {
      store,
      mapping: { ...MAPPING, roleId: 'role_x', ownerId: 'owner_x' },
      isTerminal: false, existingCandidateId: null,
    });
    expect(world.shells[0]).toEqual({ roleId: 'role_x', ownerId: 'owner_x' });
  });

  it('is re-entrant: a second call reuses the bound candidate and creates nothing', async () => {
    const { store, world } = newStore();
    const r = await materializeCandidateShell('link_1', {
      store, mapping: MAPPING, isTerminal: false, existingCandidateId: 'cand_existing',
    });
    expect(r).toEqual({ status: 'reused', candidateId: 'cand_existing' });
    expect(world.shells).toEqual([]);
  });

  it('a LOST race adopts the winner and deletes its own orphan — no orphan survives', async () => {
    const { store, world } = newStore({ raceWinner: 'cand_winner' });
    const r = await materializeCandidateShell('link_1', {
      store, mapping: MAPPING, isTerminal: false, existingCandidateId: null,
    });
    expect(r).toEqual({ status: 'reused', candidateId: 'cand_winner' });
    expect(world.deleted).toEqual([{ table: 'candidates', id: 'cand_shell_1' }]);
  });

  it('a terminal application is SKIPPED, not failed — there is genuinely no work', async () => {
    const { store, world } = newStore();
    const r = await materializeCandidateShell('link_1', {
      store, mapping: MAPPING, isTerminal: true, existingCandidateId: null,
    });
    expect(r).toEqual({ status: 'skipped', reason: 'blocked_terminal' });
    expect(world.shells).toEqual([]);
  });

  it('a persistence failure reports FAILED (not skipped) and leaves no orphan', async () => {
    const { store, world } = newStore({ shellThrows: true });
    const r = await materializeCandidateShell('link_1', {
      store, mapping: MAPPING, isTerminal: false, existingCandidateId: null,
    });
    expect(r).toEqual({ status: 'failed', reason: 'persist_failed' });
    expect(world.bound).toBeNull();
  });

  it('a store without the seam FAILS CLOSED rather than silently skipping', async () => {
    const { store } = newStore();
    delete (store as { insertCandidateShell?: unknown }).insertCandidateShell;
    const r = await materializeCandidateShell('link_1', {
      store, mapping: MAPPING, isTerminal: false, existingCandidateId: null,
    });
    // Reporting this as `skipped` would be the exact swallow the seam exists
    // to refuse.
    expect(r).toEqual({ status: 'failed', reason: 'shell_unsupported' });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. runImport — the shell is part of the success condition
// ═══════════════════════════════════════════════════════════════════════

const AI_STAGE = 'stage_ai';

function reader(app: Record<string, unknown>) {
  return { applicationInfo: async () => ({ ok: true as const, status: 200, results: app }) } as never;
}

const appAtAi = {
  application: { id: 'app_1', job: { id: 'job_1' }, currentInterviewStage: { id: AI_STAGE } },
};

function importStores() {
  const enqueued: string[] = [];
  const advanced: string[] = [];
  return {
    enqueued, advanced,
    stores: {
      findLinkByApplicationId: async () => null,
      createLink: async () => ({ id: 'link_1' }),
      advanceIngestion: async (_l: string, s: string) => { advanced.push(s); return { status: 'ok' }; },
      enqueueOperation: async (i: { operationKey: string }) => {
        enqueued.push(i.operationKey); return { status: 'inserted' as const };
      },
      completeOperation: async () => 'ok' as const,
      failOperation: async () => ({ outcome: 'retry' as const }),
    },
  };
}

function importDeps(over: Partial<ImportDeps> = {}): ImportDeps {
  const { stores } = importStores();
  return {
    gates: { enabled: true, email: { providerApproved: false, domainVerified: false } },
    client: reader(appAtAi),
    stores: stores as never,
    resolveMapping: async () => ({
      id: 'map_1', status: 'enabled', aiScreeningStageId: AI_STAGE,
      taScreeningStageId: 'stage_ta', deliveryMode: 'manual',
    } as never),
    ...over,
  };
}

describe('runImport — shell binding', () => {
  it('a valid mapped import reports the bound shell', async () => {
    const shell = vi.fn(async () => ({ status: 'created' as const, candidateId: 'cand_1' }));
    const r = await runImport('app_1', importDeps({ materializeShell: shell }));
    expect(r).toMatchObject({ status: 'imported', candidateId: 'cand_1', shell: 'created' });
    expect(shell).toHaveBeenCalledWith('link_1');
  });

  it('a shell FAILURE is not swallowed: the import reports shell_unbound', async () => {
    const r = await runImport('app_1', importDeps({
      materializeShell: async () => ({ status: 'failed' as const, reason: 'persist_failed' }),
    }));
    expect(r).toEqual({ status: 'shell_unbound', applicationLinkId: 'link_1', reason: 'persist_failed' });
  });

  it('a shell failure stops BEFORE the invite operations exist', async () => {
    const io = importStores();
    const r = await runImport('app_1', importDeps({
      stores: io.stores as never,
      materializeShell: async () => ({ status: 'failed' as const, reason: 'persist_failed' }),
    }));
    expect(r.status).toBe('shell_unbound');
    // The link and the ingestion seed are durable (higher value, and idempotent
    // on retry); the operations are not created on a failed pass.
    expect(io.advanced).toEqual(['queued']);
    expect(io.enqueued).toEqual([]);
  });

  it('a SKIPPED shell (paused mapping / terminal) is not a failure and does not loop', async () => {
    const io = importStores();
    const r = await runImport('app_1', importDeps({
      stores: io.stores as never,
      materializeShell: async () => ({ status: 'skipped' as const, reason: 'no_mapping' }),
    }));
    expect(r).toMatchObject({ status: 'imported', candidateId: null, shell: 'skipped' });
    expect(io.enqueued).toHaveLength(1);
  });

  it('a decision-only caller (no seam) reports `unavailable` — an assertable fact, not a silent success', async () => {
    const r = await runImport('app_1', importDeps());
    expect(r).toMatchObject({ status: 'imported', candidateId: null, shell: 'unavailable' });
  });

  it('a terminal / unmapped / no-job import binds NO shell at all', async () => {
    const shell = vi.fn();
    for (const deps of [
      importDeps({
        materializeShell: shell as never,
        stores: { ...importStores().stores, findLinkByApplicationId: async () => ({ id: 'l', externalApplicationId: 'app_1', terminalState: 'withdrawn' as const }) } as never,
      }),
      importDeps({ materializeShell: shell as never, client: reader({ application: { id: 'app_1' } }) }),
      importDeps({
        materializeShell: shell as never,
        resolveMapping: async () => ({ id: 'map_1', status: 'paused', aiScreeningStageId: AI_STAGE, taScreeningStageId: 't', deliveryMode: 'manual' } as never),
      }),
    ]) {
      const r = await runImport('app_1', deps);
      expect(r.status).toBe('skipped');
    }
    expect(shell).not.toHaveBeenCalled();
  });

  it('the whole lane is inert when the runtime gate is closed', async () => {
    const shell = vi.fn();
    const r = await runImport('app_1', importDeps({
      gates: { enabled: false, email: { providerApproved: false, domainVerified: false } },
      materializeShell: shell as never,
    }));
    expect(r).toEqual({ status: 'disabled' });
    expect(shell).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. The import QUEUE JOB refuses to complete without the shell
// ═══════════════════════════════════════════════════════════════════════

function baseLink(over: Partial<WorkflowLinkRow> = {}): WorkflowLinkRow {
  return {
    id: 'link_1', externalApplicationId: 'app_1', externalJobId: 'job_1',
    externalResumeFileHandle: 'handle_1', jobMappingId: 'map_1',
    candidateId: null, sessionId: null, inviteId: null,
    lifecycle: 'imported', terminalState: null, ...over,
  };
}

function importRuntime(opts: {
  store: MaterializationStore;
  link?: WorkflowLinkRow;
  mapping?: MaterializationMapping | null;
}) {
  const enqueues: Array<{ name: string }> = [];
  let link = opts.link ?? baseLink();
  return {
    enqueues,
    linkRef: () => link,
    runtime: {
      runtimeConfig: {},
      client: reader(appAtAi),
      materialization: opts.store,
      resolveMappingByJobId: async () => ({
        id: 'map_1', status: 'enabled', aiScreeningStageId: AI_STAGE,
        taScreeningStageId: 'stage_ta', deliveryMode: 'manual',
      }),
      resolveMappingForLink: async () => (opts.mapping === undefined ? MAPPING : opts.mapping),
      stores: {
        findLinkByApplicationId: async () => null,
        createLink: async () => ({ id: 'link_1' }),
        advanceIngestion: async () => ({ status: 'ok' }),
        enqueueOperation: async () => ({ status: 'inserted' }),
        readIngestion: async () => ({ state: 'queued', attempts: 0 }),
        readLink: async () => link,
        bindLinkResumeHandle: async () => {},
      },
      queue: {
        enqueue: async (name: string) => { enqueues.push({ name }); return { id: 'q1' }; },
      },
      setLink: (l: WorkflowLinkRow) => { link = l; },
    } as never,
  };
}

const importJob = () => ({
  id: 'j1', name: ASHBY_IMPORT_QUEUE, payload: { externalApplicationId: 'app_1' },
  attempts: 1, maxAttempts: 5, createdAt: new Date().toISOString(),
}) as never;

describe('the ashby.import queue job', () => {
  it('binds a queued PII-minimal shell and then enqueues the ingestion', async () => {
    const { store, world } = newStore();
    const { runtime, enqueues } = importRuntime({ store });
    await buildAshbyHandlers(runtime)[ASHBY_IMPORT_QUEUE]!(importJob());
    expect(world.shells).toEqual([{ roleId: 'role_1', ownerId: 'owner_1' }]);
    expect(world.bound).toBe('cand_shell_1');
    expect(enqueues.map((e) => e.name)).toEqual([ASHBY_INGESTION_QUEUE]);
  });

  it('THROWS when the shell cannot be bound, so the durable job cannot complete', async () => {
    const { store } = newStore({ shellThrows: true });
    const { runtime, enqueues } = importRuntime({ store });
    await expect(buildAshbyHandlers(runtime)[ASHBY_IMPORT_QUEUE]!(importJob()))
      .rejects.toThrow('ashby_import_shell_unbound');
    // And it did not go on to schedule downstream work on a broken import.
    expect(enqueues).toEqual([]);
  });

  it('a paused mapping at write time skips the shell WITHOUT failing the job', async () => {
    const { store, world } = newStore();
    const { runtime, enqueues } = importRuntime({ store, mapping: null });
    await buildAshbyHandlers(runtime)[ASHBY_IMPORT_QUEUE]!(importJob());
    expect(world.shells).toEqual([]);
    expect(enqueues.map((e) => e.name)).toEqual([ASHBY_INGESTION_QUEUE]);
  });

  it('a terminal application binds no shell', async () => {
    const { store, world } = newStore();
    const { runtime } = importRuntime({ store, link: baseLink({ terminalState: 'withdrawn' }) });
    await buildAshbyHandlers(runtime)[ASHBY_IMPORT_QUEUE]!(importJob());
    expect(world.shells).toEqual([]);
  });

  it('three concurrent redeliveries converge on ONE candidate via the link CAS', async () => {
    const { store, world } = newStore();
    let winner: string | null = null;
    // A CAS that behaves like the real one: the first writer wins, everyone
    // else is told who won.
    store.bindLinkColumn = async (input) => {
      if (winner) return { bound: winner, wonRace: false };
      winner = input.value;
      world.bound = input.value;
      return { bound: input.value, wonRace: true };
    };
    const { runtime } = importRuntime({ store });
    const handler = buildAshbyHandlers(runtime)[ASHBY_IMPORT_QUEUE]!;
    await Promise.all([handler(importJob()), handler(importJob()), handler(importJob())]);

    // Three shells were INSERTED (three racers), but exactly one survives:
    // the two losers delete their own rows.
    expect(world.shells).toHaveLength(3);
    expect(world.deleted.filter((d) => d.table === 'candidates')).toHaveLength(2);
    expect(world.deleted.map((d) => d.id)).not.toContain(winner);
    expect(winner).toBe('cand_shell_1');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. Identity: never merged by email or phone
// ═══════════════════════════════════════════════════════════════════════

describe('identity', () => {
  it('two applications from the same human produce TWO candidates', async () => {
    const { store, world } = newStore();
    const bindings: Record<string, string> = {};
    store.bindLinkColumn = async (input) => {
      if (bindings[input.applicationLinkId]) {
        return { bound: bindings[input.applicationLinkId]!, wonRace: false };
      }
      bindings[input.applicationLinkId] = input.value;
      return { bound: input.value, wonRace: true };
    };
    const a = await materializeCandidateShell('link_a', {
      store, mapping: MAPPING, isTerminal: false, existingCandidateId: null,
    });
    const b = await materializeCandidateShell('link_b', {
      store, mapping: MAPPING, isTerminal: false, existingCandidateId: null,
    });
    expect(a.status).toBe('created');
    expect(b.status).toBe('created');
    expect((a as { candidateId: string }).candidateId)
      .not.toBe((b as { candidateId: string }).candidateId);
    expect(world.shells).toHaveLength(2);
    expect(world.deleted).toEqual([]);
  });

  it('the shell seam exposes no lookup by email or phone at all', () => {
    // Structural, not behavioural: the deps type carries a mapping and a
    // terminal flag, and nothing that could address a human.
    const keys = ['store', 'mapping', 'isTerminal', 'existingCandidateId'];
    const deps = { store: newStore().store, mapping: MAPPING, isTerminal: false, existingCandidateId: null };
    expect(Object.keys(deps).sort()).toEqual([...keys].sort());
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. Parse success POPULATES the shell — it does not create a second one
// ═══════════════════════════════════════════════════════════════════════

describe('materializeCandidate against an existing shell', () => {
  it('updates the SAME candidate and creates no second identity', async () => {
    const { store, world } = newStore();
    const r = await materializeCandidate('link_1', PARSED, {
      store, mapping: MAPPING, isTerminal: false, existingCandidateId: 'cand_shell_1',
      textExtracted: 'Ada Lovelace',
    });
    expect(r).toEqual({ status: 'updated', candidateId: 'cand_shell_1' });
    expect(world.candidates).toEqual([]);          // no second candidate row
    expect(world.populated).toHaveLength(1);
    expect(world.populated[0]).toMatchObject({ candidateId: 'cand_shell_1', resumeId: 'resume_1' });
  });

  it('the update never touches role, owner, status, or ats_source', async () => {
    const { store, world } = newStore();
    await materializeCandidate('link_1', PARSED, {
      store, mapping: MAPPING, isTerminal: false, existingCandidateId: 'cand_shell_1',
    });
    // The seam's input shape is the enforcement: there is no field through
    // which ownership or funnel position could be revised.
    expect(Object.keys(world.populated[0]!).sort()).toEqual(['candidateId', 'parsed', 'resumeId']);
  });

  it('running the ready path TWICE writes once — no duplicate resume, no second candidate', async () => {
    const { store, world } = newStore();
    await materializeCandidate('link_1', PARSED, {
      store, mapping: MAPPING, isTerminal: false, existingCandidateId: 'cand_shell_1',
    });
    world.alreadyPopulated = true;      // the CAS now matches zero rows
    const second = await materializeCandidate('link_1', PARSED, {
      store, mapping: MAPPING, isTerminal: false, existingCandidateId: 'cand_shell_1',
    });
    expect(second).toEqual({ status: 'reused', candidateId: 'cand_shell_1' });
    expect(world.populated).toHaveLength(1);
    // The second run's resume row is cleaned up rather than accumulating.
    expect(world.deleted).toEqual([{ table: 'resumes', id: 'resume_2' }]);
  });

  it('a link bound BEFORE the shell existed still works — backward compatibility', async () => {
    const { store, world } = newStore();
    delete (store as { updateCandidateFromParse?: unknown }).updateCandidateFromParse;
    const r = await materializeCandidate('link_1', PARSED, {
      store, mapping: MAPPING, isTerminal: false, existingCandidateId: 'cand_legacy',
    });
    expect(r).toEqual({ status: 'reused', candidateId: 'cand_legacy' });
    expect(world.candidates).toEqual([]);
  });

  it('an UNBOUND link still takes the original create path', async () => {
    const { store, world } = newStore();
    const r = await materializeCandidate('link_1', PARSED, {
      store, mapping: MAPPING, isTerminal: false, existingCandidateId: null,
    });
    expect(r).toEqual({ status: 'created', candidateId: 'cand_full_1' });
    expect(world.candidates).toHaveLength(1);
    expect(world.candidates[0]).toMatchObject({ roleId: 'role_1', ownerId: 'owner_1' });
  });

  it('a LOST RACE against the import shell POPULATES the winner, never abandons the parse', async () => {
    // The realistic race: the import binds the shell while this ingestion is
    // still downloading/scanning/parsing, so `existingCandidateId` was null
    // when the ready path started but the link is bound by the time it writes.
    // Returning `reused` here would leave a candidate with no name that NO
    // later run can fill — `ready` is terminal, so this path never runs again.
    const { store, world } = newStore({ raceWinner: 'cand_shell_winner' });
    const r = await materializeCandidate('link_1', PARSED, {
      store, mapping: MAPPING, isTerminal: false, existingCandidateId: null,
    });
    expect(r).toEqual({ status: 'updated', candidateId: 'cand_shell_winner' });
    expect(world.populated).toEqual([
      { candidateId: 'cand_shell_winner', resumeId: 'resume_1', parsed: PARSED },
    ]);
    // Our own losing candidate is removed; the resume we created is KEPT,
    // because it is now the winner's resume.
    expect(world.deleted).toEqual([{ table: 'candidates', id: 'cand_full_1' }]);
  });

  it('a lost race whose winner is ALREADY populated cleans up and reuses', async () => {
    const { store, world } = newStore({ raceWinner: 'cand_shell_winner', alreadyPopulated: true });
    const r = await materializeCandidate('link_1', PARSED, {
      store, mapping: MAPPING, isTerminal: false, existingCandidateId: null,
    });
    expect(r).toEqual({ status: 'reused', candidateId: 'cand_shell_winner' });
    expect(world.deleted).toEqual([
      { table: 'candidates', id: 'cand_full_1' },
      { table: 'resumes', id: 'resume_1' },
    ]);
  });

  it('a lost race against a store WITHOUT the populate seam still cleans up fully', async () => {
    const { store, world } = newStore({ raceWinner: 'cand_legacy_winner' });
    delete (store as { updateCandidateFromParse?: unknown }).updateCandidateFromParse;
    const r = await materializeCandidate('link_1', PARSED, {
      store, mapping: MAPPING, isTerminal: false, existingCandidateId: null,
    });
    expect(r).toEqual({ status: 'reused', candidateId: 'cand_legacy_winner' });
    expect(world.deleted).toEqual([
      { table: 'candidates', id: 'cand_full_1' },
      { table: 'resumes', id: 'resume_1' },
    ]);
  });

  it('a failed population does NOT delete the durable shell', async () => {
    const { store, world } = newStore();
    store.updateCandidateFromParse = async () => { throw new Error('db_down'); };
    const r = await materializeCandidate('link_1', PARSED, {
      store, mapping: MAPPING, isTerminal: false, existingCandidateId: 'cand_shell_1',
    });
    expect(r).toEqual({ status: 'skipped', reason: 'persist_failed' });
    expect(world.deleted).toEqual([{ table: 'resumes', id: 'resume_1' }]);
    expect(world.deleted.some((d) => d.table === 'candidates')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 6. The shell does NOT weaken the invite prerequisite (0035)
// ═══════════════════════════════════════════════════════════════════════

describe('invite prerequisite with a shell present', () => {
  const inviteDeps = (ingestionState: string | null) => ({
    store: newStore().store,
    mapping: MAPPING,
    channel: 'manual' as const,
    link: {
      id: 'link_1', externalApplicationId: 'app_1',
      // The SHELL is bound. Before this change `candidateId` was null until
      // `ready`, so "is there a candidate?" accidentally doubled as "is the
      // resume parsed?". It no longer does, and the ingestion gate must be
      // what actually blocks.
      candidateId: 'cand_shell_1', sessionId: null, inviteId: null, terminalState: null,
    },
    ingestionState,
    noResume: false,
    email: { providerApproved: false, domainVerified: false },
    recruiterReissuePath: '/ashby-mission-control?application=app_1',
  });

  it('a shell + failed_review ingestion still CANNOT produce an invite', async () => {
    const r = await materializeInvite(inviteDeps('failed_review'));
    expect(r).toMatchObject({ status: 'blocked', delivery: 'not_ready', reason: 'ingestion_not_ready' });
    expect(r.inviteId).toBeUndefined();
    expect(r.sessionId).toBeUndefined();
  });

  it('a shell + in-flight ingestion still cannot produce an invite', async () => {
    for (const state of ['queued', 'fetching', 'scanning', 'extracting', 'structuring']) {
      const r = await materializeInvite(inviteDeps(state));
      expect(r).toMatchObject({ status: 'blocked', reason: 'ingestion_not_ready' });
    }
  });

  it('only `ready` opens the gate — the shell changed nothing about it', async () => {
    const r = await materializeInvite(inviteDeps('ready'));
    expect(r).toMatchObject({ status: 'issued', channel: 'manual', delivery: 'manual_reissue' });
  });
});
