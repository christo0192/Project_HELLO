/**
 * phone-persistence.test.ts — what actually reaches the `candidates` row, and
 * what a replay of the same parse can and cannot do to it.
 *
 * The unit-level rules live in `phone-resume-source.test.ts`. This file asserts
 * the PERSISTENCE side of the same rules against the real service-role adapters
 * and the real materialization domain: the exact payload sent to Postgres, the
 * compare-and-set that guards a replay, and the fail-closed default when a
 * caller supplies no dialability decision at all.
 *
 * Zero network, zero DB. Every phone value here is synthetic.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMaterializationStore } from '../integrations/ashby/runtime.js';
import {
  materializeCandidate,
  populateExistingCandidate,
  type MaterializationStore,
} from '../integrations/ashby/materialize.js';
import { deriveCandidatePhone, MODEL_STRUCTURER_VERSION, FALLBACK_STRUCTURER_VERSION } from '../lib/candidate-phone.js';
import type { StructuredResume } from '../integrations/ashby/resume-ingestion.js';

// ── A recording Supabase double (same idiom as ashby-runtime-adapters) ──────

interface Recorded {
  table: string;
  op: 'insert' | 'update' | 'select' | 'delete';
  payload?: Record<string, unknown>;
  filters: Array<[string, string, unknown]>;
}

function fakeSupabase(results: Record<string, unknown> = {}) {
  const calls: Recorded[] = [];
  const client = {
    from(table: string) {
      const rec: Recorded = { table, op: 'select', filters: [] };
      calls.push(rec);
      const b: Record<string, unknown> = {};
      const chain = () => b;
      b.insert = (p: Record<string, unknown>) => { rec.op = 'insert'; rec.payload = p; return chain(); };
      b.update = (p: Record<string, unknown>) => { rec.op = 'update'; rec.payload = p; return chain(); };
      b.delete = () => { rec.op = 'delete'; return chain(); };
      b.select = () => chain();
      b.eq = (c: string, v: unknown) => { rec.filters.push(['eq', c, v]); return chain(); };
      b.is = (c: string, v: unknown) => { rec.filters.push(['is', c, v]); return chain(); };
      b.limit = () => chain();
      b.order = () => chain();
      const settle = () => Promise.resolve(
        (results[`${table}:${rec.op}`] as object) ?? (results[table] as object) ?? { data: null, error: null },
      );
      b.single = settle;
      b.maybeSingle = settle;
      b.then = (ok: (v: unknown) => unknown) => settle().then(ok);
      return b;
    },
  };
  return { client: client as never, calls };
}

const PARSED: StructuredResume = {
  name: 'Ada Lovelace',
  email: 'ada@example.invalid',
  phone: '9876543210',
  skills: ['analysis'],
  experience_years: 7,
  current_role: 'Engineer',
  summary: 'Synthetic.',
};

const DIALABLE = deriveCandidatePhone(PARSED.phone, MODEL_STRUCTURER_VERSION);
const UNDIALABLE = deriveCandidatePhone(PARSED.phone, FALLBACK_STRUCTURER_VERSION);

describe('the exact payload written to `candidates`', () => {
  it('an approved decision writes all three columns together', async () => {
    const { client, calls } = fakeSupabase({ 'candidates:insert': { data: { id: 'c1' }, error: null } });
    await createMaterializationStore(client).insertCandidate({
      roleId: 'role_1', ownerId: 'owner_1', resumeId: 'r1', parsed: PARSED, phone: DIALABLE,
    });
    const p = calls.find((c) => c.table === 'candidates' && c.op === 'insert')!.payload!;
    expect(p.phone_raw).toBe('9876543210');
    expect(p.phone_e164).toBe('+919876543210');
    expect(p.phone_valid).toBe(true);
  });

  it('a fallback-provenance decision writes the raw string and NOTHING dialable', async () => {
    const { client, calls } = fakeSupabase({ 'candidates:insert': { data: { id: 'c1' }, error: null } });
    await createMaterializationStore(client).insertCandidate({
      roleId: 'role_1', ownerId: 'owner_1', resumeId: 'r1', parsed: PARSED, phone: UNDIALABLE,
    });
    const p = calls.find((c) => c.table === 'candidates' && c.op === 'insert')!.payload!;
    // The recruiter still sees what the document said…
    expect(p.phone_raw).toBe('9876543210');
    // …and 0042's admission refuses this row with `phone_invalid`.
    expect(p.phone_e164).toBeNull();
    expect(p.phone_valid).toBe(false);
  });

  it('FAILS CLOSED when the caller supplied no decision at all', async () => {
    // `phone` is optional so a store written before this seam type-checks.
    // Optional has to mean UNDIALABLE: absence means nobody decided, and the
    // safe reading of "nobody decided" on a dialer is "do not call".
    const { client, calls } = fakeSupabase({ 'candidates:insert': { data: { id: 'c1' }, error: null } });
    await createMaterializationStore(client).insertCandidate({
      roleId: 'role_1', ownerId: 'owner_1', resumeId: 'r1', parsed: PARSED,
    });
    const p = calls.find((c) => c.table === 'candidates' && c.op === 'insert')!.payload!;
    expect(p.phone_e164).toBeNull();
    expect(p.phone_valid).toBe(false);
    // Pre-change behaviour for the raw column is preserved exactly.
    expect(p.phone_raw).toBe('9876543210');
  });

  it('the shell insert still writes no candidate PII whatsoever', async () => {
    const { client, calls } = fakeSupabase({ 'candidates:insert': { data: { id: 'c1' }, error: null } });
    await createMaterializationStore(client).insertCandidateShell!({ roleId: 'role_1', ownerId: 'owner_1' });
    const p = calls.find((c) => c.table === 'candidates' && c.op === 'insert')!.payload!;
    // The shell is the state a candidate rests in BEFORE any parse. It must
    // stay null/invalid: an invite or an admission reaching a shell has to
    // refuse, not dial a half-populated row.
    expect(p.phone_raw).toBeNull();
    expect(p.phone_e164).toBeNull();
    expect(p.phone_valid).toBe(false);
    expect(p.name).toBeNull();
    expect(p.email).toBeNull();
  });
});

/**
 * A one-row `candidates` double that APPLIES the filters it is given, so the
 * never-downgrade rule is asserted as an outcome on the row, not only as the
 * presence of a filter. `eq`/`is` are the only predicates the populate path
 * uses; a write lands only when every one of them holds.
 */
function rowSupabase(row: Record<string, unknown>) {
  const client = {
    from(table: string) {
      expect(table).toBe('candidates');
      let payload: Record<string, unknown> | null = null;
      const preds: Array<[string, unknown]> = [];
      const b: Record<string, unknown> = {};
      b.update = (p: Record<string, unknown>) => { payload = p; return b; };
      b.eq = (c: string, v: unknown) => { preds.push([c, v]); return b; };
      b.is = (c: string, v: unknown) => { preds.push([c, v]); return b; };
      b.select = () => b;
      const settle = () => {
        const matched = payload !== null && preds.every(([c, v]) => row[c] === v);
        if (matched) Object.assign(row, payload);
        return Promise.resolve({ data: matched ? { id: row.id } : null, error: null });
      };
      b.maybeSingle = settle;
      b.then = (ok: (v: unknown) => unknown) => settle().then(ok);
      return b;
    },
  };
  return client as never;
}

/** A shell exactly as `insertCandidateShell` leaves it, plus the given phone. */
function shellRow(phone: { raw: string | null; e164: string | null; valid: boolean }) {
  return {
    id: 'c1', resume_id: null, name: null, email: null, parsed: null,
    phone_raw: phone.raw, phone_e164: phone.e164, phone_valid: phone.valid,
  } as Record<string, unknown>;
}

describe('the populate CAS and what a replay may do', () => {
  it('writes the phone FIRST, in its own update, only while the number is not valid', async () => {
    const { client, calls } = fakeSupabase({ 'candidates:update': { data: { id: 'c1' }, error: null } });
    const res = await createMaterializationStore(client).updateCandidateFromParse!({
      candidateId: 'c1', resumeId: 'r1', parsed: PARSED, phone: DIALABLE,
    });
    expect(res).toEqual({ updated: true });

    const updates = calls.filter((c) => c.table === 'candidates' && c.op === 'update');
    expect(updates).toHaveLength(2);
    const [phoneUpd, parseUpd] = updates as [Recorded, Recorded];

    // Step 1: the phone and nothing else, under the same CAS PLUS
    // `phone_valid = false`, so a valid number already on the row (HR
    // verified, or applied from the Ashby profile) is never overwritten.
    expect(phoneUpd.payload).toEqual({
      phone_raw: '9876543210', phone_e164: '+919876543210', phone_valid: true,
    });
    expect(phoneUpd.filters).toContainEqual(['eq', 'id', 'c1']);
    expect(phoneUpd.filters).toContainEqual(['is', 'resume_id', null]);
    expect(phoneUpd.filters).toContainEqual(['eq', 'phone_valid', false]);

    // Step 2: the parse fields, still guarded by the compare-and-set, and no
    // phone column at all. A replay matches zero rows here.
    expect(parseUpd.filters).toContainEqual(['is', 'resume_id', null]);
    expect(parseUpd.filters).toContainEqual(['eq', 'id', 'c1']);
    expect(parseUpd.payload!.resume_id).toBe('r1');
    for (const phoneKey of ['phone_raw', 'phone_e164', 'phone_valid']) {
      expect(parseUpd.payload).not.toHaveProperty(phoneKey);
    }
    // Ownership and funnel position remain unreachable from a parse.
    for (const upd of [phoneUpd, parseUpd]) {
      for (const forbidden of ['role_id', 'owner_id', 'status', 'ats_source']) {
        expect(upd.payload).not.toHaveProperty(forbidden);
      }
    }
  });

  it('an undialable parse writes only `phone_raw`', async () => {
    const { client, calls } = fakeSupabase({ 'candidates:update': { data: { id: 'c1' }, error: null } });
    await createMaterializationStore(client).updateCandidateFromParse!({
      candidateId: 'c1', resumeId: 'r1', parsed: PARSED, phone: UNDIALABLE,
    });
    const phoneUpd = calls.find((c) => c.table === 'candidates' && c.op === 'update')!;
    // The recruiter still sees what the document said; the dialable pair is
    // not named, so the row stays exactly as undialable as it already was.
    expect(phoneUpd.payload).toEqual({ phone_raw: '9876543210' });
    expect(phoneUpd.filters).toContainEqual(['eq', 'phone_valid', false]);
  });

  it('FAILS CLOSED on populate when the caller supplied no decision at all', async () => {
    const { client, calls } = fakeSupabase({ 'candidates:update': { data: { id: 'c1' }, error: null } });
    await createMaterializationStore(client).updateCandidateFromParse!({
      candidateId: 'c1', resumeId: 'r1', parsed: PARSED,
    });
    const phoneUpd = calls.find((c) => c.table === 'candidates' && c.op === 'update')!;
    expect(phoneUpd.payload).toEqual({ phone_raw: '9876543210' });
  });

  it('a phone write error throws a fixed code and writes no parse field', async () => {
    const { client, calls } = fakeSupabase({
      'candidates:update': { data: null, error: { message: 'synthetic failure' } },
    });
    const err = await createMaterializationStore(client).updateCandidateFromParse!({
      candidateId: 'c1', resumeId: 'r1', parsed: PARSED, phone: DIALABLE,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('ashby_candidate_phone_write_error');
    // The parse step never ran, so the CAS is still open for the retry.
    expect(calls.filter((c) => c.table === 'candidates' && c.op === 'update')).toHaveLength(1);
  });

  it('a VALID number on the shell survives the parse; the parse fields still land', async () => {
    // The 0084 re-parse case: HR verified a number (or the Ashby profile was
    // applied) while the shell was waiting for its resume. The parse found a
    // different, equally dialable number, and it must not win.
    const row = shellRow({ raw: '+91 98123 45670', e164: '+919812345670', valid: true });
    const res = await createMaterializationStore(rowSupabase(row)).updateCandidateFromParse!({
      candidateId: 'c1', resumeId: 'r1', parsed: PARSED, phone: DIALABLE,
    });
    expect(res).toEqual({ updated: true });
    expect(row.phone_raw).toBe('+91 98123 45670');
    expect(row.phone_e164).toBe('+919812345670');
    expect(row.phone_valid).toBe(true);
    expect(row.resume_id).toBe('r1');
    expect(row.name).toBe(PARSED.name);
  });

  it('a shell with no valid number takes the parse number, and a retry changes nothing', async () => {
    const row = shellRow({ raw: null, e164: null, valid: false });
    const store = createMaterializationStore(rowSupabase(row));
    const first = await store.updateCandidateFromParse!({
      candidateId: 'c1', resumeId: 'r1', parsed: PARSED, phone: DIALABLE,
    });
    expect(first).toEqual({ updated: true });
    expect(row).toMatchObject({ phone_raw: '9876543210', phone_e164: '+919876543210', phone_valid: true });

    const after = { ...row };
    const retry = await store.updateCandidateFromParse!({
      candidateId: 'c1', resumeId: 'r2', parsed: { ...PARSED, phone: null }, phone: UNDIALABLE,
    });
    expect(retry).toEqual({ updated: false });
    expect(row).toEqual(after);
  });

  it('a REPLAY matches zero rows and reports updated:false', async () => {
    // `maybeSingle()` resolving to null data is precisely what PostgREST
    // returns when the CAS matched nothing — i.e. the row already has a
    // resume, because a previous run populated it.
    const { client } = fakeSupabase({ 'candidates:update': { data: null, error: null } });
    const res = await createMaterializationStore(client).updateCandidateFromParse!({
      candidateId: 'c1', resumeId: 'r2', parsed: PARSED, phone: DIALABLE,
    });
    expect(res).toEqual({ updated: false });
  });

  it('a replay carrying NO phone cannot erase a phone the first run stored', async () => {
    // THE ERASURE CASE. Imagine the same application redelivered and its
    // second parse producing nothing (a scanned image, a truncated download).
    // If that replay could write, it would blank a good number. It cannot: the
    // CAS is on `resume_id is null`, the first run set `resume_id`, so the
    // second update matches zero rows and NOTHING — phone included — is
    // written. The row is byte-identical afterwards.
    const world = { populated: 0 };
    const store: MaterializationStore = {
      insertResume: async () => ({ id: 'r2' }),
      insertCandidate: async () => ({ id: 'c_new' }),
      updateCandidateFromParse: async () => { world.populated += 1; return { updated: false }; },
      bindLinkColumn: async () => ({ bound: 'c1', wonRace: false }),
      deleteOrphan: async () => {},
    } as unknown as MaterializationStore;

    const empty: StructuredResume = { ...PARSED, phone: null, name: null, email: null };
    const res = await populateExistingCandidate('c1', empty, { store, phone: deriveCandidatePhone(null, MODEL_STRUCTURER_VERSION) });

    // The CAS refused it, and the caller reports `reused` — the existing row
    // stands, and no compensating write is attempted.
    expect(res).toEqual({ status: 'reused', candidateId: 'c1' });
    expect(world.populated).toBe(1); // exactly one attempt, which wrote nothing
  });

  it('an INVALID replay likewise cannot downgrade a stored valid phone', async () => {
    const seen: Array<{ phone?: unknown }> = [];
    const store: MaterializationStore = {
      insertResume: async () => ({ id: 'r2' }),
      insertCandidate: async () => ({ id: 'c_new' }),
      updateCandidateFromParse: async (input: { phone?: unknown }) => {
        seen.push({ phone: input.phone });
        return { updated: false };            // CAS refuses: already populated
      },
      bindLinkColumn: async () => ({ bound: 'c1', wonRace: false }),
      deleteOrphan: async () => {},
    } as unknown as MaterializationStore;

    const landline: StructuredResume = { ...PARSED, phone: '+912212345678' };
    const res = await populateExistingCandidate('c1', landline, {
      store, phone: deriveCandidatePhone(landline.phone, MODEL_STRUCTURER_VERSION),
    });

    expect(res.status).toBe('reused');
    // Even the ATTEMPTED write was already undialable — the landline never
    // became a dial target on its way in, quite apart from the CAS refusing it.
    expect(seen[0]!.phone).toEqual({ raw: '+912212345678', e164: null, valid: false });
  });
});

describe('two applications carrying the same number stay two candidates', () => {
  it('materialization never looks up or merges by phone or email', async () => {
    // Two people can share a household landline; one person can apply twice
    // from one mobile. Neither is a reason to fuse two applications into one
    // candidate, and a dialer that merged them would carry one application's
    // opt-out onto another's engagement.
    const inserted: Array<Record<string, unknown>> = [];
    const store: MaterializationStore = {
      insertResume: async () => ({ id: `r${inserted.length + 1}` }),
      insertCandidate: async (input: Record<string, unknown>) => {
        inserted.push(input);
        return { id: `c${inserted.length}` };
      },
      bindLinkColumn: async (input: { value: string }) => ({ bound: input.value, wonRace: true }),
      deleteOrphan: async () => {},
    } as unknown as MaterializationStore;

    const mapping = { id: 'm1', roleId: 'role_1', ownerId: 'owner_1', deliveryMode: 'email' as const };
    const a = await materializeCandidate('link_a', PARSED, {
      store, mapping, isTerminal: false, existingCandidateId: null, phone: DIALABLE,
    });
    const b = await materializeCandidate('link_b', PARSED, {
      store, mapping, isTerminal: false, existingCandidateId: null, phone: DIALABLE,
    });

    expect(a).toEqual({ status: 'created', candidateId: 'c1' });
    expect(b).toEqual({ status: 'created', candidateId: 'c2' });
    expect(inserted).toHaveLength(2);
    // Both carry the same dialable number and remain distinct rows.
    expect(inserted[0]!.phone).toEqual(DIALABLE);
    expect(inserted[1]!.phone).toEqual(DIALABLE);
  });

  it('no persistence path filters candidates by a contact field', () => {
    // The behavioural test above proves two rows are created; this proves
    // there is no code path that COULD have merged them. A lookup by
    // phone/email is what a future "dedupe" change would add, and it would be
    // invisible in a test that only counts rows.
    const files = ['integrations/ashby/materialize.ts', 'integrations/ashby/runtime.ts'];
    for (const f of files) {
      const src = readFileSync(join(process.cwd(), 'src', f), 'utf8');
      expect(src).not.toMatch(/\.eq\(\s*'phone_e164'/);
      expect(src).not.toMatch(/\.eq\(\s*'phone_raw'/);
      expect(src).not.toMatch(/\.eq\(\s*'email'/);
    }
  });
});
