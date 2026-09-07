/**
 * POST /ashby/mission-control/ingestions/:applicationLinkId/retry-model-degraded
 * — the audited re-drive of a MODEL-DEGRADED ready ingestion (0084).
 *
 * WHY A THIRD DOOR EXISTS: both audited recoveries before it (0040 parse-class,
 * 0041 legacy bad-output) demand `failed_review`. The row this route serves is
 * the one they refuse for ever — a "successful" ingestion (`state = 'ready'`)
 * whose structuring silently fell back to the deterministic extractor when the
 * model call failed (RCA 2026-09-07: one of three identical résumés), leaving
 * the candidate permanently non-dialable with no operator remedy short of a
 * new application.
 *
 * The route contributes authentication, the admin gate, id validation and the
 * audit record. Everything that DECIDES whether the re-drive is permitted —
 * ready state, the deterministic-fallback structurer tag, terminal
 * application, the unchanged five-attempt ceiling, the in-flight refusal — is
 * enforced server-side in the RPC (migration 0084, proven in
 * policy_tests.sql).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { createAshbyMissionControlRouter } from '../routes/ashby-mission-control.js';
import { setAuditSink, getAuditSink, type AuditEntry } from '../lib/audit.js';
import type { MissionControlStore } from '../integrations/ashby/workflow-stores.js';

const UUID = '22222222-2222-4222-8222-222222222222';
const PATH = `/mc/ingestions/${UUID}/retry-model-degraded`;

function fakeStore(over: Partial<MissionControlStore> = {}): MissionControlStore {
  return {
    listMappings: async () => [],
    listWorkflows: async () => [],
    setMappingStatus: async () => ({ status: 'ok' }),
    cancelApplication: async () => ({ status: 'ok' }),
    retryOperation: async () => ({ status: 'ok' }),
    retryIngestionParse: async () => ({ status: 'ok' }),
    retryLegacyBadOutput: async () => ({ status: 'ok' }),
    retryModelDegraded: async () => ({ status: 'ok' }),
    upsertMapping: async () => ({ status: 'ok', id: UUID }),
    reissueManualInvite: async () => ({ status: 'ok', inviteId: UUID, revokedInvites: 0 }),
    ...over,
  };
}

function appWith(role: string | null, store: MissionControlStore) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (role) (req as unknown as { authUser: unknown }).authUser = { id: 'user_1', appRole: role };
    next();
  });
  app.use('/mc', createAshbyMissionControlRouter({ store }));
  return app;
}

let audits: AuditEntry[] = [];
let restore: ReturnType<typeof getAuditSink>;

beforeEach(() => {
  audits = [];
  restore = getAuditSink();
  setAuditSink(async (e) => { audits.push(e); });
  return () => setAuditSink(restore);
});

// ═══════════════════════════════════════════════════════════════════════
// 1. Authorization
// ═══════════════════════════════════════════════════════════════════════

describe('authorization', () => {
  for (const role of [null, 'viewer', 'interviewer'] as const) {
    it(`${role ?? 'an unauthenticated caller'} is refused before the store is reached`, async () => {
      const calls = vi.fn();
      const res = await request(appWith(role, fakeStore({ retryModelDegraded: calls as never })))
        .post(PATH);
      expect(res.status).toBe(403);
      expect(calls).not.toHaveBeenCalled();
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// 2. Validation, outcomes, and the refusal matrix the RPC owns
// ═══════════════════════════════════════════════════════════════════════

describe('admin re-drive', () => {
  it('rejects a malformed application link id before reaching the store', async () => {
    const calls = vi.fn();
    const res = await request(appWith('admin', fakeStore({ retryModelDegraded: calls as never })))
      .post('/mc/ingestions/not-a-uuid/retry-model-degraded');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: 'invalid_application_link_id' });
    expect(calls).not.toHaveBeenCalled();
  });

  it('the happy path returns 200 and passes the ACTOR through for attribution', async () => {
    const seen: Array<[string, string]> = [];
    const res = await request(appWith('admin', fakeStore({
      retryModelDegraded: async (linkId, actorId) => { seen.push([linkId, actorId]); return { status: 'ok' }; },
    }))).post(PATH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(seen).toEqual([[UUID, 'user_1']]);
  });

  for (const status of [
    'not_found',
    'not_recoverable',
    'blocked_terminal',
    'not_model_degraded',
    'retry_exhausted',
    'ingestion_job_in_flight',
  ]) {
    it(`a ${status} verdict from the RPC surfaces as a 409 carrying the stable status`, async () => {
      const res = await request(appWith('admin', fakeStore({
        retryModelDegraded: async () => ({ status }),
      }))).post(PATH);
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ ok: false, error: status });
    });
  }

  it('a store failure is a truthful 500, never a fabricated success', async () => {
    const res = await request(appWith('admin', fakeStore({
      retryModelDegraded: async () => { throw new Error('ashby_mc_model_degraded_error'); },
    }))).post(PATH);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'mission_control_action_error' });
  });

  it('this route drives the MODEL-DEGRADED door, never the failed_review ones', async () => {
    const wrongDoor = vi.fn(async () => ({ status: 'ok' }));
    const rightDoor = vi.fn(async () => ({ status: 'ok' }));
    await request(appWith('admin', fakeStore({
      retryIngestionParse: wrongDoor as never,
      retryLegacyBadOutput: wrongDoor as never,
      retryModelDegraded: rightDoor as never,
    }))).post(PATH);
    expect(rightDoor).toHaveBeenCalledTimes(1);
    expect(wrongDoor).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. Audit + disclosure boundary
// ═══════════════════════════════════════════════════════════════════════

describe('audit and disclosure', () => {
  it('writes an audit row carrying the opaque link id and the stable outcome only', async () => {
    await request(appWith('admin', fakeStore())).post(PATH);
    const row = audits.find((a) => a.metadata?.resource === 'ashby_resume_ingestion');
    expect(row).toBeDefined();
    expect(row!.userId).toBe('user_1');
    expect(row!.userRole).toBe('admin');
    expect(row!.statusCode).toBe(200);
    expect(row!.metadata).toMatchObject({ outcome: 'ok' });
    expect(String(row!.metadata!.application_link_id)).toContain('22222222-2222-4222-8222-');
  });

  it('a REFUSAL is audited too — a denied admin action must not be silent', async () => {
    await request(appWith('admin', fakeStore({
      retryModelDegraded: async () => ({ status: 'not_model_degraded' }),
    }))).post(PATH);
    const row = audits.find((a) => a.metadata?.resource === 'ashby_resume_ingestion');
    expect(row!.statusCode).toBe(409);
    expect(row!.metadata).toMatchObject({ outcome: 'not_model_degraded' });
  });

  it('neither the response nor the audit row carries a structurer tag, handle, token, or PII', async () => {
    const res = await request(appWith('admin', fakeStore({
      retryModelDegraded: async () => ({ status: 'not_model_degraded' }),
    }))).post(PATH);
    const blob = JSON.stringify(res.body) + JSON.stringify(audits);
    // The RPC knows the structurer_version; the route deliberately never asks
    // for it and never echoes one. Nothing about the document reaches the
    // client.
    expect(blob).not.toMatch(/deterministic-fallback|resume-model/);
    expect(blob).not.toMatch(/token|bearer|presigned|https?:\/\//i);
    expect(blob).not.toMatch(/@[a-z0-9.-]+\.[a-z]{2,}/i);
    expect(blob).not.toMatch(/handle_|file_/);
  });

  it('issues no invite and moves no stage — this route touches the ingestion alone', async () => {
    const forbidden = {
      reissueManualInvite: async () => { throw new Error('must_not_issue_an_invite'); },
      cancelApplication: async () => { throw new Error('must_not_cancel'); },
      setMappingStatus: async () => { throw new Error('must_not_change_a_mapping'); },
      retryOperation: async () => { throw new Error('must_not_retry_an_operation'); },
    };
    const res = await request(appWith('admin', fakeStore(forbidden as never))).post(PATH);
    expect(res.status).toBe(200);
  });
});
