/**
 * phone-runtime-session-port.test.ts — the ONE function in `lib/phone-runtime/`
 * that writes to a table.
 *
 * ── WHY THIS FILE EXISTS ──────────────────────────────────────────────
 * `createPhoneSessionPort` provisions the `call_sessions` row that every phone
 * attempt is dialled against, and until this suite it had no test at all. The
 * proof that the gap was real: deleting the `transitionSession` call left all
 * 163 tests of the package green, while the shipped runtime would have handed
 * `dialPhoneAttempt` a session with NO `external_call_id`, placed the call to a
 * real person, and had `start_phone_assessment` refuse it
 * `session_binding_mismatch` — the candidate answers and the screening cannot
 * start. Every negative case below is therefore paired with a WRITE COUNTER,
 * because "returned null" is also what a port that minted a session and then
 * failed would report, and those are opposite operational facts.
 *
 * ── NO DATABASE, BY CONSTRUCTION ──────────────────────────────────────
 * The port takes `(reader, writer)`. Both are hand-written fakes here with
 * per-method call counters and recorded arguments; the real `createSession` /
 * `transitionSession` (and therefore the real Supabase client) are never
 * reached. `phoneRoomName` and `PHONE_SESSION_MODE` are imported from the
 * modules under test rather than restated, so a change to either derivation
 * moves the expectation with it instead of leaving a stale literal behind.
 *
 * ── THE THREE PATHS ───────────────────────────────────────────────────
 *   A. `existingSessionId` — VERIFIED, not trusted (finding M7).
 *   B. adoption — scoped to the asking ENGAGEMENT, not the candidate (H1).
 *   C. mint — and a half-provisioned session is worse than none.
 */

import { describe, expect, it } from 'vitest';
import {
  createPhoneSessionPort,
  type PhoneSessionWriter,
} from '../lib/phone-runtime/runtime.js';
import {
  PHONE_SESSION_MODE,
  RESUMABLE_SESSION_STATUSES,
  REUSABLE_SESSION_STATUSES,
  type PhoneRuntimeReader,
} from '../lib/phone-runtime/read.js';
import { phoneRoomName } from '../integrations/livekit-phone-dial/phone-room.js';
import { TERMINAL_STATES, type SessionRow } from '../lib/session-lifecycle.js';

// ═══════════════════════════════════════════════════════════════════════
// Fixtures
// ═══════════════════════════════════════════════════════════════════════

const ENGAGEMENT = 'engagement-asking-1';
const OTHER_ENGAGEMENT = 'engagement-other-2';
const CANDIDATE = 'candidate-1';
const ROLE = 'role-1';

const EXISTING_SESSION = 'session-existing-1';
const ADOPTED_SESSION = 'session-adopted-2';
const NEW_SESSION = 'session-minted-3';

type SessionReuse = { status: string; roomVerified: boolean } | null;

interface ReaderCalls {
  readSessionForReuse: string[];
  findReusableSession: string[];
  engagementOwningSession: string[];
  countLiveEngagements: string[];
}

/**
 * A reader whose three reuse reads answer from the fixture and whose OTHER
 * methods throw.
 *
 * The throw is deliberate. The port must not be reaching for due engagements,
 * phone numbers or consent — those belong to the due pass — and a fake that
 * answered them politely would let such a read slip in unnoticed.
 */
function fakeReader(over: {
  session?: SessionReuse;
  reusable?: string | null;
  owner?: string | null;
  /**
   * How many non-terminal engagements the candidate has. Defaults to 1 — the
   * ordinary case, in which adoption is unambiguous and therefore allowed.
   */
  liveEngagements?: number;
} = {}): { reader: PhoneRuntimeReader; calls: ReaderCalls } {
  const calls: ReaderCalls = {
    readSessionForReuse: [],
    findReusableSession: [],
    engagementOwningSession: [],
    countLiveEngagements: [],
  };
  const reader: PhoneRuntimeReader = {
    async listDueEngagements() {
      throw new Error('the session port must not read due engagements');
    },
    async listDialableNumbers() {
      throw new Error('the session port must not read phone numbers');
    },
    async readSessionForReuse(input) {
      calls.readSessionForReuse.push(input.sessionId);
      return over.session ?? null;
    },
    async countLiveEngagements(input) {
      calls.countLiveEngagements.push(input.candidateId);
      return over.liveEngagements ?? 1;
    },
    async findReusableSession(input) {
      calls.findReusableSession.push(input.candidateId);
      return over.reusable ?? null;
    },
    async engagementOwningSession(input) {
      calls.engagementOwningSession.push(input.sessionId);
      return over.owner ?? null;
    },
    consent: {
      async latestConsentRecord() {
        throw new Error('the session port must not read consent');
      },
      async activeConsentTemplate() {
        throw new Error('the session port must not read consent');
      },
    },
  };
  return { reader, calls };
}

type CreateResult = Awaited<ReturnType<PhoneSessionWriter['createSession']>>;
type CreateArgs = Parameters<PhoneSessionWriter['createSession']>[0];
type TransitionArgs = Parameters<PhoneSessionWriter['transitionSession']>;
type TransitionResult = Awaited<ReturnType<PhoneSessionWriter['transitionSession']>>;

interface WriterCalls {
  createSession: CreateArgs[];
  transitionSession: TransitionArgs[];
}

function sessionRow(id: string, over: Partial<SessionRow> = {}): SessionRow {
  return {
    id,
    status: 'created',
    terminal_reason: null,
    started_at: '2026-09-01T06:00:00.000Z',
    ended_at: null,
    waiting_at: null,
    candidate_id: CANDIDATE,
    role_id: ROLE,
    ...over,
  };
}

/**
 * The two writes, faked, with the arguments recorded verbatim.
 *
 * The recorded arguments — not just the counts — are what let the mint test
 * assert that the room name reached the CAS, which is the single fact whose
 * absence the reviewer's mutation exposed.
 */
function fakeWriter(over: {
  created?: CreateResult;
  moved?: TransitionResult;
} = {}): { writer: PhoneSessionWriter; calls: WriterCalls } {
  const calls: WriterCalls = { createSession: [], transitionSession: [] };
  const writer: PhoneSessionWriter = {
    async createSession(fields) {
      calls.createSession.push(fields);
      return over.created ?? { data: sessionRow(NEW_SESSION), error: null };
    },
    async transitionSession(...args: TransitionArgs) {
      calls.transitionSession.push(args);
      return over.moved ?? { ok: true };
    },
  };
  return { writer, calls };
}

function ensureInput(over: Partial<Parameters<
  ReturnType<typeof createPhoneSessionPort>['ensureSession']
>[0]> = {}) {
  return {
    engagementId: ENGAGEMENT,
    candidateId: CANDIDATE,
    roleId: ROLE as string | null,
    existingSessionId: null as string | null,
    ...over,
  };
}

/** No write of either kind happened. The control every negative case carries. */
function expectNoWrites(calls: WriterCalls): void {
  expect(calls.createSession).toHaveLength(0);
  expect(calls.transitionSession).toHaveLength(0);
}

// ═══════════════════════════════════════════════════════════════════════
// The status vocabularies themselves
// ═══════════════════════════════════════════════════════════════════════

describe('phone session port: the two status vocabularies are not the same set', () => {
  /**
   * WHY `in_progress` IS RESUMABLE HERE BUT NOT ADOPTABLE BELOW.
   *
   * The two lists answer different questions and the difference is
   * load-bearing:
   *
   *   * ADOPTION (`REUSABLE_SESSION_STATUSES`) picks up a session that NEVER
   *     STARTED — an orphan minted by an earlier due pass whose dial was not
   *     answered. `start_phone_assessment` has not run against it, nothing is
   *     bound to it, so `created`/`waiting` are the only safe states: adopting
   *     an `in_progress` session would drop a second SIP leg into a
   *     conversation that is already live.
   *   * THE RECONNECT PATH (`RESUMABLE_SESSION_STATUSES`) resumes the session
   *     `start_phone_assessment` ALREADY ACTIVATED for this very engagement —
   *     an engagement in `reconnecting` whose call dropped mid-conversation.
   *     That session is `in_progress` by definition, and refusing it would
   *     make every reconnect mint a second session and lose the transcript
   *     0042 keys to the room.
   *
   * Both still refuse a TERMINAL status, which is the case the unverified
   * path used to dial a real person for.
   */
  it('resumable is a strict superset of reusable, and `in_progress` is the difference', () => {
    const resumable = new Set<string>(RESUMABLE_SESSION_STATUSES);
    for (const s of REUSABLE_SESSION_STATUSES) {
      expect(resumable.has(s), s).toBe(true);
    }
    expect(resumable.has('in_progress')).toBe(true);
    expect(new Set<string>(REUSABLE_SESSION_STATUSES).has('in_progress')).toBe(false);
  });

  it('neither vocabulary admits a terminal status', () => {
    // Fail closed: an empty terminal set would make the table-driven refusal
    // suite below vacuous, so its non-emptiness is asserted here.
    expect(TERMINAL_STATES.size).toBeGreaterThan(0);
    for (const terminal of TERMINAL_STATES) {
      expect((RESUMABLE_SESSION_STATUSES as readonly string[]).includes(terminal), terminal)
        .toBe(false);
      expect((REUSABLE_SESSION_STATUSES as readonly string[]).includes(terminal), terminal)
        .toBe(false);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// A. The `existingSessionId` path — VERIFIED, not trusted (M7)
// ═══════════════════════════════════════════════════════════════════════

describe('phone session port: the session named on the engagement is verified', () => {
  for (const status of RESUMABLE_SESSION_STATUSES) {
    it(`returns the id for a \`${status}\` session whose room is verified`, async () => {
      const { reader, calls } = fakeReader({ session: { status, roomVerified: true } });
      const w = fakeWriter();
      const port = createPhoneSessionPort(reader, w.writer);

      const got = await port.ensureSession(
        ensureInput({ existingSessionId: EXISTING_SESSION }),
      );

      expect(got).toBe(EXISTING_SESSION);
      // The id was VERIFIED, not echoed: the read actually happened, and for
      // this session. Without this the assertion above would also pass against
      // a port that returned the column outright — which is exactly what M7
      // was.
      expect(calls.readSessionForReuse).toEqual([EXISTING_SESSION]);
      // A usable named session ends the decision. Adoption is not consulted
      // and nothing is minted.
      expect(calls.findReusableSession).toHaveLength(0);
      expectNoWrites(w.calls);
    });
  }

  for (const status of TERMINAL_STATES) {
    it(`refuses a \`${status}\` session and mints NOTHING`, async () => {
      // THE LOAD-BEARING CASE. The old code returned the id here. An
      // engagement in `reconnecting` whose session had gone terminal would be
      // handed that dead session, dialled, ANSWERED BY A REAL PERSON, and then
      // refused by `start_phone_assessment` with `session_not_active` — a call
      // that could never have gone anywhere, charged against a reconnect
      // budget that is spent at the grant.
      const { reader, calls } = fakeReader({ session: { status, roomVerified: true } });
      const w = fakeWriter();
      const port = createPhoneSessionPort(reader, w.writer);

      const got = await port.ensureSession(
        ensureInput({ existingSessionId: EXISTING_SESSION }),
      );

      expect(got).toBeNull();
      expect(got).not.toBe(EXISTING_SESSION);
      expect(calls.readSessionForReuse).toEqual([EXISTING_SESSION]);
      // CONTROL. A named-but-dead session must not silently become a NEW
      // conversation either: the engagement is skipped, not re-provisioned
      // behind the reconnect's back.
      expectNoWrites(w.calls);
    });
  }

  it('refuses a live-status session whose room name is not verified', async () => {
    // A session that does not carry `phone-<id>` cannot be bound by
    // `start_phone_assessment`, whatever its status says.
    const { reader } = fakeReader({ session: { status: 'waiting', roomVerified: false } });
    const w = fakeWriter();
    const port = createPhoneSessionPort(reader, w.writer);

    const got = await port.ensureSession(
      ensureInput({ existingSessionId: EXISTING_SESSION }),
    );

    expect(got).toBeNull();
    expectNoWrites(w.calls);
  });

  it('refuses when the named session does not exist at all', async () => {
    const { reader, calls } = fakeReader({ session: null });
    const w = fakeWriter();
    const port = createPhoneSessionPort(reader, w.writer);

    const got = await port.ensureSession(
      ensureInput({ existingSessionId: EXISTING_SESSION }),
    );

    expect(got).toBeNull();
    expect(calls.readSessionForReuse).toEqual([EXISTING_SESSION]);
    expectNoWrites(w.calls);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// B. Adoption — scoped to the asking ENGAGEMENT (H1)
// ═══════════════════════════════════════════════════════════════════════

describe('phone session port: adoption is scoped to the engagement that asked', () => {
  it('adopts an unowned reusable session without minting one', async () => {
    const { reader, calls } = fakeReader({ reusable: ADOPTED_SESSION, owner: null });
    const w = fakeWriter();
    const port = createPhoneSessionPort(reader, w.writer);

    const got = await port.ensureSession(ensureInput());

    expect(got).toBe(ADOPTED_SESSION);
    expect(calls.findReusableSession).toEqual([CANDIDATE]);
    expect(calls.engagementOwningSession).toEqual([ADOPTED_SESSION]);
    // The whole point of adoption: no orphan `call_sessions` row per due pass.
    expectNoWrites(w.calls);
  });

  it('adopts a session THIS engagement already owns', async () => {
    const { reader, calls } = fakeReader({ reusable: ADOPTED_SESSION, owner: ENGAGEMENT });
    const w = fakeWriter();
    const port = createPhoneSessionPort(reader, w.writer);

    const got = await port.ensureSession(ensureInput());

    expect(got).toBe(ADOPTED_SESSION);
    expect(calls.engagementOwningSession).toEqual([ADOPTED_SESSION]);
    expectNoWrites(w.calls);
  });

  it('REFUSES a session another engagement owns, and mints its own instead', async () => {
    // THE H1 GUARD. `call_sessions` carries no engagement column, so adoption
    // resolves by CANDIDATE — and a candidate is not unique per engagement:
    // `uq_phone_engagements_application` keys an engagement to an application
    // link and `idx_phone_engagements_candidate` is deliberately not unique,
    // so one person applying to two roles has two engagements with two
    // independent no-answer budgets. Adopting one session across both would
    // put two SIP legs in one room and bind one session to two engagements —
    // only one of which could ever complete.
    const { reader, calls } = fakeReader({
      reusable: ADOPTED_SESSION,
      owner: OTHER_ENGAGEMENT,
    });
    const w = fakeWriter();
    const port = createPhoneSessionPort(reader, w.writer);

    const got = await port.ensureSession(ensureInput());

    // Both halves, because either alone is satisfiable by a broken port: the
    // first by one that returns null and skips the engagement forever, the
    // second by one that mints AND returns the stolen id.
    expect(got).not.toBe(ADOPTED_SESSION);
    expect(got).toBe(NEW_SESSION);
    expect(calls.engagementOwningSession).toEqual([ADOPTED_SESSION]);
    expect(w.calls.createSession).toHaveLength(1);
  });

  it('mints when no reusable session exists, without asking who owns nothing', async () => {
    const { reader, calls } = fakeReader({ reusable: null });
    const w = fakeWriter();
    const port = createPhoneSessionPort(reader, w.writer);

    const got = await port.ensureSession(ensureInput());

    expect(got).toBe(NEW_SESSION);
    expect(calls.findReusableSession).toEqual([CANDIDATE]);
    expect(calls.engagementOwningSession).toHaveLength(0);
    expect(w.calls.createSession).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// C. The mint path — a half-provisioned session is worse than none
// ═══════════════════════════════════════════════════════════════════════

describe('phone session port: minting provisions the room in the same CAS', () => {
  it('returns the new id and moves `created` -> `waiting` carrying its room name', async () => {
    const { reader } = fakeReader({ reusable: null });
    const w = fakeWriter();
    const port = createPhoneSessionPort(reader, w.writer);

    const got = await port.ensureSession(ensureInput());

    expect(got).toBe(NEW_SESSION);
    expect(w.calls.transitionSession).toHaveLength(1);
    const [id, expected, next, reason, extra] = w.calls.transitionSession[0]!;
    expect(id).toBe(NEW_SESSION);
    expect(expected).toBe('created');
    expect(next).toBe('waiting');
    // Not a terminal move, so no terminal reason may be invented for it —
    // `transitionSession` would refuse `ERR_INVALID_REASON` for a
    // non-terminal target anyway.
    expect(reason).toBeUndefined();
    // Derived with the REAL `phoneRoomName`, never a literal: this exact
    // string is what `start_phone_assessment` recomputes and compares before
    // it will bind anything, so a change to the derivation must move the
    // expectation with it rather than leave a stale format behind.
    expect(extra).toEqual({ external_call_id: phoneRoomName(NEW_SESSION) });
    expect(extra?.external_call_id).toBe(`phone-${NEW_SESSION}`);
  });

  it('inserts with the PHONE mode and the livekit provider', async () => {
    const { reader } = fakeReader({ reusable: null });
    const w = fakeWriter();
    const port = createPhoneSessionPort(reader, w.writer);

    await port.ensureSession(ensureInput());

    expect(w.calls.createSession).toHaveLength(1);
    const fields = w.calls.createSession[0]!;
    // Imported, not restated. `PHONE_SESSION_MODE` is what the adoption read
    // filters `call_sessions` by, so a mint that used a different mode would
    // produce a session its own reader could never find again.
    expect(fields.mode).toBe(PHONE_SESSION_MODE);
    // The provider has no exported constant to import — it is a bare literal
    // at the mint site. Pinned here so the pairing is at least asserted
    // somewhere; see the note in the suite header.
    expect(fields.provider).toBe('livekit');
    expect(fields.candidate_id).toBe(CANDIDATE);
    expect(fields.role_id).toBe(ROLE);
  });

  it('passes a null role through rather than inventing one', async () => {
    const { reader } = fakeReader({ reusable: null });
    const w = fakeWriter();
    const port = createPhoneSessionPort(reader, w.writer);

    await port.ensureSession(ensureInput({ roleId: null }));

    expect(w.calls.createSession[0]!.role_id).toBeNull();
  });

  it('refuses when the insert errors, and attempts NO transition', async () => {
    const { reader } = fakeReader({ reusable: null });
    const w = fakeWriter({ created: { data: null, error: new Error('insert_failed') } });
    const port = createPhoneSessionPort(reader, w.writer);

    const got = await port.ensureSession(ensureInput());

    expect(got).toBeNull();
    expect(w.calls.createSession).toHaveLength(1);
    // Transitioning a session that was never inserted would burn a round trip
    // and, worse, make the failure look like a CAS conflict in the logs.
    expect(w.calls.transitionSession).toHaveLength(0);
  });

  it('refuses when the insert answers with no row at all', async () => {
    // `{ data: null, error: null }` is outside the declared union, which is
    // exactly why the port tests BOTH disjuncts: the value crossing this seam
    // comes from a PostgREST client at runtime, and a client that answered
    // neither would otherwise reach `created.data.id` on a null.
    const { reader } = fakeReader({ reusable: null });
    const w = fakeWriter({
      created: { data: null, error: null } as unknown as CreateResult,
    });
    const port = createPhoneSessionPort(reader, w.writer);

    const got = await port.ensureSession(ensureInput());

    expect(got).toBeNull();
    expect(w.calls.transitionSession).toHaveLength(0);
  });

  for (const moved of [
    { label: 'a CAS conflict', result: { ok: false, conflict: true } as TransitionResult },
    {
      label: 'a stable error code',
      result: { ok: false, conflict: false, code: 'ERR_INVALID_TRANSITION' } as TransitionResult,
    },
  ]) {
    it(`refuses the half-provisioned session when the CAS answers ${moved.label}`, async () => {
      // NULL, NOT THE ID. A session still in `created` and carrying no
      // `external_call_id` can never start an assessment: `dialPhoneAttempt`
      // would place a real call and `start_phone_assessment` would refuse it
      // `session_binding_mismatch`, so the person answers and the screening
      // cannot begin. Returning the id here is strictly worse than returning
      // nothing, because nothing merely skips the engagement until next pass.
      const { reader } = fakeReader({ reusable: null });
      const w = fakeWriter({ moved: moved.result });
      const port = createPhoneSessionPort(reader, w.writer);

      const got = await port.ensureSession(ensureInput());

      expect(got).toBeNull();
      expect(got).not.toBe(NEW_SESSION);
      // The attempt was genuinely made — this is a refusal AFTER the write,
      // not a port that skipped provisioning altogether.
      expect(w.calls.createSession).toHaveLength(1);
      expect(w.calls.transitionSession).toHaveLength(1);
    });
  }
});

// ════════════════════════════════════════════════════════════════════
//  The UNOWNED orphan — the half of H1 the ownership check cannot see
// ════════════════════════════════════════════════════════════════════

describe('a candidate with more than one live engagement adopts NOTHING', () => {
  // `engagementOwningSession` reads `phone_engagements.session_id`, which is
  // written only by `start_phone_assessment`. So it identifies a session some
  // engagement has BOUND — and the dangerous session is usually unbound:
  // engagement A is dialled, nobody answers, and A leaves an adoptable
  // `waiting` session that nothing owns. Engagement B, same candidate and a
  // different application, becomes due and adopts it. Two engagements, one
  // room, and whichever starts its assessment first binds the session so the
  // other never can. The ownership check is necessary and not sufficient.

  it('mints its own session even when a perfectly adoptable one exists', async () => {
    const { reader, calls } = fakeReader({
      reusable: 'S-ORPHAN',
      owner: null,          // nobody owns it — the ownership check would ALLOW this
      liveEngagements: 2,
    });
    const { writer, calls: writes } = fakeWriter();
    const port = createPhoneSessionPort(reader, writer);

    const id = await port.ensureSession({
      engagementId: 'E-SECOND',
      candidateId: 'C-TWO-APPS',
      roleId: 'R2',
      existingSessionId: null,
    });

    expect(id).not.toBe('S-ORPHAN');
    expect(writes.createSession.length).toBe(1);
    // The adoption reads are not even attempted once the count says two.
    expect(calls.findReusableSession).toEqual([]);
    expect(calls.engagementOwningSession).toEqual([]);
  });

  it('CONTROL — the SAME orphan IS adopted when the candidate has one engagement', async () => {
    // Without this the test above is satisfied by a port that never adopts.
    const { reader } = fakeReader({
      reusable: 'S-ORPHAN',
      owner: null,
      liveEngagements: 1,
    });
    const { writer, calls: writes } = fakeWriter();
    const port = createPhoneSessionPort(reader, writer);

    const id = await port.ensureSession({
      engagementId: 'E-ONLY',
      candidateId: 'C-ONE-APP',
      roleId: 'R1',
      existingSessionId: null,
    });

    expect(id).toBe('S-ORPHAN');
    expect(writes.createSession.length).toBe(0);
  });
});
