/**
 * lib/phone-runtime/read.ts — the two reads the runtime needs and nothing
 * else: which engagements are due, and the number to dial one with.
 *
 * ── WHY THE NUMBER IS READ HERE AND NOWHERE ELSE IN THIS PACKAGE ──────
 * Stated precisely, because an earlier draft of this comment overclaimed and
 * a reviewer caught it: this is the only reader of `phone_e164` IN THE PHONE
 * RUNTIME, and the only place in the codebase that turns the column into a
 * dialable value. It is NOT the only read of the column in the repository —
 * `routes/candidates.ts` selects it on a `requireRole('viewer')` route and
 * redacts it for non-admins via `redactCandidatePhone`. That is a projection
 * for a human reader, not a dial, and it predates this phase.
 *
 * What IS true and load-bearing: the value never crosses a process boundary
 * on the CALLING path. Admission reads it inside `admit_phone_attempt`,
 * digests it, and compares the digest against the suppression list.
 * `lib/phone-screening/read-stores.ts` forbids the column outright, and a
 * structural test enumerates it among nineteen others that may not appear in
 * any declared column list.
 *
 * But `dialPhoneAttempt` needs a `DialableNumber`, and only a process can hold
 * one. So this phase must introduce exactly one reader, and the whole cost of
 * that decision is concentrated here:
 *
 *   * The raw string is wrapped by `wrapDialableNumber` IN THE SAME
 *     EXPRESSION that reads it. No local, no field and no return value ever
 *     holds the bare string, so there is nothing for a later edit to log.
 *   * A number that does not wrap is DROPPED and counted, never returned and
 *     never named. `admit_phone_attempt` would refuse it `phone_invalid`
 *     anyway; refusing earlier saves a round trip and, more importantly, means
 *     an unusable value is never carried further than the row it came from.
 *   * `phone-runtime-structural.test.ts` asserts that `phone_e164` appears in
 *     THIS FILE ONLY, and that no file in this package contains a logger, a
 *     console call, or an interpolated error.
 *
 * ── EVERY QUERY IS BOUNDED AND COLUMN-EXPLICIT ────────────────────────
 * No `select('*')`, an explicit `.limit()` on every read, and an empty id list
 * performs NO query at all — PostgREST answers `in.()` with every row, which
 * is the failure mode that turns a bounded read into a table scan.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  wrapDialableNumber,
  type DialableNumber,
} from '../../integrations/livekit-phone-dial/dialable-number.js';
import { phoneRoomName } from '../../integrations/livekit-phone-dial/phone-room.js';
import type { ConsentReader } from '../phone-screening/index.js';

/**
 * The engagement states a due sweep may act on. `dialing` and `in_call` are
 * absent deliberately: a live conversation is not due for another one, and the
 * one-live index would refuse it anyway.
 */
export const PHONE_DUE_STATES = ['eligible', 'reconnecting', 'scheduled'] as const;

export type PhoneDueState = (typeof PHONE_DUE_STATES)[number];

/** Explicit column lists. Never `*`, and never a column this file does not use. */
const DUE_ENGAGEMENT_COLUMNS =
  'id,state,candidate_id,role_id,session_id,next_eligible_at,no_answer_attempts,updated_at';

/**
 * The candidate read is TWO columns and both are about dialability. `name`,
 * `email` and `parsed` are absent because the runtime has no use for them and
 * a column list is the cheapest place to prove that.
 */
const DIALABLE_CANDIDATE_COLUMNS = 'id,phone_e164,phone_valid';

/** `mode` for a telephony session. The browser path uses `browser`. */
export const PHONE_SESSION_MODE = 'live';

/**
 * The two non-terminal states a phone session may be adopted from. `created`
 * is included because a session that was minted and never advanced is exactly
 * the orphan this adoption exists to stop accumulating.
 */
export const REUSABLE_SESSION_STATUSES = ['created', 'waiting'] as const;

const REUSABLE_SESSION_COLUMNS = 'id,status,external_call_id,started_at';

/** One column, because the only question is WHICH engagement, if any. */
const OWNING_ENGAGEMENT_COLUMNS = 'id';

/**
 * Statuses in which a session NAMED ON THE ENGAGEMENT may still be reused.
 *
 * Wider than `REUSABLE_SESSION_STATUSES` on purpose, and the difference is
 * load-bearing. Adoption picks up a session that has never started, so it
 * accepts only `created`/`waiting`. A reconnect resumes a session that
 * `start_phone_assessment` already activated, so it must also accept
 * `in_progress` — while still refusing a terminal one, which is exactly the
 * case the old unchecked path would have dialled a real person for.
 */
export const RESUMABLE_SESSION_STATUSES = ['created', 'waiting', 'in_progress'] as const;

/**
 * Consent columns. `ip_address` and `user_agent` are absent deliberately: the
 * preflight decides on status, expiry and the consent set, and a column list
 * is the cheapest place to prove nothing else was fetched.
 */
const CONSENT_RECORD_COLUMNS = 'status,consents,expires_at,created_at,id';
const CONSENT_TEMPLATE_COLUMNS = 'required_consents,updated_at,id';

/** Hard ceiling on any single read, whatever a caller asks for. */
export const PHONE_RUNTIME_MAX_ROWS = 200;

export function boundedRowLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit < 1) return 1;
  return Math.min(PHONE_RUNTIME_MAX_ROWS, Math.floor(limit));
}

export interface DuePhoneEngagement {
  readonly engagementId: string;
  readonly state: PhoneDueState;
  readonly candidateId: string;
  readonly roleId: string | null;
  /** Already bound by a previous leg, or null when this is a new conversation. */
  readonly sessionId: string | null;
  readonly nextEligibleAt: string | null;
  readonly noAnswerAttempts: number;
  readonly updatedAt: string | null;
}

export interface PhoneRuntimeReader {
  /**
   * Engagements in a due state, RECONNECTS FIRST and then oldest-eligible,
   * bounded, de-duplicated by engagement id.
   *
   * The reconnect priority is not cosmetic — see the implementation. It is
   * served by a second bounded read rather than by a cleverer ORDER BY,
   * because `updated_at asc` is right for the no-answer ladder and exactly
   * wrong for a reconnect, and one clause cannot be both.
   *
   * This read decides only CANDIDACY. Whether any of them may actually be
   * dialled is decided by `admit_phone_attempt` under the advisory lock, which
   * re-checks the halt switch, the IST window, consent, suppression, the
   * per-IST-day index, the fleet cap and the number. Nothing here duplicates
   * any of that; a second copy of a gate is how the two come to disagree.
   */
  listDueEngagements(input: {
    nowIso: string;
    limit: number;
    /**
     * The reconnect backoff, so the RECONNECT batch can be clock-filtered in
     * SQL. It has to be here rather than derived: a reconnect's due time is
     * `updated_at + backoff`, `next_eligible_at` does not carry it, and the
     * batch is bounded before any JS filter runs — so a filter applied after
     * the read cannot stop not-yet-due reconnects consuming every slot.
     */
    reconnectBackoffSeconds: number;
  }): Promise<readonly DuePhoneEngagement[]>;

  /**
   * Dialable numbers for the given candidates, as opaque wrapped values.
   *
   * Returns a map keyed by candidate id. A candidate whose number is absent,
   * invalid or unwrappable is simply not in the map — the caller then has no
   * number to dial with, which is the correct outcome and the only one that
   * does not require the bad value to travel.
   */
  listDialableNumbers(input: {
    candidateIds: readonly string[];
  }): Promise<ReadonlyMap<string, DialableNumber>>;

  /**
   * The newest REUSABLE phone session for a candidate, or null.
   *
   * Without this the runtime would mint a fresh `call_sessions` row on every
   * due pass for any engagement that has not yet reached `in_call` — because
   * `phone_engagements.session_id` is written only by `start_phone_assessment`
   * (P4b), and that requires the disclosure to have been delivered. An
   * engagement that is dialled and not answered would therefore leave one
   * orphan session per attempt, forever, and P5 must not add a second writer
   * to that column just to tidy up after itself.
   *
   * So a non-terminal phone session for the same candidate is ADOPTED instead.
   * That is also the correct behaviour on its own terms: 0042 keys the room by
   * session precisely so every attempt of one conversation shares a transcript.
   */
  findReusableSession(input: { candidateId: string }): Promise<string | null>;

  /**
   * The engagement that already claims this session, or null.
   *
   * `phone_engagements.session_id` is written only by `start_phone_assessment`,
   * so this answers "has some engagement already bound its conversation to
   * this session?". Adoption consults it because `call_sessions` carries no
   * engagement column, and a candidate can legitimately have MORE THAN ONE
   * engagement: `uq_phone_engagements_application` keys an engagement to an
   * application link, and `idx_phone_engagements_candidate` is deliberately
   * NOT unique. Every 0042 budget and both uniqueness indexes are scoped by
   * engagement, so two engagements of one person are two independent budgets
   * — and adopting one session across both would put two SIP legs in one room
   * and bind one session to two engagements.
   */
  engagementOwningSession(input: { sessionId: string }): Promise<string | null>;

  /**
   * How many NON-TERMINAL phone engagements this candidate has, capped at 2.
   *
   * Capped because the only question is "more than one?" and an exact count
   * of a set we will not enumerate is a read we do not need.
   *
   * This exists because `engagementOwningSession` is necessary but not
   * sufficient. `phone_engagements.session_id` is written only by
   * `start_phone_assessment`, so it identifies a session some engagement has
   * BOUND — and the dangerous session is usually UNBOUND. Engagement A is
   * dialled, nobody answers, and A leaves an adoptable `waiting` session that
   * nothing owns; engagement B, same candidate and a different application,
   * becomes due and adopts it. Two engagements, one room, and whichever
   * starts its assessment first binds the session so the other never can.
   *
   * So adoption is allowed only where it is unambiguous: a candidate with a
   * single live engagement. With two, every engagement mints its own session,
   * which costs an extra row and is the safe direction.
   */
  countLiveEngagements(input: { candidateId: string }): Promise<number>;

  /**
   * The reuse-relevant facts about a session already named on an engagement:
   * its status, and whether it carries its own derived room name.
   *
   * Needed because the ADOPTION path status-filters and verifies the room,
   * while the `existingSessionId` path historically trusted the column
   * outright — so the two paths disagreed about what a usable session is. A
   * session that has gone terminal is not usable by either.
   */
  readSessionForReuse(input: { sessionId: string }): Promise<{
    status: string;
    roomVerified: boolean;
  } | null>;

  /**
   * The two reads the ADVISORY consent preflight needs.
   *
   * Advisory is the load-bearing word. `admit_phone_attempt` re-checks consent
   * authoritatively under the advisory lock, over the same ordering, and its
   * verdict is the one that decides whether a call happens. This exists only
   * so an obvious refusal costs no round trip — and because
   * `consentPreflight` can refuse but can never grant, a disagreement between
   * the two can only ever stop a call, never start one.
   */
  readonly consent: ConsentReader;
}

interface Row {
  readonly [key: string]: unknown;
}

function str(row: Row, key: string): string | undefined {
  const v = row[key];
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function num(row: Row, key: string): number | undefined {
  const v = row[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * The ONE value this module interpolates into a PostgREST filter.
 *
 * The `or` grammar is comma- and dot-delimited, so a string reaching that
 * position decides how many filter terms the query has. `nowIso` is a plain
 * `string` on the public `PhoneRuntimeReader` interface, and today's only
 * caller passes `options.now.toISOString()` — but "today's only caller" is
 * not a guarantee, it is a fact with an expiry date. Validated to an
 * ISO-8601 instant here so the guarantee lives at the boundary that needs it.
 *
 * Throws rather than falling back to a permissive filter: a clock we cannot
 * render is not a reason to widen the query.
 */
function isoInstant(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value)) {
    throw new Error('phone_runtime_bad_now');
  }
  return value;
}

/**
 * The instant a reconnect must have been updated BEFORE to be due.
 *
 * `nowIso` is validated at this boundary and the backoff arrived without the
 * same treatment, which is the gap `isoInstant`'s own comment warns about:
 * today's only caller is a fact with an expiry date, not a guarantee. Two
 * concrete failures it leaves open:
 *
 *   * a non-finite value makes `new Date(NaN).toISOString()` throw a raw
 *     `RangeError` — the one path in this file that would have escaped as
 *     something other than a bare stable code;
 *   * a NEGATIVE value pushes the ceiling into the FUTURE, silently admitting
 *     reconnects that are not due — a quieter version of the very bug the
 *     SQL ceiling was added to fix, and one that fails open rather than loud.
 */
function reconnectDueCeiling(nowIso: string, backoffSeconds: number): string {
  if (!Number.isFinite(backoffSeconds) || backoffSeconds < 0) {
    throw new Error('phone_runtime_bad_backoff');
  }
  return new Date(
    Date.parse(isoInstant(nowIso)) - Math.floor(backoffSeconds) * 1_000,
  ).toISOString();
}

function dueState(value: unknown): PhoneDueState | undefined {
  return typeof value === 'string'
    && (PHONE_DUE_STATES as readonly string[]).includes(value)
    ? (value as PhoneDueState)
    : undefined;
}

/**
 * The clock predicate for the ORDINARY due read.
 *
 * Factored rather than repeated because M-3 gives this reader a second read
 * (the reconnect batch below) and two copies of a clock predicate are two
 * things that can drift — the same reasoning that keeps `istWindowOpen` a
 * single definition shared with admission.
 *
 * `state.eq.reconnecting` is the exemption and it is why this is one `or`
 * rather than three chained filters: a reconnect's due time is NOT in
 * `next_eligible_at` at all — 0042 leaves the reconnect backoff to a worker
 * clock, so `dueByClock` derives it from `updated_at`. Filtering reconnects on
 * a column that does not carry their due time would hide EVERY reconnect from
 * the pass.
 */
function dueClockPredicate(nowIso: string): string {
  return (
    'state.eq.reconnecting,next_eligible_at.is.null,'
    + `next_eligible_at.lte.${isoInstant(nowIso)}`
  );
}

/** Project a raw PostgREST payload into the due-engagement shape. */
function projectDueRows(data: unknown): DuePhoneEngagement[] {
  const rows = Array.isArray(data) ? (data as Row[]) : [];
  const out: DuePhoneEngagement[] = [];
  for (const row of rows) {
    const engagementId = str(row, 'id');
    const state = dueState(row.state);
    const candidateId = str(row, 'candidate_id');
    // A row missing any of the three is not actionable. Dropping it is
    // safe in the only direction that matters: nobody is dialled.
    if (engagementId === undefined || state === undefined || candidateId === undefined) {
      continue;
    }
    out.push({
      engagementId,
      state,
      candidateId,
      roleId: str(row, 'role_id') ?? null,
      sessionId: str(row, 'session_id') ?? null,
      nextEligibleAt: str(row, 'next_eligible_at') ?? null,
      noAnswerAttempts: num(row, 'no_answer_attempts') ?? 0,
      updatedAt: str(row, 'updated_at') ?? null,
    });
  }
  return out;
}

/**
 * One bounded due read, narrowed either to the whole due set or to a single
 * state.
 *
 * Most of the shape is shared with its sibling — the column list, the
 * terminal filter, the ordering — but the CLOCK and the BOUND are not, and
 * both differences are deliberate. The reconnect batch filters on
 * `updated_at` (its due time lives there, not on `next_eligible_at`) and is
 * capped at `limit - 1` so the ordinary lane always keeps a slot. An earlier
 * version of this comment claimed both were shared; they are not: the same
 * explicit column list, the same `terminal_at is null`, the same clock
 * predicate, the same `updated_at asc` ordering and the same bound. That is
 * the point of the seam — the reconnect batch must not be able to drift into
 * a differently-filtered read of the same table.
 */
async function readDueBatch(
  client: SupabaseClient,
  input: {
    nowIso: string;
    limit: number;
    onlyState: PhoneDueState | null;
    reconnectBackoffSeconds: number;
  },
): Promise<DuePhoneEngagement[]> {
  const base = client
    .from('phone_engagements')
    .select(DUE_ENGAGEMENT_COLUMNS)
    .is('terminal_at', null);
  const narrowed = input.onlyState === null
    ? base.in('state', PHONE_DUE_STATES as unknown as string[])
    : base.eq('state', input.onlyState);
  // ── THE RECONNECT BATCH NEEDS ITS OWN CLOCK, IN SQL ────────────────
  // `dueClockPredicate`'s first disjunct is `state.eq.reconnecting`, which
  // is trivially TRUE for every row of the reconnect-only read — so that
  // read had no due-time filter at all, and its due time was decided only
  // afterwards by `dueByClock`. Combined with reading reconnects FIRST into
  // a hard-capped batch, three not-yet-due reconnects filled every slot of
  // every pass and the lane dialled nobody. Worse: an admission refusal is
  // free by design and bumps no `updated_at`, so three permanently-refused
  // reconnects stayed the oldest rows for ever.
  //
  // A reconnect's due time is `updated_at + reconnectBackoffSeconds` — the
  // same arithmetic `dueByClock` does — so it can be expressed here, and
  // must be, because the batch is bounded before the JS filter ever runs.
  const filtered = input.onlyState === 'reconnecting'
    ? narrowed.lte(
      'updated_at',
      reconnectDueCeiling(input.nowIso, input.reconnectBackoffSeconds),
    )
    : narrowed.or(dueClockPredicate(input.nowIso));
  const { data, error } = await filtered
    .order('updated_at', { ascending: true })
    .limit(input.limit);
  // Sanitized: a PostgREST error carries the failing statement and can
  // carry row values. None of it propagates.
  if (error) throw new Error('phone_runtime_due_read_error');
  return projectDueRows(data);
}

export function createPhoneRuntimeReader(client: SupabaseClient): PhoneRuntimeReader {
  return {
    /**
     * ── RECONNECTS GO FIRST, AND THE ORDERING ALONE CANNOT DO IT ──────
     * The main batch is ordered `updated_at asc` and BOUNDED (`dueLimit`
     * defaults to 3). A row entering `reconnecting` was just written by
     * `apply_phone_event`, so it carries the NEWEST `updated_at` in the due
     * set and sorts LAST — behind any three `eligible` rows still waiting to
     * be dialled, which is an ordinary morning backlog. The one due row with
     * a human already on the line was therefore the lowest-priority row in
     * the system, and no amount of tuning the single ORDER BY fixes that:
     * oldest-first is right for the no-answer ladder and wrong for a
     * reconnect, and one clause cannot be both.
     *
     * So the reconnect batch is READ SEPARATELY and merged AHEAD. Both reads
     * go through `readDueBatch`, so they SHARE the column list, the
     * `terminal_at is null` filter and the `updated_at asc` ordering. Three
     * things DIFFER, all three deliberately: the **state filter**
     * (`in PHONE_DUE_STATES` against `eq 'reconnecting'`), the **clock
     * filter** (`dueClockPredicate` against the `updated_at <= now − backoff`
     * ceiling below) and the **bound** (`limit` against `limit − 1`). The
     * clock filter is the one that looks mergeable and is not — see the block
     * immediately below for what happened when the reconnect read borrowed
     * the main predicate.
     * The cost is one extra bounded, indexed read per pass — paid on the
     * cheapest and most latency-sensitive loop in the lane.
     *
     * The merged set is DE-DUPLICATED by engagement id, because the main read
     * selects `reconnecting` too (the state is one of the three): without the
     * dedupe a single reconnect would occupy two of the three batch slots and
     * be offered twice in one pass.
     */
    async listDueEngagements(input): Promise<readonly DuePhoneEngagement[]> {
      const limit = boundedRowLimit(input.limit);
      // AT MOST `limit - 1` reconnects, so the main batch can never be
      // starved to zero. Priority is not precedence: a reconnect goes first
      // among those dialled, but it may not be the only thing dialled. With
      // `limit` of 1 the reservation is 0 and the ordinary batch is the
      // whole pass — a single-slot pass has no room for a priority lane.
      const reconnectSlots = Math.max(0, limit - 1);
      const reconnecting = reconnectSlots === 0
        ? []
        : await readDueBatch(client, {
          nowIso: input.nowIso,
          limit: reconnectSlots,
          onlyState: 'reconnecting',
          reconnectBackoffSeconds: input.reconnectBackoffSeconds,
        });
      const rest = await readDueBatch(client, {
        nowIso: input.nowIso,
        limit,
        onlyState: null,
        reconnectBackoffSeconds: input.reconnectBackoffSeconds,
      });

      const merged: DuePhoneEngagement[] = [];
      const seen = new Set<string>();
      for (const row of [...reconnecting, ...rest]) {
        if (seen.has(row.engagementId)) continue;
        seen.add(row.engagementId);
        merged.push(row);
        // The BATCH stays bounded by the caller's limit, not by twice it: the
        // fleet cap is ten and each row here is a call to a person.
        if (merged.length >= limit) break;
      }
      return merged;
    },

    async listDialableNumbers(input): Promise<ReadonlyMap<string, DialableNumber>> {
      const ids = [...new Set(input.candidateIds)].filter((id) => id !== '');
      // An empty `.in()` list is `in.()`, which PostgREST answers with EVERY
      // row. Performing no query is the only safe reading of "nothing to ask".
      if (ids.length === 0) return new Map();

      const { data, error } = await client
        .from('candidates')
        .select(DIALABLE_CANDIDATE_COLUMNS)
        .in('id', ids)
        .limit(boundedRowLimit(ids.length));
      if (error) throw new Error('phone_runtime_number_read_error');

      const rows = Array.isArray(data) ? (data as Row[]) : [];
      const out = new Map<string, DialableNumber>();
      for (const row of rows) {
        const id = str(row, 'id');
        if (id === undefined) continue;
        // `phone_valid` is the operator-visible verdict the ingestion lane
        // wrote. Honour it before parsing: a number marked invalid must not be
        // dialled even if it happens to match the pattern.
        if (row.phone_valid !== true) continue;
        const raw = row.phone_e164;
        if (typeof raw !== 'string') continue;
        try {
          // Wrapped in the SAME expression that reads it. No local ever holds
          // the bare string, so there is nothing for a later edit to log.
          out.set(id, wrapDialableNumber(raw));
        } catch {
          // `phone_number_not_dialable`. Dropped and never named: admission
          // would refuse it `phone_invalid`, and an unusable value must not
          // travel further than the row it came from.
          continue;
        }
      }
      return out;
    },

    consent: {
      async latestConsentRecord(candidateId: string) {
        const { data, error } = await client
          .from('consent_records')
          .select(CONSENT_RECORD_COLUMNS)
          .eq('candidate_id', candidateId)
          // The SQL orders `created_at desc, id desc` over ALL records, so a
          // later `withdrawn` row overrides an older `granted` one. Mirroring
          // the order matters more than mirroring the filter.
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .limit(1);
        if (error) throw new Error('phone_runtime_consent_read_error');
        const row = (Array.isArray(data) ? (data as Row[]) : [])[0];
        if (row === undefined) return null;
        const expires = str(row, 'expires_at');
        return {
          status: str(row, 'status') ?? '',
          consents: Array.isArray(row.consents)
            ? (row.consents as unknown[]).filter((c): c is string => typeof c === 'string')
            : [],
          expiresAt: expires === undefined ? null : new Date(expires),
        };
      },

      async activeConsentTemplate() {
        const { data, error } = await client
          .from('consent_templates')
          .select(CONSENT_TEMPLATE_COLUMNS)
          .eq('is_active', true)
          .order('updated_at', { ascending: false })
          .order('id', { ascending: false })
          .limit(1);
        if (error) throw new Error('phone_runtime_consent_read_error');
        const row = (Array.isArray(data) ? (data as Row[]) : [])[0];
        if (row === undefined) return null;
        return {
          requiredConsents: Array.isArray(row.required_consents)
            ? (row.required_consents as unknown[]).filter((c): c is string => typeof c === 'string')
            : [],
        };
      },
    },

    async findReusableSession(input): Promise<string | null> {
      const { data, error } = await client
        .from('call_sessions')
        .select(REUSABLE_SESSION_COLUMNS)
        .eq('candidate_id', input.candidateId)
        .eq('mode', PHONE_SESSION_MODE)
        .in('status', REUSABLE_SESSION_STATUSES as unknown as string[])
        .order('started_at', { ascending: false })
        .limit(1);
      if (error) throw new Error('phone_runtime_session_read_error');

      const rows = Array.isArray(data) ? (data as Row[]) : [];
      const row = rows[0];
      if (row === undefined) return null;
      const id = str(row, 'id');
      if (id === undefined) return null;
      // The room name is derived from the session id, and
      // `start_phone_assessment` VERIFIES that derivation before it will bind
      // anything. A session that does not already carry it is not adoptable —
      // reusing one would produce a leg that could never start its assessment.
      return str(row, 'external_call_id') === phoneRoomName(id) ? id : null;
    },

    async countLiveEngagements(input): Promise<number> {
      const { data, error } = await client
        .from('phone_engagements')
        .select(OWNING_ENGAGEMENT_COLUMNS)
        .eq('candidate_id', input.candidateId)
        .is('terminal_at', null)
        .limit(2);
      if (error) throw new Error('phone_runtime_session_read_error');
      return Array.isArray(data) ? data.length : 0;
    },

    async engagementOwningSession(input): Promise<string | null> {
      const { data, error } = await client
        .from('phone_engagements')
        .select(OWNING_ENGAGEMENT_COLUMNS)
        .eq('session_id', input.sessionId)
        .limit(1);
      if (error) throw new Error('phone_runtime_session_read_error');
      const rows = Array.isArray(data) ? (data as Row[]) : [];
      const row = rows[0];
      return row === undefined ? null : (str(row, 'id') ?? null);
    },

    async readSessionForReuse(input): Promise<{ status: string; roomVerified: boolean } | null> {
      const { data, error } = await client
        .from('call_sessions')
        .select(REUSABLE_SESSION_COLUMNS)
        .eq('id', input.sessionId)
        .eq('mode', PHONE_SESSION_MODE)
        .limit(1);
      if (error) throw new Error('phone_runtime_session_read_error');
      const rows = Array.isArray(data) ? (data as Row[]) : [];
      const row = rows[0];
      if (row === undefined) return null;
      const status = str(row, 'status');
      if (status === undefined) return null;
      return {
        status,
        roomVerified: str(row, 'external_call_id') === phoneRoomName(input.sessionId),
      };
    },
  };
}
