/**
 * `recheckRoundConsent` (lib/r1/consent.ts): the admission-time consent re-check that
 * preflight, attempts (fresh and rejoin), the exchange (before and after the worker gate)
 * and the ready relay share through the router's `consentStillGranted` closure (M034 S04 T4).
 *
 * It must answer exactly what the six inline `readRoundConsent` blocks answered before:
 * `unreadable` exactly when the read is not ok, `ok` exactly when the state is `granted`,
 * and otherwise `not_granted` carrying the read's state. The Meet exchange (S05) relies on
 * it answering `ok` for an HR-attested 0142 row, with no other check.
 */

import { describe, expect, it } from 'vitest';
import { readRoundConsent, recheckRoundConsent } from '../lib/r1/consent.js';
import { createFakeDb, type Tables } from './support/r1-candidate-fake-db.js';
import {
  NOW,
  OLD_TEMPLATE,
  REQUIRED,
  ROUND,
  TEMPLATE,
  grantConsent,
  seedTables,
} from './support/r1-candidate-harness.js';

const dbFor = (tables = seedTables()) => createFakeDb({ tables }) as never;
/** The seeded round as the router holds it (only the two fields the re-check reads). */
const CANDIDATE_ROUND = { id: ROUND, consent_locale: 'en-IN' };
const STAFF_ROUND = { id: ROUND, consent_locale: 'en-IN-x-staff' };
const AT = new Date(NOW).toISOString();

/** The staff dry-run notice, shipped at the SAME version as the candidate notice. */
function addStaffTemplate(tables: Tables): void {
  tables.interview_round_consent_templates!.push({
    id: 'staff-template',
    version: '002',
    locale: 'en-IN-x-staff',
    title: 'staff',
    body_md: 'b',
    required_consents: REQUIRED,
    is_active: true,
  });
}

describe('recheckRoundConsent', () => {
  it('is ok for a live consent for the newest active template of the round audience', async () => {
    const tables = seedTables();
    grantConsent(tables);
    expect(await recheckRoundConsent(dbFor(tables), CANDIDATE_ROUND)).toEqual({ ok: true });
  });

  it('is not granted (required) when the round has no consent at all', async () => {
    expect(await recheckRoundConsent(dbFor(), CANDIDATE_ROUND))
      .toEqual({ ok: false, reason: 'not_granted', state: 'required' });
  });

  it('carries the withdrawn and declined states through', async () => {
    const withdrawn = seedTables();
    grantConsent(withdrawn, { withdrawn_at: AT, proof: { decision: 'withdrawn' } });
    expect(await recheckRoundConsent(dbFor(withdrawn), CANDIDATE_ROUND))
      .toEqual({ ok: false, reason: 'not_granted', state: 'withdrawn' });

    const declined = seedTables();
    grantConsent(declined, { withdrawn_at: AT, proof: { decision: 'declined' } });
    expect(await recheckRoundConsent(dbFor(declined), CANDIDATE_ROUND))
      .toEqual({ ok: false, reason: 'not_granted', state: 'declined' });
  });

  it('is not granted (required) for a consent that names an older template', async () => {
    const tables = seedTables();
    grantConsent(tables, { template_id: OLD_TEMPLATE });
    expect(await recheckRoundConsent(dbFor(tables), CANDIDATE_ROUND))
      .toEqual({ ok: false, reason: 'not_granted', state: 'required' });
  });

  it('locks the consent to the round audience (consent_locale)', async () => {
    const tables = seedTables();
    addStaffTemplate(tables);
    const live = grantConsent(tables);
    // A candidate-notice consent does not cover a round re-marked for the staff notice ...
    expect(await recheckRoundConsent(dbFor(tables), STAFF_ROUND))
      .toEqual({ ok: false, reason: 'not_granted', state: 'required' });
    expect(await recheckRoundConsent(dbFor(tables), CANDIDATE_ROUND)).toEqual({ ok: true });
    // ... and a staff-notice consent does not cover a candidate round.
    live.template_id = 'staff-template';
    expect(await recheckRoundConsent(dbFor(tables), STAFF_ROUND)).toEqual({ ok: true });
    expect(await recheckRoundConsent(dbFor(tables), CANDIDATE_ROUND))
      .toEqual({ ok: false, reason: 'not_granted', state: 'required' });
  });

  it('is unreadable, never an absent consent, when either consent table cannot be read', async () => {
    for (const table of ['interview_round_consent_templates', 'interview_round_consents']) {
      const tables = seedTables();
      grantConsent(tables);
      const failing = createFakeDb({ tables, failures: { [table]: { message: 'down' } } }) as never;
      expect(await recheckRoundConsent(failing, CANDIDATE_ROUND))
        .toEqual({ ok: false, reason: 'unreadable' });
    }
  });

  it('answers exactly what readRoundConsent answers, with the same reads', async () => {
    const fixtures: Array<{
      name: string;
      round: { id: string; consent_locale: string };
      setup: (tables: Tables) => void;
      failures?: Record<string, { message: string }>;
    }> = [
      { name: 'granted', round: CANDIDATE_ROUND, setup: (t) => { grantConsent(t); } },
      { name: 'required', round: CANDIDATE_ROUND, setup: () => {} },
      {
        name: 'withdrawn',
        round: CANDIDATE_ROUND,
        setup: (t) => { grantConsent(t, { withdrawn_at: AT, proof: { decision: 'withdrawn' } }); },
      },
      {
        name: 'declined',
        round: CANDIDATE_ROUND,
        setup: (t) => { grantConsent(t, { withdrawn_at: AT, proof: { decision: 'declined' } }); },
      },
      {
        name: 'old template',
        round: CANDIDATE_ROUND,
        setup: (t) => { grantConsent(t, { template_id: OLD_TEMPLATE }); },
      },
      {
        name: 'audience mismatch',
        round: STAFF_ROUND,
        setup: (t) => { addStaffTemplate(t); grantConsent(t); },
      },
      {
        name: 'templates unreadable',
        round: CANDIDATE_ROUND,
        setup: (t) => { grantConsent(t); },
        failures: { interview_round_consent_templates: { message: 'down' } },
      },
      {
        name: 'consents unreadable',
        round: CANDIDATE_ROUND,
        setup: (t) => { grantConsent(t); },
        failures: { interview_round_consents: { message: 'down' } },
      },
    ];

    for (const fixture of fixtures) {
      const tables = seedTables();
      fixture.setup(tables);
      const readDb = createFakeDb({ tables, ...(fixture.failures ? { failures: fixture.failures } : {}) });
      const recheckDb = createFakeDb({ tables, ...(fixture.failures ? { failures: fixture.failures } : {}) });
      const read = await readRoundConsent(readDb as never, fixture.round.id, fixture.round.consent_locale);
      const recheck = await recheckRoundConsent(recheckDb as never, fixture.round);

      const granted = read.ok && read.value.state === 'granted';
      expect(recheck.ok, fixture.name).toBe(granted);
      expect(!recheck.ok && recheck.reason === 'unreadable', fixture.name).toBe(!read.ok);
      if (read.ok && read.value.state !== 'granted') {
        expect(recheck, fixture.name)
          .toEqual({ ok: false, reason: 'not_granted', state: read.value.state });
      }
      // One read, the same tables: the re-check adds and drops no query.
      expect([...recheckDb.touched].sort(), fixture.name).toEqual([...readDb.touched].sort());
    }
  });

  it('is ok for an HR-attested 0142 row for the newest template, with no other check', async () => {
    const tables = seedTables();
    const hrAttested = {
      template_id: TEMPLATE,
      consents: [...REQUIRED],
      method: 'hr_attested_ashby',
      attested_by_external_id: '50000000-0000-4000-8000-0000000000f1',
      attested_at: new Date(NOW - 3600_000).toISOString(),
      india_location_attested: true,
      proof: {
        decision: 'granted',
        method: 'hr_attested_ashby',
        captured_at: AT,
        template_version: '002',
        locale: 'en-IN',
        india_location_attested: true,
        source: 'ashby_interview_schedule',
      },
    };
    const row = grantConsent(tables, hrAttested);
    expect(await recheckRoundConsent(dbFor(tables), CANDIDATE_ROUND)).toEqual({ ok: true });

    // A later template release makes it `not_granted`, exactly like a browser consent.
    row.template_id = OLD_TEMPLATE;
    expect(await recheckRoundConsent(dbFor(tables), CANDIDATE_ROUND))
      .toEqual({ ok: false, reason: 'not_granted', state: 'required' });
  });
});
