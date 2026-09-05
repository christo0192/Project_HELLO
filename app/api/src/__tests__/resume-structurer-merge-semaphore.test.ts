/**
 * resume-structurer-merge-semaphore.test.ts — three P0/P1 properties of the
 * bounded model structurer that pull in different directions:
 *
 *   1. MERGE FLOOR. When the model omits a role field but the deterministic
 *      extractor now provides one (the deterministic side extracts prose roles),
 *      the merged result KEEPS the role: model-wins-when-present, else
 *      deterministic. Losing a role the regex found would be a silent regression
 *      of exactly the field the prose-role work exists to populate.
 *
 *   2. coercePhone COLLAPSE. A model echoing the leading-"+" instruction as
 *      "+ 91 ..." is stored canonically as "+91 ..." so the strict provenance
 *      gate cannot be defeated by a stray space.
 *
 *   3. CONCURRENCY SEMAPHORE. Concurrent model calls are bounded independently
 *      of the parser pool, and a wait that exceeds the budget FALLS THROUGH TO
 *      null (deterministic fallback) — never throws into the caller.
 *
 * Every phone value here is synthetic.
 */

import { describe, it, expect } from 'vitest';
import {
  mergeStructuredResume,
  coerceStructuredResume,
  structureResumeWithModel,
  __setModelConcurrencyForTest,
  type ResumeModelRunner,
} from '../lib/resume-structurer.js';
import type { ParsedResume } from '../lib/types.js';

const EMPTY_MODEL: ParsedResume = {
  name: null, email: null, phone: null, skills: [], experience_years: null,
  current_role: null, summary: null, recent_role: null, prior_roles: [],
  career_highlights: [], education: [], certifications: [],
};

const DETERMINISTIC_WITH_ROLES: ParsedResume = {
  name: 'Rohan Mehta',
  email: 'rohan@example.invalid',
  phone: '98765 43210',
  skills: ['Sales', 'CRM'],
  experience_years: 6,
  current_role: 'Senior Sales Consultant',
  summary: 'Consultative sales background.',
  recent_role: { title: 'Senior Sales Consultant', employer: 'Acme', period: '2020-present', highlights: ['Exceeded quota'] },
  prior_roles: [{ title: 'Sales Associate', employer: 'Prior Co', period: null, highlights: [] }],
  career_highlights: ['Top performer'],
  education: ['MBA'],
  certifications: ['Salesforce Administrator'],
};

describe('mergeStructuredResume — role floor from the deterministic side', () => {
  it('fills recent_role/current_role/prior_roles/experience_years/education from deterministic when the model omitted them', () => {
    const { structured } = mergeStructuredResume(EMPTY_MODEL, DETERMINISTIC_WITH_ROLES);
    expect(structured.recent_role).toEqual(DETERMINISTIC_WITH_ROLES.recent_role);
    expect(structured.current_role).toBe('Senior Sales Consultant');
    expect(structured.prior_roles).toEqual(DETERMINISTIC_WITH_ROLES.prior_roles);
    expect(structured.experience_years).toBe(6);
    expect(structured.education).toEqual(['MBA']);
    expect(structured.certifications).toEqual(['Salesforce Administrator']);
    expect(structured.career_highlights).toEqual(['Top performer']);
  });

  it('the model still WINS per field where it produced a value', () => {
    const model: ParsedResume = {
      ...EMPTY_MODEL,
      current_role: 'Model-Provided Title',
      recent_role: { title: 'Model Role', employer: null, period: null, highlights: [] },
      experience_years: 9,
    };
    const { structured } = mergeStructuredResume(model, DETERMINISTIC_WITH_ROLES);
    expect(structured.current_role).toBe('Model-Provided Title');
    expect(structured.recent_role).toEqual(model.recent_role);
    expect(structured.experience_years).toBe(9);
    // …and a field the model left empty still fills from deterministic.
    expect(structured.prior_roles).toEqual(DETERMINISTIC_WITH_ROLES.prior_roles);
  });

  it('phoneFromModel is false when the phone came from the deterministic side', () => {
    const { phoneFromModel } = mergeStructuredResume(EMPTY_MODEL, DETERMINISTIC_WITH_ROLES);
    expect(phoneFromModel).toBe(false);
  });
});

describe('coercePhone — collapses a spaced country-code plus', () => {
  it('stores "+ 91 ..." canonically as "+91 ..."', () => {
    expect(coerceStructuredResume({ phone: '+ 91 98765 43210' })!.phone).toBe('+91 98765 43210');
  });

  it('collapses multiple leading spaces after the plus', () => {
    expect(coerceStructuredResume({ phone: '+   91 90000 00000' })!.phone).toBe('+91 90000 00000');
  });

  it('leaves an already-canonical number untouched', () => {
    expect(coerceStructuredResume({ phone: '+91 98765 43210' })!.phone).toBe('+91 98765 43210');
  });

  it('does not touch a plus that appears mid-string', () => {
    // Only the FIRST "+  " run is collapsed; an internal "+ " is left alone.
    expect(coerceStructuredResume({ phone: '98765 + 43210' })!.phone).toBe('98765 + 43210');
  });
});

describe('structureResumeWithModel — concurrency semaphore', () => {
  it('bounds concurrent model calls to the configured capacity', async () => {
    const restore = __setModelConcurrencyForTest(2);
    let inFlight = 0;
    let maxInFlight = 0;
    const gate: Array<() => void> = [];
    const runner: ResumeModelRunner = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => gate.push(resolve));
      inFlight -= 1;
      return { phone: '98765 43210', skills: [] };
    };
    try {
      const calls = Array.from({ length: 6 }, () => structureResumeWithModel('résumé text here', runner));
      // Let the first wave acquire slots.
      await new Promise((r) => setTimeout(r, 10));
      expect(maxInFlight).toBeLessThanOrEqual(2);
      // Drain: release each running call, which hands its slot to a waiter.
      while (gate.length > 0 || inFlight > 0) {
        const next = gate.shift();
        if (next) next();
        await new Promise((r) => setTimeout(r, 1));
      }
      await Promise.all(calls);
      expect(maxInFlight).toBe(2); // never exceeded the cap despite 6 concurrent callers
    } finally {
      restore();
    }
  });

  it('falls through to null on saturation (never throws) when the wait budget expires', async () => {
    // Capacity 1, a ~5ms acquire budget, and one held call that never returns:
    // the second caller cannot get a slot and must degrade to null.
    const restore = __setModelConcurrencyForTest(1, 5);
    let release!: () => void;
    const held: ResumeModelRunner = () => new Promise(() => { /* never resolves while held */ });
    try {
      // Occupy the only slot.
      const occupying = structureResumeWithModel('first', held);
      await new Promise((r) => setTimeout(r, 1));
      // A second caller waits, times out, and falls through to null.
      const second = structureResumeWithModel('second', async () => ({ phone: '9', skills: [] }));
      await expect(second).resolves.toBeNull();
      void occupying; // intentionally left pending; unref'd timer keeps nothing alive
      release = () => {};
      void release;
    } finally {
      restore();
    }
  });

  it('capacity 0 clamps to 1 and the slot is restored after release (no wedge)', async () => {
    // The semaphore clamps capacity to a minimum of 1. Before the fix, the
    // constructor clamped `available` to 1 but `release` compared against the
    // RAW capacity (0), so the freed slot was never restored and the second
    // call wedged forever. With the clamp stored once, both the grant and the
    // release guard use capacity 1, so a serialized second call still gets a
    // slot. A generous acquire budget proves the slot was RESTORED, not merely
    // granted before the first call finished.
    const restore = __setModelConcurrencyForTest(0, 1_000);
    try {
      const first = await structureResumeWithModel('a', async () => ({ phone: '98765 43210', skills: [] }));
      expect(first).not.toBeNull();
      // If release did not restore the slot, this second acquire would time out
      // and return null; it must succeed.
      const second = await structureResumeWithModel('b', async () => ({ phone: '90000 00000', skills: [] }));
      expect(second).not.toBeNull();
      expect(second!.phone).toBe('90000 00000');
    } finally {
      restore();
    }
  });

  it('releases the slot even when the runner throws, so a failure never wedges the semaphore', async () => {
    const restore = __setModelConcurrencyForTest(1, 50);
    try {
      // First call throws inside the runner — must release its slot.
      await expect(
        structureResumeWithModel('x', async () => { throw new Error('provider down'); }),
      ).resolves.toBeNull();
      // A subsequent call still gets the freed slot and succeeds.
      const out = await structureResumeWithModel('y', async () => ({ phone: '98765 43210', skills: [] }));
      expect(out).not.toBeNull();
      expect(out!.phone).toBe('98765 43210');
    } finally {
      restore();
    }
  });
});
