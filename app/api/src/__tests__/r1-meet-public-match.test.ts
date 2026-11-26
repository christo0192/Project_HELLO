/**
 * M035 S04 T1: the match and eligibility decisions of the public booking form
 * (lib/r1/meet/public/match.ts; S04-PLAN D-S04-7..D-S04-13).
 *
 * The owner's rule is "only people already in Ashby can take it" and "never guess": zero matches,
 * several matches or an input the module cannot read refuse. These tables pin each rule and the
 * order the rules apply in. Ashby `Candidate` fixtures follow the documented shape (R04 section 1:
 * required id, name, doNotContact, primaryEmailAddress, emailAddresses, applicationIds, ...;
 * optional fraudStatus). Every id, name, email and number below is synthetic.
 */
import { describe, expect, it } from 'vitest';
import { ASHBY_CANDIDATE_SEARCH_LIMIT } from '../integrations/ashby/types.js';
import {
  R1_PUBLIC_LOCAL_ROW_LIMIT,
  R1_PUBLIC_MATCH_REFUSALS,
  R1_PUBLIC_MAX_ASHBY_APPLICATIONS,
  R1_PUBLIC_MAX_CHECK_LINKS,
  confirmR1PublicTypedEmail,
  decideR1PublicApplications,
  decideR1PublicCandidateFlags,
  decideR1PublicLocal,
  pickR1PublicAshbyCandidate,
  r1PublicMatchAlert,
  readR1PublicAshbyCandidate,
  readR1PublicAshbySearch,
  resolveR1PublicOnFileEmail,
  scopeR1PublicCheck,
  type R1PublicApplicationFacts,
  type R1PublicAshbyCandidateHit,
  type R1PublicLocalDecision,
  type R1PublicLocalRow,
  type R1PublicMatchRefusal,
} from '../lib/r1/meet/public/match.js';

// ── Synthetic identity ──────────────────────────────────────────────────────────────────────────
/** Local `candidates.id` values. */
const C1 = '0b6f3c1e-1111-4a00-8000-00000000c001';
const C2 = '0b6f3c1e-1111-4a00-8000-00000000c002';
/** Ashby application ids. */
const app = (n: number): string => `0b6f3c1e-2222-4a00-8000-${String(n).padStart(12, '0')}`;
const APP1 = app(1);
const APP2 = app(2);
const APP3 = app(3);
/** Ashby candidate ids. */
const ASHBY1 = '0b6f3c1e-3333-4a00-8000-00000000b001';
const ASHBY2 = '0b6f3c1e-3333-4a00-8000-00000000b002';
const JOB1 = '0b6f3c1e-4444-4a00-8000-00000000d001';
const STAGE1 = '0b6f3c1e-5555-4a00-8000-00000000e001';

const EMAIL = 'test.person@example.com';
const WORK_EMAIL = 'test.person.work@example.com';
const OTHER_EMAIL = 'other.person@example.com';

/** Substrings that must never appear in a serialised decision or hit. */
const PII_FRAGMENTS = ['test.person', 'other.person', 'example.com', 'Test Person', '98123', '45670'];

// ── Factories ───────────────────────────────────────────────────────────────────────────────────
function row(over: Partial<R1PublicLocalRow> = {}): R1PublicLocalRow {
  return {
    candidateId: C1,
    matchedBy: 'email',
    applicationId: APP1,
    ashbyCandidateId: ASHBY1,
    linkTerminal: false,
    mappingEnabled: true,
    dsarHold: false,
    decisionBlocked: false,
    ...over,
  };
}

function facts(over: Partial<R1PublicApplicationFacts> = {}): R1PublicApplicationFacts {
  return {
    applicationId: APP1,
    status: 'Active',
    jobId: JOB1,
    stageId: STAGE1,
    stageMilestone: 'r1',
    mappingEnabled: true,
    link: { candidateId: C1, terminal: false },
    ...over,
  };
}

function hit(over: Partial<R1PublicAshbyCandidateHit> = {}): R1PublicAshbyCandidateHit {
  return { id: ASHBY1, emails: [EMAIL], applicationIds: [APP1], doNotContact: false, fraudStatus: null, ...over };
}

type ContactType = 'Personal' | 'Work' | 'Other';
function contact(value: string, type: ContactType = 'Personal', isPrimary = true) {
  return { value, type, isPrimary };
}

/** A `candidate.info` result / `candidate.search` entry with every documented required key. */
function documentedCandidate(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ASHBY1,
    createdAt: '2026-10-01T09:30:00.000Z',
    updatedAt: '2026-10-19T11:05:00.000Z',
    name: 'Test Person',
    doNotContact: false,
    primaryEmailAddress: contact(EMAIL),
    emailAddresses: [contact(EMAIL), contact(WORK_EMAIL, 'Work', false)],
    primaryPhoneNumber: contact('+91 98123 45670'),
    phoneNumbers: [contact('+91 98123 45670')],
    socialLinks: [],
    tags: [],
    applicationIds: [APP1],
    resumeFileHandle: null,
    fileHandles: [],
    profileUrl: `https://app.ashbyhq.com/candidates/${ASHBY1}`,
    source: null,
    creditedToUser: null,
    timezone: null,
    fraudStatus: 'NotFraudulent',
    ...over,
  };
}

const notFound = (reason: R1PublicMatchRefusal) => ({ kind: 'not_found', reason });
const check = (applicationIds: string[], ashbyCandidateId: string | null = ASHBY1, emailMatched = true) =>
  ({ kind: 'check', applicationIds, ashbyCandidateId, emailMatched });
const search = (phoneAshbyCandidateIds: string[] | null) => ({ kind: 'search_ashby', phoneAshbyCandidateIds });

function expectNoPii(value: unknown): void {
  const text = JSON.stringify(value);
  for (const fragment of PII_FRAGMENTS) expect(text).not.toContain(fragment);
}

// ── The refusal list ────────────────────────────────────────────────────────────────────────────
describe('R1_PUBLIC_MATCH_REFUSALS', () => {
  it('is the contracts 7.2 list, in order, and frozen', () => {
    expect([...R1_PUBLIC_MATCH_REFUSALS]).toEqual([
      'no_match',
      'conflicting_identity',
      'ambiguous',
      'no_bookable_application',
      'unmapped_job',
      'not_active',
      'stage_not_r1',
      'do_not_contact',
      'fraud_flag',
      'no_on_file_email',
    ]);
    expect(Object.isFrozen(R1_PUBLIC_MATCH_REFUSALS)).toBe(true);
  });

  it('pins the bounds', () => {
    expect(R1_PUBLIC_LOCAL_ROW_LIMIT).toBe(20);
    expect(R1_PUBLIC_MAX_CHECK_LINKS).toBe(5);
    expect(R1_PUBLIC_MAX_ASHBY_APPLICATIONS).toBe(10);
  });
});

// ── decideR1PublicLocal ─────────────────────────────────────────────────────────────────────────
describe('decideR1PublicLocal', () => {
  const sixLinks = [1, 2, 3, 4, 5, 6].map((n) => row({ applicationId: app(n) }));
  const twentyRows = Array.from({ length: 20 }, (_, i) => row({ applicationId: app(i + 1), linkTerminal: i > 0 }));
  const twentyOneRows = Array.from({ length: 21 }, (_, i) => row({ applicationId: app(i + 1), linkTerminal: i > 0 }));

  it.each<[string, readonly R1PublicLocalRow[], unknown]>([
    ['zero rows: search Ashby, no phone identity', [], search(null)],
    ['one bookable email row', [row()], check([APP1])],
    ['email-only, two links of one person', [row({ applicationId: APP2 }), row()], check([APP1, APP2])],
    ['phone-only bookable row (no email row): emailMatched false', [row({ matchedBy: 'phone' })], check([APP1], ASHBY1, false)],
    ['both on one row', [row({ matchedBy: 'both' })], check([APP1])],
    ['both agreeing across an email row and a phone row', [row({ matchedBy: 'email' }), row({ matchedBy: 'phone' })], check([APP1])],
    [
      'both agreeing: the intersection excludes an extra email-only candidate',
      [row({ matchedBy: 'both' }), row({ candidateId: C2, matchedBy: 'email', applicationId: APP2, ashbyCandidateId: ASHBY2 })],
      check([APP1]),
    ],
    [
      'both conflicting: email names one candidate, phone another',
      [row(), row({ candidateId: C2, matchedBy: 'phone', applicationId: APP2, ashbyCandidateId: ASHBY2 })],
      notFound('conflicting_identity'),
    ],
    [
      'both conflicting even when only the phone side is bookable',
      [row({ linkTerminal: true }), row({ candidateId: C2, matchedBy: 'phone', applicationId: APP2, ashbyCandidateId: ASHBY2 })],
      notFound('conflicting_identity'),
    ],
    [
      'two candidates on one email, one Ashby person: check both links',
      [row(), row({ candidateId: C2, applicationId: APP2 })],
      check([APP1, APP2]),
    ],
    [
      'two candidates on one email, one Ashby person whose id differs only in case',
      [row(), row({ candidateId: C2, applicationId: APP2, ashbyCandidateId: ASHBY1.toUpperCase() })],
      check([APP1, APP2]),
    ],
    [
      'two candidates on one email, different Ashby people: ambiguous',
      [row(), row({ candidateId: C2, applicationId: APP2, ashbyCandidateId: ASHBY2 })],
      notFound('ambiguous'),
    ],
    ['one kept link with no Ashby candidate id', [row({ ashbyCandidateId: null })], check([APP1], null)],
    [
      'a kept link with no Ashby candidate id beside another: ambiguous',
      [row({ ashbyCandidateId: null }), row({ applicationId: APP2 })],
      notFound('ambiguous'),
    ],
    ['email side: terminal link', [row({ linkTerminal: true })], notFound('no_bookable_application')],
    ['email side: disabled or archived mapping', [row({ mappingEnabled: false })], notFound('no_bookable_application')],
    ['email side: DSAR hold', [row({ dsarHold: true })], notFound('no_bookable_application')],
    ['email side: decision-blocked', [row({ decisionBlocked: true })], notFound('no_bookable_application')],
    [
      'email side: no link',
      [row({ applicationId: null, ashbyCandidateId: null, linkTerminal: true, mappingEnabled: false })],
      notFound('no_bookable_application'),
    ],
    [
      'email side: a DSAR hold on one row excludes the candidate\'s other rows',
      [row({ dsarHold: true }), row({ applicationId: APP2 })],
      notFound('no_bookable_application'),
    ],
    [
      'email side: a decision block on one row excludes the candidate\'s other rows',
      [row({ applicationId: APP2 }), row({ decisionBlocked: true })],
      notFound('no_bookable_application'),
    ],
    ['phone-only: terminal link -> search with its Ashby id', [row({ matchedBy: 'phone', linkTerminal: true })], search([ASHBY1])],
    ['phone-only: disabled mapping -> search with its Ashby id', [row({ matchedBy: 'phone', mappingEnabled: false })], search([ASHBY1])],
    ['phone-only: DSAR hold refuses, never a search (review F2)', [row({ matchedBy: 'phone', dsarHold: true })], notFound('no_bookable_application')],
    ['phone-only: decision-blocked refuses, never a search (review F2)', [row({ matchedBy: 'phone', decisionBlocked: true })], notFound('no_bookable_application')],
    [
      'phone-only: a held candidate with no link refuses, never a search (review F2)',
      [row({ matchedBy: 'phone', applicationId: null, ashbyCandidateId: null, linkTerminal: true, mappingEnabled: false, dsarHold: true })],
      notFound('no_bookable_application'),
    ],
    [
      'phone-only: a hold on one of two phone candidates refuses the form (review F2)',
      [
        row({ matchedBy: 'phone' }),
        row({ candidateId: C2, matchedBy: 'phone', applicationId: APP2, ashbyCandidateId: ASHBY2, linkTerminal: true, dsarHold: true }),
      ],
      notFound('no_bookable_application'),
    ],
    [
      'both agreeing: a hold on the extra email-only candidate refuses the form (review F2)',
      [row({ matchedBy: 'both' }), row({ candidateId: C2, matchedBy: 'email', applicationId: APP2, dsarHold: true })],
      notFound('no_bookable_application'),
    ],
    [
      'two candidates on one email of one Ashby person, one decision-blocked: refused, not booked around it (review F2)',
      [row(), row({ candidateId: C2, applicationId: APP2, decisionBlocked: true })],
      notFound('no_bookable_application'),
    ],
    [
      'conflicting_identity outranks a hold',
      [row(), row({ candidateId: C2, matchedBy: 'phone', applicationId: APP2, ashbyCandidateId: ASHBY2, dsarHold: true })],
      notFound('conflicting_identity'),
    ],
    [
      'more than 20 rows outranks a hold (ambiguous)',
      [...twentyOneRows.slice(0, 20), row({ applicationId: app(99), dsarHold: true })],
      notFound('ambiguous'),
    ],
    [
      'phone-only: no link -> search with no phone identity',
      [row({ matchedBy: 'phone', applicationId: null, ashbyCandidateId: null, linkTerminal: true, mappingEnabled: false })],
      search(null),
    ],
    [
      'phone-only: two unbookable people -> both Ashby ids, distinct and sorted',
      [
        row({ matchedBy: 'phone', candidateId: C2, applicationId: APP2, ashbyCandidateId: ASHBY2, linkTerminal: true }),
        row({ matchedBy: 'phone', linkTerminal: true }),
        row({ matchedBy: 'phone', applicationId: APP3, linkTerminal: true }),
      ],
      search([ASHBY1, ASHBY2]),
    ],
    ['five kept links: check all five', sixLinks.slice(0, 5), check([app(1), app(2), app(3), app(4), app(5)])],
    ['six kept links: ambiguous', sixLinks, notFound('ambiguous')],
    ['twenty rows (one bookable): check', twentyRows, check([APP1])],
    ['twenty-one rows: ambiguous', twentyOneRows, notFound('ambiguous')],
    [
      'ids sorted and deduplicated',
      [row({ applicationId: APP3 }), row(), row({ matchedBy: 'both' })],
      check([APP1, APP3]),
    ],
    [
      'an application id that differs only in case is one link (first spelling kept)',
      [row(), row({ applicationId: APP1.toUpperCase() })],
      check([APP1]),
    ],
    [
      'two rows of one application that disagree on the person: ambiguous',
      [row(), row({ candidateId: C2, ashbyCandidateId: ASHBY2 })],
      notFound('ambiguous'),
    ],
  ])('%s', (_name, rows, expected) => {
    const decision = decideR1PublicLocal(rows);
    expect(decision).toEqual(expected);
    expect(Object.isFrozen(decision)).toBe(true);
    if (decision.kind === 'check') expect(Object.isFrozen(decision.applicationIds)).toBe(true);
    if (decision.kind === 'search_ashby' && decision.phoneAshbyCandidateIds !== null) {
      expect(Object.isFrozen(decision.phoneAshbyCandidateIds)).toBe(true);
    }
    expectNoPii(decision);
  });

  it.each<[string, unknown]>([
    ['not an array', { length: 1 }],
    ['a null row', [null]],
    ['a candidate id that is not a UUID', [row({ candidateId: 'candidate-1' })]],
    ['an unknown matchedBy', [{ ...row(), matchedBy: 'name' }]],
    ['an empty application id', [row({ applicationId: '' })]],
    ['an application id with a space', [row({ applicationId: 'app 1' })]],
    ['an Ashby candidate id that is not a string', [{ ...row(), ashbyCandidateId: 42 }]],
    ['a boolean given as a string', [{ ...row(), dsarHold: 'false' }]],
    ['a missing boolean', [{ ...row(), decisionBlocked: undefined }]],
    ['one malformed row among good ones', [row(), { ...row({ applicationId: APP2 }), mappingEnabled: 1 }]],
  ])('a malformed input refuses as ambiguous: %s', (_name, rows) => {
    expect(decideR1PublicLocal(rows as readonly R1PublicLocalRow[])).toEqual(notFound('ambiguous'));
  });

  it('the review F2 path end to end: a phone-only held person is never searched, so never imported', () => {
    // Person A is held locally; A's Ashby email differs from the local one, and A has a second Ashby
    // application, Active, unlinked, on an enabled mapping. Before the fix the decision was
    // search_ashby([A]), the pick confirmed A, and the applications decision answered import.
    const decision = decideR1PublicLocal([row({ matchedBy: 'phone', linkTerminal: true, dsarHold: true })]);
    expect(decision).toEqual(notFound('no_bookable_application'));
  });

  it('check carries the one Ashby candidate id its links share (the first spelling) and emailMatched', () => {
    const shared = decideR1PublicLocal([row({ ashbyCandidateId: ASHBY1.toUpperCase() }), row({ candidateId: C2, applicationId: APP2 })]);
    expect(shared).toEqual(check([APP1, APP2], ASHBY1.toUpperCase()));
    expect(decideR1PublicLocal([row({ matchedBy: 'phone' })])).toMatchObject({ emailMatched: false });
    expect(decideR1PublicLocal([row({ matchedBy: 'both' })])).toMatchObject({ emailMatched: true });
    expect(decideR1PublicLocal([row({ matchedBy: 'email' })])).toMatchObject({ emailMatched: true });
  });

  it('does not mutate its input', () => {
    const rows = Object.freeze([row({ applicationId: APP2 }), row()].map((r) => Object.freeze(r)));
    expect(decideR1PublicLocal(rows)).toEqual(check([APP1, APP2]));
  });

  it('the decision kinds are exactly check, search_ashby and not_found', () => {
    const kinds = new Set<R1PublicLocalDecision['kind']>([
      decideR1PublicLocal([]).kind,
      decideR1PublicLocal([row()]).kind,
      decideR1PublicLocal([row({ linkTerminal: true })]).kind,
    ]);
    expect([...kinds].sort()).toEqual(['check', 'not_found', 'search_ashby']);
  });
});

// ── Ashby readers ───────────────────────────────────────────────────────────────────────────────
describe('readR1PublicAshbyCandidate', () => {
  it('reads the documented Candidate shape', () => {
    const read = readR1PublicAshbyCandidate(documentedCandidate());
    expect(read).not.toBeNull();
    expect({ ...read! }).toEqual({
      id: ASHBY1,
      emails: [EMAIL, WORK_EMAIL],
      applicationIds: [APP1],
      doNotContact: false,
      fraudStatus: 'NotFraudulent',
    });
  });

  it('is frozen and serialises to a fixed marker, never its contents', () => {
    const read = readR1PublicAshbyCandidate(documentedCandidate())!;
    expect(Object.isFrozen(read)).toBe(true);
    expect(Object.isFrozen(read.emails)).toBe(true);
    expect(Object.isFrozen(read.applicationIds)).toBe(true);
    expect(JSON.stringify(read)).toBe('"[r1-public-ashby-candidate]"');
    expect(JSON.stringify({ nested: [read] })).toBe('{"nested":["[r1-public-ashby-candidate]"]}');
    expect(Object.keys(read)).toEqual(['id', 'emails', 'applicationIds', 'doNotContact', 'fraudStatus']);
    expect(Object.keys(read)).not.toContain('toJSON');
    expectNoPii({ read });
  });

  it.each<[string, Record<string, unknown>, string[]]>([
    ['bare-string items, normalised', { primaryEmailAddress: ' Test.Person@Example.COM ', emailAddresses: ['Other.Person@Example.com'] }, [EMAIL, OTHER_EMAIL]],
    ['{ value } items', { primaryEmailAddress: { value: EMAIL }, emailAddresses: [{ value: OTHER_EMAIL }] }, [EMAIL, OTHER_EMAIL]],
    ['the primary first, then the list order', { primaryEmailAddress: contact(OTHER_EMAIL), emailAddresses: [contact(EMAIL), contact(OTHER_EMAIL)] }, [OTHER_EMAIL, EMAIL]],
    ['duplicates collapse after normalisation', { emailAddresses: [contact(EMAIL), contact(EMAIL.toUpperCase())] }, [EMAIL]],
    [
      'invalid emails are dropped',
      { primaryEmailAddress: contact('not-an-email'), emailAddresses: [contact(''), 42, null, contact('a b@example.com'), contact(OTHER_EMAIL)] },
      [OTHER_EMAIL],
    ],
    ['a null primary reads the list only', { primaryEmailAddress: null, emailAddresses: [contact(OTHER_EMAIL)] }, [OTHER_EMAIL]],
    ['an absent list reads the primary only', { emailAddresses: undefined }, [EMAIL]],
    ['an empty list and no primary: no emails', { primaryEmailAddress: null, emailAddresses: [] }, []],
    ['twenty list entries are read', { primaryEmailAddress: null, emailAddresses: Array.from({ length: 20 }, (_, i) => contact(`p${i}@example.com`)) }, Array.from({ length: 20 }, (_, i) => `p${i}@example.com`)],
  ])('emails: %s', (_name, over, emails) => {
    expect(readR1PublicAshbyCandidate(documentedCandidate(over))?.emails).toEqual(emails);
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['an array', [documentedCandidate()]],
    ['a string', 'candidate'],
    ['a non-UUID id', documentedCandidate({ id: 'cand_1' })],
    ['a missing id', documentedCandidate({ id: undefined })],
    ['applicationIds not an array', documentedCandidate({ applicationIds: APP1 })],
    ['applicationIds missing', documentedCandidate({ applicationIds: undefined })],
    ['a non-UUID application id', documentedCandidate({ applicationIds: [APP1, 'app_2'] })],
    ['101 application ids', documentedCandidate({ applicationIds: Array.from({ length: 101 }, (_, i) => app(i + 1)) })],
    ['21 email entries', documentedCandidate({ emailAddresses: Array.from({ length: 21 }, (_, i) => contact(`p${i}@example.com`)) })],
    ['emailAddresses not an array', documentedCandidate({ emailAddresses: EMAIL })],
    ['emailAddresses null', documentedCandidate({ emailAddresses: null })],
    ['a numeric fraudStatus', documentedCandidate({ fraudStatus: 1 })],
    ['an object fraudStatus', documentedCandidate({ fraudStatus: { value: 'NotFraudulent' } })],
  ])('unreadable candidate -> null: %s', (_name, raw) => {
    expect(readR1PublicAshbyCandidate(raw)).toBeNull();
  });

  it('application ids: 100 are read, duplicates collapse case-insensitively, the first spelling is kept', () => {
    const hundred = Array.from({ length: 100 }, (_, i) => app(i + 1));
    expect(readR1PublicAshbyCandidate(documentedCandidate({ applicationIds: hundred }))?.applicationIds).toEqual(hundred);
    expect(
      readR1PublicAshbyCandidate(documentedCandidate({ applicationIds: [APP1, APP1.toUpperCase(), APP2] }))?.applicationIds,
    ).toEqual([APP1, APP2]);
  });

  it('keeps the Ashby candidate id verbatim', () => {
    expect(readR1PublicAshbyCandidate(documentedCandidate({ id: ASHBY1.toUpperCase() }))?.id).toBe(ASHBY1.toUpperCase());
  });

  it.each<[string, unknown, boolean]>([
    ['false', false, false],
    ['true', true, true],
    ['missing', undefined, true],
    ['the string false', 'false', true],
    ['null', null, true],
    ['zero', 0, true],
  ])('doNotContact %s -> %s (only an explicit false lets contact through)', (_name, value, expected) => {
    expect(readR1PublicAshbyCandidate(documentedCandidate({ doNotContact: value }))?.doNotContact).toBe(expected);
  });

  it.each<[string, unknown, string | null]>([
    ['a documented value', 'Unsure', 'Unsure'],
    ['null', null, null],
    ['missing', undefined, null],
    ['a long value is cut to 64 characters', 'x'.repeat(100), 'x'.repeat(64)],
  ])('fraudStatus %s', (_name, value, expected) => {
    expect(readR1PublicAshbyCandidate(documentedCandidate({ fraudStatus: value }))?.fraudStatus).toBe(expected);
  });
});

describe('readR1PublicAshbySearch', () => {
  const page = (results: unknown, moreDataAvailable?: unknown) =>
    ({ results, moreDataAvailable }) as { results: unknown; moreDataAvailable?: boolean };

  it('reads a documented page', () => {
    const read = readR1PublicAshbySearch(page([documentedCandidate(), documentedCandidate({ id: ASHBY2 })], false));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.hits.map((h) => h.id)).toEqual([ASHBY1, ASHBY2]);
    expect(Object.isFrozen(read)).toBe(true);
    expect(Object.isFrozen(read.hits)).toBe(true);
    expectNoPii(read);
  });

  it.each<[string, { results: unknown; moreDataAvailable?: boolean }, unknown]>([
    ['an empty page', page([], false), { ok: true, hits: [] }],
    ['moreDataAvailable absent', page([]), { ok: true, hits: [] }],
    ['results not an array (null)', page(null, false), { ok: false, reason: 'malformed' }],
    ['results not an array (object)', page({ id: ASHBY1 }, false), { ok: false, reason: 'malformed' }],
    ['the page itself is null', null as unknown as { results: unknown }, { ok: false, reason: 'malformed' }],
    ['one unreadable entry', page([documentedCandidate(), documentedCandidate({ id: 'x' })], false), { ok: false, reason: 'malformed' }],
    ['moreDataAvailable not a boolean', page([], 'false'), { ok: false, reason: 'malformed' }],
    ['more data beyond the page', page([documentedCandidate()], true), { ok: false, reason: 'ambiguous' }],
    ['21 results', page(Array.from({ length: 21 }, () => documentedCandidate()), false), { ok: false, reason: 'ambiguous' }],
  ])('%s', (_name, input, expected) => {
    expect(readR1PublicAshbySearch(input)).toEqual(expected);
  });

  it('20 results are read', () => {
    const read = readR1PublicAshbySearch(page(Array.from({ length: 20 }, () => documentedCandidate()), false));
    expect(read.ok && read.hits.length).toBe(20);
  });

  describe('with the typed email (review F5)', () => {
    const others = (n: number) => Array.from({ length: n }, (_, i) => contact(`p${i}@example.com`, 'Other', false));
    /** Unreadable (21 addresses), and none of them is the typed one. */
    const unrelated = documentedCandidate({ id: ASHBY2, primaryEmailAddress: contact(OTHER_EMAIL), emailAddresses: others(21) });

    it.each<[string, unknown[], unknown]>([
      ['an unreadable entry that is not the person is skipped', [documentedCandidate(), unrelated], 'ASHBY1'],
      [
        'an unreadable entry with 101 applications that is not the person is skipped',
        [documentedCandidate(), documentedCandidate({ id: ASHBY2, primaryEmailAddress: contact(OTHER_EMAIL), emailAddresses: [], applicationIds: Array.from({ length: 101 }, (_, i) => app(i + 1)) })],
        'ASHBY1',
      ],
      ['only unrelated unreadable entries: no hits', [unrelated], { ok: true, hits: [] }],
      ['an unreadable entry that carries the typed email (bad id) -> ambiguous', [documentedCandidate({ id: 'cand_1' })], { ok: false, reason: 'ambiguous' }],
      [
        'an unreadable entry that carries it in another case, in its list -> ambiguous',
        [documentedCandidate(), documentedCandidate({ id: ASHBY2, primaryEmailAddress: null, emailAddresses: [...others(20), contact(EMAIL.toUpperCase())] })],
        { ok: false, reason: 'ambiguous' },
      ],
      ['an unreadable entry whose address list is not a list -> ambiguous', [documentedCandidate({ id: 'cand_1', primaryEmailAddress: null, emailAddresses: OTHER_EMAIL })], { ok: false, reason: 'ambiguous' }],
      [
        'an unreadable entry with more than 1000 addresses -> ambiguous',
        [documentedCandidate({ id: ASHBY2, primaryEmailAddress: contact(OTHER_EMAIL), emailAddresses: others(1000) })],
        { ok: false, reason: 'ambiguous' },
      ],
      ['an entry that is not an object is still malformed', [documentedCandidate(), 'candidate'], { ok: false, reason: 'malformed' }],
      ['a null entry is still malformed', [null], { ok: false, reason: 'malformed' }],
    ])('%s', (_name, results, expected) => {
      const read = readR1PublicAshbySearch(page(results, false), { email: ' Test.Person@Example.com ' });
      if (expected === 'ASHBY1') {
        expect(read.ok && read.hits.map((h) => h.id)).toEqual([ASHBY1]);
        expectNoPii(read);
      } else {
        expect(read).toEqual(expected);
      }
      expect(Object.isFrozen(read)).toBe(true);
    });

    it('without a usable typed email an unreadable entry still fails the page (malformed)', () => {
      for (const o of [undefined, {}, { email: null }, { email: 'not-an-email' }]) {
        expect(readR1PublicAshbySearch(page([documentedCandidate(), unrelated], false), o)).toEqual({ ok: false, reason: 'malformed' });
      }
    });

    it('a skipped entry never changes the pick: the one exact person is picked', () => {
      const read = readR1PublicAshbySearch(page([unrelated, documentedCandidate()], false), { email: EMAIL });
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      const picked = pickR1PublicAshbyCandidate(EMAIL, read.hits);
      expect(picked.kind === 'one' && picked.hit.id).toBe(ASHBY1);
    });
  });

  it('the page bound is the limit the Ashby client sends (parity, T4)', () => {
    expect(ASHBY_CANDIDATE_SEARCH_LIMIT).toBe(20);
    const at = readR1PublicAshbySearch(page(Array.from({ length: ASHBY_CANDIDATE_SEARCH_LIMIT }, () => documentedCandidate()), false));
    const over = readR1PublicAshbySearch(page(Array.from({ length: ASHBY_CANDIDATE_SEARCH_LIMIT + 1 }, () => documentedCandidate()), false));
    expect(at.ok).toBe(true);
    expect(over).toEqual({ ok: false, reason: 'ambiguous' });
  });
});

// ── pickR1PublicAshbyCandidate ──────────────────────────────────────────────────────────────────
describe('pickR1PublicAshbyCandidate', () => {
  const one = (h: R1PublicAshbyCandidateHit) => ({ kind: 'one', hit: h });
  const base = hit();
  const twentyOne = [base, ...Array.from({ length: 20 }, (_, i) => hit({ id: app(900 + i), emails: [`p${i}@example.com`] }))];

  it.each<[string, string, readonly R1PublicAshbyCandidateHit[], { phoneAshbyCandidateIds?: readonly string[] | null } | undefined, unknown]>([
    ['no hits', EMAIL, [], undefined, notFound('no_match')],
    ['a partial match only (Ashby returned a longer address)', 'john@example.com', [hit({ emails: ['john.doe@example.com'] })], undefined, notFound('no_match')],
    ['an exact match after case and space normalisation', '  Test.Person@EXAMPLE.com ', [base], undefined, one(base)],
    ['a hit email that is not normalised yet still matches', EMAIL, [hit({ emails: ['TEST.PERSON@example.com'] })], undefined, 'one'],
    ['one exact among non-exact hits', EMAIL, [hit({ id: ASHBY2, emails: [OTHER_EMAIL] }), base], undefined, one(base)],
    ['a secondary address matches', WORK_EMAIL, [hit({ emails: [EMAIL, WORK_EMAIL] })], undefined, 'one'],
    ['two distinct exact hits', EMAIL, [base, hit({ id: ASHBY2 })], undefined, notFound('ambiguous')],
    ['the same id twice', EMAIL, [base, base], undefined, one(base)],
    ['the same id twice, case differs', EMAIL, [base, hit({ id: ASHBY1.toUpperCase() })], undefined, one(base)],
    ['ten applications', EMAIL, [hit({ applicationIds: Array.from({ length: 10 }, (_, i) => app(i + 1)) })], undefined, 'one'],
    ['eleven applications', EMAIL, [hit({ applicationIds: Array.from({ length: 11 }, (_, i) => app(i + 1)) })], undefined, notFound('ambiguous')],
    ['21 hits', EMAIL, twentyOne, undefined, notFound('ambiguous')],
    ['phone ids that do not contain the hit', EMAIL, [base], { phoneAshbyCandidateIds: [ASHBY2] }, notFound('conflicting_identity')],
    ['phone ids that contain the hit (case differs)', EMAIL, [base], { phoneAshbyCandidateIds: [ASHBY2, ASHBY1.toUpperCase()] }, one(base)],
    ['phone ids null: no constraint', EMAIL, [base], { phoneAshbyCandidateIds: null }, one(base)],
    ['phone ids empty: no constraint', EMAIL, [base], { phoneAshbyCandidateIds: [] }, one(base)],
    ['no options: no constraint', EMAIL, [base], {}, one(base)],
    ['phone ids that are not a list: ambiguous', EMAIL, [base], { phoneAshbyCandidateIds: ASHBY1 as unknown as string[] }, notFound('ambiguous')],
    ['an unparseable typed email', 'not-an-email', [base], undefined, notFound('no_match')],
    ['an empty typed email', '', [base], undefined, notFound('no_match')],
    ['a malformed hit', EMAIL, [{ ...base, emails: EMAIL } as unknown as R1PublicAshbyCandidateHit], undefined, notFound('ambiguous')],
  ])('%s', (_name, email, hits, o, expected) => {
    const picked = pickR1PublicAshbyCandidate(email, hits, o);
    if (expected === 'one') expect(picked.kind).toBe('one');
    else expect(picked).toEqual(expected);
    expect(Object.isFrozen(picked)).toBe(true);
  });

  it('returns the hit object itself (still serialising to its marker when read from Ashby)', () => {
    const read = readR1PublicAshbyCandidate(documentedCandidate())!;
    const picked = pickR1PublicAshbyCandidate(EMAIL, [read]);
    expect(picked).toEqual({ kind: 'one', hit: read });
    if (picked.kind === 'one') expect(picked.hit).toBe(read);
    expectNoPii(picked);
  });

  it('flows a documented search page end to end', () => {
    const read = readR1PublicAshbySearch({
      results: [documentedCandidate({ id: ASHBY2, primaryEmailAddress: contact('test.person.longer@example.com'), emailAddresses: [] }), documentedCandidate()],
      moreDataAvailable: false,
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const picked = pickR1PublicAshbyCandidate('Test.Person@Example.com', read.hits);
    expect(picked.kind === 'one' && picked.hit.id).toBe(ASHBY1);
  });
});

// ── scopeR1PublicCheck (review F3) ──────────────────────────────────────────────────────────────
describe('scopeR1PublicCheck', () => {
  const read = (...applicationIds: string[]) => ({ kind: 'read', applicationIds });
  const local = (applicationIds: string[], ashbyCandidateId: string | null = ASHBY1) => ({ applicationIds, ashbyCandidateId });

  it.each<[string, { applicationIds: readonly string[]; ashbyCandidateId: string | null }, R1PublicAshbyCandidateHit, unknown]>([
    ['widens one local link to every application of the person, sorted', local([APP1]), hit({ applicationIds: [APP3, APP1, APP2] }), read(APP1, APP2, APP3)],
    ['the same set when everything is imported', local([APP1, APP2]), hit({ applicationIds: [APP2, APP1] }), read(APP1, APP2)],
    ['the person id differs only in case', local([APP1], ASHBY1.toUpperCase()), hit(), read(APP1)],
    ['a local id that differs only in case from Ashby\'s', local([APP1.toUpperCase()]), hit(), read(APP1)],
    ['no Ashby id on the single link: the hit S06 resolved is taken', local([APP1], null), hit({ id: ASHBY2 }), read(APP1)],
    ['another Ashby person than the links name -> ambiguous', local([APP1]), hit({ id: ASHBY2 }), notFound('ambiguous')],
    ['a local link Ashby does not list -> ambiguous', local([APP1, APP3]), hit({ applicationIds: [APP1, APP2] }), notFound('ambiguous')],
    ['ten applications', local([APP1]), hit({ applicationIds: Array.from({ length: 10 }, (_, i) => app(i + 1)) }), 'read'],
    ['eleven applications -> ambiguous', local([APP1]), hit({ applicationIds: Array.from({ length: 11 }, (_, i) => app(i + 1)) }), notFound('ambiguous')],
    ['no local ids -> ambiguous', local([]), hit(), notFound('ambiguous')],
    ['six local ids -> ambiguous', local([1, 2, 3, 4, 5, 6].map(app)), hit({ applicationIds: [1, 2, 3, 4, 5, 6].map(app) }), notFound('ambiguous')],
    ['a malformed local id -> ambiguous', local(['app 1']), hit(), notFound('ambiguous')],
    ['a malformed hit -> ambiguous', local([APP1]), { ...hit(), applicationIds: APP1 } as unknown as R1PublicAshbyCandidateHit, notFound('ambiguous')],
    ['a missing ashbyCandidateId key -> ambiguous', { applicationIds: [APP1] } as unknown as ReturnType<typeof local>, hit(), notFound('ambiguous')],
  ])('%s', (_name, checked, h, expected) => {
    const scoped = scopeR1PublicCheck(checked, h);
    if (expected === 'read') expect(scoped.kind).toBe('read');
    else expect(scoped).toEqual(expected);
    expect(Object.isFrozen(scoped)).toBe(true);
    if (scoped.kind === 'read') expect(Object.isFrozen(scoped.applicationIds)).toBe(true);
    expectNoPii(scoped);
  });

  it('the review F3 case: one imported and one not-imported Active application is ambiguous on the check path too', () => {
    // Ashby person X: APP1 imported (Active, mapping enabled), APP2 not imported (Active, mapping enabled).
    const decision = decideR1PublicLocal([row()]);
    expect(decision).toEqual(check([APP1]));
    if (decision.kind !== 'check') return;
    const scoped = scopeR1PublicCheck(decision, hit({ applicationIds: [APP1, APP2] }));
    expect(scoped).toEqual(read(APP1, APP2));
    if (scoped.kind !== 'read') return;
    const byId: Record<string, R1PublicApplicationFacts> = {
      [APP1]: facts(),
      [APP2]: facts({ applicationId: APP2, link: null }),
    };
    const facts2 = scoped.applicationIds.map((id) => byId[id]!);
    expect(decideR1PublicApplications(facts2, { requireR1Stage: false })).toEqual(notFound('ambiguous'));
    // The same person found through the search path decides the same way.
    expect(decideR1PublicApplications([byId[APP2]!, byId[APP1]!], { requireR1Stage: false })).toEqual(notFound('ambiguous'));
  });
});

// ── confirmR1PublicTypedEmail (review F6) ───────────────────────────────────────────────────────
describe('confirmR1PublicTypedEmail', () => {
  const ok = { ok: true };
  const no = (reason: R1PublicMatchRefusal) => ({ ok: false, reason });

  it.each<[string, string, readonly R1PublicAshbyCandidateHit[], string, unknown]>([
    ['the typed email is new to Ashby: the phone match stands', EMAIL, [], ASHBY1, ok],
    ['only partial hits: the phone match stands', 'test@example.com', [hit({ emails: [EMAIL] })], ASHBY1, ok],
    ['the typed email is the same person', EMAIL, [hit()], ASHBY1, ok],
    ['the same person, the id in another case', EMAIL, [hit()], ASHBY1.toUpperCase(), ok],
    ['the typed email is ANOTHER Ashby person -> conflicting_identity', EMAIL, [hit({ id: ASHBY2 })], ASHBY1, no('conflicting_identity')],
    ['two exact people -> ambiguous', EMAIL, [hit(), hit({ id: ASHBY2 })], ASHBY1, no('ambiguous')],
    ['an unusable typed email: the phone match stands', 'not-an-email', [hit({ id: ASHBY2 })], ASHBY1, ok],
    ['a phone person id that is not an id -> ambiguous', EMAIL, [hit()], 'ashby 1', no('ambiguous')],
    ['malformed hits -> ambiguous', EMAIL, 'hits' as unknown as R1PublicAshbyCandidateHit[], ASHBY1, no('ambiguous')],
  ])('%s', (_name, email, hits, id, expected) => {
    const confirmed = confirmR1PublicTypedEmail(email, hits, id);
    expect(confirmed).toEqual(expected);
    expect(Object.isFrozen(confirmed)).toBe(true);
  });

  it('the review F6 case: the email names Ashby person B, the phone local A: refused', () => {
    const decision = decideR1PublicLocal([row({ matchedBy: 'phone' })]);
    expect(decision).toEqual(check([APP1], ASHBY1, false));
    if (decision.kind !== 'check') return;
    const page = readR1PublicAshbySearch({ results: [documentedCandidate({ id: ASHBY2 })], moreDataAvailable: false }, { email: EMAIL });
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(confirmR1PublicTypedEmail(EMAIL, page.hits, decision.ashbyCandidateId!)).toEqual(no('conflicting_identity'));
  });
});

// ── decideR1PublicApplications ──────────────────────────────────────────────────────────────────
describe('decideR1PublicApplications', () => {
  const OFF = { requireR1Stage: false };
  const ON = { requireR1Stage: true };
  const book = (applicationId = APP1, candidateId = C1) => ({ kind: 'book', candidateId, applicationId });
  const importIt = (applicationId = APP1) => ({ kind: 'import', applicationId });
  const archived = (over: Partial<R1PublicApplicationFacts> = {}) =>
    facts({ applicationId: APP2, status: 'Archived', ...over });

  it.each<[string, readonly R1PublicApplicationFacts[], { requireR1Stage: boolean }, unknown]>([
    ['one Active linked application: book', [facts()], OFF, book()],
    ['one Active unlinked application: import', [facts({ link: null })], OFF, importIt()],
    ['one Active and one Archived of one person: book the Active one', [archived(), facts()], OFF, book()],
    ['one Active unlinked and one Archived: import the Active one', [archived(), facts({ link: null })], OFF, importIt()],
    ['two Active (linked and unlinked): ambiguous', [facts(), facts({ applicationId: APP2, link: null })], OFF, notFound('ambiguous')],
    ['two Active (both linked): ambiguous', [facts(), facts({ applicationId: APP2 })], OFF, notFound('ambiguous')],
    ['Active on a disabled, archived or missing mapping only (linked): unmapped_job', [facts({ mappingEnabled: false })], OFF, notFound('unmapped_job')],
    ['Active on an unmapped job only (unlinked): unmapped_job', [facts({ mappingEnabled: false, link: null })], OFF, notFound('unmapped_job')],
    ['Active unbound link on an unmapped job: unmapped_job', [facts({ mappingEnabled: false, link: { candidateId: null, terminal: false } })], OFF, notFound('unmapped_job')],
    ['Active mapped plus Active unmapped: book the mapped one', [facts({ applicationId: APP2, mappingEnabled: false, link: null }), facts()], OFF, book()],
    ['Active mapped unlinked plus Active unmapped: import the mapped one', [facts({ link: null }), facts({ applicationId: APP2, mappingEnabled: false })], OFF, importIt()],
    ['a linked-but-terminal Active application never books', [facts({ link: { candidateId: C1, terminal: true } })], OFF, notFound('no_bookable_application')],
    ['a terminal link on an unmapped job is not unmapped_job', [facts({ mappingEnabled: false, link: { candidateId: C1, terminal: true } })], OFF, notFound('no_bookable_application')],
    ['an unbound link (import mid-flight) is never booked or imported', [facts({ link: { candidateId: null, terminal: false } })], OFF, notFound('no_bookable_application')],
    ['Archived', [facts({ status: 'Archived' })], OFF, notFound('not_active')],
    ['Hired', [facts({ status: 'Hired' })], OFF, notFound('not_active')],
    ['Lead', [facts({ status: 'Lead' })], OFF, notFound('not_active')],
    ['a null status', [facts({ status: null })], OFF, notFound('not_active')],
    ['active in the wrong case', [facts({ status: 'active' })], OFF, notFound('not_active')],
    ['ACTIVE in upper case', [facts({ status: 'ACTIVE' })], OFF, notFound('not_active')],
    ['Active with a space', [facts({ status: ' Active' })], OFF, notFound('not_active')],
    ['R1 rule OFF: a null milestone books', [facts({ stageMilestone: null })], OFF, book()],
    ['R1 rule OFF: an r2 milestone books', [facts({ stageMilestone: 'r2' })], OFF, book()],
    ['R1 rule ON: the r1 milestone books', [facts()], ON, book()],
    ['R1 rule ON: the r1 milestone imports', [facts({ link: null })], ON, importIt()],
    ['R1 rule ON: a null milestone is stage_not_r1', [facts({ stageMilestone: null })], ON, notFound('stage_not_r1')],
    ['R1 rule ON: r2 is stage_not_r1', [facts({ stageMilestone: 'r2' })], ON, notFound('stage_not_r1')],
    ['R1 rule ON: R1 in upper case is stage_not_r1', [facts({ stageMilestone: 'R1' })], ON, notFound('stage_not_r1')],
    ['R1 rule ON: r1 on the right stage beats an off-stage Active one', [facts({ applicationId: APP2, stageMilestone: 'r2' }), facts()], ON, book()],
    ['R1 rule ON: unmapped_job outranks stage_not_r1', [facts({ mappingEnabled: false }), facts({ applicationId: APP2, stageMilestone: 'r2' })], ON, notFound('unmapped_job')],
    ['R1 rule ON: an off-stage unmapped Active one is stage_not_r1', [facts({ mappingEnabled: false, stageMilestone: 'r2' })], ON, notFound('stage_not_r1')],
    ['R1 rule ON: stage_not_r1 outranks a terminal link', [facts({ link: { candidateId: C1, terminal: true } }), facts({ applicationId: APP2, stageMilestone: 'r2' })], ON, notFound('stage_not_r1')],
    ['no_bookable_application outranks not_active', [archived(), facts({ link: { candidateId: C1, terminal: true } })], OFF, notFound('no_bookable_application')],
    ['ten facts, one Active', [facts(), ...Array.from({ length: 9 }, (_, i) => archived({ applicationId: app(10 + i) }))], OFF, book()],
    ['eleven facts: ambiguous', [facts(), ...Array.from({ length: 10 }, (_, i) => archived({ applicationId: app(10 + i) }))], OFF, notFound('ambiguous')],
    ['a duplicate application id: ambiguous', [facts(), archived({ applicationId: APP1 })], OFF, notFound('ambiguous')],
    ['a duplicate application id differing in case: ambiguous', [facts(), archived({ applicationId: APP1.toUpperCase() })], OFF, notFound('ambiguous')],
    ['no facts', [], OFF, notFound('no_bookable_application')],
  ])('%s', (_name, input, o, expected) => {
    const decision = decideR1PublicApplications(input, o);
    expect(decision).toEqual(expected);
    expect(Object.isFrozen(decision)).toBe(true);
    expectNoPii(decision);
  });

  it.each<[string, unknown]>([
    ['not an array', { 0: facts() }],
    ['a null fact', [null]],
    ['a missing link key', [{ ...facts(), link: undefined }]],
    ['mappingEnabled as a string', [{ ...facts(), mappingEnabled: 'true' }]],
    ['an empty application id', [facts({ applicationId: '' })]],
    ['a numeric status', [{ ...facts(), status: 1 }]],
    ['a link candidate id that is not a UUID', [facts({ link: { candidateId: 'cand-1', terminal: false } })]],
    ['a link without terminal', [{ ...facts(), link: { candidateId: C1 } }]],
  ])('a malformed input refuses as ambiguous: %s', (_name, input) => {
    expect(decideR1PublicApplications(input as readonly R1PublicApplicationFacts[], { requireR1Stage: false })).toEqual(
      notFound('ambiguous'),
    );
  });

  it('fails closed on the stage rule: anything but an explicit false requires the R1 stage', () => {
    const offStage = [facts({ stageMilestone: null })];
    expect(decideR1PublicApplications(offStage, {} as { requireR1Stage: boolean })).toEqual(notFound('stage_not_r1'));
    expect(decideR1PublicApplications(offStage, { requireR1Stage: 'no' as unknown as boolean })).toEqual(notFound('stage_not_r1'));
    expect(decideR1PublicApplications(offStage, { requireR1Stage: false })).toEqual(book());
  });
});

// ── decideR1PublicCandidateFlags ────────────────────────────────────────────────────────────────
describe('decideR1PublicCandidateFlags', () => {
  const ok = { ok: true };
  const no = (reason: R1PublicMatchRefusal) => ({ ok: false, reason });

  it.each<[string, { doNotContact: unknown; fraudStatus: unknown; onFileEmail: unknown }, unknown]>([
    ['clean', { doNotContact: false, fraudStatus: null, onFileEmail: EMAIL }, ok],
    ['doNotContact true', { doNotContact: true, fraudStatus: null, onFileEmail: EMAIL }, no('do_not_contact')],
    ['doNotContact wins over a fraud flag', { doNotContact: true, fraudStatus: 'Fraudulent', onFileEmail: EMAIL }, no('do_not_contact')],
    ['doNotContact missing', { doNotContact: undefined, fraudStatus: null, onFileEmail: EMAIL }, no('do_not_contact')],
    ['doNotContact as the string false', { doNotContact: 'false', fraudStatus: null, onFileEmail: EMAIL }, no('do_not_contact')],
    ['Fraudulent', { doNotContact: false, fraudStatus: 'Fraudulent', onFileEmail: EMAIL }, no('fraud_flag')],
    ['Unsure', { doNotContact: false, fraudStatus: 'Unsure', onFileEmail: EMAIL }, no('fraud_flag')],
    ['fraudulent in lower case', { doNotContact: false, fraudStatus: 'fraudulent', onFileEmail: EMAIL }, no('fraud_flag')],
    ['UNSURE in upper case', { doNotContact: false, fraudStatus: 'UNSURE', onFileEmail: EMAIL }, no('fraud_flag')],
    ['an unknown status (Reviewed)', { doNotContact: false, fraudStatus: 'Reviewed', onFileEmail: EMAIL }, no('fraud_flag')],
    ['an empty status', { doNotContact: false, fraudStatus: '', onFileEmail: EMAIL }, no('fraud_flag')],
    ['an undefined status', { doNotContact: false, fraudStatus: undefined, onFileEmail: EMAIL }, no('fraud_flag')],
    ['a fraud flag wins over a missing email', { doNotContact: false, fraudStatus: 'Fraudulent', onFileEmail: null }, no('fraud_flag')],
    ['NotFraudulent', { doNotContact: false, fraudStatus: 'NotFraudulent', onFileEmail: EMAIL }, ok],
    ['Unreviewed', { doNotContact: false, fraudStatus: 'Unreviewed', onFileEmail: EMAIL }, ok],
    ['PassedFraudCheck', { doNotContact: false, fraudStatus: 'PassedFraudCheck', onFileEmail: EMAIL }, ok],
    ['notfraudulent in lower case', { doNotContact: false, fraudStatus: 'notfraudulent', onFileEmail: EMAIL }, ok],
    ['a null on-file email', { doNotContact: false, fraudStatus: null, onFileEmail: null }, no('no_on_file_email')],
    ['an empty on-file email', { doNotContact: false, fraudStatus: null, onFileEmail: '' }, no('no_on_file_email')],
    ['an unusable on-file email', { doNotContact: false, fraudStatus: null, onFileEmail: 'not-an-email' }, no('no_on_file_email')],
    ['a blank on-file email', { doNotContact: false, fraudStatus: null, onFileEmail: '   ' }, no('no_on_file_email')],
    ['an on-file email that needs normalising', { doNotContact: false, fraudStatus: null, onFileEmail: ' Test.Person@Example.com ' }, ok],
  ])('%s', (_name, p, expected) => {
    const decision = decideR1PublicCandidateFlags(
      p as { doNotContact: boolean; fraudStatus: string | null; onFileEmail: string | null },
    );
    expect(decision).toEqual(expected);
    expect(Object.isFrozen(decision)).toBe(true);
    expectNoPii(decision);
  });
});

// ── resolveR1PublicOnFileEmail ──────────────────────────────────────────────────────────────────
describe('resolveR1PublicOnFileEmail', () => {
  const LOCAL = 'local.person@example.com';
  const ASHBY_PRIMARY = 'ashby.person@example.com';

  it.each<[string, unknown, string | null, string | null]>([
    ['the Ashby primary wins over the local email', { primaryEmailAddress: contact('Ashby.Person@Example.com') }, LOCAL, ASHBY_PRIMARY],
    ['a bare-string primary', { primaryEmailAddress: ASHBY_PRIMARY }, LOCAL, ASHBY_PRIMARY],
    ['the documented candidate', documentedCandidate(), LOCAL, EMAIL],
    ['a null primary falls back to the local email, normalised', { primaryEmailAddress: null }, '  Local.Person@Example.com ', LOCAL],
    ['a missing primary falls back', {}, LOCAL, LOCAL],
    ['a blank primary falls back', { primaryEmailAddress: '   ' }, LOCAL, LOCAL],
    ['an unusable primary falls back', { primaryEmailAddress: contact('not-an-email') }, LOCAL, LOCAL],
    ['a primary whose value is not text falls back', { primaryEmailAddress: { value: 42 } }, LOCAL, LOCAL],
    ['both missing', { primaryEmailAddress: null }, null, null],
    ['a missing primary and an unusable local email', {}, 'not-an-email', null],
    ['the emailAddresses list is never used', { primaryEmailAddress: null, emailAddresses: [contact(OTHER_EMAIL)] }, null, null],
    ['results null: the local email', null, LOCAL, LOCAL],
    ['results a string: the local email', 'candidate', LOCAL, LOCAL],
    ['results an array: the local email', [{ primaryEmailAddress: ASHBY_PRIMARY }], LOCAL, LOCAL],
  ])('%s', (_name, results, local, expected) => {
    expect(resolveR1PublicOnFileEmail(results, local)).toBe(expected);
  });
});

// ── r1PublicMatchAlert ──────────────────────────────────────────────────────────────────────────
describe('r1PublicMatchAlert', () => {
  it('names an alert for ambiguity and unmapped jobs only', () => {
    const table = Object.fromEntries(R1_PUBLIC_MATCH_REFUSALS.map((reason) => [reason, r1PublicMatchAlert(reason)]));
    expect(table).toEqual({
      no_match: null,
      conflicting_identity: 'r1_meet_public_ambiguous_match',
      ambiguous: 'r1_meet_public_ambiguous_match',
      no_bookable_application: null,
      unmapped_job: 'r1_meet_public_unmapped_job',
      not_active: null,
      stage_not_r1: null,
      do_not_contact: null,
      fraud_flag: null,
      no_on_file_email: null,
    });
  });
});
