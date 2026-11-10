/**
 * The Ashby progress worker (M031 S3): integrations/ashby/progress-worker.ts.
 *
 *   Ashby JSON fixture ─► REAL AshbyClient (injected transport, no network)
 *   ─► runProgressPass ─► an in-memory store with the 0139 rules
 *
 * The store double follows the functions it stands for: a claim leases due
 * rows in next_check_at order; a record is refused unless its lease still
 * holds; intervals are upserted on Ashby's history id and a row a fresh read
 * no longer returns is marked gone, never deleted. The SQL itself runs on real
 * Postgres in app/supabase/tests/policy_tests.sql (section "0139").
 *
 * Fixture shapes follow developers.ashbyhq.com (application.info,
 * application.listHistory, interviewStage.info, the 403 and 200
 * success:false missing-permission answers pinned in
 * ashby-recommendation-tag-contract.test.ts). Every id and name is synthetic.
 */
import { describe, expect, it, vi } from 'vitest';
import { createAshbyClient, type AshbyTransportResponse } from '../integrations/ashby/client.js';
import { AshbyError } from '../integrations/ashby/errors.js';
import { ASHBY_OPERATIONS } from '../integrations/ashby/types.js';
import { loadAshbyProgressConfig, loadAshbyRuntimeConfig, type AshbyProgressConfig } from '../integrations/ashby/config.js';
import {
  CALL_BUDGET_MS,
  CALLS_PER_APPLICATION,
  MAX_HISTORY_PAGES,
  MAX_SCANNER_SKIPS,
  MAX_STAGE_LOOKUPS_PER_PASS,
  PROGRESS_READ_OPERATIONS,
  RATE_LIMIT_HOLD_MS,
  SCANNER_PRESSURE_REASONS,
  STAGE_LOOKUP_BUDGET_MS,
  assertProgressReadOnly,
  callBudgetMs,
  codeCounts,
  createProgressStore,
  errorBackoffMs,
  estimateBackfill,
  leaseSecondsFor,
  needsHistoryRead,
  nextCheckDelayMs,
  readApplicationInfo,
  readHistoryRow,
  runProgressPass,
  type ClaimedProgress,
  type ProgressReader,
  type ProgressRecord,
  type ProgressRunInput,
  type ProgressStore,
} from '../integrations/ashby/progress-worker.js';
import { LIVE_STAGES } from './support/ashby-live-stages.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PLAN = 'plan-shared-0001';
const ACTOR = 'actor-staff-7f2f1c3e';
const stage = (id: string) => {
  const s = LIVE_STAGES.find((x) => x.id === id)!;
  return { id: s.id, title: s.title, type: s.type, orderInInterviewPlan: LIVE_STAGES.indexOf(s), interviewStageGroupId: null, interviewPlanId: PLAN };
};

const CONFIG: AshbyProgressConfig = {
  ...loadAshbyProgressConfig({}),
  enabled: true,
};

// ── Fixtures ────────────────────────────────────────────────────────────────

/** A documented Application, with the personal fields the worker must never copy. */
function application(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-11-09T09:00:00.000Z',
    status: 'Active',
    candidate: {
      id: 'cand-7f2f1c3e',
      name: 'Synthetic Person',
      primaryEmailAddress: { value: 'synthetic@example.invalid', type: 'Work', isPrimary: true },
      primaryPhoneNumber: { value: '+910000000000', type: 'Mobile', isPrimary: true },
    },
    currentInterviewStage: stage('stage-09-r1'),
    job: { id: 'job-a', title: 'Sales Program Advisor', hiringTeam: [{ email: 'recruiter@example.invalid' }] },
    archiveReason: null,
    archivedAt: null,
    customFields: [{ title: 'Salary expectation', value: '12 LPA' }],
    hiringTeam: [{ userId: 'user-1', email: 'hm@example.invalid', role: 'Hiring Manager' }],
    creditedToUser: { id: 'user-2', firstName: 'Recruiter', email: 'r@example.invalid' },
    ...over,
  };
}

/** One history row. `left` undefined leaves the key out (the live current-row quirk). */
function hist(id: string, stageId: string, entered: string, left?: string | null, actorId?: string | null, n = 0) {
  const s = LIVE_STAGES.find((x) => x.id === stageId);
  const row: Record<string, unknown> = {
    id, stageId, title: s?.title ?? 'Old Stage', enteredStageAt: entered, stageNumber: n,
    allowedActions: ['delete', 'set_entered_at'],
  };
  if (left !== undefined) row.leftStageAt = left;
  if (actorId !== undefined) row.actorId = actorId;
  return row;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): AshbyTransportResponse => {
  const text = JSON.stringify(body);
  return { status, ok: status >= 200 && status < 300, headers: { get: (k: string) => headers[k.toLowerCase()] ?? null }, text: async () => text };
};
const success = (results: unknown, extra: Record<string, unknown> = {}) => json(200, { success: true, results, ...extra });
const MISSING_403 = () => json(403, { success: false, errorInfo: { code: 'missing_endpoint_permission', message: 'Missing permission: candidatesRead' } });
const MISSING_200 = () => json(200, { success: false, errorInfo: { code: 'missing_endpoint_permission', message: 'no' } });

type Route = (body: Record<string, unknown>) => AshbyTransportResponse;

/** A tenant behind a REAL client. Routes by path; each may answer per call. */
function tenant(routes: Record<string, Route>, maxAttempts = 1) {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const client = createAshbyClient({
    apiKey: 'SYNTHETIC_KEY_0001',
    maxAttempts,
    random: () => 0.5,
    sleep: async () => {},
    transport: async (req) => {
      const path = new URL(req.url).pathname;
      const body = JSON.parse(req.body) as Record<string, unknown>;
      requests.push({ path, body });
      const route = routes[path];
      if (!route) throw new Error(`unexpected call to ${path}`);
      return route(body);
    },
  });
  return { client, requests };
}

// ── The store double: the 0139 rules, in memory ─────────────────────────────

interface MemRow {
  progressId: string;
  linkId: string;
  appId: string;
  next: string;
  attempts: number;
  status: string | null;
  currentStageId: string | null;
  currentStageEnteredAt: string | null;
  archivedAt: string | null;
  ashbyUpdatedAt: string | null;
  archiveReasonId: string | null;
  lastCheckedAt: string | null;
  errorCode: string | null;
  updatedAt: string;
}

interface MemInterval {
  linkId: string;
  stageId: string;
  title: string | null;
  enteredAt: string;
  leftAt: string | null;
  stageNumber: number | null;
  movedByPerson: boolean | null;
  lastSeenAt: string;
  goneAt: string | null;
}

const FAR = '9999-12-31T00:00:00.000Z';

function memoryStore(apps: string[], options: {
  catalog?: Array<[string, 'plan' | 'history', string | null]>;
  scannerBusy?: boolean;
  backfillOpen?: boolean;
  /** When the open backfill began (the claim answers it); implies backfillOpen. */
  backfillStartedAt?: string | null;
  t0?: number;
} = {}) {
  const t0 = options.t0 ?? Date.now();
  const backfill = { startedAt: options.backfillStartedAt ?? null };
  const rows: MemRow[] = apps.map((appId, i) => ({
    progressId: `progress-${i}`, linkId: `link-${i}`, appId,
    // Newest first, as a seed or a backfill orders them.
    next: new Date(t0 - (apps.length - i) * 1000).toISOString(),
    attempts: 0, status: null, currentStageId: null, currentStageEnteredAt: null, archivedAt: null,
    ashbyUpdatedAt: null, archiveReasonId: null, lastCheckedAt: null, errorCode: null, updatedAt: new Date(t0 - DAY).toISOString(),
  }));
  const intervals = new Map<string, MemInterval>();
  const catalog = new Map<string, { source: 'plan' | 'history'; stageType: string | null; title?: string | null; milestone?: string | null }>(
    (options.catalog ?? LIVE_STAGES.map((s) => [s.id, 'plan', s.type] as [string, 'plan', string])).map(([id, source, stageType]) => [id, { source, stageType }]),
  );
  const reasons = new Map<string, unknown>();
  const records: Array<{ progressId: string; record: ProgressRecord }> = [];
  const runs: ProgressRunInput[] = [];
  const historyReadAt = (linkId: string): string | null => {
    const seen = [...intervals.values()].filter((i) => i.linkId === linkId).map((i) => i.lastSeenAt).sort();
    return seen.length ? seen[seen.length - 1] : null;
  };
  const toClaimed = (r: MemRow): ClaimedProgress => ({
    progressId: r.progressId, linkId: r.linkId, applicationId: r.appId, leaseUntil: r.next, attempts: r.attempts,
    stored: {
      status: r.status, currentStageId: r.currentStageId, currentStageEnteredAt: r.currentStageEnteredAt,
      archivedAt: r.archivedAt, ashbyUpdatedAt: r.ashbyUpdatedAt, lastCheckedAt: r.lastCheckedAt, historyReadAt: historyReadAt(r.linkId),
    },
  });
  const store = {
    scannerBusy: vi.fn(async () => options.scannerBusy === true),
    claimDue: vi.fn(async ({ limit, leaseSeconds, nowIso }: { limit: number; leaseSeconds: number; seedLimit: number; nowIso: string }) => {
      const now = Date.parse(nowIso);
      // Atomic, like FOR UPDATE SKIP LOCKED plus the moved next_check_at.
      const due = rows.filter((r) => Date.parse(r.next) <= now).sort((a, b) => Date.parse(a.next) - Date.parse(b.next)).slice(0, limit);
      for (const r of due) {
        r.next = new Date(now + leaseSeconds * 1000).toISOString();
        r.attempts += 1;
      }
      return {
        seeded: 0,
        backfillOpen: options.backfillOpen === true || backfill.startedAt !== null,
        backfillStartedAt: backfill.startedAt,
        claimed: due.map(toClaimed),
      };
    }),
    knownStages: vi.fn(async (ids: string[]) => new Map([...catalog].filter(([id]) => ids.includes(id)).map(([id, v]) => [id, { source: v.source, stageType: v.stageType }]))),
    christyStageIds: vi.fn(async () => ['stage-05-christy']),
    record: vi.fn(async (progressId: string, leaseUntil: string, nowIso: string, record: ProgressRecord) => {
      const r = rows.find((x) => x.progressId === progressId);
      if (!r) return { status: 'not_found' as const };
      if (r.next !== leaseUntil) return { status: 'lease_lost' as const };
      records.push({ progressId, record });
      if (record.outcome === 'deferred') {
        r.next = record.next_check_at;
        r.attempts = Math.max(0, r.attempts - 1);
        return { status: 'ok' as const, changed: false };
      }
      r.updatedAt = nowIso;
      if (record.outcome === 'error') {
        r.errorCode = record.error_code;
        r.next = record.next_check_at;
        return { status: 'ok' as const, changed: false };
      }
      if (record.outcome === 'gone') {
        r.errorCode = record.error_code;
        r.next = FAR;
        r.attempts = 0;
        return { status: 'ok' as const, changed: false };
      }
      let changed = false;
      if (record.history) {
        const fresh = new Set(record.history.map((h) => h.history_id));
        for (const h of record.history) {
          const had = intervals.get(h.history_id);
          const next: MemInterval = {
            linkId: r.linkId, stageId: h.stage_id, title: h.title ?? had?.title ?? null, enteredAt: h.entered_at, leftAt: h.left_at,
            stageNumber: h.stage_number, movedByPerson: h.moved_by_person, lastSeenAt: nowIso, goneAt: null,
          };
          if (!had || had.goneAt || had.enteredAt !== next.enteredAt || had.leftAt !== next.leftAt || had.stageId !== next.stageId) changed = true;
          intervals.set(h.history_id, next);
        }
        for (const [id, i] of intervals) {
          if (i.linkId === r.linkId && !fresh.has(id) && i.goneAt === null) {
            intervals.set(id, { ...i, goneAt: nowIso });
            changed = true;
          }
        }
      }
      for (const s of record.stages) {
        const had = catalog.get(s.stage_id);
        if (!had) catalog.set(s.stage_id, { source: 'history', stageType: s.stage_type, title: s.title, milestone: s.default_milestone });
        else if (had.source === 'history') catalog.set(s.stage_id, { ...had, stageType: had.stageType ?? s.stage_type });
      }
      if (record.reason) reasons.set(record.reason.reason_id, record.reason);
      const a = record.application;
      if (r.status !== a.status || r.currentStageId !== a.current_stage_id || r.archivedAt !== a.archived_at
        || r.archiveReasonId !== a.archive_reason_id || r.currentStageEnteredAt !== a.current_stage_entered_at) changed = true;
      Object.assign(r, {
        status: a.status, currentStageId: a.current_stage_id, currentStageEnteredAt: a.current_stage_entered_at,
        archivedAt: a.archived_at, ashbyUpdatedAt: a.ashby_updated_at, archiveReasonId: a.archive_reason_id,
        lastCheckedAt: nowIso, errorCode: null, attempts: 0, next: record.next_check_at,
      });
      return { status: 'ok' as const, changed };
    }),
    recordRun: vi.fn(async (run: ProgressRunInput) => { runs.push(run); return { backfillFinished: false }; }),
    overview: vi.fn(async () => { throw new Error('not used by a pass'); }),
    startBackfill: vi.fn(async () => { throw new Error('not used by a pass'); }),
  } satisfies ProgressStore;
  /** Make every row due again (a test's stand-in for time passing). */
  const dueAgain = (at = Date.now()) => { for (const r of rows) r.next = new Date(at - 1000).toISOString(); };
  /** Open (or close, with null) a backfill that began at `iso`. */
  const setBackfill = (iso: string | null) => { backfill.startedAt = iso; };
  return { store, rows, intervals, catalog, reasons, records, runs, dueAgain, setBackfill };
}

const okRecords = (records: Array<{ record: ProgressRecord }>) =>
  records.map((r) => r.record).filter((r): r is Extract<ProgressRecord, { outcome: 'ok' }> => r.outcome === 'ok');

// A pass with a fixed clock (the client's own deadline uses Date.now(), which this is close to).
function pass(reader: ProgressReader, store: ProgressStore, over: Partial<AshbyProgressConfig> = {}, t = Date.now()) {
  const sleeps: number[] = [];
  return {
    sleeps,
    run: runProgressPass({
      reader, store, config: { ...CONFIG, ...over }, now: () => t,
      sleep: async (ms) => { sleeps.push(ms); },
    }),
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Reading application.info
// ═══════════════════════════════════════════════════════════════════════

describe('reading application.info', () => {
  it('an active application: status, current stage with type, order, plan and group, job, updatedAt', () => {
    const view = readApplicationInfo(application('app-1'));
    expect(view).toEqual({
      status: 'Active',
      currentStage: { id: 'stage-09-r1', title: 'R1', type: 'Active', orderInPlan: 8, groupId: null, planId: PLAN },
      currentJobId: 'job-a',
      archiveReason: null,
      archivedAt: null,
      updatedAt: '2026-11-09T09:00:00.000Z',
    });
    expect(readApplicationInfo({ application: application('app-1') })).toEqual(view);
  });

  it('a hired application', () => {
    const view = readApplicationInfo(application('app-h', { status: 'Hired', currentInterviewStage: stage('stage-18-hired') }));
    expect(view?.status).toBe('Hired');
    expect(view?.currentStage).toMatchObject({ id: 'stage-18-hired', type: 'Hired', orderInPlan: 17 });
  });

  it('an archived application with its reason from the catalogue, and one with none', () => {
    const withReason = readApplicationInfo(application('app-a', {
      status: 'Archived', archivedAt: '2026-11-08T10:00:00Z', currentInterviewStage: stage('stage-05-christy'),
      archiveReason: { id: 'reason-1', text: 'Not a fit‮', reasonType: 'RejectedByOrg', isArchived: false, customFields: [{ value: 'typed note' }] },
    }));
    expect(withReason?.archiveReason).toEqual({ id: 'reason-1', text: 'Not a fit', reasonType: 'RejectedByOrg', isArchived: false });
    expect(withReason?.archivedAt).toBe('2026-11-08T10:00:00.000Z');
    const none = readApplicationInfo(application('app-b', { status: 'Archived', archivedAt: '2026-11-08T10:00:00Z', archiveReason: null }));
    expect(none?.archiveReason).toBeNull();
    expect(none?.status).toBe('Archived');
  });

  it('copies nothing personal: no name, email, phone, custom field, hiring team or credited user', () => {
    const text = JSON.stringify(readApplicationInfo(application('app-1')));
    for (const leaked of ['Synthetic Person', 'example.invalid', '+910000000000', 'Salary', '12 LPA', 'Hiring Manager', 'Recruiter', 'cand-7f2f1c3e', 'Sales Program Advisor']) {
      expect(text).not.toContain(leaked);
    }
  });

  it('a payload with neither a status nor a stage is malformed; an unknown status is kept as unknown', () => {
    expect(readApplicationInfo(null)).toBeNull();
    expect(readApplicationInfo([])).toBeNull();
    expect(readApplicationInfo({ id: 'app-1' })).toBeNull();
    expect(readApplicationInfo({ id: 'app-1', status: 'Pending' })?.status).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Reading a history row
// ═══════════════════════════════════════════════════════════════════════

describe('reading a history row', () => {
  it('the current row without leftStageAt (the live quirk) is open; null is open too', () => {
    expect(readHistoryRow(hist('h3', 'stage-09-r1', '2026-11-09T08:00:00Z'))).toMatchObject({ leftAt: null, enteredAt: '2026-11-09T08:00:00.000Z' });
    expect(readHistoryRow(hist('h3', 'stage-09-r1', '2026-11-09T08:00:00Z', null))?.leftAt).toBeNull();
    expect(readHistoryRow(hist('h2', 'stage-07-hm', '2026-11-01T00:00:00Z', '2026-11-09T08:00:00Z'))?.leftAt).toBe('2026-11-09T08:00:00.000Z');
  });

  it('keeps only whether a person moved it: actorId set, null, or absent; never the id', () => {
    const byPerson = readHistoryRow(hist('h1', 'stage-07-hm', '2026-11-01T00:00:00Z', null, ACTOR));
    expect(byPerson?.movedByPerson).toBe(true);
    expect(JSON.stringify(byPerson)).not.toContain(ACTOR);
    expect(readHistoryRow(hist('h1', 'stage-07-hm', '2026-11-01T00:00:00Z', null, null))?.movedByPerson).toBe(false);
    expect(readHistoryRow(hist('h1', 'stage-07-hm', '2026-11-01T00:00:00Z', null))?.movedByPerson).toBeNull();
  });

  it('a row with no id, stage or entry time, or an exit that is not a time, is malformed', () => {
    expect(readHistoryRow({ stageId: 'stage-07-hm', enteredStageAt: '2026-11-01T00:00:00Z' })).toBeNull();
    expect(readHistoryRow({ id: 'h1', enteredStageAt: '2026-11-01T00:00:00Z' })).toBeNull();
    expect(readHistoryRow({ id: 'h1', stageId: 'stage-07-hm', enteredStageAt: 'yesterday' })).toBeNull();
    expect(readHistoryRow({ id: 'h1', stageId: 'stage-07-hm', enteredStageAt: '2026-11-01T00:00:00Z', leftStageAt: 7 })).toBeNull();
    expect(readHistoryRow({ id: 'h1', interviewStageId: 'stage-07-hm', enteredStageAt: '2026-11-01T00:00:00Z' })?.stageId).toBe('stage-07-hm');
  });

  it('sanitizes the title and bounds the stage number', () => {
    const row = readHistoryRow({ id: 'h1', stageId: 's', title: 'R​1⁦', enteredStageAt: '2026-11-01T00:00:00Z', stageNumber: -1 });
    expect(row?.title).toBe('R 1');
    expect(row?.stageNumber).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Cadence
// ═══════════════════════════════════════════════════════════════════════

describe('cadence', () => {
  const T = Date.parse('2026-11-10T12:00:00Z');
  const iso = (ms: number) => new Date(ms).toISOString();
  const c = CONFIG.cadenceHours;
  const at = (input: Partial<Parameters<typeof nextCheckDelayMs>[0]>) =>
    nextCheckDelayMs({ status: 'Active', currentStageEnteredAt: null, updatedAt: null, archivedAt: null, ...input }, T, c) / HOUR;

  it('defaults: 6 h, 24 h, 168 h, 720 h, and history at least every 168 h', () => {
    expect(c).toEqual({ activeRecent: 6, active: 24, terminal: 168, terminalOld: 720, historyMaxAge: 168 });
  });

  it('Active and moved within 14 days: every 6 h; longer ago, or never: daily', () => {
    expect(at({ currentStageEnteredAt: iso(T - 2 * DAY) })).toBe(6);
    expect(at({ currentStageEnteredAt: iso(T - 14 * DAY) })).toBe(6);
    expect(at({ currentStageEnteredAt: iso(T - 14 * DAY - 1) })).toBe(24);
    expect(at({ currentStageEnteredAt: iso(T - 30 * DAY), updatedAt: iso(T - DAY) })).toBe(6);
    expect(at({})).toBe(24);
    expect(at({ status: 'Lead', currentStageEnteredAt: iso(T - DAY) })).toBe(6);
    expect(at({ status: null, currentStageEnteredAt: iso(T - 40 * DAY) })).toBe(24);
  });

  it('Hired or Archived: weekly for 90 days from finishing, then monthly', () => {
    expect(at({ status: 'Hired', currentStageEnteredAt: iso(T - 10 * DAY) })).toBe(168);
    expect(at({ status: 'Hired', currentStageEnteredAt: iso(T - 90 * DAY) })).toBe(168);
    expect(at({ status: 'Hired', currentStageEnteredAt: iso(T - 90 * DAY - 1) })).toBe(720);
    // An archive is dated by archivedAt, not by its stage entry.
    expect(at({ status: 'Archived', archivedAt: iso(T - 100 * DAY), currentStageEnteredAt: iso(T - DAY) })).toBe(720);
    expect(at({ status: 'Archived', archivedAt: iso(T - 5 * DAY), currentStageEnteredAt: iso(T - 200 * DAY) })).toBe(168);
    // Unknown finishing time: the fresher cadence.
    expect(at({ status: 'Archived' })).toBe(168);
  });

  it('follows the tunables', () => {
    const custom = { activeRecent: 2, active: 12, terminal: 48, terminalOld: 240, historyMaxAge: 24 };
    expect(nextCheckDelayMs({ status: 'Active', currentStageEnteredAt: iso(T - DAY), updatedAt: null, archivedAt: null }, T, custom)).toBe(2 * HOUR);
    expect(nextCheckDelayMs({ status: 'Hired', currentStageEnteredAt: iso(T - 200 * DAY), updatedAt: null, archivedAt: null }, T, custom)).toBe(240 * HOUR);
  });

  it('a failed read backs off: a day for a refused permission or key, 15 minutes for a rate limit, doubling otherwise', () => {
    expect(errorBackoffMs('missing_endpoint_permission', 1)).toBe(DAY);
    expect(errorBackoffMs('forbidden', 1)).toBe(DAY);
    expect(errorBackoffMs('rate_limited', 9)).toBe(15 * 60_000);
    expect([1, 2, 3, 4].map((n) => errorBackoffMs('server_error', n) / 60_000)).toEqual([15, 30, 60, 120]);
    expect(errorBackoffMs('server_error', 50)).toBe(DAY);
  });

  it('the history is re-read when anything changed, when never read, or when older than the max age', () => {
    const T2 = Date.parse('2026-11-10T12:00:00Z');
    const app = readApplicationInfo(application('app-1'))!;
    const stored = {
      status: 'Active', currentStageId: 'stage-09-r1', currentStageEnteredAt: '2026-11-09T08:00:00.000Z', archivedAt: null,
      ashbyUpdatedAt: '2026-11-09T09:00:00.000Z', lastCheckedAt: '2026-11-10T06:00:00.000Z', historyReadAt: '2026-11-10T06:00:00.000Z',
    };
    const max = 168 * HOUR;
    expect(needsHistoryRead({ stored }, app, T2, max)).toBe(false);
    expect(needsHistoryRead({ stored: { ...stored, lastCheckedAt: null } }, app, T2, max)).toBe(true);
    expect(needsHistoryRead({ stored: { ...stored, historyReadAt: null } }, app, T2, max)).toBe(true);
    expect(needsHistoryRead({ stored: { ...stored, historyReadAt: '2026-11-03T12:00:00.000Z' } }, app, T2, max)).toBe(true);
    expect(needsHistoryRead({ stored: { ...stored, status: 'Lead' } }, app, T2, max)).toBe(true);
    expect(needsHistoryRead({ stored: { ...stored, currentStageId: 'stage-07-hm' } }, app, T2, max)).toBe(true);
    expect(needsHistoryRead({ stored: { ...stored, ashbyUpdatedAt: '2026-11-08T09:00:00.000Z' } }, app, T2, max)).toBe(true);
    expect(needsHistoryRead({ stored }, { ...app, archivedAt: '2026-11-10T00:00:00.000Z' }, T2, max)).toBe(true);
  });

  it('an open backfill re-reads every history read before it began, change or not (S3-4)', () => {
    const T2 = Date.parse('2026-11-10T12:00:00Z');
    const app = readApplicationInfo(application('app-1'))!;
    const stored = {
      status: 'Active', currentStageId: 'stage-09-r1', currentStageEnteredAt: '2026-11-09T08:00:00.000Z', archivedAt: null,
      ashbyUpdatedAt: '2026-11-09T09:00:00.000Z', lastCheckedAt: '2026-11-10T06:00:00.000Z', historyReadAt: '2026-11-10T06:00:00.000Z',
    };
    const max = 168 * HOUR;
    expect(needsHistoryRead({ stored }, app, T2, max, null)).toBe(false);
    // Begun after the history was last read: read it again.
    expect(needsHistoryRead({ stored }, app, T2, max, '2026-11-10T07:00:00.000Z')).toBe(true);
    // Postgres answers microseconds; read after the backfill began: not again.
    expect(needsHistoryRead({ stored }, app, T2, max, '2026-11-10T05:59:59.999999+00:00')).toBe(false);
  });

  it('a backfill estimate: two calls an application at the worker pace, one for an application Ashby no longer has', () => {
    expect(estimateBackfill(600, CONFIG)).toEqual({ expectedCalls: 1_200, estimatedMinutes: 10, requestsPerSecond: 2 });
    expect(estimateBackfill(600, CONFIG, 10)).toEqual({ expectedCalls: 1_190, estimatedMinutes: 10, requestsPerSecond: 2 });
    expect(estimateBackfill(3, CONFIG, 10).expectedCalls).toBe(3);
    expect(estimateBackfill(0, CONFIG)).toEqual({ expectedCalls: 0, estimatedMinutes: 0, requestsPerSecond: 2 });
    expect(CALLS_PER_APPLICATION).toBe(2);
  });

  it('each Ashby call has its own budget, below the pass deadline (S3-1)', () => {
    expect(CALL_BUDGET_MS).toBe(20_000);
    expect(callBudgetMs(CONFIG)).toBe(20_000);
    expect(callBudgetMs({ passDeadlineMs: 5_000 })).toBe(2_500);
    expect(callBudgetMs({ passDeadlineMs: 300_000 })).toBe(20_000);
    expect(STAGE_LOOKUP_BUDGET_MS).toBeLessThan(CALL_BUDGET_MS);
  });

  it('the lease outlasts a whole pass', () => {
    expect(leaseSecondsFor(CONFIG)).toBe(Math.ceil(CONFIG.passDeadlineMs / 1000) + 60);
    expect(leaseSecondsFor({ ...CONFIG, passDeadlineMs: 300_000 }) * 1000).toBeGreaterThan(300_000);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Config
// ═══════════════════════════════════════════════════════════════════════

describe('ASHBY_PROGRESS_* config', () => {
  it('is off unless the switch is the literal "true", with small defaults', () => {
    const cfg = loadAshbyProgressConfig({});
    expect(cfg).toEqual({
      enabled: false, intervalMs: 120_000, drainIntervalMs: 5_000, batchSize: 10, passDeadlineMs: 45_000, minCallIntervalMs: 500,
      cadenceHours: { activeRecent: 6, active: 24, terminal: 168, terminalOld: 720, historyMaxAge: 168 },
    });
    for (const v of ['1', 'TRUE', 'yes', ' true']) expect(loadAshbyProgressConfig({ ASHBY_PROGRESS_ENABLED: v }).enabled).toBe(false);
    expect(loadAshbyProgressConfig({ ASHBY_PROGRESS_ENABLED: 'true' }).enabled).toBe(true);
    expect(loadAshbyRuntimeConfig({}).progress?.enabled).toBe(false);
  });

  it('clamps every tunable and ignores garbage', () => {
    const cfg = loadAshbyProgressConfig({
      ASHBY_PROGRESS_BATCH_SIZE: '5000', ASHBY_PROGRESS_PASS_DEADLINE_MS: '1', ASHBY_PROGRESS_MIN_CALL_INTERVAL_MS: 'fast',
      ASHBY_PROGRESS_ACTIVE_RECENT_HOURS: '2', ASHBY_PROGRESS_TERMINAL_OLD_HOURS: '-3',
    });
    expect(cfg.batchSize).toBe(50);
    expect(cfg.passDeadlineMs).toBe(5_000);
    expect(cfg.minCallIntervalMs).toBe(500);
    expect(cfg.cadenceHours.activeRecent).toBe(2);
    expect(cfg.cadenceHours.terminalOld).toBe(720);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// A pass
// ═══════════════════════════════════════════════════════════════════════

describe('a pass: switched off, or the machine short of CPU', () => {
  it('off: no query, no Ashby call', async () => {
    const mem = memoryStore(['app-1']);
    const { client, requests } = tenant({});
    const r = await runProgressPass({ reader: client, store: mem.store, config: { ...CONFIG, enabled: false } });
    expect(r.skipped).toBe('disabled');
    for (const fn of Object.values(mem.store)) expect(fn).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });

  it('while the resume scanner defers ingestion, the pass is skipped before any claim', async () => {
    const mem = memoryStore(['app-1'], { scannerBusy: true });
    const { client, requests } = tenant({});
    const r = await pass(client, mem.store).run;
    expect(r.skipped).toBe('scanner_busy');
    expect(mem.store.claimDue).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });

  it('a pause is capped: after MAX_SCANNER_SKIPS skipped passes in a row one application is read, and the skips go on its run row (S3-3)', async () => {
    const T = Date.now();
    const route = {
      '/application.info': (b: Record<string, unknown>) => success(application(String(b.applicationId))),
      '/application.listHistory': (b: Record<string, unknown>) => success([hist(`${b.applicationId}-h`, 'stage-09-r1', '2026-10-01T00:00:00Z', undefined, ACTOR, 0)], { moreDataAvailable: false }),
    };
    const mem = memoryStore(['a1', 'a2', 'a3'], { scannerBusy: true, t0: T });
    const below = await runProgressPass({ reader: tenant(route).client, store: mem.store, config: CONFIG, now: () => T, sleep: async () => {}, scannerSkips: MAX_SCANNER_SKIPS - 1 });
    expect(below.skipped).toBe('scanner_busy');
    expect(mem.store.claimDue).not.toHaveBeenCalled();

    const capped = await runProgressPass({ reader: tenant(route).client, store: mem.store, config: CONFIG, now: () => T, sleep: async () => {}, scannerSkips: MAX_SCANNER_SKIPS });
    expect(capped).toMatchObject({ skipped: null, trickle: true, claimed: 1, checked: 1, drain: false });
    expect(mem.store.claimDue).toHaveBeenCalledWith(expect.objectContaining({ limit: 1 }));
    expect(mem.runs).toEqual([expect.objectContaining({ checked: 1, errors: { scanner_paused: MAX_SCANNER_SKIPS } })]);
  });

  it('the first pass after the scanner recovers runs a full batch and records the passes it skipped, even with nothing to read (S3-3)', async () => {
    const T = Date.now();
    const quiet = memoryStore([], { t0: T });
    const r = await runProgressPass({ reader: tenant({}).client, store: quiet.store, config: CONFIG, now: () => T, sleep: async () => {}, scannerSkips: 3 });
    expect(r).toMatchObject({ skipped: null, trickle: false, claimed: 0 });
    expect(quiet.store.claimDue).toHaveBeenCalledWith(expect.objectContaining({ limit: CONFIG.batchSize }));
    expect(quiet.runs).toEqual([expect.objectContaining({ checked: 0, errors: { scanner_paused: 3 } })]);
  });
});

describe('a pass: what one application read records', () => {
  const T = Date.now();
  const entered = new Date(T - HOUR).toISOString();

  it('an active application: every history page, the open current row, who moved it as a boolean, the 6 h cadence', async () => {
    const mem = memoryStore(['app-1'], { t0: T });
    const { client, requests } = tenant({
      '/application.info': () => success(application('app-1', { updatedAt: entered })),
      '/application.listHistory': (body) => body.cursor === 'page-2'
        ? success([hist('h3', 'stage-09-r1', entered, undefined, ACTOR, 2)], { moreDataAvailable: false })
        : success([
          hist('h1', 'stage-05-christy', '2026-11-01T00:00:00Z', '2026-11-03T00:00:00Z', null, 0),
          hist('h2', 'stage-07-hm', '2026-11-03T00:00:00Z', entered, ACTOR, 1),
        ], { moreDataAvailable: true, nextCursor: 'page-2' }),
    });
    const r = await pass(client, mem.store, {}, T).run;
    expect(r).toMatchObject({ skipped: null, claimed: 1, checked: 1, changed: 1, deferred: 0, errors: {}, calls: 3 });
    expect(requests.map((q) => q.path)).toEqual(['/application.info', '/application.listHistory', '/application.listHistory']);
    expect(requests[1].body).toEqual({ applicationId: 'app-1', limit: 100 });
    expect(requests[2].body).toEqual({ applicationId: 'app-1', cursor: 'page-2', limit: 100 });
    const [rec] = okRecords(mem.records);
    expect(rec.application).toEqual({
      status: 'Active', current_stage_id: 'stage-09-r1', current_stage_entered_at: new Date(entered).toISOString(),
      current_job_id: 'job-a', archive_reason_id: null, archive_reason_type: null, archived_at: null,
      ashby_updated_at: new Date(entered).toISOString(),
    });
    expect(rec.history).toEqual([
      { history_id: 'h1', stage_id: 'stage-05-christy', title: 'Hello Christy', entered_at: '2026-11-01T00:00:00.000Z', left_at: '2026-11-03T00:00:00.000Z', stage_number: 0, moved_by_person: false },
      { history_id: 'h2', stage_id: 'stage-07-hm', title: 'HM Review', entered_at: '2026-11-03T00:00:00.000Z', left_at: new Date(entered).toISOString(), stage_number: 1, moved_by_person: true },
      { history_id: 'h3', stage_id: 'stage-09-r1', title: 'R1', entered_at: new Date(entered).toISOString(), left_at: null, stage_number: 2, moved_by_person: true },
    ]);
    expect(Date.parse(rec.next_check_at) - T).toBe(6 * HOUR);
    expect(rec.stages).toEqual([]); // every stage is already a plan stage
    // Nothing personal and no actor id leaves the read.
    const text = JSON.stringify(mem.records);
    for (const leaked of [ACTOR, 'Synthetic Person', 'example.invalid', 'Salary', 'allowedActions', 'set_entered_at']) expect(text).not.toContain(leaked);
    expect(mem.runs).toEqual([{ startedAt: new Date(T).toISOString(), finishedAt: new Date(T).toISOString(), checked: 1, changed: 1, errors: {} }]);
  });

  it('a hired application: PreInterviewScreen, Offer and Hired rows, the weekly cadence', async () => {
    const mem = memoryStore(['app-h'], { t0: T });
    const hiredAt = new Date(T - 3 * DAY).toISOString();
    const { client } = tenant({
      '/application.info': () => success(application('app-h', { status: 'Hired', currentInterviewStage: stage('stage-18-hired') })),
      '/application.listHistory': () => success([
        hist('h1', 'stage-05-christy', '2026-10-01T00:00:00Z', '2026-10-05T00:00:00Z', ACTOR, 0),
        hist('h2', 'stage-16-offer', '2026-10-05T00:00:00Z', hiredAt, ACTOR, 1),
        hist('h3', 'stage-18-hired', hiredAt, undefined, ACTOR, 2),
      ], { moreDataAvailable: false }),
    });
    await pass(client, mem.store, {}, T).run;
    const [rec] = okRecords(mem.records);
    expect(rec.application.status).toBe('Hired');
    expect(rec.application.current_stage_entered_at).toBe(hiredAt);
    expect(rec.history?.map((h) => h.stage_id)).toEqual(['stage-05-christy', 'stage-16-offer', 'stage-18-hired']);
    expect(Date.parse(rec.next_check_at) - T).toBe(168 * HOUR);
  });

  it('archived with a reason: the reason catalogue entry; archived with none: no reason, the time kept', async () => {
    const mem = memoryStore(['app-a', 'app-b'], { t0: T });
    const { client } = tenant({
      '/application.info': (b) => success(application(String(b.applicationId), b.applicationId === 'app-a'
        ? { status: 'Archived', archivedAt: '2026-11-08T10:00:00Z', currentInterviewStage: stage('stage-17-archived'),
            archiveReason: { id: 'reason-1', text: 'Not a fit', reasonType: 'RejectedByOrg', isArchived: false } }
        : { status: 'Archived', archivedAt: '2026-11-07T10:00:00Z', currentInterviewStage: stage('stage-17-archived'), archiveReason: null })),
      '/application.listHistory': () => success([hist('hx-' + Math.random(), 'stage-17-archived', '2026-11-07T10:00:00Z', undefined, null, 1)], { moreDataAvailable: false }),
    });
    await pass(client, mem.store, {}, T).run;
    const [a, b] = okRecords(mem.records);
    expect(a.reason).toEqual({ reason_id: 'reason-1', text: 'Not a fit', reason_type: 'RejectedByOrg', is_archived: false });
    expect(a.application).toMatchObject({ status: 'Archived', archive_reason_id: 'reason-1', archive_reason_type: 'RejectedByOrg', archived_at: '2026-11-08T10:00:00.000Z' });
    expect(b.reason).toBeNull();
    expect(b.application).toMatchObject({ status: 'Archived', archive_reason_id: null, archive_reason_type: null, archived_at: '2026-11-07T10:00:00.000Z' });
  });

  it('skipped and backward moves are kept as Ashby wrote them, in order', async () => {
    const mem = memoryStore(['app-1'], { t0: T });
    const { client } = tenant({
      '/application.info': () => success(application('app-1', { currentInterviewStage: stage('stage-09-r1') })),
      '/application.listHistory': () => success([
        hist('h1', 'stage-05-christy', '2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z', ACTOR, 0),
        hist('h2', 'stage-10-r2', '2026-11-02T00:00:00Z', '2026-11-04T00:00:00Z', ACTOR, 1), // R1 skipped
        hist('h3', 'stage-09-r1', '2026-11-04T00:00:00Z', undefined, ACTOR, 2), // back to R1
      ], { moreDataAvailable: false }),
    });
    await pass(client, mem.store, {}, T).run;
    const [rec] = okRecords(mem.records);
    expect(rec.history?.map((h) => [h.stage_id, h.stage_number, h.left_at === null])).toEqual([
      ['stage-05-christy', 0, false], ['stage-10-r2', 1, false], ['stage-09-r1', 2, true],
    ]);
    expect(rec.application.current_stage_entered_at).toBe('2026-11-04T00:00:00.000Z');
  });

  it('an edited history: the row Ashby no longer returns is marked gone and kept', async () => {
    const mem = memoryStore(['app-1'], { t0: T });
    let edited = false;
    const { client } = tenant({
      '/application.info': () => success(application('app-1', { updatedAt: edited ? '2026-11-10T00:00:00Z' : '2026-11-09T00:00:00Z' })),
      '/application.listHistory': () => success(edited
        ? [hist('h1', 'stage-05-christy', '2026-11-01T00:00:00Z', '2026-11-04T00:00:00Z', ACTOR, 0), hist('h3', 'stage-09-r1', '2026-11-04T00:00:00Z', undefined, ACTOR, 1)]
        : [hist('h1', 'stage-05-christy', '2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z', ACTOR, 0),
           hist('h2', 'stage-07-hm', '2026-11-02T00:00:00Z', '2026-11-04T00:00:00Z', ACTOR, 1),
           hist('h3', 'stage-09-r1', '2026-11-04T00:00:00Z', undefined, ACTOR, 2)], { moreDataAvailable: false }),
    });
    await pass(client, mem.store, {}, T).run;
    edited = true;
    mem.dueAgain(T);
    const second = await pass(client, mem.store, {}, T + 1000).run;
    expect(second).toMatchObject({ checked: 1, changed: 1 });
    expect(okRecords(mem.records)[1].history?.map((h) => h.history_id)).toEqual(['h1', 'h3']);
    expect(mem.intervals.get('h2')).toMatchObject({ goneAt: new Date(T + 1000).toISOString(), stageId: 'stage-07-hm' });
    expect(mem.intervals.get('h1')).toMatchObject({ goneAt: null, leftAt: '2026-11-04T00:00:00.000Z' });
    expect(mem.intervals.size).toBe(3);
  });

  it('nothing changed and the history is fresh: application.info only, the history and entry time kept', async () => {
    const mem = memoryStore(['app-1'], { t0: T });
    const { client, requests } = tenant({
      '/application.info': () => success(application('app-1')),
      '/application.listHistory': () => success([hist('h3', 'stage-09-r1', '2026-11-04T00:00:00Z', undefined, ACTOR, 0)], { moreDataAvailable: false }),
    });
    await pass(client, mem.store, {}, T).run;
    mem.dueAgain(T);
    requests.length = 0;
    await pass(client, mem.store, {}, T + HOUR).run;
    expect(requests.map((q) => q.path)).toEqual(['/application.info']);
    const rec = okRecords(mem.records)[1];
    expect(rec.history).toBeNull();
    expect(rec.application.current_stage_entered_at).toBe('2026-11-04T00:00:00.000Z');
    // A week later the history is read again even though nothing moved.
    mem.dueAgain(T + 8 * DAY);
    requests.length = 0;
    await pass(client, mem.store, {}, T + 8 * DAY).run;
    expect(requests.map((q) => q.path)).toEqual(['/application.info', '/application.listHistory']);
  });

  it('a backfill re-reads the history of an application read before it began, though nothing changed; once, not on every check (S3-4)', async () => {
    const mem = memoryStore(['app-1'], { t0: T });
    const { client, requests } = tenant({
      '/application.info': () => success(application('app-1')),
      '/application.listHistory': () => success([hist('h3', 'stage-09-r1', '2026-11-04T00:00:00Z', undefined, ACTOR, 0)], { moreDataAvailable: false }),
    });
    await pass(client, mem.store, {}, T).run;
    // An hour later an admin starts a backfill; the history read at T predates it.
    mem.setBackfill(new Date(T + HOUR).toISOString());
    mem.dueAgain(T + 2 * HOUR);
    requests.length = 0;
    await pass(client, mem.store, {}, T + 2 * HOUR).run;
    expect(requests.map((q) => q.path)).toEqual(['/application.info', '/application.listHistory']);
    expect(okRecords(mem.records)[1].history?.map((h) => h.history_id)).toEqual(['h3']);
    // Read again while the same backfill is open: its history is newer than the backfill.
    mem.dueAgain(T + 3 * HOUR);
    requests.length = 0;
    await pass(client, mem.store, {}, T + 3 * HOUR).run;
    expect(requests.map((q) => q.path)).toEqual(['/application.info']);
  });

  it('a stage known only from history is added: the current one from application.info, another from interviewStage.info', async () => {
    const catalog = LIVE_STAGES.filter((s) => s.id !== 'stage-09-r1').map((s) => [s.id, 'plan', s.type] as [string, 'plan', string]);
    const mem = memoryStore(['app-1'], { t0: T, catalog });
    const { client, requests } = tenant({
      '/application.info': () => success(application('app-1')),
      '/application.listHistory': () => success([
        hist('h1', 'old-stage-x', '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z', ACTOR, 0),
        hist('h2', 'stage-09-r1', '2026-10-02T00:00:00Z', undefined, ACTOR, 1),
      ], { moreDataAvailable: false }),
      '/interviewStage.info': () => success({ id: 'old-stage-x', title: 'Old Screen', type: 'PreInterviewScreen', orderInInterviewPlan: 3, interviewStageGroupId: 'grp-1', interviewPlanId: 'plan-old', interviewers: [{ email: 'i@example.invalid' }] }),
    });
    await pass(client, mem.store, {}, T).run;
    expect(requests.filter((q) => q.path === '/interviewStage.info').map((q) => q.body)).toEqual([{ interviewStageId: 'old-stage-x' }]);
    const [rec] = okRecords(mem.records);
    expect(rec.stages).toEqual([
      { stage_id: 'old-stage-x', interview_plan_id: 'plan-old', title: 'Old Screen', stage_type: 'PreInterviewScreen', order_in_plan: 3, stage_group_id: 'grp-1', default_milestone: null },
      { stage_id: 'stage-09-r1', interview_plan_id: PLAN, title: 'R1', stage_type: 'Active', order_in_plan: 8, stage_group_id: null, default_milestone: 'r1' },
    ]);
    expect(JSON.stringify(rec)).not.toContain('i@example.invalid');
  });

  it('without Interviews read, a history stage is added from its history title and no more lookups are made', async () => {
    const mem = memoryStore(['app-1', 'app-2'], { t0: T });
    const { client, requests } = tenant({
      '/application.info': (b) => success(application(String(b.applicationId))),
      '/application.listHistory': (b) => success([
        hist(`${b.applicationId}-h1`, `gone-stage-${b.applicationId}`, '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z', ACTOR, 0),
        hist(`${b.applicationId}-h2`, 'stage-09-r1', '2026-10-02T00:00:00Z', undefined, ACTOR, 1),
      ], { moreDataAvailable: false }),
      '/interviewStage.info': MISSING_403,
    });
    const r = await pass(client, mem.store, {}, T).run;
    expect(r.checked).toBe(2);
    expect(requests.filter((q) => q.path === '/interviewStage.info')).toHaveLength(1);
    const stages = okRecords(mem.records).flatMap((x) => x.stages);
    expect(stages.map((s) => [s.stage_id, s.title, s.stage_type])).toEqual([
      ['gone-stage-app-1', 'Old Stage', null], ['gone-stage-app-2', 'Old Stage', null],
    ]);
  });

  it('stage lookups are bounded per pass', async () => {
    const apps = Array.from({ length: 8 }, (_, i) => `app-${i}`);
    const mem = memoryStore(apps, { t0: T });
    const { client, requests } = tenant({
      '/application.info': (b) => success(application(String(b.applicationId))),
      '/application.listHistory': (b) => success([hist(`${b.applicationId}-h`, `extra-${b.applicationId}`, '2026-10-01T00:00:00Z', undefined, ACTOR, 0)], { moreDataAvailable: false }),
      '/interviewStage.info': (b) => success({ id: b.interviewStageId, title: 'Extra', type: 'Active' }),
    });
    await pass(client, mem.store, {}, T).run;
    expect(requests.filter((q) => q.path === '/interviewStage.info')).toHaveLength(MAX_STAGE_LOOKUPS_PER_PASS);
    expect(okRecords(mem.records).flatMap((x) => x.stages)).toHaveLength(8);
  });
});

describe('a pass: history paging', () => {
  const T = Date.now();
  const info = () => success(application('app-1'));

  it('follows every cursor', async () => {
    const mem = memoryStore(['app-1'], { t0: T });
    const pages: Record<string, unknown[]> = {
      start: [hist('h1', 'stage-05-christy', '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z', ACTOR, 0)],
      c2: [hist('h2', 'stage-07-hm', '2026-10-02T00:00:00Z', '2026-10-03T00:00:00Z', ACTOR, 1)],
      c3: [hist('h3', 'stage-09-r1', '2026-10-03T00:00:00Z', undefined, ACTOR, 2)],
    };
    const { client } = tenant({
      '/application.info': info,
      '/application.listHistory': (b) => {
        const key = typeof b.cursor === 'string' ? b.cursor : 'start';
        const next = key === 'start' ? 'c2' : key === 'c2' ? 'c3' : null;
        return success(pages[key], next ? { moreDataAvailable: true, nextCursor: next } : { moreDataAvailable: false });
      },
    });
    await pass(client, mem.store, {}, T).run;
    expect(okRecords(mem.records)[0].history?.map((h) => h.history_id)).toEqual(['h1', 'h2', 'h3']);
  });

  it.each([
    ['a repeated cursor', (b: Record<string, unknown>) => success([hist(`h-${String(b.cursor)}`, 'stage-09-r1', '2026-10-01T00:00:00Z', undefined, ACTOR, 0)], { moreDataAvailable: true, nextCursor: 'same' }), 'malformed_response'],
    ['more pages but no cursor', () => success([], { moreDataAvailable: true }), 'malformed_response'],
    ['a malformed row', () => success([{ id: 'h1' }], { moreDataAvailable: false }), 'malformed_response'],
    ['results that are not a list', () => success({ rows: [] }, { moreDataAvailable: false }), 'malformed_response'],
  ])('%s fails the read, and no partial history is written', async (_name, route, code) => {
    const mem = memoryStore(['app-1'], { t0: T });
    const { client } = tenant({ '/application.info': info, '/application.listHistory': route as Route });
    const r = await pass(client, mem.store, {}, T).run;
    expect(r.errors).toEqual({ [code]: 1 });
    expect(mem.records.map((x) => x.record.outcome)).toEqual(['error']);
    expect(mem.intervals.size).toBe(0);
  });

  it('past the page cap the read fails rather than mark the unread rows gone', async () => {
    const mem = memoryStore(['app-1'], { t0: T });
    let n = 0;
    const { client, requests } = tenant({
      '/application.info': info,
      '/application.listHistory': () => { n += 1; return success([hist(`h${n}`, 'stage-09-r1', '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z', ACTOR, n)], { moreDataAvailable: true, nextCursor: `c${n}` }); },
    });
    const r = await pass(client, mem.store, {}, T).run;
    expect(requests.filter((q) => q.path === '/application.listHistory')).toHaveLength(MAX_HISTORY_PAGES);
    expect(r.errors).toEqual({ history_page_cap: 1 });
    expect(mem.intervals.size).toBe(0);
  });

  it('a row Ashby repeats across pages is sent once', async () => {
    const mem = memoryStore(['app-1'], { t0: T });
    const { client } = tenant({
      '/application.info': info,
      '/application.listHistory': (b) => b.cursor
        ? success([hist('h1', 'stage-05-christy', '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z', ACTOR, 0), hist('h2', 'stage-09-r1', '2026-10-02T00:00:00Z', undefined, ACTOR, 1)], { moreDataAvailable: false })
        : success([hist('h1', 'stage-05-christy', '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z', ACTOR, 0)], { moreDataAvailable: true, nextCursor: 'c2' }),
    });
    await pass(client, mem.store, {}, T).run;
    expect(okRecords(mem.records)[0].history?.map((h) => h.history_id)).toEqual(['h1', 'h2']);
  });
});

describe('a pass: Ashby refuses or fails', () => {
  const T = Date.now();

  it.each([
    ['HTTP 403 missing_endpoint_permission', MISSING_403, 'missing_endpoint_permission', DAY],
    ['HTTP 200 success:false missing_endpoint_permission', MISSING_200, 'missing_endpoint_permission', DAY],
    ['HTTP 403 without that code (a refused key)', () => json(403, { success: false }), 'forbidden', DAY],
    ['HTTP 500', () => json(500, { success: false }), 'server_error', 15 * 60_000],
  ])('%s is recorded as its code, backs off, and the pass goes on', async (_name, route, code, backoff) => {
    const mem = memoryStore(['app-1', 'app-2'], { t0: T });
    const { client, requests } = tenant({
      '/application.info': (b) => (b.applicationId === 'app-2' ? (route as () => AshbyTransportResponse)() : success(application('app-1'))),
      '/application.listHistory': () => success([hist('h1', 'stage-09-r1', '2026-10-01T00:00:00Z', undefined, ACTOR, 0)], { moreDataAvailable: false }),
    });
    const r = await pass(client, mem.store, {}, T).run;
    expect(r).toMatchObject({ checked: 2, errors: { [code]: 1 }, rateLimited: false });
    const failed = mem.records.find((x) => x.record.outcome === 'error')!.record as Extract<ProgressRecord, { outcome: 'error' }>;
    expect(failed).toEqual({ outcome: 'error', error_code: code, next_check_at: new Date(T + backoff).toISOString() });
    // app-1 (due first) was read, then app-2 failed; the pass did not stop.
    expect(requests.map((q) => q.path)).toContain('/application.listHistory');
    expect(mem.runs[0].errors).toEqual({ [code]: 1 });
  });

  it('a missing permission on the history is recorded too', async () => {
    const mem = memoryStore(['app-1'], { t0: T });
    const { client } = tenant({ '/application.info': () => success(application('app-1')), '/application.listHistory': MISSING_200 });
    const r = await pass(client, mem.store, {}, T).run;
    expect(r.errors).toEqual({ missing_endpoint_permission: 1 });
  });

  it.each([
    ['HTTP 404', () => json(404, { success: false })],
    ['HTTP 200 success:false application_not_found', () => json(200, { success: false, errors: ['application_not_found'] })],
  ])('%s: the application is gone and is not read again', async (_name, route) => {
    const mem = memoryStore(['app-1'], { t0: T });
    const { client } = tenant({ '/application.info': route as () => AshbyTransportResponse });
    const r = await pass(client, mem.store, {}, T).run;
    expect(r).toMatchObject({ checked: 1, errors: { application_not_found: 1 } });
    expect(mem.records[0].record).toEqual({ outcome: 'gone', error_code: 'application_not_found' });
    expect(mem.rows[0].next).toBe(FAR);
    const again = await pass(client, mem.store, {}, T + 30 * DAY).run;
    expect(again.claimed).toBe(0);
  });

  it('a 429 the client can wait out is read on its retry (the Retry-After handling)', async () => {
    const mem = memoryStore(['app-1'], { t0: T });
    let calls = 0;
    const { client } = tenant({
      '/application.info': () => (++calls === 1 ? json(429, { success: false }, { 'retry-after': '1' }) : success(application('app-1'))),
      '/application.listHistory': () => success([hist('h1', 'stage-09-r1', '2026-10-01T00:00:00Z', undefined, ACTOR, 0)], { moreDataAvailable: false }),
    }, 3);
    const r = await pass(client, mem.store, {}, T).run;
    expect(r).toMatchObject({ checked: 1, errors: {}, rateLimited: false });
    expect(calls).toBe(2);
  });

  it('a 429 that persists: that row backs off, the rest wait five minutes unread, the pass stops', async () => {
    const mem = memoryStore(['app-1', 'app-2', 'app-3'], { t0: T });
    const { client, requests } = tenant({ '/application.info': () => json(429, { success: false }, { 'retry-after': '120' }) }, 2);
    const r = await pass(client, mem.store, {}, T).run;
    expect(r).toMatchObject({ rateLimited: true, checked: 1, deferred: 2, errors: { rate_limited: 1 }, drain: false });
    expect(requests.filter((q) => q.path === '/application.info').length).toBeLessThanOrEqual(2);
    const deferred = mem.records.filter((x) => x.record.outcome === 'deferred').map((x) => x.record as Extract<ProgressRecord, { outcome: 'deferred' }>);
    expect(deferred.map((d) => d.next_check_at)).toEqual([new Date(T + RATE_LIMIT_HOLD_MS).toISOString(), new Date(T + RATE_LIMIT_HOLD_MS).toISOString()]);
    // app-1 (due first) met the 429 and keeps its counted attempt; the two handed back are refunded.
    expect(mem.rows.map((x) => [x.appId, x.attempts])).toEqual([['app-1', 1], ['app-2', 0], ['app-3', 0]]);
    // The run row counts the rows handed back next to the failures.
    expect(mem.runs[0].errors).toEqual({ rate_limited: 1, deferred: 2 });
  });
});

describe('a pass: its deadline, its pace, its lease', () => {
  /** A fake reader on a fake clock: each call takes `ms`. */
  function slowReader(clock: { t: number }, ms: number): ProgressReader & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      async applicationInfo(id) { calls.push(`info:${id}`); clock.t += ms; return { results: application(id) as never }; },
      async applicationListHistory(p) { calls.push(`history:${p.applicationId}`); clock.t += ms; return { results: [hist(`${p.applicationId}-h`, 'stage-09-r1', '2026-10-01T00:00:00Z', undefined, ACTOR, 0)] as never, moreDataAvailable: false }; },
      async interviewStageInfo() { throw new Error('not expected'); },
    };
  }

  it('rows the deadline leaves unread are handed back, their claim refunded', async () => {
    const clock = { t: Date.parse('2026-11-10T12:00:00Z') };
    const mem = memoryStore(['a1', 'a2', 'a3', 'a4'], { t0: clock.t });
    const reader = slowReader(clock, 10_000);
    const r = await runProgressPass({ reader, store: mem.store, config: { ...CONFIG, passDeadlineMs: 45_000 }, now: () => clock.t, sleep: async (ms) => { clock.t += ms; } });
    expect(r).toMatchObject({ claimed: 4, checked: 2, deferred: 2, deadlineHit: true, drain: false });
    // a3's application.info ends past the deadline, so its history is never asked for and a3 goes back unread.
    expect(reader.calls).toEqual(['info:a1', 'history:a1', 'info:a2', 'history:a2', 'info:a3']);
    expect(mem.records.filter((x) => x.record.outcome === 'deferred').map((x) => x.progressId)).toEqual(['progress-2', 'progress-3']);
    expect(mem.rows.map((x) => x.attempts)).toEqual([0, 0, 0, 0]);
    expect(mem.runs).toEqual([expect.objectContaining({ checked: 2, errors: { deferred: 2 } })]);
  });

  it('a pass that only handed rows back still writes its run row, so the status route shows it (S3-1)', async () => {
    const clock = { t: Date.parse('2026-11-10T12:00:00Z') };
    const mem = memoryStore(['a1', 'a2'], { t0: clock.t });
    const claim = mem.store.claimDue.getMockImplementation()!;
    // The claim itself was slow (a busy database): nothing is left of the pass.
    mem.store.claimDue.mockImplementation(async (args) => { const c = await claim(args); clock.t += 44_000; return c; });
    const reader = slowReader(clock, 10);
    const r = await runProgressPass({ reader, store: mem.store, config: CONFIG, now: () => clock.t, sleep: async (ms) => { clock.t += ms; } });
    expect(r).toMatchObject({ claimed: 2, checked: 0, deferred: 2, errors: {} });
    expect(reader.calls).toEqual([]);
    expect(mem.runs).toEqual([expect.objectContaining({ checked: 0, changed: 0, errors: { deferred: 2 } })]);
  });

  it('keeps about two Ashby calls a second', async () => {
    const clock = { t: Date.parse('2026-11-10T12:00:00Z') };
    const mem = memoryStore(['a1', 'a2'], { t0: clock.t });
    const starts: number[] = [];
    const reader = slowReader(clock, 0);
    const wrapped: ProgressReader = {
      applicationInfo: async (...args) => { starts.push(clock.t); return reader.applicationInfo(...args); },
      applicationListHistory: async (p) => { starts.push(clock.t); return reader.applicationListHistory(p); },
      interviewStageInfo: reader.interviewStageInfo,
    };
    await runProgressPass({ reader: wrapped, store: mem.store, config: CONFIG, now: () => clock.t, sleep: async (ms) => { clock.t += ms; } });
    expect(starts).toHaveLength(4);
    for (let i = 1; i < starts.length; i += 1) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(CONFIG.minCallIntervalMs);
  });

  it('a read whose lease was lost (a backfill re-marked the row) writes nothing and is not counted as checked', async () => {
    const T = Date.now();
    const mem = memoryStore(['app-1'], { t0: T });
    const { client } = tenant({
      '/application.info': () => {
        mem.rows[0].next = new Date(T).toISOString(); // a backfill marks it due meanwhile
        return success(application('app-1'));
      },
      '/application.listHistory': () => success([hist('h1', 'stage-09-r1', '2026-10-01T00:00:00Z', undefined, ACTOR, 0)], { moreDataAvailable: false }),
    });
    const r = await pass(client, mem.store, {}, T).run;
    expect(r).toMatchObject({ checked: 0, errors: { lease_lost: 1 } });
    expect(mem.records).toEqual([]);
    expect(mem.intervals.size).toBe(0);
  });

  it('a full batch asks for the short drain interval; a short one does not', async () => {
    const T = Date.now();
    const route = { '/application.info': (b: Record<string, unknown>) => success(application(String(b.applicationId))), '/application.listHistory': (b: Record<string, unknown>) => success([hist(`${b.applicationId}-h`, 'stage-09-r1', '2026-10-01T00:00:00Z', undefined, ACTOR, 0)], { moreDataAvailable: false }) };
    const full = await pass(tenant(route).client, memoryStore(['a1', 'a2'], { t0: T }).store, { batchSize: 2 }, T).run;
    expect(full.drain).toBe(true);
    const short = await pass(tenant(route).client, memoryStore(['a1'], { t0: T }).store, { batchSize: 2 }, T).run;
    expect(short.drain).toBe(false);
  });

  it('an empty pass writes no run row, unless a backfill is open (so it can close)', async () => {
    const quiet = memoryStore([]);
    await pass(tenant({}).client, quiet.store).run;
    expect(quiet.store.recordRun).not.toHaveBeenCalled();
    const open = memoryStore([], { backfillOpen: true });
    await pass(tenant({}).client, open.store).run;
    expect(open.runs).toHaveLength(1);
    expect(open.runs[0]).toMatchObject({ checked: 0, changed: 0, errors: {} });
  });

  it('a record Postgres refuses is backed off as record_error, and the pass goes on', async () => {
    const T = Date.now();
    const mem = memoryStore(['a1', 'a2'], { t0: T });
    const original = mem.store.record.getMockImplementation()!;
    let first = true;
    mem.store.record.mockImplementation(async (...args) => {
      if (first && args[3].outcome === 'ok') { first = false; throw new Error('ashby_progress_record_error'); }
      return original(...args);
    });
    const { client } = tenant({
      '/application.info': (b) => success(application(String(b.applicationId))),
      '/application.listHistory': (b) => success([hist(`${b.applicationId}-h`, 'stage-09-r1', '2026-10-01T00:00:00Z', undefined, ACTOR, 0)], { moreDataAvailable: false }),
    });
    const r = await pass(client, mem.store, {}, T).run;
    expect(r).toMatchObject({ checked: 1, errors: { record_error: 1 } });
    expect(mem.records.map((x) => x.record.outcome)).toEqual(['error', 'ok']);
    expect((mem.records[0].record as { error_code: string }).error_code).toBe('record_error');
  });
});

describe('a pass: an Ashby read that never answers (S3-1)', () => {
  const T0 = Date.parse('2026-11-12T00:00:00Z');

  /**
   * A reader on a fake clock. A hanging call does what AshbyClient does with a
   * call that never answers: it waits out the deadline it was given, then
   * fails as an exhausted retry of a timeout. Every other call takes `ms`.
   */
  function hangingReader(clock: { t: number }, hangs: (op: string, id: string) => boolean, ms = 300) {
    const calls: Array<{ op: string; id: string; budget: number }> = [];
    const hang = (op: string, id: string, deadlineAt: number | undefined) => {
      calls.push({ op, id, budget: (deadlineAt ?? Number.NaN) - clock.t });
      if (!hangs(op, id)) { clock.t += ms; return false; }
      clock.t = Math.max(clock.t, deadlineAt ?? clock.t + 60_000);
      throw new AshbyError('retry_exhausted', { operation: op, code: 'timeout', retriable: false });
    };
    const reader: ProgressReader = {
      async applicationInfo(id, _extra, options) {
        hang('application.info', id, options?.deadlineAt);
        return { results: application(id, { updatedAt: '2026-10-01T00:00:00Z' }) as never };
      },
      async applicationListHistory(p) {
        hang('application.listHistory', p.applicationId, p.deadlineAt);
        return { results: [hist(`${p.applicationId}-h`, 'stage-09-r1', '2026-10-01T00:00:00Z', undefined, ACTOR, 0)] as never, moreDataAvailable: false };
      },
      async interviewStageInfo(id, options) {
        hang('interviewStage.info', id, options?.deadlineAt);
        return { results: { id, title: 'Found', type: 'Active' } as never };
      },
    };
    return { reader, calls };
  }

  const run = (mem: ReturnType<typeof memoryStore>, reader: ProgressReader, clock: { t: number }, over: Partial<AshbyProgressConfig> = {}) =>
    runProgressPass({ reader, store: mem.store, config: { ...CONFIG, ...over }, now: () => clock.t, sleep: async (ms) => { clock.t += ms; } });

  it('costs one call budget, is recorded as a timeout with its attempt kept and the usual backoff, and the rows behind it are read', async () => {
    const clock = { t: T0 };
    const mem = memoryStore(['a-hang', 'a2', 'a3'], { t0: T0 });
    const { reader, calls } = hangingReader(clock, (_op, id) => id === 'a-hang');
    const r = await run(mem, reader, clock);
    expect(calls[0]).toEqual({ op: 'application.info', id: 'a-hang', budget: CALL_BUDGET_MS });
    expect(r).toMatchObject({ claimed: 3, checked: 3, deferred: 0, errors: { timeout: 1 }, deadlineHit: false });
    const failed = mem.records.find((x) => x.progressId === 'progress-0')!.record;
    expect(failed).toEqual({ outcome: 'error', error_code: 'timeout', next_check_at: new Date(T0 + CALL_BUDGET_MS + 15 * 60_000).toISOString() });
    expect(mem.rows[0]).toMatchObject({ attempts: 1, errorCode: 'timeout' });
    expect(okRecords(mem.records)).toHaveLength(2);
    expect(clock.t - T0).toBeLessThan(CONFIG.passDeadlineMs);
    expect(mem.runs).toEqual([expect.objectContaining({ checked: 3, errors: { timeout: 1 } })]);
  });

  it('never starves the rows claimed after it, and backs off rather than coming back every pass', async () => {
    const clock = { t: T0 };
    const apps = Array.from({ length: 12 }, (_, i) => `app-${String(i).padStart(2, '0')}`);
    const mem = memoryStore(apps, { t0: T0 });
    const { reader, calls } = hangingReader(clock, (_op, id) => id === 'app-04');
    for (let i = 0; i < 6; i += 1) {
      await run(mem, reader, clock);
      clock.t += 60_000;
    }
    const poison = mem.rows.find((x) => x.appId === 'app-04')!;
    expect(poison).toMatchObject({ errorCode: 'timeout', attempts: 1, lastCheckedAt: null });
    expect(mem.rows.filter((x) => x.appId !== 'app-04').every((x) => x.lastCheckedAt !== null)).toBe(true);
    // Read once in six passes: its 15-minute backoff holds it.
    expect(calls.filter((c) => c.id === 'app-04')).toHaveLength(1);
    expect(mem.records.filter((x) => x.record.outcome === 'deferred')).toHaveLength(0);
  });

  it('a history read that never answers is a timeout too, and no partial history is written', async () => {
    const clock = { t: T0 };
    const mem = memoryStore(['a1'], { t0: T0 });
    const { reader, calls } = hangingReader(clock, (op) => op === 'application.listHistory');
    const r = await run(mem, reader, clock);
    expect(r).toMatchObject({ checked: 1, deferred: 0, errors: { timeout: 1 } });
    expect(calls.map((c) => [c.op, c.budget])).toEqual([['application.info', CALL_BUDGET_MS], ['application.listHistory', CALL_BUDGET_MS]]);
    expect(mem.intervals.size).toBe(0);
  });

  it('a row the pass deadline cuts, begun with no more than one call budget left, is handed back with its claim refunded', async () => {
    const clock = { t: T0 };
    const mem = memoryStore(['a1', 'a2', 'a-late'], { t0: T0 });
    // a1 and a2 take 30 s between them; a-late begins with 15 s left and hangs.
    const { reader, calls } = hangingReader(clock, (_op, id) => id === 'a-late', 7_500);
    const r = await run(mem, reader, clock);
    const late = calls.find((c) => c.id === 'a-late')!;
    expect(late.budget).toBeLessThanOrEqual(CALL_BUDGET_MS);
    expect(r).toMatchObject({ checked: 2, deferred: 1, errors: {}, deadlineHit: true });
    expect(mem.records.find((x) => x.progressId === 'progress-2')!.record.outcome).toBe('deferred');
    expect(mem.rows[2]).toMatchObject({ attempts: 0, errorCode: null });
  });

  it('a row whose own slow reads ran the pass out is a timeout, not handed back again and again', async () => {
    const clock = { t: T0 };
    const mem = memoryStore(['a-slow', 'a2'], { t0: T0 });
    // Each call answers in 14 s; a-slow's history has a second page, and that page never answers.
    const calls: string[] = [];
    const reader: ProgressReader = {
      async applicationInfo(id) { calls.push(`info:${id}`); clock.t += 14_000; return { results: application(id) as never }; },
      async applicationListHistory(p) {
        calls.push(`history:${p.applicationId}:${p.cursor ?? 'start'}`);
        if (p.cursor) {
          clock.t = Math.max(clock.t, p.deadlineAt ?? clock.t);
          throw new AshbyError('retry_exhausted', { operation: 'application.listHistory', code: 'timeout', retriable: false });
        }
        clock.t += 14_000;
        return { results: [hist('h1', 'stage-09-r1', '2026-10-01T00:00:00Z', undefined, ACTOR, 0)] as never, moreDataAvailable: true, nextCursor: 'c2' };
      },
      async interviewStageInfo() { throw new Error('not expected'); },
    };
    const r = await run(mem, reader, clock);
    expect(calls).toEqual(['info:a-slow', 'history:a-slow:start', 'history:a-slow:c2']);
    expect(mem.records.find((x) => x.progressId === 'progress-0')!.record).toMatchObject({ outcome: 'error', error_code: 'timeout' });
    expect(mem.rows[0].attempts).toBe(1);
    // a2 never started: the deadline hands it back.
    expect(r).toMatchObject({ checked: 1, deferred: 1, errors: { timeout: 1 }, deadlineHit: true });
  });

  it('a stage lookup that never answers costs its own short budget, once a pass; the rows are still recorded', async () => {
    const clock = { t: T0 };
    const catalog = LIVE_STAGES.map((s) => [s.id, 'plan', s.type] as [string, 'plan', string]);
    const mem = memoryStore(['a1', 'a2'], { t0: T0, catalog });
    const { reader, calls } = hangingReader(clock, (op) => op === 'interviewStage.info');
    const histories: ProgressReader['applicationListHistory'] = async (p) => {
      calls.push({ op: 'application.listHistory', id: p.applicationId, budget: (p.deadlineAt ?? 0) - clock.t });
      clock.t += 300;
      return { results: [hist(`${p.applicationId}-h`, `unknown-${p.applicationId}`, '2026-10-01T00:00:00Z', undefined, ACTOR, 0)] as never, moreDataAvailable: false };
    };
    const r = await run(mem, { ...reader, applicationListHistory: histories }, clock);
    const lookups = calls.filter((c) => c.op === 'interviewStage.info');
    expect(lookups).toEqual([{ op: 'interviewStage.info', id: 'unknown-a1', budget: STAGE_LOOKUP_BUDGET_MS }]);
    expect(r).toMatchObject({ checked: 2, errors: {} });
    expect(okRecords(mem.records).flatMap((x) => x.stages.map((s) => [s.stage_id, s.stage_type]))).toEqual([['unknown-a1', null], ['unknown-a2', null]]);
  });

  it('through the REAL AshbyClient (15 s a try, 3 tries) and real timers faked: one call budget, then a timeout', async () => {
    vi.useFakeTimers({ now: T0 });
    try {
      const mem = memoryStore(['app-hang', 'app-2'], { t0: T0 });
      const paths: string[] = [];
      const client = createAshbyClient({
        apiKey: 'SYNTHETIC_KEY_0001',
        random: () => 0.5,
        transport: async (req) => {
          const body = JSON.parse(req.body) as Record<string, unknown>;
          const path = new URL(req.url).pathname;
          paths.push(`${path}:${String(body.applicationId)}`);
          if (body.applicationId === 'app-hang') {
            return new Promise<AshbyTransportResponse>((_resolve, reject) => {
              req.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
            });
          }
          return path === '/application.info'
            ? success(application(String(body.applicationId)))
            : success([hist('h1', 'stage-09-r1', '2026-10-01T00:00:00Z', undefined, ACTOR, 0)], { moreDataAvailable: false });
        },
      });
      const started = Date.now();
      const pending = runProgressPass({ reader: client, store: mem.store, config: CONFIG });
      await vi.advanceTimersByTimeAsync(CONFIG.passDeadlineMs + 5_000);
      const r = await pending;
      expect(r).toMatchObject({ checked: 2, deferred: 0, errors: { timeout: 1 } });
      expect(mem.records.find((x) => x.progressId === 'progress-0')!.record).toMatchObject({ outcome: 'error', error_code: 'timeout' });
      // Two tries inside the call's 20 s, then the pass went on to app-2.
      expect(paths.filter((p) => p.endsWith(':app-hang'))).toEqual(['/application.info:app-hang', '/application.info:app-hang']);
      expect(paths).toContain('/application.info:app-2');
      expect(Date.parse(mem.runs[0].finishedAt) - started).toBeLessThan(CALL_BUDGET_MS + 5_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('two workers at once', () => {
  it('never read the same application: each claims its own rows', async () => {
    const T = Date.now();
    const apps = Array.from({ length: 20 }, (_, i) => `app-${i}`);
    const mem = memoryStore(apps, { t0: T });
    const reads: string[] = [];
    const reader = (): ProgressReader => ({
      async applicationInfo(id) { reads.push(id); await new Promise((r) => setTimeout(r, 1)); return { results: application(id) as never }; },
      async applicationListHistory(p) { await new Promise((r) => setTimeout(r, 1)); return { results: [hist(`${p.applicationId}-h`, 'stage-09-r1', '2026-10-01T00:00:00Z', undefined, ACTOR, 0)] as never, moreDataAvailable: false }; },
      async interviewStageInfo() { throw new Error('not expected'); },
    });
    const config = { ...CONFIG, batchSize: 5, minCallIntervalMs: 100 };
    const one = async () => {
      let total = 0;
      for (let i = 0; i < 10; i += 1) {
        const r = await runProgressPass({ reader: reader(), store: mem.store, config, now: () => T, sleep: async () => {} });
        total += r.checked;
        if (r.claimed === 0) break;
      }
      return total;
    };
    const [a, b] = await Promise.all([one(), one()]);
    expect(a + b).toBe(20);
    expect(new Set(reads).size).toBe(20);
    expect(reads).toHaveLength(20);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Read-only, and the tables it touches
// ═══════════════════════════════════════════════════════════════════════

describe('read-only toward Ashby', () => {
  it('allows only three registry reads', () => {
    expect([...PROGRESS_READ_OPERATIONS]).toEqual(['application.info', 'application.listHistory', 'interviewStage.info']);
    for (const op of PROGRESS_READ_OPERATIONS) expect(ASHBY_OPERATIONS[op].mutation).toBe(false);
    for (const op of ['application.changeStage', 'candidate.addTag', 'applicationFeedback.submit', 'application.list', 'nope']) {
      expect(() => assertProgressReadOnly(op)).toThrow('ashby_progress_operation_not_allowed');
    }
  });

  it('a pass calls nothing else', async () => {
    const T = Date.now();
    const mem = memoryStore(['app-1'], { t0: T, catalog: [] });
    const { client, requests } = tenant({
      '/application.info': () => success(application('app-1')),
      '/application.listHistory': () => success([hist('h1', 'stage-05-christy', '2026-10-01T00:00:00Z', undefined, ACTOR, 0)], { moreDataAvailable: false }),
      '/interviewStage.info': (b) => success({ id: b.interviewStageId, title: 'Hello Christy', type: 'PreInterviewScreen' }),
    });
    await pass(client, mem.store, {}, T).run;
    expect(new Set(requests.map((q) => q.path))).toEqual(new Set(['/application.info', '/application.listHistory', '/interviewStage.info']));
  });
});

describe('the service-role store', () => {
  /** A PostgREST double that records every builder method and RPC. */
  function recordingClient(rpcAnswers: Record<string, unknown> = {}) {
    const calls: Array<{ kind: 'rpc' | 'from'; name: string; methods: string[]; args?: unknown }> = [];
    const client = {
      rpc: vi.fn(async (name: string, args: unknown) => {
        calls.push({ kind: 'rpc', name, methods: [], args });
        return { data: rpcAnswers[name] ?? { status: 'ok' }, error: null };
      }),
      from: vi.fn((table: string) => {
        const entry = { kind: 'from' as const, name: table, methods: [] as string[] };
        calls.push(entry);
        const builder: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'like', 'in', 'is', 'order', 'limit', 'insert', 'update', 'upsert', 'delete']) {
          builder[m] = (..._args: unknown[]) => { entry.methods.push(m); return builder; };
        }
        builder.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], count: 0, error: null });
        return builder;
      }),
    };
    return { client, calls };
  }

  it('writes only through the five 0139 functions, and reads only the queue, the catalogue and the mappings', async () => {
    const { client, calls } = recordingClient({
      claim_ashby_progress_due: { seeded: 1, backfill_open: true, backfill_started_at: '2026-11-10T13:00:00.123456+00:00', claimed: [{ progress_id: 'p1', link_id: 'l1', application_id: 'a1', lease_until: '2026-11-10T13:40:13.76+00:00', attempts: 1, status: null, history_read_at: null }] },
      record_ashby_progress_run: { status: 'ok', run_id: 'r1', backfill_finished: true },
      start_ashby_progress_backfill: { status: 'started', run_id: 'r2', started_at: '2026-11-10T13:40:13.76+00:00', links: 3, seeded: 1, marked: 3 },
    });
    const store = createProgressStore(client as never);
    expect(await store.scannerBusy()).toBe(false);
    const claim = await store.claimDue({ limit: 10, leaseSeconds: 105, seedLimit: 500, nowIso: '2026-11-10T13:38:28.760Z' });
    // The lease goes back exactly as the claim answered it: no precision lost.
    expect(claim.claimed[0].leaseUntil).toBe('2026-11-10T13:40:13.76+00:00');
    // When the open backfill began, so its reads re-read every older history.
    expect(claim).toMatchObject({ backfillOpen: true, backfillStartedAt: '2026-11-10T13:00:00.123Z' });
    await store.knownStages(Array.from({ length: 250 }, (_, i) => `stage-${i}`));
    await store.christyStageIds();
    await store.record('p1', claim.claimed[0].leaseUntil, '2026-11-10T13:39:00.000Z', { outcome: 'deferred', next_check_at: '2026-11-10T13:39:00.000Z' });
    expect((await store.recordRun({ startedAt: 'a', finishedAt: 'b', checked: 1, changed: 0, errors: {} })).backfillFinished).toBe(true);
    await store.overview('2026-11-10T13:39:00.000Z', 86_400);
    expect(await store.startBackfill('44444444-4444-4444-8444-444444444444', '2026-11-10T13:39:00.000Z')).toMatchObject({ state: 'started', links: 3, marked: 3 });

    const rpcs = new Set(calls.filter((c) => c.kind === 'rpc').map((c) => c.name));
    expect([...rpcs].sort()).toEqual([
      'ashby_progress_overview', 'claim_ashby_progress_due', 'record_ashby_application_progress', 'record_ashby_progress_run', 'start_ashby_progress_backfill',
    ]);
    const reads = calls.filter((c) => c.kind === 'from');
    expect(new Set(reads.map((c) => c.name))).toEqual(new Set(['job_queue', 'ashby_stage_catalog', 'ashby_job_mappings']));
    for (const r of reads) expect(r.methods.filter((m) => ['insert', 'update', 'upsert', 'delete'].includes(m))).toEqual([]);
    // 250 stage ids are read in batches of at most 100.
    expect(reads.filter((c) => c.name === 'ashby_stage_catalog')).toHaveLength(3);
  });

  it('a refusal or a database error surfaces as such, never as success', async () => {
    const refused = createProgressStore(recordingClient({ record_ashby_application_progress: { status: 'invalid_history' } }).client as never);
    expect(await refused.record('p1', 'l', 'n', { outcome: 'deferred', next_check_at: 'n' })).toEqual({ status: 'refused', code: 'invalid_history' });
    const lost = createProgressStore(recordingClient({ record_ashby_application_progress: { status: 'lease_lost' } }).client as never);
    expect(await lost.record('p1', 'l', 'n', { outcome: 'deferred', next_check_at: 'n' })).toEqual({ status: 'lease_lost' });
    const broken = { rpc: async () => ({ data: null, error: { message: 'boom' } }), from: () => ({}) };
    await expect(createProgressStore(broken as never).claimDue({ limit: 1, leaseSeconds: 30, seedLimit: 0, nowIso: 'n' })).rejects.toThrow('ashby_progress_claim_error');
    await expect(createProgressStore(broken as never).startBackfill('a', 'n')).rejects.toThrow('ashby_progress_backfill_error');
    const runRefused = createProgressStore(recordingClient({ record_ashby_progress_run: { status: 'invalid_run' } }).client as never);
    await expect(runRefused.recordRun({ startedAt: 'a', finishedAt: 'b', checked: 1, changed: 2, errors: {} })).rejects.toThrow('ashby_progress_run_refused');
  });

  it('the overview keeps counts and safe codes only', async () => {
    const store = createProgressStore(recordingClient({
      ashby_progress_overview: {
        links: 5, links_excluded: 1, progress_rows: 5, checked: 3, never_checked: 2, due_now: 2, gone: 1, stale: 0,
        by_status: { Active: 2, Hired: 1, Archived: 0, Lead: 0, unknown: 2 },
        by_error: { missing_endpoint_permission: 1, 'Bad Code!': 4, timeout: -1 },
        intervals: { total: 9, open: 3, gone: 1 }, history_stages: 2,
        open_backfill: { started_at: '2026-11-10T13:00:00+00:00', remaining: 2 },
        last_sweep: {
          mode: 'sweep', started_at: '2026-11-10T13:00:00+00:00', finished_at: '2026-11-10T13:00:30+00:00', checked: 3, changed: 1,
          errors_by_code: { rate_limited: 1, deferred: 4, scanner_paused: 5 },
        },
        recent_runs: [],
        scanner_pause: { skipped_passes: 12, last_at: '2026-11-10T12:55:00+00:00' },
      },
    }).client as never);
    const o = await store.overview('n', 86_400);
    expect(o.byError).toEqual([{ code: 'missing_endpoint_permission', count: 1 }]);
    expect(o.openBackfill).toEqual({ startedAt: '2026-11-10T13:00:00.000Z', remaining: 2 });
    // Rows handed back and passes the scanner skipped are counted apart from the failures.
    expect(o.lastSweep).toEqual({
      mode: 'sweep', startedAt: '2026-11-10T13:00:00.000Z', finishedAt: '2026-11-10T13:00:30.000Z', checked: 3, changed: 1,
      deferred: 4, scannerPaused: 5, errors: [{ code: 'rate_limited', count: 1 }],
    });
    expect(o.scannerPause).toEqual({ skippedPasses: 12, lastAt: '2026-11-10T12:55:00.000Z' });
    const none = await createProgressStore(recordingClient({ ashby_progress_overview: {} }).client as never).overview('n', 86_400);
    expect(none.scannerPause).toEqual({ skippedPasses: 0, lastAt: null });
    expect(codeCounts({ b: 1, a: 1, c: 5 })).toEqual([{ code: 'c', count: 5 }, { code: 'a', count: 1 }, { code: 'b', count: 1 }]);
  });

  it('pauses only for the scanner deferrals that mean a CPU-starved machine, not a signature or readiness hold (S3-3)', async () => {
    expect([...SCANNER_PRESSURE_REASONS]).toEqual(['scanner_timeout', 'scanner_busy']);
    const filters: Array<[string, unknown[]]> = [];
    let answer = 0;
    const client = {
      from: (table: string) => {
        filters.push(['from', [table]]);
        const builder: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'in', 'like']) builder[m] = (...args: unknown[]) => { filters.push([m, args]); return builder; };
        builder.then = (resolve: (v: unknown) => unknown) => resolve({ count: answer, error: null });
        return builder;
      },
    };
    const store = createProgressStore(client as never);
    expect(await store.scannerBusy()).toBe(false);
    answer = 2;
    expect(await store.scannerBusy()).toBe(true);
    expect(filters.slice(0, 5)).toEqual([
      ['from', ['job_queue']],
      ['select', ['*', { count: 'exact', head: true }]],
      ['eq', ['name', 'ashby.ingestion']],
      ['eq', ['status', 'delayed']],
      ['in', ['defer_reason', ['scanner_timeout', 'scanner_busy']]],
    ]);
    expect(filters.some(([m]) => m === 'like')).toBe(false);
  });
});

describe('the error taxonomy the worker relies on', () => {
  it('an AshbyError carries the codes it reads', () => {
    const e = new AshbyError('logical_failure', { httpStatus: 200, endpointCodes: ['missing_endpoint_permission'] });
    expect(e.endpointCodes).toEqual(['missing_endpoint_permission']);
  });
});
