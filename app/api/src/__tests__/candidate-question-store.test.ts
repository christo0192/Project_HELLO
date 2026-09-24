/**
 * The service-role adapter: does it ask the right tables for the right
 * columns, and write the row `0103`'s CHECK constraints will accept?
 *
 * THE MOCK REFUSES AN UNKNOWN RELATION, and that is the whole reason this file
 * exists rather than being folded into the job tests. A route in this very
 * package shipped asking for a table called `sessions` — the real one is
 * `call_sessions` — and every test passed because the mock answered "0 rows"
 * to anything, while production answered 500 on every request. A mock that
 * agrees with the code cannot find that; one that refuses loudly can.
 *
 * The COLUMN lists are asserted for the same reason one step down: a `select`
 * missing `candidate_id` fails silently as "no résumé", which looks exactly
 * like a candidate who has not been parsed yet.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: vi.fn() },
  RESUME_BUCKET: 'resumes_v2',
}));

const { createCandidateQuestionStore } = await import('../lib/candidate-question-store.js');
const { templateFingerprint } = await import('../lib/candidate-questions.js');
const { supabase } = await import('../lib/supabase.js');

/** Every relation `0103` and its neighbours actually have. */
const KNOWN_TABLES = [
  'phone_engagements',
  'roles',
  'candidates',
  'candidate_screening_questions',
];

interface Call {
  table: string;
  op: 'select' | 'upsert';
  columns?: string;
  filters: Array<[string, unknown]>;
  /** `.is(col, value)` — how the ACTIVE cycle is selected. */
  nulls: Array<[string, unknown]>;
  order?: [string, boolean];
  limit?: number;
  payload?: Record<string, unknown>;
  options?: Record<string, unknown>;
}

let calls: Call[];
let rows: Record<string, unknown | null>;
let failOn: string | null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function chain(table: string): any {
  if (!KNOWN_TABLES.includes(table)) {
    throw new Error(
      `PGRST205: relation "screening_v2.${table}" does not exist — ` +
        'the store asked for a table this schema has never had',
    );
  }
  const call: Call = { table, op: 'select', filters: [], nulls: [] };
  calls.push(call);
  const result = {
    data: failOn === table ? null : (rows[table] ?? null),
    error: failOn === table ? { code: 'XX000', message: 'boom' } : null,
  };
  const api = {
    select: (columns: string) => {
      call.columns = columns;
      return api;
    },
    upsert: (payload: Record<string, unknown>, options?: Record<string, unknown>) => {
      call.op = 'upsert';
      call.payload = payload;
      call.options = options;
      return Promise.resolve({ error: result.error });
    },
    eq: (column: string, value: unknown) => {
      call.filters.push([column, value]);
      return api;
    },
    is: (column: string, value: unknown) => {
      call.nulls.push([column, value]);
      return api;
    },
    order: (column: string, opts?: { ascending?: boolean }) => {
      call.order = [column, opts?.ascending !== false];
      return api;
    },
    limit: (n: number) => {
      call.limit = n;
      return api;
    },
    maybeSingle: () => Promise.resolve(result),
  };
  return api;
}

beforeEach(() => {
  calls = [];
  failOn = null;
  rows = {
    phone_engagements: { id: 'eng-1', role_id: 'role-1', candidate_id: 'cand-1', state: 'eligible' },
    roles: {
      title: 'Inside Sales Advisor',
      jd: 'Sell to enterprise buyers.',
      required_skills: ['Outbound calling', 42],
      screening_template: [
        { id: 'q1', question: 'Tell me about yourself?', weight: 1, mandatory: true, category: 'introduction' },
        { id: 'q2', question: 'What does your day look like?', weight: 2, category: 'profile_relevance' },
        { bad: 'row with no id or question' },
      ],
    },
    candidates: { parsed: { name: 'Asha' } },
    candidate_screening_questions: null,
  };
  (supabase.from as ReturnType<typeof vi.fn>).mockImplementation(chain);
});

describe('loadContext', () => {
  it('reads only tables that exist, and asks each for what it needs', async () => {
    const context = await createCandidateQuestionStore(supabase as never).loadContext('link-1');

    expect(context).not.toBeNull();
    expect(calls.map((c) => c.table)).toEqual([
      'phone_engagements',
      'roles',
      'candidates',
      'candidate_screening_questions',
    ]);
    // The engagement read must carry `candidate_id`: without it there is no
    // résumé, which looks identical to an unparsed candidate.
    expect(calls[0].columns).toContain('candidate_id');
    expect(calls[0].columns).toContain('state');
    expect(calls[0].columns).toContain('role_id');
    expect(calls[0].filters).toEqual([['application_link_id', 'link-1']]);
    // EVERY read's filter is asserted, not just the first and last: a role read
    // keyed on the engagement id, or a candidate read keyed on the role, both
    // return null and look exactly like "this candidate has no résumé".
    expect(calls[1].columns).toContain('screening_template');
    expect(calls[1].columns).toContain('jd');
    expect(calls[1].columns).toContain('required_skills');
    expect(calls[1].columns).toContain('title');
    expect(calls[1].filters).toEqual([['id', 'role-1']]);
    expect(calls[2].columns).toContain('parsed');
    expect(calls[2].filters).toEqual([['id', 'cand-1']]);
    expect(calls[3].filters).toEqual([['engagement_id', 'eng-1']]);
  });

  it('reads the engagement ONCE — the candidate comes off the same row', async () => {
    await createCandidateQuestionStore(supabase as never).loadContext('link-1');
    expect(calls.filter((c) => c.table === 'phone_engagements')).toHaveLength(1);
  });

  it('SELECTS THE ACTIVE CYCLE — an application can hold three engagements', async () => {
    // `uq_phone_engagements_application` was DROPPED in `0057`; the key is now
    // `(application_link_id, cycle_number)` for up to three rescreens. Without
    // the active-cycle filter, `maybeSingle()` over the link alone returns
    // PGRST116 for every rescreened candidate — the job fails, retries, fails
    // and dead-letters, and the feature is permanently dead for exactly the
    // population a fresh set of questions helps most.
    await createCandidateQuestionStore(supabase as never).loadContext('link-1');
    const read = calls[0];
    expect(read.nulls, 'the read must be scoped to the non-terminal cycle')
      .toContainEqual(['terminal_at', null]);
    expect(read.limit, 'the read must not assume one row').toBe(1);
    // Newest cycle first, so the one active row is the one taken.
    expect(read.order).toEqual(['cycle_number', false]);
  });

  it('projects the template, dropping rows that are not questions', async () => {
    const context = await createCandidateQuestionStore(supabase as never).loadContext('link-1');
    expect(context?.template.map((q) => q.id)).toEqual(['q1', 'q2']);
    expect(context?.template[0]).toEqual({
      id: 'q1',
      question: 'Tell me about yourself?',
      weight: 1,
      mandatory: true,
      category: 'introduction',
    });
    // A non-string skill would reach the prompt as `undefined`.
    expect(context?.requiredSkills).toEqual(['Outbound calling']);
  });

  it('marks every terminal engagement state terminal, and no other', async () => {
    const store = createCandidateQuestionStore(supabase as never);
    for (const state of ['completed', 'abandoned_no_answer', 'opted_out', 'wrong_number', 'failed', 'cancelled']) {
      rows.phone_engagements = { id: 'eng-1', role_id: 'role-1', candidate_id: 'c', state };
      expect((await store.loadContext('link-1'))?.engagementTerminal, state).toBe(true);
    }
    for (const state of ['pending_prereqs', 'eligible', 'scheduled', 'dialing', 'in_call', 'reconnecting', 'awaiting_retry']) {
      rows.phone_engagements = { id: 'eng-1', role_id: 'role-1', candidate_id: 'c', state };
      expect((await store.loadContext('link-1'))?.engagementTerminal, state).toBe(false);
    }
  });

  it('returns null when the engagement, the role or the role link is missing', async () => {
    const store = createCandidateQuestionStore(supabase as never);
    rows.phone_engagements = null;
    expect(await store.loadContext('link-1')).toBeNull();

    rows.phone_engagements = { id: 'eng-1', role_id: null, candidate_id: 'c', state: 'eligible' };
    expect(await store.loadContext('link-1')).toBeNull();

    rows.phone_engagements = { id: 'eng-1', role_id: 'role-1', candidate_id: 'c', state: 'eligible' };
    rows.roles = null;
    expect(await store.loadContext('link-1')).toBeNull();
  });

  it('tolerates a candidate with no parse rather than failing the job', async () => {
    rows.candidates = { parsed: null };
    const context = await createCandidateQuestionStore(supabase as never).loadContext('link-1');
    // The generator decides whether that is enough to work from; the store's
    // job is to report it truthfully.
    expect(context?.resume).toBeNull();
  });

  it('carries an existing row through, status and hash', async () => {
    rows.candidate_screening_questions = { status: 'ready', template_hash: 'fnv1a32:abcd1234:8' };
    const context = await createCandidateQuestionStore(supabase as never).loadContext('link-1');
    expect(context?.existing).toEqual({ status: 'ready', templateHash: 'fnv1a32:abcd1234:8' });
  });

  it('THROWS on a read error rather than reporting an empty context', async () => {
    // An empty context is indistinguishable from "this candidate has no role",
    // and silently means "never personalise this call". A database fault must
    // reach the queue, which can retry it.
    failOn = 'roles';
    await expect(
      createCandidateQuestionStore(supabase as never).loadContext('link-1'),
    ).rejects.toThrow(/role_read_error/);
  });
});

describe('currentTemplateFingerprint', () => {
  it('fingerprints the role template as it stands RIGHT NOW', async () => {
    const fp = await createCandidateQuestionStore(supabase as never)
      .currentTemplateFingerprint('role-1');
    const read = calls.find((c) => c.table === 'roles');
    expect(read?.filters).toEqual([['id', 'role-1']]);
    expect(fp).toMatch(/^fnv1a32:[0-9a-f]{8}:2$/);
    // Computed over the SAME projection `loadContext` uses, so the two
    // fingerprints are comparable by construction rather than by coincidence.
    const context = await createCandidateQuestionStore(supabase as never).loadContext('link-1');
    expect(fp).toBe(templateFingerprint(context!.template));
  });

  it('answers NULL rather than a wrong hash when the role cannot be read', async () => {
    // "Do not know" must not read as "changed": the caller writes anyway,
    // because refusing on a transient read error throws away a generation that
    // is almost certainly still correct.
    failOn = 'roles';
    expect(
      await createCandidateQuestionStore(supabase as never).currentTemplateFingerprint('role-1'),
    ).toBeNull();
  });
});

describe('writing the outcome', () => {
  const questions = [{ id: 'q1', question: 'Tell me about yourself?', weight: 1 }];

  it('writes a ready row that `0103` will accept', async () => {
    await createCandidateQuestionStore(supabase as never).writeReady({
      engagementId: 'eng-1',
      roleId: 'role-1',
      questions,
      templateHash: 'fnv1a32:abcd1234:1',
      model: 'deepseek-v4-pro',
    });
    const call = calls.find((c) => c.op === 'upsert');
    expect(call?.table).toBe('candidate_screening_questions');
    expect(call?.options).toEqual({ onConflict: 'engagement_id' });
    expect(call?.payload).toMatchObject({
      engagement_id: 'eng-1',
      role_id: 'role-1',
      status: 'ready',
      questions,
      template_hash: 'fnv1a32:abcd1234:1',
      model: 'deepseek-v4-pro',
      error_reason: null,
    });
    // `chk_candidate_questions_ready` refuses a ready row with no questions.
    expect(Array.isArray(call?.payload?.questions)).toBe(true);
    expect((call?.payload?.questions as unknown[]).length).toBeGreaterThan(0);
    expect(call?.payload?.generated_at).toEqual(expect.any(String));
  });

  it('CLEARS the previous questions when it records a failure', async () => {
    // Nothing reads them — `0103` keys on `status = 'ready'` — but a failed
    // row still holding last week's questions makes the table lie to the
    // operator it exists for.
    await createCandidateQuestionStore(supabase as never).writeFailed({
      engagementId: 'eng-1',
      roleId: 'role-1',
      reason: 'no_resume',
    });
    const call = calls.find((c) => c.op === 'upsert');
    expect(call?.payload).toMatchObject({
      status: 'failed',
      questions: null,
      template_hash: null,
      error_reason: 'no_resume',
      generated_at: null,
    });
  });

  it('throws when the write fails', async () => {
    failOn = 'candidate_screening_questions';
    await expect(
      createCandidateQuestionStore(supabase as never).writeReady({
        engagementId: 'eng-1',
        roleId: 'role-1',
        questions,
        templateHash: 'h',
        model: 'm',
      }),
    ).rejects.toThrow(/write_error/);
  });
});
