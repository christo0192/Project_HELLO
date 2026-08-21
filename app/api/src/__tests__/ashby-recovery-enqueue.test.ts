/**
 * 0040 — the cross-language half of "a recovery leaves durable, CLAIMABLE
 * work".
 *
 * WHAT WENT WRONG: `recover_ashby_ingestion_parse` (0039) moved a rested
 * ingestion `failed_review -> queued`, charged an attempt and wrote a
 * `success` audit row while enqueuing nothing. The original `ashby.ingestion`
 * job had COMPLETED, the governing event receipt was already terminal, and
 * the 0030 outbox therefore suppresses re-drive on every subsequent
 * reconciliation pass and webhook redelivery — so no producer of that queue
 * could ever fire again for an unchanged, already-linked application. The row
 * rested in `queued` for ever, having LEFT the operator queue watching it.
 *
 * 0040 admits the job inside the RPC's own transaction. That fix spans two
 * languages: the job is now written by SQL and read by TypeScript. The DB side
 * is asserted in `app/supabase/tests/policy_tests.sql` ("ashby 0040: ..."),
 * which proves the migration produces exactly one live job with an exact
 * payload, dedup key, attempt budget, priority and schedule.
 *
 * THIS file asserts the other half, which no SQL test can reach:
 *
 *   1. the literals the migration writes are the literals this codebase
 *      produces and consumes — asserted against the migration TEXT, so a
 *      drift on either side fails here rather than in production;
 *   2. a job carrying the migration's payload is genuinely CLAIMABLE and
 *      CONSUMABLE by the shipped handler — it is not rejected as
 *      `malformed_ingestion_payload` and does not dead-letter;
 *   3. the malformed shape the migration could plausibly have written
 *      (snake_case, mirroring the column names) really would have thrown —
 *      i.e. assertion (2) has teeth.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Queue } from '../lib/queue/index.js';
import { MemoryAdapter } from '../lib/queue/memory-adapter.js';
import { createQueueRunner } from '../lib/queue/runner.js';
import {
  buildAshbyHandlers,
  ASHBY_INGESTION_QUEUE,
  ingestionDedupKey,
} from '../integrations/ashby/runtime-workers.js';
import type { WorkflowLinkRow } from '../integrations/ashby/orchestration.js';
import type { MaterializationStore } from '../integrations/ashby/materialize.js';

const MIGRATION = readFileSync(
  fileURLToPath(new URL('../../../supabase/migrations/0040_ashby_recovery_queue_admission.sql', import.meta.url)),
  'utf8',
);

const LINK_ID = '9d1f6f3e-1f4a-4c2a-9c3e-2f0a5b7c8d90';

/**
 * The payload the migration writes, transcribed by hand from the SQL rather
 * than built with `ingestionDedupKey` or a shared helper — the whole risk this
 * guards is the two sides silently diverging, and a shared builder would hide
 * exactly that.
 */
const SQL_PAYLOAD = { provider: 'ashby', applicationLinkId: LINK_ID };
const SQL_QUEUE_NAME = 'ashby.ingestion';
const SQL_DEDUP_KEY = `ashby:ingestion:${LINK_ID}`;
const SQL_MAX_ATTEMPTS = 5;

function baseLink(over: Partial<WorkflowLinkRow> = {}): WorkflowLinkRow {
  return {
    id: LINK_ID, externalApplicationId: 'app_1', externalJobId: 'job_1',
    // No resume handle: the handler reads the link, finds nothing to ingest and
    // returns cleanly. That is deliberate — this test is about the PAYLOAD
    // being understood, so it stops at the first step that proves the link id
    // was extracted, without any provider contact.
    externalResumeFileHandle: null, jobMappingId: 'map_1',
    candidateId: null, sessionId: null, inviteId: null,
    lifecycle: 'imported', terminalState: null, ...over,
  };
}

function runtimeFor(readLink: (id: string) => Promise<WorkflowLinkRow | null>) {
  const buildIngestionPorts = vi.fn(async () => {
    throw new Error('no provider contact is expected in this test');
  });
  return {
    runtime: {
      runtimeConfig: {},
      stores: {
        readLink: vi.fn(readLink),
        readIngestion: async () => ({ state: 'queued', attempts: 1 }),
        advanceIngestion: async () => ({ status: 'ok' }),
      },
      buildIngestionPorts,
      resolveMappingForLink: async () => null,
      materialization: {} as MaterializationStore,
    } as never,
    buildIngestionPorts,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// 1. The migration writes what this codebase reads
// ═══════════════════════════════════════════════════════════════════════

describe('0040 — the SQL and TypeScript sides of the ingestion job agree', () => {
  it('the migration enqueues onto the queue the workers actually run', () => {
    expect(SQL_QUEUE_NAME).toBe(ASHBY_INGESTION_QUEUE);
    expect(MIGRATION).toContain(`v_queue_name       constant text    := '${ASHBY_INGESTION_QUEUE}'`);
  });

  it('the migration uses the camelCase payload key the handler reads', () => {
    // The plausible mistake is snake_case, mirroring `application_link_id` —
    // the column name, the RPC parameter name and the audit metadata key. It
    // would type-check nowhere and fail only at runtime, as a dead letter.
    expect(MIGRATION).toContain("jsonb_build_object('provider', 'ashby',");
    expect(MIGRATION).toContain("'applicationLinkId', p_application_link_id)");
    expect(MIGRATION).not.toContain("'application_link_id', p_application_link_id)");
  });

  it('the migration builds the same dedup key as ingestionDedupKey', () => {
    expect(SQL_DEDUP_KEY).toBe(ingestionDedupKey(LINK_ID));
    expect(MIGRATION).toContain("v_dedup_key := 'ashby:ingestion:' || p_application_link_id::text;");
  });

  it('the migration matches the ordinary enqueue budget, priority and schedule', () => {
    expect(MIGRATION).toContain(`v_job_max_attempts constant integer := ${SQL_MAX_ATTEMPTS}`);
    expect(MIGRATION).toContain('v_job_priority     constant integer := 0');
    expect(MIGRATION).toContain('0, v_job_max_attempts, v_job_priority, p_now, p_now)');
  });

  it('the migration fails CLOSED rather than reporting a recovery it did not schedule', () => {
    expect(MIGRATION).toContain("raise exception 'ashby_ingestion_recovery_enqueue_failed'");
    // The verification, not just the insert: `on conflict do nothing` skipping
    // is only acceptable when a CLAIMABLE job is already there. `active` is
    // deliberately excluded — a claimed job may be seconds from completing,
    // and counting it would recreate the very stall 0040 removes.
    expect(MIGRATION).toContain("and status in ('pending', 'delayed')");
    expect(MIGRATION).toContain("return jsonb_build_object('status', 'ingestion_job_in_flight',");
  });

  it('the migration carries no resume handle, URL, token or candidate field into the payload', () => {
    // The STATEMENT, not the surrounding commentary (which discusses
    // `on conflict do nothing` before the insert reaches it).
    const start = MIGRATION.indexOf('insert into screening_v2.job_queue\n    (name, payload');
    const insert = MIGRATION.slice(start, MIGRATION.indexOf('on conflict do nothing', start));
    expect(insert.length).toBeGreaterThan(0);
    for (const forbidden of [
      'external_resume_file_handle', 'resume_url', 'presigned', 'token',
      'candidate', 'email', 'phone', 'failed_reason', 'external_application_id',
    ]) {
      expect(insert).not.toContain(forbidden);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. The produced job is claimable and consumable
// ═══════════════════════════════════════════════════════════════════════

describe('0040 — a job carrying the migration payload runs', () => {
  it('is claimed, understood and completed — never malformed, never dead-lettered', async () => {
    const queue = new Queue(new MemoryAdapter());
    const enqueued = await queue.enqueue(SQL_QUEUE_NAME, SQL_PAYLOAD, {
      dedupKey: SQL_DEDUP_KEY,
      maxAttempts: SQL_MAX_ATTEMPTS,
    });

    const seen: string[] = [];
    const { runtime, buildIngestionPorts } = runtimeFor(async (id) => {
      seen.push(id);
      return baseLink();
    });

    const runner = createQueueRunner({
      queue,
      handlers: buildAshbyHandlers(runtime),
      owner: 'w1',
      leaseSeconds: 30,
      pollMs: 10,
    });
    await runner.tick();
    for (let i = 0; i < 500 && runner.inFlight() > 0; i++) await Promise.resolve();

    // The link id came out of the payload — the camelCase key was understood.
    expect(seen).toEqual([LINK_ID]);
    // No provider contact: this link carries no resume handle.
    expect(buildIngestionPorts).not.toHaveBeenCalled();

    const row = await queue.getById(enqueued.id);
    expect(row!.status).toBe('completed');
    expect(await queue.getDlqJobs()).toHaveLength(0);
  });

  it('the snake_case shape the migration could have written WOULD have thrown', async () => {
    const handlers = buildAshbyHandlers(runtimeFor(async () => baseLink()).runtime);
    await expect(
      handlers[ASHBY_INGESTION_QUEUE]!({
        id: 'job_bad', name: ASHBY_INGESTION_QUEUE,
        payload: { provider: 'ashby', application_link_id: LINK_ID },
        attempts: 1, maxAttempts: 5, createdAt: new Date().toISOString(),
      } as never),
    ).rejects.toThrow('malformed_ingestion_payload');
  });
});
