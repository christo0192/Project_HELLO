/**
 * `lib/phone-runtime/read.ts` — the SQL read seam, driven against a recording
 * fake PostgREST builder.
 *
 * WHY THIS SUITE EXISTS SEPARATELY FROM THE STRUCTURAL ONE
 * `phone-runtime-structural.test.ts` proves things about the SOURCE TEXT: that
 * `phone_e164` appears in this file and nowhere else in the package, that every
 * column list is a plain literal without a star, that every thrown error is a
 * bare code. None of that can see what the reader actually ASKS the database,
 * nor what it does with a row that comes back malformed. This file is the only
 * place in the repository that reads a candidate's `phone_e164` out of SQL, so
 * its behaviour deserves to be executed, not merely grepped.
 *
 * ── ON COMMITTED PHONE LITERALS ───────────────────────────────────────
 * India publishes no reserved documentation range, so a plausible-looking
 * fixture is indistinguishable from a real subscriber's number, and the phone
 * lane's structural suites assert that no committed literal in the lane matches
 * the substrate's own gate `^\+91[6-9][0-9]{9}$`. This suite therefore commits
 * NO such literal: the one dialable value it needs is ASSEMBLED at runtime from
 * fragments (`DIALABLE`, below), and the sentinel used to prove a number never
 * travels is deliberately not number-shaped at all.
 *
 * No network, no database, no real Supabase client.
 */

import { describe, it, expect } from 'vitest';
import { inspect } from 'node:util';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  createPhoneRuntimeReader,
  boundedRowLimit,
  PHONE_DUE_STATES,
  PHONE_RUNTIME_MAX_ROWS,
  PHONE_SESSION_MODE,
  REUSABLE_SESSION_STATUSES,
} from '../lib/phone-runtime/read.js';
import { phoneRoomName } from '../integrations/livekit-phone-dial/phone-room.js';

// ════════════════════════════════════════════════════════════════════
//  A recording fake PostgREST builder
//
//  Modelled on `phone-api-read-stores.test.ts`'s `fakeClient` — same
//  chainable-recorder-plus-thenable shape — widened only where this seam
//  needs it: responses are keyed BY TABLE (this reader touches five), and
//  `.is`/`.or` join the recorded operator set.
// ════════════════════════════════════════════════════════════════════

interface RecordedCall {
  readonly op: string;
  readonly args: readonly unknown[];
}

/** A raw PostgREST row, as the fake hands it back. */
interface Row {
  readonly [key: string]: unknown;
}

interface RecordedQuery {
  readonly table: string;
  readonly columns: string;
  readonly calls: RecordedCall[];
}

interface FakeResponse {
  readonly data?: unknown;
  readonly error?: unknown;
}

/** Every builder method this reader uses, plus the ones a sibling might. */
const BUILDER_OPS = [
  'select', 'is', 'in', 'or', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte',
  'not', 'filter', 'order', 'limit', 'range', 'maybeSingle', 'single',
] as const;

function fakeClient(responses: Readonly<Record<string, FakeResponse | FakeResponse[]>>) {
  const queries: RecordedQuery[] = [];
  const cursor = new Map<string, number>();
  let fromCalls = 0;

  function answerFor(table: string): { data: unknown; error: unknown } {
    const entry = responses[table];
    const at = cursor.get(table) ?? 0;
    cursor.set(table, at + 1);
    const picked = Array.isArray(entry) ? entry[at] : entry;
    return { data: picked?.data ?? [], error: picked?.error ?? null };
  }

  const client = {
    from(table: string) {
      fromCalls += 1;
      return {
        select(columns: string) {
          const record: RecordedQuery = { table, columns, calls: [] };
          queries.push(record);
          const builder: Record<string, unknown> = {};
          for (const op of BUILDER_OPS) {
            builder[op] = (...args: unknown[]): unknown => {
              record.calls.push({ op, args });
              return builder;
            };
          }
          // Thenable, exactly as a PostgREST builder is: awaiting it runs it.
          //
          // ── THE BOUND AND THE CLOCK ARE HONOURED, NOT MERELY RECORDED ──
          // H-2. A fake that returned every configured row whatever `.limit()`
          // said could not tell a reconnect batch capped at `limit - 1` from
          // one capped at `limit` — which is exactly the head-of-line-blocking
          // distinction this suite has to be able to fail on. And a fake that
          // ignored `.lte('updated_at', ...)` could not tell a reconnect read
          // that carries the backoff clock from one that carries none, which is
          // the whole of the bug. Both are applied here, and nothing else is:
          // `.or`, `.eq` and `.in` are still recorded-only, so the assertions
          // about them stay assertions about the QUERY, not about this fake.
          builder.then = (
            resolve: (v: { data: unknown; error: unknown }) => unknown,
          ): unknown => {
            const answer = answerFor(table);
            let data = answer.data;
            if (Array.isArray(data)) {
              for (const call of record.calls) {
                if (call.op !== 'lte') continue;
                const [column, ceiling] = call.args as [string, string];
                data = (data as Row[]).filter((row) => {
                  const value = row?.[column];
                  // SQL semantics: `null <= x` is unknown, so the row is out.
                  return typeof value === 'string' && value <= ceiling;
                });
              }
              const bound = record.calls.find((c) => c.op === 'limit')?.args[0];
              if (typeof bound === 'number') data = (data as unknown[]).slice(0, bound);
            }
            return resolve({ data, error: answer.error });
          };
          return builder;
        },
      };
    },
  };

  return {
    client: client as unknown as SupabaseClient,
    queries,
    fromCalls: (): number => fromCalls,
    only(table: string): RecordedQuery {
      const hits = queries.filter((q) => q.table === table);
      expect(hits.length, `expected exactly one read of ${table}`).toBe(1);
      return hits[0];
    },
    /**
     * Every recorded read of a table, in issue order.
     *
     * `listDueEngagements` issues TWO reads of `phone_engagements` — the
     * reconnect batch and then the main batch (M-3) — so `only()` is not the
     * right assertion for that table any more. It stays for the tables that
     * really are read once, and the due assertions below name the count
     * explicitly instead, in both directions.
     */
    all(table: string): RecordedQuery[] {
      return queries.filter((q) => q.table === table);
    },
    /** The two due reads, asserted to be exactly two, reconnect batch first. */
    dueQueries(): { reconnects: RecordedQuery; main: RecordedQuery; both: RecordedQuery[] } {
      const hits = queries.filter((q) => q.table === 'phone_engagements');
      expect(hits.length, 'expected exactly two reads of phone_engagements').toBe(2);
      return { reconnects: hits[0], main: hits[1], both: hits };
    },
  };
}

/** The arguments of the first `op` call on a recorded query, or undefined. */
function argsOf(query: RecordedQuery, op: string): readonly unknown[] | undefined {
  return query.calls.find((c) => c.op === op)?.args;
}

function allArgsOf(query: RecordedQuery, op: string): Array<readonly unknown[]> {
  return query.calls.filter((c) => c.op === op).map((c) => c.args);
}

/**
 * Every rendering by which a value normally reaches a log line or an operator's
 * screen. A leak assertion that checked only `.message` would miss `details`
 * riding on a `cause`, an own property, or Node's inspect output.
 */
function renderings(value: unknown): string {
  const own = value instanceof Error
    ? JSON.stringify(value, Object.getOwnPropertyNames(value))
    : JSON.stringify(value);
  return [
    String(value),
    own ?? '',
    inspect(value, { depth: null, showHidden: true }),
    value instanceof Error ? (value.stack ?? '') : '',
  ].join('\n');
}

// ════════════════════════════════════════════════════════════════════
//  Fixtures
// ════════════════════════════════════════════════════════════════════

const NOW_ISO = '2026-08-24T03:30:00.000Z';

/**
 * The reconnect backoff the pass runs with, in seconds.
 *
 * H-2 made this an INPUT to `listDueEngagements` rather than something the
 * reader could derive: a reconnect's due time is `updated_at + backoff`,
 * `next_eligible_at` does not carry it, and the reconnect batch is bounded
 * before any in-process filter runs — so the clock has to be in the SQL.
 */
const RECONNECT_BACKOFF_SECONDS = 120;

/**
 * The instant the reconnect batch must filter `updated_at` at, COMPUTED from
 * the two inputs rather than written out as a literal. A literal would go on
 * agreeing with a reader that had stopped subtracting the backoff at all, as
 * long as somebody remembered to edit the literal too.
 */
function reconnectDueBefore(nowIso: string, backoffSeconds: number): string {
  return new Date(Date.parse(nowIso) - backoffSeconds * 1_000).toISOString();
}

/**
 * A value the substrate's `^\+91[6-9][0-9]{9}$` gate accepts, ASSEMBLED rather
 * than committed — see the header. No fragment below is itself dialable, and
 * the concatenation exists only inside a running process.
 */
const DIALABLE = ['+9', '1', '70', '1234', '5678'].join('');

/**
 * The value used to prove a number never travels. Deliberately NOT
 * number-shaped: it must not match `/\+91[6-9]\d{9}/`, both because the lane
 * forbids a committed dialable literal and because a sentinel that looked like
 * a number would be indistinguishable from a real leak in a failure message.
 */
const NUMBER_SENTINEL = 'SENTINEL-CANDIDATE-NUMBER-MUST-NOT-TRAVEL';

/**
 * A PostgREST error as the driver actually shapes one: a message naming the
 * failing relation, plus `details` and `hint`, plus — the reason this matters —
 * a row value. None of it may reach a caller.
 */
function pgError(extra: Record<string, unknown> = {}) {
  return {
    code: '42501',
    message: 'permission denied for relation: SENTINEL-STATEMENT',
    details: 'SENTINEL-DETAILS-FAILING-ROW',
    hint: 'SENTINEL-HINT-GRANT-SELECT',
    row: 'SENTINEL-ROW-VALUE',
    ...extra,
  };
}

const PG_ERROR_SENTINELS = [
  'SENTINEL-STATEMENT',
  'SENTINEL-DETAILS-FAILING-ROW',
  'SENTINEL-HINT-GRANT-SELECT',
  'SENTINEL-ROW-VALUE',
  '42501',
];

const GOOD_DUE_ROW = {
  id: 'e-good',
  state: 'eligible',
  candidate_id: 'c-good',
  role_id: 'r1',
  session_id: null,
  next_eligible_at: null,
  no_answer_attempts: 2,
  updated_at: '2026-08-23T10:00:00.000Z',
};

// ════════════════════════════════════════════════════════════════════
//  A. listDueEngagements
// ════════════════════════════════════════════════════════════════════

describe('A. listDueEngagements — the query it actually issues', () => {
  it('A1: BOTH due reads share the column list, the terminal filter and the ordering — the state filter, the clock filter and the bound are what differ', async () => {
    const fake = fakeClient({ phone_engagements: { data: [GOOD_DUE_ROW] } });
    await createPhoneRuntimeReader(fake.client).listDueEngagements({
        nowIso: NOW_ISO,
        limit: 3,
        reconnectBackoffSeconds: RECONNECT_BACKOFF_SECONDS,
      });

    const { reconnects, main, both } = fake.dueQueries();

    for (const q of both) {
      // The declared list, spelled out. Not `*`: a star would silently start
      // fetching every future column of a table that holds candidate-linked
      // scheduling state.
      expect(q.columns).toBe(
        'id,state,candidate_id,role_id,session_id,next_eligible_at,no_answer_attempts,updated_at',
      );
      expect(q.columns).not.toContain('*');
      // And the number is NOT among them — this read decides candidacy only.
      expect(q.columns).not.toContain('phone_e164');

      // `terminal_at is null`: a finished engagement is never due again.
      expect(argsOf(q, 'is')).toEqual(['terminal_at', null]);

      expect(argsOf(q, 'order')).toEqual(['updated_at', { ascending: true }]);
      // BOTH batches are bounded. An unbounded reconnect read would be a
      // second, uncapped way into the same table.
      const bound = argsOf(q, 'limit')?.[0];
      expect(bound, 'a due read was issued with no bound at all').toBeDefined();
      expect(Number.isInteger(bound)).toBe(true);
      expect(bound as number).toBeGreaterThanOrEqual(1);
    }

    // ── AND THE BOUNDS ARE NOT THE SAME BOUND ─────────────────────────
    // H-2. The ordinary batch gets the caller's whole limit; the reconnect
    // batch gets at most `limit - 1`, so the ordinary batch can never be
    // starved to zero by a queue of reconnects. Priority is not precedence.
    expect(argsOf(main, 'limit')).toEqual([3]);
    expect(argsOf(reconnects, 'limit')).toEqual([2]);

    // ── THE PRIORITY READ COMES FIRST AND IS NARROWED TO ONE STATE ────
    // M-3. `updated_at asc` sorts a row that JUST entered `reconnecting`
    // LAST, behind any three eligible rows, so the one due row with a human
    // on the line had the lowest priority in the system. The fix is a second
    // bounded read merged AHEAD, and the order of issue is what makes it a
    // priority rather than a duplicate.
    expect(argsOf(reconnects, 'eq')).toEqual(['state', 'reconnecting']);
    expect(argsOf(reconnects, 'in'), 'the reconnect batch must not widen to every due state')
      .toBeUndefined();

    // Exactly the three due states on the MAIN batch — `dialing` and
    // `in_call` are absent deliberately: a live conversation is not due for
    // another one.
    const inArgs = argsOf(main, 'in');
    expect(inArgs?.[0]).toBe('state');
    expect(inArgs?.[1]).toEqual(['eligible', 'reconnecting', 'scheduled']);
    expect(argsOf(main, 'eq'), 'the main batch must not be narrowed to one state')
      .toBeUndefined();
    // ...and the exported constant is that same set, so the assertion above
    // cannot drift away from the code by editing only one of them.
    expect([...PHONE_DUE_STATES]).toEqual(['eligible', 'reconnecting', 'scheduled']);
  });

  it('A2: THE CLOCK PREDICATE — one `or` on the ORDINARY batch, carrying all three disjuncts including the exact nowIso passed in', async () => {
    // WHY EACH DISJUNCT IS THERE:
    //
    // `next_eligible_at.lte.<now>` and `next_eligible_at.is.null` are the
    // clock, and applying it IN SQL rather than only after the read is
    // load-bearing because the batch is BOUNDED — `dueLimit` defaults to 3 —
    // and ordered `updated_at asc`. Without the predicate, three rows whose
    // `next_eligible_at` is hours away would be selected by the ordering,
    // occupy the whole batch, be discarded by the in-process clock check, and
    // then be selected again on the next pass, forever. Rows that are genuinely
    // due would never be reached. A filter applied after the read can OBSERVE
    // that starvation; it cannot cure it, because the rows it wants were never
    // fetched.
    //
    // `state.eq.reconnecting` is the exemption, and it is why this is one `or`
    // rather than three chained filters. A reconnect's due time is NOT in
    // `next_eligible_at` at all: 0042 leaves the reconnect backoff to a worker
    // clock, so it is derived from `updated_at + reconnectBackoffSeconds`.
    // On THIS batch — which selects all three due states — filtering
    // reconnects on a column that does not carry their due time would hide
    // every reconnect that also reached the ordinary read, so the exemption is
    // still correct here and is asserted here.
    //
    // What CHANGED (H-2): the same disjunct is trivially TRUE for every row of
    // the reconnect-only read, so on THAT batch this predicate is no filter at
    // all. It has moved to a real `updated_at` ceiling there — see A9/A10.
    const fake = fakeClient({ phone_engagements: { data: [] } });
    await createPhoneRuntimeReader(fake.client).listDueEngagements({
      nowIso: NOW_ISO,
      limit: 3,
      reconnectBackoffSeconds: RECONNECT_BACKOFF_SECONDS,
    });

    const { reconnects, main } = fake.dueQueries();

    const orArgs = argsOf(main, 'or');
    expect(orArgs, 'no `.or()` clock predicate was applied to the ordinary batch').toBeDefined();
    const predicate = String(orArgs?.[0]);

    expect(predicate).toContain('state.eq.reconnecting');
    expect(predicate).toContain('next_eligible_at.is.null');
    expect(predicate).toContain(`next_eligible_at.lte.${NOW_ISO}`);
    // The exact instant the caller passed, not a re-derived one: a reader
    // that called `new Date()` itself would drift from the clock the rest
    // of the pass reasons with.
    expect(predicate).toContain(NOW_ISO);
    // The whole predicate, spelled out, in order — the operator sequence is a
    // pin, not a smoke test. An extra disjunct, a reordering, or a dropped
    // term all fail here.
    expect(predicate).toBe(
      `state.eq.reconnecting,next_eligible_at.is.null,next_eligible_at.lte.${NOW_ISO}`,
    );
    expect(allArgsOf(main, 'or')).toHaveLength(1);

    // ...and EXACTLY ONE `or` is issued in the whole pass. Two copies of a
    // clock rule are two things that can drift; and the copy that used to sit
    // on the reconnect batch was worse than a duplicate, it was a no-op.
    const orsInPass = fake.dueQueries().both.flatMap((q) => allArgsOf(q, 'or'));
    expect(orsInPass).toHaveLength(1);
    expect(argsOf(reconnects, 'or')).toBeUndefined();
  });

  it('A2b: a different nowIso moves BOTH filters — the ordinary predicate and the reconnect ceiling', async () => {
    const other = '2026-01-01T00:00:00.000Z';
    const fake = fakeClient({ phone_engagements: { data: [] } });
    await createPhoneRuntimeReader(fake.client).listDueEngagements({
      nowIso: other,
      limit: 3,
      reconnectBackoffSeconds: RECONNECT_BACKOFF_SECONDS,
    });
    const { reconnects, main } = fake.dueQueries();
    expect(String(argsOf(main, 'or')?.[0])).toContain(`next_eligible_at.lte.${other}`);
    // The reconnect ceiling is derived from the SAME clock, one backoff back.
    expect(argsOf(reconnects, 'lte')).toEqual([
      'updated_at',
      reconnectDueBefore(other, RECONNECT_BACKOFF_SECONDS),
    ]);
    // ...and it is genuinely a different instant from the NOW_ISO the rest of
    // this suite uses, so neither assertion can be satisfied by a baked-in one.
    expect(reconnectDueBefore(other, RECONNECT_BACKOFF_SECONDS))
      .not.toBe(reconnectDueBefore(NOW_ISO, RECONNECT_BACKOFF_SECONDS));
  });

  it('A3: the limit handed to `.limit()` is BOUNDED whatever the caller asks for', async () => {
    const cases: Array<{ asked: number; expected: number; why: string }> = [
      { asked: 1_000_000_000, expected: PHONE_RUNTIME_MAX_ROWS, why: 'absurdly large clamps to the ceiling' },
      { asked: PHONE_RUNTIME_MAX_ROWS + 1, expected: PHONE_RUNTIME_MAX_ROWS, why: 'one over the ceiling clamps' },
      { asked: 0, expected: 1, why: 'zero would be a read that can never dial' },
      { asked: -1, expected: 1, why: 'negative is meaningless to PostgREST' },
      { asked: Number.NaN, expected: 1, why: 'NaN would serialize as `limit=NaN`' },
      { asked: Number.POSITIVE_INFINITY, expected: 1, why: 'non-finite is refused, not clamped' },
      { asked: 2.9, expected: 2, why: 'a fractional limit is floored, never rounded up' },
      { asked: 3, expected: 3, why: 'the ordinary case passes through untouched' },
    ];

    for (const { asked, expected, why } of cases) {
      const fake = fakeClient({ phone_engagements: { data: [] } });
      await createPhoneRuntimeReader(fake.client).listDueEngagements({
        nowIso: NOW_ISO,
        limit: asked,
        reconnectBackoffSeconds: RECONNECT_BACKOFF_SECONDS,
      });
      // BOTH reads are bounded by the SAME clamped value — a reconnect batch
      // that took the caller's raw number would be an unbounded second read of
      // the same table — except that the reconnect batch reserves at most
      // `limit - 1` slots (H-2), and at a clamped limit of 1 that reservation
      // is zero, so no reconnect read is issued at all.
      const reads = fake.all('phone_engagements');
      expect(reads.length, `${why}: wrong number of due reads`)
        .toBe(expected === 1 ? 1 : 2);

      const main = reads[reads.length - 1];
      expect(argsOf(main, 'in')?.[0], `${why}: the last read is not the ordinary batch`)
        .toBe('state');
      expect(argsOf(main, 'limit')?.[0], why).toBe(expected);

      if (expected !== 1) {
        const reconnects = reads[0];
        expect(argsOf(reconnects, 'eq')).toEqual(['state', 'reconnecting']);
        expect(argsOf(reconnects, 'limit')?.[0], `${why}: reconnect slots`)
          .toBe(expected - 1);
      }

      for (const q of reads) {
        // Whatever the case, the value that reaches the driver is a sane integer.
        const applied = argsOf(q, 'limit')?.[0];
        expect(Number.isInteger(applied)).toBe(true);
        expect(applied as number).toBeGreaterThanOrEqual(1);
        expect(applied as number).toBeLessThanOrEqual(PHONE_RUNTIME_MAX_ROWS);
      }
      expect(boundedRowLimit(asked)).toBe(expected);
    }
  });

  it('A4: a PostgREST error becomes a bare code and carries NONE of the driver payload', async () => {
    const fake = fakeClient({ phone_engagements: { error: pgError({ phone_e164: NUMBER_SENTINEL }) } });
    const reader = createPhoneRuntimeReader(fake.client);

    const thrown = await reader
      .listDueEngagements({
        nowIso: NOW_ISO,
        limit: 3,
        reconnectBackoffSeconds: RECONNECT_BACKOFF_SECONDS,
      })
      .then(() => null, (e: unknown) => e);

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('phone_runtime_due_read_error');

    // A PostgREST error carries the failing statement and can carry row values.
    // None of it may propagate — not through the message, not through a
    // `cause`, not through an own property, not through Node's inspect output.
    const rendered = renderings(thrown);
    for (const sentinel of [...PG_ERROR_SENTINELS, NUMBER_SENTINEL]) {
      expect(rendered, `driver payload ${sentinel} escaped the sanitized error`)
        .not.toContain(sentinel);
    }
    expect((thrown as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it('A5: a malformed row is DROPPED, and does not poison the good row beside it', async () => {
    const bad: Array<{ label: string; row: Record<string, unknown> }> = [
      { label: 'missing id', row: { state: 'eligible', candidate_id: 'c1' } },
      { label: 'null id', row: { id: null, state: 'eligible', candidate_id: 'c1' } },
      { label: 'non-string id', row: { id: 12345, state: 'eligible', candidate_id: 'c1' } },
      { label: 'empty-string id', row: { id: '', state: 'eligible', candidate_id: 'c1' } },
      { label: 'unknown state', row: { id: 'e1', state: 'quantum', candidate_id: 'c1' } },
      // `dialing` is a real engagement state and still not a DUE one. A row in
      // it must be dropped rather than coerced, or the reader would hand the
      // pass a row the one-live index would refuse anyway.
      { label: 'non-due state (dialing)', row: { id: 'e1', state: 'dialing', candidate_id: 'c1' } },
      { label: 'non-string state', row: { id: 'e1', state: 7, candidate_id: 'c1' } },
      { label: 'missing candidate_id', row: { id: 'e1', state: 'eligible' } },
      { label: 'null candidate_id', row: { id: 'e1', state: 'eligible', candidate_id: null } },
      { label: 'non-string candidate_id', row: { id: 'e1', state: 'eligible', candidate_id: 99 } },
    ];

    for (const { label, row } of bad) {
      const fake = fakeClient({ phone_engagements: { data: [row, GOOD_DUE_ROW] } });
      const out = await createPhoneRuntimeReader(fake.client)
        .listDueEngagements({
        nowIso: NOW_ISO,
        limit: 10,
        reconnectBackoffSeconds: RECONNECT_BACKOFF_SECONDS,
      });

      // Dropped, never coerced into a half-valid engagement.
      expect(out.map((e) => e.engagementId), `${label}: bad row survived`)
        .toEqual(['e-good']);
      // ...and the good row in the SAME batch is untouched. A reader that threw
      // on the first bad row would let one corrupt row stall the whole lane.
      expect(out[0].candidateId, `${label}: good neighbour was poisoned`).toBe('c-good');
    }
  });

  it('A5b: a well-formed row is projected with its optional fields defaulted, not dropped', async () => {
    const fake = fakeClient({
      phone_engagements: {
        data: [
          GOOD_DUE_ROW,
          // Everything optional absent: role/session/next-eligible/updated are
          // nullable facts, and `no_answer_attempts` defaults to zero rather
          // than to undefined, so the caller never has to test for it.
          { id: 'e-sparse', state: 'reconnecting', candidate_id: 'c-sparse' },
        ],
      },
    });
    const out = await createPhoneRuntimeReader(fake.client)
      .listDueEngagements({
        nowIso: NOW_ISO,
        limit: 10,
        reconnectBackoffSeconds: RECONNECT_BACKOFF_SECONDS,
      });

    expect(out).toEqual([
      {
        engagementId: 'e-good',
        state: 'eligible',
        candidateId: 'c-good',
        roleId: 'r1',
        sessionId: null,
        nextEligibleAt: null,
        noAnswerAttempts: 2,
        updatedAt: '2026-08-23T10:00:00.000Z',
      },
      {
        engagementId: 'e-sparse',
        state: 'reconnecting',
        candidateId: 'c-sparse',
        roleId: null,
        sessionId: null,
        nextEligibleAt: null,
        noAnswerAttempts: 0,
        updatedAt: null,
      },
    ]);
  });

  it('A5c: a non-array payload yields an empty batch rather than a throw', async () => {
    const fake = fakeClient({ phone_engagements: { data: null } });
    await expect(
      createPhoneRuntimeReader(fake.client).listDueEngagements({
        nowIso: NOW_ISO,
        limit: 3,
        reconnectBackoffSeconds: RECONNECT_BACKOFF_SECONDS,
      }),
    ).resolves.toEqual([]);
  });

  // ── M-3: RECONNECTS ARE NOT STARVED BY THE ORDERING ─────────────────
  //
  // `updated_at asc` over a batch of three is the right order for the
  // no-answer ladder and the WORST possible order for a reconnect: a row
  // entering `reconnecting` was just written by `apply_phone_event`, so it
  // carries the newest timestamp in the due set and sorts LAST — behind every
  // eligible row still waiting to be dialled. A reconnect is the one due row
  // with a human already on the line. The three tests below fail if the
  // priority read is removed, if the merge order is reversed, if the dedupe
  // is dropped, or if the merged batch stops being bounded.
  //
  // The fake answers the two reads from an ARRAY, in issue order: entry 0 is
  // the reconnect batch, entry 1 the main batch.

  const RECONNECT_ROW = {
    id: 'e-reconnect',
    state: 'reconnecting',
    candidate_id: 'c-reconnect',
    role_id: null,
    session_id: 's-reconnect',
    next_eligible_at: null,
    no_answer_attempts: 0,
    // The NEWEST timestamp in the set — which is exactly why `updated_at asc`
    // alone puts it last. Still comfortably older than
    // `NOW_ISO - RECONNECT_BACKOFF_SECONDS`, so it is genuinely DUE: after H-2
    // the reconnect batch carries a real `updated_at` ceiling, and a fixture
    // that was not due would make every merge assertion below vacuous.
    updated_at: '2026-08-24T03:20:00.000Z',
  };

  /** A reconnect written moments ago — NOT yet due under the backoff. */
  const FRESH_RECONNECT_ROW = {
    ...RECONNECT_ROW,
    id: 'e-fresh',
    candidate_id: 'c-fresh',
    updated_at: '2026-08-24T03:29:59.000Z',
  };

  const eligibleRow = (n: number) => ({
    id: `e-old-${n}`,
    state: 'eligible',
    candidate_id: `c-old-${n}`,
    role_id: null,
    session_id: null,
    next_eligible_at: null,
    no_answer_attempts: 0,
    updated_at: `2026-08-20T0${n}:00:00.000Z`,
  });

  it('A6: a reconnect is merged AHEAD of a full batch of older eligible rows', async () => {
    const fake = fakeClient({
      phone_engagements: [
        { data: [RECONNECT_ROW] },
        // A morning backlog: three eligible rows, every one of them older, so
        // a single `updated_at asc` read bounded at 3 would return exactly
        // these and the reconnect would never be seen.
        { data: [eligibleRow(1), eligibleRow(2), eligibleRow(3)] },
      ],
    });

    const out = await createPhoneRuntimeReader(fake.client)
      .listDueEngagements({
        nowIso: NOW_ISO,
        limit: 3,
        reconnectBackoffSeconds: RECONNECT_BACKOFF_SECONDS,
      });

    // TWO reads, and the reconnect one is issued first — bounded at
    // `limit - 1`, not at `limit` (H-2).
    const { reconnects, main } = fake.dueQueries();
    expect(argsOf(reconnects, 'eq')).toEqual(['state', 'reconnecting']);
    expect(argsOf(reconnects, 'limit')).toEqual([2]);
    expect(argsOf(main, 'limit')).toEqual([3]);
    // The reconnect is FIRST, and the batch is still three rows.
    expect(out.map((e) => e.engagementId)).toEqual(['e-reconnect', 'e-old-1', 'e-old-2']);
    expect(out[0].state).toBe('reconnecting');
    // ...and the row that fell off the end is the OLDEST-priority one, not
    // the reconnect.
    expect(out.map((e) => e.engagementId)).not.toContain('e-old-3');
  });

  it('A7: a reconnect returned by BOTH reads is offered once, not twice', async () => {
    // The main read selects all three due states, so a reconnect appears in
    // both batches. Without the dedupe one reconnect would occupy two of the
    // three slots and be offered twice in a single pass — two admissions, and
    // one phone ringing off the back of one row.
    const fake = fakeClient({
      phone_engagements: [
        { data: [RECONNECT_ROW] },
        { data: [eligibleRow(1), RECONNECT_ROW] },
      ],
    });

    const out = await createPhoneRuntimeReader(fake.client)
      .listDueEngagements({
        nowIso: NOW_ISO,
        limit: 3,
        reconnectBackoffSeconds: RECONNECT_BACKOFF_SECONDS,
      });

    expect(out.map((e) => e.engagementId)).toEqual(['e-reconnect', 'e-old-1']);
    expect(out.filter((e) => e.engagementId === 'e-reconnect')).toHaveLength(1);
  });

  it('A8: the MERGED batch is bounded by the caller\'s limit, never by twice it — and never by reconnects alone', async () => {
    // Two bounded reads must not compose into an unbounded batch: the fleet
    // cap is ten and every row here is a call to a person.
    //
    // WHAT CHANGED, AND WHY THE OLD EXPECTATION WAS THE BUG (H-2). This test
    // used to assert that three reconnects filled a batch of three and that
    // `out.every(state === 'reconnecting')` — "nobody eligible is dialled
    // while three people are waiting on a dropped line". That is precisely
    // head-of-line blocking, and an admission refusal is free by design
    // (`candidate_call_in_flight` / `at_capacity` / `phone_invalid` write no
    // row and bump no `updated_at`), so three permanently-refused reconnects
    // stay the OLDEST reconnect rows for ever and the lane dials nobody for
    // ever. The reconnect batch now reserves at most `limit - 1` slots, so the
    // ordinary batch is structurally guaranteed at least one.
    const fake = fakeClient({
      phone_engagements: [
        {
          data: [
            { ...RECONNECT_ROW, id: 'e-r1', candidate_id: 'c-r1' },
            { ...RECONNECT_ROW, id: 'e-r2', candidate_id: 'c-r2' },
            { ...RECONNECT_ROW, id: 'e-r3', candidate_id: 'c-r3' },
          ],
        },
        { data: [eligibleRow(1), eligibleRow(2), eligibleRow(3)] },
      ],
    });

    const out = await createPhoneRuntimeReader(fake.client)
      .listDueEngagements({
        nowIso: NOW_ISO,
        limit: 3,
        reconnectBackoffSeconds: RECONNECT_BACKOFF_SECONDS,
      });

    expect(out).toHaveLength(3);
    // Reconnects still go FIRST — the priority is intact — but only two of
    // them, and the third slot belongs to the ordinary lane.
    expect(out.map((e) => e.engagementId)).toEqual(['e-r1', 'e-r2', 'e-old-1']);
    expect(out.filter((e) => e.state === 'reconnecting')).toHaveLength(2);
    expect(out.some((e) => e.state === 'eligible'), 'the ordinary lane was starved to zero')
      .toBe(true);
  });

  // ── H-2: THE RECONNECT BATCH CARRIES ITS OWN CLOCK, IN SQL ──────────
  //
  // The M-3 repair above reads reconnects FIRST into a hard-capped batch. The
  // regression it introduced: `dueClockPredicate`'s first disjunct is
  // `state.eq.reconnecting`, trivially TRUE for every row of a reconnect-only
  // read — so that read had NO due-time filter, and the due time was decided
  // afterwards, in JS, on a batch that had already been bounded. Three
  // not-yet-due reconnects filled every slot of every pass and the lane
  // dialled nobody. The tests below fail if the `or` comes back, if the
  // `updated_at` ceiling goes away, if the backoff stops being subtracted, or
  // if the reservation goes back to the full limit.

  it('A9: the reconnect batch is filtered on `updated_at` at exactly `nowIso - reconnectBackoffSeconds`', async () => {
    const fake = fakeClient({ phone_engagements: { data: [] } });
    await createPhoneRuntimeReader(fake.client).listDueEngagements({
      nowIso: NOW_ISO,
      limit: 3,
      reconnectBackoffSeconds: RECONNECT_BACKOFF_SECONDS,
    });

    const { reconnects, main } = fake.dueQueries();

    // COMPUTED from the two inputs, never a literal: a literal would go on
    // agreeing with a reader that had stopped subtracting the backoff.
    const ceiling = reconnectDueBefore(NOW_ISO, RECONNECT_BACKOFF_SECONDS);
    expect(ceiling).not.toBe(NOW_ISO);
    expect(argsOf(reconnects, 'lte'), 'the reconnect batch carries no clock filter at all')
      .toEqual(['updated_at', ceiling]);
    expect(allArgsOf(reconnects, 'lte')).toHaveLength(1);

    // A reconnect's due time is `updated_at + backoff`; `next_eligible_at`
    // does not carry it, so the ceiling must be on `updated_at` and on
    // nothing else.
    expect(String(argsOf(reconnects, 'lte')?.[0])).toBe('updated_at');
    // ...and the ORDINARY batch does not acquire one. Its clock is the `or`.
    expect(argsOf(main, 'lte')).toBeUndefined();
  });

  it('A10: the reconnect batch does NOT carry the `or` clock predicate — it would be trivially true', async () => {
    const fake = fakeClient({ phone_engagements: { data: [] } });
    await createPhoneRuntimeReader(fake.client).listDueEngagements({
      nowIso: NOW_ISO,
      limit: 3,
      reconnectBackoffSeconds: RECONNECT_BACKOFF_SECONDS,
    });

    const { reconnects } = fake.dueQueries();
    // The read is `state = 'reconnecting'`, so `state.eq.reconnecting` matches
    // every row it can return: an `or` here is not a filter, it is a licence.
    expect(argsOf(reconnects, 'or'), 'the trivially-true clock predicate is back on the reconnect batch')
      .toBeUndefined();
    expect(allArgsOf(reconnects, 'or')).toEqual([]);
    // Spelled out at the operator level, because the shape is the finding:
    // narrow, then clock-filter, then order, then bound.
    expect(reconnects.calls.map((c) => c.op)).toEqual(['is', 'eq', 'lte', 'order', 'limit']);
  });

  it('A11: the ORDINARY batch still carries the `or` predicate unchanged, `state.eq.reconnecting` included', async () => {
    // The exemption is still CORRECT on this batch. It selects all three due
    // states, so without the disjunct a reconnect whose `next_eligible_at` is
    // null-or-future would be hidden from the ordinary read entirely — and
    // this is the read that catches a reconnect the priority batch could not
    // fit. Removing it here would be a different bug, not a fix for H-2.
    const fake = fakeClient({ phone_engagements: { data: [] } });
    await createPhoneRuntimeReader(fake.client).listDueEngagements({
      nowIso: NOW_ISO,
      limit: 3,
      reconnectBackoffSeconds: RECONNECT_BACKOFF_SECONDS,
    });

    const { main } = fake.dueQueries();
    expect(argsOf(main, 'or')).toEqual([
      `state.eq.reconnecting,next_eligible_at.is.null,next_eligible_at.lte.${NOW_ISO}`,
    ]);
    expect(main.calls.map((c) => c.op)).toEqual(['is', 'in', 'or', 'order', 'limit']);
  });

  it('A12: HEAD-OF-LINE BLOCKING IS IMPOSSIBLE — five due reconnects take at most `limit - 1` slots, and the ordinary batch is still consulted with the full limit', async () => {
    // The failure this reproduces: a LiveKit blip drops several live calls,
    // every one of them becomes a `reconnecting` row, and — because an
    // admission refusal bumps no `updated_at` — they stay the oldest
    // reconnects for ever. Under the old shape they occupied every slot of
    // every pass and the fifty candidates behind them were never dialled.
    const fiveDueReconnects = [1, 2, 3, 4, 5].map((n) => ({
      ...RECONNECT_ROW,
      id: `e-r${n}`,
      candidate_id: `c-r${n}`,
      // All comfortably past the backoff, so the SQL ceiling admits every one
      // of them: the cap under test is the SLOT reservation, not the clock.
      updated_at: `2026-08-24T03:0${n}:00.000Z`,
    }));
    const fake = fakeClient({
      phone_engagements: [
        { data: fiveDueReconnects },
        { data: [eligibleRow(1), eligibleRow(2), eligibleRow(3)] },
      ],
    });

    const out = await createPhoneRuntimeReader(fake.client)
      .listDueEngagements({
        nowIso: NOW_ISO,
        limit: 3,
        reconnectBackoffSeconds: RECONNECT_BACKOFF_SECONDS,
      });

    const { reconnects, main } = fake.dueQueries();

    // (a) AT MOST `limit - 1` come back from the reconnect read — asserted on
    //     the bound handed to the driver AND on what the read returned.
    expect(argsOf(reconnects, 'limit')).toEqual([2]);
    expect(out.filter((e) => e.state === 'reconnecting').length).toBeLessThanOrEqual(2);

    // (b) The ordinary batch is still consulted, with the CALLER'S FULL limit
    //     — not with whatever the reconnect read left over.
    expect(main).toBeDefined();
    expect(argsOf(main, 'in')?.[1]).toEqual(['eligible', 'reconnecting', 'scheduled']);
    expect(argsOf(main, 'limit')).toEqual([3]);

    // ...and the pass therefore dials somebody who is not a reconnect.
    expect(out).toHaveLength(3);
    expect(out.map((e) => e.engagementId)).toEqual(['e-r1', 'e-r2', 'e-old-1']);
    expect(out.some((e) => e.state === 'eligible'), 'the whole batch was reconnects again')
      .toBe(true);
  });

  it('A13: a limit of 1 issues NO reconnect read at all', async () => {
    // A single-slot pass has no room for a priority lane: `limit - 1` is zero,
    // and a reconnect read bounded at zero would be either a wasted round trip
    // or — worse, if it were left at 1 — the whole pass.
    const fake = fakeClient({
      phone_engagements: [{ data: [RECONNECT_ROW] }, { data: [eligibleRow(1)] }],
    });

    const out = await createPhoneRuntimeReader(fake.client)
      .listDueEngagements({
        nowIso: NOW_ISO,
        limit: 1,
        reconnectBackoffSeconds: RECONNECT_BACKOFF_SECONDS,
      });

    // The CALL COUNT on the fake, not merely the result: a reconnect read that
    // was issued and then discarded would still be a round trip, and its rows
    // would still be the first entry the response array hands out.
    expect(fake.all('phone_engagements')).toHaveLength(1);
    expect(fake.fromCalls()).toBe(1);

    const only = fake.all('phone_engagements')[0];
    expect(argsOf(only, 'eq'), 'the one read was narrowed to reconnects').toBeUndefined();
    expect(argsOf(only, 'in')?.[1]).toEqual(['eligible', 'reconnecting', 'scheduled']);
    expect(argsOf(only, 'limit')).toEqual([1]);

    // The single read is answered by the FIRST configured response, so the
    // result proves the reconnect read was never the one that consumed it.
    expect(out.map((e) => e.engagementId)).toEqual(['e-reconnect']);
  });

  it('A14: a different `reconnectBackoffSeconds` moves the reconnect filter — the value is threaded, not defaulted', async () => {
    // If the reader defaulted the backoff internally — or ignored the input
    // and used `nowIso` directly — every ceiling below would be identical.
    const seen = new Map<number, string>();
    for (const backoff of [30, 120, 900]) {
      const fake = fakeClient({ phone_engagements: { data: [] } });
      await createPhoneRuntimeReader(fake.client).listDueEngagements({
        nowIso: NOW_ISO,
        limit: 3,
        reconnectBackoffSeconds: backoff,
      });
      const applied = argsOf(fake.dueQueries().reconnects, 'lte');
      expect(applied, `backoff ${backoff}: no reconnect clock filter`).toEqual([
        'updated_at',
        reconnectDueBefore(NOW_ISO, backoff),
      ]);
      seen.set(backoff, String(applied?.[1]));
    }
    // Three distinct instants, all strictly before `nowIso`, ordered by how
    // long the backoff is.
    expect(new Set(seen.values()).size).toBe(3);
    for (const value of seen.values()) expect(value < NOW_ISO).toBe(true);
    expect(seen.get(900)! < seen.get(120)!).toBe(true);
    expect(seen.get(120)! < seen.get(30)!).toBe(true);
  });

  it('A15: a NOT-yet-due reconnect is excluded by the SQL ceiling, before the batch is bounded', async () => {
    // The whole point of moving the clock into SQL: a reconnect written
    // moments ago must never occupy a slot. Under the old shape it did, and
    // was then discarded by `dueByClock` — after the batch had been capped.
    const fake = fakeClient({
      phone_engagements: [
        { data: [FRESH_RECONNECT_ROW] },
        // The ordinary batch is empty so nothing else can supply the row and
        // make the exclusion ambiguous.
        { data: [] },
      ],
    });

    const out = await createPhoneRuntimeReader(fake.client)
      .listDueEngagements({
        nowIso: NOW_ISO,
        limit: 3,
        reconnectBackoffSeconds: RECONNECT_BACKOFF_SECONDS,
      });

    // The fixture really is fresher than the ceiling — otherwise this test
    // would pass against a reader that filtered nothing.
    expect(FRESH_RECONNECT_ROW.updated_at > reconnectDueBefore(NOW_ISO, RECONNECT_BACKOFF_SECONDS))
      .toBe(true);
    expect(FRESH_RECONNECT_ROW.updated_at < NOW_ISO).toBe(true);
    expect(out).toEqual([]);
  });

  it('A16: CONTROL — a reconnect whose `updated_at` IS old enough comes back', async () => {
    // Without this, every assertion above is satisfied by a reconnect read
    // that returns nothing at all: an over-tight ceiling would hide EVERY
    // reconnect from the pass, which is a silent total loss of the reconnect
    // path rather than a delay, and is the failure the `or` exemption on the
    // ordinary batch exists to prevent.
    const fake = fakeClient({
      phone_engagements: [{ data: [RECONNECT_ROW] }, { data: [] }],
    });

    const out = await createPhoneRuntimeReader(fake.client)
      .listDueEngagements({
        nowIso: NOW_ISO,
        limit: 3,
        reconnectBackoffSeconds: RECONNECT_BACKOFF_SECONDS,
      });

    // The fixture is genuinely due — asserted, not assumed.
    expect(RECONNECT_ROW.updated_at <= reconnectDueBefore(NOW_ISO, RECONNECT_BACKOFF_SECONDS))
      .toBe(true);
    expect(out.map((e) => e.engagementId)).toEqual(['e-reconnect']);
    expect(out[0].state).toBe('reconnecting');
    // And it came from the RECONNECT read: the ordinary batch was empty.
    expect(fake.dueQueries().reconnects).toBeDefined();
  });
});

// ════════════════════════════════════════════════════════════════════
//  B. listDialableNumbers — the only read of `phone_e164` in this PACKAGE, and the only place the column becomes a dialable value (`routes/candidates.ts` also selects it, redacted, for a human reader)
// ════════════════════════════════════════════════════════════════════

describe('B. listDialableNumbers — the number read', () => {
  it('B6: an empty candidate list performs NO query at all', async () => {
    // PostgREST answers `in.()` with EVERY row. A naive implementation would
    // therefore turn "nothing to ask about" into a full scan of `candidates`
    // — the one table in this system whose every row holds a phone number.
    // Performing no query is the only safe reading of an empty list.
    for (const candidateIds of [[], ['', ''], ['']]) {
      const fake = fakeClient({ candidates: { data: [{ id: 'anyone', phone_e164: DIALABLE, phone_valid: true }] } });
      const out = await createPhoneRuntimeReader(fake.client).listDialableNumbers({ candidateIds });

      expect(fake.fromCalls(), `the client was called for ${JSON.stringify(candidateIds)}`).toBe(0);
      expect(fake.queries).toEqual([]);
      expect(out.size).toBe(0);
    }
  });

  it('B7: only a BOOLEAN true `phone_valid` passes — every other value drops the candidate', async () => {
    const cases: Array<{ label: string; value: unknown; kept: boolean }> = [
      { label: 'boolean true', value: true, kept: true },
      { label: 'boolean false', value: false, kept: false },
      { label: 'null', value: null, kept: false },
      { label: 'undefined (column absent)', value: undefined, kept: false },
      // The string is the interesting one: `phone_valid` arriving as text is
      // exactly what a schema drift or a view would produce, and `== true`
      // or a truthiness check would let it through.
      { label: "the STRING 'true'", value: 'true', kept: false },
      { label: 'the number 1', value: 1, kept: false },
      { label: "the string '1'", value: '1', kept: false },
    ];

    for (const { label, value, kept } of cases) {
      const row: Record<string, unknown> = { id: 'c1', phone_e164: DIALABLE };
      if (value !== undefined) row.phone_valid = value;
      const fake = fakeClient({ candidates: { data: [row] } });
      const out = await createPhoneRuntimeReader(fake.client)
        .listDialableNumbers({ candidateIds: ['c1'] });

      expect(out.has('c1'), `${label}: expected kept=${kept}`).toBe(kept);
    }
  });

  it('B8: an absent, non-string or unwrappable number drops the candidate and throws nothing', async () => {
    const cases: Array<{ label: string; row: Record<string, unknown> }> = [
      { label: 'column absent', row: { id: 'c1', phone_valid: true } },
      { label: 'null', row: { id: 'c1', phone_valid: true, phone_e164: null } },
      { label: 'a number', row: { id: 'c1', phone_valid: true, phone_e164: 919_000_000 } },
      { label: 'an object', row: { id: 'c1', phone_valid: true, phone_e164: { digits: 'x' } } },
      { label: 'empty string', row: { id: 'c1', phone_valid: true, phone_e164: '' } },
      { label: 'not a number at all', row: { id: 'c1', phone_valid: true, phone_e164: NUMBER_SENTINEL } },
      // Shapes the substrate's own gate refuses. Each is assembled, never
      // committed, for the same reason the good one is.
      { label: 'wrong country', row: { id: 'c1', phone_valid: true, phone_e164: ['+', '4471', '2345', '6789'].join('') } },
      { label: 'leading digit out of range', row: { id: 'c1', phone_valid: true, phone_e164: ['+9', '1', '50', '1234', '5678'].join('') } },
      { label: 'one digit short', row: { id: 'c1', phone_valid: true, phone_e164: DIALABLE.slice(0, -1) } },
      { label: 'one digit long', row: { id: 'c1', phone_valid: true, phone_e164: `${DIALABLE}0` } },
      { label: 'surrounding whitespace', row: { id: 'c1', phone_valid: true, phone_e164: ` ${DIALABLE} ` } },
      { label: 'row id missing', row: { phone_valid: true, phone_e164: DIALABLE } },
    ];

    for (const { label, row } of cases) {
      const fake = fakeClient({ candidates: { data: [row] } });
      const out = await createPhoneRuntimeReader(fake.client)
        .listDialableNumbers({ candidateIds: ['c1'] })
        .catch((e: unknown) => {
          expect.unreachable(`${label}: threw instead of dropping — ${String(e)}`);
        });

      expect(out.size, `${label}: an undialable row reached the map`).toBe(0);
    }
  });

  it('B9: a valid row is present, and the map VALUE is a wrapper rather than the raw string', async () => {
    const fake = fakeClient({
      candidates: { data: [{ id: 'c1', phone_e164: DIALABLE, phone_valid: true }] },
    });
    const out = await createPhoneRuntimeReader(fake.client)
      .listDialableNumbers({ candidateIds: ['c1'] });

    expect(out.size).toBe(1);
    const value = out.get('c1');
    expect(value).toBeDefined();
    // The whole point of the seam: what leaves this function is a
    // `DialableNumber`, not a string. A string return type would make every
    // downstream `${number}` a leak.
    expect(typeof value).not.toBe('string');
    expect(typeof value).toBe('object');
    // ...and its default renderings are redacted, which is what makes the
    // sentinel assertion in B10 a property of the type rather than of luck.
    expect(String(value)).toBe('[redacted]');
    expect(JSON.stringify(value)).toBe('"[redacted]"');
    expect(inspect(value)).toBe('[redacted]');
    // The digest IS meant to travel — it is the form the suppression list and
    // the allowlist speak — and it is not the number.
    expect(value).toHaveProperty('digest');
    expect(String((value as { digest: string }).digest)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('B10: THE NUMBER NEVER TRAVELS — a dropped row leaks nothing into the result or an error', async () => {
    // The sentinel is deliberately NOT number-shaped (it does not match
    // `/\+91[6-9]\d{9}/`): the phone lane's structural suites forbid a
    // committed dialable literal anywhere in the lane, since India publishes no
    // reserved documentation range and a plausible fixture is indistinguishable
    // from a real subscriber's number. A recognisable non-numeric sentinel
    // proves the same property — that this exact string, having entered the
    // reader in a row, comes back out nowhere.

    // (a) The row is DROPPED because `phone_valid` is the string 'true'. The
    //     number it carried must not appear in the returned map under any
    //     rendering.
    const dropped = fakeClient({
      candidates: {
        data: [
          { id: 'c-dropped', phone_e164: NUMBER_SENTINEL, phone_valid: 'true' },
          { id: 'c-kept', phone_e164: DIALABLE, phone_valid: true },
        ],
      },
    });
    const out = await createPhoneRuntimeReader(dropped.client)
      .listDialableNumbers({ candidateIds: ['c-dropped', 'c-kept'] });

    expect(out.has('c-dropped')).toBe(false);
    const serialized = [
      JSON.stringify([...out.entries()]),
      JSON.stringify(Object.fromEntries(out)),
      inspect(out, { depth: null, showHidden: true }),
      [...out.values()].map((v) => String(v)).join(','),
    ].join('\n');
    expect(serialized).not.toContain(NUMBER_SENTINEL);
    // The kept row's own number is not in there either — it is wrapped.
    expect(serialized).not.toContain(DIALABLE);

    // (b) The same sentinel riding on a driver error. The read fails; the
    //     thrown error is a bare code and carries none of the payload.
    const failing = fakeClient({ candidates: { error: pgError({ phone_e164: NUMBER_SENTINEL }) } });
    const thrown = await createPhoneRuntimeReader(failing.client)
      .listDialableNumbers({ candidateIds: ['c1'] })
      .then(() => null, (e: unknown) => e);

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('phone_runtime_number_read_error');
    const rendered = renderings(thrown);
    expect(rendered).not.toContain(NUMBER_SENTINEL);
    for (const sentinel of PG_ERROR_SENTINELS) {
      expect(rendered, `driver payload ${sentinel} escaped`).not.toContain(sentinel);
    }
  });

  it('B11: the select is the two dialability columns and nothing else, and a bound is applied', async () => {
    const fake = fakeClient({ candidates: { data: [] } });
    await createPhoneRuntimeReader(fake.client)
      .listDialableNumbers({ candidateIds: ['c1', 'c2', 'c3'] });

    const q = fake.only('candidates');
    expect(q.columns).toBe('id,phone_e164,phone_valid');
    expect(q.columns).not.toContain('*');
    // `name`, `email` and `parsed` are absent because the runtime has no use
    // for them, and a column list is the cheapest place to prove that.
    for (const forbidden of ['name', 'email', 'parsed', 'phone_raw', 'resume']) {
      expect(q.columns.split(',')).not.toContain(forbidden);
    }
    expect(argsOf(q, 'in')).toEqual(['id', ['c1', 'c2', 'c3']]);
    expect(argsOf(q, 'limit')).toEqual([3]);
  });

  it('B11b: duplicate ids are collapsed, so the bound matches the ids actually asked for', async () => {
    const fake = fakeClient({ candidates: { data: [] } });
    await createPhoneRuntimeReader(fake.client)
      .listDialableNumbers({ candidateIds: ['c1', 'c1', 'c2', '', 'c1'] });

    const q = fake.only('candidates');
    expect(argsOf(q, 'in')).toEqual(['id', ['c1', 'c2']]);
    expect(argsOf(q, 'limit')).toEqual([2]);
  });

  it('B11c: an absurd id list is still bounded by the ceiling', async () => {
    const many = Array.from({ length: PHONE_RUNTIME_MAX_ROWS + 500 }, (_, i) => `c${i}`);
    const fake = fakeClient({ candidates: { data: [] } });
    await createPhoneRuntimeReader(fake.client).listDialableNumbers({ candidateIds: many });
    expect(argsOf(fake.only('candidates'), 'limit')).toEqual([PHONE_RUNTIME_MAX_ROWS]);
  });
});

// ════════════════════════════════════════════════════════════════════
//  C. findReusableSession
// ════════════════════════════════════════════════════════════════════

describe('C. findReusableSession — adoption is verified, not assumed', () => {
  it('C12: the id is returned ONLY when the row already carries its own deterministic room name', async () => {
    const sessionId = 's-adoptable';
    const fake = fakeClient({
      call_sessions: {
        data: [{
          id: sessionId,
          status: 'waiting',
          // Derived with the SAME helper the code uses. Hardcoding the format
          // here would let the two drift apart and still pass.
          external_call_id: phoneRoomName(sessionId),
          started_at: '2026-08-23T10:00:00.000Z',
        }],
      },
    });

    await expect(
      createPhoneRuntimeReader(fake.client).findReusableSession({ candidateId: 'c1' }),
    ).resolves.toBe(sessionId);

    const q = fake.only('call_sessions');
    expect(q.columns).toBe('id,status,external_call_id,started_at');
    expect(q.columns).not.toContain('*');
    expect(allArgsOf(q, 'eq')).toEqual([
      ['candidate_id', 'c1'],
      ['mode', PHONE_SESSION_MODE],
    ]);
    expect(PHONE_SESSION_MODE).toBe('live');
    expect(argsOf(q, 'order')).toEqual(['started_at', { ascending: false }]);
    expect(argsOf(q, 'limit')).toEqual([1]);
  });

  it('C13: a room-name mismatch, a missing id, or no rows at all all yield null', async () => {
    const sessionId = 's1';
    const cases: Array<{ label: string; data: unknown }> = [
      { label: 'no rows', data: [] },
      { label: 'a non-array payload', data: null },
      {
        label: 'external_call_id null (minted, never provisioned)',
        data: [{ id: sessionId, status: 'created', external_call_id: null }],
      },
      {
        label: 'external_call_id is the bare session id',
        data: [{ id: sessionId, status: 'waiting', external_call_id: sessionId }],
      },
      {
        label: 'external_call_id is a BROWSER room for the same session',
        data: [{ id: sessionId, status: 'waiting', external_call_id: `browser-${sessionId}` }],
      },
      {
        label: "external_call_id is another session's phone room",
        data: [{ id: sessionId, status: 'waiting', external_call_id: phoneRoomName('s-other') }],
      },
      {
        label: 'row id missing',
        data: [{ status: 'waiting', external_call_id: phoneRoomName(sessionId) }],
      },
    ];

    for (const { label, data } of cases) {
      const fake = fakeClient({ call_sessions: { data } });
      await expect(
        createPhoneRuntimeReader(fake.client).findReusableSession({ candidateId: 'c1' }),
        label,
      ).resolves.toBeNull();
    }
  });

  it('C13b: a terminal session is excluded BY THE QUERY — the status filter is the whole control', async () => {
    // NARROWED, HONESTLY. `read.ts` does not re-check `status` in JavaScript
    // after the read; the exclusion lives entirely in `.in('status', ...)`. So
    // the truthful assertion is about the QUERY, not about a terminal row being
    // filtered out of a returned batch — feeding one through a fake that
    // ignores filters would test the fake, not the reader.
    const fake = fakeClient({ call_sessions: { data: [] } });
    await createPhoneRuntimeReader(fake.client).findReusableSession({ candidateId: 'c1' });

    const inArgs = argsOf(fake.only('call_sessions'), 'in');
    expect(inArgs?.[0]).toBe('status');
    expect(inArgs?.[1]).toEqual(['created', 'waiting']);
    expect([...REUSABLE_SESSION_STATUSES]).toEqual(['created', 'waiting']);
    // Every state that is not one of those two — `active`, `completed`,
    // `failed`, `expired` — is therefore never fetched.
    for (const terminal of ['completed', 'failed', 'expired', 'cancelled']) {
      expect(inArgs?.[1] as string[]).not.toContain(terminal);
    }
  });

  it('C14: a read error THROWS a bare stable code — it does not degrade to null', async () => {
    // WHICH IT DOES, AND WHY THAT IS THE FAIL-SAFE DIRECTION HERE.
    // The code throws `phone_runtime_session_read_error`; it does not return
    // null. Null would be the wrong fail-safe for this particular read, because
    // null does not mean "stop" — `createPhoneSessionPort` reads null as "no
    // session to adopt" and goes on to MINT a fresh `call_sessions` row. A
    // transient read failure would therefore produce exactly the orphan-per-
    // attempt accumulation this function exists to prevent, silently, on every
    // pass. Throwing propagates to the due pass, which counts the failure and
    // places no call: the safe direction is "nobody is dialled", not "a new
    // session is created anyway".
    const fake = fakeClient({ call_sessions: { error: pgError() } });
    const thrown = await createPhoneRuntimeReader(fake.client)
      .findReusableSession({ candidateId: 'c1' })
      .then((v) => ({ resolved: v }), (e: unknown) => e);

    expect(thrown, 'the read degraded to a value instead of throwing').toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('phone_runtime_session_read_error');
    const rendered = renderings(thrown);
    for (const sentinel of PG_ERROR_SENTINELS) {
      expect(rendered, `driver payload ${sentinel} escaped`).not.toContain(sentinel);
    }
  });
});

// ════════════════════════════════════════════════════════════════════
//  D. the ADVISORY consent reads
// ════════════════════════════════════════════════════════════════════

describe('D. consent — the two advisory preflight reads', () => {
  it('D15a: latestConsentRecord returns the newest record, ordered as the SQL orders it', async () => {
    const fake = fakeClient({
      consent_records: {
        data: [{
          id: 'cr1',
          status: 'granted',
          consents: ['recording', 'ai_processing', 42, null],
          expires_at: '2026-12-31T00:00:00.000Z',
          created_at: '2026-08-01T00:00:00.000Z',
        }],
      },
    });
    const record = await createPhoneRuntimeReader(fake.client).consent.latestConsentRecord('c1');

    expect(record).not.toBeNull();
    expect(record?.status).toBe('granted');
    // Non-string members are filtered out rather than coerced.
    expect(record?.consents).toEqual(['recording', 'ai_processing']);
    expect(record?.expiresAt).toBeInstanceOf(Date);
    expect((record?.expiresAt as Date).toISOString()).toBe('2026-12-31T00:00:00.000Z');

    const q = fake.only('consent_records');
    expect(q.columns).toBe('status,consents,expires_at,created_at,id');
    expect(q.columns).not.toContain('*');
    // `ip_address` and `user_agent` are absent deliberately.
    for (const forbidden of ['ip_address', 'user_agent']) {
      expect(q.columns.split(',')).not.toContain(forbidden);
    }
    expect(argsOf(q, 'eq')).toEqual(['candidate_id', 'c1']);
    // The SQL orders over ALL records so a later `withdrawn` row overrides an
    // older `granted` one. Mirroring the ORDER matters more than mirroring the
    // filter — an unstable tie-break would let two rows with the same
    // `created_at` disagree between the preflight and the authoritative check.
    expect(allArgsOf(q, 'order')).toEqual([
      ['created_at', { ascending: false }],
      ['id', { ascending: false }],
    ]);
    expect(argsOf(q, 'limit')).toEqual([1]);
  });

  it('D15b: an absent record is null, and a missing expiry is a null Date, not an Invalid Date', async () => {
    const absent = fakeClient({ consent_records: { data: [] } });
    await expect(
      createPhoneRuntimeReader(absent.client).consent.latestConsentRecord('c1'),
    ).resolves.toBeNull();

    const nonArray = fakeClient({ consent_records: { data: null } });
    await expect(
      createPhoneRuntimeReader(nonArray.client).consent.latestConsentRecord('c1'),
    ).resolves.toBeNull();

    const sparse = fakeClient({ consent_records: { data: [{ id: 'cr1' }] } });
    const record = await createPhoneRuntimeReader(sparse.client).consent.latestConsentRecord('c1');
    expect(record).toEqual({ status: '', consents: [], expiresAt: null });
  });

  it('D15c: a consent_records read error is a bare code carrying none of the driver payload', async () => {
    const fake = fakeClient({ consent_records: { error: pgError({ phone_e164: NUMBER_SENTINEL }) } });
    const thrown = await createPhoneRuntimeReader(fake.client).consent
      .latestConsentRecord('c1')
      .then(() => null, (e: unknown) => e);

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('phone_runtime_consent_read_error');
    const rendered = renderings(thrown);
    for (const sentinel of [...PG_ERROR_SENTINELS, NUMBER_SENTINEL]) {
      expect(rendered, `driver payload ${sentinel} escaped`).not.toContain(sentinel);
    }
  });

  it('D15d: activeConsentTemplate reads the active template, ordered and bounded', async () => {
    const fake = fakeClient({
      consent_templates: {
        data: [{ id: 't1', required_consents: ['recording', 7, 'ai_processing'], updated_at: '2026-08-01T00:00:00.000Z' }],
      },
    });
    const template = await createPhoneRuntimeReader(fake.client).consent.activeConsentTemplate();

    expect(template).toEqual({ requiredConsents: ['recording', 'ai_processing'] });

    const q = fake.only('consent_templates');
    expect(q.columns).toBe('required_consents,updated_at,id');
    expect(q.columns).not.toContain('*');
    expect(argsOf(q, 'eq')).toEqual(['is_active', true]);
    expect(allArgsOf(q, 'order')).toEqual([
      ['updated_at', { ascending: false }],
      ['id', { ascending: false }],
    ]);
    expect(argsOf(q, 'limit')).toEqual([1]);
  });

  it('D15e: an absent template is null and a malformed one yields an empty required set', async () => {
    const absent = fakeClient({ consent_templates: { data: [] } });
    await expect(
      createPhoneRuntimeReader(absent.client).consent.activeConsentTemplate(),
    ).resolves.toBeNull();

    const nonArray = fakeClient({ consent_templates: { data: null } });
    await expect(
      createPhoneRuntimeReader(nonArray.client).consent.activeConsentTemplate(),
    ).resolves.toBeNull();

    // An empty required set is NOT the same as an absent template: the
    // preflight distinguishes "no template configured" from "a template that
    // requires nothing", so a row whose column is malformed must still be a row.
    const malformed = fakeClient({ consent_templates: { data: [{ id: 't1', required_consents: 'recording' }] } });
    await expect(
      createPhoneRuntimeReader(malformed.client).consent.activeConsentTemplate(),
    ).resolves.toEqual({ requiredConsents: [] });
  });

  it('D15f: a consent_templates read error is a bare code carrying none of the driver payload', async () => {
    const fake = fakeClient({ consent_templates: { error: pgError() } });
    const thrown = await createPhoneRuntimeReader(fake.client).consent
      .activeConsentTemplate()
      .then(() => null, (e: unknown) => e);

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('phone_runtime_consent_read_error');
    const rendered = renderings(thrown);
    for (const sentinel of PG_ERROR_SENTINELS) {
      expect(rendered, `driver payload ${sentinel} escaped`).not.toContain(sentinel);
    }
  });
});

// ════════════════════════════════════════════════════════════════════
//  CONTROLS — the fixtures and the fake are not vacuous
// ════════════════════════════════════════════════════════════════════

describe('the reconnect backoff is validated at the boundary, like nowIso', () => {
  // `nowIso` is validated here and the backoff arrived without the same
  // treatment. Both of these escaped as something other than a bare stable
  // code, or worse, silently.
  const bad: Array<[string, number]> = [
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    // A NEGATIVE backoff pushes the ceiling into the FUTURE, admitting
    // reconnects that are not due — a quieter version of the bug the SQL
    // ceiling exists to fix, and one that fails OPEN.
    ['negative', -120],
  ];

  for (const [label, backoff] of bad) {
    it(`${label} is refused with a bare stable code, not a RangeError`, async () => {
      const fake = fakeClient({ phone_engagements: { data: [] } });
      const reader = createPhoneRuntimeReader(fake.client);
      await expect(reader.listDueEngagements({
        nowIso: NOW_ISO,
        limit: 3,
        reconnectBackoffSeconds: backoff,
      })).rejects.toThrow(/^phone_runtime_bad_backoff$/);
    });
  }

  it('CONTROL — a legitimate backoff is not refused', async () => {
    // Otherwise the four cases above pass for a reader that refuses every
    // backoff, which would take the whole reconnect lane down.
    const fake = fakeClient({ phone_engagements: { data: [] } });
    const reader = createPhoneRuntimeReader(fake.client);
    await expect(reader.listDueEngagements({
      nowIso: NOW_ISO,
      limit: 3,
      reconnectBackoffSeconds: 120,
    })).resolves.toEqual([]);
  });
});

describe('CONTROLS — the harness itself', () => {
  it('CONTROL: the assembled DIALABLE really is what the substrate accepts, and the sentinel really is not', () => {
    // If DIALABLE stopped matching, B9 would be asserting that a bad number is
    // dropped — which B8 already covers — and would silently stop proving that
    // a GOOD one is kept.
    expect(DIALABLE).toMatch(/^\+91[6-9][0-9]{9}$/);
    // And the sentinel must not be number-shaped, or the "never travels"
    // assertions would be forbidden literals rather than proofs.
    expect(NUMBER_SENTINEL).not.toMatch(/\+91[6-9]\d{9}/);
    expect(NUMBER_SENTINEL).not.toMatch(/\d/);
  });

  it('CONTROL: this test file commits no dialable literal of its own', () => {
    // The lane's rule, applied to the file that has the most reason to break
    // it. India publishes no reserved documentation range, so the only safe
    // committed literal is none — hence the runtime assembly above.
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(source).not.toMatch(/\+91[6-9]\d{9}/);
    // Fail closed: an unreadable file would make the assertion vacuous.
    expect(source).toContain('THE NUMBER NEVER TRAVELS');
  });

  it('CONTROL: the fake records calls and can distinguish tables', async () => {
    // Every assertion above reads `queries`. A fake that recorded nothing would
    // make `argsOf(...)` undefined and several `toEqual(undefined)` comparisons
    // vacuously true; this is the assertion that would fail instead.
    const fake = fakeClient({
      phone_engagements: { data: [GOOD_DUE_ROW] },
      candidates: { data: [{ id: 'c-good', phone_e164: DIALABLE, phone_valid: true }] },
    });
    const reader = createPhoneRuntimeReader(fake.client);
    await reader.listDueEngagements({
        nowIso: NOW_ISO,
        limit: 3,
        reconnectBackoffSeconds: RECONNECT_BACKOFF_SECONDS,
      });
    await reader.listDialableNumbers({ candidateIds: ['c-good'] });

    // Three queries, because the due read is TWO reads (M-3: the reconnect
    // priority batch, then the main batch) followed by the number read.
    expect(fake.queries.map((q) => q.table))
      .toEqual(['phone_engagements', 'phone_engagements', 'candidates']);
    // The reconnect batch narrows with `eq` and clock-filters with `lte`; the
    // main batch widens with `in` and clock-filters with `or`. Everything else
    // about the two is identical, which is the shape the factored builder is
    // supposed to produce — and the `lte`/`or` split is H-2 itself: the `or`
    // predicate is trivially true on a reconnect-only read.
    expect(fake.queries[0].calls.map((c) => c.op)).toEqual(['is', 'eq', 'lte', 'order', 'limit']);
    expect(fake.queries[1].calls.map((c) => c.op)).toEqual(['is', 'in', 'or', 'order', 'limit']);
    expect(fake.queries[2].calls.map((c) => c.op)).toEqual(['in', 'limit']);
    expect(fake.fromCalls()).toBe(3);
  });

  it('CONTROL: `renderings` would actually catch a leaked payload', async () => {
    // The leak assertions are all `expect(renderings(err)).not.toContain(...)`.
    // If `renderings` returned something inert, every one of them would pass
    // against a reader that interpolated the raw number into its message.
    const leaky = new Error(`boom ${NUMBER_SENTINEL}`);
    expect(renderings(leaky)).toContain(NUMBER_SENTINEL);
    const viaCause = new Error('bare', { cause: pgError() });
    expect(renderings(viaCause)).toContain('SENTINEL-DETAILS-FAILING-ROW');
    const viaProperty = Object.assign(new Error('bare'), { details: 'SENTINEL-ROW-VALUE' });
    expect(renderings(viaProperty)).toContain('SENTINEL-ROW-VALUE');
  });
});
