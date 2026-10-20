/**
 * Phone parsing (M017, ADR-0018) at the two existing doors: the import and the
 * ingestion.
 *
 *   - The import enqueues a DELAYED profile job for an application with no
 *     resume, only while the switch is on and only for a phone_primary mapping.
 *   - The ingestion returns early for a link already stamped `phone_parsing`
 *     (always on), and asks the profile job for the Ashby number when a parsed
 *     resume left the engagement `phone_invalid` (D3, switch on), or when
 *     the resume could not be read and rests in `failed_review` (B3, switch
 *     on, delayed like the import's classification).
 *   - `runImport` refuses to bind a late resume onto a `phone_parsing` link
 *     and says so.
 *
 * And with the switch OFF, both handlers make exactly the calls they made
 * before phone parsing existed — pinned as a literal trace, so an extra read
 * or enqueue on the OFF path fails here.
 *
 * Synthetic data only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildAshbyHandlers,
  extractResumeHandle,
  ingestionDedupKey,
  profileDedupKey,
  ASHBY_INGESTION_QUEUE,
  ASHBY_PROFILE_QUEUE,
  PROFILE_CLASSIFY_DELAY_MS,
} from '../integrations/ashby/runtime-workers.js';
import { ASHBY_IMPORT_QUEUE } from '../integrations/ashby/signal-worker.js';
import { runImport, type ImportDeps, type WorkflowLinkRow } from '../integrations/ashby/orchestration.js';
import { CANDIDATE_QUESTIONS_QUEUE } from '../lib/candidate-question-jobs.js';
import type { MaterializationStore } from '../integrations/ashby/materialize.js';

const AI_STAGE = 'stage_ai';
const NOW_MS = Date.parse('2026-10-20T06:00:00.000Z');

interface Enqueued {
  name: string;
  payload: unknown;
  options?: { dedupKey?: string; maxAttempts?: number; scheduledAt?: string | Date };
}

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

function logged(lines: string[], category: string): Array<Record<string, unknown>> {
  return lines
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((e) => e.error_category === category);
}

function baseLink(over: Partial<WorkflowLinkRow> = {}): WorkflowLinkRow {
  return {
    id: 'link_1', externalApplicationId: 'app_1', externalJobId: 'job_1',
    externalResumeFileHandle: null, jobMappingId: 'map_1',
    candidateId: 'cand_1', sessionId: null, inviteId: null,
    lifecycle: 'imported', terminalState: null, ...over,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// The import handler
// ═══════════════════════════════════════════════════════════════════════

interface ImportWorld {
  link: WorkflowLinkRow;
  screeningMode: 'phone_primary' | 'browser_primary';
  trace: string[];
  enqueued: Enqueued[];
  readLinkThrows?: boolean;
  profileEnqueueThrows?: boolean;
}

function importRuntime(w: ImportWorld) {
  const store = {
    insertCandidateShell: async () => ({ id: 'cand_1' }),
    bindLinkColumn: async (input: { value: string }) => ({ bound: input.value, wonRace: true }),
    deleteOrphan: async () => {},
  } as unknown as MaterializationStore;
  return {
    runtimeConfig: {},
    client: {
      applicationInfo: async () => {
        w.trace.push('client.applicationInfo');
        return {
          results: {
            id: 'app_1', job: { id: 'job_1' }, currentInterviewStage: { id: AI_STAGE },
            candidate: { id: 'ashby_cand_1' },
          },
        };
      },
      candidateInfo: async () => {
        w.trace.push('client.candidateInfo');
        return { results: { id: 'ashby_cand_1', resumeFileHandle: null } };
      },
    },
    materialization: store,
    resolveMappingByJobId: async () => {
      w.trace.push('resolveMappingByJobId');
      return {
        id: 'map_1', status: 'enabled', aiScreeningStageId: AI_STAGE,
        deliveryMode: 'manual', screeningMode: w.screeningMode,
        activationAt: '2026-10-01T00:00:00Z',
      };
    },
    resolveMappingForLink: async () => {
      w.trace.push('resolveMappingForLink');
      return { id: 'map_1', roleId: 'role_1', ownerId: 'owner_1', deliveryMode: 'manual' };
    },
    // The snapshot authorizer admits the application, so no history read.
    isSnapshotApplicationAuthorized: async () => true,
    isExplicitImportAuthorized: async () => false,
    stores: {
      findLinkByApplicationId: async () => { w.trace.push('stores.findLinkByApplicationId'); return null; },
      createLink: async () => { w.trace.push('stores.createLink'); return { id: 'link_1' }; },
      advanceIngestion: async (_id: string, state: string) => {
        w.trace.push(`stores.advanceIngestion:${state}`);
        return { status: 'ok' };
      },
      enqueueOperation: async () => { w.trace.push('stores.enqueueOperation'); return { status: 'inserted' }; },
      readIngestion: async () => { w.trace.push('stores.readIngestion'); return { state: 'queued', attempts: 0 }; },
      readLink: async () => {
        w.trace.push('stores.readLink');
        if (w.readLinkThrows) throw new Error('ashby_link_read_error');
        return w.link;
      },
    },
    queue: {
      enqueue: async (name: string, payload: unknown, options?: Enqueued['options']) => {
        w.trace.push(`queue.enqueue:${name}`);
        if (w.profileEnqueueThrows && name === ASHBY_PROFILE_QUEUE) throw new Error('queue_unavailable');
        w.enqueued.push({ name, payload, options });
        return { id: `job_${w.enqueued.length}` };
      },
    },
  } as never;
}

function importWorld(over: Partial<ImportWorld> = {}): ImportWorld {
  return { link: baseLink(), screeningMode: 'phone_primary', trace: [], enqueued: [], ...over };
}

async function runImportJob(w: ImportWorld, enabled: boolean | undefined) {
  const handlers = buildAshbyHandlers(importRuntime(w), {
    ...(enabled === undefined ? {} : { phoneParsingEnabled: enabled }),
    nowMs: () => NOW_MS,
  });
  return handlers[ASHBY_IMPORT_QUEUE]!({
    id: 'job_i', name: ASHBY_IMPORT_QUEUE, payload: { externalApplicationId: 'app_1' },
    attempts: 1, maxAttempts: 5, createdAt: new Date(NOW_MS).toISOString(),
  } as never);
}

/** What the import handler did before phone parsing existed, call for call. */
const IMPORT_TRACE_TODAY = [
  'client.applicationInfo',
  'stores.findLinkByApplicationId',
  'resolveMappingByJobId',
  'client.candidateInfo',
  'stores.createLink',
  'stores.advanceIngestion:queued',
  'stores.readLink',
  'resolveMappingForLink',
  'stores.readIngestion',
  `queue.enqueue:${ASHBY_INGESTION_QUEUE}`,
];

const INGESTION_ENQUEUE: Enqueued = {
  name: ASHBY_INGESTION_QUEUE,
  payload: { provider: 'ashby', applicationLinkId: 'link_1' },
  options: { dedupKey: ingestionDedupKey('link_1'), maxAttempts: 5 },
};

describe('the import handler', () => {
  it('switch OFF: exactly today\'s calls, and no profile job', async () => {
    for (const enabled of [false, undefined]) {
      const w = importWorld();
      await runImportJob(w, enabled);
      expect(w.trace, String(enabled)).toEqual(IMPORT_TRACE_TODAY);
      expect(w.enqueued, String(enabled)).toEqual([INGESTION_ENQUEUE]);
    }
  });

  it('switch ON, no handle, phone_primary: a DELAYED profile job, link id only', async () => {
    const w = importWorld();
    await runImportJob(w, true);
    expect(w.enqueued).toEqual([
      {
        name: ASHBY_PROFILE_QUEUE,
        payload: { applicationLinkId: 'link_1' },
        options: {
          dedupKey: profileDedupKey('link_1'),
          maxAttempts: 3,
          scheduledAt: new Date(NOW_MS + PROFILE_CLASSIFY_DELAY_MS).toISOString(),
        },
      },
      // The ingestion enqueue is unchanged.
      INGESTION_ENQUEUE,
    ]);
    expect(Object.keys(w.enqueued[0]!.payload as object)).toEqual(['applicationLinkId']);
    // The ON path adds the link read, the mapping read and the enqueue, and
    // nothing else; the rest of the trace is today's, in today's order.
    const added = ['stores.readLink', 'resolveMappingByJobId', `queue.enqueue:${ASHBY_PROFILE_QUEUE}`];
    const extra = [...w.trace];
    for (const call of added) extra.splice(extra.lastIndexOf(call), 1);
    expect(extra).toEqual(IMPORT_TRACE_TODAY);
  });

  it('switch ON, but the link has a resume handle: no profile job', async () => {
    const w = importWorld({ link: baseLink({ externalResumeFileHandle: 'handle_1' }) });
    await runImportJob(w, true);
    expect(w.enqueued).toEqual([INGESTION_ENQUEUE]);
  });

  it('switch ON, but the link is already phone parsing: no profile job', async () => {
    const w = importWorld({ link: baseLink({ intakeType: 'phone_parsing' }) });
    await runImportJob(w, true);
    expect(w.enqueued).toEqual([INGESTION_ENQUEUE]);
  });

  it('switch ON, but the mapping is not phone_primary: no profile job', async () => {
    const w = importWorld({ screeningMode: 'browser_primary' });
    await runImportJob(w, true);
    expect(w.enqueued.map((e) => e.name)).not.toContain(ASHBY_PROFILE_QUEUE);
  });

  it('BEST EFFORT: a failed link read or enqueue is logged, and the import still completes', async () => {
    for (const over of [{ readLinkThrows: true }, { profileEnqueueThrows: true }]) {
      const w = importWorld(over);
      let readLinkCalls = 0;
      const runtime = importRuntime(w) as unknown as { stores: { readLink: () => Promise<unknown> } };
      const realReadLink = runtime.stores.readLink;
      // The shell's own read must still succeed; only the profile read fails.
      runtime.stores.readLink = async () => {
        readLinkCalls += 1;
        if (readLinkCalls === 1) return baseLink();
        return realReadLink();
      };
      const handlers = buildAshbyHandlers(runtime as never, { phoneParsingEnabled: true, nowMs: () => NOW_MS });
      const { lines, error } = await captureLogs(() => handlers[ASHBY_IMPORT_QUEUE]!({
        id: 'job_i', name: ASHBY_IMPORT_QUEUE, payload: { externalApplicationId: 'app_1' },
        attempts: 1, maxAttempts: 5, createdAt: new Date(NOW_MS).toISOString(),
      } as never));
      expect(error).toBeNull();
      expect(w.enqueued).toEqual([INGESTION_ENQUEUE]);
      expect(logged(lines, 'ashby_profile_enqueue_failed').map((e) => e.error_type)).toEqual(['import']);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// The ingestion handler
// ═══════════════════════════════════════════════════════════════════════

interface IngestionWorld {
  link: WorkflowLinkRow;
  engagementStatus: string;
  trace: string[];
  enqueued: Enqueued[];
  scannerCalls: number;
  profileEnqueueThrows?: boolean;
  /** The mapping the job resolves to (the B3 trigger reads it). */
  screeningMode?: 'phone_primary' | 'browser_primary';
  mappingReadThrows?: boolean;
  /** B3: end the pipeline on a scan verdict, or fail before it starts. */
  scanInfected?: boolean;
  portsStatus?: 'url_unresolved';
  /** B3: a document verdict from the magic/MIME guard. */
  guardRejected?: boolean;
  /** R1-1: machine-class pipeline failures (a transport timeout, a stdout protocol fault). */
  fetchFails?: boolean;
  parseBadOutput?: boolean;
  /** The ingestion row the handler first reads (default `queued`). */
  initialIngestion?: { state: string; attempts: number; failedReason?: string | null };
}

function ingestionRuntime(w: IngestionWorld) {
  let ingestion: { state: string; attempts: number; failedReason?: string | null } | null =
    w.initialIngestion ?? { state: 'queued', attempts: 0 };
  const parsed = {
    name: 'Test Person', email: 'test.person@example.invalid', phone: null,
    skills: ['Outbound calling'], experience_years: 5,
    current_role: 'Inside Sales Lead', summary: 'Synthetic.',
  };
  return {
    runtimeConfig: {},
    queue: {
      enqueue: async (name: string, payload: unknown, options?: Enqueued['options']) => {
        w.trace.push(`queue.enqueue:${name}`);
        if (w.profileEnqueueThrows && name === ASHBY_PROFILE_QUEUE) throw new Error('queue_unavailable');
        w.enqueued.push({ name, payload, options });
        return { id: `job_${w.enqueued.length}` };
      },
    },
    stores: {
      readLink: async () => { w.trace.push('stores.readLink'); return w.link; },
      readIngestion: async () => { w.trace.push('stores.readIngestion'); return ingestion; },
      advanceIngestion: async (_id: string, state: string) => {
        w.trace.push(`stores.advanceIngestion:${state}`);
        ingestion = { state, attempts: 0 };
        return { status: 'ok' };
      },
      ensurePhoneEngagement: async () => {
        w.trace.push('stores.ensurePhoneEngagement');
        return { status: w.engagementStatus, engagementId: 'eng_1' };
      },
      deferPhoneDialForQuestions: async () => {
        w.trace.push('stores.deferPhoneDialForQuestions');
        return { status: 'deferred' };
      },
    },
    resolveMappingByJobId: async () => {
      w.trace.push('resolveMappingByJobId');
      if (w.mappingReadThrows) throw new Error('ashby_mapping_read_error');
      return {
        id: 'map_1', status: 'enabled', aiScreeningStageId: AI_STAGE,
        deliveryMode: 'manual', screeningMode: w.screeningMode ?? 'phone_primary',
      };
    },
    buildIngestionPorts: async (input: { onState: (s: string, p?: unknown) => Promise<void> }) => {
      w.trace.push('buildIngestionPorts');
      if (w.portsStatus) return { status: w.portsStatus };
      return {
        status: 'ok' as const,
        ports: {
          presignedUrl: 'https://host.example/r.pdf',
          policy: { allowlistEnabled: true, allowedHosts: ['host.example'], allowedPorts: [443] },
          fetch: async () => (w.fetchFails
            ? { ok: false as const, reason: 'timeout', hops: 0 }
            : {
              ok: true as const, bytes: Buffer.from('resume'), sha256: 'a'.repeat(64),
              contentType: 'application/pdf', finalHost: 'host.example', hops: 0,
            }),
          scan: async () => (w.scanInfected
            ? { safe: false, status: 'infected' }
            : { safe: true, status: 'clean' }),
          guard: () => (w.guardRejected
            ? { ok: false as const, reason: 'magic_mismatch' }
            : { ok: true as const, mime: 'application/pdf' }),
          parse: async () => {
            if (w.parseBadOutput) {
              throw Object.assign(new Error('parser'), { code: 'PARSER_ERROR', detail: 'bad_output' });
            }
            return { text: 'resume text', structurerVersion: 'v1', structured: parsed };
          },
          fallbackFromText: () => parsed,
          persist: async () => ({ status: 'ok' as const }),
          onState: input.onState,
          extractorVersion: 'x1',
          classifyScan: () => 'verdict',
        },
      };
    },
    resolveMappingForLink: async () => null,
    materialization: {} as MaterializationStore,
  } as never;
}

function ingestionWorld(over: Partial<IngestionWorld> = {}): IngestionWorld {
  return {
    link: baseLink({ externalResumeFileHandle: 'handle_1', candidateId: null }),
    engagementStatus: 'phone_invalid',
    trace: [],
    enqueued: [],
    scannerCalls: 0,
    ...over,
  };
}

async function runIngestion(w: IngestionWorld, enabled: boolean | undefined) {
  const handlers = buildAshbyHandlers(ingestionRuntime(w), {
    ...(enabled === undefined ? {} : { phoneParsingEnabled: enabled }),
    scannerGate: async () => { w.scannerCalls += 1; return { action: 'proceed', mode: 'clamav' }; },
    nowMs: () => NOW_MS,
  });
  return handlers[ASHBY_INGESTION_QUEUE]!({
    id: 'job_g', name: ASHBY_INGESTION_QUEUE, payload: { applicationLinkId: 'link_1' },
    attempts: 1, maxAttempts: 5, createdAt: new Date(NOW_MS).toISOString(),
  } as never);
}

/**
 * What the ingestion did before phone parsing, for a parse that ends
 * `phone_invalid`. The extra link reads are the pipeline's own cancellation
 * polls and the persist step's re-read.
 */
const INGESTION_TRACE_TODAY = [
  'stores.readLink',
  'stores.readIngestion',
  'stores.advanceIngestion:fetching',
  'buildIngestionPorts',
  'stores.readLink',
  'stores.advanceIngestion:fetching',
  'stores.readLink',
  'stores.advanceIngestion:scanning',
  'stores.advanceIngestion:extracting',
  'stores.advanceIngestion:structuring',
  'stores.readLink',
  'stores.advanceIngestion:ready',
  'stores.ensurePhoneEngagement',
];

const ORIGINAL_QUESTIONS = process.env.CANDIDATE_QUESTIONS_ENABLED;
beforeEach(() => {
  process.env.CANDIDATE_QUESTIONS_ENABLED = 'true';
});
afterEach(() => {
  if (ORIGINAL_QUESTIONS === undefined) delete process.env.CANDIDATE_QUESTIONS_ENABLED;
  else process.env.CANDIDATE_QUESTIONS_ENABLED = ORIGINAL_QUESTIONS;
});

describe('the ingestion guard: phone parsing owns the application', () => {
  for (const enabled of [true, false]) {
    it(`returns before the scanner and the provider (switch ${enabled ? 'on' : 'off'})`, async () => {
      const w = ingestionWorld({ link: baseLink({ intakeType: 'phone_parsing', externalResumeFileHandle: 'handle_late' }) });
      const { lines } = await captureLogs(() => runIngestion(w, enabled));
      expect(w.trace).toEqual(['stores.readLink', 'stores.readIngestion']);
      expect(w.scannerCalls).toBe(0);
      expect(w.enqueued).toEqual([]);
      expect(logged(lines, 'ashby_late_resume_ignored').map((e) => e.error_type)).toEqual(['ingestion']);
    });
  }

  it('a B3 link resting in failed_review returns quietly; one that something requeued is reported', async () => {
    const link = baseLink({ intakeType: 'phone_parsing', externalResumeFileHandle: 'handle_1' });
    const rested = ingestionWorld({
      link, initialIngestion: { state: 'failed_review', attempts: 1, failedReason: 'no_extractable_fields' },
    });
    const quiet = await captureLogs(() => runIngestion(rested, true));
    expect(rested.trace).toEqual(['stores.readLink', 'stores.readIngestion']);
    expect(logged(quiet.lines, 'ashby_phone_parsing_ingestion_requeued')).toEqual([]);

    // The handler never reads it, so a `queued` row would otherwise sit
    // there unseen: it is never left without a signal.
    const requeued = ingestionWorld({ link, initialIngestion: { state: 'queued', attempts: 2 } });
    const loud = await captureLogs(() => runIngestion(requeued, true));
    expect(requeued.trace).toEqual(['stores.readLink', 'stores.readIngestion']);
    expect(requeued.scannerCalls).toBe(0);
    expect(logged(loud.lines, 'ashby_phone_parsing_ingestion_requeued').map((e) => e.error_type))
      .toEqual(['queued']);
    expect(loud.lines.join('\n')).not.toContain('handle_1');
  });

  it('a stamped link with no handle returns silently', async () => {
    const w = ingestionWorld({ link: baseLink({ intakeType: 'phone_parsing', externalResumeFileHandle: null }) });
    const { lines } = await captureLogs(() => runIngestion(w, true));
    expect(w.trace).toEqual(['stores.readLink', 'stores.readIngestion']);
    expect(logged(lines, 'ashby_late_resume_ignored')).toEqual([]);
  });

  it('a resume_parsing link runs the pipeline as before', async () => {
    const w = ingestionWorld({ link: baseLink({ intakeType: 'resume_parsing', externalResumeFileHandle: 'handle_1', candidateId: null }) });
    await runIngestion(w, true);
    expect(w.scannerCalls).toBe(1);
    expect(w.trace).toContain('stores.advanceIngestion:ready');
  });
});

describe('the D3 trigger: a parsed resume with no dialable number', () => {
  it('switch ON and `phone_invalid`: the profile job is enqueued NOW, link id only', async () => {
    const w = ingestionWorld();
    await runIngestion(w, true);
    expect(w.enqueued).toEqual([{
      name: ASHBY_PROFILE_QUEUE,
      payload: { applicationLinkId: 'link_1' },
      options: { dedupKey: profileDedupKey('link_1'), maxAttempts: 3 },
    }]);
    expect(w.enqueued[0]!.options).not.toHaveProperty('scheduledAt');
  });

  it('switch OFF: exactly today\'s calls, and no profile job', async () => {
    for (const enabled of [false, undefined]) {
      const w = ingestionWorld();
      await runIngestion(w, enabled);
      expect(w.trace, String(enabled)).toEqual(INGESTION_TRACE_TODAY);
      expect(w.enqueued, String(enabled)).toEqual([]);
    }
  });

  for (const status of ['eligible', 'scheduled_next_window', 'engagement_active', 'consent_evidence_missing', 'duplicate_application']) {
    it(`does not fire on \`${status}\``, async () => {
      const w = ingestionWorld({ engagementStatus: status });
      await runIngestion(w, true);
      expect(w.enqueued.map((e) => e.name)).not.toContain(ASHBY_PROFILE_QUEUE);
    });
  }

  it('an admitted candidate still gets questions exactly as before', async () => {
    const w = ingestionWorld({ engagementStatus: 'eligible' });
    await runIngestion(w, true);
    expect(w.enqueued.map((e) => e.name)).toEqual([CANDIDATE_QUESTIONS_QUEUE]);
  });

  it('BEST EFFORT: a failed enqueue is logged and the ingestion still completes', async () => {
    const w = ingestionWorld({ profileEnqueueThrows: true });
    const { lines, error } = await captureLogs(() => runIngestion(w, true));
    expect(error).toBeNull();
    expect(logged(lines, 'ashby_profile_enqueue_failed').map((e) => e.error_type)).toEqual(['ingestion_ready']);
  });
});

describe('the B3 trigger: a resume that rests in `failed_review`', () => {
  /** The one profile job the trigger asks for: link id only, delayed, deduped. */
  const FALLBACK_ENQUEUE: Enqueued = {
    name: ASHBY_PROFILE_QUEUE,
    payload: { applicationLinkId: 'link_1' },
    options: {
      dedupKey: profileDedupKey('link_1'),
      maxAttempts: 3,
      scheduledAt: new Date(NOW_MS + PROFILE_CLASSIFY_DELAY_MS).toISOString(),
    },
  };
  const profileJobs = (w: IngestionWorld) => w.enqueued.filter((e) => e.name === ASHBY_PROFILE_QUEUE);

  it('switch ON, a scan verdict: the profile job is enqueued ONCE, delayed, link id only', async () => {
    const w = ingestionWorld({ scanInfected: true });
    await runIngestion(w, true);
    expect(w.trace).toContain('stores.advanceIngestion:failed_review');
    expect(w.trace).not.toContain('stores.ensurePhoneEngagement');
    expect(w.enqueued).toEqual([FALLBACK_ENQUEUE]);
    expect(Object.keys(w.enqueued[0]!.payload as object)).toEqual(['applicationLinkId']);
  });

  it('switch ON, a guard verdict: the same one job', async () => {
    const w = ingestionWorld({ guardRejected: true });
    await runIngestion(w, true);
    expect(w.trace).toContain('stores.advanceIngestion:failed_review');
    expect(w.enqueued).toEqual([FALLBACK_ENQUEUE]);
  });

  // R1-1: a machine-class rest is not an unreadable resume. The handler's own
  // failure writes (all machine-class) and the pipeline's transport or
  // protocol failures rest the row, but never ask for the fallback, and never
  // spend a mapping read on it.
  for (const [label, over] of [
    ['the handler\'s own failure write (fetch_url_unresolved)', { portsStatus: 'url_unresolved' as const }],
    ['a transport failure (fetch_timeout)', { fetchFails: true }],
    ['a stdout protocol fault (parse_bad_output)', { parseBadOutput: true }],
  ] as const) {
    it(`switch ON, ${label}: rests the row, no profile job`, async () => {
      const w = ingestionWorld(over);
      await runIngestion(w, true);
      expect(w.trace).toContain('stores.advanceIngestion:failed_review');
      expect(w.trace).not.toContain('resolveMappingByJobId');
      expect(profileJobs(w)).toEqual([]);
    });
  }

  it('switch OFF: no mapping read and no profile job', async () => {
    for (const enabled of [false, undefined]) {
      for (const over of [{ scanInfected: true }, { guardRejected: true }, { portsStatus: 'url_unresolved' as const }]) {
        const w = ingestionWorld(over);
        await runIngestion(w, enabled);
        expect(w.trace, String(enabled)).toContain('stores.advanceIngestion:failed_review');
        expect(w.trace, String(enabled)).not.toContain('resolveMappingByJobId');
        expect(w.enqueued, String(enabled)).toEqual([]);
      }
    }
  });

  it('switch ON, but the mapping is not phone_primary: no profile job', async () => {
    const w = ingestionWorld({ scanInfected: true, screeningMode: 'browser_primary' });
    await runIngestion(w, true);
    expect(profileJobs(w)).toEqual([]);
  });

  it('does not fire when the resume was READ, whatever the engagement says', async () => {
    const w = ingestionWorld({ engagementStatus: 'eligible' });
    await runIngestion(w, true);
    expect(w.trace).not.toContain('stores.advanceIngestion:failed_review');
    expect(w.trace).not.toContain('resolveMappingByJobId');
    expect(profileJobs(w)).toEqual([]);
  });

  it('BEST EFFORT: a failed enqueue or mapping read is logged, and the ingestion still completes', async () => {
    for (const over of [{ profileEnqueueThrows: true }, { mappingReadThrows: true }]) {
      const w = ingestionWorld({ scanInfected: true, ...over });
      const { lines, error } = await captureLogs(() => runIngestion(w, true));
      expect(error).toBeNull();
      expect(w.enqueued).toEqual([]);
      expect(logged(lines, 'ashby_profile_enqueue_failed').map((e) => e.error_type))
        .toEqual(['ingestion_failed_review']);
      const text = lines.join('\n');
      for (const fragment of ['Test Person', 'example.invalid', 'link_1']) {
        expect(text).not.toContain(fragment);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// runImport: a late resume on a phone-parsing link
// ═══════════════════════════════════════════════════════════════════════

describe('runImport: a resume that arrives after phone parsing was applied', () => {
  function deps(existing: { intakeType?: 'resume_parsing' | 'phone_parsing'; handle?: string | null }) {
    const binds: Array<{ linkId: string; handle: string }> = [];
    const d: ImportDeps = {
      gates: { enabled: true, email: { providerApproved: false, domainVerified: false } },
      client: {
        applicationInfo: async () => ({
          results: {
            id: 'app_1', job: { id: 'job_1' }, currentInterviewStage: { id: AI_STAGE },
            resumeFileHandle: 'handle_late',
          },
        }) as never,
      },
      resolveMapping: async () => ({
        id: 'map_1', status: 'enabled', aiScreeningStageId: AI_STAGE,
        deliveryMode: 'manual', screeningMode: 'phone_primary',
      }),
      readResumeFileHandle: (info) => extractResumeHandle(info),
      stores: {
        findLinkByApplicationId: async () => ({
          id: 'link_1', externalApplicationId: 'app_1', terminalState: null,
          externalResumeFileHandle: existing.handle ?? null,
          ...(existing.intakeType ? { intakeType: existing.intakeType } : {}),
        }),
        createLink: async () => { throw new Error('must reuse'); },
        advanceIngestion: async () => ({ status: 'ok' }),
        enqueueOperation: async () => ({ status: 'inserted' }),
        bindLinkResumeHandle: async (linkId: string, handle: string) => { binds.push({ linkId, handle }); },
      } as never,
    };
    return { d, binds };
  }

  it('does NOT bind it, and logs the refusal', async () => {
    const { d, binds } = deps({ intakeType: 'phone_parsing' });
    const { lines, error } = await captureLogs(() => runImport('app_1', d));
    expect(error).toBeNull();
    expect(binds).toEqual([]);
    expect(logged(lines, 'ashby_late_resume_ignored').map((e) => e.error_type)).toEqual(['phone_parsing']);
  });

  it('still binds it onto a resume_parsing link, or one whose store predates 0130', async () => {
    for (const intakeType of ['resume_parsing', undefined] as const) {
      const { d, binds } = deps({ intakeType });
      const { lines } = await captureLogs(() => runImport('app_1', d));
      expect(binds, String(intakeType)).toEqual([{ linkId: 'link_1', handle: 'handle_late' }]);
      expect(logged(lines, 'ashby_late_resume_ignored')).toEqual([]);
    }
  });

  it('logs nothing when the re-read carries no resume', async () => {
    const { d } = deps({ intakeType: 'phone_parsing' });
    d.readResumeFileHandle = () => null;
    const { lines } = await captureLogs(() => runImport('app_1', d));
    expect(logged(lines, 'ashby_late_resume_ignored')).toEqual([]);
  });
});
