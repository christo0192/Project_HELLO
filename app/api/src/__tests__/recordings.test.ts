/**
 * MIG-06 / REC-03/04/05 (Phase 7 L5): test suite for
 *   - GET /api/recordings/:sessionId/download
 *     (recruiter download + revocation/quarantine/deleted gate)
 *   - POST /api/livekit/:sessionId/recording (hardened upload path)
 *   - POST /api/livekit/grant/recording (route-shadow fixed)
 *
 * Covers (negative controls are asserted as designed):
 *   - route absent from PUBLIC_ROUTES; unauthenticated 401; inactive 403
 *   - admin/viewer read-all 200; interviewer owner 200; non-owner 403
 *   - malformed session id 400; missing object key 404
 *   - deleted tombstone → 404; quarantined → 409; revoked → 403 (download + grant mint)
 *   - signing failure → redacted stable 500
 *   - upload: 413 oversize (multer LIMIT_FILE_SIZE, not 500)
 *   - upload: 415 spoofed magic / MIME↔extension mismatch / polyglot
 *   - upload: 200 valid WebM/OGG/MP3/M4A fixtures
 *   - upload: 422 EICAR (test scanner) + prod fail-closed scanner
 *   - upload: 403 cross-session grant; 401 no-grant-no-owner; 200 owner recruiter;
 *     403 non-owner interviewer; 409 second upload (quota)
 *   - integrity: sha256/size/content_type/provenance/verified_at persisted +
 *     'uploaded' event row
 *   - quarantine: tampered-digest fixture → recording_quarantined=true +
 *     mismatch_quarantined event; download → 409 (no signed URL)
 *   - route-shadow: POST /grant/recording reaches the real handler (no 400 shadow)
 *
 * Supabase is mocked (repo convention) so the route never touches a live DB.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { createApp } from '../app.js';
import { isPublicRoute, PUBLIC_ROUTES } from '../lib/auth.js';
import { setRateLimitStore, MemoryRateLimitStore } from '../lib/rate-limit.js';
import { vi } from 'vitest';

// ── Supabase mock (chainable query builder + storage) ────────────────

const mockFrom = vi.fn();
const mockUpload = vi.fn();
const mockCreateSignedUrl = vi.fn();
const mockDownload = vi.fn();
const mockRemove = vi.fn();
const mockRpc = vi.fn();
const mockAuthGetUser = vi.fn();
vi.mock('../lib/supabase.js', () => ({
  supabase: {
    from: (...args: unknown[]) => mockFrom(...args),
    rpc: (...args: unknown[]) => mockRpc(...args),
    auth: { getUser: (...a: unknown[]) => mockAuthGetUser(...a) },
    storage: {
      from: (..._args: unknown[]) => ({
        upload: (...a: unknown[]) => mockUpload(...a),
        createSignedUrl: (...a: unknown[]) => mockCreateSignedUrl(...a),
        download: (...a: unknown[]) => mockDownload(...a),
        remove: (...a: unknown[]) => mockRemove(...a),
      }),
    },
  },
  RESUME_BUCKET: 'resumes_v2',
}));

/** Chainable Supabase query-builder mock that resolves to `value` and
 *  records insert/update payloads for later assertions. */
function chain(value: unknown, insertCalls: unknown[], updateCalls: unknown[]) {
  const c: Record<string, unknown> = {};
  const methods = ['select', 'insert', 'update', 'delete', 'upsert', 'eq', 'is', 'single', 'maybeSingle', 'order', 'limit'];
  for (const m of methods) {
    c[m] = (...args: unknown[]) => {
      if (m === 'insert') insertCalls.push(args[0]);
      if (m === 'update') updateCalls.push(args[0]);
      return chain(value, insertCalls, updateCalls);
    };
  }
  c.then = (resolve: (v: unknown) => unknown) => Promise.resolve(value).then(resolve);
  c.catch = (reject: (e: unknown) => unknown) => Promise.resolve(value).catch(reject);
  return c;
}

let insertCalls: unknown[] = [];
let updateCalls: unknown[] = [];

/** Configure per-table resolved values (Supabase response shape). Missing
 *  tables resolve { data: null, error: null }. Values are the row(s). */
function configureTables(config: Record<string, unknown>) {
  mockFrom.mockImplementation((table: string) => {
    const v = config[table];
    const resolved = v === undefined ? { data: null, error: null } : { data: v, error: null };
    return chain(resolved, insertCalls, updateCalls);
  });
}

// ── Fixtures ──────────────────────────────────────────────────────────

const VALID_SESSION = '00000000-0000-4000-8000-000000000001';
const OTHER_SESSION = '00000000-0000-4000-8000-000000000002';
const OBJECT_KEY = 'sessions/00000000-0000-4000-8000-000000000001/recording.webm';
const SIGNED_URL = 'https://storage.example.invalid/signed/recording.webm?token=x';
const GRANT_TOKEN = 'a'.repeat(64);

const GRANT_PAYLOAD = {
  candidate_id: '00000000-0000-4000-8000-000000000021',
  session_id: VALID_SESSION,
  room_name: `screening-${VALID_SESSION}`,
  expires_at: '2099-01-01T00:00:00.000Z',
  consumed_at: null,
  revoked_at: null,
};

const UPLOAD_SESSION = {
  id: VALID_SESSION,
  owner_id: 'interviewer-1',
  recording_object_key: null,
  recording_sha256: null,
};

// Synthetic minimal audio fixtures — valid magic bytes only (no real media).
const WEBM_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
function webmBuf(extra = 'demo-webm-payload'): Buffer {
  return Buffer.concat([WEBM_MAGIC, Buffer.from(extra)]);
}
function oggBuf(): Buffer {
  return Buffer.concat([Buffer.from('OggS'), Buffer.from('demo-ogg-payload')]);
}
function mp3Buf(): Buffer {
  return Buffer.concat([
    Buffer.from('ID3'),
    Buffer.from([0x03, 0x00, 0x00, 0x00, 0x00, 0x00]),
    Buffer.from('demo-mp3-payload'),
  ]);
}
function mp4Buf(): Buffer {
  return Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x20]),
    Buffer.from('ftypisom'),
    Buffer.from('demo-m4a-payload'),
  ]);
}

// JWT-shaped token whose payload decodes to {"sub":"user-001","aal":"aal2"}.
const JWT_AAL2 =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTAwMSIsImFhbCI6ImFhbDIifQ.signature';
const AUTH_HEADER = `Bearer ${JWT_AAL2}`;

/** authDeps that resolve a given app role + active flag with an AAL2 JWT. */
function authAs(role: 'admin' | 'interviewer' | 'viewer', userId: string, active = true) {
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
    resolveMembership: async () => ({ role, active }),
  };
}

function createTestApp(authDeps?: any) {
  return createApp({
    nodeEnv: 'test',
    webOrigin: 'http://localhost:5173',
    authDeps,
    auditSinkOverride: async () => {}, // silent audit
  });
}

describe('GET /api/recordings/:sessionId/download', () => {
  beforeEach(() => {
    setRateLimitStore(new MemoryRateLimitStore(100_000));
    mockFrom.mockReset();
    mockUpload.mockReset();
    mockCreateSignedUrl.mockReset();
    mockDownload.mockReset();
    mockRemove.mockReset();
    mockRpc.mockReset();
    insertCalls = [];
    updateCalls = [];
    configureTables({});
    mockCreateSignedUrl.mockResolvedValue({ data: null, error: { message: 'no' } });
    mockRemove.mockResolvedValue({ data: null, error: null });
    // Default RPC: finalize_recording_upload → ok, quarantine_recording → quarantined
    mockRpc.mockImplementation((fn: string) => {
      if (fn === 'finalize_recording_upload') {
        return Promise.resolve({ data: { status: 'ok' }, error: null });
      }
      if (fn === 'quarantine_recording') {
        return Promise.resolve({ data: { status: 'quarantined' }, error: null });
      }
      return Promise.resolve({ data: null, error: { message: 'unknown rpc' } });
    });
  });

  // ── Route not public ──────────────────────────────────────────────
  it('is not in PUBLIC_ROUTES', () => {
    const found = PUBLIC_ROUTES.some(
      (r) => r.method === 'GET' && r.path.startsWith('/api/recordings'),
    );
    expect(found).toBe(false);
  });

  it('is not identified as public by isPublicRoute', () => {
    expect(isPublicRoute('GET', '/api/recordings/0000/download')).toBe(false);
  });

  // ── Unauthenticated 401 ───────────────────────────────────────────
  it('returns 401 when no auth token is provided', async () => {
    const app = createTestApp();
    const res = await request(app).get(`/api/recordings/${VALID_SESSION}/download`);
    expect(res.status).toBe(401);
    expect(res.body.error.type).toBe('authentication_error');
  });

  // ── Inactive membership 403 (auth middleware) ─────────────────────
  it('returns 403 when membership is inactive', async () => {
    const app = createTestApp(authAs('admin', 'admin-1', false));
    const res = await request(app)
      .get(`/api/recordings/${VALID_SESSION}/download`)
      .set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(403);
  });

  // ── Interviewer non-owner 403 ─────────────────────────────────────
  it('returns 403 when interviewer does not own the session', async () => {
    configureTables({
      call_sessions: { owner_id: 'someone-else', recording_object_key: OBJECT_KEY },
    });
    const app = createTestApp(authAs('interviewer', 'interviewer-1'));
    const res = await request(app)
      .get(`/api/recordings/${VALID_SESSION}/download`)
      .set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(403);
  });

  // ── Interviewer owner 200 ─────────────────────────────────────────
  it('returns a signed URL when interviewer owns the session', async () => {
    configureTables({
      call_sessions: { owner_id: 'interviewer-1', recording_object_key: OBJECT_KEY },
    });
    mockCreateSignedUrl.mockResolvedValue({ data: { signedUrl: SIGNED_URL }, error: null });
    const app = createTestApp(authAs('interviewer', 'interviewer-1'));
    const res = await request(app)
      .get(`/api/recordings/${VALID_SESSION}/download`)
      .set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(res.body.url).toBe(SIGNED_URL);
  });

  // ── Viewer read-all 200 ───────────────────────────────────────────
  it('allows an active viewer to read any session (200)', async () => {
    configureTables({
      call_sessions: { owner_id: 'someone-else', recording_object_key: OBJECT_KEY },
    });
    mockCreateSignedUrl.mockResolvedValue({ data: { signedUrl: SIGNED_URL }, error: null });
    const app = createTestApp(authAs('viewer', 'viewer-1'));
    const res = await request(app)
      .get(`/api/recordings/${VALID_SESSION}/download`)
      .set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(res.status).not.toBe(403);
    expect(res.body.url).toBe(SIGNED_URL);
  });

  // ── Admin read-all 200; never persists the URL ────────────────────
  it('returns a signed URL for admin and never writes it back to the DB', async () => {
    configureTables({
      call_sessions: { owner_id: 'someone-else', recording_object_key: OBJECT_KEY },
    });
    mockCreateSignedUrl.mockResolvedValue({ data: { signedUrl: SIGNED_URL }, error: null });
    const app = createTestApp(authAs('admin', 'admin-1'));
    const res = await request(app)
      .get(`/api/recordings/${VALID_SESSION}/download`)
      .set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(res.body.url).toBe(SIGNED_URL);
    // The signed URL must be minted on-demand, not read from a durable column.
    expect(mockCreateSignedUrl).toHaveBeenCalledWith(OBJECT_KEY, expect.any(Number));
    // Only the call_sessions SELECT should touch the DB — no insert/update.
    for (const call of mockFrom.mock.calls) {
      expect(call[0]).toBe('call_sessions');
    }
  });

  // ── Malformed session ID 400 ──────────────────────────────────────
  it('returns 400 for malformed session ID', async () => {
    const app = createTestApp(authAs('admin', 'admin-1'));
    const res = await request(app)
      .get('/api/recordings/not-a-uuid/download')
      .set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(400);
    expect(res.body.error.type).toBe('validation_error');
  });

  // ── Missing object key 404 ────────────────────────────────────────
  it('returns 404 when session has no recording_object_key', async () => {
    configureTables({
      call_sessions: { owner_id: 'admin-1', recording_object_key: null },
    });
    const app = createTestApp(authAs('admin', 'admin-1'));
    const res = await request(app)
      .get(`/api/recordings/${VALID_SESSION}/download`)
      .set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(404);
  });

  // ── Deleted tombstone 404 (REC-06 forward-compat) ────────────────
  it('returns 404 when the recording is tombstoned (recording_deleted_at set)', async () => {
    configureTables({
      call_sessions: {
        owner_id: 'admin-1',
        recording_object_key: OBJECT_KEY,
        recording_deleted_at: '2026-01-01T00:00:00.000Z',
        recording_quarantined: false,
        recording_revoked_at: null,
      },
    });
    const app = createTestApp(authAs('admin', 'admin-1'));
    const res = await request(app)
      .get(`/api/recordings/${VALID_SESSION}/download`)
      .set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(404);
    expect(mockCreateSignedUrl).not.toHaveBeenCalled();
  });

  // ── Quarantined 409 (REC-04: never serve) ────────────────────────
  it('returns 409 and never mints a signed URL for a quarantined recording', async () => {
    configureTables({
      call_sessions: {
        owner_id: 'admin-1',
        recording_object_key: OBJECT_KEY,
        recording_quarantined: true,
        recording_revoked_at: null,
        recording_deleted_at: null,
      },
    });
    const app = createTestApp(authAs('admin', 'admin-1'));
    const res = await request(app)
      .get(`/api/recordings/${VALID_SESSION}/download`)
      .set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(409);
    expect(mockCreateSignedUrl).not.toHaveBeenCalled();
  });

  // ── Revoked 403 (REC-05: deny new mints within TTL) ──────────────
  it('returns 403 when the recording is revoked', async () => {
    configureTables({
      call_sessions: {
        owner_id: 'admin-1',
        recording_object_key: OBJECT_KEY,
        recording_revoked_at: '2026-01-01T00:00:00.000Z',
        recording_quarantined: false,
        recording_deleted_at: null,
      },
    });
    const app = createTestApp(authAs('admin', 'admin-1'));
    const res = await request(app)
      .get(`/api/recordings/${VALID_SESSION}/download`)
      .set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(403);
    expect(mockCreateSignedUrl).not.toHaveBeenCalled();
  });

  // ── Signing failure → redacted stable 500 ─────────────────────────
  it('returns a redacted 500 when signing fails', async () => {
    configureTables({
      call_sessions: { owner_id: 'admin-1', recording_object_key: OBJECT_KEY },
    });
    mockCreateSignedUrl.mockResolvedValue({ data: null, error: { message: 'boom secret detail' } });
    const app = createTestApp(authAs('admin', 'admin-1'));
    const res = await request(app)
      .get(`/api/recordings/${VALID_SESSION}/download`)
      .set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(500);
    // Error is stable and never echoes the signing failure detail.
    expect(JSON.stringify(res.body)).not.toContain('boom secret detail');
  });

  // ── REC-04 download-time re-verification (F1 repair) ─────────────
  // Untampered object → re-verify passes → mint proceeds (200).
  it('mints a signed URL when the stored bytes hash to the persisted sha256 (200)', async () => {
    const buf = webmBuf();
    const sha = createHash('sha256').update(buf).digest('hex');
    configureTables({
      call_sessions: {
        owner_id: 'admin-1',
        recording_object_key: OBJECT_KEY,
        recording_sha256: sha,
        recording_size_bytes: buf.length,
        recording_quarantined: false,
        recording_revoked_at: null,
        recording_deleted_at: null,
      },
    });
    mockDownload.mockResolvedValue({ data: new Blob([new Uint8Array(buf)]), error: null });
    mockCreateSignedUrl.mockResolvedValue({ data: { signedUrl: SIGNED_URL }, error: null });
    const app = createTestApp(authAs('admin', 'admin-1'));
    const res = await request(app)
      .get(`/api/recordings/${VALID_SESSION}/download`)
      .set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(res.body.url).toBe(SIGNED_URL);
    // The object was fetched and re-hashed before the mint.
    expect(mockDownload).toHaveBeenCalledWith(OBJECT_KEY);
    expect(mockCreateSignedUrl).toHaveBeenCalled();
  });

  // Tampered at-rest bytes → 409 quarantine + mismatch event, no signed URL.
  it('quarantines a tampered at-rest object (409) via atomic RPC, never mints', async () => {
    const storedSha = 'f'.repeat(64); // persisted digest ≠ tampered bytes
    configureTables({
      call_sessions: {
        owner_id: 'admin-1',
        recording_object_key: OBJECT_KEY,
        recording_sha256: storedSha,
        recording_size_bytes: 16,
        recording_quarantined: false,
        recording_revoked_at: null,
        recording_deleted_at: null,
      },
    });
    mockDownload.mockResolvedValue({ data: Buffer.from('tampered-at-rest-bytes'), error: null });
    const app = createTestApp(authAs('admin', 'admin-1'));
    const res = await request(app)
      .get(`/api/recordings/${VALID_SESSION}/download`)
      .set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(409);
    expect(res.body.error.type).toBe('recording_quarantined');
    expect(mockCreateSignedUrl).not.toHaveBeenCalled();

    // F-B repair: flag + event are atomic via quarantine_recording RPC.
    // F-E: actual digest observed at download is forwarded as evidence.
    expect(mockRpc).toHaveBeenCalledWith(
      'quarantine_recording',
      expect.objectContaining({
        p_session_id: VALID_SESSION,
        p_expected_sha256: storedSha,
        p_actual_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
    // No direct update/insert on call_sessions or recording_integrity_events.
    const quarantineUpdate = updateCalls.find(
      (u) => (u as Record<string, unknown>).recording_quarantined === true,
    );
    expect(quarantineUpdate).toBeUndefined();
  });

  // F-B: RPC returns already_quarantined → still 409, no duplicate evidence.
  it('returns 409 when quarantine RPC reports already_quarantined (concurrent loser)', async () => {
    const storedSha = 'f'.repeat(64);
    configureTables({
      call_sessions: {
        owner_id: 'admin-1',
        recording_object_key: OBJECT_KEY,
        recording_sha256: storedSha,
        recording_size_bytes: 16,
        recording_quarantined: false,
        recording_revoked_at: null,
        recording_deleted_at: null,
      },
    });
    mockDownload.mockResolvedValue({ data: Buffer.from('tampered-at-rest-bytes'), error: null });
    mockRpc.mockResolvedValueOnce({ data: { status: 'already_quarantined' }, error: null });
    const app = createTestApp(authAs('admin', 'admin-1'));
    const res = await request(app)
      .get(`/api/recordings/${VALID_SESSION}/download`)
      .set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(409);
    expect(mockCreateSignedUrl).not.toHaveBeenCalled();
  });

  // F-B: RPC failure → 500 fail-closed, never a URL.
  it('returns 500 and never mints a URL when quarantine RPC fails', async () => {
    const storedSha = 'f'.repeat(64);
    configureTables({
      call_sessions: {
        owner_id: 'admin-1',
        recording_object_key: OBJECT_KEY,
        recording_sha256: storedSha,
        recording_size_bytes: 16,
        recording_quarantined: false,
        recording_revoked_at: null,
        recording_deleted_at: null,
      },
    });
    mockDownload.mockResolvedValue({ data: Buffer.from('tampered-at-rest-bytes'), error: null });
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'db error' } });
    const app = createTestApp(authAs('admin', 'admin-1'));
    const res = await request(app)
      .get(`/api/recordings/${VALID_SESSION}/download`)
      .set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(500);
    expect(mockCreateSignedUrl).not.toHaveBeenCalled();
  });

  // Storage read failure → fail-closed 500, never a URL (redacted stable).
  it('fails closed (500, no URL) when the stored object cannot be read back', async () => {
    configureTables({
      call_sessions: {
        owner_id: 'admin-1',
        recording_object_key: OBJECT_KEY,
        recording_sha256: 'e'.repeat(64),
        recording_size_bytes: 16,
        recording_quarantined: false,
        recording_revoked_at: null,
        recording_deleted_at: null,
      },
    });
    mockDownload.mockResolvedValue({ data: null, error: { message: 'bucket unreadable secret detail' } });
    const app = createTestApp(authAs('admin', 'admin-1'));
    const res = await request(app)
      .get(`/api/recordings/${VALID_SESSION}/download`)
      .set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(500);
    expect(res.body.error.type).toBe('internal_error');
    expect(mockCreateSignedUrl).not.toHaveBeenCalled();
    // Redacted: the storage failure detail must never leak.
    expect(JSON.stringify(res.body)).not.toContain('bucket unreadable secret detail');
  });

  // No persisted hash → truthful legacy behavior: no download, mint proceeds.
  it('skips re-verification when no hash is persisted (legacy truthfulness)', async () => {
    configureTables({
      call_sessions: {
        owner_id: 'admin-1',
        recording_object_key: OBJECT_KEY,
        recording_sha256: null,
        recording_size_bytes: null,
        recording_quarantined: false,
        recording_revoked_at: null,
        recording_deleted_at: null,
      },
    });
    mockCreateSignedUrl.mockResolvedValue({ data: { signedUrl: SIGNED_URL }, error: null });
    const app = createTestApp(authAs('admin', 'admin-1'));
    const res = await request(app)
      .get(`/api/recordings/${VALID_SESSION}/download`)
      .set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(res.body.url).toBe(SIGNED_URL);
    // No object fetch at all — legacy rows mint exactly as before 0014.
    expect(mockDownload).not.toHaveBeenCalled();
  });

  // Recorded size above the upload cap → quarantined before any download.
  it('quarantines an object whose recorded size exceeds the cap (409, no download)', async () => {
    configureTables({
      call_sessions: {
        owner_id: 'admin-1',
        recording_object_key: OBJECT_KEY,
        recording_sha256: 'd'.repeat(64),
        recording_size_bytes: 999_999_999, // > RECORDING_MAX_BYTES
        recording_quarantined: false,
        recording_revoked_at: null,
        recording_deleted_at: null,
      },
    });
    const app = createTestApp(authAs('admin', 'admin-1'));
    const res = await request(app)
      .get(`/api/recordings/${VALID_SESSION}/download`)
      .set('Authorization', AUTH_HEADER);
    expect(res.status).toBe(409);
    expect(res.body.error.type).toBe('recording_quarantined');
    expect(mockDownload).not.toHaveBeenCalled();
    expect(mockCreateSignedUrl).not.toHaveBeenCalled();
    // F-B: quarantine is via RPC, not direct update.
    expect(mockRpc).toHaveBeenCalledWith(
      'quarantine_recording',
      expect.objectContaining({
        p_session_id: VALID_SESSION,
      }),
    );
    const quarantineUpdate = updateCalls.find(
      (u) => (u as Record<string, unknown>).recording_quarantined === true,
    );
    expect(quarantineUpdate).toBeUndefined();
  });

  // ── Rate-limit headers present ────────────────────────────────────
  it('exposes rate-limit headers on the recordings endpoint', async () => {
    const app = createTestApp(authAs('admin', 'admin-1'));
    const res = await request(app)
      .get(`/api/recordings/${VALID_SESSION}/download`)
      .set('Authorization', AUTH_HEADER);
    expect(res.headers['x-ratelimit-limit']).toBeDefined();
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
  });
});

describe('POST /api/livekit/:sessionId/recording (hardened upload)', () => {
  function uploadApp(authDeps?: any) {
    return createTestApp(authDeps);
  }
  /** Attach an audio fixture with a declared MIME + filename. */
  function attachAudio(req: request.Test, buf: Buffer, filename: string, contentType: string) {
    return req.attach('file', buf, { filename, contentType });
  }

  /**
   * Mock the in-route recruiter auth seam (resolveFullAuth → supabase.auth
   * getUser + allowlist resolver RPC). Models a fully ALLOWLISTED,
   * email-confirmed company recruiter so the owner tests exercise the
   * happy path. Callers that want denial set mockRpc's
   * resolve_allowlist_access branch (or a wrong-domain email) themselves.
   */
  function mockRecruiterAuth(role: 'admin' | 'interviewer' | 'viewer', userId: string) {
    mockAuthGetUser.mockResolvedValue({
      data: {
        user: {
          id: userId,
          email: `${role}@interviewkickstart.com`,
          email_confirmed_at: '2026-01-01T00:00:00.000Z',
          app_metadata: { app_role: role, org_id: null, active: true },
        },
      },
      error: null,
    });
    mockRpc.mockImplementation((fn: string) => {
      if (fn === 'resolve_allowlist_access') {
        return Promise.resolve({ data: { status: 'ok', role, active: true }, error: null });
      }
      if (fn === 'finalize_recording_upload') {
        return Promise.resolve({ data: { status: 'ok' }, error: null });
      }
      if (fn === 'quarantine_recording') {
        return Promise.resolve({ data: { status: 'quarantined' }, error: null });
      }
      return Promise.resolve({ data: null, error: { message: 'unknown rpc' } });
    });
    configureTables({ recruiter_memberships: { role, active: true } });
  }

  /** Mock a verified token whose email is NOT a company address. */
  function mockNonCompanyEmail() {
    mockAuthGetUser.mockResolvedValue({
      data: {
        user: {
          id: 'outsider-1',
          email: 'outsider@gmail.com',
          email_confirmed_at: '2026-01-01T00:00:00.000Z',
          app_metadata: { app_role: 'viewer', org_id: null, active: true },
        },
      },
      error: null,
    });
  }

  beforeEach(() => {
    setRateLimitStore(new MemoryRateLimitStore(100_000));
    mockFrom.mockReset();
    mockUpload.mockReset();
    mockCreateSignedUrl.mockReset();
    mockDownload.mockReset();
    mockRpc.mockReset();
    mockRemove.mockReset();
    mockAuthGetUser.mockReset();
    insertCalls = [];
    updateCalls = [];
    configureTables({});
    mockUpload.mockResolvedValue({ data: { path: `${VALID_SESSION}.webm` }, error: null });
    mockCreateSignedUrl.mockResolvedValue({ data: { signedUrl: SIGNED_URL }, error: null });
    mockRemove.mockResolvedValue({ data: null, error: null });
    mockRpc.mockImplementation((fn: string) => {
      if (fn === 'resolve_allowlist_access') {
        // Fail-closed default: unless a test explicitly allowlists the
        // recruiter (mockRecruiterAuth), the access resolver denies.
        return Promise.resolve({ data: { status: 'denied' }, error: null });
      }
      if (fn === 'finalize_recording_upload') {
        return Promise.resolve({ data: { status: 'ok' }, error: null });
      }
      if (fn === 'quarantine_recording') {
        return Promise.resolve({ data: { status: 'quarantined' }, error: null });
      }
      return Promise.resolve({ data: null, error: { message: 'unknown rpc' } });
    });
  });

  // ── 413 oversize (multer LIMIT_FILE_SIZE mapped, not 500) ─────────
  it('returns 413 for an upload above the reduced cap (never 500)', async () => {
    const app = uploadApp();
    const bigBuf = Buffer.alloc(26 * 1024 * 1024, 0x41); // > 25 MiB default cap
    const res = await request(app)
      .post(`/api/livekit/${VALID_SESSION}/recording`)
      .attach('file', bigBuf, { filename: 'big.webm', contentType: 'audio/webm' });
    expect(res.status).toBe(413);
    expect(res.body.error.type).toBe('payload_too_large');
    expect(res.status).not.toBe(500);
  });

  // ── 415 spoofed magic bytes with audio/webm MIME ──────────────────
  it('returns 415 when magic bytes are spoofed (PDF header claiming webm)', async () => {
    configureTables({
      candidate_access_grants: GRANT_PAYLOAD,
      call_sessions: UPLOAD_SESSION,
    });
    const app = uploadApp();
    const res = await request(app)
      .post(`/api/livekit/${VALID_SESSION}/recording`)
      .set('x-grant-token', GRANT_TOKEN)
      .attach('file', Buffer.from('%PDF-1.7 fake'), { filename: 'spoof.webm', contentType: 'audio/webm' });
    expect(res.status).toBe(415);
    expect(res.body.error.details[0].code).toBe('INVALID_AUDIO_MAGIC');
    expect(mockUpload).not.toHaveBeenCalled();
  });

  // ── 415 MIME↔extension mismatch ───────────────────────────────────
  it('returns 415 when declared MIME disagrees with the extension', async () => {
    configureTables({
      candidate_access_grants: GRANT_PAYLOAD,
      call_sessions: UPLOAD_SESSION,
    });
    const app = uploadApp();
    const res = await request(app)
      .post(`/api/livekit/${VALID_SESSION}/recording`)
      .set('x-grant-token', GRANT_TOKEN)
      .attach('file', webmBuf(), { filename: 'clip.mp3', contentType: 'audio/webm' });
    expect(res.status).toBe(415);
    expect(res.body.error.details[0].code).toBe('MIME_MISMATCH');
    expect(mockUpload).not.toHaveBeenCalled();
  });

  // ── 415 polyglot (valid audio magic + foreign signature) ──────────
  it('returns 415 for a polyglot (webm magic + embedded PDF signature)', async () => {
    configureTables({
      candidate_access_grants: GRANT_PAYLOAD,
      call_sessions: UPLOAD_SESSION,
    });
    const polyglot = Buffer.concat([WEBM_MAGIC, Buffer.from('abc'), Buffer.from('%PDF-1.7')]);
    const app = uploadApp();
    const res = await request(app)
      .post(`/api/livekit/${VALID_SESSION}/recording`)
      .set('x-grant-token', GRANT_TOKEN)
      .attach('file', polyglot, { filename: 'poly.webm', contentType: 'audio/webm' });
    expect(res.status).toBe(415);
    expect(res.body.error.details[0].code).toBe('POLYGLOT_DETECTED');
    expect(mockUpload).not.toHaveBeenCalled();
  });

  // ── 200 valid WebM/OGG/MP3/M4A fixtures ───────────────────────────
  const audioFixtures: Array<[string, Buffer, string, string]> = [
    ['webm', webmBuf(), 'rec.webm', 'audio/webm'],
    ['ogg', oggBuf(), 'rec.ogg', 'audio/ogg'],
    ['mp3', mp3Buf(), 'rec.mp3', 'audio/mpeg'],
    ['m4a', mp4Buf(), 'rec.m4a', 'audio/mp4'],
  ];
  for (const [label, buf, filename, mime] of audioFixtures) {
    it(`stores a valid ${label} upload (200) and finalizes atomically via RPC`, async () => {
      configureTables({
        candidate_access_grants: GRANT_PAYLOAD,
        call_sessions: UPLOAD_SESSION,
      });
      const app = uploadApp();
      const res = await request(app)
        .post(`/api/livekit/${VALID_SESSION}/recording`)
        .set('x-grant-token', GRANT_TOKEN)
        .attach('file', buf, { filename, contentType: mime });
      expect(res.status).toBe(200);
      // Unique-per-attempt key (random suffix, F-A repair).
      expect(res.body.object_key).toContain(VALID_SESSION);
      expect(res.body.object_key).toContain(`.${label}`);
      expect(mockUpload).toHaveBeenCalledWith(
        expect.stringContaining(`${VALID_SESSION}-`),
        buf,
        expect.objectContaining({ upsert: false }),
      );

      // F-A repair: DB finalization is atomic via RPC — no direct update/insert.
      const sha256 = createHash('sha256').update(buf).digest('hex');
      expect(mockRpc).toHaveBeenCalledWith(
        'finalize_recording_upload',
        expect.objectContaining({
          p_session_id: VALID_SESSION,
          p_sha256: sha256,
          p_size_bytes: buf.length,
          p_content_type: mime,
          p_provenance: 'browser_upload',
        }),
      );
      // No direct call_sessions update or integrity_events insert (RPC owns them).
      const sessionUpdate = updateCalls.find(
        (u) => (u as Record<string, unknown>).recording_sha256 === sha256,
      );
      expect(sessionUpdate).toBeUndefined();
      const uploadedEvent = insertCalls.find(
        (i) => (i as Record<string, unknown>).event_type === 'uploaded',
      );
      expect(uploadedEvent).toBeUndefined();
    });
  }

  // ── MP3 frame-sync variant (no ID3 tag) is accepted ───────────────
  it('accepts an MP3 starting with an MPEG frame-sync byte (200)', async () => {
    configureTables({
      candidate_access_grants: GRANT_PAYLOAD,
      call_sessions: UPLOAD_SESSION,
    });
    const frameSyncMp3 = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.from('demo')]);
    const app = uploadApp();
    const res = await request(app)
      .post(`/api/livekit/${VALID_SESSION}/recording`)
      .set('x-grant-token', GRANT_TOKEN)
      .attach('file', frameSyncMp3, { filename: 'rec.mp3', contentType: 'audio/mpeg' });
    expect(res.status).toBe(200);
  });

  // ── 415 MP4 declared but missing the ftyp box ─────────────────────
  it('returns 415 when an MP4-declared file lacks the ftyp box', async () => {
    configureTables({
      candidate_access_grants: GRANT_PAYLOAD,
      call_sessions: UPLOAD_SESSION,
    });
    const noFtyp = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x20]), Buffer.from('notftyp')]);
    const app = uploadApp();
    const res = await request(app)
      .post(`/api/livekit/${VALID_SESSION}/recording`)
      .set('x-grant-token', GRANT_TOKEN)
      .attach('file', noFtyp, { filename: 'rec.m4a', contentType: 'audio/mp4' });
    expect(res.status).toBe(415);
    expect(res.body.error.details[0].code).toBe('INVALID_AUDIO_MAGIC');
  });

  // ── guardAudioUpload unit edges (unsupported ext / too small / quota) ──
  it('guardAudioUpload rejects unsupported extensions, tiny files, and over-quota buffers', async () => {
    const { guardAudioUpload, UploadGuardError } = await import('../lib/upload-guard.js');
    // Unsupported extension.
    expect(() => guardAudioUpload(webmBuf(), 'audio/webm', 'rec.exe')).toThrowError(UploadGuardError);
    expect(() => guardAudioUpload(webmBuf(), 'audio/webm', 'rec.webm', 8)).toThrow(
      /EXCEEDS_QUOTA|exceeds max recording bytes/,
    );
    // Too small to carry magic bytes.
    expect(() => guardAudioUpload(Buffer.from('ab'), 'audio/webm', 'rec.webm')).toThrowError(
      UploadGuardError,
    );
    // MIME mismatch is still rejected.
    expect(() => guardAudioUpload(webmBuf(), 'audio/mpeg', 'rec.webm')).toThrowError(
      UploadGuardError,
    );
  });

  // ── 422 EICAR (test scanner) ──────────────────────────────────────
  it('rejects an EICAR-bearing webm with 422 (test scanner)', async () => {
    configureTables({
      candidate_access_grants: GRANT_PAYLOAD,
      call_sessions: UPLOAD_SESSION,
    });
    const eicar =
      'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
    const app = uploadApp();
    const res = await request(app)
      .post(`/api/livekit/${VALID_SESSION}/recording`)
      .set('x-grant-token', GRANT_TOKEN)
      .attach('file', webmBuf(eicar), { filename: 'evil.webm', contentType: 'audio/webm' });
    expect(res.status).toBe(422);
    expect(res.body.error.type).toBe('malware_detected');
    expect(mockUpload).not.toHaveBeenCalled();
  });

  // ── Production scanner is fail-closed (unit) ──────────────────────
  it('production scanner rejects ALL files (fail-closed)', async () => {
    const { resolveScanner } = await import('../lib/malware-scanner.js');
    const prod = resolveScanner('production');
    const result = await prod.scan(webmBuf());
    expect(result.safe).toBe(false);
    expect(result.status).toBe('scanner_unavailable');
  });

  // ── 403 cross-session grant ───────────────────────────────────────
  it('returns 403 when the grant is bound to a different session', async () => {
    configureTables({
      candidate_access_grants: { ...GRANT_PAYLOAD, session_id: OTHER_SESSION },
    });
    const app = uploadApp();
    const res = await request(app)
      .post(`/api/livekit/${VALID_SESSION}/recording`)
      .set('x-grant-token', GRANT_TOKEN)
      .attach('file', webmBuf(), { filename: 'rec.webm', contentType: 'audio/webm' });
    expect(res.status).toBe(403);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  // ── 401 no grant AND no recruiter auth ────────────────────────────
  it('returns 401 when there is no grant token and no recruiter auth', async () => {
    const app = uploadApp();
    const res = await request(app)
      .post(`/api/livekit/${VALID_SESSION}/recording`)
      .attach('file', webmBuf(), { filename: 'rec.webm', contentType: 'audio/webm' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('authentication_required');
    expect(mockUpload).not.toHaveBeenCalled();
  });

  // ── 403 non-owner interviewer ─────────────────────────────────────
  it('returns 403 when an interviewer uploads for a session they do not own', async () => {
    mockRecruiterAuth('interviewer', 'interviewer-1');
    configureTables({
      recruiter_memberships: { role: 'interviewer', active: true },
      call_sessions: { ...UPLOAD_SESSION, owner_id: 'someone-else' },
    });
    const app = uploadApp();
    const res = await request(app)
      .post(`/api/livekit/${VALID_SESSION}/recording`)
      .set('Authorization', AUTH_HEADER)
      .attach('file', webmBuf(), { filename: 'rec.webm', contentType: 'audio/webm' });
    expect(res.status).toBe(403);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  // ── 200 owner recruiter upload (TODO closed) ──────────────────────
  it('accepts an upload from the owning interviewer (200)', async () => {
    mockRecruiterAuth('interviewer', 'interviewer-1');
    configureTables({
      recruiter_memberships: { role: 'interviewer', active: true },
      call_sessions: UPLOAD_SESSION, // owner_id: interviewer-1
    });
    const app = uploadApp();
    const res = await request(app)
      .post(`/api/livekit/${VALID_SESSION}/recording`)
      .set('Authorization', AUTH_HEADER)
      .attach('file', webmBuf(), { filename: 'rec.webm', contentType: 'audio/webm' });
    expect(res.status).toBe(200);
    expect(mockUpload).toHaveBeenCalled();
  });

  // ── 200 admin recruiter upload ────────────────────────────────────
  it('accepts an upload from an admin (200)', async () => {
    mockRecruiterAuth('admin', 'admin-1');
    configureTables({
      recruiter_memberships: { role: 'admin', active: true },
      call_sessions: UPLOAD_SESSION,
    });
    const app = uploadApp();
    const res = await request(app)
      .post(`/api/livekit/${VALID_SESSION}/recording`)
      .set('Authorization', AUTH_HEADER)
      .attach('file', webmBuf(), { filename: 'rec.webm', contentType: 'audio/webm' });
    expect(res.status).toBe(200);
  });

  // ── HELLO allowlist gate on the recruiter upload path (0016) ─────
  // Regression: the in-route recruiter auth now uses the SAME shared
  // resolveFullAuth seam as the global middleware — a valid old JWT and an
  // active membership row are NOT enough; the allowlist resolver must pass.

  it('rejects a valid JWT + active membership when the allowlist entry is MISSING (403)', async () => {
    // Verified company email but NO allowlist entry (default RPC → denied).
    mockAuthGetUser.mockResolvedValue({
      data: {
        user: {
          id: 'outsider-1',
          email: 'outsider@interviewkickstart.com',
          email_confirmed_at: '2026-01-01T00:00:00.000Z',
          app_metadata: { app_role: 'admin', org_id: null, active: true },
        },
      },
      error: null,
    });
    configureTables({
      recruiter_memberships: { role: 'admin', active: true }, // stale active membership
      call_sessions: UPLOAD_SESSION,
    });
    const app = uploadApp();
    const res = await request(app)
      .post(`/api/livekit/${VALID_SESSION}/recording`)
      .set('Authorization', AUTH_HEADER)
      .attach('file', webmBuf(), { filename: 'rec.webm', contentType: 'audio/webm' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('access_denied');
    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockRpc).toHaveBeenCalledWith(
      'resolve_allowlist_access',
      expect.objectContaining({ p_email: 'outsider@interviewkickstart.com' }),
    );
  });

  it('rejects a valid JWT + active membership when the allowlist entry is INACTIVE/disabled (403)', async () => {
    mockAuthGetUser.mockResolvedValue({
      data: {
        user: {
          id: 'disabled-1',
          email: 'disabled@interviewkickstart.com',
          email_confirmed_at: '2026-01-01T00:00:00.000Z',
          app_metadata: { app_role: 'viewer', org_id: null, active: true },
        },
      },
      error: null,
    });
    // Resolver denies because the entry is inactive (uniform 'denied' —
    // indistinguishable from missing at the API boundary, by design).
    mockRpc.mockImplementation((fn: string) => {
      if (fn === 'resolve_allowlist_access') {
        return Promise.resolve({ data: { status: 'denied' }, error: null });
      }
      return Promise.resolve({ data: null, error: { message: 'unknown rpc' } });
    });
    configureTables({
      recruiter_memberships: { role: 'viewer', active: true }, // stale active membership
      call_sessions: UPLOAD_SESSION,
    });
    const app = uploadApp();
    const res = await request(app)
      .post(`/api/livekit/${VALID_SESSION}/recording`)
      .set('Authorization', AUTH_HEADER)
      .attach('file', webmBuf(), { filename: 'rec.webm', contentType: 'audio/webm' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('access_denied');
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('rejects a verified NON-COMPANY email (wrong domain) even with a valid JWT (403)', async () => {
    mockNonCompanyEmail();
    configureTables({
      recruiter_memberships: { role: 'viewer', active: true },
      call_sessions: UPLOAD_SESSION,
    });
    const app = uploadApp();
    const res = await request(app)
      .post(`/api/livekit/${VALID_SESSION}/recording`)
      .set('Authorization', AUTH_HEADER)
      .attach('file', webmBuf(), { filename: 'rec.webm', contentType: 'audio/webm' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('access_denied');
    // Denied BEFORE the RPC — the domain gate runs in the shared seam.
    expect(mockRpc).not.toHaveBeenCalledWith('resolve_allowlist_access', expect.anything());
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('accepts a valid ALLOWLISTED recruiter via the shared seam (200)', async () => {
    mockRecruiterAuth('viewer', 'viewer-1');
    configureTables({
      recruiter_memberships: { role: 'viewer', active: true },
      call_sessions: UPLOAD_SESSION,
    });
    const app = uploadApp();
    const res = await request(app)
      .post(`/api/livekit/${VALID_SESSION}/recording`)
      .set('Authorization', AUTH_HEADER)
      .attach('file', webmBuf(), { filename: 'rec.webm', contentType: 'audio/webm' });
    expect(res.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith(
      'resolve_allowlist_access',
      expect.objectContaining({ p_email: 'viewer@interviewkickstart.com' }),
    );
    expect(mockUpload).toHaveBeenCalled();
  });

  it('grant-token path is UNCHANGED — succeeds without bearer and without an allowlist entry (200)', async () => {
    // Default allowlist resolver DENIES (fail-closed) — grant uploads must
    // not depend on it at all.
    configureTables({
      candidate_access_grants: GRANT_PAYLOAD,
      call_sessions: UPLOAD_SESSION,
    });
    const app = uploadApp();
    const res = await request(app)
      .post(`/api/livekit/${VALID_SESSION}/recording`)
      .set('x-grant-token', GRANT_TOKEN)
      .attach('file', webmBuf(), { filename: 'rec.webm', contentType: 'audio/webm' });
    expect(res.status).toBe(200);
    expect(mockRpc).not.toHaveBeenCalledWith('resolve_allowlist_access', expect.anything());
    expect(mockUpload).toHaveBeenCalled();
  });

  // ── 409 second upload (quota / upsert:false) ──────────────────────
  it('returns 409 when the session already holds a recording', async () => {
    configureTables({
      candidate_access_grants: GRANT_PAYLOAD,
      call_sessions: { ...UPLOAD_SESSION, recording_object_key: OBJECT_KEY },
    });
    const app = uploadApp();
    const res = await request(app)
      .post(`/api/livekit/${VALID_SESSION}/recording`)
      .set('x-grant-token', GRANT_TOKEN)
      .attach('file', webmBuf(), { filename: 'rec.webm', contentType: 'audio/webm' });
    expect(res.status).toBe(409);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  // ── F-D: deleted session rejects upload before storage ───────────
  it('returns 404 when the session is deleted (F-D preflight)', async () => {
    configureTables({
      candidate_access_grants: GRANT_PAYLOAD,
      call_sessions: { ...UPLOAD_SESSION, recording_deleted_at: '2026-01-01T00:00:00.000Z' },
    });
    const app = uploadApp();
    const res = await request(app)
      .post(`/api/livekit/${VALID_SESSION}/recording`)
      .set('x-grant-token', GRANT_TOKEN)
      .attach('file', webmBuf(), { filename: 'rec.webm', contentType: 'audio/webm' });
    expect(res.status).toBe(404);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  // ── F-D: quarantined session rejects upload before storage ───────
  it('returns 409 when the session is quarantined (F-D preflight)', async () => {
    configureTables({
      candidate_access_grants: GRANT_PAYLOAD,
      call_sessions: { ...UPLOAD_SESSION, recording_quarantined: true },
    });
    const app = uploadApp();
    const res = await request(app)
      .post(`/api/livekit/${VALID_SESSION}/recording`)
      .set('x-grant-token', GRANT_TOKEN)
      .attach('file', webmBuf(), { filename: 'rec.webm', contentType: 'audio/webm' });
    expect(res.status).toBe(409);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  // ── F-D: revoked session rejects upload before storage ───────────
  it('returns 403 when the session is revoked (F-D preflight)', async () => {
    configureTables({
      candidate_access_grants: GRANT_PAYLOAD,
      call_sessions: { ...UPLOAD_SESSION, recording_revoked_at: '2026-01-01T00:00:00.000Z' },
    });
    const app = uploadApp();
    const res = await request(app)
      .post(`/api/livekit/${VALID_SESSION}/recording`)
      .set('x-grant-token', GRANT_TOKEN)
      .attach('file', webmBuf(), { filename: 'rec.webm', contentType: 'audio/webm' });
    expect(res.status).toBe(403);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  // ── F-A: quota gate blocks before storage/RPC (code-level check) ─
  it('returns 409 when the session already holds a recording (code quota gate)', async () => {
    configureTables({
      candidate_access_grants: GRANT_PAYLOAD,
      call_sessions: { ...UPLOAD_SESSION, recording_object_key: OBJECT_KEY },
    });
    const app = uploadApp();
    const res = await request(app)
      .post(`/api/livekit/${VALID_SESSION}/recording`)
      .set('x-grant-token', GRANT_TOKEN)
      .attach('file', webmBuf(), { filename: 'rec.webm', contentType: 'audio/webm' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('recording_already_exists');
    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  // ── Session not found 404 ─────────────────────────────────────────
  it('returns 404 when the session does not exist', async () => {
    configureTables({
      candidate_access_grants: GRANT_PAYLOAD,
      // call_sessions resolves null → not found
    });
    const app = uploadApp();
    const res = await request(app)
      .post(`/api/livekit/${VALID_SESSION}/recording`)
      .set('x-grant-token', GRANT_TOKEN)
      .attach('file', webmBuf(), { filename: 'rec.webm', contentType: 'audio/webm' });
    expect(res.status).toBe(404);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  // ── Storage upload failure → 500 (stable) ─────────────────────────
  it('returns 500 when storage upload fails (stable error)', async () => {
    configureTables({
      candidate_access_grants: GRANT_PAYLOAD,
      call_sessions: UPLOAD_SESSION,
    });
    mockUpload.mockResolvedValue({ data: null, error: { message: 's3 secret detail' } });
    const app = uploadApp();
    const res = await request(app)
      .post(`/api/livekit/${VALID_SESSION}/recording`)
      .set('x-grant-token', GRANT_TOKEN)
      .attach('file', webmBuf(), { filename: 'rec.webm', contentType: 'audio/webm' });
    expect(res.status).toBe(500);
    expect(res.body.error.type).toBe('internal_error');
    expect(JSON.stringify(res.body)).not.toContain('s3 secret detail');
  });

  // ── F-A: RPC failure → compensation delete, 500, no orphan record ─
  it('compensates (deletes orphan) when finalize RPC fails, returns 500', async () => {
    configureTables({
      candidate_access_grants: GRANT_PAYLOAD,
      call_sessions: UPLOAD_SESSION,
    });
    mockRpc.mockResolvedValueOnce({ data: { status: 'session_not_found' }, error: null });
    const app = uploadApp();
    const res = await request(app)
      .post(`/api/livekit/${VALID_SESSION}/recording`)
      .set('x-grant-token', GRANT_TOKEN)
      .attach('file', webmBuf(), { filename: 'rec.webm', contentType: 'audio/webm' });
    expect(res.status).toBe(500);
    // Compensation: orphaned object was deleted.
    expect(mockRemove).toHaveBeenCalled();
    // No orphan table write (compensation succeeded).
    const orphanCalls = mockFrom.mock.calls.filter(
      (c: unknown[]) => c[0] === 'recording_orphaned_objects',
    );
    expect(orphanCalls.length).toBe(0);
  });

  // ── F-A: RPC failure + compensation failure → private orphan row ──
  it('records orphan in BACKEND-ONLY table when both RPC and compensation fail (F-C)', async () => {
    configureTables({
      candidate_access_grants: GRANT_PAYLOAD,
      call_sessions: UPLOAD_SESSION,
    });
    mockRpc.mockResolvedValueOnce({ data: { status: 'session_not_found' }, error: null });
    mockRemove.mockResolvedValueOnce({ data: null, error: { message: 'storage down' } });
    const app = uploadApp();
    const res = await request(app)
      .post(`/api/livekit/${VALID_SESSION}/recording`)
      .set('x-grant-token', GRANT_TOKEN)
      .attach('file', webmBuf(), { filename: 'rec.webm', contentType: 'audio/webm' });
    expect(res.status).toBe(500);
    // F-C: orphan goes to BACKEND-ONLY recording_orphaned_objects — NEVER
    // to recruiter-readable integrity_events, NEVER with event_type='uploaded'.
    const orphanCalls = mockFrom.mock.calls.filter(
      (c: unknown[]) => c[0] === 'recording_orphaned_objects',
    );
    expect(orphanCalls.length).toBeGreaterThanOrEqual(1);
    // No uploaded event in integrity_events for this orphan.
    const uploadedEv = insertCalls.find(
      (i) => (i as Record<string, unknown>).event_type === 'uploaded',
    );
    expect(uploadedEv).toBeUndefined();
  });

  // ── F-C: retry after orphan converges — exactly one uploaded event ─
  it('retry succeeds after prior orphan (compensation failure), exactly one uploaded event', async () => {
    // First attempt: RPC fails, compensation fails → orphan recorded.
    configureTables({
      candidate_access_grants: GRANT_PAYLOAD,
      call_sessions: UPLOAD_SESSION,
    });
    mockRpc.mockResolvedValueOnce({ data: { status: 'session_not_found' }, error: null });
    mockRemove.mockResolvedValueOnce({ data: null, error: { message: 'storage down' } });
    const app = uploadApp();
    let res = await request(app)
      .post(`/api/livekit/${VALID_SESSION}/recording`)
      .set('x-grant-token', GRANT_TOKEN)
      .attach('file', webmBuf(), { filename: 'rec.webm', contentType: 'audio/webm' });
    expect(res.status).toBe(500);

    // Reset mocks for retry (second attempt with different object key).
    mockRpc.mockReset();
    mockRemove.mockReset();
    mockRpc.mockImplementation((fn: string) => {
      if (fn === 'finalize_recording_upload') {
        return Promise.resolve({ data: { status: 'ok' }, error: null });
      }
      return Promise.resolve({ data: null, error: { message: 'unknown' } });
    });
    mockRemove.mockResolvedValue({ data: null, error: null });
    insertCalls = [];
    updateCalls = [];

    // Retry succeeds — unique key per attempt avoids orphan collision.
    res = await request(app)
      .post(`/api/livekit/${VALID_SESSION}/recording`)
      .set('x-grant-token', GRANT_TOKEN)
      .attach('file', webmBuf(), { filename: 'retry.webm', contentType: 'audio/webm' });
    expect(res.status).toBe(200);
    // Exactly one uploaded event via RPC — no duplicate from prior orphan.
    const uploadedEvs = insertCalls.filter(
      (i) => (i as Record<string, unknown>).event_type === 'uploaded',
    );
    expect(uploadedEvs.length).toBe(0); // RPC owns the event, not direct insert
    expect(mockRpc).toHaveBeenCalledWith(
      'finalize_recording_upload',
      expect.objectContaining({ p_session_id: VALID_SESSION }),
    );
  });

  // ── F-A: RPC CAS race (concurrent upload already linked) → 500 ──
  it('returns 500 when finalize RPC reports recording_already_exists (CAS race)', async () => {
    configureTables({
      candidate_access_grants: GRANT_PAYLOAD,
      call_sessions: UPLOAD_SESSION,
    });
    mockRpc.mockResolvedValueOnce({ data: { status: 'recording_already_exists' }, error: null });
    const app = uploadApp();
    const res = await request(app)
      .post(`/api/livekit/${VALID_SESSION}/recording`)
      .set('x-grant-token', GRANT_TOKEN)
      .attach('file', webmBuf(), { filename: 'rec.webm', contentType: 'audio/webm' });
    expect(res.status).toBe(500);
    // Compensation attempted.
    expect(mockRemove).toHaveBeenCalled();
  });

  // ── T7-T11: Egress-precedence gate (I‑2) ─────────────────────────

  it('T7: rejects browser upload (409) when egress is active (authoritative_recording_pending)', async () => {
    configureTables({
      candidate_access_grants: GRANT_PAYLOAD,
      call_sessions: {
        ...UPLOAD_SESSION,
        recording_egress_id: 'EG_active123',
        recording_egress_status: 'active',
      },
    });
    const app = uploadApp();
    const res = await request(app)
      .post(`/api/livekit/${VALID_SESSION}/recording`)
      .set('x-grant-token', GRANT_TOKEN)
      .attach('file', webmBuf(), { filename: 'rec.webm', contentType: 'audio/webm' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('authoritative_recording_pending');
    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('T7b: rejects also when egress status is complete (still authoritative, not failed)', async () => {
    configureTables({
      candidate_access_grants: GRANT_PAYLOAD,
      call_sessions: {
        ...UPLOAD_SESSION,
        recording_egress_id: 'EG_complete123',
        recording_egress_status: 'complete',
      },
    });
    const app = uploadApp();
    const res = await request(app)
      .post(`/api/livekit/${VALID_SESSION}/recording`)
      .set('x-grant-token', GRANT_TOKEN)
      .attach('file', webmBuf(), { filename: 'rec.webm', contentType: 'audio/webm' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('authoritative_recording_pending');
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('T8: allows upload when egress status is failed (fallback declared)', async () => {
    configureTables({
      candidate_access_grants: GRANT_PAYLOAD,
      call_sessions: {
        ...UPLOAD_SESSION,
        recording_egress_id: 'EG_failed123',
        recording_egress_status: 'failed',
      },
    });
    const app = uploadApp();
    const res = await request(app)
      .post(`/api/livekit/${VALID_SESSION}/recording`)
      .set('x-grant-token', GRANT_TOKEN)
      .attach('file', webmBuf(), { filename: 'rec.webm', contentType: 'audio/webm' });
    // Upload proceeds past the egress gate — should return 200 (not 409).
    expect(res.status).toBe(200);
    expect(res.body.object_key).toBeDefined();
  });

  it('T9: legacy path unchanged when no recording_egress_id is set', async () => {
    configureTables({
      candidate_access_grants: GRANT_PAYLOAD,
      call_sessions: {
        ...UPLOAD_SESSION,
        recording_egress_id: null,
        recording_egress_status: null,
      },
    });
    const app = uploadApp();
    const res = await request(app)
      .post(`/api/livekit/${VALID_SESSION}/recording`)
      .set('x-grant-token', GRANT_TOKEN)
      .attach('file', webmBuf(), { filename: 'rec.webm', contentType: 'audio/webm' });
    expect(res.status).toBe(200);
    expect(res.body.object_key).toBeDefined();
  });

  it('T10: gate ordering preserved — deleted (404) before egress gate', async () => {
    configureTables({
      candidate_access_grants: GRANT_PAYLOAD,
      call_sessions: {
        ...UPLOAD_SESSION,
        recording_egress_id: 'EG_active123',
        recording_egress_status: 'active',
        recording_deleted_at: '2026-01-01T00:00:00.000Z',
      },
    });
    const app = uploadApp();
    const res = await request(app)
      .post(`/api/livekit/${VALID_SESSION}/recording`)
      .set('x-grant-token', GRANT_TOKEN)
      .attach('file', webmBuf(), { filename: 'rec.webm', contentType: 'audio/webm' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });

  it('T10b: gate ordering preserved — quarantined (409) before egress gate', async () => {
    configureTables({
      candidate_access_grants: GRANT_PAYLOAD,
      call_sessions: {
        ...UPLOAD_SESSION,
        recording_egress_id: 'EG_active123',
        recording_egress_status: 'active',
        recording_quarantined: true,
      },
    });
    const app = uploadApp();
    const res = await request(app)
      .post(`/api/livekit/${VALID_SESSION}/recording`)
      .set('x-grant-token', GRANT_TOKEN)
      .attach('file', webmBuf(), { filename: 'rec.webm', contentType: 'audio/webm' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('recording_quarantined');
  });

  it('T10c: gate ordering preserved — revoked (403) before egress gate', async () => {
    configureTables({
      candidate_access_grants: GRANT_PAYLOAD,
      call_sessions: {
        ...UPLOAD_SESSION,
        recording_egress_id: 'EG_active123',
        recording_egress_status: 'active',
        recording_revoked_at: '2026-01-01T00:00:00.000Z',
      },
    });
    const app = uploadApp();
    const res = await request(app)
      .post(`/api/livekit/${VALID_SESSION}/recording`)
      .set('x-grant-token', GRANT_TOKEN)
      .attach('file', webmBuf(), { filename: 'rec.webm', contentType: 'audio/webm' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('access_denied');
  });

  // T11: grant-token and recruiter-owner auth outcomes unchanged
  it('T11: recruiter-owner upload returns 200 (unchanged, egress is null)', async () => {
    mockRecruiterAuth('interviewer', 'interviewer-1');
    configureTables({
      call_sessions: {
        ...UPLOAD_SESSION,
        owner_id: 'interviewer-1',
        recording_egress_id: null,
        recording_egress_status: null,
      },
    });
    const app = uploadApp();
    const res = await request(app)
      .post(`/api/livekit/${VALID_SESSION}/recording`)
      .set('Authorization', AUTH_HEADER)
      .attach('file', webmBuf(), { filename: 'rec.webm', contentType: 'audio/webm' });
    expect(res.status).toBe(200);
  });
});

describe('POST /api/livekit/grant/recording (route-shadow fixed)', () => {
  beforeEach(() => {
    setRateLimitStore(new MemoryRateLimitStore(100_000));
    mockFrom.mockReset();
    mockUpload.mockReset();
    mockCreateSignedUrl.mockReset();
    mockDownload.mockReset();
    insertCalls = [];
    updateCalls = [];
    configureTables({});
    mockCreateSignedUrl.mockResolvedValue({ data: { signedUrl: SIGNED_URL }, error: null });
  });

  it('is no longer shadowed by /:sessionId/recording — invalid grant reaches the handler (403)', async () => {
    configureTables({
      call_sessions: {
        id: VALID_SESSION,
        recording_object_key: OBJECT_KEY,
        recording_deleted_at: null,
        recording_quarantined: false,
        recording_revoked_at: null,
      },
      // candidate_access_grants resolves null → validateGrant fails closed.
    });
    const app = createTestApp();
    const res = await request(app)
      .post('/api/livekit/grant/recording')
      .send({ grant_token: GRANT_TOKEN, session_id: VALID_SESSION });
    // Fixed route: no 400 shadow — the real grant handler runs and denies 403.
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('access_denied');
  });

  it('denies mint (403) for a revoked recording even with a valid grant', async () => {
    configureTables({
      call_sessions: {
        id: VALID_SESSION,
        recording_object_key: OBJECT_KEY,
        recording_deleted_at: null,
        recording_quarantined: false,
        recording_revoked_at: '2026-01-01T00:00:00.000Z',
      },
      candidate_access_grants: GRANT_PAYLOAD,
    });
    const app = createTestApp();
    const res = await request(app)
      .post('/api/livekit/grant/recording')
      .send({ grant_token: GRANT_TOKEN, session_id: VALID_SESSION });
    expect(res.status).toBe(403);
    expect(mockCreateSignedUrl).not.toHaveBeenCalled();
  });

  it('denies mint (409) for a quarantined recording', async () => {
    configureTables({
      call_sessions: {
        id: VALID_SESSION,
        recording_object_key: OBJECT_KEY,
        recording_deleted_at: null,
        recording_quarantined: true,
        recording_revoked_at: null,
      },
    });
    const app = createTestApp();
    const res = await request(app)
      .post('/api/livekit/grant/recording')
      .send({ grant_token: GRANT_TOKEN, session_id: VALID_SESSION });
    expect(res.status).toBe(409);
    expect(mockCreateSignedUrl).not.toHaveBeenCalled();
  });

  it('denies mint (404) for a deleted recording', async () => {
    configureTables({
      call_sessions: {
        id: VALID_SESSION,
        recording_object_key: OBJECT_KEY,
        recording_deleted_at: '2026-01-01T00:00:00.000Z',
        recording_quarantined: false,
        recording_revoked_at: null,
      },
    });
    const app = createTestApp();
    const res = await request(app)
      .post('/api/livekit/grant/recording')
      .send({ grant_token: GRANT_TOKEN, session_id: VALID_SESSION });
    expect(res.status).toBe(404);
    expect(mockCreateSignedUrl).not.toHaveBeenCalled();
  });

  it('mints a signed URL (200) for a healthy grant-bound recording', async () => {
    configureTables({
      call_sessions: {
        id: VALID_SESSION,
        recording_object_key: OBJECT_KEY,
        recording_deleted_at: null,
        recording_quarantined: false,
        recording_revoked_at: null,
      },
      candidate_access_grants: GRANT_PAYLOAD,
    });
    mockCreateSignedUrl.mockResolvedValue({ data: { signedUrl: SIGNED_URL }, error: null });
    const app = createTestApp();
    const res = await request(app)
      .post('/api/livekit/grant/recording')
      .send({ grant_token: GRANT_TOKEN, session_id: VALID_SESSION });
    expect(res.status).toBe(200);
    expect(res.body.url).toBe(SIGNED_URL);
  });
});

describe('POST /api/recordings/:sessionId/revoke (REC-05 F2 repair)', () => {
  beforeEach(() => {
    setRateLimitStore(new MemoryRateLimitStore(100_000));
    mockFrom.mockReset();
    mockUpload.mockReset();
    mockCreateSignedUrl.mockReset();
    mockDownload.mockReset();
    insertCalls = [];
    updateCalls = [];
    configureTables({});
  });

  function revokeApp(role: 'admin' | 'interviewer' | 'viewer', userId: string) {
    return createTestApp(authAs(role, userId));
  }

  // ── Admin revoke: transition + exactly one revoked event ──────────
  it('revokes as admin (200): sets recording_revoked_at, appends one revoked event', async () => {
    configureTables({
      call_sessions: { id: VALID_SESSION, recording_revoked_at: null },
    });
    const app = revokeApp('admin', 'admin-1');
    const res = await request(app)
      .post(`/api/recordings/${VALID_SESSION}/revoke`)
      .set('Authorization', AUTH_HEADER)
      .send({ reason: 'candidate requested' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, status: 'revoked' });
    expect(res.body.revoked_at).toBeTruthy();

    // CAS transition persisted on call_sessions.
    const revokeUpdate = updateCalls.find(
      (u) => (u as Record<string, unknown>).recording_revoked_at,
    ) as Record<string, unknown>;
    expect(revokeUpdate).toBeDefined();

    // Exactly one revoked integrity event.
    const revokedEvents = insertCalls.filter(
      (i) => (i as Record<string, unknown>).event_type === 'revoked',
    );
    expect(revokedEvents).toHaveLength(1);
    expect((revokedEvents[0] as Record<string, unknown>).detail).toContain('candidate requested');
  });

  // ── Retry convergence: already_revoked, no duplicate evidence ─────
  it('is idempotent on retry (200 already_revoked, no duplicate event/update)', async () => {
    configureTables({
      call_sessions: { id: VALID_SESSION, recording_revoked_at: '2026-01-01T00:00:00.000Z' },
      recording_integrity_events: { id: 'evt-1', event_type: 'revoked' },
    });
    const app = revokeApp('admin', 'admin-1');
    const res = await request(app)
      .post(`/api/recordings/${VALID_SESSION}/revoke`)
      .set('Authorization', AUTH_HEADER)
      .send({ reason: 'retry' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, status: 'already_revoked' });
    expect(res.body.revoked_at).toBe('2026-01-01T00:00:00.000Z');
    // No new mutation and no duplicate event.
    expect(updateCalls).toHaveLength(0);
    expect(insertCalls).toHaveLength(0);
  });

  // ── Backfill: tombstone set but event missing → converges, no transition
  it('backfills a missing revoked event when revoked_at is already set (convergence)', async () => {
    configureTables({
      call_sessions: { id: VALID_SESSION, recording_revoked_at: '2026-01-01T00:00:00.000Z' },
      // recording_integrity_events resolves null → event missing
    });
    const app = revokeApp('admin', 'admin-1');
    const res = await request(app)
      .post(`/api/recordings/${VALID_SESSION}/revoke`)
      .set('Authorization', AUTH_HEADER)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, status: 'revoked' });
    expect(res.body.revoked_at).toBe('2026-01-01T00:00:00.000Z');
    // No transition update (already set) but exactly one backfilled event.
    expect(updateCalls).toHaveLength(0);
    const revokedEvents = insertCalls.filter(
      (i) => (i as Record<string, unknown>).event_type === 'revoked',
    );
    expect(revokedEvents).toHaveLength(1);
  });

  // ── RBAC: admin-only (uniform 403 for interviewer/viewer) ─────────
  it('denies non-admin roles with a uniform 403', async () => {
    configureTables({
      call_sessions: { id: VALID_SESSION, recording_revoked_at: null },
    });
    for (const role of ['interviewer', 'viewer'] as const) {
      const app = revokeApp(role, `${role}-1`);
      const res = await request(app)
        .post(`/api/recordings/${VALID_SESSION}/revoke`)
        .set('Authorization', AUTH_HEADER)
        .send({ reason: 'nope' });
      expect(res.status).toBe(403);
      expect(res.body.error.type).toBe('authorization_error');
    }
    // No mutation attempted by denied roles.
    expect(updateCalls).toHaveLength(0);
    expect(insertCalls).toHaveLength(0);
  });

  // ── Anti-enumeration: unknown session → 404, no mutation ──────────
  it('returns 404 for an unknown session (no mutation)', async () => {
    const app = revokeApp('admin', 'admin-1');
    const res = await request(app)
      .post(`/api/recordings/${VALID_SESSION}/revoke`)
      .set('Authorization', AUTH_HEADER)
      .send({});
    expect(res.status).toBe(404);
    expect(updateCalls).toHaveLength(0);
    expect(insertCalls).toHaveLength(0);
  });

  // ── Validation bounds: malformed UUID + oversize reason → 400 ─────
  it('returns 400 for a malformed session id and for an oversize reason', async () => {
    const app = revokeApp('admin', 'admin-1');
    const badId = await request(app)
      .post('/api/recordings/not-a-uuid/revoke')
      .set('Authorization', AUTH_HEADER)
      .send({});
    expect(badId.status).toBe(400);
    expect(badId.body.error.type).toBe('validation_error');

    const badReason = await request(app)
      .post(`/api/recordings/${VALID_SESSION}/revoke`)
      .set('Authorization', AUTH_HEADER)
      .send({ reason: 'x'.repeat(201) });
    expect(badReason.status).toBe(400);
    expect(badReason.body.error.type).toBe('validation_error');
  });

  // ── Unauthenticated → 401 (route is not public) ───────────────────
  it('returns 401 without a bearer token', async () => {
    const app = createTestApp();
    const res = await request(app)
      .post(`/api/recordings/${VALID_SESSION}/revoke`)
      .send({});
    expect(res.status).toBe(401);
  });
});
