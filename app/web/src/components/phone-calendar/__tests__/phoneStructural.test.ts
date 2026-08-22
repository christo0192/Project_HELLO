/**
 * Source-level invariants for the phone calendar.
 *
 * These are the rules a render test cannot enforce, because the code that
 * breaks them still renders — it just renders the wrong hour to an operator
 * in another zone, or puts an identifier in the DOM that the fixture happened
 * not to contain.
 *
 * Every scan below asserts its own inputs are non-empty first. A file list
 * built from a glob that silently matched nothing would turn all of this into
 * a safety assertion that cannot fail, which is worse than no assertion at
 * all because it reads as coverage.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const COMPONENT_DIR = resolve(__dirname, '..');
const PAGE = resolve(__dirname, '../../../pages/PhoneCalendarPage.tsx');
const IST_HELPER = resolve(__dirname, '../../../lib/ist-datetime.ts');

interface SourceFile {
  name: string;
  text: string;
}

/** Every non-test source of the phone calendar surface. */
function surfaceSources(): SourceFile[] {
  const files = readdirSync(COMPONENT_DIR)
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .map((f) => ({ name: `phone-calendar/${f}`, text: readFileSync(resolve(COMPONENT_DIR, f), 'utf8') }));
  files.push({ name: 'pages/PhoneCalendarPage.tsx', text: readFileSync(PAGE, 'utf8') });
  return files;
}

describe('the file list is real', () => {
  it('finds every source it claims to scan', () => {
    const files = surfaceSources();
    expect(files.length).toBeGreaterThan(8);
    const names = files.map((f) => f.name);
    for (const expected of [
      'phone-calendar/PhoneWeekTable.tsx',
      'phone-calendar/PhoneQueueList.tsx',
      'phone-calendar/PhoneAppointmentDetail.tsx',
      'phone-calendar/PhoneBookingPanel.tsx',
      'phone-calendar/PhoneSlotPicker.tsx',
      'phone-calendar/phoneGrid.ts',
      'phone-calendar/phoneVocabulary.ts',
      'phone-calendar/phoneCalendarFilters.ts',
      'phone-calendar/phoneErrors.ts',
      'pages/PhoneCalendarPage.tsx',
    ]) {
      expect(names).toContain(expected);
    }
    for (const file of files) expect(file.text.length).toBeGreaterThan(100);
  });
});

/**
 * ── NO COMPONENT MAY READ THE HOST CLOCK'S ZONE ───────────────────────
 *
 * `getHours()` and friends answer in whatever zone the browser is set to.
 * On a calendar whose entire contract is "these times are IST", a single one
 * of these would produce a page that is silently wrong for anyone outside
 * India — and right for the developer who wrote it, which is why it needs a
 * mechanical check rather than review.
 *
 * The UTC-suffixed accessors (`getUTCHours`, `getUTCDate`, …) are fine: they
 * are zone-independent by definition. `src/lib/ist-datetime.ts` is where the
 * conversion is allowed to live, and it is scanned separately below.
 */
describe('no host-local time reading', () => {
  const FORBIDDEN = [
    /\.getHours\s*\(/,
    /\.getMinutes\s*\(/,
    /\.getSeconds\s*\(/,
    /\.getDate\s*\(/,
    /\.getMonth\s*\(/,
    /\.getFullYear\s*\(/,
    /\.getDay\s*\(/,
    /\.getTimezoneOffset\s*\(/,
    /\.toLocaleString\s*\(/,
    /\.toLocaleDateString\s*\(/,
    /\.toLocaleTimeString\s*\(/,
    /\.toDateString\s*\(/,
    /\.toTimeString\s*\(/,
  ];

  it('control: the patterns match the code they are meant to catch', () => {
    // Without this, a typo in a regex would make the sweep below vacuous.
    const sample = 'const h = new Date(iso).getHours();';
    expect(FORBIDDEN.some((re) => re.test(sample))).toBe(true);
    expect(FORBIDDEN.some((re) => re.test('d.toLocaleTimeString()'))).toBe(true);
    // And do NOT match the zone-independent accessors.
    expect(FORBIDDEN.some((re) => re.test('d.getUTCHours()'))).toBe(false);
    expect(FORBIDDEN.some((re) => re.test('d.getUTCDate()'))).toBe(false);
  });

  it('appears in no phone calendar source', () => {
    const offenders: string[] = [];
    for (const file of surfaceSources()) {
      file.text.split('\n').forEach((line, i) => {
        // Prose in a comment may legitimately name these.
        const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, '');
        for (const re of FORBIDDEN) {
          if (re.test(code)) offenders.push(`${file.name}:${i + 1} ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * Formatting must name the zone. An `Intl.DateTimeFormat` without an explicit
 * `timeZone` silently formats in the host's zone, which is the same defect as
 * `getHours()` wearing better clothes.
 */
describe('every formatter names its zone', () => {
  it('constructs no Intl formatter outside the IST helper', () => {
    const offenders = surfaceSources()
      .filter((f) => /Intl\.DateTimeFormat/.test(f.text))
      .map((f) => f.name);
    // The one place a formatter may be built is `lib/ist-datetime.ts`.
    expect(offenders).toEqual([]);
  });

  it('pins the zone on every formatter the helper does build', () => {
    const helper = readFileSync(IST_HELPER, 'utf8');
    const constructions = helper.match(/new Intl\.DateTimeFormat\([^)]*\)/g) ?? [];
    expect(constructions.length).toBeGreaterThan(0);
    for (const construction of constructions) {
      expect(construction).toMatch(/timeZone/);
    }
    // And the zone it pins is the one the calling window is expressed in.
    expect(helper).toMatch(/IST_TIME_ZONE = 'Asia\/Kolkata'/);
  });
});

/**
 * ── NOTHING PROVIDER-BEARING MAY BE NAMED IN THIS SURFACE ─────────────
 *
 * The API achieves this by omission — it never selects the columns — and the
 * job here is to make sure the UI never reintroduces them by reading a field
 * that would only exist if someone widened the projection. A component that
 * so much as NAMES `sip_call_id` is either dead code or a request for a leak.
 */
describe('no provider or contact identifier is named', () => {
  const FORBIDDEN_FIELDS = [
    'sip_call_id',
    'room_name',
    'participant_identity',
    'egress_id',
    'egress_status',
    'lease_token',
    'lease_owner',
    'provider_event_id',
    'provider_metadata',
    'suppression_digest',
    'phone_e164',
    'transcript',
  ];

  it('control: the scan would catch one if it were there', () => {
    const sample = 'const n = appt.phone_e164;';
    expect(FORBIDDEN_FIELDS.some((f) => sample.includes(f))).toBe(true);
  });

  it('names none of them in any phone calendar source', () => {
    const offenders: string[] = [];
    for (const file of surfaceSources()) {
      for (const field of FORBIDDEN_FIELDS) {
        // Skip prose: the docblocks deliberately LIST what is excluded, and
        // a comment naming the ban is the opposite of a leak.
        file.text.split('\n').forEach((line, i) => {
          const trimmed = line.trim();
          const isComment =
            trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
          if (!isComment && line.includes(field)) {
            offenders.push(`${file.name}:${i + 1} ${field}`);
          }
        });
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * The API client is the only door to the network, and the phone routes are
 * the only ones this surface may open. A component reaching for `fetch`
 * directly would bypass the bearer-token handling, the 401 event and the
 * error envelope all at once.
 */
describe('no direct network access', () => {
  it('uses no fetch, XHR, WebSocket or EventSource', () => {
    const offenders: string[] = [];
    for (const file of surfaceSources()) {
      for (const pattern of [/\bfetch\s*\(/, /XMLHttpRequest/, /new WebSocket/, /EventSource/]) {
        if (pattern.test(file.text)) offenders.push(file.name);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('calls only the phone endpoints of the shared client', () => {
    const allowed = new Set([
      'getPhoneCalendar',
      'getPhoneSlots',
      'createPhoneAppointment',
      'reschedulePhoneAppointment',
      'cancelPhoneAppointment',
      'getMe',
    ]);
    // Whitespace is permitted around the dot: the page writes several of
    // these as `api\n  .getMe()`, and a pattern that missed those would
    // quietly shrink the set this allowlist is checking.
    const CALL = /\bapi\s*\.\s*([A-Za-z0-9_]+)\s*\(/g;

    const used = new Set<string>();
    for (const file of surfaceSources()) {
      for (const m of file.text.matchAll(CALL)) used.add(m[1]);
    }

    // Non-vacuous, and specific: every endpoint this surface is supposed to
    // use must actually have been found, so a future refactor that hides a
    // call from the scan fails here rather than weakening the allowlist.
    expect([...used].sort()).toEqual([
      'cancelPhoneAppointment',
      'createPhoneAppointment',
      'getMe',
      'getPhoneCalendar',
      'getPhoneSlots',
      'reschedulePhoneAppointment',
    ]);
    expect([...used].filter((name) => !allowed.has(name))).toEqual([]);
  });
});
