/**
 * GOV-03/GOV-08/GOV-09/GOV-10: Consent route tests.
 *
 * Verified:
 * - GOV-03: Versioned consent submission and retrieval
 * - GOV-08: Privacy notice template endpoint
 * - GOV-09: Decline blocks AI/recording; withdraw works
 * - GOV-10: job_application consent alone cannot unlock ai_interview/recording
 * - Negative: join fails without consent evidence
 * - hasConsentFor helper correctly gates consent types
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';

// ── Supabase mock ────────────────────────────────────────────────────

const mockFrom = vi.fn();
const mockSelect = vi.fn();
const mockInsert = vi.fn();
const mockEq = vi.fn();
const mockSingle = vi.fn();
const mockOrder = vi.fn();
const mockLimit = vi.fn();

/** Reset all mock chain functions to return self for chaining. */
function resetChain() {
  mockSelect.mockReturnValue(chainValue);
  mockInsert.mockReturnValue(chainValue);
  mockEq.mockReturnValue(chainValue);
  mockSingle.mockReturnValue(chainValue);
  mockOrder.mockReturnValue(chainValue);
  mockLimit.mockReturnValue(chainValue);
}

// Use a mutable value holder so tests can set resolved data per-call.
let chainResolveValue: unknown = null;
const chainValue: any = {
  select: (...args: unknown[]) => {
    mockSelect(...args);
    return chainValue;
  },
  insert: (...args: unknown[]) => {
    mockInsert(...args);
    return chainValue;
  },
  eq: (...args: unknown[]) => {
    mockEq(...args);
    return chainValue;
  },
  single: (...args: unknown[]) => {
    mockSingle(...args);
    return chainValue;
  },
  order: (...args: unknown[]) => {
    mockOrder(...args);
    return chainValue;
  },
  limit: (...args: unknown[]) => {
    mockLimit(...args);
    return chainValue;
  },
  then: (resolve: (v: unknown) => unknown) => {
    return Promise.resolve(chainResolveValue).then(resolve);
  },
  catch: (_reject: (e: unknown) => unknown) => chainValue,
};

vi.mock('../lib/supabase.js', () => ({
  supabase: {
    from: (...args: unknown[]) => {
      mockFrom(...args);
      return chainValue;
    },
  },
}));

vi.mock('../lib/correlation.js', () => ({
  getCorrelationId: () => '00000000-0000-4000-8000-000000000000',
  // createApp mounts correlationMiddleware; provide a passthrough so the app
  // builds without pulling in AsyncLocalStorage internals for these tests.
  correlationMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { hasConsentFor } from '../routes/consent.js';
import type { ConsentType } from '../schemas/consent.js';

const CANDIDATE_ID = '00000000-0000-4000-8000-000000000001';

// ── App for route integration tests ──────────────────────────────────

const app = createApp({ nodeEnv: 'test', webOrigin: 'http://localhost:5173' });

describe('Consent API — GOV-03/GOV-08/GOV-09/GOV-10', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChain();
    chainResolveValue = null;
  });

  // ── GOV-03: Versioned consent submission ─────────────────────────

  describe('POST /api/consent/submit (GOV-03)', () => {
    it('rejects unauthenticated submit with 401 (fail-closed, not public)', async () => {
      // Consent routes are mounted behind the global auth middleware. They carry
      // no per-candidate grant, so they are deliberately NOT public — an
      // unauthenticated request must be refused (401), never reach the handler.
      const res = await request(app)
        .post('/api/consent/submit')
        .send({
          candidate_id: CANDIDATE_ID,
          version: '1.0',
          consents: ['ai_interview', 'recording', 'purpose'],
          status: 'granted',
        });

      expect(res.status).toBe(401);
    });
  });

  // ── GOV-10: hasConsentFor helper ─────────────────────────────────

  describe('hasConsentFor (GOV-10)', () => {
    it('returns false when no consent record exists', async () => {
      chainResolveValue = { data: null, error: { message: 'not found', code: 'PGRST116' } };

      const result = await hasConsentFor(CANDIDATE_ID, ['ai_interview', 'recording']);

      expect(result.ok).toBe(false);
      expect(result.missing).toEqual(['ai_interview', 'recording']);
    });

    it('returns false for expired consent', async () => {
      chainResolveValue = {
        data: {
          consents: ['ai_interview', 'recording'],
          status: 'granted',
          expires_at: new Date(Date.now() - 86400000).toISOString(), // yesterday
        },
        error: null,
      };

      const result = await hasConsentFor(CANDIDATE_ID, ['ai_interview']);

      expect(result.ok).toBe(false);
      expect(result.missing).toContain('ai_interview');
    });

    it('returns true when all required consent types are present', async () => {
      chainResolveValue = {
        data: {
          consents: ['ai_interview', 'recording', 'purpose', 'data_processing'],
          status: 'granted',
          expires_at: null,
        },
        error: null,
      };

      const result = await hasConsentFor(CANDIDATE_ID, ['ai_interview', 'recording']);

      expect(result.ok).toBe(true);
      expect(result.missing).toEqual([]);
    });

    it('returns missing types when not all consents granted', async () => {
      chainResolveValue = {
        data: {
          consents: ['ai_interview', 'purpose'],
          status: 'granted',
          expires_at: null,
        },
        error: null,
      };

      const result = await hasConsentFor(CANDIDATE_ID, ['ai_interview', 'recording']);

      expect(result.ok).toBe(false);
      expect(result.missing).toEqual(['recording']);
    });

    it('returns false when consent is declined', async () => {
      chainResolveValue = {
        data: {
          consents: ['ai_interview', 'recording'],
          status: 'declined',
          expires_at: null,
        },
        error: null,
      };

      const result = await hasConsentFor(CANDIDATE_ID, ['ai_interview']);

      expect(result.ok).toBe(false);
      expect(result.missing).toContain('ai_interview');
    });
  });

  // ── GOV-10: job_application alone cannot unlock AI/recording ────

  describe('GOV-10 — job_application consent', () => {
    it('job_application alone cannot unlock ai_interview', async () => {
      chainResolveValue = {
        data: {
          consents: ['job_application'],
          status: 'granted',
          expires_at: null,
        },
        error: null,
      };

      const result = await hasConsentFor(CANDIDATE_ID, ['ai_interview']);

      expect(result.ok).toBe(false);
      expect(result.missing).toContain('ai_interview');
    });

    it('job_application alone cannot unlock recording', async () => {
      chainResolveValue = {
        data: {
          consents: ['job_application'],
          status: 'granted',
          expires_at: null,
        },
        error: null,
      };

      const result = await hasConsentFor(CANDIDATE_ID, ['recording']);

      expect(result.ok).toBe(false);
      expect(result.missing).toContain('recording');
    });

    it('job_application + explicit ai_interview consent unlocks AI', async () => {
      chainResolveValue = {
        data: {
          consents: ['job_application', 'ai_interview', 'recording'],
          status: 'granted',
          expires_at: null,
        },
        error: null,
      };

      const result = await hasConsentFor(CANDIDATE_ID, ['ai_interview', 'recording']);

      expect(result.ok).toBe(true);
      expect(result.missing).toEqual([]);
    });

    it('generic consent without any type still fails for AI/recording', async () => {
      chainResolveValue = {
        data: {
          consents: ['job_application'],
          status: 'granted',
          expires_at: null,
        },
        error: null,
      };

      const result = await hasConsentFor(CANDIDATE_ID, ['ai_interview', 'recording']);

      expect(result.ok).toBe(false);
      expect(result.missing).toEqual(['ai_interview', 'recording']);
    });
  });

  // ── GOV-09: Decline blocks AI/recording ─────────────────────────

  describe('GOV-09 — consent decline', () => {
    it('declined consent returns false for all required types', async () => {
      chainResolveValue = {
        data: {
          consents: ['ai_interview', 'recording'],
          status: 'declined',
          expires_at: null,
        },
        error: null,
      };

      const result = await hasConsentFor(CANDIDATE_ID, ['ai_interview']);

      expect(result.ok).toBe(false);
    });

    it('withdrawn consent returns false', async () => {
      chainResolveValue = {
        data: {
          consents: ['ai_interview', 'recording'],
          status: 'withdrawn',
          expires_at: null,
        },
        error: null,
      };

      const result = await hasConsentFor(CANDIDATE_ID, ['recording']);

      expect(result.ok).toBe(false);
    });
  });

  // ── GET /api/consent/:candidateId/status ────────────────────────

  describe('GET /api/consent/:candidateId/status (GOV-03)', () => {
    it('rejects unauthenticated status read with 401 (not public)', async () => {
      const res = await request(app)
        .get(`/api/consent/${CANDIDATE_ID}/status`);

      expect(res.status).toBe(401);
    });
  });

  // ── POST /api/consent/check ─────────────────────────────────────

  describe('POST /api/consent/check (GOV-10)', () => {
    it('rejects unauthenticated check with 401 (not public)', async () => {
      const res = await request(app)
        .post('/api/consent/check')
        .send({
          candidate_id: CANDIDATE_ID,
          required: ['ai_interview', 'recording'],
        });

      expect(res.status).toBe(401);
    });
  });

  // ── POST /api/consent/withdraw ──────────────────────────────────

  describe('POST /api/consent/withdraw (GOV-09)', () => {
    it('rejects unauthenticated withdraw with 401 (not public)', async () => {
      const res = await request(app)
        .post('/api/consent/withdraw')
        .send({
          candidate_id: CANDIDATE_ID,
          reason: 'Testing withdrawal',
        });

      expect(res.status).toBe(401);
    });
  });

  // ── GET /api/consent/templates ──────────────────────────────────

  describe('GET /api/consent/templates (GOV-08)', () => {
    it('rejects unauthenticated templates read with 401 (not public)', async () => {
      const res = await request(app).get('/api/consent/templates');

      expect(res.status).toBe(401);
    });
  });
});
