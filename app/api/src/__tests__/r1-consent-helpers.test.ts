import { describe, expect, it } from 'vitest';
import {
  asConsentList,
  consentCovers,
  loadLiveConsent,
  loadNewestTemplate,
  readRoundConsent,
} from '../lib/r1/consent.js';
import { createFakeDb } from './support/r1-candidate-fake-db.js';
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
/** The notice audience of the seeded round (its `consent_locale`). */
const AUDIENCE = 'en-IN';

describe('R1 consent helpers', () => {
  it('accepts only lists of short snake_case consent identifiers', () => {
    expect(asConsentList(['ai_interview', 'recording'])).toEqual(['ai_interview', 'recording']);
    expect(asConsentList([])).toEqual([]);
    const bads = [null, undefined, 'recording', {}, [1], ['Recording'], ['a b'], ['']];
    for (const bad of [...bads, ['a'.repeat(65)]]) {
      expect(asConsentList(bad)).toBeNull();
    }
  });

  it('checks that every required consent is present (required is contained in granted)', () => {
    expect(consentCovers(['a', 'b'], ['b', 'a', 'c'])).toBe(true);
    expect(consentCovers(['a', 'b'], ['a'])).toBe(false);
    // The database semantics: an empty requirement is satisfied by anything.
    expect(consentCovers([], [])).toBe(true);
  });

  it('loads the newest active template per locale or overall, skipping inactive', async () => {
    const tables = seedTables();
    const found = await loadNewestTemplate(dbFor(tables));
    expect(found).toMatchObject({ ok: true, value: { id: TEMPLATE, version: '002' } });
    expect(await loadNewestTemplate(dbFor(tables), 'hi-IN')).toEqual({ ok: true, value: null });
    tables.interview_round_consent_templates!.push({
      id: 'newer',
      version: '003',
      locale: 'hi-IN',
      title: 't',
      body_md: 'b',
      required_consents: ['recording'],
      is_active: true,
    });
    expect(await loadNewestTemplate(dbFor(tables))).toMatchObject({ value: { id: 'newer' } });
    expect(await loadNewestTemplate(dbFor(tables), 'en-IN'))
      .toMatchObject({ value: { id: TEMPLATE } });
  });

  it('ignores a template row whose required consents are malformed', async () => {
    const tables = seedTables();
    tables.interview_round_consent_templates!.find((t) => t.id === TEMPLATE)!
      .required_consents = 'recording';
    expect(await loadNewestTemplate(dbFor(tables))).toEqual({ ok: true, value: null });
  });

  it('reports database errors as not-ok, never as an absent consent', async () => {
    const failing = createFakeDb({
      tables: seedTables(),
      failures: { interview_round_consent_templates: { message: 'down' } },
    }) as never;
    expect(await loadNewestTemplate(failing)).toEqual({ ok: false });
    expect(await readRoundConsent(failing, ROUND, AUDIENCE)).toEqual({ ok: false });
    const noConsents = createFakeDb({
      tables: seedTables(),
      failures: { interview_round_consents: { message: 'down' } },
    }) as never;
    expect(await loadLiveConsent(noConsents, ROUND)).toEqual({ ok: false });
    expect(await readRoundConsent(noConsents, ROUND, AUDIENCE)).toEqual({ ok: false });
  });

  it('derives the consent in force the way admission does', async () => {
    const tables = seedTables();
    expect(await readRoundConsent(dbFor(tables), ROUND, AUDIENCE))
      .toEqual({ ok: true, value: { state: 'required', templateVersion: '002' } });

    const live = grantConsent(tables);
    expect(await readRoundConsent(dbFor(tables), ROUND, AUDIENCE))
      .toEqual({ ok: true, value: { state: 'granted', templateVersion: '002' } });

    live.consents = REQUIRED.slice(0, 2);
    expect(await readRoundConsent(dbFor(tables), ROUND, AUDIENCE))
      .toMatchObject({ value: { state: 'required' } });
    live.consents = [...REQUIRED];

    live.template_id = OLD_TEMPLATE;
    expect(await readRoundConsent(dbFor(tables), ROUND, AUDIENCE))
      .toMatchObject({ value: { state: 'required' } });
    live.template_id = TEMPLATE;

    live.withdrawn_at = new Date(NOW).toISOString();
    live.proof = { decision: 'withdrawn' };
    expect(await readRoundConsent(dbFor(tables), ROUND, AUDIENCE))
      .toMatchObject({ value: { state: 'withdrawn' } });
    live.proof = null;
    expect(await readRoundConsent(dbFor(tables), ROUND, AUDIENCE))
      .toMatchObject({ value: { state: 'required' } });
  });

  it('counts a live consent only for the audience its template belongs to', async () => {
    const tables = seedTables();
    // Both notices ship at ONE version, so admission would accept either.
    tables.interview_round_consent_templates!.push({
      id: 'staff-template',
      version: '002',
      locale: 'en-IN-x-staff',
      title: 'staff',
      body_md: 'b',
      required_consents: REQUIRED,
      is_active: true,
    });
    const live = grantConsent(tables);
    expect(await readRoundConsent(dbFor(tables), ROUND, 'en-IN'))
      .toEqual({ ok: true, value: { state: 'granted', templateVersion: '002' } });
    expect(await readRoundConsent(dbFor(tables), ROUND, 'en-IN-x-staff'))
      .toEqual({ ok: true, value: { state: 'required', templateVersion: '002' } });

    live.template_id = 'staff-template';
    expect(await readRoundConsent(dbFor(tables), ROUND, 'en-IN-x-staff'))
      .toEqual({ ok: true, value: { state: 'granted', templateVersion: '002' } });
    expect(await readRoundConsent(dbFor(tables), ROUND, 'en-IN'))
      .toEqual({ ok: true, value: { state: 'required', templateVersion: '002' } });
    // An audience nobody ships can never be covered.
    expect(await readRoundConsent(dbFor(tables), ROUND, 'hi-IN'))
      .toMatchObject({ value: { state: 'required' } });
  });

  it('is required when there is no active template at all', async () => {
    const tables = seedTables();
    grantConsent(tables);
    for (const row of tables.interview_round_consent_templates!) row.is_active = false;
    expect(await readRoundConsent(dbFor(tables), ROUND, AUDIENCE))
      .toEqual({ ok: true, value: { state: 'required', templateVersion: null } });
  });
});
