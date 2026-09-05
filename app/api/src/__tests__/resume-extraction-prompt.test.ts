/**
 * resume-extraction-prompt.test.ts — the résumé structuring prompt.
 *
 * Two properties are load-bearing and easy to regress silently:
 *
 *   1. PREFIX CACHING. DeepSeek's automatic context cache keys on the longest
 *      identical prefix across calls. The static instruction block MUST come
 *      first and be byte-identical on every call; the variable résumé text MUST
 *      come last. If a later edit interleaves résumé content into the
 *      instructions or moves the résumé above them, the cache-hit rate collapses
 *      to zero with no test failure — unless this suite guards it.
 *
 *   2. RECALL INSTRUCTIONS. The phone-recall (address/PIN-adjacent), prose-role,
 *      and clean-summary instructions are the primary levers that make an
 *      address-embedded number model-authored (and therefore dialable via the
 *      provenance gate) and that pull roles out of a narrative summary. If they
 *      are dropped, the parser silently regresses.
 *
 * Every résumé string here is synthetic.
 */

import { describe, it, expect } from 'vitest';
import { EXTRACTION_INSTRUCTIONS, buildExtractionPrompt } from '../lib/prompts.js';

describe('résumé extraction prompt — prefix caching layout', () => {
  it('puts the STATIC instruction block first, byte-identical across calls', () => {
    const a = buildExtractionPrompt('Alice — Senior Engineer, +91 98765 43210');
    const b = buildExtractionPrompt('Different résumé entirely, another human');
    // Both prompts start with the exact same instruction prefix…
    expect(a.startsWith(EXTRACTION_INSTRUCTIONS)).toBe(true);
    expect(b.startsWith(EXTRACTION_INSTRUCTIONS)).toBe(true);
    // …and that shared prefix is identical between the two calls.
    const prefixLen = EXTRACTION_INSTRUCTIONS.length;
    expect(a.slice(0, prefixLen)).toBe(b.slice(0, prefixLen));
  });

  it('puts the VARIABLE résumé text LAST, after the instructions', () => {
    const resume = 'Bhavna Rao unique-marker-9931';
    const prompt = buildExtractionPrompt(resume);
    const idxInstructions = prompt.indexOf(EXTRACTION_INSTRUCTIONS);
    const idxResume = prompt.indexOf('unique-marker-9931');
    expect(idxInstructions).toBe(0);
    expect(idxResume).toBeGreaterThan(EXTRACTION_INSTRUCTIONS.length);
    // Nothing but the fenced résumé follows the instruction prefix.
    const tail = prompt.slice(EXTRACTION_INSTRUCTIONS.length);
    expect(tail).toContain('unique-marker-9931');
    expect(tail).not.toContain('Return a JSON object'); // no instruction text after the résumé
  });

  it('does not interleave résumé content into the instruction block', () => {
    const resume = 'INTERLEAVE_SENTINEL should never appear inside the instructions';
    const prompt = buildExtractionPrompt(resume);
    expect(EXTRACTION_INSTRUCTIONS).not.toContain('INTERLEAVE_SENTINEL');
    // The sentinel appears exactly once, in the résumé tail.
    expect(prompt.split('INTERLEAVE_SENTINEL')).toHaveLength(2);
  });

  it('still bounds the résumé text to 12k', () => {
    const huge = 'x'.repeat(20_000);
    const prompt = buildExtractionPrompt(huge);
    expect(prompt).not.toContain('x'.repeat(12_001));
    expect(prompt).toContain('x'.repeat(12_000));
  });
});

describe('résumé extraction prompt — recall instructions present', () => {
  it('instructs phone recall from headers/footers/address blocks with a leading "+"', () => {
    expect(EXTRACTION_INSTRUCTIONS).toMatch(/header/i);
    expect(EXTRACTION_INSTRUCTIONS).toMatch(/footer/i);
    expect(EXTRACTION_INSTRUCTIONS).toMatch(/address/i);
    expect(EXTRACTION_INSTRUCTIONS).toMatch(/leading "\+"/);
  });

  it('instructs the phone NOT to include the postal/PIN code', () => {
    expect(EXTRACTION_INSTRUCTIONS).toMatch(/postal|PIN/i);
    // The instruction pairs "next to a PIN" with "never include the PIN".
    expect(EXTRACTION_INSTRUCTIONS).toMatch(/never include the postal\/PIN code/i);
  });

  it('instructs prose-role extraction (roles are not only under an Experience heading)', () => {
    expect(EXTRACTION_INSTRUCTIONS).toMatch(/not only found under a dated "experience"/i);
    expect(EXTRACTION_INSTRUCTIONS).toMatch(/narrative professional summary/i);
    expect(EXTRACTION_INSTRUCTIONS).toMatch(/recent_role.*current_role.*prior_roles/i);
  });

  it('instructs a clean summary with no contact block', () => {
    expect(EXTRACTION_INSTRUCTIONS).toMatch(/do NOT copy the contact block/i);
    expect(EXTRACTION_INSTRUCTIONS).toMatch(/belong in their own fields/i);
  });
});
