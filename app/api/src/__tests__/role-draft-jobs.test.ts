/**
 * Ask Hello as a JOB — the row, the fences on it, and the dead-worker read.
 *
 * The whole reason this layer exists: drafting runs v4-pro up to three times
 * at 133-206s a call. Held in one HTTP response that meant nothing survived a
 * refresh, a proxy idle timeout reaped it mid-draft, and Cancel stopped the
 * spinner while the generation carried on billing.
 *
 * The invariants worth testing are therefore not "it generates" — that is
 * `role-authoring.test.ts` — but what happens around a ten-minute gap: a
 * result landing after a cancellation, a worker that died holding a `running`
 * row, and one recruiter reaching for another's draft.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Every call made through the supabase stub, with its filters. */
interface Call {
  table: string;
  op: 'insert' | 'update' | 'select';
  payload?: Record<string, unknown>;
  filters: Array<[string, unknown]>;
}
let calls: Call[] = [];
/** What the next terminal read resolves to, by op. */
let selectResult: unknown = null;
let updateResult: unknown[] = [];

function builder(call: Call): any {
  const result =
    call.op === 'insert'
      ? { data: { id: 'draft-1', ...(call.payload ?? {}) }, error: null }
      : call.op === 'update'
        ? { data: updateResult, error: null }
        : { data: selectResult, error: null };
  const self: any = {
    eq(col: string, val: unknown) {
      call.filters.push([col, val]);
      return self;
    },
    select() {
      return self;
    },
    single: () => Promise.resolve(result),
    maybeSingle: () => Promise.resolve(result),
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(res, rej),
  };
  return self;
}

vi.mock('../lib/supabase.js', () => ({
  supabase: {
    from(table: string) {
      return {
        insert(payload: Record<string, unknown>) {
          const call: Call = { table, op: 'insert', payload, filters: [] };
          calls.push(call);
          return builder(call);
        },
        update(payload: Record<string, unknown>) {
          const call: Call = { table, op: 'update', payload, filters: [] };
          calls.push(call);
          return builder(call);
        },
        select() {
          const call: Call = { table, op: 'select', filters: [] };
          calls.push(call);
          return builder(call);
        },
      };
    },
  },
}));

const { startRoleDraft, readRoleDraft, cancelRoleDraft, ROLE_DRAFT_STALE_MS } = await import(
  '../lib/role-draft-jobs.js'
);
const { RoleDraftError, ROLE_DRAFT_MAX_ATTEMPTS } = await import('../lib/role-authoring.js');

const OWNER = '00000000-0000-4000-8000-0000000000ff';
const DRAFT = {
  jd: 'A job description.',
  required_skills: ['Sales'],
  screening_template: [{ id: 'q1', question: 'What do you do?', weight: 1 }],
};

/** The terminal write a finished run makes, if it made one. */
const finalWrite = () =>
  calls.find((c) => c.op === 'update' && typeof c.payload?.status === 'string');

/** Let the fire-and-forget run settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  calls = [];
  selectResult = null;
  updateResult = [];
});

describe('startRoleDraft', () => {
  it('RETURNS BEFORE THE WORK — the row exists, the drafting has not finished', async () => {
    // The point of the whole redesign. A start that awaited generation would
    // hold the request open for the ten minutes this was built to escape.
    let release: () => void = () => {};
    const run = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve({ draft: DRAFT, attempts: 1, repaired: [] });
      }),
    );

    const job = await startRoleDraft(OWNER, 'Sales Advisor', { run: run as never });

    expect(job.id).toBe('draft-1');
    expect(job.status).toBe('running');
    // Nothing terminal has been written yet: the generator is still running.
    expect(finalWrite()).toBeUndefined();
    release();
    await settle();
  });

  it('PINS the attempt budget the progress label counts against', async () => {
    // Asserted as a LITERAL on both sides, deliberately.
    //
    // `expect(job.max_attempts).toBe(ROLE_DRAFT_MAX_ATTEMPTS)` looks stronger
    // and is worth nothing: replacing the reference with a hard-coded 3 keeps
    // it green, because the constant IS 3. While the budget is a compile-time
    // constant, no test can prove the job reads it rather than repeats it.
    //
    // What CAN be defended is the number itself. "1 of 3" is the only thing
    // telling an operator a ten-minute wait is bounded, and three v4-pro calls
    // at 133-206s each is what that bound costs. Changing it has to be a
    // deliberate edit here as well as in the generator.
    const run = vi.fn().mockResolvedValue({ draft: DRAFT, attempts: 1, repaired: [] });
    const job = await startRoleDraft(OWNER, 'Sales Advisor', { run: run as never });
    expect(job.max_attempts).toBe(3);
    expect(ROLE_DRAFT_MAX_ATTEMPTS).toBe(3);
    await settle();
  });

  it('FENCES THE SUCCESS WRITE on status=running', async () => {
    // A ten-minute job can finish after the operator cancelled it. Without the
    // fence, the result resurrects a cancelled job and the form fills itself
    // from work the user explicitly stopped.
    const run = vi.fn().mockResolvedValue({ draft: DRAFT, attempts: 2, repaired: ['q3'] });
    await startRoleDraft(OWNER, 'Sales Advisor', { run: run as never });
    await settle();

    const write = finalWrite();
    expect(write?.payload?.status).toBe('succeeded');
    expect(write?.payload?.repaired).toEqual(['q3']);
    expect(write?.filters).toContainEqual(['status', 'running']);
  });

  it('FENCES THE FAILURE WRITE the same way', async () => {
    // Same race, opposite outcome: a provider error arriving after a cancel
    // must not overwrite `cancelled` with `failed` and show the user an error
    // for something they chose.
    const run = vi.fn().mockRejectedValue(new Error('socket hang up'));
    await startRoleDraft(OWNER, 'Sales Advisor', { run: run as never });
    await settle();

    const write = finalWrite();
    expect(write?.payload?.status).toBe('failed');
    expect(write?.filters).toContainEqual(['status', 'running']);
  });

  it('keeps the generator’s OWN reason rather than flattening it', async () => {
    // "unspeakable_questions" tells an operator the model wrote questions the
    // screener refuses to read; a generic provider error tells them to retry
    // something that will fail the same way three more times.
    const run = vi
      .fn()
      .mockRejectedValue(new RoleDraftError('Too many unreadable questions.', 'unspeakable_questions'));
    await startRoleDraft(OWNER, 'Sales Advisor', { run: run as never });
    await settle();

    expect(finalWrite()?.payload?.error_reason).toBe('unspeakable_questions');
    expect(finalWrite()?.payload?.error_message).toBe('Too many unreadable questions.');
  });

  it('does NOT leak a raw provider message to the operator', async () => {
    // An unexpected throw is not a sentence anyone should read. `RoleDraftError`
    // messages are written for a human; nothing else is.
    const run = vi.fn().mockRejectedValue(new Error('ECONNRESET 10.0.3.44:443'));
    await startRoleDraft(OWNER, 'Sales Advisor', { run: run as never });
    await settle();

    expect(finalWrite()?.payload?.error_reason).toBe('provider_unavailable');
    expect(String(finalWrite()?.payload?.error_message)).not.toContain('ECONNRESET');
  });

  it('SURVIVES a generator that throws SYNCHRONOUSLY', async () => {
    // Fire-and-forget without a guard is an unhandled rejection, and an
    // unhandled rejection in Node 22 kills the process — this API also serves
    // live calls, so that would drop screenings in progress.
    const run = vi.fn(() => {
      throw new Error('boom');
    });
    await expect(
      startRoleDraft(OWNER, 'Sales Advisor', { run: run as never }),
    ).resolves.toMatchObject({ status: 'running' });
    await settle();
  });
});

describe('readRoleDraft', () => {
  const base = {
    id: 'draft-1',
    owner_id: OWNER,
    job_role: 'Sales Advisor',
    status: 'running' as const,
    phase: { phase: 'drafting', attempt: 1, maxAttempts: 3 },
    draft: null,
    attempts: 1,
    repaired: [],
    error_reason: null,
    error_message: null,
    cancelled_at: null,
  };

  it('reads a live job as running', async () => {
    const now = Date.parse('2026-09-22T10:00:00Z');
    selectResult = { ...base, updated_at: new Date(now - 30_000).toISOString() };
    const job = await readRoleDraft(OWNER, 'draft-1', { now: () => now });
    expect(job?.status).toBe('running');
    expect(job?.phase).toEqual(base.phase);
  });

  it('TURNS A DEAD WORKER INTO A FAILURE, not an eternal spinner', async () => {
    // A redeploy mid-draft leaves `running` in the table forever. Reporting it
    // as still running is exactly the "feels stuck forever" this UI exists to
    // prevent — and it would never resolve, because nothing is working on it.
    const now = Date.parse('2026-09-22T10:00:00Z');
    selectResult = {
      ...base,
      updated_at: new Date(now - ROLE_DRAFT_STALE_MS - 1).toISOString(),
    };
    const job = await readRoleDraft(OWNER, 'draft-1', { now: () => now });
    expect(job?.status).toBe('failed');
    expect(job?.error_reason).toBe('abandoned');
  });

  it('does NOT declare a slow job dead', async () => {
    // One v4-pro call legitimately runs to 270s with no phase change. A
    // tighter threshold kills healthy drafts, which is worse than the spinner.
    const now = Date.parse('2026-09-22T10:00:00Z');
    selectResult = {
      ...base,
      updated_at: new Date(now - (ROLE_DRAFT_STALE_MS - 1_000)).toISOString(),
    };
    const job = await readRoleDraft(OWNER, 'draft-1', { now: () => now });
    expect(job?.status).toBe('running');
  });

  it('SCOPES THE READ TO THE OWNER', async () => {
    // A draft carries a job title someone typed. One recruiter has no reason
    // to read another's, and the row id is guessable to anyone who has one.
    selectResult = null;
    const job = await readRoleDraft(OWNER, 'draft-1');
    expect(job).toBeNull();
    const read = calls.find((c) => c.op === 'select');
    expect(read?.filters).toContainEqual(['owner_id', OWNER]);
  });

  it('never leaves `repaired` undefined for a caller to crash on', async () => {
    // The row's jsonb is `[]` by default but is not guaranteed to be an array
    // — the client maps over it without checking.
    const now = Date.parse('2026-09-22T10:00:00Z');
    selectResult = {
      ...base,
      repaired: null,
      updated_at: new Date(now).toISOString(),
    };
    const job = await readRoleDraft(OWNER, 'draft-1', { now: () => now });
    expect(job?.repaired).toEqual([]);
  });
});

describe('cancelRoleDraft', () => {
  it('cancels only a RUNNING job owned by the caller', async () => {
    updateResult = [{ id: 'draft-1' }];
    await expect(cancelRoleDraft(OWNER, 'draft-1')).resolves.toBe(true);
    const write = calls.find((c) => c.op === 'update');
    expect(write?.payload?.status).toBe('cancelled');
    expect(write?.filters).toContainEqual(['owner_id', OWNER]);
    expect(write?.filters).toContainEqual(['status', 'running']);
  });

  it('is IDEMPOTENT — cancelling a finished job is not an error', async () => {
    // The operator presses Cancel as the draft lands. That is a race they
    // cannot be blamed for, and a 500 would be the wrong answer to it.
    updateResult = [];
    await expect(cancelRoleDraft(OWNER, 'draft-1')).resolves.toBe(false);
  });

  it('WRITES cancelled_at, which is what the generator reads', async () => {
    // Status alone would stop the poller and leave v4-pro running: the
    // generator checks this column between attempts to stop the spending.
    updateResult = [{ id: 'draft-1' }];
    await cancelRoleDraft(OWNER, 'draft-1');
    expect(calls.find((c) => c.op === 'update')?.payload?.cancelled_at).toEqual(expect.any(String));
  });
});
