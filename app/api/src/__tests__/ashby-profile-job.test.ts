/**
 * The `ashby.profile` job (M017, ADR-0018): phone parsing for an Ashby
 * application that arrived with no resume, and the Ashby number for a resume
 * whose own number was undialable (D3).
 *
 * Drives the REAL handler from `buildAshbyHandlers` against an in-memory
 * world, so every assertion is about what the job actually read, wrote and
 * enqueued — never about a helper in isolation. The one store seam whose
 * error mapping matters (`applyAshbyCandidateProfile`) is also driven through
 * the REAL production store over a fake database client.
 *
 * Synthetic data only: "Test Person", an `@example.invalid` address and a
 * +91 number that is not a placeholder pattern.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Registration is asserted on the runner `createAshbyWorkers` builds, so the
// runner factory records its options instead of polling a queue.
const capturedRunners = vi.hoisted(
  () => [] as Array<{ owner: string; handlers: Record<string, unknown> }>,
);
vi.mock('../lib/queue/runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/queue/runner.js')>();
  return {
    ...actual,
    createQueueRunner: (options: { owner: string; handlers: Record<string, unknown> }) => {
      capturedRunners.push({ owner: options.owner, handlers: options.handlers });
      return {
        tick: async () => 0,
        stop: async () => undefined,
        inFlight: () => 0,
      };
    },
  };
});

import {
  buildAshbyHandlers,
  classifyResumePresence,
  createAshbyWorkers,
  ASHBY_INGESTION_QUEUE,
  ASHBY_PROFILE_QUEUE,
  PROFILE_CLASSIFY_DELAY_MS,
  profileDedupKey,
  ingestionDedupKey,
} from '../integrations/ashby/runtime-workers.js';
import * as ashbyIndex from '../integrations/ashby/index.js';
import { createWorkflowStores } from '../integrations/ashby/workflow-stores.js';
import { CANDIDATE_QUESTIONS_QUEUE } from '../lib/candidate-question-jobs.js';
import type {
  AshbyCandidateProfileInput,
  AshbyCandidateProfileResult,
  ResolvedMapping,
  WorkflowLinkRow,
} from '../integrations/ashby/orchestration.js';

// ── Synthetic contact data. None of it may appear in a log line or a throw. ──
const NAME = 'Test Person';
const EMAIL = 'test.person@example.invalid';
const NUMBER_RAW = '+91 98123 45670';
const NUMBER_E164 = '+919812345670';
const PII_FRAGMENTS = ['Test Person', 'test.person', 'example.invalid', '9812345670', '98123'];

const AI_STAGE = 'stage_ai';
const LINK_ID = 'link_1';

interface Enqueued {
  name: string;
  payload: unknown;
  options?: { dedupKey?: string; maxAttempts?: number; scheduledAt?: string | Date };
}

interface World {
  link: WorkflowLinkRow | null;
  ingestion: { state: string; attempts: number; failedReason?: string | null } | null;
  applicationInfo: Record<string, unknown> | Error;
  candidateInfo: Record<string, unknown> | Error;
  mapping: ResolvedMapping;
  applyResult: AshbyCandidateProfileResult | Error;
  applyCalls: AshbyCandidateProfileInput[];
  outcomes: string[];
  binds: Array<{ linkId: string; handle: string }>;
  enqueued: Enqueued[];
  held: Array<{ engagementId: string; graceSeconds: number }>;
  applicationReads: number;
  candidateReads: number;
}

function baseLink(over: Partial<WorkflowLinkRow> = {}): WorkflowLinkRow {
  return {
    id: LINK_ID, externalApplicationId: 'app_1', externalJobId: 'job_1',
    externalResumeFileHandle: null, jobMappingId: 'map_1',
    candidateId: 'cand_1', sessionId: null, inviteId: null,
    lifecycle: 'imported', terminalState: null, ...over,
  };
}

/** `application.info` results at the AI stage, with the candidate embedded. */
function appInfo(over: Record<string, unknown> = {}, candidate: Record<string, unknown> = {}) {
  return {
    id: 'app_1',
    status: 'Active',
    job: { id: 'job_1' },
    currentInterviewStage: { id: AI_STAGE },
    candidate: {
      id: 'ashby_cand_1',
      name: NAME,
      primaryEmailAddress: { value: EMAIL },
      primaryPhoneNumber: { value: NUMBER_RAW },
      ...candidate,
    },
    ...over,
  };
}

function newWorld(over: Partial<World> = {}): World {
  return {
    link: baseLink(),
    ingestion: { state: 'queued', attempts: 0 },
    applicationInfo: appInfo(),
    // `candidate.info` saying, strictly, that there is no resume. It carries
    // no contact fields, so the profile comes from the embedded candidate.
    candidateInfo: { id: 'ashby_cand_1', resumeFileHandle: null },
    mapping: {
      id: 'map_1', status: 'enabled', aiScreeningStageId: AI_STAGE,
      deliveryMode: 'manual', screeningMode: 'phone_primary',
    },
    applyResult: {
      status: 'eligible', engagementId: 'eng_1', profileOutcome: 'applied',
      numberApplied: true, identityApplied: true, intakeStamped: true,
    },
    applyCalls: [],
    outcomes: [],
    binds: [],
    enqueued: [],
    held: [],
    applicationReads: 0,
    candidateReads: 0,
    ...over,
  };
}

function runtimeFor(w: World, storeOver: Record<string, unknown> = {}) {
  return {
    runtimeConfig: {},
    client: {
      applicationInfo: async () => {
        w.applicationReads += 1;
        if (w.applicationInfo instanceof Error) throw w.applicationInfo;
        return { results: w.applicationInfo };
      },
      candidateInfo: async () => {
        w.candidateReads += 1;
        if (w.candidateInfo instanceof Error) throw w.candidateInfo;
        return { results: w.candidateInfo };
      },
    },
    queue: {
      enqueue: async (name: string, payload: unknown, options?: Enqueued['options']) => {
        w.enqueued.push({ name, payload, options });
        return { id: `job_${w.enqueued.length}` };
      },
    },
    resolveMappingByJobId: async () => w.mapping,
    stores: {
      readLink: async () => w.link,
      readIngestion: async () => w.ingestion,
      bindLinkResumeHandle: async (linkId: string, handle: string) => {
        w.binds.push({ linkId, handle });
      },
      recordAshbyProfileOutcome: async (_linkId: string, outcome: string) => {
        w.outcomes.push(outcome);
      },
      applyAshbyCandidateProfile: async (input: AshbyCandidateProfileInput) => {
        w.applyCalls.push(input);
        if (w.applyResult instanceof Error) throw w.applyResult;
        return w.applyResult;
      },
      deferPhoneDialForQuestions: async (engagementId: string, graceSeconds: number) => {
        w.held.push({ engagementId, graceSeconds });
        return { status: 'deferred' };
      },
      ...storeOver,
    },
  } as never;
}

function profileJob(payload: unknown = { applicationLinkId: LINK_ID }) {
  return {
    id: 'job_p', name: ASHBY_PROFILE_QUEUE, payload,
    attempts: 1, maxAttempts: 3, createdAt: new Date().toISOString(),
  } as never;
}

async function runProfile(
  w: World,
  opts: { enabled?: boolean; storeOver?: Record<string, unknown>; payload?: unknown } = {},
) {
  const handlers = buildAshbyHandlers(runtimeFor(w, opts.storeOver), {
    phoneParsingEnabled: opts.enabled ?? true,
  });
  return handlers[ASHBY_PROFILE_QUEUE]!(
    profileJob('payload' in opts ? opts.payload : { applicationLinkId: LINK_ID }),
  );
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

const ORIGINAL_QUESTIONS = process.env.CANDIDATE_QUESTIONS_ENABLED;
beforeEach(() => {
  process.env.CANDIDATE_QUESTIONS_ENABLED = 'true';
});
afterEach(() => {
  if (ORIGINAL_QUESTIONS === undefined) delete process.env.CANDIDATE_QUESTIONS_ENABLED;
  else process.env.CANDIDATE_QUESTIONS_ENABLED = ORIGINAL_QUESTIONS;
});

// ═══════════════════════════════════════════════════════════════════════
// Names and keys other tracks depend on
// ═══════════════════════════════════════════════════════════════════════

describe('the profile queue contract', () => {
  it('pins the queue name, the dedup key and the classification delay', () => {
    expect(ASHBY_PROFILE_QUEUE).toBe('ashby.profile');
    expect(profileDedupKey('link_9')).toBe('ashby-profile:link_9');
    expect(PROFILE_CLASSIFY_DELAY_MS).toBe(15 * 60_000);
  });

  it('is exported from the integration index', () => {
    expect(ashbyIndex.ASHBY_PROFILE_QUEUE).toBe(ASHBY_PROFILE_QUEUE);
    expect(ashbyIndex.profileDedupKey).toBe(profileDedupKey);
    expect(ashbyIndex.PROFILE_CLASSIFY_DELAY_MS).toBe(PROFILE_CLASSIFY_DELAY_MS);
    expect(ashbyIndex.classifyResumePresence).toBe(classifyResumePresence);
  });

  it('runs on the MAIN Ashby runner, not the questions runner', () => {
    capturedRunners.length = 0;
    createAshbyWorkers({
      runtime: {
        runtimeConfig: {
          leaseSeconds: 60, signalPollMs: 5000, operationPollMs: 7000,
          reconcileIntervalMs: 900_000, reclaimIntervalMs: 60_000,
          scannerReadinessTimeoutMs: 1000, reconcileCaps: {}, reconcileAnchorDisabled: false,
        },
        queue: {}, stores: {}, materialization: {}, client: {},
        shutdown: async () => undefined,
      } as never,
      owner: 'api-test',
      scheduler: {
        setTimer: (() => 0) as never,
        clearTimer: (() => undefined) as never,
        random: () => 0.5,
        now: () => 0,
      },
    });
    const [ashby, questions] = capturedRunners;
    expect(Object.keys(ashby!.handlers)).toContain(ASHBY_PROFILE_QUEUE);
    expect(Object.keys(questions!.handlers)).not.toContain(ASHBY_PROFILE_QUEUE);
  });
});

describe('classifyResumePresence', () => {
  it('answers `present` for any handle extractResumeHandle accepts', () => {
    expect(classifyResumePresence({ resumeFileHandle: 'handle_x' })).toBe('present');
    expect(classifyResumePresence({ resumeFileHandle: { handle: 'handle_x' } })).toBe('present');
    expect(classifyResumePresence({ resume: { fileHandle: 'handle_x' } })).toBe('present');
  });

  it('answers `absent` for a candidate (string id) whose resume fields are all missing or null', () => {
    expect(classifyResumePresence({ id: 'c', resumeFileHandle: null })).toBe('absent');
    // Ashby documents resumeFileHandle as optional and omits it with no
    // resume: the first live no-resume applicant (2026-10-21) had no key.
    expect(classifyResumePresence({ id: 'c' })).toBe('absent');
    expect(classifyResumePresence({ id: 'c', resumeFileHandle: undefined })).toBe('absent');
    expect(classifyResumePresence({ id: 'c', resume: null, fileHandle: null, resumeHandle: null })).toBe('absent');
    expect(classifyResumePresence({ id: 'c', name: 'x', fileHandles: [] })).toBe('absent');
  });

  it('answers `unknown` for every other shape', () => {
    for (const shape of [
      {},
      { id: '' },
      { id: 42 },
      { resumeFileHandle: null },
      { id: 'c', resumeFileHandle: '' },
      { id: 'c', resumeFileHandle: {} },
      { id: 'c', resumeFileHandle: { id: 'f', name: 'resume.pdf' } },
      { id: 'c', resumeFileHandle: 'bad\u0000handle' },
      { id: 'c', resume: {} },
      { id: 'c', fileHandle: 0 },
      { resumeFileHandle: undefined },
      { resumeFileHandle: '' },
      { resumeFileHandle: 'bad\u0000handle' },
      { resumeFileHandle: 'x'.repeat(513) },
      { resumeFileHandle: {} },
      Object.create({ resumeFileHandle: null }),
      [],
      null,
      undefined,
      'resumeFileHandle',
    ]) {
      expect(classifyResumePresence(shape)).toBe('unknown');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Exits before any Ashby read
// ═══════════════════════════════════════════════════════════════════════

describe('exits before Ashby is read', () => {
  it('throws a fixed code on a malformed payload, even with the switch off', async () => {
    for (const payload of [{}, { applicationLinkId: '' }, { applicationLinkId: 7 }, null]) {
      const w = newWorld();
      await expect(runProfile(w, { payload })).rejects.toThrow('malformed_profile_payload');
      await expect(runProfile(w, { payload, enabled: false })).rejects.toThrow('malformed_profile_payload');
    }
  });

  it('does NOTHING with the switch off: no read, no write, no outcome', async () => {
    const w = newWorld();
    await runProfile(w, { enabled: false });
    expect(w.applicationReads + w.candidateReads).toBe(0);
    expect(w.applyCalls).toEqual([]);
    expect(w.outcomes).toEqual([]);
    expect(w.enqueued).toEqual([]);
  });

  it('reads the switch from the runtime config when no override is given', async () => {
    const w = newWorld();
    await buildAshbyHandlers(runtimeFor(w))[ASHBY_PROFILE_QUEUE]!(profileJob());
    expect(w.applyCalls).toEqual([]);
    const on = newWorld();
    const runtime = runtimeFor(on) as unknown as { runtimeConfig: Record<string, unknown> };
    runtime.runtimeConfig = { phoneParsingEnabled: true };
    await buildAshbyHandlers(runtime as never)[ASHBY_PROFILE_QUEUE]!(profileJob());
    expect(on.applyCalls).toHaveLength(1);
  });

  it('a link that no longer exists is simply done', async () => {
    const w = newWorld({ link: null });
    await runProfile(w);
    expect(w.outcomes).toEqual([]);
    expect(w.applicationReads).toBe(0);
  });

  it('records `application_terminal` for a terminal link', async () => {
    const w = newWorld({ link: baseLink({ terminalState: 'withdrawn' }) });
    await runProfile(w);
    expect(w.outcomes).toEqual(['application_terminal']);
    expect(w.applicationReads).toBe(0);
    expect(w.applyCalls).toEqual([]);
  });

  it('records `candidate_missing` when no candidate row is bound', async () => {
    const w = newWorld({ link: baseLink({ candidateId: null }) });
    await runProfile(w);
    expect(w.outcomes).toEqual(['candidate_missing']);
    expect(w.applicationReads).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// The stage, the mapping and the application status
// ═══════════════════════════════════════════════════════════════════════

describe('the application must still be at this mapping\'s AI stage', () => {
  it('records `stage_moved` when a recruiter moved the application on', async () => {
    const w = newWorld({ applicationInfo: appInfo({ currentInterviewStage: { id: 'stage_next' } }) });
    await runProfile(w);
    expect(w.outcomes).toEqual(['stage_moved']);
    expect(w.applyCalls).toEqual([]);
    expect(w.candidateReads).toBe(0);
  });

  it('records `mapping_inactive` for a paused mapping', async () => {
    const w = newWorld();
    w.mapping = { ...w.mapping, status: 'paused' };
    await runProfile(w);
    expect(w.outcomes).toEqual(['mapping_inactive']);
    expect(w.applyCalls).toEqual([]);
  });

  it('records `mapping_inactive` for a mapping that is not phone_primary', async () => {
    const w = newWorld();
    w.mapping = { ...w.mapping, screeningMode: 'browser_primary' };
    await runProfile(w);
    expect(w.outcomes).toEqual(['mapping_inactive']);
    expect(w.applyCalls).toEqual([]);
  });

  it('records `mapping_inactive` when the job now resolves to a different mapping', async () => {
    const w = newWorld();
    w.mapping = { ...w.mapping, id: 'map_other' };
    await runProfile(w);
    expect(w.outcomes).toEqual(['mapping_inactive']);
    expect(w.applyCalls).toEqual([]);
  });

  it('records `application_inactive` for a status other than Active', async () => {
    for (const status of ['Archived', 'Hired', 'Lead', '']) {
      const w = newWorld({ applicationInfo: appInfo({ status }) });
      await runProfile(w);
      expect(w.outcomes, status).toEqual(['application_inactive']);
      expect(w.applyCalls, status).toEqual([]);
    }
  });

  it('proceeds when the status field is absent', async () => {
    const info = appInfo();
    delete (info as Record<string, unknown>).status;
    const w = newWorld({ applicationInfo: info });
    await runProfile(w);
    expect(w.applyCalls).toHaveLength(1);
  });

  it('records `ashby_unavailable` and rethrows when application.info fails', async () => {
    const w = newWorld({ applicationInfo: new Error('ashby_transport_error') });
    await expect(runProfile(w)).rejects.toThrow('ashby_transport_error');
    expect(w.outcomes).toEqual(['ashby_unavailable']);
    expect(w.applyCalls).toEqual([]);
  });

  it('still rethrows the Ashby failure when recording it fails too', async () => {
    const w = newWorld({ applicationInfo: new Error('ashby_transport_error') });
    const storeOver = {
      recordAshbyProfileOutcome: async () => { throw new Error('ashby_profile_outcome_write_error'); },
    };
    await expect(runProfile(w, { storeOver })).rejects.toThrow('ashby_transport_error');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Classification of a link with no handle
// ═══════════════════════════════════════════════════════════════════════

describe('classification: does the candidate have a resume?', () => {
  it('present: binds the handle, enqueues the ingestion, records `resume_found`', async () => {
    const w = newWorld({ candidateInfo: { id: 'ashby_cand_1', resumeFileHandle: 'handle_late' } });
    await runProfile(w);
    expect(w.binds).toEqual([{ linkId: LINK_ID, handle: 'handle_late' }]);
    expect(w.enqueued).toEqual([{
      name: ASHBY_INGESTION_QUEUE,
      payload: { provider: 'ashby', applicationLinkId: LINK_ID },
      options: { dedupKey: ingestionDedupKey(LINK_ID), maxAttempts: 5 },
    }]);
    expect(w.outcomes).toEqual(['resume_found']);
    expect(w.applyCalls).toEqual([]);
  });

  it('present on application.info is a resume too, found without a second read', async () => {
    const w = newWorld({ applicationInfo: appInfo({ resumeFileHandle: 'handle_app' }) });
    await runProfile(w);
    expect(w.candidateReads).toBe(0);
    expect(w.binds).toEqual([{ linkId: LINK_ID, handle: 'handle_app' }]);
    expect(w.outcomes).toEqual(['resume_found']);
    expect(w.applyCalls).toEqual([]);
  });

  it('the candidate.info profile wins over the embedded one', async () => {
    const w = newWorld({
      candidateInfo: {
        id: 'ashby_cand_1', resumeFileHandle: null,
        name: 'Other Person', primaryEmailAddress: { value: 'other.person@example.com' },
      },
    });
    await runProfile(w);
    expect(w.applyCalls[0]).toMatchObject({ name: 'Other Person', email: 'other.person@example.com' });
  });

  it('no resume key at all (Ashby omits the optional field): phone parsing', async () => {
    const w = newWorld({ candidateInfo: { id: 'ashby_cand_1' } });
    await runProfile(w);
    expect(w.candidateReads).toBe(1);
    expect(w.applyCalls).toEqual([{
      applicationLinkId: LINK_ID,
      intake: 'phone_parsing',
      name: NAME,
      email: EMAIL,
      phoneRaw: NUMBER_RAW,
      phoneE164: NUMBER_E164,
      skipReason: null,
    }]);
    expect(w.outcomes).toEqual([]);
  });

  it('strictly null: phone parsing with the name, the email and the number', async () => {
    const w = newWorld();
    await runProfile(w);
    expect(w.candidateReads).toBe(1);
    expect(w.applyCalls).toEqual([{
      applicationLinkId: LINK_ID,
      intake: 'phone_parsing',
      name: NAME,
      email: EMAIL,
      phoneRaw: NUMBER_RAW,
      phoneE164: NUMBER_E164,
      skipReason: null,
    }]);
    // The RPC records its own outcome; the job records none beside it.
    expect(w.outcomes).toEqual([]);
  });

  it('a bad handle or a candidate with no id is `resume_shape_unknown`, never phone parsing', async () => {
    for (const candidateInfo of [
      { resumeFileHandle: null },
      { id: 'ashby_cand_1', resumeFileHandle: {} },
      { id: 'ashby_cand_1', resumeFileHandle: 'bad\u0007handle' },
      { id: 'ashby_cand_1', resumeFileHandle: 'x'.repeat(600) },
    ]) {
      const w = newWorld({ candidateInfo });
      await runProfile(w);
      expect(w.outcomes).toEqual(['resume_shape_unknown']);
      expect(w.applyCalls).toEqual([]);
      expect(w.binds).toEqual([]);
    }
  });

  it('no Ashby candidate id on the application is `resume_shape_unknown`', async () => {
    const info = appInfo();
    delete (info as Record<string, unknown>).candidate;
    const w = newWorld({ applicationInfo: info });
    await runProfile(w);
    expect(w.candidateReads).toBe(0);
    expect(w.outcomes).toEqual(['resume_shape_unknown']);
    expect(w.applyCalls).toEqual([]);
  });

  it('records `ashby_unavailable` and rethrows when candidate.info fails', async () => {
    const w = newWorld({ candidateInfo: new Error('ashby_rate_limited') });
    await expect(runProfile(w)).rejects.toThrow('ashby_rate_limited');
    expect(w.outcomes).toEqual(['ashby_unavailable']);
    expect(w.applyCalls).toEqual([]);
  });

  it('a stamped phone-parsing link that now shows a resume STAYS phone parsing (Q1)', async () => {
    const w = newWorld({
      link: baseLink({ intakeType: 'phone_parsing' }),
      candidateInfo: { id: 'ashby_cand_1', resumeFileHandle: 'handle_late' },
    });
    const { lines } = await captureLogs(() => runProfile(w));
    expect(w.binds).toEqual([]);
    expect(w.enqueued.filter((e) => e.name === ASHBY_INGESTION_QUEUE)).toEqual([]);
    expect(w.applyCalls.map((c) => c.intake)).toEqual(['phone_parsing']);
    const late = lines.find((l) => l.includes('ashby_late_resume_ignored'));
    expect(late).toBeDefined();
    expect(JSON.parse(late!).error_type).toBe('profile');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// D3: a parsed resume with no dialable number
// ═══════════════════════════════════════════════════════════════════════

describe('D3: a resume link', () => {
  const resumeLink = () => baseLink({ externalResumeFileHandle: 'handle_1', intakeType: 'resume_parsing' });

  // `failed_review` is NOT here: an unreadable resume falls back to phone
  // parsing (B3, below). Every other non-ready, non-terminal state keeps M9.
  for (const state of ['queued', 'fetching', 'scanning', 'extracting', 'structuring']) {
    it(`whose ingestion is \`${state}\` is the resume pipeline's: ingestion enqueued (M9)`, async () => {
      const w = newWorld({ link: resumeLink(), ingestion: { state, attempts: 0 } });
      await runProfile(w);
      expect(w.enqueued.map((e) => [e.name, e.options?.dedupKey]))
        .toEqual([[ASHBY_INGESTION_QUEUE, ingestionDedupKey(LINK_ID)]]);
      expect(w.outcomes).toEqual(['resume_found']);
      expect(w.applicationReads).toBe(0);
      expect(w.applyCalls).toEqual([]);
    });
  }

  it('whose ingestion row is absent is enqueued too', async () => {
    const w = newWorld({ link: resumeLink(), ingestion: null });
    await runProfile(w);
    expect(w.enqueued.map((e) => e.name)).toEqual([ASHBY_INGESTION_QUEUE]);
  });

  it('whose ingestion is `cancelled` is left alone', async () => {
    const w = newWorld({ link: resumeLink(), ingestion: { state: 'cancelled', attempts: 0 } });
    await runProfile(w);
    expect(w.enqueued).toEqual([]);
    expect(w.outcomes).toEqual(['resume_found']);
    expect(w.applicationReads).toBe(0);
  });

  it('once `ready`, sends the number ONLY — no name, no email', async () => {
    const w = newWorld({ link: resumeLink(), ingestion: { state: 'ready', attempts: 0 } });
    w.applyResult = { ...(w.applyResult as AshbyCandidateProfileResult), intakeStamped: false, identityApplied: false };
    await runProfile(w);
    expect(w.applyCalls).toHaveLength(1);
    const call = w.applyCalls[0]!;
    expect(call).toEqual({
      applicationLinkId: LINK_ID,
      intake: 'resume_parsing',
      phoneRaw: NUMBER_RAW,
      phoneE164: NUMBER_E164,
      skipReason: null,
    });
    expect('name' in call).toBe(false);
    expect('email' in call).toBe(false);
  });

  it('does not classify: candidate.info is read only when application.info has no primary', async () => {
    const w = newWorld({
      link: resumeLink(),
      ingestion: { state: 'ready', attempts: 0 },
      // candidate.info would say "unknown" — irrelevant on the D3 path.
      candidateInfo: { id: 'ashby_cand_1' },
    });
    await runProfile(w);
    expect(w.candidateReads).toBe(0);
    expect(w.applyCalls).toHaveLength(1);

    const noPrimary = newWorld({
      link: resumeLink(),
      ingestion: { state: 'ready', attempts: 0 },
      applicationInfo: appInfo({}, { primaryPhoneNumber: null }),
      candidateInfo: { id: 'ashby_cand_1', primaryPhoneNumber: { value: NUMBER_RAW } },
    });
    await runProfile(noPrimary);
    expect(noPrimary.candidateReads).toBe(1);
    expect(noPrimary.applyCalls[0]).toMatchObject({ phoneE164: NUMBER_E164, skipReason: null });
  });

  it('never sends a name_missing skip: a resume link has its own identity', async () => {
    const w = newWorld({
      link: resumeLink(),
      ingestion: { state: 'ready', attempts: 0 },
      applicationInfo: appInfo({}, { name: null }),
    });
    await runProfile(w);
    expect(w.applyCalls[0]).toMatchObject({ intake: 'resume_parsing', skipReason: null, phoneE164: NUMBER_E164 });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// B3: an unreadable resume falls back to phone parsing
// ═══════════════════════════════════════════════════════════════════════

describe('B3: a resume link whose ingestion rests in `failed_review` on a document verdict', () => {
  const unreadable = (over: Partial<World> = {}) => newWorld({
    link: baseLink({ externalResumeFileHandle: 'handle_1', intakeType: 'resume_parsing' }),
    ingestion: { state: 'failed_review', attempts: 1, failedReason: 'no_extractable_fields' },
    // A candidate.info shape the classifier would call `unknown`: the
    // fallback must not classify, so this must not stop it.
    candidateInfo: { id: 'ashby_cand_1' },
    ...over,
  });

  it('takes the phone-parsing path: name, email and number, intake `phone_parsing`', async () => {
    const w = unreadable();
    const { lines } = await captureLogs(() => runProfile(w));
    expect(w.applyCalls).toEqual([{
      applicationLinkId: LINK_ID,
      intake: 'phone_parsing',
      name: NAME,
      email: EMAIL,
      phoneRaw: NUMBER_RAW,
      phoneE164: NUMBER_E164,
      skipReason: null,
    }]);
    // No classification, no bind, no ingestion re-enqueue, no outcome beside the RPC's.
    expect(w.outcomes).toEqual([]);
    expect(w.binds).toEqual([]);
    expect(w.enqueued.filter((e) => e.name === ASHBY_INGESTION_QUEUE)).toEqual([]);
    expect(w.candidateReads).toBe(1);
    // A fallback is not a late resume, and the canary counts it apart.
    expect(lines.some((l) => l.includes('ashby_late_resume_ignored'))).toBe(false);
    const canary = lines.find((l) => l.includes('ashby_profile_classified'));
    expect(canary).toBeDefined();
    expect(JSON.parse(canary!).error_type).toBe('resume_unreadable');
    for (const fragment of PII_FRAGMENTS) expect(lines.join('\n')).not.toContain(fragment);
  });

  it('the candidate.info profile is read and wins, as on the no-resume path', async () => {
    const w = unreadable({
      candidateInfo: {
        id: 'ashby_cand_1', resumeFileHandle: 'handle_1',
        name: 'Other Person', primaryEmailAddress: { value: 'other.person@example.com' },
      },
    });
    await runProfile(w);
    expect(w.applyCalls[0]).toMatchObject({
      intake: 'phone_parsing', name: 'Other Person', email: 'other.person@example.com',
    });
    expect(w.binds).toEqual([]);
  });

  it('keeps the phone-parsing name rule: no usable name sends no number', async () => {
    const w = unreadable({ applicationInfo: appInfo({}, { name: 'Room 4021' }) });
    await runProfile(w);
    expect(w.applyCalls[0]).toMatchObject({
      intake: 'phone_parsing', name: null, phoneRaw: null, phoneE164: null, skipReason: 'name_missing',
    });
  });

  it('generates NO questions: there is no readable resume to write them from', async () => {
    const w = unreadable();
    await runProfile(w);
    expect(w.enqueued.filter((e) => e.name === CANDIDATE_QUESTIONS_QUEUE)).toEqual([]);
    expect(w.held).toEqual([]);
  });

  it('a retry of a link already stamped `phone_parsing` stays on the fallback path', async () => {
    const w = unreadable({
      link: baseLink({ externalResumeFileHandle: 'handle_1', intakeType: 'phone_parsing' }),
      applicationInfo: appInfo({ resumeFileHandle: 'handle_1' }),
    });
    const { lines } = await captureLogs(() => runProfile(w));
    expect(w.applyCalls.map((c) => c.intake)).toEqual(['phone_parsing']);
    expect(lines.some((l) => l.includes('ashby_late_resume_ignored'))).toBe(false);
  });

  it('respects the switch exactly as phone parsing does: OFF does nothing', async () => {
    const w = unreadable();
    await runProfile(w, { enabled: false });
    expect(w.applicationReads + w.candidateReads).toBe(0);
    expect(w.applyCalls).toEqual([]);
    expect(w.outcomes).toEqual([]);
    expect(w.enqueued).toEqual([]);
  });

  it('still re-checks the stage and the mapping before anything is applied', async () => {
    const moved = unreadable({ applicationInfo: appInfo({ currentInterviewStage: { id: 'stage_next' } }) });
    await runProfile(moved);
    expect(moved.outcomes).toEqual(['stage_moved']);
    expect(moved.applyCalls).toEqual([]);
    const browser = unreadable();
    browser.mapping = { ...browser.mapping, screeningMode: 'browser_primary' };
    await runProfile(browser);
    expect(browser.outcomes).toEqual(['mapping_inactive']);
    expect(browser.applyCalls).toEqual([]);
  });

  it('every document verdict falls back', async () => {
    for (const failedReason of ['scan_infected', 'guard_magic_mismatch', 'parse_extract_failed',
      'parse_no_output', 'parse_output_exceeded', 'no_extractable_fields']) {
      const w = unreadable({ ingestion: { state: 'failed_review', attempts: 1, failedReason } });
      await runProfile(w);
      expect(w.applyCalls.map((c) => c.intake), failedReason).toEqual(['phone_parsing']);
    }
  });

  // R1-1: an outage is not an unreadable resume. A parser, scanner, provider
  // or database failure leaves a resume that may be fine and that a requeue
  // re-runs; stamping it phone_parsing would screen the candidate as having
  // no resume, and strand the requeue in `queued` behind the ingestion guard.
  for (const failedReason of ['parse_overload', 'parse_timeout', 'parse_defer_deadline', 'parse_error',
    'parse_bad_output', 'materialize_failed', 'unexpected_error', 'scan_unavailable_deadline',
    'scan_deferral_exhausted', 'fetch_url_unresolved', 'fetch_timeout', 'ingestion_midflight_restart',
    null]) {
    it(`a machine-class reason (${String(failedReason)}) does NOT fall back: the resume pipeline keeps the link (M9)`, async () => {
      const w = unreadable({ ingestion: { state: 'failed_review', attempts: 1, failedReason } });
      const { lines } = await captureLogs(() => runProfile(w));
      expect(w.applyCalls).toEqual([]);
      expect(w.outcomes).toEqual(['resume_found']);
      expect(w.applicationReads + w.candidateReads).toBe(0);
      expect(lines.some((l) => l.includes('ashby_profile_classified'))).toBe(false);
    });
  }

  it('`ready` is unchanged: D3, number only, intake `resume_parsing`', async () => {
    const w = unreadable({ ingestion: { state: 'ready', attempts: 0 } });
    await runProfile(w);
    expect(w.applyCalls).toEqual([{
      applicationLinkId: LINK_ID,
      intake: 'resume_parsing',
      phoneRaw: NUMBER_RAW,
      phoneE164: NUMBER_E164,
      skipReason: null,
    }]);
    expect(w.candidateReads).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// The number
// ═══════════════════════════════════════════════════════════════════════

describe('the number handed to the RPC', () => {
  it('`name_missing` sends no number at all', async () => {
    for (const name of [null, '', 'Room 4021', 'someone@example.invalid']) {
      const w = newWorld({ applicationInfo: appInfo({}, { name }) });
      await runProfile(w);
      expect(w.applyCalls, String(name)).toEqual([{
        applicationLinkId: LINK_ID,
        intake: 'phone_parsing',
        name: null,
        email: EMAIL,
        phoneRaw: null,
        phoneE164: null,
        skipReason: 'name_missing',
      }]);
    }
  });

  it('a placeholder is `number_placeholder`, with no E.164', async () => {
    const w = newWorld({ applicationInfo: appInfo({}, { primaryPhoneNumber: { value: '+91 98765 43210' } }) });
    await runProfile(w);
    expect(w.applyCalls[0]).toMatchObject({ skipReason: 'number_placeholder', phoneE164: null });
  });

  it('an invalid or foreign number is `number_invalid`, with no E.164', async () => {
    for (const value of ['12345', '+1 415 555 0100', '+44 20 7946 0958']) {
      const w = newWorld({ applicationInfo: appInfo({}, { primaryPhoneNumber: { value } }) });
      await runProfile(w);
      expect(w.applyCalls[0], value).toMatchObject({ skipReason: 'number_invalid', phoneE164: null });
    }
  });

  it('no number at all is `number_invalid` with nothing to send', async () => {
    const w = newWorld({ applicationInfo: appInfo({}, { primaryPhoneNumber: null }) });
    await runProfile(w);
    expect(w.applyCalls[0]).toMatchObject({ skipReason: 'number_invalid', phoneRaw: null, phoneE164: null });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// After the RPC: admission, logs, errors
// ═══════════════════════════════════════════════════════════════════════

describe('admitting a candidate the RPC made callable', () => {
  const questionJobs = (w: World) => w.enqueued.filter((e) => e.name === CANDIDATE_QUESTIONS_QUEUE);
  const readyResumeLink = () => ({
    link: baseLink({ externalResumeFileHandle: 'handle_1', intakeType: 'resume_parsing' as const }),
    ingestion: { state: 'ready', attempts: 0 },
  });

  for (const status of ['eligible', 'scheduled_next_window']) {
    it(`D3 with a number applied and \`${status}\` asks for questions and holds the dial`, async () => {
      const w = newWorld(readyResumeLink());
      w.applyResult = {
        status, engagementId: 'eng_1', profileOutcome: 'applied',
        numberApplied: true, identityApplied: false, intakeStamped: false,
      };
      await runProfile(w);
      expect(questionJobs(w)).toEqual([{
        name: CANDIDATE_QUESTIONS_QUEUE,
        payload: { applicationLinkId: LINK_ID },
        options: { dedupKey: `candidate-questions:${LINK_ID}`, maxAttempts: 2 },
      }]);
      expect(w.held).toEqual([{ engagementId: 'eng_1', graceSeconds: 150 }]);
    });
  }

  it('D3 respects the questions kill switch', async () => {
    process.env.CANDIDATE_QUESTIONS_ENABLED = 'false';
    const w = newWorld(readyResumeLink());
    await runProfile(w);
    expect(questionJobs(w)).toEqual([]);
    expect(w.held).toEqual([]);
  });

  it('phone parsing generates NO questions: there is no resume to write them from', async () => {
    const w = newWorld();
    await runProfile(w);
    expect(w.applyResult).toMatchObject({ numberApplied: true, status: 'eligible' });
    expect(questionJobs(w)).toEqual([]);
    expect(w.held).toEqual([]);
  });

  it('does nothing when no number was applied NOW, so a re-run never pushes a dial later', async () => {
    const w = newWorld(readyResumeLink());
    w.applyResult = {
      status: 'eligible', engagementId: 'eng_1', profileOutcome: 'not_applicable',
      numberApplied: false, identityApplied: false, intakeStamped: false,
    };
    await runProfile(w);
    expect(questionJobs(w)).toEqual([]);
    expect(w.held).toEqual([]);
  });

  for (const status of ['engagement_active', 'duplicate_application', 'phone_invalid', 'consent_evidence_missing']) {
    it(`does nothing on \`${status}\`, even with a number applied`, async () => {
      const w = newWorld(readyResumeLink());
      w.applyResult = {
        status, engagementId: 'eng_1', profileOutcome: 'applied',
        numberApplied: true, identityApplied: false, intakeStamped: false,
      };
      await runProfile(w);
      expect(questionJobs(w)).toEqual([]);
      expect(w.held).toEqual([]);
    });
  }
});

describe('logs and errors carry codes only', () => {
  it('logs the profile outcome, and the classification canary when the intake was stamped', async () => {
    const w = newWorld();
    const { lines } = await captureLogs(() => runProfile(w));
    const parsed = lines.filter((l) => l.trim().startsWith('{')).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed).toContainEqual(expect.objectContaining({
      error_category: 'ashby_profile_applied', error_type: 'applied',
    }));
    expect(parsed).toContainEqual(expect.objectContaining({
      error_category: 'ashby_profile_classified', error_type: 'no_resume',
    }));
  });

  it('no name, email or number reaches a log line or a thrown message, on any path', async () => {
    const scenarios: Array<() => World> = [
      () => newWorld(),
      () => newWorld({ applicationInfo: appInfo({}, { name: 'Room 4021' }) }),
      () => newWorld({ applicationInfo: appInfo({}, { primaryPhoneNumber: { value: '+91 98765 43210' } }) }),
      () => newWorld({ candidateInfo: { id: 'ashby_cand_1' } }),
      () => newWorld({ candidateInfo: { id: 'ashby_cand_1', resumeFileHandle: 'handle_late' } }),
      () => newWorld({ applyResult: new Error('ashby_candidate_profile_error') }),
      () => newWorld({ link: baseLink({ intakeType: 'phone_parsing' }), candidateInfo: { resumeFileHandle: 'h' } }),
    ];
    let lineCount = 0;
    for (const make of scenarios) {
      const w = make();
      const { lines, error } = await captureLogs(() => runProfile(w));
      lineCount += lines.length;
      const text = lines.join('\n') + (error instanceof Error ? `\n${error.message}\n${String(error.stack)}` : '');
      for (const fragment of PII_FRAGMENTS) expect(text).not.toContain(fragment);
    }
    // The capture is real, not vacuous: the scenarios did log.
    expect(lineCount).toBeGreaterThan(5);
  });

  it('an RPC failure throws the store\'s fixed code, never the database message', async () => {
    // The REAL production seam, over a client whose error echoes its input.
    const stores = createWorkflowStores({
      rpc: async (_name: string, params: Record<string, unknown>) => ({
        data: null,
        error: { message: `insert failed for ${String(params.p_name)} ${String(params.p_phone_e164)}` },
      }),
    } as never);
    const w = newWorld();
    const { error } = await captureLogs(() => runProfile(w, {
      storeOver: { applyAshbyCandidateProfile: stores.applyAshbyCandidateProfile },
    }));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('ashby_candidate_profile_error');
    for (const fragment of PII_FRAGMENTS) expect((error as Error).message).not.toContain(fragment);
  });

  it('the profile job enqueues nothing but link ids', async () => {
    const w = newWorld({ candidateInfo: { id: 'ashby_cand_1', resumeFileHandle: 'handle_late' } });
    await runProfile(w);
    for (const e of w.enqueued) {
      expect(JSON.stringify(e.payload)).not.toMatch(/Test Person|example\.invalid|9812345670/);
    }
  });
});
