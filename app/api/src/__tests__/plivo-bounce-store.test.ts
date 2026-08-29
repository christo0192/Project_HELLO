/**
 * The Plivo bounce read store — server-side attempt resolution and candidate
 * number lookup, all fail-closed.
 */

import { describe, it, expect } from 'vitest';
import { createPlivoBounceStore } from '../integrations/plivo-phone/stores.js';

const ATTEMPT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ENGAGEMENT = '11111111-2222-4333-8444-555555555555';
const CANDIDATE = '22222222-3333-4444-8555-666666666666';
const NUMBER = '+919812345678';

interface Rows {
  attempt?: Record<string, unknown> | null;
  engagement?: Record<string, unknown> | null;
  candidate?: Record<string, unknown> | null;
  attemptError?: boolean;
}

/** A minimal fake PostgREST client keyed by table. */
function fakeClient(rows: Rows) {
  return {
    from(table: string) {
      return {
        select() {
          return {
            eq() {
              return {
                async maybeSingle() {
                  if (table === 'phone_call_attempts') {
                    if (rows.attemptError) return { data: null, error: new Error('read') };
                    return { data: rows.attempt ?? null, error: null };
                  }
                  if (table === 'phone_engagements') return { data: rows.engagement ?? null, error: null };
                  if (table === 'candidates') return { data: rows.candidate ?? null, error: null };
                  return { data: null, error: null };
                },
              };
            },
          };
        },
      };
    },
  };
}

const liveAttempt = { id: ATTEMPT, engagement_id: ENGAGEMENT, state: 'answered_unclassified', answered_at: null };
const liveEngagement = { id: ENGAGEMENT, candidate_id: CANDIDATE, state: 'dialing', terminal_at: null };
const goodCandidate = { id: CANDIDATE, phone_e164: NUMBER, phone_valid: true };

describe('resolveForAnswer — bridges a live, awaiting-answer leg', () => {
  it('returns bridgeable with the wrapped candidate number', async () => {
    const store = createPlivoBounceStore(
      fakeClient({ attempt: liveAttempt, engagement: liveEngagement, candidate: goodCandidate }) as never,
    );
    const r = await store.resolveForAnswer(ATTEMPT);
    expect(r.bridgeable).toBe(true);
    expect(r.candidateNumber).toBeDefined();
    // Self-redacting: the number never renders in a log.
    expect(String(r.candidateNumber)).toBe('[redacted]');
  });

  it('bridges from admitted and ringing too', async () => {
    for (const state of ['admitted', 'ringing']) {
      const store = createPlivoBounceStore(
        fakeClient({
          attempt: { ...liveAttempt, state },
          engagement: liveEngagement,
          candidate: goodCandidate,
        }) as never,
      );
      expect((await store.resolveForAnswer(ATTEMPT)).bridgeable, state).toBe(true);
    }
  });
});

describe('resolveForAnswer — fails closed', () => {
  it('unknown attempt', async () => {
    const store = createPlivoBounceStore(fakeClient({ attempt: null }) as never);
    expect(await store.resolveForAnswer(ATTEMPT)).toEqual({ bridgeable: false, terminal: false, answered: false });
  });

  it('terminal engagement never bridges', async () => {
    const store = createPlivoBounceStore(
      fakeClient({
        attempt: liveAttempt,
        engagement: { ...liveEngagement, state: 'completed', terminal_at: '2026-08-29T00:00:00Z' },
        candidate: goodCandidate,
      }) as never,
    );
    const r = await store.resolveForAnswer(ATTEMPT);
    expect(r.bridgeable).toBe(false);
    expect(r.terminal).toBe(true);
  });

  it('an already-classified (human) attempt does not re-bridge', async () => {
    const store = createPlivoBounceStore(
      fakeClient({
        attempt: { ...liveAttempt, state: 'human', answered_at: '2026-08-29T00:00:00Z' },
        engagement: liveEngagement,
        candidate: goodCandidate,
      }) as never,
    );
    const r = await store.resolveForAnswer(ATTEMPT);
    expect(r.bridgeable).toBe(false);
    // It IS answered, just not awaiting-answer.
    expect(r.answered).toBe(true);
  });

  it('an invalid candidate number is not bridgeable', async () => {
    const store = createPlivoBounceStore(
      fakeClient({
        attempt: liveAttempt,
        engagement: liveEngagement,
        candidate: { id: CANDIDATE, phone_e164: NUMBER, phone_valid: false },
      }) as never,
    );
    expect((await store.resolveForAnswer(ATTEMPT)).bridgeable).toBe(false);
  });

  it('a read error propagates (so the route hangs up)', async () => {
    const store = createPlivoBounceStore(fakeClient({ attemptError: true }) as never);
    await expect(store.resolveForAnswer(ATTEMPT)).rejects.toThrow();
  });
});

describe('readAnsweredState — the tiny worker poll', () => {
  it('answered when answered_at is set', async () => {
    const store = createPlivoBounceStore(
      fakeClient({
        attempt: { ...liveAttempt, state: 'answered_unclassified', answered_at: '2026-08-29T00:00:00Z' },
        engagement: liveEngagement,
      }) as never,
    );
    expect(await store.readAnsweredState(ATTEMPT)).toEqual({ answered: true, terminal: false });
  });

  it('not answered for a pre-answer attempt', async () => {
    const store = createPlivoBounceStore(
      fakeClient({ attempt: { ...liveAttempt, state: 'ringing', answered_at: null }, engagement: liveEngagement }) as never,
    );
    expect(await store.readAnsweredState(ATTEMPT)).toEqual({ answered: false, terminal: false });
  });

  it('terminal when the engagement is terminal', async () => {
    const store = createPlivoBounceStore(
      fakeClient({
        // A pre-answer attempt whose engagement went terminal (e.g. cancelled).
        attempt: { ...liveAttempt, state: 'ended', answered_at: null },
        engagement: { ...liveEngagement, state: 'failed', terminal_at: '2026-08-29T00:00:00Z' },
      }) as never,
    );
    expect(await store.readAnsweredState(ATTEMPT)).toEqual({ answered: false, terminal: true });
  });

  it('not answered / not terminal for an unknown attempt', async () => {
    const store = createPlivoBounceStore(fakeClient({ attempt: null }) as never);
    expect(await store.readAnsweredState(ATTEMPT)).toEqual({ answered: false, terminal: false });
  });
});
