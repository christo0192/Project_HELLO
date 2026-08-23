/**
 * Cross-package vocabulary drift guard (review finding F-1).
 *
 * ── THE DEFECT THIS EXISTS FOR ────────────────────────────────────────
 * `types.ts` hand-copies the P6 closed vocabularies as literal unions.
 * `Record<PhoneAppointmentStatus, Term>` then gives compile-time
 * exhaustiveness *within the web package* — which is precisely why an API
 * change is invisible: adding `awaiting_disclosure` to the substrate breaks
 * nothing here, and the new state reaches an operator's table as a raw
 * snake_case code through the `?? { label: status }` fallback. `tsc` cannot
 * see across the package boundary, and the structural suite scans for
 * forbidden patterns rather than comparing vocabularies. Nothing compared
 * them, so nothing could fail.
 *
 * ── WHY THIS COMPARES THREE COPIES, NOT ONE ───────────────────────────
 * The web side states each vocabulary THREE times: the type union in
 * `types.ts`, the ordering constant in `phoneCalendarFilters.ts`, and the
 * label map in `phoneVocabulary.ts`. A guard that checked only the union
 * would let the other two drift silently — which is the failure this
 * project has already been bitten by (a second vocabulary copy failing
 * quietly when a parser dropped unknowns). So every assertion below is a
 * set equality against the OpenAPI document, and the label map is checked
 * BEHAVIOURALLY: each API member must render a real label rather than
 * falling through to the raw code.
 *
 * ── THE LOOPS ARE DRIVEN BY THE API, NEVER BY THE WEB CONSTANT ────────
 * Every iteration below walks the set extracted from `openapi.yaml`. A loop
 * driven by the constant it is validating proves nothing: it would pass
 * unchanged if the API grew a member the web side had never heard of, which
 * is the exact direction of drift this guards.
 *
 * ── NON-VACUITY ───────────────────────────────────────────────────────
 * The extractor is proved to be wired to the FILE, not to a constant: a
 * `describe` block below mutates the YAML TEXT (adds, removes and renames a
 * member) and asserts the comparison goes red each time. If the anchoring
 * ever silently stops matching, those mutations stop being observed and the
 * proofs fail — so this guard cannot rot into a green no-op.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PHONE_STATE_ORDER,
  PHONE_STATUS_ORDER,
} from '../phoneCalendarFilters';
import {
  OPERATOR_CANCEL_REASONS,
  appointmentStatusTerm,
  cancelReasonLabel,
  engagementStateTerm,
  slotRefusalLabel,
} from '../phoneVocabulary';

/**
 * The API's OpenAPI document — the interface P6 published and contract-tests
 * against its own live handlers. Reading the spec rather than the migration
 * text is deliberate: the spec is what the web package is entitled to rely
 * on, and P6's own suite is what keeps it honest against 0042.
 */
const OPENAPI_PATH = resolve(__dirname, '../../../../../api/openapi/openapi.yaml');
const TYPES_PATH = resolve(__dirname, '../../../types.ts');

const openapi = readFileSync(OPENAPI_PATH, 'utf8');
const typesSource = readFileSync(TYPES_PATH, 'utf8');

// ══════════════════════════════════════════════════════════════════════
//  Extraction — anchored by indentation, and loud when it finds nothing
// ══════════════════════════════════════════════════════════════════════

/**
 * The body of one `components.schemas` entry.
 *
 * Anchored on an exact four-space indent so `PhoneAppointment` cannot
 * accidentally capture `PhoneAppointmentCancelBody` — a prefix collision of
 * exactly the kind that has previously made a drift test in this repository
 * assert against the wrong thing.
 */
export function schemaBlock(yaml: string, name: string): string {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => l === `    ${name}:`);
  if (start === -1) throw new Error(`schema not found in openapi.yaml: ${name}`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    // The next sibling schema, at the same indent.
    if (/^ {4}\S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

/**
 * The `enum` members of one property of one schema.
 *
 * Scoped to the property's own sub-block, so a neighbouring property's enum
 * can never be returned instead. Throws rather than returning an empty list:
 * a silently empty extraction is what turns a drift guard into a test that
 * passes on anything.
 */
export function enumOfProperty(yaml: string, schema: string, property: string): string[] {
  const block = schemaBlock(yaml, schema).split('\n');
  const propIndex = block.findIndex((l) => new RegExp(`^ {8}${property}:\\s*$`).test(l));
  if (propIndex === -1) {
    throw new Error(`property not found: ${schema}.${property}`);
  }
  let end = block.length;
  for (let i = propIndex + 1; i < block.length; i += 1) {
    if (/^ {8}\S/.test(block[i])) {
      end = i;
      break;
    }
  }
  const enumLine = block
    .slice(propIndex + 1, end)
    .find((l) => /^\s+enum:\s*\[.*\]\s*$/.test(l));
  if (!enumLine) throw new Error(`no enum on property: ${schema}.${property}`);
  const inner = /\[(.*)\]/.exec(enumLine)?.[1] ?? '';
  const members = inner
    .split(',')
    .map((m) => m.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
  if (members.length === 0) throw new Error(`empty enum: ${schema}.${property}`);
  return members;
}

/** The members of a `export type X = 'a' | 'b'` union in the web types file. */
export function unionMembers(source: string, typeName: string): string[] {
  const start = source.indexOf(`export type ${typeName} =`);
  if (start === -1) throw new Error(`type not found in types.ts: ${typeName}`);
  const end = source.indexOf(';', start);
  if (end === -1) throw new Error(`unterminated type: ${typeName}`);
  const members = [...source.slice(start, end).matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);
  if (members.length === 0) throw new Error(`no members parsed for type: ${typeName}`);
  return members;
}

interface VocabularyDiff {
  missingInWeb: string[];
  extraInWeb: string[];
}

/** Bidirectional set difference. Both directions matter and mean different things. */
export function diffVocabulary(
  apiMembers: ReadonlyArray<string>,
  webMembers: ReadonlyArray<string>,
): VocabularyDiff {
  const api = new Set(apiMembers);
  const web = new Set(webMembers);
  return {
    // The API gained a member: the UI renders it as a raw snake_case code.
    missingInWeb: [...api].filter((m) => !web.has(m)).sort(),
    // The API dropped one, or the web copy invented one that never existed.
    extraInWeb: [...web].filter((m) => !api.has(m)).sort(),
  };
}

const NO_DRIFT: VocabularyDiff = { missingInWeb: [], extraInWeb: [] };

// The vocabularies this UI renders, each named by where the API declares it.
const API_APPOINTMENT_STATUS = enumOfProperty(openapi, 'PhoneCalendarAppointment', 'status');
const API_ENGAGEMENT_STATE = enumOfProperty(
  openapi,
  'PhoneCalendarAppointment',
  'engagement_state',
);
const API_APPOINTMENT_SOURCE = enumOfProperty(openapi, 'PhoneCalendarAppointment', 'source');
const API_OPERATOR_CANCEL_REASON = enumOfProperty(
  openapi,
  'PhoneAppointmentCancelBody',
  'reason',
);
const API_SLOT_REFUSAL = enumOfProperty(openapi, 'PhoneSlot', 'refusals');

// ══════════════════════════════════════════════════════════════════════
//  The extractor is real
// ══════════════════════════════════════════════════════════════════════

describe('the extractor reads the API document, and says so when it cannot', () => {
  it('pulls the exact vocabularies P6 publishes', () => {
    expect(API_APPOINTMENT_STATUS).toEqual([
      'scheduled',
      'confirmed',
      'cancelled',
      'superseded',
      'fulfilled',
      'missed',
    ]);
    expect(API_ENGAGEMENT_STATE).toHaveLength(13);
    expect(API_ENGAGEMENT_STATE).toContain('pending_prereqs');
    expect(API_ENGAGEMENT_STATE).toContain('awaiting_retry');
    expect(API_APPOINTMENT_SOURCE).toEqual([
      'candidate_voice',
      'hr_manual',
      'system_deferral',
    ]);
    expect(API_OPERATOR_CANCEL_REASON).toEqual([
      'candidate_request',
      'hr_cancelled',
      'emergency_stop',
      'engagement_cancelled',
    ]);
    expect(API_SLOT_REFUSAL).toEqual(['slot_in_past', 'at_projected_capacity']);
  });

  it('refuses to be anchored on a prefix', () => {
    // `PhoneAppointment` must not capture `PhoneAppointmentCancelBody`. A
    // prefix collision is how a drift test in this repository previously
    // ended up asserting against four unintended functions.
    const appointment = schemaBlock(openapi, 'PhoneAppointment');
    expect(appointment).toContain('PhoneAppointment:');
    expect(appointment).not.toContain('PhoneAppointmentCancelBody');
    expect(appointment).not.toContain('PhoneCalendarAppointment');
  });

  it('throws rather than returning nothing', () => {
    expect(() => schemaBlock(openapi, 'PhoneNotARealSchema')).toThrow(/schema not found/);
    expect(() => enumOfProperty(openapi, 'PhoneCalendarAppointment', 'nope')).toThrow(
      /property not found/,
    );
    // `id` is a real property with no enum — extraction must not invent one.
    expect(() => enumOfProperty(openapi, 'PhoneCalendarAppointment', 'id')).toThrow(
      /no enum on property/,
    );
    expect(() => unionMembers(typesSource, 'NotARealType')).toThrow(/type not found/);
  });

  it('agrees with itself where P6 declares a vocabulary twice', () => {
    // `status` and `state` each appear on two schemas. If those ever
    // disagree the API contradicts itself, and this UI would be right to
    // stop rather than pick one.
    expect(enumOfProperty(openapi, 'PhoneAppointment', 'status')).toEqual(
      API_APPOINTMENT_STATUS,
    );
    expect(enumOfProperty(openapi, 'PhoneEngagementDetail', 'state')).toEqual(
      API_ENGAGEMENT_STATE,
    );
  });
});

// ══════════════════════════════════════════════════════════════════════
//  Bidirectional set equality, API → each of the three web copies
// ══════════════════════════════════════════════════════════════════════

describe('appointment status agrees across the package boundary', () => {
  it('matches the type union in types.ts', () => {
    expect(
      diffVocabulary(API_APPOINTMENT_STATUS, unionMembers(typesSource, 'PhoneAppointmentStatus')),
    ).toEqual(NO_DRIFT);
  });

  it('matches the filter ordering constant', () => {
    expect(diffVocabulary(API_APPOINTMENT_STATUS, PHONE_STATUS_ORDER)).toEqual(NO_DRIFT);
  });

  it('renders a real label for every member, never a raw code', () => {
    // Driven by the API set. This is the assertion that actually catches the
    // operator-visible symptom: an unmapped status falls through to
    // `{ label: status }` and reaches the table as `awaiting_disclosure`.
    for (const member of API_APPOINTMENT_STATUS) {
      const term = appointmentStatusTerm(member);
      expect(term.label, `unmapped appointment status: ${member}`).not.toBe(member);
      expect(term.label.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('engagement state agrees across the package boundary', () => {
  it('matches the type union in types.ts', () => {
    expect(
      diffVocabulary(API_ENGAGEMENT_STATE, unionMembers(typesSource, 'PhoneEngagementState')),
    ).toEqual(NO_DRIFT);
  });

  it('matches the filter ordering constant', () => {
    expect(diffVocabulary(API_ENGAGEMENT_STATE, PHONE_STATE_ORDER)).toEqual(NO_DRIFT);
  });

  it('renders a real label for every member, never a raw code', () => {
    for (const member of API_ENGAGEMENT_STATE) {
      const term = engagementStateTerm(member);
      expect(term.label, `unmapped engagement state: ${member}`).not.toBe(member);
      expect(term.label.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('the narrower and smaller vocabularies agree too', () => {
  it('matches the appointment source union', () => {
    expect(
      diffVocabulary(API_APPOINTMENT_SOURCE, unionMembers(typesSource, 'PhoneAppointmentSource')),
    ).toEqual(NO_DRIFT);
  });

  it('matches the operator cancel reasons, in both the union and the offered list', () => {
    // This one is deliberately NARROWER than 0042's full cancel vocabulary —
    // `superseded` and `system_deferral_expired` are written only by the RPC
    // and the expiry sweep. The API already encodes that narrowing in
    // `PhoneAppointmentCancelBody`, so comparing against it preserves the
    // restraint rather than re-deriving it.
    expect(
      diffVocabulary(
        API_OPERATOR_CANCEL_REASON,
        unionMembers(typesSource, 'PhoneOperatorCancelReason'),
      ),
    ).toEqual(NO_DRIFT);
    expect(
      diffVocabulary(
        API_OPERATOR_CANCEL_REASON,
        OPERATOR_CANCEL_REASONS.map((r) => r.value),
      ),
    ).toEqual(NO_DRIFT);
  });

  it('labels every operator cancel reason the API accepts', () => {
    for (const member of API_OPERATOR_CANCEL_REASON) {
      expect(cancelReasonLabel(member), `unmapped cancel reason: ${member}`).not.toBe(member);
    }
  });

  it('matches the slot refusals, and labels each one', () => {
    expect(
      diffVocabulary(API_SLOT_REFUSAL, unionMembers(typesSource, 'PhoneSlotRefusal')),
    ).toEqual(NO_DRIFT);
    for (const member of API_SLOT_REFUSAL) {
      expect(slotRefusalLabel(member), `unmapped slot refusal: ${member}`).not.toBe(member);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
//  RECORDED RED MUTATION PROOF
// ══════════════════════════════════════════════════════════════════════

/**
 * Each case below mutates the OpenAPI TEXT, re-runs the real extractor over
 * the mutated document, and asserts the comparison goes red. That proves two
 * things at once that a hand-written array could not:
 *
 *   1. the comparison detects drift in BOTH directions, and
 *   2. the extractor is genuinely reading the file — if its anchoring ever
 *      stopped matching, the mutation would not be observed and these proofs
 *      would fail rather than passing quietly.
 *
 * Nothing here touches the real document; every mutation is applied to an
 * in-memory copy of the string.
 */
describe('red mutation proof — the guard fails when it should', () => {
  const STATUS_LINE =
    '          enum: [scheduled, confirmed, cancelled, superseded, fulfilled, missed]';

  function mutated(replacement: string): string {
    expect(openapi).toContain(STATUS_LINE);
    // Only the FIRST occurrence is replaced, which is `PhoneAppointment`'s —
    // enough for `schemaBlock` to observe a difference on that schema.
    return openapi.replace(STATUS_LINE, replacement);
  }

  it('goes red when the API GAINS a status the web side has never heard of', () => {
    const doc = mutated(
      '          enum: [scheduled, confirmed, cancelled, superseded, fulfilled, missed, awaiting_disclosure]',
    );
    const api = enumOfProperty(doc, 'PhoneAppointment', 'status');
    expect(api).toContain('awaiting_disclosure');

    const drift = diffVocabulary(api, unionMembers(typesSource, 'PhoneAppointmentStatus'));
    expect(drift).not.toEqual(NO_DRIFT);
    expect(drift.missingInWeb).toEqual(['awaiting_disclosure']);
    expect(drift.extraInWeb).toEqual([]);
  });

  it('goes red when the API DROPS a status the web side still declares', () => {
    const doc = mutated(
      '          enum: [scheduled, confirmed, cancelled, superseded, fulfilled]',
    );
    const api = enumOfProperty(doc, 'PhoneAppointment', 'status');
    expect(api).not.toContain('missed');

    const drift = diffVocabulary(api, unionMembers(typesSource, 'PhoneAppointmentStatus'));
    expect(drift).not.toEqual(NO_DRIFT);
    expect(drift.extraInWeb).toEqual(['missed']);
    expect(drift.missingInWeb).toEqual([]);
  });

  it('goes red in BOTH directions on a rename', () => {
    const doc = mutated(
      '          enum: [scheduled, confirmed, cancelled, superseded, fulfilled, no_answer_missed]',
    );
    const api = enumOfProperty(doc, 'PhoneAppointment', 'status');
    const drift = diffVocabulary(api, unionMembers(typesSource, 'PhoneAppointmentStatus'));
    expect(drift.missingInWeb).toEqual(['no_answer_missed']);
    expect(drift.extraInWeb).toEqual(['missed']);
  });

  it('goes red when a NEW member reaches the operator as a raw code', () => {
    // The behavioural half of the guard: prove the fallback really is
    // detectable, so the "renders a real label" assertions above are not
    // passing merely because nothing can make them fail.
    const unknown = 'awaiting_disclosure';
    expect(appointmentStatusTerm(unknown).label).toBe(unknown);
    expect(engagementStateTerm(unknown).label).toBe(unknown);
    expect(cancelReasonLabel(unknown)).toBe(unknown);
    expect(slotRefusalLabel(unknown)).toBe(unknown);
  });

  it('goes red when the extractor is pointed at a document that lost the schema', () => {
    const doc = openapi.replace('    PhoneCalendarAppointment:', '    PhoneRenamedSchema:');
    expect(() => enumOfProperty(doc, 'PhoneCalendarAppointment', 'status')).toThrow(
      /schema not found/,
    );
  });
});
