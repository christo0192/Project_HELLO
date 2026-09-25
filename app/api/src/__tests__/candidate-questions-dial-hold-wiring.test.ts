/**
 * The PRODUCTION half of the dial hold — the store method and the RPC call it
 * actually makes.
 *
 * `candidate-questions-enqueue.test.ts` drives the real ingestion handler, but
 * it injects its OWN `deferPhoneDialForQuestions` fake. So the handler was
 * covered and everything below it was not: three separate deletions left the
 * whole suite green while the feature was silently dead in production —
 *
 *   1. delete `deferPhoneDialForQuestions` from `workflow-stores.ts`. The port
 *      is optional on `RuntimeWorkflowStores`, so this still typechecks, and
 *      the caller's `&& runtime.stores.deferPhoneDialForQuestions` simply
 *      short-circuits. No hold, no error.
 *   2. stop surfacing `engagement_id` as `engagementId`. Same short-circuit.
 *   3. rename an RPC argument (`p_grace_seconds` -> `p_grace`). PostgREST 404s,
 *      the store throws, and the call races forever.
 *
 * That is the same defect class `candidate-questions-enqueue.test.ts` was
 * written to close one layer up. This file closes it at the bottom, against
 * the REAL `createWorkflowStores` with a fake Supabase client.
 */
import { describe, it, expect, vi } from 'vitest';
import { createWorkflowStores } from '../integrations/ashby/workflow-stores.js';
import { CANDIDATE_QUESTIONS_DIAL_GRACE_SECONDS } from '../integrations/ashby/runtime-workers.js';
import { CANDIDATE_QUESTIONS_TIMEOUT_MS, JUDGE_TIMEOUT_MS } from '../lib/candidate-questions.js';

interface RpcCall { name: string; args: Record<string, unknown>; }

/** A Supabase client that records `.rpc()` and answers with `data`. */
function client(data: unknown, error: unknown = null) {
  const calls: RpcCall[] = [];
  const fake = {
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return { data, error };
    }),
  };
  return { fake: fake as never, calls };
}

describe('the dial hold reaches the database', () => {
  it('CALLS THE 0104 RPC, by name, with the three argument names it declares', async () => {
    // Argument NAMES are the drift this test exists for: PostgREST addresses
    // parameters by name, so a rename is a 404 at runtime and a no-op in every
    // type check. The migration test pins the identity signature's TYPES; only
    // this pins the names against the caller.
    const { fake, calls } = client({ status: 'deferred' });
    const stores = createWorkflowStores(fake, 'actor-1');

    const result = await stores.deferPhoneDialForQuestions!('eng-7', 150);

    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('defer_phone_dial_for_questions');
    expect(Object.keys(calls[0].args).sort()).toEqual(
      ['p_engagement_id', 'p_grace_seconds', 'p_now'],
    );
    expect(calls[0].args.p_engagement_id).toBe('eng-7');
    expect(calls[0].args.p_grace_seconds).toBe(150);
    expect(typeof calls[0].args.p_now).toBe('string');
    expect(result.status).toBe('deferred');
  });

  it('surfaces every status verbatim, so the caller can tell a hold from a refusal', async () => {
    // The caller logs `deferred`/`unchanged` as info and everything else as a
    // warning. Flattening any of these to 'ok' would hide a permanently
    // refused hold, which is the original race wearing a green light.
    for (const status of [
      'deferred', 'unchanged', 'window_edge', 'engagement_not_waiting',
      'engagement_terminal', 'unknown_engagement', 'invalid_grace',
    ]) {
      const { fake } = client({ status });
      const stores = createWorkflowStores(fake, 'actor-1');
      expect((await stores.deferPhoneDialForQuestions!('eng-7', 150)).status, status)
        .toBe(status);
    }
  });

  it('turns a transport error into a stable sanitized code, never the raw object', async () => {
    // A transport error can carry whatever the provider handed it.
    const { fake } = client(null, { message: 'connection to 10.0.0.4 refused', code: '08006' });
    const stores = createWorkflowStores(fake, 'actor-1');
    await expect(stores.deferPhoneDialForQuestions!('eng-7', 150))
      .rejects.toThrow(/^phone_dial_defer_error$/);
  });

  it('SURFACES engagement_id AS engagementId, or the caller never holds anything', async () => {
    // `runtime-workers.ts` guards on `engagement?.engagementId`. If this
    // mapping breaks the hold vanishes, and before the caller was fixed it
    // vanished without even a log line.
    const { fake } = client({ status: 'eligible', engagement_id: 'eng-42' });
    const stores = createWorkflowStores(fake, 'actor-1');
    expect(await stores.ensurePhoneEngagement!('link-1')).toEqual({
      status: 'eligible', engagementId: 'eng-42',
    });
  });
});

describe('the grace is still big enough for the work it is waiting on', () => {
  it('COVERS A CLAIM, ONE GENERATION AND THE JUDGE — derived, not hardcoded', () => {
    // The constant's own comment spells out 5 + 60 + 45 = 110s. Nothing tied
    // it to the two timeouts it is derived from, so raising
    // CANDIDATE_QUESTIONS_TIMEOUT_MS to 120s — a one-line edit that looks
    // principled — would silently put the worst case past the grace and
    // restore the race. This is the tripwire for that edit.
    const CLAIM_SECONDS = 5; // one poll interval at signalPollMs 5000
    const onePass = CLAIM_SECONDS
      + CANDIDATE_QUESTIONS_TIMEOUT_MS / 1000
      + JUDGE_TIMEOUT_MS / 1000;
    expect(onePass).toBe(110);
    expect(CANDIDATE_QUESTIONS_DIAL_GRACE_SECONDS).toBeGreaterThanOrEqual(onePass);
  });

  it('stays inside the RPC bound, or every hold is refused as invalid_grace', () => {
    // `0104` refuses anything above 600 rather than clamping it.
    expect(CANDIDATE_QUESTIONS_DIAL_GRACE_SECONDS).toBeGreaterThan(0);
    expect(CANDIDATE_QUESTIONS_DIAL_GRACE_SECONDS).toBeLessThanOrEqual(600);
  });
});
