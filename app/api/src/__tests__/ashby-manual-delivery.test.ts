/**
 * Manual invite DELIVERY — the surface that makes the invite reachable (B1).
 *
 * Before this repair the chain minted an invite, persisted only its SHA-256
 * digest, discarded the plaintext by design, threw away the manual artifact,
 * and completed the operation as `succeeded`. No API returned a link, the
 * reissue path pointed at a page with no such affordance, and the Mission
 * Control projection deliberately omits `sessionId` — so no operator action
 * could produce a usable link for that session. The operation reported success
 * for work that had not happened.
 *
 * These tests pin the repair:
 *   - an authorized admin can obtain a usable candidate link, exactly once;
 *   - the token is returned ONLY in the HTTPS body, never logged/audited/
 *     persisted/queried/stored, and the link carries it in the URL FRAGMENT;
 *   - the response is uncacheable;
 *   - interviewer / viewer / unauthenticated all fail closed;
 *   - terminal and not-ready applications are refused;
 *   - the operation only reaches `succeeded` because a human took the link.
 *
 * Zero network, zero DB: the Mission Control store is an injected recorder.
 */

import { describe, it, expect, afterEach } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { createAshbyMissionControlRouter } from '../routes/ashby-mission-control.js';
import type { MissionControlStore } from '../integrations/ashby/workflow-stores.js';
import { hashInviteToken, INVITE_TTL_HOURS } from '../lib/invite-token.js';
import { setAuditSink, getAuditSink } from '../lib/audit.js';

// The audit sink is a module-level global. Capturing it must never leak into
// another suite, so the original is restored after every test here.
const ORIGINAL_AUDIT_SINK = getAuditSink();
afterEach(() => { setAuditSink(ORIGINAL_AUDIT_SINK); });

const UUID = '11111111-1111-4111-8111-111111111111';
const INVITE_UUID = '44444444-4444-4444-8444-444444444444';

interface Recorder {
  store: MissionControlStore;
  reissues: Array<{ applicationLinkId: string; tokenDigest: string; expiresAt: string; actorId: string }>;
  audits: unknown[];
}

function recorder(status = 'ok'): Recorder {
  const rec: Recorder = { reissues: [], audits: [], store: null as never };
  rec.store = {
    listMappings: async () => [],
    listWorkflows: async () => [],
    setMappingStatus: async () => ({ status: 'ok' }),
    cancelApplication: async () => ({ status: 'ok' }),
    retryOperation: async () => ({ status: 'ok' }),
    upsertMapping: async () => ({ status: 'ok', id: UUID }),
    reissueManualInvite: async (input) => {
      rec.reissues.push(input);
      return status === 'ok'
        ? { status: 'ok', inviteId: INVITE_UUID, revokedInvites: 1 }
        : { status };
    },
  };
  return rec;
}

function appWith(role: string | null, store: MissionControlStore, audits?: unknown[]) {
  // Capture through the REAL audit sink the route writes to, so the token
  // sweep below is genuine rather than an assertion about an unused array.
  if (audits) setAuditSink((entry) => { audits.push(entry); });
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (role) (req as unknown as { authUser: unknown }).authUser = { id: UUID, appRole: role };
    next();
  });
  app.use('/mc', createAshbyMissionControlRouter({ store, probeReader: null }));
  return app;
}

describe('POST /workflows/:id/invite — an admin can actually deliver', () => {
  it('returns a usable candidate join link exactly once', async () => {
    const rec = recorder();
    const res = await request(appWith('admin', rec.store)).post(`/mc/workflows/${UUID}/invite`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.invite_id).toBe(INVITE_UUID);
    expect(res.body.ttl_hours).toBe(INVITE_TTL_HOURS);
    expect(INVITE_TTL_HOURS).toBe(24);

    // The link must carry the token in the FRAGMENT — never a query parameter,
    // because query strings reach servers, proxies, and access logs.
    const url = new URL(res.body.join_url);
    expect(url.pathname).toBe('/candidate/join');
    expect(url.search).toBe('');
    expect(url.hash).toMatch(/^#[a-f0-9]{64}$/);
  });

  it('sends ONLY the digest to the store — the plaintext never crosses that boundary', async () => {
    const rec = recorder();
    const res = await request(appWith('admin', rec.store)).post(`/mc/workflows/${UUID}/invite`);
    const token = new URL(res.body.join_url).hash.slice(1);

    expect(rec.reissues).toHaveLength(1);
    const sent = rec.reissues[0];
    expect(sent.tokenDigest).toBe(hashInviteToken(token));
    expect(sent.tokenDigest).not.toBe(token);
    expect(JSON.stringify(sent)).not.toContain(token);
    expect(sent.applicationLinkId).toBe(UUID);
    expect(sent.actorId).toBe(UUID);
  });

  it('sets an expiry exactly 24 hours out', async () => {
    const rec = recorder();
    const before = Date.now();
    const res = await request(appWith('admin', rec.store)).post(`/mc/workflows/${UUID}/invite`);
    const delta = Date.parse(res.body.expires_at) - before;
    const ttlMs = INVITE_TTL_HOURS * 60 * 60 * 1000;
    expect(delta).toBeGreaterThan(ttlMs - 60_000);
    expect(delta).toBeLessThanOrEqual(ttlMs + 60_000);
  });

  it('marks the response uncacheable so the one-time secret is not stored by a proxy', async () => {
    const rec = recorder();
    const res = await request(appWith('admin', rec.store)).post(`/mc/workflows/${UUID}/invite`);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.headers['cache-control']).toContain('private');
    expect(res.headers['pragma']).toBe('no-cache');
  });

  it('issues a DIFFERENT token on each call (revoke-then-issue, never a replay)', async () => {
    const rec = recorder();
    const app = appWith('admin', rec.store);
    const a = await request(app).post(`/mc/workflows/${UUID}/invite`);
    const b = await request(app).post(`/mc/workflows/${UUID}/invite`);
    const t1 = new URL(a.body.join_url).hash.slice(1);
    const t2 = new URL(b.body.join_url).hash.slice(1);
    expect(t1).not.toBe(t2);
    expect(rec.reissues[0].tokenDigest).not.toBe(rec.reissues[1].tokenDigest);
    // The store reports how many prior live invites it revoked.
    expect(a.body.revoked_invites).toBe(1);
  });
});

describe('POST /workflows/:id/invite — authorization fails closed', () => {
  it('rejects interviewer, viewer, candidate and unauthenticated callers', async () => {
    for (const role of ['interviewer', 'viewer', 'candidate', null]) {
      const rec = recorder();
      const res = await request(appWith(role, rec.store)).post(`/mc/workflows/${UUID}/invite`);
      expect(res.status, `role=${role}`).toBe(403);
      // No token was minted and the store was never reached.
      expect(rec.reissues, `role=${role}`).toHaveLength(0);
      expect(JSON.stringify(res.body)).not.toMatch(/[a-f0-9]{64}/);
    }
  });

  it('NEGATIVE CONTROL: an admin DOES succeed, so the rejections above are meaningful', async () => {
    const rec = recorder();
    const res = await request(appWith('admin', rec.store)).post(`/mc/workflows/${UUID}/invite`);
    expect(res.status).toBe(200);
    expect(rec.reissues).toHaveLength(1);
  });
});

describe('POST /workflows/:id/invite — refusals', () => {
  it('refuses a terminal application', async () => {
    const rec = recorder('blocked_terminal');
    const res = await request(appWith('admin', rec.store)).post(`/mc/workflows/${UUID}/invite`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('blocked_terminal');
    expect(res.body.join_url).toBeUndefined();
  });

  it('refuses when the screening session has not been materialized yet', async () => {
    const rec = recorder('not_ready');
    const res = await request(appWith('admin', rec.store)).post(`/mc/workflows/${UUID}/invite`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('not_ready');
    expect(res.body.join_url).toBeUndefined();
  });

  it('404s an unknown workflow', async () => {
    const rec = recorder('not_found');
    const res = await request(appWith('admin', rec.store)).post(`/mc/workflows/${UUID}/invite`);
    expect(res.status).toBe(404);
  });

  it('rejects a malformed workflow id before minting anything', async () => {
    const rec = recorder();
    const res = await request(appWith('admin', rec.store)).post('/mc/workflows/not-a-uuid/invite');
    expect(res.status).toBe(400);
    expect(rec.reissues).toHaveLength(0);
  });

  it('never leaks a token on the failure paths', async () => {
    for (const status of ['blocked_terminal', 'not_ready', 'not_found']) {
      const rec = recorder(status);
      const res = await request(appWith('admin', rec.store)).post(`/mc/workflows/${UUID}/invite`);
      expect(JSON.stringify(res.body)).not.toMatch(/[a-f0-9]{64}/);
    }
  });
});

describe('token containment across the whole delivery path', () => {
  it('the plaintext appears in the response body and nowhere else', async () => {
    const rec = recorder();
    const audits: unknown[] = [];
    const logged: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...a: unknown[]) => { logged.push(a.map(String).join(' ')); };
    console.error = (...a: unknown[]) => { logged.push(a.map(String).join(' ')); };
    let res;
    try {
      res = await request(appWith('admin', rec.store, audits)).post(`/mc/workflows/${UUID}/invite`);
    } finally {
      console.log = origLog;
      console.error = origErr;
    }

    const token = new URL(res!.body.join_url).hash.slice(1);
    expect(token).toMatch(/^[a-f0-9]{64}$/);

    // Not in anything handed to the store (which is what would reach the DB).
    expect(JSON.stringify(rec.reissues)).not.toContain(token);
    // Not in anything audited — and the sweep is non-vacuous: the route DID
    // write an audit row for this action.
    expect(audits.length).toBeGreaterThan(0);
    expect(JSON.stringify(audits)).not.toContain(token);
    expect(JSON.stringify(audits)).toContain('ashby_manual_invite');
    // Not in any log line emitted while handling the request.
    expect(logged.join('\n')).not.toContain(token);
    // Not in a response header (only the body).
    expect(JSON.stringify(res!.headers)).not.toContain(token);
  });
});
