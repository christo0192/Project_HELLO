/**
 * The per-agreement wording the consent-template route returns (lib/r1/consent-items.ts,
 * shipped by PR-CT beside migration 0123). PR-3 needs it to answer `consent_items` for BOTH
 * notice audiences, so the contract the route and the web page rely on is pinned here too:
 * every key the 0123 notices require has a label for each audience, in the notice's order.
 * (PR-CT's own test additionally pins these against the migration's rows.)
 */

import { describe, expect, it } from 'vitest';
import {
  R1_CANDIDATE_LOCALE,
  R1_CONSENT_ITEMS,
  R1_STAFF_LOCALE,
  r1ConsentItems,
} from '../lib/r1/consent-items.js';

/** The `required_consents` of both 0123 rows, in order. */
const KEYS = ['ai_interview', 'video_audio_recording', 'ai_evaluation', 'data_processing'];

describe('r1ConsentItems', () => {
  it('names the two notice audiences by the locales the round column allows', () => {
    expect(R1_CANDIDATE_LOCALE).toBe('en-IN');
    expect(R1_STAFF_LOCALE).toBe('en-IN-x-staff');
    expect(Object.keys(R1_CONSENT_ITEMS).sort()).toEqual(['en-IN', 'en-IN-x-staff']);
  });

  it.each([R1_CANDIDATE_LOCALE, R1_STAFF_LOCALE])(
    'labels every key of the %s notice, in order, as one plain line',
    (locale) => {
      const items = r1ConsentItems(locale, KEYS);
      expect(items?.map((item) => item.type)).toEqual(KEYS);
      for (const item of items ?? []) {
        expect(item.label).toMatch(/^[\x20-\x7e]+$/);
      }
    },
  );

  it('never says the staff dry run may change an application status', () => {
    const staff = JSON.stringify(r1ConsentItems(R1_STAFF_LOCALE, KEYS));
    expect(staff).not.toMatch(/application status/);
    expect(JSON.stringify(r1ConsentItems(R1_CANDIDATE_LOCALE, KEYS))).toMatch(/application status/);
  });

  it('returns nothing, rather than a partial list, for an unknown locale or key', () => {
    expect(r1ConsentItems('hi-IN', KEYS)).toBeNull();
    expect(r1ConsentItems('constructor', KEYS)).toBeNull();
    expect(r1ConsentItems(R1_CANDIDATE_LOCALE, [...KEYS, 'recording'])).toBeNull();
    expect(r1ConsentItems(R1_CANDIDATE_LOCALE, ['recording'])).toBeNull();
  });
});
