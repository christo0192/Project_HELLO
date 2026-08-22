/**
 * phone-resume-source.test.ts — the shared dialability fixture table, the
 * provenance gate, and the persistence invariants that make 0042's admission
 * and its opt-out suppression agree with each other.
 *
 * ── WHY THIS FILE IS THE CONTRACT AND NOT JUST A UNIT TEST ──────────────────
 *
 * `candidates.phone_e164` / `phone_valid` are read by exactly two places in
 * migration 0042, and they disagree about validation:
 *
 *   - `admit_phone_attempt` digests the number ONLY after checking
 *     `phone_valid AND phone_e164 ~ '^\+91[6-9][0-9]{9}$'`.
 *   - `apply_phone_event` digests it on opt-out with NO format check at all.
 *
 * If a non-strict value can ever be stored, an opt-out writes a suppression row
 * and audits `suppression_written: true`, while admission — which only ever
 * digests strict values — can never match that digest. The consent control
 * would look applied and would not be. The asymmetry is in the merged
 * migration and this PR does not change it; what this PR guarantees instead is
 * the premise that makes it harmless: `phone_e164` is NULL or strict, always.
 * {@link https://—} nothing else is required for the two digests to agree.
 *
 * The fixture table below is therefore SHARED and deliberately exported: the
 * P2 lane consumes the same predicate in its admission facades and projections,
 * and asserting the same rows on both sides is what stops two definitions of
 * "dialable" from drifting apart.
 *
 * No real number appears anywhere in this file. Every value is synthetic.
 * India publishes NO reserved documentation range — there is no +1-555
 * equivalent — so these are not "reserved" numbers; they are invented values
 * that exist only in this process.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  deriveCandidatePhone,
  isDialableStructurer,
  redactCandidatePhone,
  redactPhoneView,
  toCandidateColumns,
  STRICT_IN_MOBILE_E164,
  MODEL_STRUCTURER_VERSION,
  FALLBACK_STRUCTURER_VERSION,
} from '../lib/candidate-phone.js';
import { normalizePhone } from '../lib/phone.js';
import { fallbackParseResumeText } from '../lib/resume-fallback.js';
import { applyPhoneCorrection, correctDSAR, CORRECTION_REJECTED_PHONE_SUBSTITUTION } from '../lib/dsar.js';

// ── The shared fixture table ────────────────────────────────────────────────

export interface PhoneFixture {
  /** What the label says, for a readable failure. */
  label: string;
  /** The string as a structurer would hand it over. */
  input: string | null;
  /** Expected `phone_e164` when the provenance is APPROVED. */
  e164: string | null;
  /** Expected `phone_valid` when the provenance is APPROVED. */
  valid: boolean;
}

/**
 * Every row a reviewer of either lane should be able to point at.
 *
 * The four rows that matter most are the ones `libphonenumber` alone gets
 * WRONG for this purpose — it answers "is this a real telephone number
 * somewhere in the world", and the question here is "can 0042 dial it":
 *
 *   - a valid US number            — real, undialable by this system
 *   - an Indian FIXED LINE         — real, refused by the admission regex
 *   - an Indian mobile starting 5  — parses, but 0042 requires 6-9
 *   - a bare ten-digit ID run      — parses as an IN number and is not one
 */
export const PHONE_FIXTURES: readonly PhoneFixture[] = [
  // ── dialable ──
  { label: 'IN mobile, bare local 10 digits', input: '9876543210', e164: '+919876543210', valid: true },
  { label: 'IN mobile, +91 with spaces and a dash', input: '+91 98765-43210', e164: '+919876543210', valid: true },
  { label: 'IN mobile, already E.164', input: '+919876543210', e164: '+919876543210', valid: true },
  { label: 'IN mobile, country code without a plus', input: '919876543210', e164: '+919876543210', valid: true },
  { label: 'IN mobile, parentheses and mixed punctuation', input: '+91 (98765) 43210', e164: '+919876543210', valid: true },
  { label: 'IN mobile, surrounding whitespace', input: '  9876543210  ', e164: '+919876543210', valid: true },
  { label: 'IN mobile starting 6 (lower bound of the class)', input: '6012345678', e164: '+916012345678', valid: true },

  // ── NOT dialable, and each for a different reason ──
  {
    // libphonenumber: VALID. Admission: refused. This row is the reason the
    // strict gate exists on top of `normalizePhone` rather than instead of it.
    label: 'IN fixed line (valid number, undialable by 0042)',
    input: '+912212345678', e164: null, valid: false,
  },
  {
    label: 'IN fixed line, local format with an STD prefix',
    input: '022 2712 3456', e164: null, valid: false,
  },
  {
    // libphonenumber: VALID. A US number is a real number and this system
    // must never place a call to it.
    label: 'valid non-IN number (US)',
    input: '+14155552671', e164: null, valid: false,
  },
  {
    // Parses to +915876543210 and libphonenumber accepts it, but the Indian
    // mobile class is 6-9. 0042's regex refuses; so does this.
    label: 'IN-shaped number starting 5 (outside the 6-9 mobile class)',
    input: '+915876543210', e164: null, valid: false,
  },
  {
    // The single most dangerous row: a ten-digit EMPLOYEE ID or reference
    // number normalizes to a syntactically valid Indian number. Strictness
    // alone cannot save this one — only provenance can. See the dedicated
    // provenance suite below.
    label: 'ten-digit run beginning 2 (ID-like; strict gate refuses)',
    input: '2012345678', e164: null, valid: false,
  },
  { label: 'free text', input: 'not-a-number', e164: null, valid: false },
  { label: 'too few digits', input: '98765', e164: null, valid: false },
  { label: 'empty string', input: '', e164: null, valid: false },
  { label: 'null (no phone on the document)', input: null, e164: null, valid: false },
];

describe('the shared dialability fixture table', () => {
  it.each(PHONE_FIXTURES)(
    'approved provenance: $label',
    ({ input, e164, valid }) => {
      const got = deriveCandidatePhone(input, MODEL_STRUCTURER_VERSION);
      expect(got.e164).toBe(e164);
      expect(got.valid).toBe(valid);
    },
  );

  it('`valid` and `e164` can never disagree, on any fixture', () => {
    // `admit_phone_attempt` reads BOTH columns. A row with `valid = true` and
    // a null number, or a number with `valid = false`, is a shape the DB would
    // have to defend against. It cannot occur because the pair is derived
    // together, and this asserts that for every row rather than by inspection.
    for (const f of PHONE_FIXTURES) {
      const got = deriveCandidatePhone(f.input, MODEL_STRUCTURER_VERSION);
      expect(got.valid).toBe(got.e164 !== null);
    }
  });

  it('preserves `phone_raw` even when the number is undialable', () => {
    // The recruiter still needs to see what the document said — that is how a
    // wrong number gets noticed at all. `phone_raw` is PII-scoped and
    // role-gated at the API edge; it is never dialed.
    const got = deriveCandidatePhone('+912212345678', MODEL_STRUCTURER_VERSION);
    expect(got.raw).toBe('+912212345678');
    expect(got.e164).toBeNull();
  });

  it('stores NULL rather than an empty string when nothing was extracted', () => {
    for (const input of [null, undefined, '', '   ']) {
      expect(deriveCandidatePhone(input, MODEL_STRUCTURER_VERSION).raw).toBeNull();
    }
  });
});

// ── The opt-out suppression premise ─────────────────────────────────────────

describe('the opt-out suppression digest premise', () => {
  it('every non-null e164 this module can produce matches 0042 exactly', () => {
    // THE INVARIANT. `apply_phone_event` digests `phone_e164` with no format
    // check; `admit_phone_attempt` digests it only when strict. Both digest
    // the SAME string precisely because this is the only producer and it can
    // only ever emit a strict value or null.
    const produced = PHONE_FIXTURES
      .map((f) => deriveCandidatePhone(f.input, MODEL_STRUCTURER_VERSION).e164)
      .filter((v): v is string => v !== null);

    expect(produced.length).toBeGreaterThan(0); // the assertion is not vacuous
    for (const e164 of produced) expect(e164).toMatch(STRICT_IN_MOBILE_E164);
  });

  it('the TypeScript predicate is byte-identical to the migration regex', () => {
    // Read from the migration text rather than restated, so the two cannot
    // drift: if 0042 ever changes its class, this fails instead of silently
    // admitting numbers the DB will refuse.
    const sql = readFileSync(
      join(process.cwd(), '..', 'supabase', 'migrations', '0042_phone_screening.sql'),
      'utf8',
    );
    // The SQL literal is `'^\+91[6-9][0-9]{9}$'`; `STRICT_IN_MOBILE_E164.source`
    // is the same characters.
    expect(sql).toContain(`'${STRICT_IN_MOBILE_E164.source}'`);
  });

  it('a number that admission would refuse is never stored, so no digest can be orphaned', () => {
    // The failure this prevents, stated as a test: store a landline, opt out,
    // and the suppression digest is of a number admission can never digest.
    // Because the landline is never stored, that sequence has no first step.
    const landline = deriveCandidatePhone('+912212345678', MODEL_STRUCTURER_VERSION);
    expect(landline.e164).toBeNull();
    const us = deriveCandidatePhone('+14155552671', MODEL_STRUCTURER_VERSION);
    expect(us.e164).toBeNull();
  });
});

describe('the strict gate re-applied at the column write', () => {
  it('collapses a hand-built non-strict decision to the undialable pair', () => {
    // `CandidatePhone` is a structural interface, so an object of the right
    // SHAPE satisfies the persistence seam whether or not `deriveCandidatePhone`
    // built it. A later caller writing the perfectly natural
    // `{e164: '<an Indian landline>', valid: true}` — libphonenumber agrees it
    // is valid — would otherwise reintroduce the exact non-strict value the
    // opt-out digest cannot tolerate. The write site refuses it independently.
    expect(toCandidateColumns({ raw: 'x', e164: '+912212345678', valid: true }))
      .toEqual({ phone_e164: null, phone_valid: false });
    expect(toCandidateColumns({ raw: 'x', e164: '+14155552671', valid: true }))
      .toEqual({ phone_e164: null, phone_valid: false });
    expect(toCandidateColumns({ raw: 'x', e164: '+915876543210', valid: true }))
      .toEqual({ phone_e164: null, phone_valid: false });
    expect(toCandidateColumns({ raw: 'x', e164: 'garbage', valid: true }))
      .toEqual({ phone_e164: null, phone_valid: false });
  });

  it('refuses a `valid: true` that carries no number, and a number with `valid: false`', () => {
    // The two columns are coalesced together, never read independently, so the
    // pair `admit_phone_attempt` checks can never be half-set.
    expect(toCandidateColumns({ raw: 'x', e164: null, valid: true }))
      .toEqual({ phone_e164: null, phone_valid: false });
    expect(toCandidateColumns({ raw: 'x', e164: '+919876543210', valid: false }))
      .toEqual({ phone_e164: null, phone_valid: false });
  });

  it('is undialable when no decision was supplied at all', () => {
    expect(toCandidateColumns(undefined)).toEqual({ phone_e164: null, phone_valid: false });
  });

  it('passes a genuinely strict decision through unchanged', () => {
    // Not a rubber stamp — the gate must still admit the real case.
    expect(toCandidateColumns(deriveCandidatePhone('9876543210', MODEL_STRUCTURER_VERSION)))
      .toEqual({ phone_e164: '+919876543210', phone_valid: true });
  });

  it('agrees with the deriver on every fixture', () => {
    for (const f of PHONE_FIXTURES) {
      const derived = deriveCandidatePhone(f.input, MODEL_STRUCTURER_VERSION);
      expect(toCandidateColumns(derived)).toEqual({
        phone_e164: derived.e164, phone_valid: derived.valid,
      });
    }
  });
});

// ── Provenance ──────────────────────────────────────────────────────────────

describe('provenance: only a model-authored field may be dialed', () => {
  it('the deterministic fallback structurer can never produce a dialable number', () => {
    // Same input, same strict format, opposite outcome. Nothing about the
    // STRING decides this; only where it came from.
    const approved = deriveCandidatePhone('9876543210', MODEL_STRUCTURER_VERSION);
    const fallback = deriveCandidatePhone('9876543210', FALLBACK_STRUCTURER_VERSION);

    expect(approved).toEqual({ raw: '9876543210', e164: '+919876543210', valid: true });
    expect(fallback).toEqual({ raw: '9876543210', e164: null, valid: false });
  });

  it('a `+fallback` suffix disqualifies an otherwise approved tag', () => {
    // `runResumeIngestion` marks a model parse that produced nothing useful
    // and was rescued by the regex extractor as `<tag>+fallback`. The fields
    // in that result came from the REGEX, so the approved prefix must not
    // launder them.
    expect(isDialableStructurer(MODEL_STRUCTURER_VERSION)).toBe(true);
    expect(isDialableStructurer(`${MODEL_STRUCTURER_VERSION}+fallback`)).toBe(false);
    expect(
      deriveCandidatePhone('9876543210', `${MODEL_STRUCTURER_VERSION}+fallback`).valid,
    ).toBe(false);
  });

  it('an unknown, absent or empty structurer tag is undialable (allowlist, not denylist)', () => {
    for (const tag of [null, undefined, '', 'some-future-extractor-9', 'deterministic-fallback-2']) {
      expect(isDialableStructurer(tag)).toBe(false);
      expect(deriveCandidatePhone('9876543210', tag).valid).toBe(false);
    }
  });

  it('an employee ID that normalizes to a VALID Indian mobile is still not dialable', () => {
    // THE CASE THE STRICT GATE CANNOT CATCH. A ten-digit staff number
    // beginning 9 is indistinguishable from a mobile by format: it parses, it
    // is in the 6-9 class, it has ten digits. The ONLY thing standing between
    // it and an outbound call to a stranger is that the deterministic
    // extractor found it, and the deterministic extractor is not allowed to
    // decide who gets called.
    const resume = [
      'Rohan Mehta',
      'Employee ID: 9988776655',
      'Senior Engineer, 2018-2024',
      'Skills: TypeScript, Postgres',
    ].join('\n');

    const extracted = fallbackParseResumeText(resume);
    expect(extracted.phone).toBe('9988776655');           // the regex did match it

    // Strictness alone would have promoted it:
    const normalized = normalizePhone(extracted.phone);
    expect(normalized.e164).toBe('+919988776655');
    expect(normalized.e164).toMatch(STRICT_IN_MOBILE_E164);

    // Provenance refuses it. `phone_raw` still records what the document said.
    const decided = deriveCandidatePhone(extracted.phone, FALLBACK_STRUCTURER_VERSION);
    expect(decided).toEqual({ raw: '9988776655', e164: null, valid: false });
  });

  it('a date range picked up by the fallback extractor is likewise inert', () => {
    const resume = 'Jane Doe\nExperience: 1998-2004 and 2012-2019\nSummary line for usefulness.';
    const extracted = fallbackParseResumeText(resume);
    const decided = deriveCandidatePhone(extracted.phone, FALLBACK_STRUCTURER_VERSION);
    expect(decided.e164).toBeNull();
    expect(decided.valid).toBe(false);
  });
});

// ── DSAR correction: may remove dialability, never create it ────────────────

describe('DSAR correction can only withdraw a dial target', () => {
  it('refuses a SUBSTITUTION into phone_e164', () => {
    // Accepting one would make a staff-operated rectification endpoint a
    // manual source of dialable numbers, which the approved-source rule
    // forbids, and would let an arbitrary non-strict string reach the column
    // the opt-out digest depends on.
    expect(applyPhoneCorrection('phone_e164', '+919876543210')).toBeNull();
    expect(applyPhoneCorrection('phone_e164', '+14155552671')).toBeNull();
    expect(applyPhoneCorrection('phone_e164', 'anything at all')).toBeNull();
  });

  it('accepts an ERASURE of phone_e164 and clears phone_valid with it', () => {
    for (const erasure of [null, undefined, '', '   ']) {
      expect(applyPhoneCorrection('phone_e164', erasure)).toEqual({
        phone_e164: null, phone_valid: false,
      });
    }
  });

  it('REPORTS a refused substitution instead of swallowing it', async () => {
    // A rectification denied on policy grounds must be VISIBLE. Reporting it
    // as an empty `corrections` array is indistinguishable from a no-op, and
    // this refusal is a new, deliberate decision the data subject is entitled
    // to be told about. Asserted end-to-end through `correctDSAR`, not just on
    // the pure rule, because the reporting is what was missing.
    const CANDIDATE_ID = 'cand_1';
    const dsarRow = {
      id: 'dsar_1', candidate_id: CANDIDATE_ID, request_type: 'correct',
      request_status: 'pending', requested_by: 'actor_1', requested_at: 'now',
      reviewed_by: null, reviewed_at: null, fulfilled_at: null,
      rejection_reason: null, legal_hold_blocked: false, notes: null,
      metadata: null, created_at: 'now', updated_at: 'now',
    };
    const candidateRow = {
      id: CANDIDATE_ID, name: 'Ada',
      phone_raw: '9876543210', phone_e164: '+919876543210', phone_valid: true,
    };
    const audits: Array<Record<string, unknown>> = [];
    const updates: Array<Record<string, unknown>> = [];

    const client = {
      from(table: string) {
        const row = table === 'candidates' ? candidateRow
          : table === 'data_subject_requests' ? dsarRow
            : null;
        const b: Record<string, unknown> = {};
        const chain = () => b;
        b.insert = (p: Record<string, unknown>) => { audits.push(p); return chain(); };
        b.update = (p: Record<string, unknown>) => {
          if (table === 'candidates') updates.push(p);
          return chain();
        };
        b.delete = chain; b.select = chain; b.eq = chain; b.order = chain; b.limit = chain;
        b.single = async () => ({ data: row, error: null });
        b.maybeSingle = b.single;
        b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: row, error: null }).then(ok);
        return b;
      },
    } as never;

    const res = await correctDSAR(
      'dsar_1',
      [
        { field: 'phone_e164', value: '+919000000000' },  // SUBSTITUTION — refused
        { field: 'name', value: 'Ada Lovelace' },          // ordinary — applied
      ],
      'actor_1',
      client,
    );

    expect(res.success).toBe(true);
    // The refusal is named, with a stable machine reason…
    expect(res.rejected).toEqual([
      { field: 'phone_e164', reason: CORRECTION_REJECTED_PHONE_SUBSTITUTION },
    ]);
    // …the ordinary correction still went through…
    expect(res.corrections.map((c) => c.field)).toEqual(['name']);
    // …and no substituted number reached the column.
    for (const u of updates) expect(u.phone_e164).toBeUndefined();

    // The denial is DURABLE: the governance audit carries the field name and
    // the reason code — and no value. That audit, not the HTTP body, is where
    // this PR records the refusal (see `redactCorrections`).
    const corrected = audits.find((a) => a.action === 'data_corrected');
    expect(corrected).toBeDefined();
    const details = corrected!.details as { rejected?: string[] };
    expect(details.rejected).toEqual([`phone_e164:${CORRECTION_REJECTED_PHONE_SUBSTITUTION}`]);
    expect(JSON.stringify(details)).not.toContain('9000000000');
  });

  it('records the denial even when EVERY correction was refused', () => {
    // The zero-applied path takes a DIFFERENT audit branch. A refusal that is
    // reported on one branch and dropped on the other is the shape where a
    // control looks applied and is not — and "every correction refused" is the
    // most likely real request, since a data subject correcting their number
    // sends exactly one field.
    const audits: Array<Record<string, unknown>> = [];
    const dsarRow = {
      id: 'dsar_2', candidate_id: 'cand_2', request_type: 'correct',
      request_status: 'pending', requested_by: 'actor_1', requested_at: 'now',
      reviewed_by: null, reviewed_at: null, fulfilled_at: null,
      rejection_reason: null, legal_hold_blocked: false, notes: null,
      metadata: null, created_at: 'now', updated_at: 'now',
    };
    const candidateRow = { id: 'cand_2', name: 'Ada', phone_e164: '+919876543210' };
    const client = {
      from(table: string) {
        const row = table === 'candidates' ? candidateRow
          : table === 'data_subject_requests' ? dsarRow : null;
        const b: Record<string, unknown> = {};
        const chain = () => b;
        b.insert = (p: Record<string, unknown>) => { audits.push(p); return chain(); };
        b.update = chain; b.delete = chain; b.select = chain;
        b.eq = chain; b.order = chain; b.limit = chain;
        b.single = async () => ({ data: row, error: null });
        b.maybeSingle = b.single;
        b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: row, error: null }).then(ok);
        return b;
      },
    } as never;

    return correctDSAR('dsar_2', [{ field: 'phone_e164', value: '+919000000000' }], 'actor_1', client)
      .then((res) => {
        expect(res.corrections).toEqual([]);
        expect(res.rejected).toEqual([
          { field: 'phone_e164', reason: CORRECTION_REJECTED_PHONE_SUBSTITUTION },
        ]);
        const corrected = audits.find((a) => a.action === 'data_corrected');
        expect(corrected).toBeDefined();
        const details = corrected!.details as { rejected?: string[] };
        expect(details.rejected).toEqual([`phone_e164:${CORRECTION_REJECTED_PHONE_SUBSTITUTION}`]);
        expect(JSON.stringify(details)).not.toContain('9000000000');
      });
  });

  it('names a stable machine reason for the refusal', () => {
    expect(CORRECTION_REJECTED_PHONE_SUBSTITUTION).toBe('phone_substitution_forbidden');
    expect(CORRECTION_REJECTED_PHONE_SUBSTITUTION).toMatch(/^[a-z0-9_.:-]{1,64}$/);
  });

  it('correcting phone_raw withdraws dialability rather than leaving a stale target', () => {
    // If the number of record just changed, continuing to dial the previous
    // one while displaying the new one is the worst available outcome.
    expect(applyPhoneCorrection('phone_raw', '+91 90000-00000')).toEqual({
      phone_raw: '+91 90000-00000', phone_e164: null, phone_valid: false,
    });
    expect(applyPhoneCorrection('phone_raw', null)).toEqual({
      phone_raw: null, phone_e164: null, phone_valid: false,
    });
  });
});

// ── The redaction helpers, at the unit level ────────────────────────────────

describe('role-based redaction', () => {
  const row = {
    id: 'c1',
    phone_raw: '+91 98765-43210',
    phone_e164: '+919876543210',
    phone_valid: true,
    parsed: { name: 'Ada', phone: '+91 98765-43210', skills: [] },
  };

  it('admin sees every carrier', () => {
    expect(redactCandidatePhone({ ...row }, 'admin')).toEqual(row);
  });

  it.each(['viewer', 'interviewer', undefined, null, 'some-unknown-role'])(
    'role %s receives no number through ANY of the three carriers',
    (role) => {
      const out = redactCandidatePhone({ ...row }, role as string) as Record<string, unknown>;
      expect('phone_raw' in out).toBe(false);
      expect(out.phone_e164).toBeNull();
      expect((out.parsed as { phone: unknown }).phone).toBeNull();
      // The boolean survives — it discloses no contact detail and the UI needs
      // it to explain why a candidate is or is not reachable.
      expect(out.phone_valid).toBe(true);
    },
  );

  it('never mutates the row it was given', () => {
    // A redaction that edited in place would be a time bomb: the same row
    // object reaching a second consumer — a cache, a second projection, an
    // audit sink — would already be redacted, or worse, a row redacted for a
    // viewer would poison an admin's copy. Assert the input is untouched.
    const original = { ...row, parsed: { ...row.parsed } };
    const out = redactCandidatePhone(row, 'viewer');
    expect(row).toEqual(original);
    expect(row.parsed.phone).toBe('+91 98765-43210');
    expect(out).not.toBe(row);
    expect((out as { parsed: unknown }).parsed).not.toBe(row.parsed);
  });

  it('keeps `phone_e164` PRESENT and null, because the schema marks it required', () => {
    const out = redactCandidatePhone({ ...row }, 'viewer') as Record<string, unknown>;
    expect('phone_e164' in out).toBe(true);
    expect(out.phone_e164).toBeNull();
  });

  it('does not invent a `phone_e164` key on a row that never had one', () => {
    const out = redactCandidatePhone({ id: 'c1', name: 'Ada' }, 'viewer');
    expect('phone_e164' in out).toBe(false);
  });

  it('leaves a null or non-object `parsed` alone', () => {
    expect(redactCandidatePhone({ parsed: null }, 'viewer').parsed).toBeNull();
    expect(redactCandidatePhone({ parsed: 'text' }, 'viewer').parsed).toBe('text');
    expect(redactCandidatePhone({ parsed: {} }, 'viewer').parsed).toEqual({});
  });

  it('redactPhoneView withholds both string forms and keeps the boolean', () => {
    const phone = { raw: '9876543210', e164: '+919876543210', valid: true };
    expect(redactPhoneView(phone, 'admin')).toEqual(phone);
    expect(redactPhoneView(phone, 'interviewer')).toEqual({ raw: null, e164: null, valid: true });
    expect(redactPhoneView({ raw: 'x', e164: null, valid: false }, 'viewer'))
      .toEqual({ raw: null, e164: null, valid: false });
  });
});

// ── Structural assertions ───────────────────────────────────────────────────

describe('structural boundaries of this change', () => {
  const SRC = join(process.cwd(), 'src');

  function read(rel: string): string {
    return readFileSync(join(SRC, rel), 'utf8');
  }

  it('nothing in this PR imports the P2 phone-screening module', () => {
    // The two lanes are independent by contract: P2 is DB-mocked and must not
    // depend on a number existing, and this PR must not depend on P2 shipping.
    for (const f of [
      'lib/candidate-phone.ts',
      'routes/resumes.ts',
      'routes/candidates.ts',
      'routes/ashby-review.ts',
      'integrations/ashby/runtime.ts',
      'integrations/ashby/runtime-workers.ts',
      'integrations/ashby/materialize.ts',
    ]) {
      expect(read(f)).not.toContain('phone-screening');
    }
  });

  it('the derivation module reaches no database, network, provider or queue', () => {
    const src = read('lib/candidate-phone.ts');
    for (const forbidden of ['supabase', 'fetch(', '.rpc(', ".from('", 'job_queue', 'axios', 'http']) {
      expect(src).not.toContain(forbidden);
    }
  });

  it('no phone value is handed to a logger, an audit record or a job payload', () => {
    // A grep of the OUTPUT would be vacuous — `lib/logger.ts` redacts runs of
    // 10+ digits, so a leaking call site still produces a clean line. The
    // assertion has to be at the CALL SITE, and it is: no module that handles
    // a phone value passes one into a logger or audit call.
    let scanned = 0;
    for (const f of ['routes/resumes.ts', 'routes/candidates.ts', 'routes/ashby-review.ts',
      'integrations/ashby/runtime-workers.ts', 'lib/candidate-phone.ts',
      // The two paths added when model structuring was wired in. The first
      // HOLDS the full resume text; the second is where it is handed over.
      'lib/resume-structurer.ts', 'integrations/ashby/runtime.ts']) {
      const src = read(f);
      const calls = src.match(/(?:Logger|logger)\.(?:info|warn|error|debug)\([^)]*\)|recordAudit\([^)]*\)|recordGovernanceAudit\(\{[^}]*\}/g) ?? [];
      scanned += calls.length;
      for (const call of calls) {
        expect(call).not.toContain('phone_e164');
        expect(call).not.toContain('phone_raw');
        expect(call).not.toMatch(/\bphone\b\s*[,)]/);
      }
    }
    // Guards the assertion against becoming vacuous: if the logger idiom is
    // ever renamed, this fails rather than quietly checking nothing.
    expect(scanned).toBeGreaterThanOrEqual(10);
  });

  it('introduces no external contact lookup and no provider call', () => {
    // The approved SOURCE is the resume structurer and nothing else. An Ashby
    // contact-field API, an enrichment provider or a bulk backfill would each
    // be a second source with different consent, and none exists: the only
    // provider surface this PR touches is the resume file it already fetched.
    for (const f of ['lib/candidate-phone.ts', 'integrations/ashby/materialize.ts']) {
      const src = read(f);
      // No provider client, no HTTP, no enrichment vendor is reachable from
      // either module — asserted on the IMPORT graph, which is what actually
      // bounds what a module can do, rather than on prose.
      const imports = src.match(/^import[\s\S]*?from '[^']+';$/gm) ?? [];
      for (const imp of imports) {
        expect(imp).not.toMatch(/\.\/client\.js|node:https?|undici|axios|enrich/);
      }
      expect(src).not.toMatch(/\bcandidate\.(info|list)\b/);
      expect(src).not.toMatch(/\bfetch\s*\(/);
    }
    // The one place provenance is decided for Ashby reads it from the parse it
    // already performed — it issues no additional request of its own.
    const workers = read('integrations/ashby/runtime-workers.ts');
    const derive = workers.slice(
      workers.indexOf('async function persistParsedCandidate'),
      workers.indexOf('async function persistParsedCandidate') + 2000,
    );
    expect(derive).toContain('deriveCandidatePhone(structured.phone, structurerVersion)');
    expect(derive).not.toContain('await client.');
  });

  it('the DETERMINISTIC Ashby tag is not on the dialable allowlist', () => {
    // Narrow by design: this asserts one constant, and nothing about the live
    // path. An earlier version of this test claimed to be the tripwire for
    // "the Ashby path can never dial", and it stayed GREEN when the model tier
    // was wired — because the constant it checks never changed. A safety
    // assertion that cannot fail when the thing it guards changes is worse
    // than no assertion, so the live-path claim was moved to a test that
    // drives the real parse port (`phone-model-structurer.test.ts`).
    const runtime = read('integrations/ashby/runtime.ts');
    const tag = runtime.match(/ASHBY_STRUCTURER_VERSION = '([^']+)'/)?.[1];
    expect(tag).toBeTruthy();
    expect(isDialableStructurer(tag!)).toBe(false);
  });

  it('a merged result whose phone came from the regex is refused', () => {
    // The suffix guard is what stops a merge from laundering a digit-run false
    // positive into a call: the rest of the row can be entirely model-authored
    // and the phone still is not.
    expect(isDialableStructurer(`${MODEL_STRUCTURER_VERSION}+fallback`)).toBe(false);
    expect(deriveCandidatePhone('9876543210', `${MODEL_STRUCTURER_VERSION}+fallback`))
      .toEqual({ raw: '9876543210', e164: null, valid: false });
  });

  it('the candidate write sites fail closed when no decision was supplied', () => {
    // `phone?: CandidatePhone` is optional so pre-existing stores type-check.
    // Optional must mean UNDIALABLE, not "whatever the parser said".
    // Both candidate writers spread `toCandidateColumns(...)`, which is the
    // single function that decides these two columns — and which returns the
    // undialable pair for `undefined`. Neither writer names the columns
    // directly, so neither can drift from the strict gate.
    const runtime = read('integrations/ashby/runtime.ts');
    expect(runtime.match(/\.\.\.toCandidateColumns\(input\.phone\)/g)?.length).toBe(2);
    // insertCandidate + updateCandidateFromParse, and nowhere else.
    // The ONLY direct assignments left anywhere in the file are the PII-minimal
    // shell's hard nulls. Any other literal would be a second rule.
    expect(runtime.match(/phone_e164:\s*\S+/g)).toEqual(['phone_e164: null,']);
    expect(runtime.match(/phone_valid:\s*\S+/g)).toEqual(['phone_valid: false,']);
    // The upload route uses the same function rather than a second rule.
    expect(read('routes/resumes.ts')).toContain('...toCandidateColumns(phone)');
  });

  it('the populate CAS on `resume_id is null` is preserved verbatim', () => {
    // The idempotency of the whole ready path rests on this one clause. The
    // phone columns joined the SAME allowlist inside the SAME update; they did
    // not get their own write.
    const runtime = read('integrations/ashby/runtime.ts');
    expect(runtime).toContain(".is('resume_id', null)");
    const update = runtime.slice(
      runtime.indexOf('async updateCandidateFromParse'),
      runtime.indexOf('async bindLinkColumn'),
    );
    expect(update).toContain(".is('resume_id', null)");
    expect(update).toContain('toCandidateColumns(input.phone)');
    expect(update).toContain('phone_raw:');
    // Ownership and funnel position remain unreachable from a parse.
    for (const forbidden of ['role_id:', 'owner_id:', 'status:', 'ats_source:']) {
      expect(update).not.toContain(forbidden);
    }
  });
});
