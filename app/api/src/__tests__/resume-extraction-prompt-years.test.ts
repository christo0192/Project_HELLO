/**
 * resume-extraction-prompt-years.test.ts — the prompt must ASK for the years
 * arithmetic, and must not forbid it.
 *
 * The old wording ("total years … as a number" + "Do not infer … dates") led a
 * faithful model to answer `null` for every résumé that did not literally state
 * a total — which is most of them. The dashboard column read `—`.
 */

import { describe, it, expect } from 'vitest';
import { EXTRACTION_INSTRUCTIONS, buildExtractionPrompt } from '../lib/prompts.js';

describe('résumé extraction prompt — experience_years contract', () => {
  it('instructs the model to CALCULATE total years from the role dates when no total is stated', () => {
    expect(EXTRACTION_INSTRUCTIONS).toMatch(/CALCULATE it from the employment dates/);
    expect(EXTRACTION_INSTRUCTIONS).toMatch(/do not double-count overlapping roles/i);
  });

  it('carves the arithmetic out of the "do not infer" rule explicitly', () => {
    expect(EXTRACTION_INSTRUCTIONS).toMatch(/Adding up the dates that ARE present .* is required, not inference/);
  });

  it('asks for a JSON number and forbids a string for experience_years', () => {
    expect(EXTRACTION_INSTRUCTIONS).toMatch(/"experience_years".*JSON number/);
    expect(EXTRACTION_INSTRUCTIONS).toMatch(/never a string/);
  });

  it('states the per-field type rules and asks for the JSON object only', () => {
    expect(EXTRACTION_INSTRUCTIONS).toMatch(/Type rules:/);
    expect(EXTRACTION_INSTRUCTIONS).toMatch(/Respond with the JSON object only/);
  });

  it('keeps the résumé text LAST so the instruction prefix stays cacheable', () => {
    const p = buildExtractionPrompt('unique-marker-4471');
    expect(p.startsWith(EXTRACTION_INSTRUCTIONS)).toBe(true);
    expect(p.indexOf('unique-marker-4471')).toBeGreaterThan(EXTRACTION_INSTRUCTIONS.length);
  });
});
