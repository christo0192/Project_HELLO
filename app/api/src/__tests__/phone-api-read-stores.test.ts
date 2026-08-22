/**
 * The phone READ seam, driven against a recording fake client.
 *
 * These assertions are about the QUERIES, not about the projection: which
 * table, which columns, which filters, which bound, and how many round trips.
 * A route test cannot see any of that — it sees whatever the injected store
 * returned — so the two suites check different things and neither substitutes
 * for the other.
 *
 * No network, no database, no real client.
 */

import { describe, it, expect } from 'vitest';
import {
  PHONE_READ_MAX_ROWS,
  boundedRowLimit,
  createPhoneReadStore,
} from '../lib/phone-screening/index.js';

// ════════════════════════════════════════════════════════════════════
//  A recording fake PostgREST builder
// ════════════════════════════════════════════════════════════════════

interface RecordedQuery {
  table: string;
  columns: string;
  filters: Array<{ op: string; args: unknown[] }>;
}

function fakeClient(responses: Array<{ data: unknown; error?: unknown }>) {
  const queries: RecordedQuery[] = [];
  let next = 0;
  const client = {
    from(table: string) {
      return {
        select(columns: string) {
          const record: RecordedQuery = { table, columns, filters: [] };
          queries.push(record);
          const builder: Record<string, unknown> = {};
          for (const op of ['gte', 'lt', 'in', 'eq', 'order', 'limit']) {
            builder[op] = (...args: unknown[]) => {
              record.filters.push({ op, args });
              return builder;
            };
          }
          // Thenable, exactly as a PostgREST builder is: awaiting it runs it.
          builder.then = (
            resolve: (v: { data: unknown; error: unknown }) => unknown,
          ): unknown => {
            const answer = responses[next] ?? { data: [] };
            next += 1;
            return resolve({ data: answer.data, error: answer.error ?? null });
          };
          return builder;
        },
      };
    },
  };
  return { client, queries, remaining: () => responses.length - next };
}

const APPOINTMENT = {
  id: 'a1',
  engagement_id: 'e1',
  starts_at: '2026-08-24T03:30:00.000Z',
  ends_at: '2026-08-24T04:00:00.000Z',
  ist_date: '2026-08-24',
  status: 'scheduled',
  source: 'hr_manual',
  confirmed_at: null,
  cancel_reason: null,
  version: 1,
  created_at: '2026-08-23T10:00:00.000Z',
  updated_at: '2026-08-23T10:00:00.000Z',
};

const ENGAGEMENT = {
  id: 'e1',
  candidate_id: 'c1',
  state: 'scheduled',
  state_reason: null,
  epoch: 0,
  version: 2,
  no_answer_attempts: 1,
  reconnects_used: 0,
  provider_failures: 0,
  next_eligible_at: null,
  last_attempt_at: null,
  terminal_at: null,
  created_at: '2026-08-20T10:00:00.000Z',
  updated_at: '2026-08-23T10:00:00.000Z',
};

const ATTEMPT = {
  id: 't1',
  engagement_id: 'e1',
  attempt_seq: 1,
  epoch: 0,
  kind: 'initial',
  state: 'ended',
  outcome_class: 'no_answer',
  ist_date: '2026-08-23',
  prior_engagement_state: 'eligible',
  admitted_at: '2026-08-23T05:00:00.000Z',
  answered_at: null,
  classified_at: null,
  ended_at: '2026-08-23T05:01:00.000Z',
};

const CANDIDATE = { id: 'c1', name: 'Test Candidate', status: 'screening', ats_external_id: 'ATS-1' };

describe('boundedRowLimit', () => {
  it('clamps into [1, PHONE_READ_MAX_ROWS] and refuses a non-integer', () => {
    expect(boundedRowLimit(0)).toBe(1);
    expect(boundedRowLimit(-5)).toBe(1);
    expect(boundedRowLimit(1.5)).toBe(1);
    expect(boundedRowLimit(Number.NaN)).toBe(1);
    expect(boundedRowLimit(50)).toBe(50);
    expect(boundedRowLimit(PHONE_READ_MAX_ROWS)).toBe(PHONE_READ_MAX_ROWS);
    expect(boundedRowLimit(PHONE_READ_MAX_ROWS + 1_000)).toBe(PHONE_READ_MAX_ROWS);
  });
});

describe('every query names its columns and its bound', () => {
  it('the calendar range read is a half-open range with an ordered, bounded result', async () => {
    const { client, queries } = fakeClient([{ data: [APPOINTMENT] }]);
    const rows = await createPhoneReadStore(client as never).listAppointmentsByStart({
      fromIso: '2026-08-24T00:00:00.000Z',
      toIso: '2026-08-25T00:00:00.000Z',
      limit: 201,
    });
    expect(rows).toHaveLength(1);
    expect(queries).toHaveLength(1);
    const q = queries[0];
    expect(q.table).toBe('phone_appointments');
    expect(q.columns).not.toContain('*');
    expect(q.columns).not.toContain('created_by');
    expect(q.filters.map((f) => f.op)).toEqual(['gte', 'lt', 'order', 'limit']);
    // Half-open: `gte` on the low end, `lt` on the high end. A `lte` would
    // return an appointment starting exactly at the next range's first instant
    // in BOTH pages.
    expect(q.filters[0].args[0]).toBe('starts_at');
    expect(q.filters[1].args[0]).toBe('starts_at');
    expect(q.filters[3].args[0]).toBe(201);
  });

  it('the slot occupancy read filters to the two LIVE statuses', async () => {
    const { client, queries } = fakeClient([{ data: [APPOINTMENT] }]);
    await createPhoneReadStore(client as never).listLiveAppointmentsByStart({
      fromIso: '2026-08-23T18:30:00.000Z',
      toIso: '2026-08-24T18:30:00.000Z',
      limit: 500,
    });
    const statusFilter = queries[0].filters.find((f) => f.op === 'in');
    expect(statusFilter).toBeDefined();
    expect(statusFilter!.args[0]).toBe('status');
    expect(statusFilter!.args[1]).toEqual(['scheduled', 'confirmed']);
  });

  it('the attempt read is scoped, ordered newest-first and bounded', async () => {
    const { client, queries } = fakeClient([{ data: [ATTEMPT] }]);
    await createPhoneReadStore(client as never).listAttemptsForEngagement({
      engagementId: 'e1',
      limit: 51,
    });
    const q = queries[0];
    expect(q.table).toBe('phone_call_attempts');
    expect(q.filters.map((f) => f.op)).toEqual(['eq', 'order', 'limit']);
    expect(q.filters[0].args).toEqual(['engagement_id', 'e1']);
    expect(q.filters[1].args[1]).toEqual({ ascending: false });
    expect(q.filters[2].args[0]).toBe(51);
  });

  it('clamps a caller limit that exceeds the ceiling', async () => {
    const { client, queries } = fakeClient([{ data: [] }]);
    await createPhoneReadStore(client as never).listAppointmentsByStart({
      fromIso: '2026-08-24T00:00:00.000Z',
      toIso: '2026-08-25T00:00:00.000Z',
      limit: 100_000,
    });
    expect(queries[0].filters.at(-1)!.args[0]).toBe(PHONE_READ_MAX_ROWS);
  });

  it('never selects a provider-bearing or contact column', async () => {
    const { client, queries } = fakeClient([
      { data: [APPOINTMENT] },
      { data: [ENGAGEMENT] },
      { data: [CANDIDATE] },
      { data: [ATTEMPT] },
    ]);
    const store = createPhoneReadStore(client as never);
    await store.listAppointmentsByStart({
      fromIso: '2026-08-24T00:00:00.000Z',
      toIso: '2026-08-25T00:00:00.000Z',
      limit: 10,
    });
    await store.listEngagementsByIds(['e1']);
    await store.listCandidatesByIds(['c1']);
    await store.listAttemptsForEngagement({ engagementId: 'e1', limit: 10 });
    expect(queries).toHaveLength(4);
    const FORBIDDEN = [
      'sip_call_id', 'room_name', 'participant_identity', 'egress_id', 'egress_status',
      'lease_token', 'lease_owner', 'lease_expires_at', 'created_by',
      'email', 'phone_raw', 'phone_e164', 'phone_valid', 'parsed', 'skills',
      'application_link_id',
    ];
    for (const q of queries) {
      const columns = q.columns.split(',');
      for (const forbidden of FORBIDDEN) {
        expect(columns, `${q.table} selects ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});

describe('batched id reads are one round trip, never N+1', () => {
  it('resolves many engagements with a single `in()` query', async () => {
    const { client, queries } = fakeClient([{ data: [ENGAGEMENT] }]);
    await createPhoneReadStore(client as never).listEngagementsByIds([
      'e1', 'e2', 'e3', 'e4', 'e5',
    ]);
    expect(queries).toHaveLength(1);
    const inFilter = queries[0].filters.find((f) => f.op === 'in')!;
    expect(inFilter.args[1]).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);
  });

  it('de-duplicates ids so a repeated engagement is fetched once', async () => {
    const { client, queries } = fakeClient([{ data: [CANDIDATE] }]);
    await createPhoneReadStore(client as never).listCandidatesByIds(['c1', 'c1', 'c2', 'c1']);
    expect(queries[0].filters.find((f) => f.op === 'in')!.args[1]).toEqual(['c1', 'c2']);
  });

  it('issues NO query at all for an empty id list', async () => {
    // An empty `.in()` is a filter PostgREST answers with EVERY row. Not
    // issuing the query is the control; clamping afterwards would not be.
    const { client, queries } = fakeClient([{ data: [ENGAGEMENT] }]);
    const store = createPhoneReadStore(client as never);
    expect(await store.listEngagementsByIds([])).toEqual([]);
    expect(await store.listCandidatesByIds([])).toEqual([]);
    expect(queries).toHaveLength(0);
  });

  it('drops empty and non-string ids rather than sending them', async () => {
    const { client, queries } = fakeClient([{ data: [] }]);
    await createPhoneReadStore(client as never).listCandidatesByIds([
      '', 'c1', null as never, undefined as never, 'c2',
    ]);
    expect(queries[0].filters.find((f) => f.op === 'in')!.args[1]).toEqual(['c1', 'c2']);
  });

  it('bounds a pathologically long id list', async () => {
    const { client, queries } = fakeClient([{ data: [] }]);
    const ids = Array.from({ length: PHONE_READ_MAX_ROWS + 200 }, (_, i) => `e${i}`);
    await createPhoneReadStore(client as never).listEngagementsByIds(ids);
    expect((queries[0].filters.find((f) => f.op === 'in')!.args[1] as string[]))
      .toHaveLength(PHONE_READ_MAX_ROWS);
  });
});

describe('rows are narrowed, and a driver error is sanitized', () => {
  it('maps an appointment row onto the projection, dropping nothing it declares', async () => {
    const { client } = fakeClient([{ data: [APPOINTMENT] }]);
    const [row] = await createPhoneReadStore(client as never).listAppointmentsByStart({
      fromIso: 'x', toIso: 'y', limit: 1,
    });
    expect(row).toEqual({
      id: 'a1',
      engagementId: 'e1',
      startsAt: '2026-08-24T03:30:00.000Z',
      endsAt: '2026-08-24T04:00:00.000Z',
      istDate: '2026-08-24',
      status: 'scheduled',
      source: 'hr_manual',
      confirmedAt: null,
      cancelReason: null,
      version: 1,
      createdAt: '2026-08-23T10:00:00.000Z',
      updatedAt: '2026-08-23T10:00:00.000Z',
    });
  });

  it('reads a null outcome_class as null and a bad one as drift', async () => {
    const live = { ...ATTEMPT, outcome_class: null };
    const { client } = fakeClient([{ data: [live] }, { data: [{ ...ATTEMPT, outcome_class: 'invented' }] }]);
    const store = createPhoneReadStore(client as never);
    const [ok] = await store.listAttemptsForEngagement({ engagementId: 'e1', limit: 1 });
    expect(ok.outcomeClass).toBeNull();
    // A value outside the eleven fails the ROW rather than making the field
    // vanish — a missing key in a response is the silent failure this lane has
    // already been burned by once.
    await expect(store.listAttemptsForEngagement({ engagementId: 'e1', limit: 1 }))
      .rejects.toThrow('phone_attempt_row_invalid');
  });

  it('refuses a row that is missing a required scalar', async () => {
    // A partial row is drift too — a projection built from it would report a
    // field as absent rather than saying the read could not be trusted.
    const { kind, ...noKind } = ATTEMPT;
    expect(kind).toBe('initial');
    const { attempt_seq, ...noSeq } = ATTEMPT;
    expect(attempt_seq).toBe(1);
    for (const bad of [noKind, noSeq]) {
      const { client } = fakeClient([{ data: [bad] }]);
      await expect(createPhoneReadStore(client as never)
        .listAttemptsForEngagement({ engagementId: 'e1', limit: 1 }))
        .rejects.toThrow('phone_attempt_row_invalid');
    }
  });

  it('refuses a reason code that is not a stable snake_case code', async () => {
    // `state_reason` and `cancel_reason` were the only strings crossing this
    // boundary unnarrowed. 0042 constrains both by a FORMAT rule rather than a
    // closed allowlist, so mirroring the format is the correct narrowing — and
    // without it a future writer putting free text in either column would have
    // reached a response silently.
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...ENGAGEMENT, state_reason: 'Call the candidate back on Tuesday!' }, 'engagement'],
      [{ ...ENGAGEMENT, state_reason: 'a'.repeat(65) }, 'over length'],
      [{ ...ENGAGEMENT, state_reason: 'Provider_Error' }, 'uppercase'],
    ];
    for (const [row, label] of cases) {
      const { client } = fakeClient([{ data: [row] }]);
      await expect(createPhoneReadStore(client as never).getEngagement('e1'), label)
        .rejects.toThrow('phone_reason_code_invalid');
    }
    // The shapes 0042 actually writes pass, and a null stays null.
    for (const value of ['provider_budget_exhausted', 'no_answer_budget_exhausted', null]) {
      const { client } = fakeClient([{ data: [{ ...ENGAGEMENT, state_reason: value }] }]);
      const row = await createPhoneReadStore(client as never).getEngagement('e1');
      expect(row!.stateReason).toBe(value);
    }
    const { client } = fakeClient([{ data: [{ ...APPOINTMENT, cancel_reason: 'hr cancelled' }] }]);
    await expect(createPhoneReadStore(client as never).getAppointment('a1'))
      .rejects.toThrow('phone_reason_code_invalid');
  });

  it('refuses a row carrying a state outside the 0042 vocabulary', async () => {
    const { client } = fakeClient([{ data: [{ ...ENGAGEMENT, state: 'daydreaming' }] }]);
    await expect(createPhoneReadStore(client as never).getEngagement('e1'))
      .rejects.toThrow('phone_engagement_row_invalid');
  });

  it('refuses an appointment row with a status outside the vocabulary', async () => {
    const { client } = fakeClient([{ data: [{ ...APPOINTMENT, status: 'pencilled_in' }] }]);
    await expect(createPhoneReadStore(client as never).getAppointment('a1'))
      .rejects.toThrow('phone_appointment_row_invalid');
  });

  it('turns a driver error into a bare stable code with no detail', async () => {
    const leaky = {
      message: 'permission denied for relation phone_appointments',
      details: 'row: (a1, +919000000000)',
      hint: 'select * from screening_v2.phone_appointments',
      code: '42501',
    };
    const cases: Array<[string, () => Promise<unknown>]> = [];
    const mk = (): ReturnType<typeof createPhoneReadStore> => {
      const { client } = fakeClient([{ data: null, error: leaky }]);
      return createPhoneReadStore(client as never);
    };
    cases.push(['phone_appointment_read_error', () => mk().getAppointment('a1')]);
    cases.push(['phone_engagement_read_error', () => mk().getEngagement('e1')]);
    cases.push(['phone_candidate_read_error', () => mk().listCandidatesByIds(['c1'])]);
    cases.push([
      'phone_attempt_read_error',
      () => mk().listAttemptsForEngagement({ engagementId: 'e1', limit: 1 }),
    ]);
    for (const [code, run] of cases) {
      await expect(run()).rejects.toThrow(code);
      await run().catch((err: Error) => {
        expect(err.message).toBe(code);
        expect(err.message).not.toContain('permission');
        expect((err as { cause?: unknown }).cause).toBeUndefined();
        expect(JSON.stringify(err.message)).not.toMatch(/\d{7,}/);
      });
    }
  });

  it('answers null for a missing single row rather than throwing', async () => {
    const { client } = fakeClient([{ data: [] }, { data: [] }, { data: [] }]);
    const store = createPhoneReadStore(client as never);
    expect(await store.getAppointment('nope')).toBeNull();
    expect(await store.getEngagement('nope')).toBeNull();
    expect(await store.getLiveAppointmentForEngagement('nope')).toBeNull();
  });

  it('ignores a non-array body instead of inventing rows', async () => {
    const { client } = fakeClient([{ data: { id: 'a1' } }]);
    expect(await createPhoneReadStore(client as never).listAppointmentsByStart({
      fromIso: 'x', toIso: 'y', limit: 1,
    })).toEqual([]);
  });
});
