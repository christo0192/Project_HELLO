/**
 * ashby-candidate-info-contract.test.ts — can the API actually fetch the
 * required candidate details (name, email, primary phone) out of the response
 * shapes Ashby DOCUMENTS for `application.info` and `candidate.info`?
 *
 * The sibling suites feed the extractor and the profile job hand-trimmed
 * objects (`{ results: {...} }` straight from a fake client). This one pins the
 * contract end to end instead:
 *
 *   documented JSON envelope ─► REAL AshbyClient (injected transport, no
 *   network) ─► REAL `ashby.profile` handler ─► extractAshbyCandidateProfile
 *   ─► deriveAshbyProfilePhone ─► applyAshbyCandidateProfile (recorded)
 *
 * Documented shapes (developers.ashbyhq.com, reference pages `candidateinfo`
 * and `applicationinfo`, read 2026-10-20):
 *
 *   - Every response is `{ success: true, results }` or the ErrorResponse
 *     `{ success: false, errors: [{ message, parameter? }] }`.
 *   - `candidate.info` results: a Candidate whose REQUIRED keys are id,
 *     createdAt, updatedAt, name, primaryEmailAddress, emailAddresses,
 *     primaryPhoneNumber, phoneNumbers, socialLinks, tags, applicationIds,
 *     resumeFileHandle, fileHandles, profileUrl. `primaryEmailAddress`,
 *     `primaryPhoneNumber` and `resumeFileHandle` are nullable. LIVE CORRECTION
 *     (2026-10-21): the first real no-resume applicant was left at
 *     `resume_shape_unknown`, which means `resumeFileHandle` arrived OMITTED,
 *     not `null`. Both must read as "no resume". Contact items are ContactInfo
 *     `{ value: string, type: 'Personal'|'Work'|'Other', isPrimary: boolean }`.
 *     `resumeFileHandle` is a FileHandle `{ id, name, handle }` or null.
 *   - `application.info` results: the application at the ROOT of `results`
 *     with `status` in Active|Archived|Hired|Lead, `currentInterviewStage`,
 *     `job`, and an embedded `candidate` carrying ONLY id, name,
 *     primaryEmailAddress and primaryPhoneNumber (no lists;
 *     `additionalProperties: false`). Only `id` and `name` are REQUIRED on the
 *     embedded candidate: its two contact keys may be omitted outright, not
 *     just null.
 *
 * Every name, email, id and number below is synthetic.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Record every logger call with its RAW arguments ─────────────────────────
// The production logger scrubs emails and long digit runs before it writes,
// so a stdout capture would hide a leak the code made. The assertion here is
// stricter: no contact value is ever HANDED to the logger at all.
const loggerCalls = vi.hoisted(
  () => [] as Array<{ component: string; level: string; args: unknown[] }>,
);
vi.mock('../lib/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/logger.js')>();
  return {
    ...actual,
    createLogger: (component: string, deps?: Parameters<typeof actual.createLogger>[1]) => {
      const real = actual.createLogger(component, deps);
      const wrap = (level: 'debug' | 'info' | 'warn' | 'error') =>
        (...args: Parameters<typeof real.info>) => {
          loggerCalls.push({ component, level, args });
          return real[level](...args);
        };
      return { debug: wrap('debug'), info: wrap('info'), warn: wrap('warn'), error: wrap('error') };
    },
  };
});

import { createAshbyClient, type AshbyLogRecord, type AshbyTransportRequest } from '../integrations/ashby/client.js';
import { AshbyError } from '../integrations/ashby/errors.js';
import {
  extractAshbyCandidateProfile,
  extractAshbyApplicationStatus,
} from '../integrations/ashby/candidate-profile.js';
import { deriveAshbyProfilePhone, STRICT_IN_MOBILE_E164 } from '../lib/candidate-phone.js';
import {
  buildAshbyHandlers,
  classifyResumePresence,
  describeResumeShape,
  extractResumeHandle,
  ASHBY_PROFILE_QUEUE,
  ASHBY_INGESTION_QUEUE,
} from '../integrations/ashby/runtime-workers.js';
import type {
  AshbyCandidateProfileInput,
  AshbyCandidateProfileResult,
  ResolvedMapping,
  WorkflowLinkRow,
} from '../integrations/ashby/orchestration.js';

// ── Synthetic identity ──────────────────────────────────────────────────────
const APP_ID = '0b6f3c1e-1111-4a00-8000-00000000a001';
const CAND_ID = '0b6f3c1e-2222-4a00-8000-00000000c001';
const JOB_ID = '0b6f3c1e-3333-4a00-8000-00000000b001';
const STAGE_ID = '0b6f3c1e-4444-4a00-8000-00000000e001';
const PLAN_ID = '0b6f3c1e-5555-4a00-8000-00000000f001';
const FILE_ID = '0b6f3c1e-6666-4a00-8000-00000000f002';
const LINK_ID = 'link_contract_1';

const NAME = 'Test Person';
const EMAIL = 'test.person@example.com';
const WORK_EMAIL = 'test.person.work@example.com';
const PRIMARY_RAW = '+91 98123 45670';
const PRIMARY_E164 = '+919812345670';
const SECONDARY_RAW = '+91 98123 45671';
const SECONDARY_E164 = '+919812345671';

/** Substrings that must never reach a logger argument, a client log record or a throw. */
const PII_FRAGMENTS = [
  'Test Person', 'Person', 'test.person', 'example.com',
  '9812345670', '9812345671', '98123', '45670', '45671',
];

type ContactType = 'Personal' | 'Work' | 'Other';
function contact(value: string, type: ContactType = 'Personal', isPrimary = true) {
  return { value, type, isPrimary };
}

/** A `candidate.info` `results` object with every documented required key. */
function documentedCandidate(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CAND_ID,
    createdAt: '2026-10-01T09:30:00.000Z',
    updatedAt: '2026-10-19T11:05:00.000Z',
    name: NAME,
    primaryEmailAddress: contact(EMAIL),
    emailAddresses: [contact(EMAIL)],
    primaryPhoneNumber: contact(PRIMARY_RAW),
    phoneNumbers: [contact(PRIMARY_RAW)],
    socialLinks: [],
    tags: [],
    applicationIds: [APP_ID],
    resumeFileHandle: null,
    fileHandles: [],
    profileUrl: `https://app.ashbyhq.com/candidates/${CAND_ID}`,
    source: null,
    creditedToUser: null,
    timezone: null,
    fraudStatus: null,
    ...over,
  };
}

/**
 * An `application.info` `results` object: the application at the root, the
 * candidate embedded with ONLY the four documented keys.
 */
function documentedApplication(
  candidateOver: Record<string, unknown> = {},
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: APP_ID,
    createdAt: '2026-10-01T09:30:00.000Z',
    updatedAt: '2026-10-19T11:05:00.000Z',
    status: 'Active',
    customFields: [],
    candidate: {
      id: CAND_ID,
      name: NAME,
      primaryEmailAddress: contact(EMAIL),
      primaryPhoneNumber: contact(PRIMARY_RAW),
      ...candidateOver,
    },
    currentInterviewStage: {
      id: STAGE_ID,
      title: 'AI Phone Screen',
      type: 'PreInterviewScreen',
      orderInInterviewPlan: 2,
      interviewStageGroupId: null,
      interviewPlanId: PLAN_ID,
    },
    source: null,
    archiveReason: null,
    archivedAt: null,
    job: { id: JOB_ID, title: 'Synthetic Role', locationId: null, departmentId: null },
    creditedToUser: null,
    hiringTeam: [],
    appliedViaJobPostingId: null,
    submitterClientIp: null,
    submitterUserAgent: null,
    ...over,
  };
}

const ok = (results: unknown) => ({ success: true, results });

/** The documented ErrorResponse, with contact data in the message on purpose. */
const documentedError = {
  success: false,
  errors: [{ message: `Candidate ${NAME} <${EMAIL}> ${PRIMARY_RAW} not found`, parameter: 'id' }],
};

// ── A REAL client over an in-memory transport ───────────────────────────────

/** A reply for one operation: a JSON body (status 200 unless given) or a thrown transport error. */
type Reply = { status?: number; body: unknown } | Error;

interface Wire {
  application: Reply;
  candidate: Reply;
  requests: Array<{ operation: string; method: string; url: string; body: Record<string, unknown> }>;
  clientEvents: AshbyLogRecord[];
}

function newWire(over: Partial<Pick<Wire, 'application' | 'candidate'>> = {}): Wire {
  return {
    application: { body: ok(documentedApplication({ primaryPhoneNumber: null })) },
    candidate: { body: ok(documentedCandidate()) },
    requests: [],
    clientEvents: [],
    ...over,
  };
}

function realClient(wire: Wire) {
  return createAshbyClient({
    apiKey: 'synthetic-test-key',
    maxAttempts: 1,
    sleep: async () => undefined,
    random: () => 0.5,
    logger: { event: (record) => { wire.clientEvents.push(record); } },
    transport: async (req: AshbyTransportRequest) => {
      const operation = req.url.endsWith('/candidate.info')
        ? 'candidate'
        : req.url.endsWith('/application.info') ? 'application' : 'unexpected';
      wire.requests.push({
        operation, method: req.method, url: req.url, body: JSON.parse(req.body) as Record<string, unknown>,
      });
      if (operation === 'unexpected') throw new Error('unexpected_operation');
      const reply = wire[operation];
      if (reply instanceof Error) throw reply;
      const status = reply.status ?? 200;
      return {
        status,
        ok: status >= 200 && status < 300,
        headers: { get: () => null },
        text: async () => JSON.stringify(reply.body),
      };
    },
  });
}

/** Fetch both documented responses through the REAL client and extract. */
async function profileFromWire(wire: Wire, readCandidate = true) {
  const client = realClient(wire);
  const app = await client.applicationInfo(APP_ID);
  const cand = readCandidate ? await client.candidateInfo(CAND_ID) : undefined;
  const profile = extractAshbyCandidateProfile(app.results, cand?.results);
  const phone = deriveAshbyProfilePhone({ primary: profile.primaryNumber, others: profile.otherNumbers });
  return { profile, phone, app, cand };
}

// ── The REAL profile handler over the real client ───────────────────────────

interface World {
  wire: Wire;
  link: WorkflowLinkRow;
  ingestion: { state: string; attempts: number } | null;
  applyCalls: AshbyCandidateProfileInput[];
  applyResult: AshbyCandidateProfileResult;
  outcomes: string[];
  binds: Array<{ linkId: string; handle: string }>;
  enqueued: Array<{ name: string; payload: unknown }>;
}

function newWorld(over: Partial<World> = {}): World {
  return {
    wire: newWire(),
    link: {
      id: LINK_ID, externalApplicationId: APP_ID, externalJobId: JOB_ID,
      externalResumeFileHandle: null, jobMappingId: 'map_1',
      candidateId: 'cand_local_1', sessionId: null, inviteId: null,
      lifecycle: 'imported', terminalState: null,
    },
    ingestion: null,
    applyCalls: [],
    applyResult: {
      status: 'eligible', engagementId: 'eng_1', profileOutcome: 'applied',
      numberApplied: true, identityApplied: true, intakeStamped: true,
    },
    outcomes: [],
    binds: [],
    enqueued: [],
    ...over,
  };
}

const MAPPING: ResolvedMapping = {
  id: 'map_1', status: 'enabled', aiScreeningStageId: STAGE_ID,
  deliveryMode: 'manual', screeningMode: 'phone_primary',
};

async function runProfile(w: World): Promise<{ error: unknown }> {
  const runtime = {
    runtimeConfig: {},
    client: realClient(w.wire),
    queue: {
      enqueue: async (name: string, payload: unknown) => {
        w.enqueued.push({ name, payload });
        return { id: `job_${w.enqueued.length}` };
      },
    },
    resolveMappingByJobId: async (jobId: string) => (jobId === JOB_ID ? MAPPING : null),
    stores: {
      readLink: async () => w.link,
      readIngestion: async () => w.ingestion,
      bindLinkResumeHandle: async (linkId: string, handle: string) => { w.binds.push({ linkId, handle }); },
      recordAshbyProfileOutcome: async (_linkId: string, outcome: string) => { w.outcomes.push(outcome); },
      applyAshbyCandidateProfile: async (input: AshbyCandidateProfileInput) => {
        w.applyCalls.push(input);
        return w.applyResult;
      },
      deferPhoneDialForQuestions: async () => ({ status: 'deferred' }),
    },
  } as never;
  const handler = buildAshbyHandlers(runtime, { phoneParsingEnabled: true })[ASHBY_PROFILE_QUEUE]!;
  const job = {
    id: 'job_contract', name: ASHBY_PROFILE_QUEUE, payload: { applicationLinkId: LINK_ID },
    attempts: 1, maxAttempts: 3, createdAt: new Date().toISOString(),
  } as never;
  // Silence the real logger's output; the raw calls are recorded by the mock.
  const out = vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    await handler(job);
    return { error: null };
  } catch (error) {
    return { error };
  } finally {
    out.mockRestore();
    warn.mockRestore();
    err.mockRestore();
  }
}

/** Every logger argument and client log record, plus the thrown error, as one text. */
function leakSurface(w: World, error: unknown): string {
  const parts = [
    JSON.stringify(loggerCalls.map((c) => c.args)),
    JSON.stringify(w.wire.clientEvents),
    JSON.stringify(w.enqueued),
  ];
  if (error instanceof Error) parts.push(error.message, String(error.stack), JSON.stringify(error));
  return parts.join('\n');
}

function expectNoContactLeak(w: World, error: unknown): void {
  const text = leakSurface(w, error);
  for (const fragment of PII_FRAGMENTS) expect(text, fragment).not.toContain(fragment);
}

const ORIGINAL_QUESTIONS = process.env.CANDIDATE_QUESTIONS_ENABLED;
beforeEach(() => {
  loggerCalls.length = 0;
  process.env.CANDIDATE_QUESTIONS_ENABLED = 'true';
});
afterEach(() => {
  if (ORIGINAL_QUESTIONS === undefined) delete process.env.CANDIDATE_QUESTIONS_ENABLED;
  else process.env.CANDIDATE_QUESTIONS_ENABLED = ORIGINAL_QUESTIONS;
});

// ═══════════════════════════════════════════════════════════════════════
// 1. The documented envelopes, through the real client
// ═══════════════════════════════════════════════════════════════════════

describe('documented envelopes reach the extractor intact', () => {
  it('the client unwraps `{ success, results }` and sends the documented request bodies', async () => {
    const wire = newWire();
    const { app, cand, profile, phone } = await profileFromWire(wire);
    expect(wire.requests).toEqual([
      { operation: 'application', method: 'POST', url: 'https://api.ashbyhq.com/application.info', body: { applicationId: APP_ID } },
      // candidate.info takes `id` on the wire, not `candidateId`.
      { operation: 'candidate', method: 'POST', url: 'https://api.ashbyhq.com/candidate.info', body: { id: CAND_ID } },
    ]);
    expect((app.results as Record<string, unknown>).id).toBe(APP_ID);
    expect((cand!.results as Record<string, unknown>).id).toBe(CAND_ID);
    expect(profile).toEqual({
      name: NAME, email: EMAIL, primaryNumber: PRIMARY_RAW, otherNumbers: [PRIMARY_RAW],
    });
    expect(phone).toEqual({ raw: PRIMARY_RAW, e164: PRIMARY_E164, verdict: 'dialable' });
  });

  it('application.status is read from the documented root for every documented value', async () => {
    for (const status of ['Active', 'Archived', 'Hired', 'Lead']) {
      const { app } = await profileFromWire(
        newWire({ application: { body: ok(documentedApplication({}, { status })) } }), false,
      );
      expect(extractAshbyApplicationStatus(app.results)).toBe(status);
    }
  });

  it('resumeFileHandle: a documented FileHandle is a resume; documented null is "no resume"', async () => {
    const withResume = documentedCandidate({
      resumeFileHandle: { id: FILE_ID, name: 'resume.pdf', handle: 'synthetic-file-handle-1' },
    });
    expect(extractResumeHandle(withResume)).toBe('synthetic-file-handle-1');
    expect(classifyResumePresence(withResume)).toBe('present');
    expect(classifyResumePresence(documentedCandidate())).toBe('absent');
    // As seen live: the key omitted entirely on a no-resume candidate.
    const omitted = documentedCandidate() as Record<string, unknown>;
    delete omitted.resumeFileHandle;
    expect(classifyResumePresence(omitted)).toBe('absent');
  });

  it('describeResumeShape names the shape with fixed codes and never a value', () => {
    const omitted = documentedCandidate() as Record<string, unknown>;
    delete omitted.resumeFileHandle;
    expect(describeResumeShape(omitted)).toBe('all_empty');
    expect(describeResumeShape(documentedCandidate())).toBe('all_empty');
    expect(describeResumeShape(documentedCandidate({ resumeFileHandle: {} }))).toBe('resumeFileHandle.object');
    expect(describeResumeShape(documentedCandidate({ resumeFileHandle: 'x\u0000' }))).toBe('resumeFileHandle.string');
    expect(describeResumeShape(documentedCandidate({ resumeFileHandle: [] }))).toBe('resumeFileHandle.array');
    expect(describeResumeShape({ name: 'Synthetic Person' })).toBe('no_id');
    expect(describeResumeShape(null)).toBe('not_object');
    expect(describeResumeShape('a string')).toBe('not_object');
  });
});

describe('which number is "the primary" in a documented candidate.info', () => {
  it('primary only in primaryPhoneNumber (empty list)', async () => {
    const { profile, phone } = await profileFromWire(newWire({
      candidate: { body: ok(documentedCandidate({ phoneNumbers: [] })) },
    }));
    expect(profile.primaryNumber).toBe(PRIMARY_RAW);
    expect(profile.otherNumbers).toEqual([]);
    expect(phone).toEqual({ raw: PRIMARY_RAW, e164: PRIMARY_E164, verdict: 'dialable' });
  });

  it('primary only via phoneNumbers[].isPrimary (primaryPhoneNumber null) — the flagged entry wins over array order', async () => {
    const { profile, phone } = await profileFromWire(newWire({
      candidate: { body: ok(documentedCandidate({
        primaryPhoneNumber: null,
        phoneNumbers: [contact(SECONDARY_RAW, 'Work', false), contact(PRIMARY_RAW, 'Personal', true)],
      })) },
    }));
    expect(profile.primaryNumber).toBeNull();
    expect(profile.otherNumbers).toEqual([PRIMARY_RAW, SECONDARY_RAW]);
    expect(phone).toEqual({ raw: PRIMARY_RAW, e164: PRIMARY_E164, verdict: 'dialable' });
  });

  it('both present and disagreeing: the primaryPhoneNumber field decides, the list flag does not', async () => {
    const { profile, phone } = await profileFromWire(newWire({
      candidate: { body: ok(documentedCandidate({
        primaryPhoneNumber: contact(PRIMARY_RAW, 'Personal', true),
        phoneNumbers: [contact(PRIMARY_RAW, 'Personal', false), contact(SECONDARY_RAW, 'Work', true)],
      })) },
    }));
    expect(profile.primaryNumber).toBe(PRIMARY_RAW);
    expect(profile.otherNumbers).toEqual([SECONDARY_RAW, PRIMARY_RAW]);
    expect(phone.e164).toBe(PRIMARY_E164);
    expect(phone.e164).not.toBe(SECONDARY_E164);
  });

  it('a failing primary is NOT replaced by a valid list entry', async () => {
    const { phone } = await profileFromWire(newWire({
      candidate: { body: ok(documentedCandidate({
        primaryPhoneNumber: contact('+1 415 555 0134', 'Personal', true),
        phoneNumbers: [contact('+1 415 555 0134'), contact(PRIMARY_RAW, 'Other', false)],
      })) },
    }));
    expect(phone).toEqual({ raw: '+1 415 555 0134', e164: null, verdict: 'invalid' });
  });

  it('candidate.info null primary and empty list fall back to the embedded application candidate', async () => {
    const { profile, phone } = await profileFromWire(newWire({
      application: { body: ok(documentedApplication()) },
      candidate: { body: ok(documentedCandidate({ primaryPhoneNumber: null, phoneNumbers: [] })) },
    }));
    expect(profile.primaryNumber).toBe(PRIMARY_RAW);
    expect(phone.verdict).toBe('dialable');
  });

  it('candidate embedded in application.info only (no candidate.info read)', async () => {
    const { profile, phone } = await profileFromWire(
      newWire({ application: { body: ok(documentedApplication()) } }), false,
    );
    // The embedded candidate has no lists, by the documented schema.
    expect(profile).toEqual({ name: NAME, email: EMAIL, primaryNumber: PRIMARY_RAW, otherNumbers: [] });
    expect(phone).toEqual({ raw: PRIMARY_RAW, e164: PRIMARY_E164, verdict: 'dialable' });
  });

  it('candidate.info and the embedded candidate disagree: candidate.info wins for phone AND email', async () => {
    const { profile, phone } = await profileFromWire(newWire({
      application: { body: ok(documentedApplication({
        primaryEmailAddress: contact(WORK_EMAIL, 'Work'),
        primaryPhoneNumber: contact(SECONDARY_RAW, 'Work'),
      })) },
      candidate: { body: ok(documentedCandidate()) },
    }));
    expect(profile.email).toBe(EMAIL);
    expect(profile.primaryNumber).toBe(PRIMARY_RAW);
    expect(phone.e164).toBe(PRIMARY_E164);
  });

  it('embedded candidate with its optional contact keys OMITTED (only id+name are required)', async () => {
    const app = documentedApplication();
    const embedded = app.candidate as Record<string, unknown>;
    delete embedded.primaryEmailAddress;
    delete embedded.primaryPhoneNumber;
    // Alone: the name reads, nothing else does, and nothing throws.
    const alone = await profileFromWire(newWire({ application: { body: ok(app) } }), false);
    expect(alone.profile).toEqual({ name: NAME, email: null, primaryNumber: null, otherNumbers: [] });
    expect(alone.phone.verdict).toBe('absent');
    // With candidate.info: everything comes from candidate.info.
    const both = await profileFromWire(newWire({ application: { body: ok(app) } }));
    expect(both.profile).toEqual({ name: NAME, email: EMAIL, primaryNumber: PRIMARY_RAW, otherNumbers: [PRIMARY_RAW] });
    expect(both.phone.e164).toBe(PRIMARY_E164);
  });

  it('the documented application.info example shape (primaryPhoneNumber null) yields no number on its own', async () => {
    const { profile, phone } = await profileFromWire(newWire(), false);
    expect(profile.primaryNumber).toBeNull();
    expect(phone).toEqual({ raw: null, e164: null, verdict: 'absent' });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. Common real-world spellings in the documented ContactInfo `value`
// ═══════════════════════════════════════════════════════════════════════

type Expected = { verdict: 'dialable' | 'invalid' | 'placeholder'; e164: string | null };
const FORMATS: Array<[string, Expected]> = [
  // The five common Indian spellings named for this contract.
  ['+91 98123 45670', { verdict: 'dialable', e164: PRIMARY_E164 }],
  ['+91-98123-45670', { verdict: 'dialable', e164: PRIMARY_E164 }],
  ['098123 45670', { verdict: 'dialable', e164: PRIMARY_E164 }],
  ['919812345670', { verdict: 'dialable', e164: PRIMARY_E164 }],
  ['9812345670', { verdict: 'dialable', e164: PRIMARY_E164 }],
  // Other spellings seen on Indian application forms.
  ['+91 098123 45670', { verdict: 'dialable', e164: PRIMARY_E164 }],
  ['+91(0)98123 45670', { verdict: 'dialable', e164: PRIMARY_E164 }],
  ['91-9812345670', { verdict: 'dialable', e164: PRIMARY_E164 }],
  ['+91 9812345670 (WhatsApp)', { verdict: 'dialable', e164: PRIMARY_E164 }],
  // Non-breaking spaces, as pasted from a document.
  ['+91\u00a098123\u00a045670', { verdict: 'dialable', e164: PRIMARY_E164 }],
  // Already E.164 (the most common value of all), and other everyday spellings.
  ['+919812345670', { verdict: 'dialable', e164: PRIMARY_E164 }],
  ['0091 98123 45670', { verdict: 'dialable', e164: PRIMARY_E164 }],
  ['(+91) 98123 45670', { verdict: 'dialable', e164: PRIMARY_E164 }],
  ['+91 98123-45670', { verdict: 'dialable', e164: PRIMARY_E164 }],
  ['98123-45670', { verdict: 'dialable', e164: PRIMARY_E164 }],
  ['+91 981 234 5670', { verdict: 'dialable', e164: PRIMARY_E164 }],
  ['+91.98123.45670', { verdict: 'dialable', e164: PRIMARY_E164 }],
  // Full-width digits ARE folded (unlike Devanagari below): pinned so the
  // asymmetry is visible.
  ['+91\uff19\uff18\uff11\uff12\uff13\uff14\uff15\uff16\uff17\uff10', { verdict: 'dialable', e164: PRIMARY_E164 }],
  // Wrong length.
  ['+91 98123 456701', { verdict: 'invalid', e164: null }],
  ['+91 98123', { verdict: 'invalid', e164: null }],
  // Two numbers in one field: refused, never one of the two.
  ['+91 98123 45670 / 98123 45671', { verdict: 'invalid', e164: null }],
  // Non-Indian primaries.
  ['+1 415 555 0134', { verdict: 'invalid', e164: null }],
  ['+971 50 123 4567', { verdict: 'invalid', e164: null }],
  ['+44 20 7946 0958', { verdict: 'invalid', e164: null }],
  // An Indian landline (area code 2-5).
  ['+91 22 2345 6789', { verdict: 'invalid', e164: null }],
  // KNOWN GAP (documented on STRICT_IN_MOBILE_E164): a landline whose area
  // code starts 7/8 (Bangalore 80) has a mobile's shape and passes the format
  // gate. Pinned so a fix is a deliberate test change.
  ['+91 80 2345 6789', { verdict: 'dialable', e164: '+918023456789' }],
  // Placeholders typed to get past a required field.
  ['+91 99999 99999', { verdict: 'placeholder', e164: null }],
  ['9876543210', { verdict: 'placeholder', e164: null }],
  ['+91 90000 00000', { verdict: 'placeholder', e164: null }],
  // Native-script (Devanagari) digits are not normalized: refused today.
  ['+91 ९८१२३ ४५६७०', { verdict: 'invalid', e164: null }],
];

describe('deriveAshbyProfilePhone on documented candidate.info values', () => {
  it.each(FORMATS)('%s → %o', async (value, expected) => {
    const { profile, phone } = await profileFromWire(newWire({
      candidate: { body: ok(documentedCandidate({
        primaryPhoneNumber: contact(value),
        phoneNumbers: [contact(value)],
      })) },
    }));
    expect(profile.primaryNumber).toBe(value);
    expect(phone.verdict).toBe(expected.verdict);
    expect(phone.e164).toBe(expected.e164);
    // raw is always what the candidate wrote; e164 is strict or null.
    expect(phone.raw).toBe(value);
    if (phone.e164 !== null) expect(STRICT_IN_MOBILE_E164.test(phone.e164)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. Name and email from the documented shapes
// ═══════════════════════════════════════════════════════════════════════

describe('name and email from documented envelopes', () => {
  async function nameAndEmail(candidateOver: Record<string, unknown>, embeddedOver: Record<string, unknown> = {}) {
    const { profile } = await profileFromWire(newWire({
      application: { body: ok(documentedApplication(embeddedOver)) },
      candidate: { body: ok(documentedCandidate(candidateOver)) },
    }));
    return { name: profile.name, email: profile.email };
  }

  it('name present', async () => {
    expect((await nameAndEmail({})).name).toBe(NAME);
  });

  it('name with an honorific is kept as written (the opener uses it verbatim)', async () => {
    expect((await nameAndEmail({ name: 'Dr. Test Person' })).name).toBe('Dr. Test Person');
    expect((await nameAndEmail({ name: 'Mr Test Person' })).name).toBe('Mr Test Person');
  });

  it('name whitespace-only on candidate.info falls back to the embedded name', async () => {
    expect((await nameAndEmail({ name: '   ' })).name).toBe(NAME);
  });

  it('name whitespace-only or missing everywhere is null', async () => {
    expect((await nameAndEmail({ name: '  ' }, { name: '\t' })).name).toBeNull();
    const app = documentedApplication();
    delete (app.candidate as Record<string, unknown>).name;
    const cand = documentedCandidate();
    delete cand.name;
    const { profile } = await profileFromWire(newWire({
      application: { body: ok(app) }, candidate: { body: ok(cand) },
    }));
    expect(profile.name).toBeNull();
  });

  it('email from primaryEmailAddress', async () => {
    expect((await nameAndEmail({})).email).toBe(EMAIL);
  });

  it('primaryEmailAddress beats a list entry flagged isPrimary when they disagree', async () => {
    const out = await nameAndEmail(
      {
        primaryEmailAddress: contact(EMAIL),
        emailAddresses: [contact(WORK_EMAIL, 'Work', true), contact(EMAIL, 'Personal', false)],
      },
      { primaryEmailAddress: null },
    );
    expect(out.email).toBe(EMAIL);
  });

  it('email from emailAddresses (isPrimary first) when primaryEmailAddress is null everywhere', async () => {
    const out = await nameAndEmail(
      {
        primaryEmailAddress: null,
        emailAddresses: [contact(WORK_EMAIL, 'Work', false), contact(EMAIL, 'Personal', true)],
      },
      { primaryEmailAddress: null },
    );
    expect(out.email).toBe(EMAIL);
  });

  it('email missing everywhere is null, and the name still reads', async () => {
    const out = await nameAndEmail({ primaryEmailAddress: null, emailAddresses: [] }, { primaryEmailAddress: null });
    expect(out).toEqual({ name: NAME, email: null });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. Error envelopes and thrown client errors
// ═══════════════════════════════════════════════════════════════════════

describe('the client on a failed read carries no contact data', () => {
  it('documented ErrorResponse (`success:false, errors[{message,parameter}]`) → AshbyError logical_failure', async () => {
    const wire = newWire({ candidate: { body: documentedError } });
    const client = realClient(wire);
    const error = await client.candidateInfo(CAND_ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AshbyError);
    expect((error as AshbyError).category).toBe('logical_failure');
    expect((error as AshbyError).message).toBe('ashby_logical_failure');
    // The documented ErrorDetail has no code, so nothing survives from it.
    expect((error as AshbyError).endpointCodes).toEqual([]);
    const text = `${(error as Error).message}\n${String((error as Error).stack)}\n${JSON.stringify(error)}`;
    for (const fragment of PII_FRAGMENTS) expect(text, fragment).not.toContain(fragment);
  });

  it('the older `errorInfo.code` shape keeps only the safe code', async () => {
    const wire = newWire({ candidate: { body: {
      success: false,
      errors: ['candidate_not_found'],
      errorInfo: { code: 'candidate_not_found', message: `No candidate ${EMAIL}` },
    } } });
    const error = await realClient(wire).candidateInfo(CAND_ID).catch((e: unknown) => e) as AshbyError;
    // Only safe codes survive (one per source field); every message is dropped.
    expect([...new Set(error.endpointCodes)]).toEqual(['candidate_not_found']);
    expect(JSON.stringify(error)).not.toContain('example.com');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. The REAL profile handler, end to end, on documented envelopes
// ═══════════════════════════════════════════════════════════════════════

describe('ashby.profile end to end over documented envelopes', () => {
  it('phone parsing: applyAshbyCandidateProfile gets the name, email, raw and E.164 number', async () => {
    // application.info exactly as the docs' example: embedded primaryPhoneNumber
    // null. The number only exists on candidate.info.
    const w = newWorld();
    const { error } = await runProfile(w);
    expect(error).toBeNull();
    expect(w.wire.requests.map((r) => [r.operation, r.body])).toEqual([
      ['application', { applicationId: APP_ID }],
      ['candidate', { id: CAND_ID }],
    ]);
    expect(w.applyCalls).toEqual([{
      applicationLinkId: LINK_ID,
      intake: 'phone_parsing',
      name: NAME,
      email: EMAIL,
      phoneRaw: PRIMARY_RAW,
      phoneE164: PRIMARY_E164,
      skipReason: null,
    }]);
    expect(w.outcomes).toEqual([]);
    expect(w.binds).toEqual([]);
    // Non-vacuous: the handler and the client both logged.
    expect(loggerCalls.length).toBeGreaterThan(0);
    expect(w.wire.clientEvents.map((e) => [e.operation, e.outcome])).toEqual([
      ['application.info', 'success'], ['candidate.info', 'success'],
    ]);
    expectNoContactLeak(w, error);
  });

  it.each(FORMATS)('handler: primary %s → the designed RPC input', async (value, expected) => {
    const w = newWorld();
    w.wire.candidate = { body: ok(documentedCandidate({
      primaryPhoneNumber: contact(value), phoneNumbers: [contact(value)],
    })) };
    const { error } = await runProfile(w);
    expect(error).toBeNull();
    const skipReason = expected.verdict === 'dialable' ? null
      : expected.verdict === 'placeholder' ? 'number_placeholder' : 'number_invalid';
    expect(w.applyCalls).toEqual([{
      applicationLinkId: LINK_ID, intake: 'phone_parsing', name: NAME, email: EMAIL,
      phoneRaw: value, phoneE164: expected.e164, skipReason,
    }]);
    expectNoContactLeak(w, error);
  });

  it('primary only via phoneNumbers[].isPrimary reaches the RPC', async () => {
    const w = newWorld();
    w.wire.candidate = { body: ok(documentedCandidate({
      primaryPhoneNumber: null,
      phoneNumbers: [contact(SECONDARY_RAW, 'Work', false), contact(PRIMARY_RAW, 'Personal', true)],
    })) };
    await runProfile(w);
    expect(w.applyCalls[0]).toMatchObject({ phoneRaw: PRIMARY_RAW, phoneE164: PRIMARY_E164, skipReason: null });
  });

  it('honorific name and missing email reach the RPC as designed', async () => {
    const w = newWorld();
    w.wire.candidate = { body: ok(documentedCandidate({
      name: 'Dr. Test Person', primaryEmailAddress: null, emailAddresses: [],
    })) };
    w.wire.application = { body: ok(documentedApplication({ primaryEmailAddress: null, primaryPhoneNumber: null })) };
    const { error } = await runProfile(w);
    expect(w.applyCalls[0]).toMatchObject({
      intake: 'phone_parsing', name: 'Dr. Test Person', email: null,
      phoneE164: PRIMARY_E164, skipReason: null,
    });
    expectNoContactLeak(w, error);
  });

  it('no usable name anywhere: `name_missing`, and the number is NOT sent', async () => {
    const w = newWorld();
    w.wire.candidate = { body: ok(documentedCandidate({ name: '   ' })) };
    w.wire.application = { body: ok(documentedApplication({ name: ' ', primaryPhoneNumber: null })) };
    await runProfile(w);
    expect(w.applyCalls).toEqual([{
      applicationLinkId: LINK_ID, intake: 'phone_parsing', name: null, email: EMAIL,
      phoneRaw: null, phoneE164: null, skipReason: 'name_missing',
    }]);
  });

  it('a documented FileHandle on candidate.info is a resume: bound and ingested, never phone parsing', async () => {
    const w = newWorld();
    w.wire.candidate = { body: ok(documentedCandidate({
      resumeFileHandle: { id: FILE_ID, name: 'resume.pdf', handle: 'synthetic-file-handle-1' },
    })) };
    await runProfile(w);
    expect(w.binds).toEqual([{ linkId: LINK_ID, handle: 'synthetic-file-handle-1' }]);
    expect(w.enqueued.map((e) => e.name)).toEqual([ASHBY_INGESTION_QUEUE]);
    expect(w.outcomes).toEqual(['resume_found']);
    expect(w.applyCalls).toEqual([]);
  });

  it('D3, candidate embedded in application.info only: no candidate.info read, number only', async () => {
    const w = newWorld({ ingestion: { state: 'ready', attempts: 0 } });
    w.link = { ...w.link, externalResumeFileHandle: 'synthetic-file-handle-1', intakeType: 'resume_parsing' };
    w.wire.application = { body: ok(documentedApplication()) };
    w.wire.candidate = new Error('candidate.info must not be read');
    w.applyResult = { ...w.applyResult, identityApplied: false, intakeStamped: false };
    const { error } = await runProfile(w);
    expect(error).toBeNull();
    expect(w.wire.requests.map((r) => r.operation)).toEqual(['application']);
    expect(w.applyCalls).toEqual([{
      applicationLinkId: LINK_ID, intake: 'resume_parsing',
      phoneRaw: PRIMARY_RAW, phoneE164: PRIMARY_E164, skipReason: null,
    }]);
    expectNoContactLeak(w, error);
  });

  describe('failed reads record `ashby_unavailable` and throw a fixed code', () => {
    const cases: Array<[string, (w: World) => void, string]> = [
      ['candidate.info documented ErrorResponse', (w) => { w.wire.candidate = { body: documentedError }; }, 'ashby_logical_failure'],
      // A read retries a network failure, so the budget (1 attempt here) ends as retry_exhausted.
      ['candidate.info transport throws', (w) => { w.wire.candidate = new Error(`socket reset ${EMAIL} ${PRIMARY_RAW}`); }, 'ashby_retry_exhausted'],
      ['candidate.info HTTP 500', (w) => { w.wire.candidate = { status: 500, body: documentedError }; }, 'ashby_retry_exhausted'],
      ['application.info documented ErrorResponse', (w) => { w.wire.application = { body: documentedError }; }, 'ashby_logical_failure'],
    ];

    it.each(cases)('%s', async (_label, arrange, message) => {
      const w = newWorld();
      arrange(w);
      const { error } = await runProfile(w);
      expect(error).toBeInstanceOf(AshbyError);
      expect((error as Error).message).toBe(message);
      expect(w.outcomes).toEqual(['ashby_unavailable']);
      expect(w.applyCalls).toEqual([]);
      expect(loggerCalls.length).toBeGreaterThan(0);
      expectNoContactLeak(w, error);
    });

    it('application.info failing means candidate.info is never requested', async () => {
      const w = newWorld();
      w.wire.application = { body: documentedError };
      await runProfile(w);
      expect(w.wire.requests.map((r) => r.operation)).toEqual(['application']);
    });
  });
});
