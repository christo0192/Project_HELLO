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
  /** Column lists passed to `.select()` on this call. */
  selects: string[];
}
let calls: Call[] = [];
/** What the next terminal read resolves to, by op. */
let selectResult: unknown = null;
let selectQueue: unknown[] = [];
let selectError: unknown = null;
let updateResult: unknown[] = [{ id: 'draft-1' }];
let updateError: unknown = null;
/** Errors the next inserts should fail with, in order. */
let insertErrors: unknown[] = [];

function builder(call: Call): any {
  // READS COME FROM A QUEUE when one is set. A single run makes several
  // different reads — the admission check, then the generator's cancellation
  // check — and they want different answers. A single `selectResult` cannot
  // express that, and the attempt to set it BETWEEN the two silently failed:
  // `shouldCancel` is invoked before `startRoleDraft` has even returned, so
  // the assignment landed too late and the test asserted the wrong thing.
  const nextRead = () =>
    selectQueue.length > 0 ? selectQueue.shift() : selectResult;
  // INSERTS CAN FAIL NOW. Without this the 23505 branch — the one that has to
  // tell "a concurrent start won" apart from "a dead worker's row is blocking
  // the index" — was unreachable, and two reviewers independently proved a
  // permanent per-owner lockout that no test could see.
  // Consumed ONLY by an insert. Shifting on every builder call meant the
  // first SELECT ate the queued insert error and every one of these tests
  // passed against a successful insert — the failure mode this whole block
  // exists to catch, reproduced in its own harness.
  const insertError =
    call.op === 'insert' && insertErrors.length > 0 ? insertErrors.shift() : null;
  const result =
    call.op === 'insert'
      ? insertError
        ? { data: null, error: insertError }
        : { data: { id: 'draft-1', ...(call.payload ?? {}) }, error: null }
      : call.op === 'update'
        ? { data: updateResult, error: updateError }
        : { data: nextRead(), error: selectError };
  const self: any = {
    eq(col: string, val: unknown) {
      call.filters.push([col, val]);
      return self;
    },
    lt(col: string, val: unknown) {
      call.filters.push([`${col}<`, val]);
      return self;
    },
    select(columns?: string) {
      // RECORDED. `select() { return self; }` discarded the column list on
      // the UPDATE chain exactly as it used to discard `.order()` on the turn
      // query — so deleting `.select('id')` from the terminal write, and the
      // zero-row warning that depends on it, kept 73/73 green.
      if (columns) call.selects.push(columns);
      return self;
    },
    order() {
      return self;
    },
    limit() {
      return self;
    },
    single: () => Promise.resolve(result),
    maybeSingle: () => Promise.resolve(result),
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(res, rej),
  };
  return self;
}

/** Every structured log line this module emitted. */
let logged: Array<{ level: string; event: string; meta: Record<string, unknown> }> = [];
vi.mock('../lib/logger.js', () => ({
  createLogger: () => ({
    debug: (event: string, meta: Record<string, unknown>) =>
      logged.push({ level: 'debug', event, meta }),
    info: (event: string, meta: Record<string, unknown>) =>
      logged.push({ level: 'info', event, meta }),
    warn: (event: string, meta: Record<string, unknown>) =>
      logged.push({ level: 'warn', event, meta }),
    error: (event: string, meta: Record<string, unknown>) =>
      logged.push({ level: 'error', event, meta }),
  }),
}));

vi.mock('../lib/supabase.js', () => ({
  supabase: {
    from(table: string) {
      return {
        insert(payload: Record<string, unknown>) {
          const call: Call = { table, op: 'insert', payload, filters: [], selects: [] };
          calls.push(call);
          return builder(call);
        },
        update(payload: Record<string, unknown>) {
          const call: Call = { table, op: 'update', payload, filters: [], selects: [] };
          calls.push(call);
          return builder(call);
        },
        select(columns?: string) {
          const call: Call = { table, op: 'select', filters: [], selects: [] };
          if (columns) call.selects.push(columns);
          calls.push(call);
          return builder(call);
        },
      };
    },
  },
}));

const {
  startRoleDraft,
  readRoleDraft,
  readActiveRoleDraft,
  cancelRoleDraft,
  RoleDraftBusyError,
  ROLE_DRAFT_STALE_MS,
  ROLE_DRAFT_MAX_CALL_MS,
} = await import('../lib/role-draft-jobs.js');
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

/**
 * Every PHASE write — an update carrying `phase`, terminal or not.
 *
 * The TABLE is checked, not just the shape: a heartbeat written to the wrong
 * table is not a heartbeat, and the stub answers to any name.
 */
const phaseWrites = () =>
  calls.filter(
    (c) => c.op === 'update' && c.table === 'role_drafts' && 'phase' in (c.payload ?? {}),
  );

/** Progress writes only: they carry a phase and no status. */
const heartbeats = () =>
  phaseWrites().filter((c) => typeof c.payload?.status !== 'string');

/**
 * `startRoleDraft` reads the caller's live job before inserting, so the
 * default for tests that are not about admission is "nothing is running".
 */
function noActiveDraft() {
  selectResult = [];
}

beforeEach(() => {
  calls = [];
  selectResult = null;
  selectQueue = [];
  selectError = null;
  // ONE ROW by default: a fenced update that matched its row. `[]` used to be
  // the default, which meant the zero-row warning fired on every terminal
  // write in the suite and nothing noticed.
  updateResult = [{ id: 'draft-1' }];
  updateError = null;
  insertErrors = [];
  logged = [];
  // The default for tests that are not about admission: nothing is running,
  // so `startRoleDraft` proceeds to insert.
  noActiveDraft();
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

  it('records the BUDGET IT BURNED on a failed job', async () => {
    // Without it every failed job reads `attempts: 0` in the row, which makes
    // "spent the whole budget on an outage" indistinguishable from "stopped
    // before the first call" — and those want opposite responses from whoever
    // is looking at why drafting is failing.
    const run = vi
      .fn()
      .mockRejectedValue(
        new RoleDraftError('Too many unreadable questions.', 'unspeakable_questions', undefined, 3),
      );
    await startRoleDraft(OWNER, 'Sales Advisor', { run: run as never });
    await settle();
    expect(finalWrite()?.payload?.attempts).toBe(3);
  });

  it('OMITS the attempts key when there is no number — the column is NOT NULL', async () => {
    // The other half of the test above, and the half that matters more.
    // `attempts` is `integer not null default 0` (0101), so writing an
    // explicit null makes the whole terminal write a 23502: it is rejected,
    // the row stays `running` with a frozen heartbeat, and twelve minutes
    // later the operator is told the draft was ABANDONED rather than that the
    // provider could not be reached. Silent everywhere but one log line.
    //
    // A review restored `attempts: isDraftError ? (err.attempts ?? null) :
    // null` and all 6,020 API tests stayed green, because only the PRESENT
    // case was pinned.
    const run = vi.fn().mockRejectedValue(new Error('socket hang up'));
    await startRoleDraft(OWNER, 'Sales Advisor', { run: run as never });
    await settle();
    expect('attempts' in (finalWrite()?.payload ?? {})).toBe(false);
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
    // What this actually covers: `runDraft`'s own try/catch turns the throw
    // into a `failed` row instead of a rejected promise.
    //
    // It does NOT cover the `.catch(() => {})` on the fire-and-forget call,
    // which only fires if the TERMINAL WRITE itself rejects — and the stub
    // here resolves every write. That guard is defence-in-depth against an
    // unhandled rejection, which in Node 22 kills the process and would drop
    // live screenings with it; a review confirmed removing it keeps this
    // suite green. Said plainly rather than left implied by the test name.
    const run = vi.fn(() => {
      throw new Error('boom');
    });
    await expect(
      startRoleDraft(OWNER, 'Sales Advisor', { run: run as never }),
    ).resolves.toMatchObject({ status: 'running' });
    await settle();
  });
});

describe('the heartbeat', () => {
  // `updated_at` on the progress write IS the liveness signal `readRoleDraft`
  // reads. A review proved the entire `onProgress` handler could be replaced
  // with `() => {}` and all 15 tests stayed green — which would have shipped
  // a button stuck on "Starting…" for ten minutes AND a healthy job reported
  // as abandoned, the two failures this feature exists to prevent.

  it('WRITES A HEARTBEAT for every phase the generator reports', async () => {
    const run = vi.fn(async (_role: string, opts: any) => {
      opts.onProgress({ phase: 'drafting', attempt: 1, maxAttempts: 3 });
      opts.onProgress({ phase: 'checking', attempt: 1, maxAttempts: 3 });
      return { draft: DRAFT, attempts: 1, repaired: [] };
    });
    await startRoleDraft(OWNER, 'Sales Advisor', { run: run as never });
    await settle();

    const beats = heartbeats();
    expect(beats).toHaveLength(2);
    expect(beats[0]?.payload?.phase).toEqual({
      phase: 'drafting',
      attempt: 1,
      maxAttempts: 3,
    });
    expect(beats[1]?.payload?.phase).toMatchObject({ phase: 'checking' });
  });

  it('bumps `updated_at` on every one — it is the liveness clock', async () => {
    // Without this the row's heartbeat is frozen at insert time and any job
    // outliving the stale window is reported dead while it is still working.
    const run = vi.fn(async (_role: string, opts: any) => {
      opts.onProgress({ phase: 'drafting', attempt: 1, maxAttempts: 3 });
      return { draft: DRAFT, attempts: 1, repaired: [] };
    });
    await startRoleDraft(OWNER, 'Sales Advisor', { run: run as never });
    await settle();
    expect(heartbeats()[0]?.payload?.updated_at).toEqual(expect.any(String));
  });

  it('FENCES the heartbeat on status=running', async () => {
    // Two PostgREST requests have no ordering guarantee. Unfenced, a late
    // `checking` write lands after the terminal write and leaves a settled
    // row advertising a phase it is no longer in.
    const run = vi.fn(async (_role: string, opts: any) => {
      opts.onProgress({ phase: 'drafting', attempt: 1, maxAttempts: 3 });
      return { draft: DRAFT, attempts: 1, repaired: [] };
    });
    await startRoleDraft(OWNER, 'Sales Advisor', { run: run as never });
    await settle();
    expect(heartbeats()[0]?.filters).toContainEqual(['status', 'running']);
  });

  it('a failed heartbeat does NOT fail the draft', async () => {
    // Failing a ten-minute generation over a failed DESCRIPTION of it would
    // be the worse trade — the opposite error from ignoring it entirely.
    updateError = new Error('pooler reset');
    const run = vi.fn(async (_role: string, opts: any) => {
      opts.onProgress({ phase: 'drafting', attempt: 1, maxAttempts: 3 });
      return { draft: DRAFT, attempts: 1, repaired: [] };
    });
    await expect(
      startRoleDraft(OWNER, 'Sales Advisor', { run: run as never }),
    ).resolves.toMatchObject({ status: 'running' });
    await settle();
    expect(finalWrite()?.payload?.status).toBe('succeeded');
  });
});

describe('the stale window', () => {
  it('is BOUNDED ABOVE, not just below', async () => {
    // Pinned as a LITERAL against a literal. The two staleness tests below
    // derive `updated_at` from the constant itself, so multiplying the
    // constant by 10000 moved both goalposts together and 70 days of spinner
    // passed the suite — the same self-referential defect this file's sibling
    // already had to fix for the attempt budget.
    //
    // The number is 2 x the 300000 env ceiling for one provider call, plus
    // two minutes. Two, because `runDeepseekJSON` retries internally with no
    // phase reported between the calls, so that is the longest gap a HEALTHY
    // job can leave. Anything tighter kills live drafts; much looser and a
    // dead worker holds the operator on a spinner.
    expect(ROLE_DRAFT_MAX_CALL_MS).toBe(300_000);
    expect(ROLE_DRAFT_STALE_MS).toBe(720_000);
  });

  it('covers TWO provider calls, because one attempt can make two', async () => {
    // The relationship, stated separately from the numbers: if someone raises
    // the per-call ceiling, this says what the window owes it.
    expect(ROLE_DRAFT_STALE_MS).toBeGreaterThan(2 * ROLE_DRAFT_MAX_CALL_MS);
  });
});

describe('cancellation reaches the generator', () => {
  // The PR's headline claim — "stops the spending, not just the spinner" — had
  // zero coverage at either end. `cancelRoleDraft` writing `cancelled_at` was
  // tested; the generator READING it was not; nothing joined them.

  it('hands the generator a shouldCancel it can actually ask', async () => {
    let asked = false;
    const run = vi.fn(async (_role: string, opts: any) => {
      expect(typeof opts.shouldCancel).toBe('function');
      asked = await opts.shouldCancel();
      return { draft: DRAFT, attempts: 1, repaired: [] };
    });
    // Read 1 is the admission check (nothing running); read 2 is the
    // generator asking whether it has been cancelled. Queued, because the
    // second happens before `startRoleDraft` returns.
    selectQueue = [[], { cancelled_at: '2026-09-22T10:00:00Z' }];
    await startRoleDraft(OWNER, 'Sales Advisor', { run: run as never });
    await settle();
    expect(asked).toBe(true);
  });

  it('reports NOT-cancelled while `cancelled_at` is null', async () => {
    // The other half. A `shouldCancel` that always answered true would stop
    // every draft on its first attempt and still satisfy the test above.
    let answer: boolean | null = null;
    const run = vi.fn(async (_role: string, opts: any) => {
      answer = await opts.shouldCancel();
      return { draft: DRAFT, attempts: 1, repaired: [] };
    });
    selectQueue = [[], { cancelled_at: null }];
    await startRoleDraft(OWNER, 'Sales Advisor', { run: run as never });
    await settle();
    expect(answer).toBe(false);
  });
});

describe('readActiveRoleDraft', () => {
  // What makes "a refresh picks the job back up" true. The browser holds the
  // job id in component state and nowhere else.

  it('returns the caller\'s live job', async () => {
    const now = Date.parse('2026-09-22T10:00:00Z');
    selectResult = [
      {
        id: 'draft-1',
        owner_id: OWNER,
        job_role: 'Sales Advisor',
        status: 'running',
        phase: { phase: 'drafting', attempt: 2, maxAttempts: 3 },
        draft: null,
        attempts: 2,
        repaired: [],
        error_reason: null,
        error_message: null,
        cancelled_at: null,
        updated_at: new Date(now - 30_000).toISOString(),
      },
    ];
    const job = await readActiveRoleDraft(OWNER, { now: () => now });
    expect(job?.id).toBe('draft-1');
    expect(job?.phase).toMatchObject({ attempt: 2 });
    const read = calls.find((c) => c.op === 'select');
    expect(read?.filters).toContainEqual(['owner_id', OWNER]);
    expect(read?.filters).toContainEqual(['status', 'running']);
  });

  it('does NOT return a stale one', async () => {
    // A dead worker's row would resume a poll that never reports again — and,
    // worse, would block every future start for good via the admission check.
    const now = Date.parse('2026-09-22T10:00:00Z');
    selectResult = [
      {
        id: 'draft-1',
        owner_id: OWNER,
        job_role: 'Sales Advisor',
        status: 'running',
        phase: null,
        draft: null,
        attempts: 1,
        repaired: [],
        error_reason: null,
        error_message: null,
        cancelled_at: null,
        updated_at: new Date(now - ROLE_DRAFT_STALE_MS - 1).toISOString(),
      },
    ];
    expect(await readActiveRoleDraft(OWNER, { now: () => now })).toBeNull();
  });

  it('returns null when nothing is running', async () => {
    selectResult = [];
    expect(await readActiveRoleDraft(OWNER)).toBeNull();
  });
});

describe('admission', () => {
  it('REFUSES A SECOND JOB while one is live, and hands back the first', async () => {
    // Each start detaches up to six v4-pro calls into the process that also
    // serves live-call operations. The UI guard is per-component, so two tabs
    // or a script with a valid token could start hundreds a minute.
    const now = Date.parse('2026-09-22T10:00:00Z');
    selectResult = [
      {
        id: 'already-running',
        owner_id: OWNER,
        job_role: 'Sales Advisor',
        status: 'running',
        phase: null,
        draft: null,
        attempts: 1,
        repaired: [],
        error_reason: null,
        error_message: null,
        cancelled_at: null,
        updated_at: new Date(now - 1_000).toISOString(),
      },
    ];
    const run = vi.fn();
    const job = await startRoleDraft(OWNER, 'Sales Advisor', {
      run: run as never,
      now: () => now,
    });
    expect(job.id).toBe('already-running');
    expect(run).not.toHaveBeenCalled();
    expect(calls.some((c) => c.op === 'insert')).toBe(false);
  });

  it('starts normally once the live job has settled', async () => {
    selectResult = [];
    const run = vi.fn().mockResolvedValue({ draft: DRAFT, attempts: 1, repaired: [] });
    const job = await startRoleDraft(OWNER, 'Sales Advisor', { run: run as never });
    expect(job.id).toBe('draft-1');
    expect(calls.some((c) => c.op === 'insert')).toBe(true);
    await settle();
  });
});

describe('the 23505 branch — where the index and the read disagree', () => {
  // `uq_role_drafts_owner_running` (0101) is what actually enforces one live
  // job per owner, because SELECT-then-INSERT cannot. But the index and
  // `readActiveRoleDraft` do not agree on what "running" means: the read hides
  // a STALE row, the index does not. Everything here is about that gap, which
  // two reviewers proved was a permanent lockout that no test could see —
  // there was no test for this branch at all, and the stub could not make one.

  const NOW = Date.parse('2026-09-22T10:00:00Z');
  const DUP = { code: '23505', message: 'duplicate key value violates unique constraint' };
  const liveRow = (over: Record<string, unknown> = {}) => ({
    id: 'live-1',
    owner_id: OWNER,
    job_role: 'Sales Advisor',
    status: 'running',
    phase: null,
    draft: null,
    attempts: 1,
    repaired: [],
    error_reason: null,
    error_message: null,
    cancelled_at: null,
    updated_at: new Date(NOW - 1_000).toISOString(),
    ...over,
  });

  it('EXPIRES A DEAD WORKER\'S ROW and starts anyway', async () => {
    // The lockout. A redeploy mid-draft leaves `running` with a frozen
    // heartbeat. The read says nothing is live, the insert hits the index, and
    // before this the retry read said nothing is live again — so the owner got
    // a 500 on every press, forever, recoverable only by hand-written SQL.
    selectQueue = [
      [],                                                   // readActiveRoleDraft: nothing live
      [liveRow({ updated_at: new Date(NOW - ROLE_DRAFT_STALE_MS - 1).toISOString() })],
    ];                                                      // readRunningRow: the stale row
    insertErrors = [DUP];                                   // first insert loses to it
    const run = vi.fn().mockResolvedValue({ draft: DRAFT, attempts: 1, repaired: [] });

    const job = await startRoleDraft(OWNER, 'Sales Advisor', {
      run: run as never,
      now: () => NOW,
    });

    // A new job exists...
    expect(job.id).toBe('draft-1');
    // ...and the dead row was written off rather than left blocking the index.
    const expiry = calls.find(
      (c) => c.op === 'update' && c.payload?.error_reason === 'abandoned',
    );
    expect(expiry).toBeDefined();
    expect(expiry?.filters).toContainEqual(['owner_id', OWNER]);
    expect(expiry?.filters).toContainEqual(['status', 'running']);
    // Fenced on the heartbeat too: a worker that wakes between the read and
    // this write must not have its live job killed.
    // THE CUT-OFF VALUE, not merely the presence of a cut-off. Asserting only
    // that `updated_at<` appears left the comparand free: replacing
    // `now() - ROLE_DRAFT_STALE_MS` with `now()` makes the expiry match ANY
    // running row, so a concurrent start can kill a live generation whose
    // heartbeats were merely being dropped — and its finished draft then
    // lands on the discarded branch. The fence is the whole protection.
    const cutoff = expiry?.filters.find(([k]) => k === 'updated_at<')?.[1];
    expect(Date.parse(String(cutoff))).toBe(NOW - ROLE_DRAFT_STALE_MS);
    await settle();
  });

  it('RETRIES when the conflicting row has VANISHED, rather than 500ing', async () => {
    // The third case, and it used to fall through to `throw error` with the
    // raw unique violation. Two tabs press Ask Hello; the first wins; its
    // draft fails instantly on a provider 502 and the row settles before the
    // second tab's recovery read lands. There is now nothing to conflict
    // with, so the right answer is another insert — not a 500 carrying
    // "duplicate key value violates unique constraint".
    selectQueue = [[], []];          // nothing live, and nothing running either
    insertErrors = [DUP];            // the first insert lost to a row now gone
    const run = vi.fn().mockResolvedValue({ draft: DRAFT, attempts: 1, repaired: [] });

    const job = await startRoleDraft(OWNER, 'Sales Advisor', {
      run: run as never,
      now: () => NOW,
    });

    expect(job.id).toBe('draft-1');
    expect(calls.filter((c) => c.op === 'insert')).toHaveLength(2);
    // Nothing was expired — there was nothing to expire.
    expect(calls.some((c) => c.op === 'update' && c.payload?.error_reason === 'abandoned')).toBe(
      false,
    );
    await settle();
  });

  it('does not retry forever — one expiry, one retry', async () => {
    // If the second insert also fails the error is raised. A loop here would
    // spin against a constraint that is not going to change its mind.
    selectQueue = [
      [],
      [liveRow({ updated_at: new Date(NOW - ROLE_DRAFT_STALE_MS - 1).toISOString() })],
    ];
    insertErrors = [DUP, DUP];
    await expect(
      startRoleDraft(OWNER, 'Sales Advisor', { run: vi.fn() as never, now: () => NOW }),
    ).rejects.toMatchObject({ code: '23505' });
    expect(calls.filter((c) => c.op === 'insert')).toHaveLength(2);
  });

  it('RETURNS THE WINNER when a concurrent start beat it by microseconds', async () => {
    // Both requests read an empty table; one inserts first. Arriving second
    // should look exactly like arriving second — the job that now exists.
    selectQueue = [[], [liveRow({ id: 'winner' })]];
    insertErrors = [DUP];
    const job = await startRoleDraft(OWNER, 'Sales Advisor', {
      run: vi.fn() as never,
      now: () => NOW,
    });
    expect(job.id).toBe('winner');
    expect(calls.filter((c) => c.op === 'insert')).toHaveLength(1);
  });

  it('REFUSES rather than substituting when the live job is a DIFFERENT role', async () => {
    // The bug this replaced: returning the live job regardless of role put a
    // Sales Advisor JD and six Sales Advisor questions into a form headed
    // "Data Engineer", and on a fresh form nothing prompts before applying it.
    selectQueue = [[], [liveRow({ job_role: 'Sales Advisor' })]];
    insertErrors = [DUP];
    await expect(
      startRoleDraft(OWNER, 'Data Engineer', { run: vi.fn() as never, now: () => NOW }),
    ).rejects.toMatchObject({ name: 'RoleDraftBusyError', liveJobRole: 'Sales Advisor' });
  });

  it('refuses on the FIRST read too, without touching the table', async () => {
    // The same rule before the index is ever consulted.
    selectQueue = [[liveRow({ job_role: 'Sales Advisor' })]];
    await expect(
      startRoleDraft(OWNER, 'Data Engineer', { run: vi.fn() as never, now: () => NOW }),
    ).rejects.toBeInstanceOf(RoleDraftBusyError);
    expect(calls.some((c) => c.op === 'insert')).toBe(false);
  });

  it('keeps the STATUS filter on the recovery read', async () => {
    // `readRunningRow` promises the owner's RUNNING row. Without the filter
    // it can hand back a settled one — refusing a start with
    // `RoleDraftBusyError` naming a role that finished an hour ago.
    selectQueue = [[], [liveRow()]];
    insertErrors = [DUP];
    await startRoleDraft(OWNER, 'Sales Advisor', {
      run: vi.fn() as never,
      now: () => NOW,
    });
    const recoveryRead = calls.filter((c) => c.op === 'select').at(-1);
    expect(recoveryRead?.filters).toContainEqual(['status', 'running']);
    expect(recoveryRead?.filters).toContainEqual(['owner_id', OWNER]);
  });

  it('a NON-23505 insert failure is raised, not swallowed', async () => {
    selectQueue = [[]];
    insertErrors = [{ code: '08006', message: 'connection failure' }];
    await expect(
      startRoleDraft(OWNER, 'Sales Advisor', { run: vi.fn() as never, now: () => NOW }),
    ).rejects.toMatchObject({ code: '08006' });
    // No expiry write on an unrelated failure.
    expect(calls.some((c) => c.op === 'update' && c.payload?.error_reason === 'abandoned')).toBe(
      false,
    );
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

describe('the writes that can be lost silently', () => {
  // Both of these were added to make a silent loss visible, and both could be
  // deleted with the suite green — the stub discarded the column list, and
  // `updateResult` defaulted to `[]` so the warning fired on every write in
  // the file and nothing noticed. The observability was itself unobserved.

  it('SELECTS on the terminal write, so zero rows is detectable at all', async () => {
    const run = vi.fn().mockResolvedValue({ draft: DRAFT, attempts: 1, repaired: [] });
    await startRoleDraft(OWNER, 'Sales Advisor', { run: run as never });
    await settle();
    expect(finalWrite()?.selects).toContain('id');
  });

  it('LOOKS UP THE STATUS when the terminal write matched nothing', async () => {
    // Zero rows has two causes and only one is a problem: the operator
    // cancelled (normal), or a live worker's row was expired out from under
    // it and ten minutes of paid output just vanished. Reading the row is the
    // only way to tell them apart.
    updateResult = [];
    selectQueue = [[], { status: 'cancelled' }];
    const run = vi.fn().mockResolvedValue({ draft: DRAFT, attempts: 1, repaired: [] });
    await startRoleDraft(OWNER, 'Sales Advisor', { run: run as never });
    await settle();
    // The classification read happened, scoped to this draft.
    const classify = calls.filter((c) => c.op === 'select').at(-1);
    expect(classify?.selects).toContain('status');
    expect(classify?.filters).toContainEqual(['id', 'draft-1']);
  });

  it('LOGS a failed expiry — the one failure that reinstates the lockout', async () => {
    // If the expiry is a no-op the retry insert conflicts again and the
    // operator gets "Internal server error" on every press, with nothing
    // naming the expiry as the cause. This was the only write in the module
    // whose error was discarded.
    const now = Date.parse('2026-09-22T10:00:00Z');
    selectQueue = [
      [],
      [
        {
          id: 'stale-1',
          owner_id: OWNER,
          job_role: 'Sales Advisor',
          status: 'running',
          phase: null,
          draft: null,
          attempts: 1,
          repaired: [],
          error_reason: null,
          error_message: null,
          cancelled_at: null,
          updated_at: new Date(now - ROLE_DRAFT_STALE_MS - 1).toISOString(),
        },
      ],
    ];
    insertErrors = [{ code: '23505', message: 'duplicate key' }];
    updateError = new Error('permission denied');

    await startRoleDraft(OWNER, 'Sales Advisor', { run: vi.fn() as never, now: () => now });
    await settle();

    // The expiry was issued with its fences...
    const expiry = calls.find(
      (c) => c.op === 'update' && c.payload?.error_reason === 'abandoned',
    );
    expect(expiry).toBeDefined();
    expect(expiry?.filters.some(([k]) => k === 'updated_at<')).toBe(true);
    // ...and its failure was reported rather than discarded.
    expect(
      logged.some(
        (l) => l.level === 'error' && l.meta.error_category === 'role_draft_expire_stale',
      ),
    ).toBe(true);
  });

  it('logs the POSTGRES CODE, not the literal string "object"', async () => {
    // postgrest-js assigns the parsed JSON body straight to `error` and never
    // constructs an Error on this path, so `err instanceof Error ? err.name :
    // typeof err` evaluated to "object" for every database failure this
    // module can have — naming which write was lost and never why. 23502,
    // 23505, 42501 and PGRST204 are four different problems.
    updateError = { code: '42501', message: 'permission denied' };
    const run = vi.fn(async (_role: string, opts: any) => {
      opts.onProgress({ phase: 'drafting', attempt: 1, maxAttempts: 3 });
      return { draft: DRAFT, attempts: 1, repaired: [] };
    });
    await startRoleDraft(OWNER, 'Sales Advisor', { run: run as never });
    await settle();
    expect(logged.some((l) => l.meta.error_type === '42501')).toBe(true);
    expect(logged.some((l) => l.meta.error_type === 'object')).toBe(false);
  });
});

describe('a database failure is never reported as an absence', () => {
  // Three reads, one rule. A review deleted each `if (error) throw` in turn
  // and the suite stayed green every time — `selectError` was declared and
  // never used. Each collapse tells the caller something false:
  //
  //   readRoleDraft   -> 404 "no such draft" for a pooler reset
  //   readActiveRoleDraft -> "nothing is running", so a refresh abandons a
  //                          live job and the next start races the index
  //   cancelRoleDraft -> `{cancelled:false}`, which the client reads as a
  //                      lost race and says nothing, while v4-pro bills on

  it('readRoleDraft THROWS rather than answering 404', async () => {
    selectError = new Error('pooler reset');
    await expect(readRoleDraft(OWNER, 'draft-1')).rejects.toThrow('pooler reset');
  });

  it('readActiveRoleDraft THROWS rather than answering "nothing running"', async () => {
    selectError = new Error('pooler reset');
    await expect(readActiveRoleDraft(OWNER)).rejects.toThrow('pooler reset');
  });

  it('cancelRoleDraft THROWS rather than answering "already finished"', async () => {
    // `false` means "there was no running job" — a race nobody is to blame
    // for. A failed write means the opposite: the job IS running and
    // `cancelled_at` was never written.
    updateError = new Error('pooler reset');
    await expect(cancelRoleDraft(OWNER, 'draft-1')).rejects.toThrow('pooler reset');
  });
});

describe('a settled row advertises no phase', () => {
  it('clears `phase` on success', async () => {
    // The contract says phase is null once the job settles. A settled row
    // still carrying "checking" makes a finished job look busy to anything
    // reading the table.
    const run = vi.fn().mockResolvedValue({ draft: DRAFT, attempts: 1, repaired: [] });
    await startRoleDraft(OWNER, 'Sales Advisor', { run: run as never });
    await settle();
    expect(finalWrite()?.payload).toHaveProperty('phase', null);
  });

  it('clears `phase` on failure too', async () => {
    const run = vi.fn().mockRejectedValue(new Error('socket hang up'));
    await startRoleDraft(OWNER, 'Sales Advisor', { run: run as never });
    await settle();
    expect(finalWrite()?.payload).toHaveProperty('phase', null);
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
