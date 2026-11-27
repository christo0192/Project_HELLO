/**
 * M035 S12 (migration 0144): the Ashby import pipeline never touches an
 * application the public R1 booking page imported on the spot, and staff
 * surfaces show no intake for it.
 *
 * A link with `intake_type = 'r1_public_booking'` is written only by the 0144
 * import RPC. The SQL fences (the intake lock, the two insert guards, the
 * claim hunk) are the guarantee; these TypeScript fences make a stray job a
 * quiet, logged no-op instead of a database error and a retry loop:
 *
 *   1. the vocabulary: three intake values, equal to the 0144 CHECK; the
 *      staff vocabulary is the 0130 pair;
 *   2. `runImport` answers `skipped`/`r1_public_booking` for such a link and
 *      calls nothing after the link lookup (also with a resume handle and a
 *      phone_primary mapping); a terminal one is still `terminal`; a resume or
 *      phone parsing reuse is unchanged;
 *   3. the import handler logs that skip, enqueues nothing and reopens no
 *      receipt;
 *   4. the profile job makes no Ashby read, outcome write or RPC for it;
 *   5. the ingestion handler returns before the ports, the scanner and the
 *      provider;
 *   6. the stores read the value, and every staff projection (Mission
 *      Control, the workflow card, the candidate list and detail) shows null;
 *   7. no file in integrations/ashby names the Meet module path or imports
 *      lib/r1.
 *
 * Synthetic data only; no network, no database.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SupabaseClient } from '@supabase/supabase-js';
import request from 'supertest';

const mockFrom = vi.fn();
vi.mock('../lib/supabase.js', () => ({
  supabase: { from: (...a: unknown[]) => mockFrom(...a) },
  RESUME_BUCKET: 'resumes_v2',
}));

import {
  ASHBY_INTAKE_TYPES,
  isAshbyIntakeType,
  runImport,
  type AshbyIntakeType,
  type AshbyScreeningIntakeType,
  type ApplicationReader,
  type EnqueueResult,
  type ExistingLinkRow,
  type ImportDeps,
  type OrchestrationGates,
  type ResolvedMapping,
  type WorkflowLinkRow,
  type WorkflowStores,
} from '../integrations/ashby/orchestration.js';
import {
  buildAshbyHandlers,
  ASHBY_INGESTION_QUEUE,
  ASHBY_PROFILE_QUEUE,
} from '../integrations/ashby/runtime-workers.js';
import { ASHBY_IMPORT_QUEUE } from '../integrations/ashby/signal-worker.js';
import { createMissionControlStore, createWorkflowStores } from '../integrations/ashby/workflow-stores.js';
import { projectCandidateWorkflow, projectIntakeType } from '../integrations/ashby/candidate-workflow.js';
import { resolveIntakeType } from '../routes/candidates.js';
import { createApp } from '../app.js';
import { mockAuthGetUser, type AuthUser } from '../lib/auth.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_SRC = path.resolve(HERE, '..');
const MIGRATION_0144 = readFileSync(
  path.resolve(API_SRC, '../../supabase/migrations/0144_r1_meet_public_import.sql'),
  'utf8',
);

const R1 = 'r1_public_booking';
const AI_STAGE = 'stage_ai';
const NOW_MS = Date.parse('2026-12-01T04:00:00.000Z');
const APP_ID = 'app_pub_1';
const LINK_ID = 'link_pub_1';
const CANDIDATE_ID = 'cand_pub_1';
const ASHBY_CANDIDATE_ID = 'ashby_cand_pub_1';
const HANDLE = 'handle_pub_1';
/** Identifiers that must never reach a log line. */
const IDS = [APP_ID, LINK_ID, CANDIDATE_ID, ASHBY_CANDIDATE_ID, HANDLE];

/** Every line the logger wrote while `fn` ran (info → stdout, warn/error → console). */
async function captureLogs(fn: () => Promise<unknown>): Promise<{ lines: string[]; error: unknown }> {
  const lines: string[] = [];
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  const warn = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
  const error = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
  let caught: unknown = null;
  try {
    await fn();
  } catch (err) {
    caught = err;
  } finally {
    out.mockRestore();
    warn.mockRestore();
    error.mockRestore();
  }
  return { lines, error: caught };
}

/** The structured log entries, parsed. */
function entries(lines: string[]): Array<Record<string, unknown>> {
  return lines
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function expectNoIds(lines: string[]): void {
  const text = lines.join('\n');
  for (const id of IDS) expect(text, id).not.toContain(id);
}

// ═══════════════════════════════════════════════════════════════════════
// 1. The vocabulary
// ═══════════════════════════════════════════════════════════════════════

describe('1. the intake vocabulary is the 0144 CHECK', () => {
  it('ASHBY_INTAKE_TYPES equals the 0144 CHECK list, in order, and is frozen', () => {
    const m = /chk_ashby_application_links_intake_type check \(intake_type in \(([^)]*)\)\)/.exec(MIGRATION_0144);
    expect(m).not.toBeNull();
    const check = [...m![1]!.matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]);
    expect(check).toEqual(['resume_parsing', 'phone_parsing', R1]);
    expect([...ASHBY_INTAKE_TYPES]).toEqual(check);
    expect(Object.isFrozen(ASHBY_INTAKE_TYPES)).toBe(true);
  });

  it('the unions are exact (a Record over each compiles with exactly these keys)', () => {
    const all: Record<AshbyIntakeType, true> = { resume_parsing: true, phone_parsing: true, r1_public_booking: true };
    const screening: Record<AshbyScreeningIntakeType, true> = { resume_parsing: true, phone_parsing: true };
    expect(Object.keys(all)).toHaveLength(3);
    expect(Object.keys(all).sort()).toEqual([...ASHBY_INTAKE_TYPES].sort());
    expect(Object.keys(screening).sort()).toEqual(['phone_parsing', 'resume_parsing']);
  });

  it('isAshbyIntakeType accepts exactly the three values', () => {
    for (const value of ASHBY_INTAKE_TYPES) expect(isAshbyIntakeType(value), value).toBe(true);
    for (const bad of [undefined, null, '', 'other', 'R1_PUBLIC_BOOKING', ' resume_parsing', 7, {}, ['phone_parsing']]) {
      expect(isAshbyIntakeType(bad), String(bad)).toBe(false);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. runImport
// ═══════════════════════════════════════════════════════════════════════

const enabledGates: OrchestrationGates = { enabled: true, email: { providerApproved: false, domainVerified: false } };

/** Every store call, in order, by name. */
class TracingStores implements WorkflowStores {
  trace: string[] = [];
  constructor(private readonly existing: ExistingLinkRow | null) {}
  async findLinkByApplicationId(): Promise<ExistingLinkRow | null> {
    this.trace.push('findLinkByApplicationId');
    return this.existing;
  }
  async createLink(): Promise<{ id: string }> { this.trace.push('createLink'); return { id: 'link_new' }; }
  async bindLinkSubmittedAt(): Promise<void> { this.trace.push('bindLinkSubmittedAt'); }
  async bindLinkResumeHandle(): Promise<void> { this.trace.push('bindLinkResumeHandle'); }
  async bindLinkExternalCandidateId(): Promise<void> { this.trace.push('bindLinkExternalCandidateId'); }
  async advanceIngestion(_id: string, state: string): Promise<{ status: string }> {
    this.trace.push(`advanceIngestion:${state}`);
    return { status: 'ok' };
  }
  async enqueueOperation(): Promise<EnqueueResult> { this.trace.push('enqueueOperation'); return { status: 'inserted', id: 'op_1' }; }
  async findScorecardWriteOperation(): Promise<{ id: string } | null> { this.trace.push('findScorecardWriteOperation'); return null; }
  async completeOperation(): Promise<'ok' | 'not_owned'> { this.trace.push('completeOperation'); return 'ok'; }
  async failOperation(): Promise<{ outcome: 'retry' | 'failed' } | 'not_owned'> {
    this.trace.push('failOperation');
    return { outcome: 'retry' };
  }
}

interface ImportCase {
  existing: ExistingLinkRow | null;
  screeningMode?: 'browser_primary' | 'phone_primary';
  withHandle?: boolean;
}

/** One `runImport` with every seam a spy; the trace lists them in call order. */
async function importWith(c: ImportCase) {
  const trace: string[] = [];
  const stores = new TracingStores(c.existing);
  const app = {
    id: APP_ID, job: { id: 'job_1' }, currentInterviewStage: { id: AI_STAGE },
    candidate: { id: ASHBY_CANDIDATE_ID }, submittedAt: '2026-11-30T00:00:00.000Z',
    ...(c.withHandle ? { resumeFileHandle: { handle: HANDLE } } : {}),
  };
  const client: ApplicationReader = {
    applicationInfo: (async () => { trace.push('applicationInfo'); return { results: app, moreDataAvailable: false }; }) as ApplicationReader['applicationInfo'],
    candidateInfo: (async () => {
      trace.push('candidateInfo');
      return { results: { id: ASHBY_CANDIDATE_ID, ...(c.withHandle ? { resumeFileHandle: { handle: HANDLE } } : {}) }, moreDataAvailable: false };
    }) as NonNullable<ApplicationReader['candidateInfo']>,
  };
  const mapping: ResolvedMapping = {
    id: 'map_1', status: 'enabled', aiScreeningStageId: AI_STAGE, deliveryMode: 'both',
    screeningMode: c.screeningMode ?? 'browser_primary',
  };
  const deps: ImportDeps = {
    gates: enabledGates,
    client,
    stores,
    resolveMapping: async () => { trace.push('resolveMapping'); return mapping; },
    admitIntake: async () => { trace.push('admitIntake'); return true; },
    readResumeFileHandle: (info) => {
      trace.push('readResumeFileHandle');
      const rec = info as { resumeFileHandle?: { handle?: unknown } };
      return typeof rec.resumeFileHandle?.handle === 'string' ? rec.resumeFileHandle.handle : null;
    },
    materializeShell: async () => { trace.push('materializeShell'); return { status: 'reused', candidateId: CANDIDATE_ID }; },
    legacyBrowserScreeningEnabled: () => { trace.push('legacyBrowserScreeningEnabled'); return true; },
  };
  const result = await runImport(APP_ID, deps);
  return { result, trace, storeTrace: stores.trace };
}

function existingLink(over: Partial<ExistingLinkRow> = {}): ExistingLinkRow {
  return {
    id: LINK_ID, externalApplicationId: APP_ID, terminalState: null,
    externalResumeFileHandle: null, externalCandidateId: null, ...over,
  };
}

describe('2. runImport skips a public booking import before any read or write after the lookup', () => {
  for (const variant of [
    { name: 'no handle, browser mapping', withHandle: false, screeningMode: 'browser_primary' as const },
    { name: 'a resume handle now on the application, phone_primary mapping', withHandle: true, screeningMode: 'phone_primary' as const },
  ]) {
    it(`answers skipped/r1_public_booking and calls nothing else (${variant.name})`, async () => {
      const { result, trace, storeTrace } = await importWith({
        existing: existingLink({ intakeType: R1 }),
        withHandle: variant.withHandle,
        screeningMode: variant.screeningMode,
      });
      expect(result).toEqual({ status: 'skipped', reason: R1 });
      // application.info is read first (it names the application); after the
      // lookup NOTHING runs: no mapping, admission, candidate.info, handle
      // read, bind, link, ingestion row, shell or operation.
      expect(trace).toEqual(['applicationInfo']);
      expect(storeTrace).toEqual(['findLinkByApplicationId']);
    });
  }

  it('the decision does not depend on the link\'s other columns', async () => {
    const { result, storeTrace } = await importWith({
      existing: existingLink({ intakeType: R1, externalCandidateId: ASHBY_CANDIDATE_ID, externalResumeFileHandle: null }),
      withHandle: true,
      screeningMode: 'phone_primary',
    });
    expect(result).toEqual({ status: 'skipped', reason: R1 });
    expect(storeTrace).toEqual(['findLinkByApplicationId']);
  });

  it('a terminal public booking import still answers terminal (the terminal check comes first)', async () => {
    const { result, trace, storeTrace } = await importWith({
      existing: existingLink({ intakeType: R1, terminalState: 'withdrawn' }),
    });
    expect(result).toEqual({ status: 'skipped', reason: 'terminal' });
    expect(trace).toEqual(['applicationInfo']);
    expect(storeTrace).toEqual(['findLinkByApplicationId']);
  });

  it('control: a resume_parsing reuse runs exactly as before (binds the late handle, seeds, enqueues)', async () => {
    const { result, trace, storeTrace } = await importWith({
      existing: existingLink({ intakeType: 'resume_parsing' }),
      withHandle: true,
    });
    expect(result).toMatchObject({ status: 'imported', reused: true, applicationLinkId: LINK_ID, candidateId: CANDIDATE_ID });
    expect(trace).toEqual([
      'applicationInfo', 'resolveMapping', 'admitIntake', 'readResumeFileHandle',
      'materializeShell', 'legacyBrowserScreeningEnabled',
    ]);
    expect(storeTrace).toEqual([
      'findLinkByApplicationId', 'bindLinkResumeHandle', 'bindLinkSubmittedAt', 'bindLinkExternalCandidateId',
      'advanceIngestion:queued', 'enqueueOperation', 'enqueueOperation',
    ]);
  });

  it('control: a phone_parsing reuse still refuses the late resume and says so', async () => {
    const { result, storeTrace } = await (async () => {
      let out: Awaited<ReturnType<typeof importWith>> | undefined;
      const { lines } = await captureLogs(async () => {
        out = await importWith({ existing: existingLink({ intakeType: 'phone_parsing' }), withHandle: true });
      });
      expect(entries(lines).filter((e) => e.error_category === 'ashby_late_resume_ignored').map((e) => e.error_type))
        .toEqual(['phone_parsing']);
      return out!;
    })();
    expect(result).toMatchObject({ status: 'imported', reused: true });
    expect(storeTrace).not.toContain('bindLinkResumeHandle');
    expect(storeTrace).toContain('advanceIngestion:queued');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Handler harness shared by 3-5
// ═══════════════════════════════════════════════════════════════════════

interface Enqueued { name: string; payload: unknown; options?: unknown }

function baseLink(over: Partial<WorkflowLinkRow> = {}): WorkflowLinkRow {
  return {
    id: LINK_ID, externalApplicationId: APP_ID, externalJobId: 'job_1',
    externalResumeFileHandle: null, jobMappingId: 'map_1',
    candidateId: CANDIDATE_ID, sessionId: null, inviteId: null,
    lifecycle: 'imported', terminalState: null, ...over,
  };
}

interface World {
  existing: ExistingLinkRow | null;
  link: WorkflowLinkRow;
  ingestion: { state: string; attempts: number } | null;
  trace: string[];
  enqueued: Enqueued[];
  scannerCalls: number;
}

function world(over: Partial<World> = {}): World {
  return {
    existing: existingLink({ intakeType: R1 }),
    link: baseLink({ intakeType: R1 }),
    ingestion: null,
    trace: [],
    enqueued: [],
    scannerCalls: 0,
    ...over,
  };
}

/** A runtime whose every seam records its name; the handlers get nothing else. */
function runtimeFor(w: World) {
  const rec = (name: string) => () => { w.trace.push(name); };
  return {
    runtimeConfig: {},
    client: {
      applicationInfo: async () => {
        w.trace.push('client.applicationInfo');
        return {
          results: {
            id: APP_ID, status: 'Active', job: { id: 'job_1' }, currentInterviewStage: { id: AI_STAGE },
            candidate: { id: ASHBY_CANDIDATE_ID },
          },
        };
      },
      candidateInfo: async () => { w.trace.push('client.candidateInfo'); return { results: { id: ASHBY_CANDIDATE_ID } }; },
    },
    resolveMappingByJobId: async () => {
      w.trace.push('resolveMappingByJobId');
      return {
        id: 'map_1', status: 'enabled', aiScreeningStageId: AI_STAGE,
        deliveryMode: 'manual', screeningMode: 'phone_primary', activationAt: '2026-10-01T00:00:00Z',
      };
    },
    resolveMappingForLink: async () => { w.trace.push('resolveMappingForLink'); return null; },
    isSnapshotApplicationAuthorized: async () => { w.trace.push('isSnapshotApplicationAuthorized'); return true; },
    isExplicitImportAuthorized: async () => { w.trace.push('isExplicitImportAuthorized'); return false; },
    receipts: {
      markStatus: async () => { w.trace.push('receipts.markStatus'); return { status: 'ok' }; },
    },
    materialization: {},
    buildIngestionPorts: async () => { w.trace.push('buildIngestionPorts'); return { status: 'url_unresolved' }; },
    stores: {
      findLinkByApplicationId: async () => { w.trace.push('stores.findLinkByApplicationId'); return w.existing; },
      createLink: async () => { w.trace.push('stores.createLink'); return { id: LINK_ID }; },
      bindLinkResumeHandle: async () => rec('stores.bindLinkResumeHandle')(),
      bindLinkSubmittedAt: async () => rec('stores.bindLinkSubmittedAt')(),
      bindLinkExternalCandidateId: async () => rec('stores.bindLinkExternalCandidateId')(),
      advanceIngestion: async (_id: string, state: string) => {
        w.trace.push(`stores.advanceIngestion:${state}`);
        return { status: 'ok' };
      },
      enqueueOperation: async () => { w.trace.push('stores.enqueueOperation'); return { status: 'inserted' }; },
      readLink: async () => { w.trace.push('stores.readLink'); return w.link; },
      readIngestion: async () => { w.trace.push('stores.readIngestion'); return w.ingestion; },
      recordAshbyProfileOutcome: async () => rec('stores.recordAshbyProfileOutcome')(),
      applyAshbyCandidateProfile: async () => {
        w.trace.push('stores.applyAshbyCandidateProfile');
        return {
          status: 'eligible', profileOutcome: 'applied', numberApplied: true, identityApplied: true, intakeStamped: true,
        };
      },
      ensurePhoneEngagement: async () => { w.trace.push('stores.ensurePhoneEngagement'); return { status: 'eligible' }; },
      deferPhoneDialForQuestions: async () => { w.trace.push('stores.deferPhoneDialForQuestions'); return { status: 'deferred' }; },
    },
    queue: {
      enqueue: async (name: string, payload: unknown, options?: unknown) => {
        w.trace.push(`queue.enqueue:${name}`);
        w.enqueued.push({ name, payload, options });
        return { id: `job_${w.enqueued.length}` };
      },
    },
  } as never;
}

function handlersFor(w: World, phoneParsingEnabled: boolean) {
  return buildAshbyHandlers(runtimeFor(w), {
    phoneParsingEnabled,
    nowMs: () => NOW_MS,
    scannerGate: async () => { w.scannerCalls += 1; return { action: 'proceed', mode: 'clamav' }; },
  } as never);
}

function job(name: string, payload: unknown) {
  return {
    id: 'job_x', name, payload, attempts: 1, maxAttempts: 5, createdAt: new Date(NOW_MS).toISOString(),
  } as never;
}

// ═══════════════════════════════════════════════════════════════════════
// 3. The import handler
// ═══════════════════════════════════════════════════════════════════════

describe('3. the import handler logs the skip and does nothing else', () => {
  for (const enabled of [true, false]) {
    it(`a stage webhook or reconciliation for a public booking import (switch ${enabled ? 'on' : 'off'})`, async () => {
      const w = world();
      const { lines, error } = await captureLogs(() => handlersFor(w, enabled)[ASHBY_IMPORT_QUEUE]!(
        job(ASHBY_IMPORT_QUEUE, { externalApplicationId: APP_ID, jobId: 'job_1', stageId: AI_STAGE, source: 'webhook' }),
      ));
      expect(error).toBeNull();
      expect(w.trace).toEqual(['client.applicationInfo', 'stores.findLinkByApplicationId']);
      // No profile job, no ingestion job, and the receipt is not reopened.
      expect(w.enqueued).toEqual([]);
      expect(w.trace).not.toContain('receipts.markStatus');
      const skipped = entries(lines).filter((e) => e.error_category === 'ashby_import_skipped');
      expect(skipped).toHaveLength(1);
      expect({ error_category: skipped[0]!.error_category, error_type: skipped[0]!.error_type })
        .toEqual({ error_category: 'ashby_import_skipped', error_type: R1 });
      expectNoIds(lines);
    });
  }

  it('control: any other skip does not log the public booking line', async () => {
    const w = world({ existing: existingLink({ intakeType: 'resume_parsing', terminalState: 'withdrawn' }) });
    const { lines } = await captureLogs(() => handlersFor(w, true)[ASHBY_IMPORT_QUEUE]!(
      job(ASHBY_IMPORT_QUEUE, { externalApplicationId: APP_ID }),
    ));
    expect(entries(lines).filter((e) => e.error_category === 'ashby_import_skipped')).toEqual([]);
    expect(w.enqueued).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. The profile job
// ═══════════════════════════════════════════════════════════════════════

describe('4. the profile job never profiles a public booking import', () => {
  for (const handle of [null, HANDLE]) {
    it(`switch on: no Ashby read, no outcome, no RPC (${handle ? 'with' : 'without'} a handle)`, async () => {
      const w = world({ link: baseLink({ intakeType: R1, externalResumeFileHandle: handle }) });
      const { lines, error } = await captureLogs(() => handlersFor(w, true)[ASHBY_PROFILE_QUEUE]!(
        job(ASHBY_PROFILE_QUEUE, { applicationLinkId: LINK_ID }),
      ));
      expect(error).toBeNull();
      expect(w.trace).toEqual(['stores.readLink']);
      expect(w.enqueued).toEqual([]);
      const skipped = entries(lines).filter((e) => e.error_category === 'ashby_profile_skipped');
      expect(skipped.map((e) => e.error_type)).toEqual([R1]);
      expect(entries(lines).filter((e) => e.error_category === 'ashby_profile_outcome')).toEqual([]);
      expectNoIds(lines);
    });
  }

  it('switch off: a no-op that reads nothing at all', async () => {
    const w = world();
    const { lines, error } = await captureLogs(() => handlersFor(w, false)[ASHBY_PROFILE_QUEUE]!(
      job(ASHBY_PROFILE_QUEUE, { applicationLinkId: LINK_ID }),
    ));
    expect(error).toBeNull();
    expect(w.trace).toEqual([]);
    expect(w.enqueued).toEqual([]);
    expect(lines.join('\n')).not.toContain(R1);
  });

  it('control: a phone_parsing link with the same shape is still profiled', async () => {
    const w = world({ link: baseLink({ intakeType: 'phone_parsing' }) });
    await captureLogs(() => handlersFor(w, true)[ASHBY_PROFILE_QUEUE]!(
      job(ASHBY_PROFILE_QUEUE, { applicationLinkId: LINK_ID }),
    ));
    expect(w.trace).toContain('client.applicationInfo');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. The ingestion handler
// ═══════════════════════════════════════════════════════════════════════

describe('5. the ingestion handler returns before the ports, the scanner and the provider', () => {
  for (const enabled of [true, false]) {
    for (const handle of [null, HANDLE]) {
      it(`switch ${enabled ? 'on' : 'off'}, ${handle ? 'with' : 'without'} a handle`, async () => {
        const w = world({ link: baseLink({ intakeType: R1, externalResumeFileHandle: handle }) });
        const { lines, error } = await captureLogs(() => handlersFor(w, enabled)[ASHBY_INGESTION_QUEUE]!(
          job(ASHBY_INGESTION_QUEUE, { applicationLinkId: LINK_ID }),
        ));
        expect(error).toBeNull();
        expect(w.trace).toEqual(['stores.readLink', 'stores.readIngestion']);
        expect(w.scannerCalls).toBe(0);
        expect(w.enqueued).toEqual([]);
        const skipped = entries(lines).filter((e) => e.error_category === 'ashby_ingestion_skipped');
        expect(skipped.map((e) => e.error_type)).toEqual([R1]);
        expect(entries(lines).filter((e) => e.error_category === 'ashby_late_resume_ignored')).toEqual([]);
        expectNoIds(lines);
      });
    }
  }

  it('control: a resume_parsing link with a handle still builds its ports', async () => {
    const w = world({
      link: baseLink({ intakeType: 'resume_parsing', externalResumeFileHandle: HANDLE }),
      ingestion: { state: 'queued', attempts: 0 },
    });
    await captureLogs(() => handlersFor(w, true)[ASHBY_INGESTION_QUEUE]!(
      job(ASHBY_INGESTION_QUEUE, { applicationLinkId: LINK_ID }),
    ));
    expect(w.trace).toContain('buildIngestionPorts');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 6. Stores and staff projections
// ═══════════════════════════════════════════════════════════════════════

/** A recording PostgREST double: every builder call is captured in order. */
function recordingClient(answer: { data: unknown; error: unknown }) {
  const ops: Array<[string, ...unknown[]]> = [];
  const builder: Record<string, unknown> = {};
  for (const m of ['insert', 'update', 'select', 'eq', 'is', 'limit', 'single', 'maybeSingle']) {
    builder[m] = (...args: unknown[]) => { ops.push([m, ...args]); return builder; };
  }
  builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve(answer).then(resolve);
  const client = {
    from(table: string) { ops.push(['from', table]); return builder; },
    rpc(name: string, params: unknown) { ops.push(['rpc', name, params]); return Promise.resolve(answer); },
  } as unknown as SupabaseClient;
  return { client, ops };
}

const LINK_ROW = {
  id: LINK_ID, external_application_id: APP_ID, external_job_id: 'job_1', job_mapping_id: 'map_1',
  candidate_id: CANDIDATE_ID, session_id: null, invite_id: null, lifecycle: 'imported',
  terminal_state: null, external_resume_file_handle: null, external_candidate_id: ASHBY_CANDIDATE_ID,
  intake_type: R1,
};

/** The Mission Control list double (the mission-control-ingestion-state pattern). */
function missionControlClient(linkRows: Array<Record<string, unknown>>) {
  const from = vi.fn(() => {
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    builder.select = () => chain();
    builder.eq = () => chain();
    builder.order = () => chain();
    builder.in = () => chain();
    builder.limit = () => Promise.resolve({ data: linkRows, error: null });
    (builder as { then?: unknown }).then = (res: (v: unknown) => unknown) => res({ data: [], error: null });
    return builder;
  });
  return { from } as never;
}

describe('6. the stores read the value; every staff projection shows null', () => {
  it('readLink and findLinkByApplicationId map r1_public_booking (the pipeline can fence it)', async () => {
    const a = recordingClient({ data: LINK_ROW, error: null });
    expect((await createWorkflowStores(a.client).readLink(LINK_ID))?.intakeType).toBe(R1);
    const b = recordingClient({ data: LINK_ROW, error: null });
    expect((await createWorkflowStores(b.client).findLinkByApplicationId(APP_ID))?.intakeType).toBe(R1);
  });

  it('projectIntakeType: the two screening intakes map to themselves, r1_public_booking and the rest to null', () => {
    expect(projectIntakeType('resume_parsing')).toBe('resume_parsing');
    expect(projectIntakeType('phone_parsing')).toBe('phone_parsing');
    expect(projectIntakeType(R1)).toBeNull();
    for (const bad of [undefined, null, '', 'other', 7]) expect(projectIntakeType(bad)).toBeNull();
  });

  it('Mission Control lists an r1_public_booking link with intakeType null', async () => {
    const row = {
      id: LINK_ID, external_application_id: APP_ID, external_job_id: 'job_1', lifecycle: 'imported',
      terminal_state: null, session_id: null, updated_at: '2026-12-01T04:00:00.000Z',
      intake_type: R1, profile_outcome: null, ashby_resume_ingestions: null, ashby_operations: [],
    };
    const control = { ...row, id: 'link_ctrl', intake_type: 'phone_parsing' };
    const out = await createMissionControlStore(missionControlClient([row, control])).listWorkflows(50);
    expect(out.map((w) => w.intakeType)).toEqual([null, 'phone_parsing']);
  });

  it('the candidate workflow card projects it to null', () => {
    const view = projectCandidateWorkflow({ lifecycle: 'imported', intake_type: R1, profile_outcome: null }, null);
    expect(view.intakeType).toBeNull();
    expect(view.ingestionState).toBeNull();
  });

  it('resolveIntakeType: a public booking link is null, and wins over a resume on file', () => {
    expect(resolveIntakeType({ intakeType: projectIntakeType(R1) }, '33333333-3333-4333-8333-333333333333')).toBeNull();
    expect(resolveIntakeType({ intakeType: projectIntakeType(R1) }, null)).toBeNull();
  });
});

// ── 6b. The candidate list and detail, through the real routes ──────────────

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTAwMSIsImFhbCI6ImFhbDIifQ.signature';
const AUTH = 'Bearer ' + JWT;
const admin: AuthUser = {
  id: 'user-admin-0000-0000-000000000001', email: 'admin@example.com',
  aal: 'aal2', active: true, appRole: 'admin', orgId: 'org-0000-0000-0000-000000000001',
};

function chain(value: unknown): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  const methods = ['select', 'eq', 'in', 'insert', 'update', 'upsert', 'delete', 'neq', 'gt', 'gte', 'lt', 'lte',
    'is', 'not', 'order', 'limit', 'range', 'single', 'maybeSingle'];
  for (const m of methods) c[m] = () => chain(value);
  c.then = (resolve: (v: unknown) => unknown) => Promise.resolve(value).then(resolve);
  c.catch = (reject: (e: unknown) => unknown) => Promise.resolve(value).catch(reject);
  return c;
}

function configure(config: Record<string, unknown>): void {
  mockFrom.mockImplementation((table: string) => chain(config[table] ?? { data: null, error: null }));
}

function appFor(user: AuthUser) {
  return createApp({
    nodeEnv: 'test', webOrigin: 'http://localhost:5173',
    authDeps: { getUser: mockAuthGetUser(user, JWT) },
    auditSinkOverride: async () => {},
  });
}

const ok = (data: unknown) => ({ data, error: null });

/** A public booking shell, as the 0144 import writes it (role and owner from the mapping). */
const SHELL = {
  id: 'cand_shell_pub', name: 'Synthetic Person', email: 'synthetic.person@example.test', phone_e164: null,
  phone_valid: false, skills: [], experience_years: null, status: 'queued', role_id: 'role_1',
  created_at: '2026-12-01T04:00:00Z', decision_use_blocked_at: null, resume_id: null,
};

describe('6b. GET /api/candidates and /api/candidates/:id show no intake and no resume review for it', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('the list: intake_type null and resume_review null (the import has no ingestion row)', async () => {
    for (const embed of [null, [], undefined]) {
      configure({
        candidates: ok([SHELL]),
        assessments: ok([]),
        ashby_application_links: ok([{
          candidate_id: SHELL.id, updated_at: '2026-12-01T04:00:00Z', job_mapping_id: null, intake_type: R1,
          ...(embed === undefined ? {} : { ashby_resume_ingestions: embed }),
        }]),
      });
      const res = await request(appFor(admin)).get('/api/candidates').set('Authorization', AUTH);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].intake_type, String(embed)).toBeNull();
      expect(res.body[0].resume_review, String(embed)).toBeNull();
      expect(JSON.stringify(res.body)).not.toContain(R1);
    }
  });

  it('the list: an adopted candidate with a resume on file whose newest link is the import reads null', async () => {
    configure({
      candidates: ok([{ ...SHELL, resume_id: '33333333-3333-4333-8333-333333333333' }]),
      assessments: ok([]),
      ashby_application_links: ok([
        { candidate_id: SHELL.id, updated_at: '2026-12-01T04:00:00Z', job_mapping_id: null, intake_type: R1, ashby_resume_ingestions: null },
        { candidate_id: SHELL.id, updated_at: '2026-09-01T00:00:00Z', job_mapping_id: null, intake_type: 'resume_parsing', ashby_resume_ingestions: { state: 'ready' } },
      ]),
    });
    const res = await request(appFor(admin)).get('/api/candidates').set('Authorization', AUTH);
    expect(res.body[0].intake_type).toBeNull();
    expect(res.body[0].resume_review).toBeNull();
  });

  it('the detail: intake_type null, even with a resume on file', async () => {
    const CAND_ID = '00000000-0000-4000-8000-000000000144';
    for (const resume_id of [null, '33333333-3333-4333-8333-333333333333']) {
      configure({
        candidates: ok({ ...SHELL, id: CAND_ID, resume_id, owner_id: null, ashby_phone_applied_at: null }),
        ashby_application_links: ok({ intake_type: R1 }),
      });
      const res = await request(appFor(admin)).get(`/api/candidates/${CAND_ID}`).set('Authorization', AUTH);
      expect(res.status).toBe(200);
      expect(res.body.candidate.intake_type, String(resume_id)).toBeNull();
      expect(JSON.stringify(res.body)).not.toContain(R1);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 7. integrations/ashby stays outside the Meet modules
// ═══════════════════════════════════════════════════════════════════════

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
  });
}

describe('7. no file in integrations/ashby names the Meet module path or imports lib/r1', () => {
  it('scans every file', () => {
    const files = walk(path.join(API_SRC, 'integrations', 'ashby'));
    expect(files.length).toBeGreaterThan(20);
    const meetPath = ['r1', 'meet'].join('/');
    const libR1Import = /from\s+['"](?:\.\.\/)+lib\/r1(?:\/|['"])/;
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(text.includes(meetPath), path.basename(file)).toBe(false);
      expect(libR1Import.test(text), path.basename(file)).toBe(false);
    }
  });

  it('the fence words are in the four files this slice touched', () => {
    for (const name of ['orchestration.ts', 'workflow-stores.ts', 'candidate-workflow.ts', 'runtime-workers.ts']) {
      expect(readFileSync(path.join(API_SRC, 'integrations', 'ashby', name), 'utf8'), name).toContain(R1);
    }
  });
});
