/**
 * The compartment vocabulary is hand-maintained in TWO packages, and nothing
 * else makes them agree.
 *
 * `app/api/src/schemas/roles.ts` owns `SCREENING_CATEGORIES`, and its
 * `.strict()` zod enum is what a Save is validated against. `app/web/src/
 * types.ts` owns the `ScreeningCategory` union and the labels the form prints.
 * The web package cannot IMPORT the API's copy — they are separate builds with
 * separate tsconfigs and no shared module — so the second copy is unavoidable.
 * What is avoidable is the two drifting silently.
 *
 * WHAT DRIFT COSTS, in each direction:
 *
 *   * a compartment added API-side and missing here renders no heading for it,
 *     so the form shows a boundary the recruiter cannot name;
 *   * a compartment named here and missing API-side means the form can echo a
 *     `category` back on Save that `z.enum` refuses — a 400 on a role the
 *     recruiter did not change and cannot fix, because the field has no
 *     control and `api.ts` surfaces only the generic validation message.
 *
 * TypeScript catches neither: the API response is CAST, not parsed.
 *
 * Read from the file rather than imported for the reason above. `PHONE_META_
 * WORDS` was refactored into one exported array precisely to kill this defect
 * class where one package could reach the other; here it cannot, so the check
 * is a parse — the same shape `0044`'s own drift test uses against its SQL.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SCREENING_CATEGORY_LABELS, SCREENING_CATEGORY_TAGS } from '../types';

const API_SCHEMA = resolve(process.cwd(), '../api/src/schemas/roles.ts');

/** The API's `SCREENING_CATEGORIES` array, in declaration order. */
function apiCategories(): string[] {
  const source = readFileSync(API_SCHEMA, 'utf8');
  const block = /export const SCREENING_CATEGORIES = \[([\s\S]*?)\] as const;/.exec(source);
  if (!block) throw new Error('SCREENING_CATEGORIES not found in the API schema');
  return [...block[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

describe('the compartment vocabulary does not drift across packages', () => {
  it('reads a non-empty list from the API schema', () => {
    // The parse is the load-bearing part of every assertion below. If the API
    // file is reformatted so this regex stops matching, the comparison would
    // otherwise pass vacuously against two empty lists.
    const api = apiCategories();
    expect(api.length).toBeGreaterThanOrEqual(5);
    expect(api).toContain('compensation');
  });

  it('names exactly the same compartments, in the same order', () => {
    // ORDER MATTERS and is asserted, not just membership: the array is written
    // in call order and read that way by anyone adding a compartment.
    expect(Object.keys(SCREENING_CATEGORY_LABELS)).toEqual(apiCategories());
  });

  it('gives EVERY compartment a row tag as well as a heading label', () => {
    // Two maps over one vocabulary is two chances to forget one. A missing tag
    // renders the raw id, which is exactly the thing the tag replaced.
    expect(Object.keys(SCREENING_CATEGORY_TAGS)).toEqual(apiCategories());
  });

  it('keeps the row tag SHORT — it renders in an 11px monospace slot', () => {
    for (const [category, tag] of Object.entries(SCREENING_CATEGORY_TAGS)) {
      expect(tag.trim(), category).not.toBe('');
      expect(tag.length, `${category}: "${tag}" is too long for the tag slot`)
        .toBeLessThanOrEqual(12);
      // Not a snake_case key: `profile_relevance` reads like a database column
      // in a slot meant for a human. (`stability` is its own tag, and that is
      // fine — the rule is about the SHAPE, not about differing from the key.)
      expect(tag, category).not.toContain('_');
    }
  });

  it('gives every compartment a non-empty human label', () => {
    for (const [category, label] of Object.entries(SCREENING_CATEGORY_LABELS)) {
      expect(label.trim(), category).not.toBe('');
      // Not the raw key. A label of `profile_relevance` would render, pass a
      // membership check, and still be wrong on screen.
      expect(label, category).not.toBe(category);
    }
  });
});
