/**
 * Phase 7 L6 (REC-06): recording-object erasure / retention tests.
 *
 * Verified:
 *   - eraseRecording() happy path: object deleted from SYNTHETIC storage,
 *     recording_deleted_at set, recording_object_key NULLed, exactly one
 *     'deleted' integrity event, one 'erasure_completed' success audit.
 *   - Idempotent double-erase: second erase no-ops (already_deleted), no
 *     error, no duplicate event/completion audit (C-4).
 *   - Legal-hold precedence: active hold → blocked + erasure_blocked_legal_hold
 *     audit, object untouched; releaseLegalHold → erase succeeds.
 *   - Erasure-exception precedence: active exception → blocked; revoke →
 *     succeeds.
 *   - Missing-object idempotency: synthetic storage remove of an absent key
 *     succeeds and the tombstone is still set.
 *   - Failure boundaries (explicit partial-failure behavior): storage delete
 *     failure leaves the row untouched (fully retryable); tombstone write
 *     failure leaves the object gone + row untouched and a retry completes
 *     with exactly one event + one success audit; integrity-event write
 *     failure leaves the tombstone set (access blocked — never resurrected)
 *     with completion NOT claimed — and the F3-repaired retry BACKFILLS the
 *     missing deleted event + success completion audit (converged, exactly
 *     one of each; a further retry is already_deleted).
 *   - Deleted recordings are not downloadable (recruiter download 404) nor
 *     re-mintable (grant mint 404) — asserts the L5 gate honours
 *     recording_deleted_at.
 *   - Synthetic processor-propagation + backup-aging: deterministic intent /
 *     horizon from the synthetic 'recording' retention policy (incl.
 *     indefinite → null horizon, missing policy → nulls).
 *   - Default Supabase-Storage binding: remove success + error surfaced.
 *
 * Supabase is mocked (repo convention); storage is an in-memory synthetic.
 * No cloud writes, no real candidate data.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { setRateLimitStore, MemoryRateLimitStore } from '../lib/rate-limit.js';
import {
  eraseRecording,
  releaseLegalHold,
  revokeErasureException,
  revokeRecording,
  propagateErasureToProcessors,
  scheduleBackupAging,
  supabaseStorageRecordingStorage,
} from '../lib/retention.js';
import type { RecordingStorage } from '../lib/retention.js';

// ── In-memory synthetic store ────────────────────────────────────────

type Row = Record<string, unknown>;
type TableName =
  | 'call_sessions'
  | 'recording_integrity_events'
  | 'governance_audit'
  | 'legal_holds'
  | 'erasure_exceptions'
  | 'retention_policies'
  | 'candidate_access_grants'
  | 'recruiter_memberships';

let mem: Record<TableName, Row[]> = {} as Record<TableName, Row[]>;
const storageObjects = new Map<string, Buffer>();
let failUpdateTable: TableName | null = null;
let failInsertTable: TableName | null = null;
let storageRemoveError: string | null = null;
let createSignedUrlCalls: unknown[] = [];

let _idCounter = 0;
function nextId(): string {
  _idCounter++;
  return `00000000-0000-4000-8000-${String(_idCounter).padStart(12, '0')}`;
}
function ts(): string { return new Date().toISOString(); }

function freshState() {
  _idCounter = 0;
  mem = {
    call_sessions: [],
    recording_integrity_events: [],
    governance_audit: [],
    legal_holds: [],
    erasure_exceptions: [],
    retention_policies: [],
    candidate_access_grants: [],
    recruiter_memberships: [],
  };
  storageObjects.clear();
  failUpdateTable = null;
  failInsertTable = null;
  storageRemoveError = null;
  createSignedUrlCalls = [];
}

/** Seed a session holding a recording (object present in synthetic storage). */
function seedSessionWithRecording(overrides: Row = {}) {
  const sessionId = overrides.id ?? SESSION_ID;
  mem.call_sessions.push({
    id: sessionId,
    owner_id: 'admin-1',
    recording_object_key: OBJECT_KEY,
    recording_sha256: 'a'.repeat(64),
    recording_size_bytes: 1024,
    recording_content_type: 'audio/webm',
    recording_provenance: 'browser_upload',
    recording_quarantined: false,
    recording_quarantine_reason: null,
    recording_revoked_at: null,
    recording_deleted_at: null,
    ...overrides,
  });
  storageObjects.set(OBJECT_KEY, Buffer.from('synthetic-audio-bytes'));
}

// ── Supabase mock (query builder + storage) ──────────────────────────

const mockFrom = vi.fn();
const mockCreateSignedUrl = vi.fn();
const mockAuthGetUser = vi.fn();

vi.mock('../lib/supabase.js', () => ({
  supabase: {
    from: (...args: unknown[]) => mockFrom(...args),
    auth: { getUser: (...a: unknown[]) => mockAuthGetUser(...a) },
    storage: {
      from: (_bucket: string) => ({
        remove: async (keys: string[]) => {
          if (storageRemoveError) {
            return { data: null, error: { message: storageRemoveError } };
          }
          let removed = 0;
          for (const k of keys) {
            if (storageObjects.delete(k as string)) removed++;
          }
          return { data: keys.map((k) => ({ name: k })), error: null };
        },
        createSignedUrl: (...a: unknown[]) => {
          createSignedUrlCalls.push(a);
          return mockCreateSignedUrl(...a);
        },
        // Fail-closed stub: this suite never exercises the download re-verify
        // (recording-integrity tests live in recordings.test.ts).
        download: async () => ({ data: null, error: { message: 'not provided in this suite' } }),
      }),
    },
  },
  RESUME_BUCKET: 'resumes_v2',
}));

/** Chainable Supabase query-builder mock backed by the in-memory tables. */
function makeFrom(table: string) {
  const rows = mem[table as TableName] as Row[];
  const filters: Array<(r: Row) => boolean> = [];
  let single = false;
  let maybeSingle = false;
  let isInsert = false;
  let isUpdate = false;
  let insertPayload: unknown;
  let updatePayload: Row;
  let sortField: string | undefined;
  let sortAsc = true;
  let limitCount: number | undefined;
  let rangeStart = 0;

  const q: Record<string, unknown> = {
    select() { return q; },
    eq(f: string, v: unknown) { filters.push((r: Row) => r[f] === v); return q; },
    is(f: string, v: unknown) {
      if (v === null) filters.push((r: Row) => r[f] == null);
      else filters.push((r: Row) => r[f] === v);
      return q;
    },
    order(f: string, o?: { ascending?: boolean }) { sortField = f; sortAsc = o?.ascending ?? true; return q; },
    limit(n: number) { limitCount = n; return q; },
    range(from: number, to: number) { rangeStart = from; limitCount = to - from + 1; return q; },
    single() { single = true; return q; },
    maybeSingle() { maybeSingle = true; return q; },
    insert(p: unknown) { isInsert = true; insertPayload = p; return q; },
    update(p: Row) { isUpdate = true; updatePayload = p; return q; },
    delete() { return q; },
    then(resolve: (v: unknown) => unknown) { return Promise.resolve(exec()).then(resolve); },
  };

  function exec() {
    if (isInsert) {
      if (failInsertTable === table) return { data: null, error: { message: 'insert failed' } };
      const list = (Array.isArray(insertPayload) ? insertPayload : [insertPayload]) as Row[];
      const inserted = list.map((p) => {
        const row: Row = { id: p.id ?? nextId(), ...p, created_at: p.created_at ?? ts() };
        rows.push(row);
        return row;
      });
      return { data: inserted.length === 1 ? inserted[0] : inserted, error: null };
    }
    if (isUpdate) {
      if (failUpdateTable === table) return { data: null, error: { message: 'update failed' } };
      const matched = rows.filter((r) => filters.every((f) => f(r)));
      for (const r of matched) Object.assign(r, updatePayload);
      return {
        data: single ? (matched[0] ?? null) : matched,
        error: matched.length === 0 && single ? { message: 'not found', code: 'PGRST116' } : null,
      };
    }
    // SELECT
    let matched = rows.filter((r) => filters.every((f) => f(r)));
    if (matched.length === 0) {
      if (single) return { data: null, error: { message: 'not found', code: 'PGRST116' } };
      if (maybeSingle) return { data: null, error: null };
      return { data: [], error: null };
    }
    if (sortField) {
      matched = [...matched].sort((a, b) => {
        const av = a[sortField!] as string | number;
        const bv = b[sortField!] as string | number;
        if (typeof av === 'string') return sortAsc ? av.localeCompare(bv as string) : (bv as string).localeCompare(av);
        return sortAsc ? (av as number) - (bv as number) : (bv as number) - (av as number);
      });
    }
    if (limitCount !== undefined) matched = matched.slice(rangeStart, rangeStart + limitCount);
    if (single || maybeSingle) {
      return {
        data: matched[0] ?? null,
        error: matched.length === 0 && single ? { message: 'not found', code: 'PGRST116' } : null,
      };
    }
    return { data: matched, error: null };
  }

  return q;
}

// ── Constants + helpers ──────────────────────────────────────────────

const SESSION_ID = '00000000-0000-4000-8000-000000000001';
const ACTOR_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OBJECT_KEY = `sessions/${SESSION_ID}/recording.webm`;
const GRANT_TOKEN = 'b'.repeat(64);
const FIXED_NOW = new Date('2026-02-01T00:00:00.000Z');

const JWT_AAL2 =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTAwMSIsImFhbCI6ImFhbDIifQ.signature';
const AUTH_HEADER = `Bearer ${JWT_AAL2}`;

function authAs(role: 'admin' | 'interviewer' | 'viewer', userId: string) {
  return {
    getUser: async () => ({
      data: {
        user: {
          id: userId,
          email: `${role}@test.invalid`,
          app_metadata: { app_role: role, org_id: null, active: true },
        },
      },
      error: null,
    }),
    resolveMembership: async () => ({ role, active: true }),
  };
}

function createTestApp(authDeps?: {
  getUser?: (token: string) => Promise<unknown>;
  resolveMembership?: (userId: string) => Promise<unknown>;
}) {
  return createApp({
    nodeEnv: 'test',
    webOrigin: 'http://localhost:5173',
    authDeps: authDeps as never,
    auditSinkOverride: async () => {},
  });
}

/** In-memory synthetic implementing the RecordingStorage interface. */
const syntheticStorage: RecordingStorage = {
  async remove(objectKey: string): Promise<void> {
    storageObjects.delete(objectKey); // absent key = success (idempotent)
  },
};

function sessionRow(id = SESSION_ID): Row | undefined {
  return mem.call_sessions.find((r) => r.id === id);
}
function deletedEvents(): Row[] {
  return mem.recording_integrity_events.filter((e) => e.event_type === 'deleted');
}
function successCompletions(): Row[] {
  return mem.governance_audit.filter(
    (a) => a.action === 'erasure_completed' && a.outcome === 'success',
  );
}
function failureCompletions(): Row[] {
  return mem.governance_audit.filter(
    (a) => a.action === 'erasure_completed' && a.outcome === 'failure',
  );
}

beforeEach(() => {
  freshState();
  setRateLimitStore(new MemoryRateLimitStore(100_000));
  mockFrom.mockImplementation((table: string) => makeFrom(table));
  mockCreateSignedUrl.mockResolvedValue({ data: null, error: { message: 'no' } });
  mockAuthGetUser.mockReset();
});

// ── Tests ────────────────────────────────────────────────────────────

describe('REC-06 eraseRecording — happy path + idempotency', () => {
  it('erases the object, tombstones, appends one deleted event + one completion audit', async () => {
    seedSessionWithRecording();

    const result = await eraseRecording(SESSION_ID, ACTOR_ID, { storage: syntheticStorage });

    expect(result.status).toBe('completed');
    expect(result.correlationId).toBeTruthy();

    // Tombstone + key NULLed (access revoked for the L5 gate).
    const row = sessionRow()!;
    expect(row.recording_deleted_at).toBeTruthy();
    expect(row.recording_object_key).toBeNull();

    // Object removed from synthetic storage.
    expect(storageObjects.has(OBJECT_KEY)).toBe(false);

    // Exactly one append-only deleted event.
    expect(deletedEvents()).toHaveLength(1);
    expect(deletedEvents()[0].session_id).toBe(SESSION_ID);

    // Exactly one success completion audit; synthetic models recorded.
    expect(successCompletions()).toHaveLength(1);
    const details = successCompletions()[0].details as Record<string, unknown>;
    expect(details.object_key_removed).toBe(true);
    const processors = details.processors as Array<Record<string, unknown>>;
    expect(processors[0].synthetic).toBe(true);
    const aging = details.backup_aging as Record<string, unknown>;
    expect(aging.synthetic).toBe(true);
  });

  it('no-ops idempotently on a second erase (no error, no duplicate audit)', async () => {
    seedSessionWithRecording();
    const first = await eraseRecording(SESSION_ID, ACTOR_ID, { storage: syntheticStorage });
    expect(first.status).toBe('completed');

    const second = await eraseRecording(SESSION_ID, ACTOR_ID, { storage: syntheticStorage });
    expect(second.status).toBe('already_deleted');

    // Still exactly one event + one completion audit.
    expect(deletedEvents()).toHaveLength(1);
    expect(successCompletions()).toHaveLength(1);
    expect(failureCompletions()).toHaveLength(0);
  });

  it('returns not_found for an unknown session (no completion claimed)', async () => {
    const result = await eraseRecording(SESSION_ID, ACTOR_ID, { storage: syntheticStorage });
    expect(result.status).toBe('not_found');
    expect(successCompletions()).toHaveLength(0);
    expect(deletedEvents()).toHaveLength(0);
  });

  it('treats a missing storage object as success and still tombstones', async () => {
    // Session references an object key that is NOT in the synthetic store.
    seedSessionWithRecording();
    storageObjects.delete(OBJECT_KEY);

    const result = await eraseRecording(SESSION_ID, ACTOR_ID, { storage: syntheticStorage });
    expect(result.status).toBe('completed');
    expect(sessionRow()!.recording_deleted_at).toBeTruthy();
    expect(sessionRow()!.recording_object_key).toBeNull();
    expect(successCompletions()).toHaveLength(1);
  });
});

describe('REC-06 eraseRecording — legal hold / erasure exception precedence', () => {
  it('blocks on an active legal hold, audits, leaves the object; succeeds after release', async () => {
    seedSessionWithRecording();
    const holdId = nextId();
    mem.legal_holds.push({
      id: holdId,
      entity_type: 'recording',
      entity_id: SESSION_ID,
      hold_reason: 'Active litigation',
      hold_source: 'litigation_hold',
      placed_by: ACTOR_ID,
      placed_at: ts(),
      released_at: null,
      released_by: null,
      release_reason: null,
      expires_at: null,
      metadata: null,
    });

    const blocked = await eraseRecording(SESSION_ID, ACTOR_ID, { storage: syntheticStorage });
    expect(blocked.status).toBe('blocked_legal_hold');
    expect(blocked.blockedBy).toBe('legal_hold');

    // Audited as blocked; object + row untouched.
    const blockedAudit = mem.governance_audit.find(
      (a) => a.action === 'erasure_blocked_legal_hold' && a.outcome === 'blocked',
    );
    expect(blockedAudit).toBeDefined();
    expect((blockedAudit!.details as Record<string, unknown>).block_reason).toBe('legal_hold');
    expect(storageObjects.has(OBJECT_KEY)).toBe(true);
    expect(sessionRow()!.recording_deleted_at).toBeNull();
    expect(successCompletions()).toHaveLength(0);
    expect(deletedEvents()).toHaveLength(0);

    // Releasing the hold then permits erasure (existing releaseLegalHold).
    const released = await releaseLegalHold(holdId, ACTOR_ID, 'case resolved');
    expect(released).not.toBeNull();

    const done = await eraseRecording(SESSION_ID, ACTOR_ID, { storage: syntheticStorage });
    expect(done.status).toBe('completed');
    expect(successCompletions()).toHaveLength(1);
  });

  it('blocks on an active erasure exception, audits, leaves the object; succeeds after revoke', async () => {
    seedSessionWithRecording();
    const exceptionId = nextId();
    mem.erasure_exceptions.push({
      id: exceptionId,
      entity_type: 'recording',
      entity_id: SESSION_ID,
      exception_type: 'regulatory',
      reason: 'Regulator requires retention',
      granted_by: ACTOR_ID,
      granted_at: ts(),
      expires_at: null,
      revoked_at: null,
      revoked_by: null,
      metadata: null,
    });

    const blocked = await eraseRecording(SESSION_ID, ACTOR_ID, { storage: syntheticStorage });
    expect(blocked.status).toBe('blocked_exception');
    expect(blocked.blockedBy).toBe('erasure_exception');

    const blockedAudit = mem.governance_audit.find(
      (a) => a.action === 'erasure_blocked_legal_hold' && a.outcome === 'blocked',
    );
    expect(blockedAudit).toBeDefined();
    expect((blockedAudit!.details as Record<string, unknown>).block_reason).toBe('erasure_exception');
    expect(storageObjects.has(OBJECT_KEY)).toBe(true);
    expect(sessionRow()!.recording_deleted_at).toBeNull();

    const revoked = await revokeErasureException(exceptionId, ACTOR_ID, 'no longer required');
    expect(revoked).not.toBeNull();

    const done = await eraseRecording(SESSION_ID, ACTOR_ID, { storage: syntheticStorage });
    expect(done.status).toBe('completed');
    expect(successCompletions()).toHaveLength(1);
  });
});

describe('REC-06 eraseRecording — failure boundaries (partial-failure behavior)', () => {
  it('storage delete failure leaves the row untouched and is fully retryable', async () => {
    seedSessionWithRecording();
    const failingStorage: RecordingStorage = {
      remove: async () => { throw new Error('storage backend boom'); },
    };

    const result = await eraseRecording(SESSION_ID, ACTOR_ID, { storage: failingStorage });
    expect(result.status).toBe('failed_storage_delete');
    expect(result.failure).toBe('storage_delete');

    // Nothing mutated: no tombstone, object intact, no event, no success audit.
    expect(sessionRow()!.recording_deleted_at).toBeNull();
    expect(sessionRow()!.recording_object_key).toBe(OBJECT_KEY);
    expect(storageObjects.has(OBJECT_KEY)).toBe(true);
    expect(deletedEvents()).toHaveLength(0);
    expect(successCompletions()).toHaveLength(0);
    expect(failureCompletions()).toHaveLength(1);
    expect((failureCompletions()[0].details as Record<string, unknown>).failure).toBe('storage_delete');

    // Retry with a healthy storage completes cleanly.
    const retry = await eraseRecording(SESSION_ID, ACTOR_ID, { storage: syntheticStorage });
    expect(retry.status).toBe('completed');
    expect(successCompletions()).toHaveLength(1);
    expect(deletedEvents()).toHaveLength(1);
  });

  it('tombstone write failure removes the object, never claims completion; retry completes once', async () => {
    seedSessionWithRecording();
    failUpdateTable = 'call_sessions';

    const result = await eraseRecording(SESSION_ID, ACTOR_ID, { storage: syntheticStorage });
    expect(result.status).toBe('failed_tombstone');
    expect(result.failure).toBe('tombstone_write');

    // Object gone, row untouched (no tombstone), no event, no success audit.
    expect(storageObjects.has(OBJECT_KEY)).toBe(false);
    expect(sessionRow()!.recording_deleted_at).toBeNull();
    expect(deletedEvents()).toHaveLength(0);
    expect(successCompletions()).toHaveLength(0);
    expect(failureCompletions()).toHaveLength(1);

    // Retry (failure cleared): storage remove idempotent on absent key → completes
    // with exactly one event + one success audit (no duplicates).
    failUpdateTable = null;
    const retry = await eraseRecording(SESSION_ID, ACTOR_ID, { storage: syntheticStorage });
    expect(retry.status).toBe('completed');
    expect(deletedEvents()).toHaveLength(1);
    expect(successCompletions()).toHaveLength(1);
  });

  it('integrity-event write failure leaves the tombstone (access blocked) and a retry CONVERGES (F3 repair)', async () => {
    seedSessionWithRecording();
    failInsertTable = 'recording_integrity_events';

    const result = await eraseRecording(SESSION_ID, ACTOR_ID, { storage: syntheticStorage });
    expect(result.status).toBe('failed_integrity_event');
    expect(result.failure).toBe('integrity_event_write');

    // Tombstone IS set (access revoked — cannot be resurrected), object gone,
    // but completion is NOT claimed and the failure is audited.
    expect(sessionRow()!.recording_deleted_at).toBeTruthy();
    expect(sessionRow()!.recording_object_key).toBeNull();
    expect(storageObjects.has(OBJECT_KEY)).toBe(false);
    expect(deletedEvents()).toHaveLength(0);
    expect(successCompletions()).toHaveLength(0);
    expect(failureCompletions()).toHaveLength(1);

    // Access is blocked: recruiter download 404, no signed URL.
    const app = createTestApp(authAs('admin', 'admin-1'));
    const dl = await request(app)
      .get(`/api/recordings/${SESSION_ID}/download`)
      .set('Authorization', AUTH_HEADER);
    expect(dl.status).toBe(404);
    expect(mockCreateSignedUrl).not.toHaveBeenCalled();

    // F3 repair: the retry (failure cleared) BACKFILLS the missing deleted
    // evidence + success completion audit instead of permanently returning
    // already_deleted — exactly one event + one success audit.
    failInsertTable = null;
    const retry = await eraseRecording(SESSION_ID, ACTOR_ID, { storage: syntheticStorage });
    expect(retry.status).toBe('completed');
    expect(retry.converged).toBe(true);
    expect(deletedEvents()).toHaveLength(1);
    expect(successCompletions()).toHaveLength(1);

    // A further retry is a fully-converged idempotent no-op (no duplication).
    const third = await eraseRecording(SESSION_ID, ACTOR_ID, { storage: syntheticStorage });
    expect(third.status).toBe('already_deleted');
    expect(deletedEvents()).toHaveLength(1);
    expect(successCompletions()).toHaveLength(1);
  });
});

describe('REC-06 deleted recordings are not downloadable / re-mintable', () => {
  it('returns 404 on recruiter download and denies the grant mint after erasure', async () => {
    seedSessionWithRecording();
    const result = await eraseRecording(SESSION_ID, ACTOR_ID, { storage: syntheticStorage });
    expect(result.status).toBe('completed');

    const app = createTestApp(authAs('admin', 'admin-1'));

    // Recruiter download → 404, no signed URL (L5 gate honours the tombstone).
    const dl = await request(app)
      .get(`/api/recordings/${SESSION_ID}/download`)
      .set('Authorization', AUTH_HEADER);
    expect(dl.status).toBe(404);
    expect(mockCreateSignedUrl).not.toHaveBeenCalled();

    // Candidate grant mint → 404 (gate runs before handleRecordingGrant).
    const mint = await request(app)
      .post('/api/livekit/grant/recording')
      .send({ grant_token: GRANT_TOKEN, session_id: SESSION_ID });
    expect(mint.status).toBe(404);
  });
});

describe('REC-06 synthetic processor propagation + backup aging', () => {
  it('propagateErasureToProcessors records deterministic synthetic intent', () => {
    const intent = propagateErasureToProcessors(SESSION_ID, 'corr-123', { now: FIXED_NOW });
    expect(intent.sessionId).toBe(SESSION_ID);
    expect(intent.correlationId).toBe('corr-123');
    expect(intent.recordedAt).toBe(FIXED_NOW.toISOString());
    expect(intent.processors).toHaveLength(1);
    expect(intent.processors[0].id).toBe('livekit_egress_mp3');
    expect(intent.processors[0].synthetic).toBe(true);
    expect(intent.processors[0].erasure_forwarded).toBe(true);

    // Without correlation id / now → defaults.
    const bare = propagateErasureToProcessors(SESSION_ID);
    expect(bare.correlationId).toBeNull();
    expect(bare.recordedAt).toBeTruthy();
  });

  it('scheduleBackupAging computes a deterministic horizon from the synthetic recording policy', async () => {
    const policyId = nextId();
    mem.retention_policies.push({
      id: policyId,
      data_category: 'recording',
      retention_days: 90,
      strategy: 'archive',
      is_default: false,
      notes: 'synthetic recording policy',
      created_by: null,
      created_at: ts(),
      updated_at: ts(),
    });

    const plan = await scheduleBackupAging(SESSION_ID, 'recording', { now: FIXED_NOW });
    expect(plan.sessionId).toBe(SESSION_ID);
    expect(plan.policyId).toBe(policyId);
    expect(plan.retentionDays).toBe(90);
    expect(plan.strategy).toBe('archive');
    expect(plan.horizonIso).toBe(
      new Date(FIXED_NOW.getTime() + 90 * 86_400_000).toISOString(),
    );
    expect(plan.synthetic).toBe(true);
  });

  it('scheduleBackupAging yields a null horizon for indefinite (D-009) and for a missing policy', async () => {
    // Indefinite policy (-1 days) → no expiry horizon.
    mem.retention_policies.push({
      id: nextId(),
      data_category: 'recording',
      retention_days: -1,
      strategy: 'archive',
      is_default: true,
      notes: 'D-009 default: retain indefinitely',
      created_by: null,
      created_at: ts(),
      updated_at: ts(),
    });
    const indefinite = await scheduleBackupAging(SESSION_ID, 'recording', { now: FIXED_NOW });
    expect(indefinite.retentionDays).toBe(-1);
    expect(indefinite.horizonIso).toBeNull();
    expect(indefinite.synthetic).toBe(true);

    // No policy configured → all nulls, still synthetic (no claim).
    const missing = await scheduleBackupAging(SESSION_ID, 'candidate', { now: FIXED_NOW });
    expect(missing.policyId).toBeNull();
    expect(missing.retentionDays).toBeNull();
    expect(missing.horizonIso).toBeNull();
    expect(missing.synthetic).toBe(true);
  });

  it('eraseRecording folds the synthetic propagation + aging models into the completion audit', async () => {
    mem.retention_policies.push({
      id: nextId(),
      data_category: 'recording',
      retention_days: 90,
      strategy: 'archive',
      is_default: false,
      notes: 'synthetic recording policy',
      created_by: null,
      created_at: ts(),
      updated_at: ts(),
    });
    seedSessionWithRecording();

    const result = await eraseRecording(SESSION_ID, ACTOR_ID, { storage: syntheticStorage });
    expect(result.status).toBe('completed');

    const details = successCompletions()[0].details as Record<string, unknown>;
    const processors = details.processors as Array<Record<string, unknown>>;
    expect(processors[0].synthetic).toBe(true);
    const aging = details.backup_aging as Record<string, unknown>;
    expect(aging.retention_days).toBe(90);
    expect(aging.horizon_iso).toBeTruthy();
    expect(aging.synthetic).toBe(true);
  });
});

describe('REC-05 revokeRecording (F2 repair) — retry-convergent revocation', () => {
  function revokedEvents(): Row[] {
    return mem.recording_integrity_events.filter((e) => e.event_type === 'revoked');
  }

  it('revokes: CAS-sets recording_revoked_at, appends exactly one revoked event', async () => {
    seedSessionWithRecording();
    expect(sessionRow()!.recording_revoked_at).toBeNull();

    const result = await revokeRecording(SESSION_ID, ACTOR_ID, { reason: 'recruiter decision' });
    expect(result.status).toBe('revoked');
    expect(result.revokedAt).toBeTruthy();
    expect(result.backfilled).toBe(false);
    expect(sessionRow()!.recording_revoked_at).toBe(result.revokedAt);
    expect(revokedEvents()).toHaveLength(1);
    expect((revokedEvents()[0].detail as string)).toContain('recruiter decision');
  });

  it('is idempotent on retry (already_revoked, no duplicate event)', async () => {
    seedSessionWithRecording();
    const first = await revokeRecording(SESSION_ID, ACTOR_ID);
    expect(first.status).toBe('revoked');

    const second = await revokeRecording(SESSION_ID, ACTOR_ID);
    expect(second.status).toBe('already_revoked');
    expect(second.revokedAt).toBe(first.revokedAt);
    expect(revokedEvents()).toHaveLength(1);
  });

  it('backfills a missing revoked event when revoked_at is already set (convergence)', async () => {
    // Simulate a partial write: revoked_at set but the append-only event
    // never landed (e.g. interrupted first attempt).
    seedSessionWithRecording({ recording_revoked_at: '2026-01-15T00:00:00.000Z' });

    const result = await revokeRecording(SESSION_ID, ACTOR_ID);
    expect(result.status).toBe('revoked');
    expect(result.backfilled).toBe(true);
    expect(result.revokedAt).toBe('2026-01-15T00:00:00.000Z');
    expect(revokedEvents()).toHaveLength(1);
  });

  it('returns not_found for an unknown session (no mutation)', async () => {
    const result = await revokeRecording(SESSION_ID, ACTOR_ID);
    expect(result.status).toBe('not_found');
    expect(result.revokedAt).toBeNull();
    expect(revokedEvents()).toHaveLength(0);
  });

  it('surfaces a failed CAS update as failed_update (fail-closed, retryable)', async () => {
    seedSessionWithRecording();
    failUpdateTable = 'call_sessions';
    const result = await revokeRecording(SESSION_ID, ACTOR_ID);
    expect(result.status).toBe('failed_update');
    expect(sessionRow()!.recording_revoked_at).toBeNull();
    expect(revokedEvents()).toHaveLength(0);

    // Retry with the failure cleared converges exactly once.
    failUpdateTable = null;
    const retry = await revokeRecording(SESSION_ID, ACTOR_ID);
    expect(retry.status).toBe('revoked');
    expect(revokedEvents()).toHaveLength(1);
  });

  it('surfaces a failed event write as failed_event (retry backfills)', async () => {
    seedSessionWithRecording();
    failInsertTable = 'recording_integrity_events';
    const result = await revokeRecording(SESSION_ID, ACTOR_ID);
    expect(result.status).toBe('failed_event');
    // Transition already persisted (access revoked), event missing.
    expect(sessionRow()!.recording_revoked_at).toBeTruthy();
    expect(revokedEvents()).toHaveLength(0);

    failInsertTable = null;
    const retry = await revokeRecording(SESSION_ID, ACTOR_ID);
    expect(retry.status).toBe('revoked');
    expect(retry.backfilled).toBe(true);
    expect(revokedEvents()).toHaveLength(1);
  });

  it('denies both mint paths (403) once revoked — no signed URL', async () => {
    seedSessionWithRecording();
    const result = await revokeRecording(SESSION_ID, ACTOR_ID);
    expect(result.status).toBe('revoked');

    const app = createTestApp(authAs('admin', 'admin-1'));

    // Recruiter download gate → 403 before createSignedUrl.
    const dl = await request(app)
      .get(`/api/recordings/${SESSION_ID}/download`)
      .set('Authorization', AUTH_HEADER);
    expect(dl.status).toBe(403);
    expect(mockCreateSignedUrl).not.toHaveBeenCalled();

    // Candidate grant mint gate → 403 before signing.
    const mint = await request(app)
      .post('/api/livekit/grant/recording')
      .send({ grant_token: GRANT_TOKEN, session_id: SESSION_ID });
    expect(mint.status).toBe(403);
    expect(mockCreateSignedUrl).not.toHaveBeenCalled();
  });
});

describe('REC-06 default Supabase-Storage binding', () => {
  it('removes the object on success', async () => {
    storageObjects.set(OBJECT_KEY, Buffer.from('bytes'));
    const storage = supabaseStorageRecordingStorage('recordings_v2');
    await expect(storage.remove(OBJECT_KEY)).resolves.toBeUndefined();
    expect(storageObjects.has(OBJECT_KEY)).toBe(false);
  });

  it('surfaces a storage error (fail-closed)', async () => {
    storageRemoveError = 'bucket unavailable';
    const storage = supabaseStorageRecordingStorage('recordings_v2');
    await expect(storage.remove(OBJECT_KEY)).rejects.toThrow(/recording storage remove failed/);
  });
});


// ═══════════════════════════════════════════════════════════════════════
// 0038 — erasure truthfulness: the orphan branch and the MANIFEST
// ═══════════════════════════════════════════════════════════════════════
//
// Two independent compliance defects are covered here.
//
// (1) THE ORPHAN. A session whose finalize never ran has a NULL
//     `recording_object_key` and a live `recording_egress_id` — and the egress
//     wrote its object anyway. Erasing such a session by tombstoning the row
//     alone leaves candidate audio in the bucket while recording a completed
//     erasure. That is the exact population the convergence repair exists for,
//     so it is also exactly the population most likely to be erased.
//
// (2) THE MANIFEST. Egress starts with `disableManifest: false`, so a
//     `<key>.json` manifest exists for every egress-recorded session, and
//     NOTHING ever removed it — not in the orphan case, and not on the normal
//     fully-linked path either.
//
// A false `erasure_completed` is materially worse than a failure record: this
// is the one part of the change with regulatory rather than operational weight.

const EGRESS_SESSION_ID = '00000000-0000-4000-8000-0000000000e9';
const EGRESS_KEY = `${EGRESS_SESSION_ID}-egress.ogg`;
const EGRESS_MANIFEST = `${EGRESS_SESSION_ID}-egress.ogg.json`;

/** A storage double that can also be ASKED whether a key exists. */
function probingStorage(): RecordingStorage & { removed: string[] } {
  const removed: string[] = [];
  return {
    removed,
    async remove(objectKey: string): Promise<void> {
      removed.push(objectKey);
      storageObjects.delete(objectKey);
    },
    async exists(objectKey: string): Promise<boolean> {
      return storageObjects.has(objectKey);
    },
  };
}

function seedOrphanEgressSession(): void {
  mem.call_sessions.push({
    id: EGRESS_SESSION_ID,
    owner_id: 'admin-1',
    // The stuck shape: finalize never linked a key...
    recording_object_key: null,
    recording_egress_id: 'EG_synthetic123',
    recording_egress_status: 'active',
    recording_sha256: null,
    recording_size_bytes: null,
    recording_content_type: null,
    recording_provenance: null,
    recording_quarantined: false,
    recording_quarantine_reason: null,
    recording_revoked_at: null,
    recording_deleted_at: null,
  });
}

function completionFor(sessionId: string): Row[] {
  return mem.governance_audit.filter(
    (a) => a.action === 'erasure_completed' && a.entity_id === sessionId,
  );
}

describe('0038 erasure: NULL key + live egress (the orphan branch)', () => {
  it('object PRESENT → object AND manifest removed, audit truthful', async () => {
    seedOrphanEgressSession();
    // ...but the egress wrote both objects anyway.
    storageObjects.set(EGRESS_KEY, Buffer.from('orphaned-audio'));
    storageObjects.set(EGRESS_MANIFEST, Buffer.from('{}'));
    const storage = probingStorage();

    const result = await eraseRecording(EGRESS_SESSION_ID, ACTOR_ID, { storage });

    expect(result.status).toBe('completed');
    expect(storageObjects.has(EGRESS_KEY)).toBe(false);
    expect(storageObjects.has(EGRESS_MANIFEST)).toBe(false);

    const details = completionFor(EGRESS_SESSION_ID)[0].details as Record<string, unknown>;
    expect(details.object_key_removed).toBe(true);
    expect(details.manifest_removed).toBe(true);
    expect(details.orphan_probe).toBe('removed');
  });

  it('object ABSENT → idempotent success that does NOT claim a removal', async () => {
    seedOrphanEgressSession();
    const storage = probingStorage();

    const result = await eraseRecording(EGRESS_SESSION_ID, ACTOR_ID, { storage });

    expect(result.status).toBe('completed');
    const details = completionFor(EGRESS_SESSION_ID)[0].details as Record<string, unknown>;
    // The whole point: idempotent success, truthfully labelled.
    expect(details.object_key_removed).toBe(false);
    expect(details.orphan_probe).toBe('absent');
    expect(storage.removed).toEqual([]);
  });

  it('object PRESENT but UNDELETABLE → failed_storage_delete, never a success', async () => {
    seedOrphanEgressSession();
    storageObjects.set(EGRESS_KEY, Buffer.from('orphaned-audio'));
    const storage: RecordingStorage = {
      async remove(): Promise<void> { throw new Error('storage backend boom'); },
      async exists(key: string): Promise<boolean> { return storageObjects.has(key); },
    };

    const result = await eraseRecording(EGRESS_SESSION_ID, ACTOR_ID, { storage });

    expect(result.status).toBe('failed_storage_delete');
    // Nothing was tombstoned and no success was claimed — fully retryable.
    expect(sessionRow(EGRESS_SESSION_ID)!.recording_deleted_at).toBeNull();
    expect(storageObjects.has(EGRESS_KEY)).toBe(true);
    const success = completionFor(EGRESS_SESSION_ID).filter((a) => a.outcome === 'success');
    expect(success).toHaveLength(0);
  });

  it('a storage double with NO probe reports orphan_probe: unavailable, never "absent"', async () => {
    // "We could not look" is a real, reportable limitation. Reporting it as
    // absence would be a confident claim about a bucket nobody inspected.
    seedOrphanEgressSession();
    storageObjects.set(EGRESS_KEY, Buffer.from('orphaned-audio'));
    const blind: RecordingStorage = { async remove(): Promise<void> {} };

    const result = await eraseRecording(EGRESS_SESSION_ID, ACTOR_ID, { storage: blind });

    expect(result.status).toBe('completed');
    const details = completionFor(EGRESS_SESSION_ID)[0].details as Record<string, unknown>;
    expect(details.orphan_probe).toBe('unavailable');
    expect(details.object_key_removed).toBe(false);
  });
});

describe('0038 erasure: the manifest on the NORMAL, fully-linked path', () => {
  it('a linked EGRESS key also removes its manifest sibling', async () => {
    // The gap was wider than the orphan case: the manifest was never removed
    // on the ordinary path either.
    mem.call_sessions.push({
      id: EGRESS_SESSION_ID,
      owner_id: 'admin-1',
      recording_object_key: EGRESS_KEY,
      recording_egress_id: 'EG_synthetic123',
      recording_provenance: 'livekit_egress',
      recording_sha256: 'b'.repeat(64),
      recording_size_bytes: 2048,
      recording_content_type: 'audio/ogg',
      recording_quarantined: false,
      recording_quarantine_reason: null,
      recording_revoked_at: null,
      recording_deleted_at: null,
    });
    storageObjects.set(EGRESS_KEY, Buffer.from('audio'));
    storageObjects.set(EGRESS_MANIFEST, Buffer.from('{}'));
    const storage = probingStorage();

    const result = await eraseRecording(EGRESS_SESSION_ID, ACTOR_ID, { storage });

    expect(result.status).toBe('completed');
    expect(storage.removed).toEqual([EGRESS_KEY, EGRESS_MANIFEST]);
    const details = completionFor(EGRESS_SESSION_ID)[0].details as Record<string, unknown>;
    expect(details.object_key_removed).toBe(true);
    expect(details.manifest_removed).toBe(true);
  });

  it('N-3: manifest_removed is FALSE when the manifest was not actually there', async () => {
    // `storage.remove()` is contractually idempotent — it succeeds on an
    // absent key — so "the call did not throw" is not evidence of a removal.
    // That is exactly the pattern this change eliminates for
    // `object_key_removed`; claiming it for `manifest_removed` would just move
    // the overstatement to a quieter field.
    mem.call_sessions.push({
      id: EGRESS_SESSION_ID,
      owner_id: 'admin-1',
      recording_object_key: EGRESS_KEY,
      recording_egress_id: 'EG_synthetic123',
      recording_provenance: 'livekit_egress',
      recording_sha256: 'b'.repeat(64),
      recording_size_bytes: 2048,
      recording_content_type: 'audio/ogg',
      recording_quarantined: false,
      recording_quarantine_reason: null,
      recording_revoked_at: null,
      recording_deleted_at: null,
    });
    // The recording is present; its manifest is NOT.
    storageObjects.set(EGRESS_KEY, Buffer.from('audio'));
    const storage = probingStorage();

    const result = await eraseRecording(EGRESS_SESSION_ID, ACTOR_ID, { storage });

    expect(result.status).toBe('completed');
    const details = completionFor(EGRESS_SESSION_ID)[0].details as Record<string, unknown>;
    expect(details.object_key_removed).toBe(true);
    expect(details.manifest_removed).toBe(false);
  });

  it('N-3: an unprobeable manifest is reported as NOT removed, never as removed', async () => {
    // "We could not look" is not "we removed it". The delete is still
    // attempted (idempotent, and the manifest almost certainly exists), but
    // the audit does not claim what was not observed.
    mem.call_sessions.push({
      id: EGRESS_SESSION_ID,
      owner_id: 'admin-1',
      recording_object_key: EGRESS_KEY,
      recording_egress_id: 'EG_synthetic123',
      recording_provenance: 'livekit_egress',
      recording_sha256: 'b'.repeat(64),
      recording_size_bytes: 2048,
      recording_content_type: 'audio/ogg',
      recording_quarantined: false,
      recording_quarantine_reason: null,
      recording_revoked_at: null,
      recording_deleted_at: null,
    });
    storageObjects.set(EGRESS_KEY, Buffer.from('audio'));
    storageObjects.set(EGRESS_MANIFEST, Buffer.from('{}'));
    const removed: string[] = [];
    const blind: RecordingStorage = {
      async remove(key: string): Promise<void> { removed.push(key); storageObjects.delete(key); },
    };

    const result = await eraseRecording(EGRESS_SESSION_ID, ACTOR_ID, { storage: blind });

    expect(result.status).toBe('completed');
    // The delete WAS attempted...
    expect(removed).toEqual([EGRESS_KEY, EGRESS_MANIFEST]);
    // ...but not claimed.
    const details = completionFor(EGRESS_SESSION_ID)[0].details as Record<string, unknown>;
    expect(details.manifest_removed).toBe(false);
  });

  it('a BROWSER-upload key gets no manifest guess — a wrong key would be a quiet false success', async () => {
    seedSessionWithRecording();
    const storage = probingStorage();
    const result = await eraseRecording(SESSION_ID, ACTOR_ID, { storage });
    expect(result.status).toBe('completed');
    // Exactly the linked key, and nothing invented alongside it.
    expect(storage.removed).toEqual([OBJECT_KEY]);
    const details = completionFor(SESSION_ID)[0].details as Record<string, unknown>;
    expect(details.manifest_removed).toBe(false);
    expect(details.orphan_probe).toBe('not_applicable');
  });
});

describe('0038 erasure: the already-tombstoned BACKFILL no longer claims a removal', () => {
  it('convergence backfill reports object_key_removed:false, not a hardcoded true', async () => {
    // This branch REMOVES NOTHING — it backfills missing evidence for a row
    // that was already tombstoned — and it hardcoded `object_key_removed: true`.
    // That was the genuine false-success compliance record.
    seedSessionWithRecording({ recording_deleted_at: '2026-08-19T00:00:00.000Z', recording_object_key: null });

    const result = await eraseRecording(SESSION_ID, ACTOR_ID, { storage: syntheticStorage });

    expect(result.status).toBe('completed');
    const success = completionFor(SESSION_ID).filter((a) => a.outcome === 'success');
    expect(success).toHaveLength(1);
    const details = success[0].details as Record<string, unknown>;
    expect(details.object_key_removed).toBe(false);
    expect(details.converged).toBe(true);
    expect(details.backfilled_evidence).toBe(true);
  });
});
