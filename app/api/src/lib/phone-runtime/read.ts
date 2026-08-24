/**
 * lib/phone-runtime/read.ts — the two reads the runtime needs and nothing
 * else: which engagements are due, and the number to dial one with.
 *
 * ── WHY THE NUMBER IS READ HERE AND NOWHERE ELSE ──────────────────────
 * Until this phase, a candidate's `phone_e164` never left SQL. Admission
 * reads it INSIDE `admit_phone_attempt`, digests it, and compares the digest
 * against the suppression list; the value never crosses a process boundary.
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
   * Engagements in a due state, oldest-eligible first, bounded.
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

function dueState(value: unknown): PhoneDueState | undefined {
  return typeof value === 'string'
    && (PHONE_DUE_STATES as readonly string[]).includes(value)
    ? (value as PhoneDueState)
    : undefined;
}

export function createPhoneRuntimeReader(client: SupabaseClient): PhoneRuntimeReader {
  return {
    async listDueEngagements(input): Promise<readonly DuePhoneEngagement[]> {
      const limit = boundedRowLimit(input.limit);
      const { data, error } = await client
        .from('phone_engagements')
        .select(DUE_ENGAGEMENT_COLUMNS)
        .is('terminal_at', null)
        .in('state', PHONE_DUE_STATES as unknown as string[])
        // The clock predicate is applied in SQL as well as in `dueByClock`,
        // and it is not redundant: the batch is BOUNDED (`dueLimit` defaults
        // to 3) and ordered `updated_at asc`, so without it three rows whose
        // `next_eligible_at` is hours away would fill every batch forever and
        // starve the rows that are genuinely due. A filter applied only after
        // the read can observe that starvation but cannot cure it.
        //
        // `reconnecting` is exempted because its due time is NOT this column:
        // 0042 leaves the reconnect backoff to a worker clock, so `dueByClock`
        // derives it from `updated_at`. Excluding those rows here would hide
        // every reconnect from the pass — which is why the predicate is an
        // `or` and not three chained filters.
        .or(
          `state.eq.reconnecting,next_eligible_at.is.null,next_eligible_at.lte.${input.nowIso}`,
        )
        .order('updated_at', { ascending: true })
        .limit(limit);
      // Sanitized: a PostgREST error carries the failing statement and can
      // carry row values. None of it propagates.
      if (error) throw new Error('phone_runtime_due_read_error');

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
  };
}
