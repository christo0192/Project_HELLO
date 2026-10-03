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
  phoneSessionUnavailableMeta,
  type PhoneSessionUnavailable,
  type PhoneSessionWriter,
} from '../lib/phone-runtime/runtime.js';
import { createLogger } from '../lib/logger.js';
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

// UUID-shaped since M009 E1: the reason log line carries the engagement id,
// and only a UUID is ever spliced into it. Synthetic, not a real row.
const ENGAGEMENT = 'e1e1e1e1-0000-4000-8000-00000000a001';
const OTHER_ENGAGEMENT = 'e1e1e1e1-0000-4000-8000-00000000a002';
const CANDIDATE = 'candidate-1';
const ROLE = 'role-1';

const EXISTING_SESSION = 'session-existing-1';
const ADOPTED_SESSION = 'session-adopted-2';
const NEW_SESSION = 'session-minted-3';

type SessionReuse = { status: string; roomVerified: boolean } | null;

interface ReaderCalls {
  readSessionForReuse: string[];
  findReusableSession: string[];
  /** The engagement each candidate-adoption read was scoped to (M009 E1). */
  findReusableSessionEngagement: string[];
  findSessionForEngagement: string[];
  findUnprovisionedSessionForEngagement: string[];
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
  /** The session THIS engagement already owns (0107 `phone_engagement_id`). */
  ownSession?: string | null;
  /** THIS engagement's half-provisioned `created` session (M009 E1). */
  unprovisioned?: string | null;
} = {}): { reader: PhoneRuntimeReader; calls: ReaderCalls } {
  const calls: ReaderCalls = {
    readSessionForReuse: [],
    findReusableSession: [],
    findReusableSessionEngagement: [],
    findSessionForEngagement: [],
    findUnprovisionedSessionForEngagement: [],
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
    async findSessionForEngagement(input) {
      calls.findSessionForEngagement.push(input.engagementId);
      return over.ownSession ?? null;
    },
    async findUnprovisionedSessionForEngagement(input) {
      calls.findUnprovisionedSessionForEngagement.push(input.engagementId);
      return over.unprovisioned ?? null;
    },
    async findReusableSession(input) {
      calls.findReusableSession.push(input.candidateId);
      calls.findReusableSessionEngagement.push(input.engagementId);
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
  /**
   * Per-call answers for `transitionSession`, in issue order (M009 E1: the
   * port may now CAS, then cancel). Falls back to `moved`, then `ok`.
   */
  transitions?: readonly TransitionResult[];
} = {}): { writer: PhoneSessionWriter; calls: WriterCalls } {
  const calls: WriterCalls = { createSession: [], transitionSession: [] };
  const writer: PhoneSessionWriter = {
    async createSession(fields) {
      calls.createSession.push(fields);
      return over.created ?? { data: sessionRow(NEW_SESSION), error: null };
    },
    async transitionSession(...args: TransitionArgs) {
      const at = calls.transitionSession.length;
      calls.transitionSession.push(args);
      return over.transitions?.[at] ?? over.moved ?? { ok: true };
    },
  };
  return { writer, calls };
}

/** Records every `phone_session_unavailable` event the port emits. */
function fakeSink(): { sink: (e: PhoneSessionUnavailable) => void; events: PhoneSessionUnavailable[] } {
  const events: PhoneSessionUnavailable[] = [];
  return { sink: (e) => { events.push(e); }, events };
}

const CAS_CONFLICT = { ok: false, conflict: true } as TransitionResult;

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

  // ── THE REDIAL WEDGE (0107 + 0108) ────────────────────────────────
  // 0107 put a partial UNIQUE index on `call_sessions.phone_engagement_id`
  // and `ensureSession` stamps it on every mint. A candidate with two live
  // engagements deliberately skips candidate-adoption (two SIP legs in one
  // room is the thing that must never happen), so this engagement's SECOND
  // pre-consent dial re-inserted the same engagement id, hit the unique
  // constraint, and `ensureSession` returned null — the due loop then skipped
  // the engagement with `no_session`, silently, on every subsequent pass.
  //
  // Adoption by the engagement column is exact, so it is safe even with
  // several live engagements, and it is what the new column was always for.
  it('re-dials with the session THIS engagement already owns, even with two live engagements', async () => {
    const { reader, calls } = fakeReader({
      ownSession: ADOPTED_SESSION,
      liveEngagements: 2,
      // Deliberately present, and deliberately not what we expect back: if
      // the port fell through to candidate-adoption it would return this.
      reusable: 'session-some-other-3',
    });
    const w = fakeWriter();
    const port = createPhoneSessionPort(reader, w.writer);

    const got = await port.ensureSession(ensureInput());

    expect(got).toBe(ADOPTED_SESSION);
    expect(calls.findSessionForEngagement).toEqual([ENGAGEMENT]);
    // No mint, so no second row carrying this engagement id — which is the
    // insert the unique index refuses.
    expect(w.calls.createSession).toHaveLength(0);
    // And no candidate-scoped adoption was even consulted.
    expect(calls.findReusableSession).toHaveLength(0);
  });

  it('still mints when this engagement owns nothing yet', async () => {
    const { reader, calls } = fakeReader({ ownSession: null, reusable: null });
    const w = fakeWriter();
    const port = createPhoneSessionPort(reader, w.writer);

    const got = await port.ensureSession(ensureInput());

    expect(got).toBe(NEW_SESSION);
    expect(calls.findSessionForEngagement).toEqual([ENGAGEMENT]);
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
    expect(fields.phone_engagement_id).toBe(ENGAGEMENT);
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
      // not a port that skipped provisioning altogether. Since M009 E1 the
      // port then tries to CANCEL the half-provisioned row (second call), so
      // it cannot hold the engagement's live slot.
      expect(w.calls.createSession).toHaveLength(1);
      expect(w.calls.transitionSession).toHaveLength(2);
      expect(w.calls.transitionSession[1]!.slice(0, 4))
        .toEqual([NEW_SESSION, 'created', 'cancelled', 'duplicate_session']);
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

// ════════════════════════════════════════════════════════════════════
//  M009 E1 — the live-only engagement index, and every null explained
// ════════════════════════════════════════════════════════════════════

describe('M009 E1: own session recovery, reason-coded nulls, no sibling adoption', () => {
  // 0112 narrowed `uq_call_sessions_phone_engagement` to LIVE sessions. The
  // port's half of the fix: a terminal own session no longer blocks a mint
  // (the index is what stopped it, and the port must not stop it either), a
  // half-provisioned own `created` row is finished or cancelled rather than
  // left to wedge the engagement, and every `null` says why in one line.

  it('own session terminal, two live engagements: exactly one create, claimed by THIS engagement', async () => {
    // `findSessionForEngagement` answers null for a terminal own session (it
    // filters `created`/`waiting`), and two live engagements skip candidate
    // adoption — so the only road left is the mint, and it must be taken.
    const { reader, calls } = fakeReader({
      ownSession: null,
      unprovisioned: null,
      liveEngagements: 2,
      reusable: 'session-must-not-be-adopted',
    });
    const w = fakeWriter();
    const s = fakeSink();
    const port = createPhoneSessionPort(reader, w.writer, s.sink);

    const got = await port.ensureSession(ensureInput());

    expect(got).toBe(NEW_SESSION);
    expect(w.calls.createSession).toHaveLength(1);
    expect(w.calls.createSession[0]!.phone_engagement_id).toBe(ENGAGEMENT);
    expect(calls.findUnprovisionedSessionForEngagement).toEqual([ENGAGEMENT]);
    expect(calls.findReusableSession).toHaveLength(0);
    expect(s.events).toEqual([]);
  });

  it('own `created` session unprovisioned: CAS to `waiting` with its room, id returned, ZERO creates', async () => {
    const STALE = 'session-own-created-4';
    const { reader, calls } = fakeReader({ ownSession: null, unprovisioned: STALE });
    const w = fakeWriter();
    const s = fakeSink();
    const port = createPhoneSessionPort(reader, w.writer, s.sink);

    const got = await port.ensureSession(ensureInput());

    expect(got).toBe(STALE);
    expect(calls.findUnprovisionedSessionForEngagement).toEqual([ENGAGEMENT]);
    expect(w.calls.createSession).toHaveLength(0);
    expect(w.calls.transitionSession).toHaveLength(1);
    const [id, from, to, reason, extra] = w.calls.transitionSession[0]!;
    expect([id, from, to, reason]).toEqual([STALE, 'created', 'waiting', undefined]);
    expect(extra).toEqual({ external_call_id: phoneRoomName(STALE) });
    // Recovery short-circuits adoption entirely.
    expect(calls.countLiveEngagements).toHaveLength(0);
    expect(calls.findReusableSession).toHaveLength(0);
    expect(s.events).toEqual([]);
  });

  it('own `created` CAS fails: the row is cancelled, then exactly one create runs', async () => {
    const STALE = 'session-own-created-5';
    const { reader } = fakeReader({ ownSession: null, unprovisioned: STALE, reusable: null });
    const w = fakeWriter({ transitions: [CAS_CONFLICT, { ok: true }, { ok: true }] });
    const s = fakeSink();
    const port = createPhoneSessionPort(reader, w.writer, s.sink);

    const got = await port.ensureSession(ensureInput());

    expect(got).toBe(NEW_SESSION);
    expect(w.calls.transitionSession.map((a) => a.slice(0, 4))).toEqual([
      [STALE, 'created', 'waiting', undefined],
      [STALE, 'created', 'cancelled', 'duplicate_session'],
      [NEW_SESSION, 'created', 'waiting', undefined],
    ]);
    expect(w.calls.createSession).toHaveLength(1);
    expect(w.calls.createSession[0]!.phone_engagement_id).toBe(ENGAGEMENT);
    expect(s.events).toEqual([]);
  });

  it('own `created` CAS AND cancel both fail: null, no create, provision_cas_failed', async () => {
    // The row may still hold the live slot, so a mint would only 23505.
    const STALE = 'session-own-created-6';
    const { reader } = fakeReader({ ownSession: null, unprovisioned: STALE });
    const w = fakeWriter({ transitions: [CAS_CONFLICT, CAS_CONFLICT] });
    const s = fakeSink();
    const port = createPhoneSessionPort(reader, w.writer, s.sink);

    const got = await port.ensureSession(ensureInput());

    expect(got).toBeNull();
    expect(w.calls.createSession).toHaveLength(0);
    expect(w.calls.transitionSession).toHaveLength(2);
    expect(s.events).toEqual([{ reason: 'provision_cas_failed', engagementId: ENGAGEMENT }]);
  });

  it('CAS after a FRESH create fails: cancel attempted, null, provision_cas_failed logged once', async () => {
    const { reader } = fakeReader({ reusable: null });
    const w = fakeWriter({ transitions: [CAS_CONFLICT, { ok: true }] });
    const s = fakeSink();
    const port = createPhoneSessionPort(reader, w.writer, s.sink);

    const got = await port.ensureSession(ensureInput());

    expect(got).toBeNull();
    expect(w.calls.createSession).toHaveLength(1);
    expect(w.calls.transitionSession.map((a) => a.slice(0, 4))).toEqual([
      [NEW_SESSION, 'created', 'waiting', undefined],
      [NEW_SESSION, 'created', 'cancelled', 'duplicate_session'],
    ]);
    expect(s.events).toEqual([{ reason: 'provision_cas_failed', engagementId: ENGAGEMENT }]);
  });

  it('createSession fails 23505: null, no transition, insert_failed carries the SQLSTATE', async () => {
    const { reader } = fakeReader({ reusable: null });
    const err = Object.assign(new Error('ERR_INSERT_FAILED'), { pgCode: '23505' });
    const w = fakeWriter({ created: { data: null, error: err } });
    const s = fakeSink();
    const port = createPhoneSessionPort(reader, w.writer, s.sink);

    const got = await port.ensureSession(ensureInput());

    expect(got).toBeNull();
    expect(w.calls.transitionSession).toHaveLength(0);
    expect(s.events).toEqual([
      { reason: 'insert_failed', engagementId: ENGAGEMENT, pgCode: '23505' },
    ]);
  });

  it('createSession fails with no SQLSTATE: insert_failed with no pgCode at all', async () => {
    const { reader } = fakeReader({ reusable: null });
    const w = fakeWriter({ created: { data: null, error: new Error('ERR_INSERT_FAILED') } });
    const s = fakeSink();
    const port = createPhoneSessionPort(reader, w.writer, s.sink);

    expect(await port.ensureSession(ensureInput())).toBeNull();
    expect(s.events).toEqual([{ reason: 'insert_failed', engagementId: ENGAGEMENT }]);
  });

  it('an existing `in_progress` session is reused (reconnect, unchanged) and logs nothing', async () => {
    const { reader, calls } = fakeReader({
      session: { status: 'in_progress', roomVerified: true },
    });
    const w = fakeWriter();
    const s = fakeSink();
    const port = createPhoneSessionPort(reader, w.writer, s.sink);

    const got = await port.ensureSession(ensureInput({ existingSessionId: EXISTING_SESSION }));

    expect(got).toBe(EXISTING_SESSION);
    expect(calls.findUnprovisionedSessionForEngagement).toHaveLength(0);
    expectNoWrites(w.calls);
    expect(s.events).toEqual([]);
  });

  for (const status of TERMINAL_STATES) {
    it(`an existing \`${status}\` session: null, ZERO creates, existing_terminal logged`, async () => {
      const { reader, calls } = fakeReader({ session: { status, roomVerified: true } });
      const w = fakeWriter();
      const s = fakeSink();
      const port = createPhoneSessionPort(reader, w.writer, s.sink);

      const got = await port.ensureSession(ensureInput({ existingSessionId: EXISTING_SESSION }));

      expect(got).toBeNull();
      expectNoWrites(w.calls);
      // The recovery path is for PRE-consent engagements only; a bound dead
      // session is E3/E4's to resolve, so it is never even consulted.
      expect(calls.findUnprovisionedSessionForEngagement).toHaveLength(0);
      expect(s.events).toEqual([{ reason: 'existing_terminal', engagementId: ENGAGEMENT }]);
    });
  }

  it('an existing session that no longer exists also logs existing_terminal', async () => {
    const { reader } = fakeReader({ session: null });
    const w = fakeWriter();
    const s = fakeSink();
    const port = createPhoneSessionPort(reader, w.writer, s.sink);

    expect(await port.ensureSession(ensureInput({ existingSessionId: EXISTING_SESSION })))
      .toBeNull();
    expectNoWrites(w.calls);
    expect(s.events).toEqual([{ reason: 'existing_terminal', engagementId: ENGAGEMENT }]);
  });

  it('an existing live session with an unverified room logs existing_room_unverified', async () => {
    const { reader } = fakeReader({ session: { status: 'waiting', roomVerified: false } });
    const w = fakeWriter();
    const s = fakeSink();
    const port = createPhoneSessionPort(reader, w.writer, s.sink);

    expect(await port.ensureSession(ensureInput({ existingSessionId: EXISTING_SESSION })))
      .toBeNull();
    expectNoWrites(w.calls);
    expect(s.events).toEqual([{ reason: 'existing_room_unverified', engagementId: ENGAGEMENT }]);
  });

  it('candidate adoption is scoped to the asking engagement', async () => {
    // The reader turns this into the `phone_engagement_id` null-or-self
    // filter (see phone-runtime-read.test.ts); the port's job is to pass it.
    const { reader, calls } = fakeReader({ reusable: ADOPTED_SESSION, owner: null });
    const w = fakeWriter();
    const port = createPhoneSessionPort(reader, w.writer, fakeSink().sink);

    expect(await port.ensureSession(ensureInput())).toBe(ADOPTED_SESSION);
    expect(calls.findReusableSessionEngagement).toEqual([ENGAGEMENT]);
  });

  it('a throwing sink cannot change the decision', async () => {
    const { reader } = fakeReader({ session: { status: 'expired', roomVerified: true } });
    const w = fakeWriter();
    const port = createPhoneSessionPort(reader, w.writer, () => {
      throw new Error('sink_down');
    });

    await expect(port.ensureSession(ensureInput({ existingSessionId: EXISTING_SESSION })))
      .resolves.toBeNull();
    expectNoWrites(w.calls);
  });

  it('a reader without the recovery method (a due-pass double) still mints as before', async () => {
    const { reader } = fakeReader({ reusable: null });
    const bare: typeof reader = { ...reader, findUnprovisionedSessionForEngagement: undefined };
    const w = fakeWriter();
    const port = createPhoneSessionPort(bare, w.writer, fakeSink().sink);

    expect(await port.ensureSession(ensureInput())).toBe(NEW_SESSION);
    expect(w.calls.createSession).toHaveLength(1);
  });
});

describe('M009 E1: the phone_session_unavailable log line survives the logger allowlist', () => {
  function emitted(event: PhoneSessionUnavailable): Record<string, unknown> {
    const lines: string[] = [];
    const logger = createLogger('phone-runtime', {
      writer: (line) => { lines.push(line); },
      clock: () => '2026-10-03T00:00:00.000Z',
      correlationIdGetter: () => null,
    });
    logger.info('unknown_event', phoneSessionUnavailableMeta(event));
    expect(lines).toHaveLength(1);
    return JSON.parse(lines[0]!) as Record<string, unknown>;
  }

  it('reason, engagement uuid and SQLSTATE all reach the emitted line', () => {
    const line = emitted({ reason: 'insert_failed', engagementId: ENGAGEMENT, pgCode: '23505' });
    expect(line.error_type).toBe('phone_session_unavailable:insert_failed');
    expect(line.error_category).toBe(`e.${ENGAGEMENT}:pg.23505`);
  });

  // Every reason with the LONGEST possible payload: a field over the logger's
  // 64-character SAFE_IDENT bound is dropped whole, silently, so the bound is
  // asserted through the real logger rather than by arithmetic in a comment.
  for (const reason of [
    'existing_terminal',
    'existing_room_unverified',
    'insert_failed',
    'provision_cas_failed',
  ] as const) {
    it(`\`${reason}\` with an engagement id and a SQLSTATE survives the logger intact`, () => {
      const line = emitted({ reason, engagementId: ENGAGEMENT, pgCode: '23505' });
      expect(line.error_type).toBe(`phone_session_unavailable:${reason}`);
      expect(line.error_category).toBe(`e.${ENGAGEMENT}:pg.23505`);
    });
  }

  it('a non-UUID engagement id and a non-SQLSTATE code are left out, never spliced in', () => {
    const meta = phoneSessionUnavailableMeta({
      reason: 'insert_failed',
      engagementId: 'not,a.uuid',
      pgCode: 'PGRST116',
    });
    expect(meta).toEqual({ error_type: 'phone_session_unavailable:insert_failed' });
  });

  it('an id with a ten-digit run is dropped so the logger guard cannot eat the SQLSTATE', () => {
    const digits = 'e1e1e1e1-0000-4000-8000-123456789012';
    const line = emitted({ reason: 'insert_failed', engagementId: digits, pgCode: '23505' });
    expect(line.error_type).toBe('phone_session_unavailable:insert_failed');
    expect(line.error_category).toBe('pg.23505');
  });
});
