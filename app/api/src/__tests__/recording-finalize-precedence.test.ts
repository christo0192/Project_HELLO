/**
 * 0038 — the finalize WORKER must not weaken authoritative precedence.
 *
 * The 0025 contract (I-1..I-5) says the egress object is authoritative and the
 * browser copy is a last resort that is accepted ONLY when the server
 * explicitly declares `fallback_required`. `'pending'` means DO NOT UPLOAD.
 *
 * Adding a server-side actor that finalizes recordings asynchronously is
 * exactly the kind of change that can quietly relax that: a new writer of
 * `recording_object_key`, a new path that accepts a browser blob, or a
 * `'pending'` that starts meaning "go ahead". None of those may happen, and
 * these are the regression guards.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRecordingFinalizeHandler } from '../lib/recording/finalize-worker.js';
import { runRecordingSweep } from '../lib/recording/sweeper.js';
import { Queue } from '../lib/queue/index.js';
import { MemoryAdapter } from '../lib/queue/memory-adapter.js';
import { RECORDING_FINALIZE_QUEUE } from '../lib/recording/config.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const SESSION = '00000000-0000-4000-8000-000000000001';

const job = () => ({
  id: 'j1', name: RECORDING_FINALIZE_QUEUE, payload: { session_id: SESSION },
  attempts: 1, maxAttempts: 5, createdAt: '2026-08-19T12:00:00.000Z',
}) as never;

function stubClient(row: Record<string, unknown> = {}) {
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: row, error: null }),
    single: async () => ({ data: row, error: null }),
  };
  return { from: () => chain, rpc: vi.fn(async () => ({ data: null, error: null })) } as never;
}

describe('0038 worker: authoritative precedence is unchanged', () => {
  it('routes every link through finalize_authoritative_recording — it adds NO new writer', () => {
    // The RPC is the single writer of `recording_object_key` for the egress
    // path, and it is the thing that produces the exactly-once `uploaded`
    // integrity event and the `repointed` evidence on a displaced browser key.
    // A worker that wrote the column directly would bypass both.
    for (const file of ['lib/recording/finalize-worker.ts', 'lib/recording/sweeper.ts', 'lib/recording/runtime.ts']) {
      const src = readFileSync(join(SRC, file), 'utf8');
      expect(src, `${file} must not write recording_object_key`)
        .not.toMatch(/recording_object_key\s*:/);
      expect(src, `${file} must not call the finalize RPC directly`)
        .not.toMatch(/finalize_authoritative_recording/);
    }
    // The ONE caller of the RPC is still the finalizer itself.
    const finalizer = readFileSync(join(SRC, 'lib/recording-egress.ts'), 'utf8');
    expect(finalizer.match(/rpc\('finalize_authoritative_recording'/g) ?? []).toHaveLength(1);
  });

  it('no worker path accepts, requests, or triggers a browser upload', () => {
    for (const file of ['lib/recording/finalize-worker.ts', 'lib/recording/sweeper.ts', 'lib/recording/runtime.ts', 'lib/recording/health.ts']) {
      const src = readFileSync(join(SRC, file), 'utf8');
      expect(src, `${file} must not reference the browser upload path`)
        .not.toMatch(/browser_upload|uploadCandidateRecording|\/recording'/);
    }
  });

  it("'pending' still means DO NOT UPLOAD — it is a deferral, never a fallback licence", async () => {
    // The single most important non-regression here: if the worker mapped
    // `'pending'` to `'fallback_required'` (or to a completed claim that let
    // the client fall back), a browser-only blob could displace an egress
    // object that was still flushing.
    const handler = createRecordingFinalizeHandler({
      maxAttempts: 5,
      client: stubClient({
        recording_finalize_attempts: 1,
        recording_finalize_defer_reason: 'poll_timeout',
        recording_finalize_exhausted_at: null,
      }),
      configured: () => true,
      finalize: async () => 'pending',
      recordDeferral: async () => ({ attempts: 1, exhausted: false }),
    });
    const result = await handler(job());
    expect(result).toMatchObject({ outcome: 'defer' });
    // Emphatically not a completion, and emphatically not a fallback signal.
    expect(result).not.toBeUndefined();
  });

  it("'fallback_required' completes the claim — the row is already truthfully failed", async () => {
    // Retrying cannot change a terminal provider verdict, and re-driving it
    // would only churn the lease.
    const handler = createRecordingFinalizeHandler({
      maxAttempts: 5, client: stubClient(), configured: () => true,
      finalize: async () => 'fallback_required',
    });
    expect(await handler(job())).toBeUndefined();
  });

  it("'ready' completes the claim", async () => {
    const handler = createRecordingFinalizeHandler({
      maxAttempts: 5, client: stubClient(), configured: () => true,
      finalize: async () => 'ready',
    });
    expect(await handler(job())).toBeUndefined();
  });

  it('the sweeper ENQUEUES; it never finalizes inline', async () => {
    // Running the finalizer inline in the sweep would put provider calls and
    // byte downloads outside the lease, in a loop with no concurrency bound
    // and no failure accounting.
    const src = readFileSync(join(SRC, 'lib/recording/sweeper.ts'), 'utf8');
    expect(src).not.toMatch(/finalizeAuthoritativeRecording/);

    const queue = new Queue(new MemoryAdapter({}), {});
    const rows = [{
      id: SESSION, status: 'completed', ended_at: '2026-08-19T11:00:00.000Z',
      recording_egress_id: 'EG_x', recording_object_key: null,
      recording_egress_status: 'active', recording_finalize_exhausted_at: null,
      recording_deleted_at: null, recording_revoked_at: null, recording_quarantined: false,
    }];
    const chain: Record<string, unknown> = {
      select: () => chain, eq: () => chain, in: () => chain, is: () => chain,
      not: () => chain, gt: () => chain, lt: () => chain, order: () => chain,
      limit: () => chain,
      then: (r: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(r),
    };
    const client = { from: () => chain } as never;

    const result = await runRecordingSweep({
      client, queue,
      halt: { read: async () => ({ halted: false, reason: null, since: null, degraded: false }), admits: async () => true, invalidate: () => {} },
      admission: 10, graceSec: 60, maxAgeSec: 604_800, maxAttempts: 5,
      now: () => Date.parse('2026-08-19T12:00:00.000Z'),
    });
    expect(result.enqueued).toBe(1);
    const claimed = await queue.claim(RECORDING_FINALIZE_QUEUE, { leaseSeconds: 30, owner: 'w' });
    expect((claimed!.payload as Record<string, unknown>).session_id).toBe(SESSION);
  });

  it("nothing in the API writes recording_egress_status='active' except the START path", () => {
    // The reopen RPC (0038) is the ONLY writer that moves 'failed' back to
    // 'active', and it is guarded by a reason allowlist and audited. A
    // TypeScript path that quietly reset the status would be an unaudited,
    // unguarded unfail — the exact back door the RPC exists to avoid. (The
    // RPC's own behaviour is exercised against a real database in
    // app/supabase/tests/policy_tests.sql, which is stronger than stubbing it
    // here.)
    const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs');
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((e) => {
      const full = join(dir, e);
      return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
    });
    const offenders: string[] = [];
    for (const file of walk(join(SRC, 'lib')).concat(walk(join(SRC, 'routes')))) {
      const src = readFileSync(file, 'utf8');
      if (!/recording_egress_status\s*:\s*'active'/.test(src)) continue;
      // The one legitimate writer: linking a NEWLY STARTED egress.
      if (file.endsWith('recording-egress.ts')) continue;
      offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('the client-side fallback rule is NOT relaxed', () => {
    // `CandidateJoinPage` must still upload only on an explicit
    // `fallback_required`, never on `pending` or `ready`.
    const page = readFileSync(
      join(SRC, '..', '..', 'web', 'src', 'pages', 'CandidateJoinPage.tsx'),
      'utf8',
    );
    expect(page).toMatch(/recordingStatus === 'fallback_required'/);
    expect(page).toMatch(/if \(fallbackRequired\) \{\s*await uploadBrowserFallback/);
  });
});
