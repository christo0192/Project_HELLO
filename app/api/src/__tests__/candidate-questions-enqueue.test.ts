/**
 * The ENQUEUE — the one line that decides whether this feature runs at all,
 * and how much it costs.
 *
 * An adversarial review mutated it ten ways: deleting the enqueue entirely,
 * pinning the kill switch off, dropping the dedup key, raising `maxAttempts`
 * to 10, making an enqueue fault fail the whole ingestion. All ten passed the
 * full 6161-test suite, because `runtime.stores.ensurePhoneEngagement` is
 * undefined in every other stub in the repository and the `&&` guard
 * short-circuits before the enqueue is ever reached.
 *
 * So this file drives the REAL ingestion handler to `ready` with that port
 * present, and reads the queue.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildAshbyHandlers,
  ASHBY_INGESTION_QUEUE,
} from '../integrations/ashby/runtime-workers.js';
import { CANDIDATE_QUESTIONS_QUEUE } from '../lib/candidate-question-jobs.js';
import type { MaterializationStore } from '../integrations/ashby/materialize.js';

interface Enqueued {
  name: string;
  payload: unknown;
  options?: { dedupKey?: string; maxAttempts?: number };
}

let enqueued: Enqueued[];
let engagementStatus: string;
let enqueueThrows: boolean;

/** A runtime whose ingestion reaches `ready` and whose queue records. */
function runtime() {
  let ingestion: { state: string; attempts: number } | null = { state: 'queued', attempts: 0 };
  const parsed = {
    name: 'Asha Menon', email: 'a@example.test', phone: '+919990000000',
    skills: ['Outbound calling'], experience_years: 5,
    current_role: 'Inside Sales Lead', summary: 'Five years in B2B sales.',
  };
  return {
    runtimeConfig: {},
    queue: {
      enqueue: async (name: string, payload: unknown, options?: Enqueued['options']) => {
        if (enqueueThrows && name === CANDIDATE_QUESTIONS_QUEUE) {
          throw new Error('queue unavailable');
        }
        enqueued.push({ name, payload, options });
        return { id: 'job_x' };
      },
    },
    stores: {
      readLink: async () => ({
        id: 'link_1', externalApplicationId: 'app_1', externalJobId: 'job_1',
        externalResumeFileHandle: 'handle_1', jobMappingId: 'map_1',
        candidateId: null, sessionId: null, inviteId: null,
        lifecycle: 'imported', terminalState: null,
      }),
      readIngestion: async () => ingestion,
      advanceIngestion: async (_id: string, state: string) => {
        ingestion = { state, attempts: 0 };
        return { status: 'ok' };
      },
      ensurePhoneEngagement: async () => ({ status: engagementStatus }),
    },
    buildIngestionPorts: async (input: { onState: (s: string, p?: unknown) => Promise<void> }) => ({
      status: 'ok' as const,
      ports: {
        presignedUrl: 'https://host.example/r.pdf',
        policy: { allowlistEnabled: true, allowedHosts: ['host.example'], allowedPorts: [443] },
        fetch: async () => ({
          ok: true as const, bytes: Buffer.from('resume'), sha256: 'a'.repeat(64),
          contentType: 'application/pdf', finalHost: 'host.example', hops: 0,
        }),
        scan: async () => ({ safe: true, status: 'clean' }),
        guard: () => ({ ok: true as const, mime: 'application/pdf' }),
        parse: async () => ({ text: 'resume text', structurerVersion: 'v1', structured: parsed }),
        fallbackFromText: () => parsed,
        persist: async () => ({ status: 'ok' as const }),
        onState: input.onState,
        extractorVersion: 'x1',
        classifyScan: () => 'verdict',
      },
    }),
    resolveMappingForLink: async () => null,
    materialization: {} as MaterializationStore,
  } as never;
}

async function runIngestion() {
  const handlers = buildAshbyHandlers(runtime(), {
    scannerGate: async () => ({ action: 'proceed', mode: 'clamav' }),
  });
  return handlers[ASHBY_INGESTION_QUEUE]({
    id: 'job_1', name: ASHBY_INGESTION_QUEUE, payload: { applicationLinkId: 'link_1' },
    attempts: 1, maxAttempts: 5, createdAt: new Date().toISOString(),
  } as never);
}

const ORIGINAL = process.env.CANDIDATE_QUESTIONS_ENABLED;

beforeEach(() => {
  enqueued = [];
  engagementStatus = 'eligible';
  enqueueThrows = false;
  process.env.CANDIDATE_QUESTIONS_ENABLED = 'true';
});
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CANDIDATE_QUESTIONS_ENABLED;
  else process.env.CANDIDATE_QUESTIONS_ENABLED = ORIGINAL;
});

function candidateJobs() {
  return enqueued.filter((e) => e.name === CANDIDATE_QUESTIONS_QUEUE);
}

describe('the enqueue', () => {
  it('ASKS FOR QUESTIONS once the engagement is admitted', async () => {
    await runIngestion();
    expect(candidateJobs()).toHaveLength(1);
    expect(candidateJobs()[0].payload).toEqual({ applicationLinkId: 'link_1' });
  });

  it('DEDUPS BY APPLICATION, and bounds the retry at two', async () => {
    // A redelivered webhook, a reconciliation recovery and a retried ingestion
    // must collapse onto one job, or one candidate costs several provider calls.
    await runIngestion();
    expect(candidateJobs()[0].options?.dedupKey).toBe('candidate-questions:link_1');
    expect(candidateJobs()[0].options?.maxAttempts).toBe(2);
  });

  describe('THE KILL SWITCH — on by default, off only when asked', () => {
    // It shipped default-OFF while `candidate.questions` shared the Ashby
    // runner's budget of 2, because two generation jobs in flight stopped the
    // drain claiming anything. That queue now has its OWN runner with a budget
    // of 1, so the isolation is structural and the default is on.
    it('ENQUEUES when the flag is unset', async () => {
      delete process.env.CANDIDATE_QUESTIONS_ENABLED;
      await runIngestion();
      expect(candidateJobs()).toHaveLength(1);
    });

    it('STOPS ONLY ON THE EXACT STRING "false"', async () => {
      process.env.CANDIDATE_QUESTIONS_ENABLED = 'false';
      await runIngestion();
      expect(candidateJobs()).toHaveLength(0);
    });

    it('treats every other value as on, rather than guessing', async () => {
      // A typo must not silently disable a feature the operator believes is
      // running — the failure that would be hardest to notice.
      for (const value of ['true', 'TRUE', '1', 'yes', '']) {
        enqueued = [];
        process.env.CANDIDATE_QUESTIONS_ENABLED = value;
        await runIngestion();
        expect(candidateJobs(), value).toHaveLength(1);
      }
    });
  });

  describe('ONLY FOR A CANDIDATE WHO WILL ACTUALLY BE CALLED', () => {
    // `ensure_ashby_phone_engagement` INSERTS the row before it checks any
    // prerequisite, so an engagement exists — and is not terminal — for a
    // candidate with an unusable number or no consent evidence. Paying a
    // provider call for those is the cost this module's own comments promise
    // not to pay.
    for (const status of ['eligible', 'scheduled_next_window', 'engagement_active']) {
      it(`enqueues on \`${status}\``, async () => {
        engagementStatus = status;
        await runIngestion();
        expect(candidateJobs()).toHaveLength(1);
      });
    }
    for (const status of [
      'phone_invalid',
      'consent_evidence_missing',
      'consent_not_granted',
      'consent_expired',
      'mapping_not_enabled',
      'identity_mismatch',
      'ingestion_not_ready',
      'engagement_terminal',
      'application_terminal',
      'candidate_missing',
    ]) {
      it(`does NOT enqueue on \`${status}\``, async () => {
        engagementStatus = status;
        await runIngestion();
        expect(candidateJobs()).toHaveLength(0);
      });
    }
  });

  it('AN ENQUEUE FAULT DOES NOT FAIL THE INGESTION', async () => {
    // Trading a working import for a nicer question is the wrong way round:
    // the ingestion is what makes the candidate dialable at all.
    enqueueThrows = true;
    await expect(runIngestion()).resolves.not.toThrow();
    expect(candidateJobs()).toHaveLength(0);
  });
});
