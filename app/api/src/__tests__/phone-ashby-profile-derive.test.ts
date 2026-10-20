/**
 * phone-ashby-profile-derive.test.ts — the dialing decision for a number taken
 * from the Ashby candidate profile (ADR-0018, M017 design §2.2 and §1.7).
 *
 * `deriveAshbyProfilePhone` is the second approved way a number becomes
 * dialable, so it is held to the same strict format gate as the resume path,
 * plus two rules of its own:
 *
 *   - PRIMARY ONLY. The designated primary is the only number evaluated when
 *     there is one. A primary that fails is never replaced by a secondary that
 *     passes; a list entry is used only when no primary exists at all.
 *   - PLACEHOLDERS REFUSED. All-one-digit, a leading digit and nine zeros, and
 *     ascending or descending runs pass the strict regex and are refused here.
 *
 * It must not widen the resume path: the structurer allowlist is pinned
 * unchanged, and a placeholder-shaped resume number keeps today's verdict.
 *
 * Every number in this file is synthetic. India publishes no reserved
 * documentation range, so these are invented values, not "reserved" ones.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  deriveAshbyProfilePhone,
  deriveCandidatePhone,
  isDialableStructurer,
  toCandidateColumns,
  MODEL_STRUCTURER_VERSION,
  FALLBACK_STRUCTURER_VERSION,
  STRICT_IN_MOBILE_E164,
  type AshbyProfilePhone,
} from '../lib/candidate-phone.js';
import { extractAshbyCandidateProfile } from '../integrations/ashby/candidate-profile.js';

const E164 = '+919812345670';
const OTHER_E164 = '+919812345671';

function primaryOnly(primary: string | null): AshbyProfilePhone {
  return deriveAshbyProfilePhone({ primary, others: [] });
}

describe('deriveAshbyProfilePhone — the research format list', () => {
  // Every common Indian spelling of one mobile number (M017-RESEARCH: checked
  // against libphonenumber-js 1.13.7) normalizes to the same strict value.
  const SPELLINGS = [
    '+919812345670',
    '+91 98123 45670',
    '+91-98123-45670',
    '+91 9812345670',
    '+91 981 234 5670',
    '+91.98123.45670',
    '+ 91 98123 45670',
    '(+91) 98123 45670',
    '+91 (981) 234-5670',
    '91 98123 45670',
    '919812345670',
    '0091 98123 45670',
    '00919812345670',
    '098123 45670',
    '09812345670',
    '9812345670',
    '98123 45670',
    '98123-45670',
    '981-234-5670',
  ];

  it.each(SPELLINGS)('%s is dialable as the strict +91 value', (spelling) => {
    const out = primaryOnly(spelling);
    expect(out.verdict).toBe('dialable');
    expect(out.e164).toBe(E164);
    expect(STRICT_IN_MOBILE_E164.test(out.e164!)).toBe(true);
  });

  it('raw is the value as written, trimmed (a spaced leading plus collapsed)', () => {
    expect(primaryOnly('  +91 98123 45670 ').raw).toBe('+91 98123 45670');
    expect(primaryOnly('+ 91 98123 45670').raw).toBe('+91 98123 45670');
  });

  it('too few or too many digits are invalid', () => {
    for (const short of ['981234567', '98123456701', '+91 98123 4567', 'not a number']) {
      const out = primaryOnly(short);
      expect(out.verdict).toBe('invalid');
      expect(out.e164).toBeNull();
      expect(out.raw).toBe(short);
    }
  });
});

describe('deriveAshbyProfilePhone — primary only', () => {
  it('a foreign primary is refused even when a valid Indian secondary exists', () => {
    const out = deriveAshbyProfilePhone({ primary: '+44 20 7946 0958', others: ['+91 98123 45670'] });
    expect(out).toEqual({ raw: '+44 20 7946 0958', e164: null, verdict: 'invalid' });
  });

  it('a placeholder or landline primary is not replaced by a valid secondary', () => {
    expect(deriveAshbyProfilePhone({ primary: '9999999999', others: ['9812345670'] }).verdict)
      .toBe('placeholder');
    expect(deriveAshbyProfilePhone({ primary: '+91 22 2345 6789', others: ['9812345670'] }).verdict)
      .toBe('invalid');
  });

  it('a valid primary wins over every list entry', () => {
    const out = deriveAshbyProfilePhone({ primary: '9812345670', others: ['9812345671'] });
    expect(out).toEqual({ raw: '9812345670', e164: E164, verdict: 'dialable' });
  });

  it('a list entry is used only when there is no primary at all', () => {
    for (const primary of [null, '', '   ']) {
      const out = deriveAshbyProfilePhone({ primary, others: ['', '  ', '+91 98123 45671', '9812345670'] });
      expect(out).toEqual({ raw: '+91 98123 45671', e164: OTHER_E164, verdict: 'dialable' });
    }
  });

  it('only the FIRST non-empty list entry is evaluated', () => {
    const out = deriveAshbyProfilePhone({ primary: null, others: ['+44 20 7946 0958', '9812345670'] });
    expect(out.verdict).toBe('invalid');
    expect(out.e164).toBeNull();
  });

  it('no number anywhere is absent, with nothing to record', () => {
    expect(deriveAshbyProfilePhone({ primary: null, others: [] }))
      .toEqual({ raw: null, e164: null, verdict: 'absent' });
    expect(deriveAshbyProfilePhone({ primary: '  ', others: ['', ' '] }))
      .toEqual({ raw: null, e164: null, verdict: 'absent' });
  });

  it('end to end with the extractor: the applicant-designated primary decides', () => {
    // candidate.info lists the primary second; the extractor still hands it
    // over as the primary, and its failure is final.
    const profile = extractAshbyCandidateProfile({}, {
      primaryPhoneNumber: { value: '+1 415 555 0134', isPrimary: true },
      phoneNumbers: [
        { value: '+91 98123 45670', isPrimary: false },
        { value: '+1 415 555 0134', isPrimary: true },
      ],
    });
    const out = deriveAshbyProfilePhone({ primary: profile.primaryNumber, others: profile.otherNumbers });
    expect(out.verdict).toBe('invalid');
    expect(out.e164).toBeNull();
  });
});

describe('deriveAshbyProfilePhone — placeholders refused', () => {
  const PLACEHOLDERS = [
    // all one digit
    '6666666666', '7777777777', '8888888888', '9999999999',
    // a leading digit and nine zeros
    '6000000000', '7000000000', '8000000000', '9000000000',
    // ascending runs, modulo 10
    '6789012345', '7890123456', '8901234567', '9012345678',
    // descending runs, modulo 10
    '6543210987', '7654321098', '8765432109', '9876543210',
  ];

  it.each(PLACEHOLDERS)('%s is a placeholder in every spelling', (local) => {
    for (const spelling of [local, `+91${local}`, `+91 ${local.slice(0, 5)} ${local.slice(5)}`, `0${local}`]) {
      const out = primaryOnly(spelling);
      expect(out.verdict).toBe('placeholder');
      expect(out.e164).toBeNull();
      expect(out.raw).toBe(spelling);
    }
  });

  it('every placeholder passes the strict regex, which is why the denylist exists', () => {
    for (const local of PLACEHOLDERS) {
      expect(STRICT_IN_MOBILE_E164.test(`+91${local}`)).toBe(true);
    }
  });

  it('near misses are ordinary numbers and stay dialable', () => {
    for (const local of ['9812345670', '9876543211', '9000000001', '9999999998', '6789012346', '8000000009']) {
      const out = primaryOnly(local);
      expect(out.verdict).toBe('dialable');
      expect(out.e164).toBe(`+91${local}`);
    }
  });

  it('the denylist is Ashby-only: the resume path keeps its verdict', () => {
    // Resume-path behaviour is pinned by phone-resume-source.test.ts; adding
    // the denylist there would be a separate decision, not a side effect.
    expect(deriveCandidatePhone('9876543210', MODEL_STRUCTURER_VERSION))
      .toEqual({ raw: '9876543210', e164: '+919876543210', valid: true });
  });
});

describe('deriveAshbyProfilePhone — landline and foreign numbers', () => {
  it('a fixed line with a 2-5 area code and foreign numbers are invalid', () => {
    for (const value of [
      '+91 22 2345 6789', '022 2345 6789', '+91 40 2345 6789',
      '+44 20 7946 0958', '+1 415 555 0134', '+971 50 123 4567', '+65 9123 4567',
      // A US number without its country code is read as Indian, and fails
      // the strict gate because Indian numbers cannot start with 4.
      '415 555 0134',
    ]) {
      const out = primaryOnly(value);
      expect(out.verdict).toBe('invalid');
      expect(out.e164).toBeNull();
    }
  });

  it('KNOWN GAP (design §6): 7x/8x landlines and bare foreign 10-digit numbers pass', () => {
    // The strict regex is a format gate, not a line-type check, on every
    // path. This pins today's behaviour so the planned line-type follow-up
    // flips these deliberately; the identity check and the mismatch release
    // are what limit the harm until then.
    expect(primaryOnly('080 2345 6789')).toMatchObject({ verdict: 'dialable', e164: '+918023456789' });
    expect(primaryOnly('079 2345 6789')).toMatchObject({ verdict: 'dialable', e164: '+917923456789' });
    expect(primaryOnly('917 555 0134')).toMatchObject({ verdict: 'dialable', e164: '+919175550134' });
  });
});

describe('deriveAshbyProfilePhone — fails closed', () => {
  it('two numbers in one field are invalid, never one of the two', () => {
    for (const value of [
      '9812345670 / 9812345671',
      '9812345670, 9812345671',
      '9812345670 9812345671',
      '+91 98123 45670 or +91 98123 45671',
    ]) {
      const out = primaryOnly(value);
      expect(out.verdict).toBe('invalid');
      expect(out.e164).toBeNull();
      expect(out.raw).toBe(value);
    }
  });

  it('e164 is non-null exactly when the verdict is dialable, and survives the column write', () => {
    const inputs = [
      '9812345670', '9999999999', '+44 20 7946 0958', '9812345670 / 9812345671', '', 'x'.repeat(200),
    ];
    for (const value of inputs) {
      const out = primaryOnly(value);
      expect(out.e164 !== null).toBe(out.verdict === 'dialable');
      const columns = toCandidateColumns({ raw: out.raw, e164: out.e164, valid: out.verdict === 'dialable' });
      expect(columns.phone_valid).toBe(out.verdict === 'dialable');
      expect(columns.phone_e164).toBe(out.e164);
    }
  });
});

describe('the structurer allowlist is unchanged', () => {
  it('DIALABLE_STRUCTURERS still holds the model tag and nothing else', () => {
    // The profile number has its own derivation; it does NOT get a structurer
    // tag on the allowlist. Asserted on the declaration itself so a widened
    // set fails here rather than in review.
    const src = readFileSync(join(process.cwd(), 'src/lib/candidate-phone.ts'), 'utf8');
    expect(src).toContain(
      'const DIALABLE_STRUCTURERS: ReadonlySet<string> = new Set([MODEL_STRUCTURER_VERSION]);',
    );
    expect(isDialableStructurer(MODEL_STRUCTURER_VERSION)).toBe(true);
    for (const tag of [FALLBACK_STRUCTURER_VERSION, 'ashby-profile', 'ashby-profile-1', 'ashby']) {
      expect(isDialableStructurer(tag)).toBe(false);
    }
  });
});
