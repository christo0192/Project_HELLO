/**
 * CROSS-SEAM: the reason the worker mints must be the reason health counts.
 *
 * The gap this closes is not a bug in either module — each was internally
 * consistent and separately tested. It is that nothing tested the JOIN between
 * them. `readBacklog` filters deferred jobs on `defer_reason LIKE 'scanner%'`,
 * while the post-scan deferral minted `scan_scanner_busy` (the ingestion
 * orchestrator prefixes every scan outcome with `scan_`). Every unit test on
 * both sides passed, and `scannerDeferredJobs` stayed 0 for the entire
 * post-claim class — the exact "indistinguishable from an idle queue" reading
 * the counter exists to prevent, and the exact repeat of PR #66's lesson that
 * a new quiet path needs a counter that actually matches it.
 *
 * So these tests do NOT hard-code a reason string. They take whatever the real
 * handler returns and feed it to the real `readBacklog` over a fake that
 * applies the filters for real.
 */

import { describe, it, expect } from 'vitest';
import { readBacklog, DEGRADE_THRESHOLDS, evaluateDegradation } from '../integrations/ashby/runtime-health.js';
import {
  buildAshbyHandlers,
  ASHBY_INGESTION_QUEUE,
} from '../integrations/ashby/runtime-workers.js';
import type { WorkflowLinkRow } from '../integrations/ashby/orchestration.js';
import type { MaterializationStore } from '../integrations/ashby/materialize.js';

// ── A fake PostgREST that actually applies the filters ─────────────────────
// A fake that ignored `.like()` would have passed against the broken prefix too,
// which is the whole failure mode being closed here.

interface Row { [k: string]: unknown }

function matches(row: Row, f: { kind: string; col: string; val: unknown }): boolean {
  const cell = row[f.col];
  if (f.kind === 'eq') return cell === f.val;
  if (f.kind === 'in') return (f.val as readonly unknown[]).includes(cell);
  if (f.kind === 'like') {
    if (typeof cell !== 'string') return false;
    const pattern = String(f.val);
    // Only the trailing-% form is used by readBacklog.
    return pattern.endsWith('%')
      ? cell.startsWith(pattern.slice(0, -1))
      : cell === pattern;
  }
  return false;
}

function makeClient(tables: Record<string, Row[]>, rpcResult: Record<string, number> = {}) {
  const build = (table: string, selected: string | null, head: boolean) => {
    const filters: Array<{ kind: string; col: string; val: unknown }> = [];
    let orderCol: string | null = null;
    let ascending = true;
    let lim: number | null = null;

    const rows = (): Row[] => {
      let out = (tables[table] ?? []).filter((r) => filters.every((f) => matches(r, f)));
      if (orderCol) {
        const col = orderCol;
        out = [...out].sort((a, b) => {
          const av = String(a[col] ?? ''); const bv = String(b[col] ?? '');
          return ascending ? av.localeCompare(bv) : bv.localeCompare(av);
        });
      }
      if (lim !== null) out = out.slice(0, lim);
      return out;
    };

    const api: Record<string, unknown> = {
      eq: (col: string, val: unknown) => { filters.push({ kind: 'eq', col, val }); return api; },
      in: (col: string, val: unknown) => { filters.push({ kind: 'in', col, val }); return api; },
      like: (col: string, val: unknown) => { filters.push({ kind: 'like', col, val }); return api; },
      order: (col: string, opts?: { ascending?: boolean }) => {
        orderCol = col; ascending = opts?.ascending ?? true; return api;
      },
      limit: (n: number) => { lim = n; return api; },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (onOk: (r: unknown) => unknown) =>
        Promise.resolve(onOk(head ? { count: rows().length, error: null } : { data: rows(), error: null })),
    };
    void selected;
    return api;
  };

  return {
    from: (table: string) => ({
      select: (sel: string, opts?: { count?: string; head?: boolean }) =>
        build(table, sel, Boolean(opts?.head)),
    }),
    rpc: async () => ({ data: rpcResult, error: null }),
  } as never;
}

const ASHBY_QUEUES = ['ashby.signal', 'ashby.import', ASHBY_INGESTION_QUEUE];

// ── The worker half: get a REAL post-scan deferral reason ──────────────────

function link(): WorkflowLinkRow {
  return {
    id: 'link_1', externalApplicationId: 'app_1', externalJobId: 'job_1',
    externalResumeFileHandle: 'handle_1', jobMappingId: 'map_1',
    candidateId: null, sessionId: null, inviteId: null,
    lifecycle: 'imported', terminalState: null,
  };
}

async function realDeferReason(scanStatus: string): Promise<string> {
  let ingestion: { state: string; attempts: number } | null = { state: 'queued', attempts: 0 };
  const runtime = {
    runtimeConfig: {},
    stores: {
      readLink: async () => link(),
      readIngestion: async () => ingestion,
      advanceIngestion: async (_id: string, state: string) => {
        ingestion = { state, attempts: 0 };
        return { status: 'ok' };
      },
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
        scan: async () => ({ safe: false, status: scanStatus }),
        guard: () => ({ ok: true as const, mime: 'application/pdf' }),
        parse: async () => ({
          text: '', structurerVersion: 'v1',
          structured: { name: null, email: null, phone: null, skills: [], experience_years: null, current_role: null, summary: null },
        }),
        fallbackFromText: () => ({ name: null, email: null, phone: null, skills: [], experience_years: null, current_role: null, summary: null }),
        onState: input.onState,
        extractorVersion: 'x1',
        classifyScan: (s: string) =>
          (s === 'clean' || s === 'infected' ? 'verdict'
            : s.startsWith('scanner_signatures') || s === 'scanner_unavailable' ? 'availability'
              : 'transient'),
      },
    }),
    resolveMappingForLink: async () => null,
    materialization: {} as MaterializationStore,
  } as never;

  const handlers = buildAshbyHandlers(runtime, {
    scannerGate: async () => ({ action: 'proceed', mode: 'clamav' }),
  });
  const result = await handlers[ASHBY_INGESTION_QUEUE]({
    id: 'job_1', name: ASHBY_INGESTION_QUEUE, payload: { applicationLinkId: 'link_1' },
    attempts: 1, maxAttempts: 5, createdAt: new Date().toISOString(),
  } as never);
  return (result as { reasonCode: string }).reasonCode;
}

// ═══════════════════════════════════════════════════════════════════════

describe('worker → health seam: a deferred job is COUNTED as deferred', () => {
  it.each([
    'scanner_signatures_unavailable',
    'scanner_signatures_stale',
    'scanner_unavailable',
    'scanner_busy',
    'scanner_timeout',
    'scanner_error',
  ])('counts a post-scan deferral on %s', async (scanStatus) => {
    // Whatever the real handler mints — not a string this test invented.
    const reason = await realDeferReason(scanStatus);

    const backlog = await readBacklog(makeClient({
      job_queue: [{
        name: ASHBY_INGESTION_QUEUE, status: 'delayed',
        defer_reason: reason, deferred_at: '2026-08-19T00:00:00.000Z',
        scheduled_at: '2026-08-19T00:00:45.000Z',
      }],
      job_dlq: [], ashby_operations: [], ashby_application_links: [],
      ashby_sync_checkpoints: [],
    }), Date.parse('2026-08-19T00:20:00.000Z'));

    expect(backlog.scannerDeferredJobs).toBe(1);
    expect(backlog.scannerDeferredOldestAgeSec).toBe(1200);
  });

  it('the handler-entry gate reason is counted by the same filter', async () => {
    // Both deferral sites now mint through one function; assert the OTHER one
    // lands in the same vocabulary rather than trusting that it does.
    const backlog = await readBacklog(makeClient({
      job_queue: [{
        name: ASHBY_INGESTION_QUEUE, status: 'delayed',
        defer_reason: 'scanner_signatures_missing', deferred_at: '2026-08-19T00:00:00.000Z',
        scheduled_at: '2026-08-19T00:00:45.000Z',
      }],
      job_dlq: [], ashby_operations: [], ashby_application_links: [],
      ashby_sync_checkpoints: [],
    }), Date.parse('2026-08-19T00:05:00.000Z'));

    expect(backlog.scannerDeferredJobs).toBe(1);
    expect(backlog.scannerDeferredOldestAgeSec).toBe(300);
  });

  it('a stalled deferral reaches the degrade verdict end to end', async () => {
    const reason = await realDeferReason('scanner_signatures_unavailable');
    const stalledFor = DEGRADE_THRESHOLDS.scannerDeferredAgeSec + 60;
    const backlog = await readBacklog(makeClient({
      job_queue: [{
        name: ASHBY_INGESTION_QUEUE, status: 'delayed',
        defer_reason: reason, deferred_at: '2026-08-19T00:00:00.000Z',
        scheduled_at: '2026-08-19T00:00:45.000Z',
      }],
      job_dlq: [], ashby_operations: [], ashby_application_links: [],
      ashby_sync_checkpoints: [],
    }), Date.parse('2026-08-19T00:00:00.000Z') + stalledFor * 1000);

    const verdict = evaluateDegradation({
      active: true,
      scheduler: { registeredInThisProcess: false, running: false, loops: [] },
      backlog,
      scanner: { mode: 'clamav', ready: true, signatureAgeSec: 30, maxAgeSec: 86_400, reason: null },
    });
    // A machine whose OWN scanner is healthy must still report jobs stuck
    // waiting on another one — the counter is fleet-wide durable evidence.
    expect(verdict.status).toBe('degraded');
    expect(verdict.reasons).toContain('scanner_deferral_stalled');
  });

  it('does NOT count a non-scanner deferral or a plain retry', async () => {
    const backlog = await readBacklog(makeClient({
      job_queue: [
        // A deferral for some future non-scanner prerequisite.
        { name: ASHBY_INGESTION_QUEUE, status: 'delayed', defer_reason: 'mapping_inactive', deferred_at: '2026-08-19T00:00:00.000Z', scheduled_at: '2026-08-19T00:01:00.000Z' },
        // An ordinary failing retry: delayed, but no deferral marker at all.
        { name: ASHBY_INGESTION_QUEUE, status: 'delayed', defer_reason: null, deferred_at: null, scheduled_at: '2026-08-19T00:01:00.000Z' },
      ],
      job_dlq: [], ashby_operations: [], ashby_application_links: [],
      ashby_sync_checkpoints: [],
    }), Date.parse('2026-08-19T00:20:00.000Z'));

    expect(backlog.scannerDeferredJobs).toBe(0);
    expect(backlog.scannerDeferredOldestAgeSec).toBeNull();
  });

  it('the filter is not vacuous: the fake would reject a mismatched prefix', async () => {
    // Guards the guard. If `like` were ignored by this fake, every assertion
    // above would pass against the broken `scan_scanner_*` vocabulary too.
    const backlog = await readBacklog(makeClient({
      job_queue: [{
        name: ASHBY_INGESTION_QUEUE, status: 'delayed',
        defer_reason: 'scan_scanner_busy', deferred_at: '2026-08-19T00:00:00.000Z',
        scheduled_at: '2026-08-19T00:01:00.000Z',
      }],
      job_dlq: [], ashby_operations: [], ashby_application_links: [],
      ashby_sync_checkpoints: [],
    }), Date.parse('2026-08-19T00:20:00.000Z'));

    expect(backlog.scannerDeferredJobs).toBe(0);
  });
});
