/**
 * POST /ashby/mission-control/ingestions/:applicationLinkId/retry —
 * the audited, BOUNDED admin recovery for a parse-class failed_review.
 *
 * WHY IT IS NOT A COUNTER RESET (and why that distinction is load-bearing):
 * 0036 zeroes an attempt counter, because a single now-fixed transport defect
 * had recorded one fault five times. That is a correction of mis-accounting.
 * A parse-class rest is not known to be one fault counted five times, so this
 * recovery instead performs the ordinary `failed_review -> queued` transition
 * and CHARGES an attempt for it. The five-attempt ceiling stays the real
 * bound, and an exhausted row answers 409 rather than being resurrected.
 *
 * The route contributes authentication, the admin gate, id validation and the
 * audit record. Everything that DECIDES whether the retry is permitted —
 * state, terminal application, the reason allowlist, the ceiling — is enforced
 * server-side in the RPC (migration 0039, proven in policy_tests.sql).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { createAshbyMissionControlRouter } from '../routes/ashby-mission-control.js';
import { setAuditSink, getAuditSink, type AuditEntry } from '../lib/audit.js';
import type { MissionControlStore } from '../integrations/ashby/workflow-stores.js';

const UUID = '11111111-1111-4111-8111-111111111111';
const PATH = `/mc/ingestions/${UUID}/retry`;

function fakeStore(over: Partial<MissionControlStore> = {}): MissionControlStore {
  return {
    listMappings: async () => [],
    listWorkflows: async () => [],
    setMappingStatus: async () => ({ status: 'ok' }),
    cancelApplication: async () => ({ status: 'ok' }),
    retryOperation: async () => ({ status: 'ok' }),
    retryIngestionParse: async () => ({ status: 'ok' }),
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
  it('an unauthenticated caller is refused', async () => {
    const calls = vi.fn();
    const res = await request(appWith(null, fakeStore({ retryIngestionParse: calls as never })))
      .post(PATH);
    expect(res.status).toBe(403);
    expect(calls).not.toHaveBeenCalled();
  });

  it('a viewer is refused', async () => {
    const calls = vi.fn();
    const res = await request(appWith('viewer', fakeStore({ retryIngestionParse: calls as never })))
      .post(PATH);
    expect(res.status).toBe(403);
    expect(calls).not.toHaveBeenCalled();
  });

  it('an INTERVIEWER is refused — reads are interviewer+, this mutation is admin-only', async () => {
    const calls = vi.fn();
    const res = await request(appWith('interviewer', fakeStore({ retryIngestionParse: calls as never })))
      .post(PATH);
    expect(res.status).toBe(403);
    expect(calls).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. Validation, outcomes, and the refusal matrix the RPC owns
// ═══════════════════════════════════════════════════════════════════════

describe('admin recovery', () => {
  it('rejects a malformed application link id before reaching the store', async () => {
    const calls = vi.fn();
    const res = await request(appWith('admin', fakeStore({ retryIngestionParse: calls as never })))
      .post('/mc/ingestions/not-a-uuid/retry');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: 'invalid_application_link_id' });
    expect(calls).not.toHaveBeenCalled();
  });

  it('the happy path returns 200 and passes the ACTOR through for attribution', async () => {
    const seen: Array<[string, string]> = [];
    const res = await request(appWith('admin', fakeStore({
      retryIngestionParse: async (linkId, actorId) => { seen.push([linkId, actorId]); return { status: 'ok' }; },
    }))).post(PATH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(seen).toEqual([[UUID, 'user_1']]);
  });

  for (const status of [
    'not_found',
    'not_recoverable',
    'blocked_terminal',
    'not_a_parse_availability_failure',
    'retry_exhausted',
  ]) {
    it(`a ${status} verdict from the RPC surfaces as a 409 carrying the stable status`, async () => {
      const res = await request(appWith('admin', fakeStore({
        retryIngestionParse: async () => ({ status }),
      }))).post(PATH);
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ ok: false, error: status });
    });
  }

  it('a store failure is a truthful 500, never a fabricated success', async () => {
    const res = await request(appWith('admin', fakeStore({
      retryIngestionParse: async () => { throw new Error('ashby_mc_ingestion_retry_error'); },
    }))).post(PATH);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'mission_control_action_error' });
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
    // The audit redactor collapses the 12-digit trailing group of any UUID
    // (its \b\d{10,}\b phone rule), so the recorded id is the same
    // partially-redacted shape every other Mission Control audit writes —
    // pre-existing, consistent, and over-redaction rather than under. The
    // point of the assertion is that the id recorded is the one the caller
    // supplied and nothing else.
    expect(String(row!.metadata!.application_link_id)).toContain('11111111-1111-4111-8111-');
  });

  it('a REFUSAL is audited too — a denied admin action must not be silent', async () => {
    await request(appWith('admin', fakeStore({
      retryIngestionParse: async () => ({ status: 'blocked_terminal' }),
    }))).post(PATH);
    const row = audits.find((a) => a.metadata?.resource === 'ashby_resume_ingestion');
    expect(row!.statusCode).toBe(409);
    expect(row!.metadata).toMatchObject({ outcome: 'blocked_terminal' });
  });

  it('neither the response nor the audit row carries a failure reason, handle, token, or PII', async () => {
    const res = await request(appWith('admin', fakeStore({
      retryIngestionParse: async () => ({ status: 'not_a_parse_availability_failure' }),
    }))).post(PATH);
    const blob = JSON.stringify(res.body) + JSON.stringify(audits);
    // The RPC knows the failed_reason; the route deliberately never asks for
    // it and never echoes one. Nothing about the document reaches the client.
    expect(blob).not.toMatch(/parse_extract_failed|scan_infected|guard_/);
    expect(blob).not.toMatch(/token|bearer|presigned|https?:\/\//i);
    expect(blob).not.toMatch(/@[a-z0-9.-]+\.[a-z]{2,}/i);
    // The only id present is the one the caller already supplied.
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
