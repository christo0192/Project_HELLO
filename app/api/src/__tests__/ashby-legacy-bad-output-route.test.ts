/**
 * POST /ashby/mission-control/ingestions/:applicationLinkId/retry-legacy-parse
 * — the ONE-SHOT release of a LEGACY `parse_bad_output` ingestion (0041).
 *
 * WHY A SEPARATE DOOR. `parse_bad_output` never meant "this document is bad".
 * The parser parent raises it in exactly one place — when `JSON.parse` of the
 * child's stdout throws — and our own dependency was breaking that channel:
 * pdf.js logs warnings through `console.log`, i.e. to stdout, so a PDF it
 * merely warned about had a `Warning: ` line prepended to the child's valid
 * JSON. Those rows recorded a verdict the document never earned, and document
 * verdicts are refused by the ordinary recovery for ever.
 *
 * Widening that recovery's allowlist would have made every `parse_bad_output`
 * retryable, including honest future ones. So this is its own route, and every
 * eligibility decision — the reason, the server-stamped boundary, the one-shot
 * flag, the unchanged ceiling, the terminal application — lives in the RPC
 * (migration 0041, proven in policy_tests.sql). The route contributes exactly
 * four things: authentication, the admin gate, id validation, and the audit
 * record.
 *
 * These tests therefore assert the ROUTE's contract against a fake store. They
 * deliberately do not restate the eligibility rules, which cannot be enforced
 * here and are not enforced here.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { createAshbyMissionControlRouter } from '../routes/ashby-mission-control.js';
import { setAuditSink, getAuditSink, type AuditEntry } from '../lib/audit.js';
import type { MissionControlStore } from '../integrations/ashby/workflow-stores.js';

const UUID = '11111111-1111-4111-8111-111111111111';
const PATH = `/mc/ingestions/${UUID}/retry-legacy-parse`;

function fakeStore(over: Partial<MissionControlStore> = {}): MissionControlStore {
  return {
    listMappings: async () => [],
    listWorkflows: async () => [],
    setMappingStatus: async () => ({ status: 'ok' }),
    cancelApplication: async () => ({ status: 'ok' }),
    retryOperation: async () => ({ status: 'ok' }),
    retryIngestionParse: async () => ({ status: 'ok' }),
    retryLegacyBadOutput: async () => ({ status: 'ok' }),
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
});
afterEach(() => { setAuditSink(restore); });

// ═══════════════════════════════════════════════════════════════════════
// 1. Auth / RBAC — the gate, before anything else
// ═══════════════════════════════════════════════════════════════════════

describe('legacy bad-output release — auth and RBAC', () => {
  it.each([
    ['anonymous', null],
    ['viewer', 'viewer'],
    ['interviewer', 'interviewer'],
    ['recruiter', 'recruiter'],
  ])('refuses %s and never reaches the store', async (_label, role) => {
    const retryLegacyBadOutput = vi.fn(async () => ({ status: 'ok' }));
    const res = await request(appWith(role, fakeStore({ retryLegacyBadOutput }))).post(PATH);
    expect(res.status).toBeGreaterThanOrEqual(401);
    expect(res.status).toBeLessThan(500);
    expect(retryLegacyBadOutput).not.toHaveBeenCalled();
  });

  it('rejects a malformed id before the store is consulted', async () => {
    const retryLegacyBadOutput = vi.fn(async () => ({ status: 'ok' }));
    const res = await request(appWith('admin', fakeStore({ retryLegacyBadOutput })))
      .post('/mc/ingestions/not-a-uuid/retry-legacy-parse');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: 'invalid_application_link_id' });
    expect(retryLegacyBadOutput).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. Outcomes — the RPC decides, the route only reports
// ═══════════════════════════════════════════════════════════════════════

describe('legacy bad-output release — outcomes', () => {
  it('releases once and reports nothing but success', async () => {
    const res = await request(appWith('admin', fakeStore())).post(PATH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it.each([
    // The second click on the same row, and every other refusal, arrive as a
    // stable status the route passes through untouched.
    ['legacy_recovery_exhausted'],
    ['not_legacy_bad_output'],
    ['not_recoverable'],
    ['blocked_terminal'],
    ['retry_exhausted'],
    ['ingestion_job_in_flight'],
    ['legacy_boundary_unavailable'],
    ['not_found'],
  ])('passes the refusal %s through as a 409 and nothing more', async (status) => {
    const res = await request(appWith('admin', fakeStore({
      retryLegacyBadOutput: async () => ({ status }),
    }))).post(PATH);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ ok: false, error: status });
  });

  it('answers a store failure with a generic 500 that leaks nothing', async () => {
    const res = await request(appWith('admin', fakeStore({
      retryLegacyBadOutput: async () => { throw new Error('ashby_mc_legacy_bad_output_error'); },
    }))).post(PATH);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'mission_control_action_error' });
  });

  it('forwards the authenticated actor, so the release is attributable', async () => {
    const retryLegacyBadOutput = vi.fn(async () => ({ status: 'ok' }));
    await request(appWith('admin', fakeStore({ retryLegacyBadOutput }))).post(PATH);
    expect(retryLegacyBadOutput).toHaveBeenCalledWith(UUID, 'user_1');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. Audit — attributable, and sanitized
// ═══════════════════════════════════════════════════════════════════════

describe('legacy bad-output release — audit', () => {
  it('audits both the success and the refusal with the outcome only', async () => {
    await request(appWith('admin', fakeStore())).post(PATH);
    await request(appWith('admin', fakeStore({
      retryLegacyBadOutput: async () => ({ status: 'legacy_recovery_exhausted' }),
    }))).post(PATH);

    const rows = audits.filter((a) => a.metadata?.resource === 'ashby_resume_ingestion');
    expect(rows).toHaveLength(2);
    expect(rows[0].metadata).toMatchObject({ resource: 'ashby_resume_ingestion', outcome: 'ok' });
    // The audit layer redacts the tail of the id, so only the prefix survives —
    // enough to correlate, not enough to enumerate.
    expect(String(rows[0].metadata!.application_link_id)).toContain('11111111-1111-4111-8111-');
    expect(String(rows[0].metadata!.application_link_id)).not.toBe(UUID);
    expect(rows[1].metadata).toMatchObject({ outcome: 'legacy_recovery_exhausted' });
  });

  it('carries no reason text, boundary, handle, external id, token or candidate field', async () => {
    await request(appWith('admin', fakeStore())).post(PATH);
    const row = audits.find((a) => a.metadata?.resource === 'ashby_resume_ingestion');
    // The resource label itself legitimately contains the word "resume"; what
    // must never appear is a reason, a boundary, a handle or a candidate field.
    const blob = JSON.stringify(row!.metadata);
    for (const forbidden of [
      'parse_bad_output', 'stdout_purity', 'effective_at', 'boundary',
      'external_application_id', 'external_resume_file_handle',
      'file_handle', 'token', 'presigned', 'email', 'phone', 'candidate_name',
    ]) {
      expect(blob).not.toContain(forbidden);
    }
    // Exactly the three sanitized keys, and no more.
    expect(Object.keys(row!.metadata ?? {}).sort())
      .toEqual(['application_link_id', 'outcome', 'resource']);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. Blast radius — this route schedules ONE thing and touches nothing else
// ═══════════════════════════════════════════════════════════════════════

describe('legacy bad-output release — blast radius', () => {
  it('issues no invite, moves no stage, and cancels nothing', async () => {
    const reissueManualInvite = vi.fn(async () => ({ status: 'ok', inviteId: UUID, revokedInvites: 0 }));
    const cancelApplication = vi.fn(async () => ({ status: 'ok' }));
    const setMappingStatus = vi.fn(async () => ({ status: 'ok' }));
    const retryOperation = vi.fn(async () => ({ status: 'ok' }));
    const retryIngestionParse = vi.fn(async () => ({ status: 'ok' }));

    await request(appWith('admin', fakeStore({
      reissueManualInvite, cancelApplication, setMappingStatus, retryOperation, retryIngestionParse,
    }))).post(PATH);

    expect(reissueManualInvite).not.toHaveBeenCalled();
    expect(cancelApplication).not.toHaveBeenCalled();
    expect(setMappingStatus).not.toHaveBeenCalled();
    expect(retryOperation).not.toHaveBeenCalled();
    // Crucially: it does NOT fall back to the ordinary recovery, whose
    // allowlist must go on refusing every document verdict.
    expect(retryIngestionParse).not.toHaveBeenCalled();
  });
});
