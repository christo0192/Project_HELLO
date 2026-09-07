/**
 * The store adapters: exact RPC names, exact parameter keys, stable parsing,
 * and no raw error propagation.
 *
 * The client is a hand-written fake, not `vi.mock`, so the assertions are about
 * what the adapter SENDS as well as what it does with what it gets back. A
 * renamed parameter key is a runtime 404 that no type check would catch, so
 * every call's argument object is compared field for field.
 */

import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createPhoneStores } from '../lib/phone-screening/stores.js';
import {
  PHONE_RPC_NAMES,
  PHONE_RPC_PARAMETERS,
  PHONE_RPC_UNKNOWN_STATUS,
} from '../lib/phone-screening/rpc-contract.js';
import {
  PHONE_ATTEMPT_KINDS,
  PHONE_ATTEMPT_STATES,
  PHONE_ENGAGEMENT_STATES,
  PHONE_EVENT_IGNORED_REASONS,
} from '../lib/phone-screening/vocabulary.js';

/**
 * A phone-SHAPED value that is NOT dialable: `+91` followed by a leading `0`,
 * which fails 0042's `^\\+91[6-9][0-9]{9}$` gate. India publishes no reserved
 * documentation range — there is no +1-555 equivalent — so a committed literal
 * must be one the substrate itself would refuse, never a plausible subscriber
 * number. A structural assertion keeps any dialable form out of this tree.
 */
const NON_DIALABLE = '+910000000000';

const NOW = new Date('2026-08-22T09:30:00.000Z');

interface Recorded {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

/** A client that records every `.rpc` call and replays a scripted answer. */
function fakeClient(answer: unknown, error: unknown = null): {
  client: SupabaseClient;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return Promise.resolve({ data: answer, error });
    },
    from() {
      throw new Error('phone stores must never reach a table directly');
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

describe('the adapters call the RPCs by name, with the declared keys', () => {
  it('admitAttempt', async () => {
    const { client, calls } = fakeClient({
      status: 'ok',
      attempt_id: 'a1',
      attempt_seq: 2,
      kind: 'initial',
      epoch: 3,
      ist_date: '2026-08-22',
      lease_token: 't1',
      lease_expires_at: '2026-08-22T09:31:00.000Z',
      live_before: 4,
    });
    const result = await createPhoneStores(client).admitAttempt({
      engagementId: 'e1', kind: 'initial', leaseOwner: 'w1', leaseSeconds: 90, now: NOW,
    });
    expect(calls[0].name).toBe('admit_phone_attempt');
    expect(calls[0].args).toEqual({
      p_engagement_id: 'e1',
      p_kind: 'initial',
      p_lease_owner: 'w1',
      p_lease_seconds: 90,
      p_now: NOW.toISOString(),
    });
    expect(result).toEqual({
      status: 'ok',
      attemptId: 'a1',
      attemptSeq: 2,
      kind: 'initial',
      epoch: 3,
      istDate: '2026-08-22',
      leaseToken: 't1',
      leaseExpiresAt: '2026-08-22T09:31:00.000Z',
      liveBefore: 4,
    });
  });

  it('a refusal carries only sanitized detail — codes, counts and instants', async () => {
    const { client } = fakeClient({
      status: 'at_capacity',
      live: 10,
      max_concurrent: 10,
      // A field 0042 does not emit, and a phone-shaped one. Both must be
      // DISCARDED rather than forwarded.
      phone_e164: NON_DIALABLE,
      raw_error: 'a provider envelope',
    });
    const result = await createPhoneStores(client).admitAttempt({
      engagementId: 'e1', kind: 'initial', now: NOW,
    });
    expect(result.status).toBe('at_capacity');
    expect(result.detail).toEqual({ live: 10, maxConcurrent: 10 });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(NON_DIALABLE);
    expect(serialized).not.toContain('provider envelope');
    expect(serialized).not.toContain('phone_e164');
  });

  it('a refusal carrying only string detail is mapped field by field', async () => {
    const { client } = fakeClient({
      status: 'kind_not_admissible', state: 'eligible', kind: 'reconnect',
    });
    const result = await createPhoneStores(client).admitAttempt({
      engagementId: 'e1', kind: 'reconnect', now: NOW,
    });
    expect(result.detail).toEqual({ state: 'eligible', kind: 'reconnect' });

    const bare = fakeClient({ status: 'halted' });
    expect((await createPhoneStores(bare.client).admitAttempt({
      engagementId: 'e1', kind: 'initial', now: NOW,
    })).detail).toBeUndefined();
  });

  it('an ABSENT ignored_reason is undefined, not null', async () => {
    // `attempt_required` records nothing at all, so there is no verdict to
    // report — distinct from an APPLIED event, whose reason is explicitly null.
    const { client } = fakeClient({
      status: 'attempt_required', event_type: 'classify.machine', engagement_state: 'dialing',
    });
    const result = await createPhoneStores(client).applyEvent({
      source: 'internal', eventType: 'classify.machine', engagementId: 'e1', now: NOW,
    });
    expect(result.status).toBe('attempt_required');
    expect(result.ignoredReason).toBeUndefined();
    expect(result.eventType).toBe('classify.machine');
  });

  it('heartbeatAttempt, reclaimAttemptLeases', async () => {
    const hb = fakeClient({ status: 'ok', lease_expires_at: '2026-08-22T09:32:00.000Z' });
    expect(await createPhoneStores(hb.client).heartbeatAttempt({
      attemptId: 'a1', leaseToken: 't1', now: NOW,
    })).toEqual({ status: 'ok', leaseExpiresAt: '2026-08-22T09:32:00.000Z' });
    expect(hb.calls[0]).toEqual({
      name: 'heartbeat_phone_attempt',
      args: { p_attempt_id: 'a1', p_lease_token: 't1', p_lease_seconds: 60, p_now: NOW.toISOString() },
    });

    const rc = fakeClient({ status: 'ok', reclaimed: 3, limit: 50 });
    expect(await createPhoneStores(rc.client).reclaimAttemptLeases({ now: NOW }))
      .toEqual({ status: 'ok', reclaimed: 3, limit: 50 });
    expect(rc.calls[0].args).toEqual({ p_limit: 50, p_now: NOW.toISOString() });
  });

  it('applyEvent, including the duplicate replay', async () => {
    const { client, calls } = fakeClient({
      status: 'applied',
      applied: true,
      ignored_reason: null,
      event_id: 'ev1',
      duplicate: false,
      engagement_state: 'in_call',
      attempt_state: 'human',
    });
    const result = await createPhoneStores(client).applyEvent({
      source: 'livekit_webhook',
      eventType: 'disclosure.delivered',
      attemptId: 'a1',
      providerEventId: 'p1',
      epoch: 2,
      metadata: { k: 'v' },
      now: NOW,
    });
    expect(calls[0].name).toBe('apply_phone_event');
    expect(Object.keys(calls[0].args)).toEqual([...PHONE_RPC_PARAMETERS.apply_phone_event]);
    expect(calls[0].args.p_engagement_id).toBeNull();
    // `toEqual` IGNORES a key whose value is undefined, so an `eventType:
    // undefined` line here would assert nothing. Compare the defined subset
    // strictly, then assert the absence separately.
    expect(result).toStrictEqual({
      status: 'applied',
      applied: true,
      ignoredReason: null,
      eventId: 'ev1',
      duplicate: false,
      engagementState: 'in_call',
      attemptState: 'human',
      eventType: undefined,
    });
    expect(result.eventType).toBeUndefined();

    const dup = fakeClient({
      status: 'ignored', applied: false, ignored_reason: 'stale_epoch',
      event_id: 'ev1', duplicate: true,
    });
    const replay = await createPhoneStores(dup.client).applyEvent({
      source: 'livekit_webhook', eventType: 'sip.participant_left', attemptId: 'a1',
      providerEventId: 'p1', now: NOW,
    });
    expect(replay.duplicate).toBe(true);
    expect(replay.ignoredReason).toBe('stale_epoch');
  });

  it('the calendar, the halt switch and the backlog', async () => {
    const start = new Date('2026-08-22T10:00:00.000Z');
    const end = new Date('2026-08-22T10:30:00.000Z');
    const sc = fakeClient({
      status: 'ok_prereqs_pending', appointment_id: 'ap1', version: 1,
      engagement_state: 'pending_prereqs', superseded_appointment_id: null,
    });
    expect(await createPhoneStores(sc.client).scheduleAppointment({
      engagementId: 'e1', startsAt: start, endsAt: end, source: 'hr_manual', now: NOW,
    })).toEqual({
      status: 'ok_prereqs_pending', appointmentId: 'ap1', version: 1,
      engagementState: 'pending_prereqs', supersededAppointmentId: null,
    });
    expect(sc.calls[0].args).toEqual({
      p_engagement_id: 'e1',
      p_starts_at: start.toISOString(),
      p_ends_at: end.toISOString(),
      p_source: 'hr_manual',
      p_actor_id: null,
      p_expected_version: null,
      p_now: NOW.toISOString(),
    });

    const rr = fakeClient({
      status: 'already_requested', engagement_id: 'e2', cycle_number: 2,
      predecessor_engagement_id: 'e1', request_id: 'request-1',
    });
    expect(await createPhoneStores(rr.client).requestRescreen({
      candidateId: 'c1', reason: 'technical_issue', requestId: 'request-1',
      source: 'hr_manual', actorId: 'actor-1', now: NOW,
    })).toEqual({
      status: 'already_requested', engagementId: 'e2', cycleNumber: 2,
      predecessorEngagementId: 'e1', requestId: 'request-1',
    });
    expect(rr.calls[0]).toEqual({
      name: 'request_phone_rescreen',
      args: {
        p_candidate_id: 'c1', p_reason: 'technical_issue', p_request_id: 'request-1',
        p_source: 'hr_manual', p_actor_id: 'actor-1', p_now: NOW.toISOString(),
      },
    });

    const cx = fakeClient({ status: 'already_cancelled', appointment_id: 'ap1', version: 2 });
    expect(await createPhoneStores(cx.client).cancelAppointment({
      appointmentId: 'ap1', reason: 'hr_cancelled', now: NOW,
    })).toMatchObject({ status: 'already_cancelled', version: 2 });

    const ex = fakeClient({ status: 'ok', expired: 2, grace_seconds: 900, limit: 50 });
    expect(await createPhoneStores(ex.client).expireAppointments({ now: NOW }))
      .toEqual({ status: 'ok', expired: 2, graceSeconds: 900, limit: 50 });

    const sh = fakeClient({ status: 'ok', already_halted: false });
    expect(await createPhoneStores(sh.client).setHalt({ reason: 'operator_pause', now: NOW }))
      .toEqual({ status: 'ok', alreadyHalted: false });
    expect(sh.calls[0].args).toEqual({
      p_reason: 'operator_pause', p_actor_id: null, p_now: NOW.toISOString(),
    });

    const ch = fakeClient({ status: 'halt_unreadable' });
    expect(await createPhoneStores(ch.client).clearHalt({ now: NOW }))
      .toStrictEqual({ status: 'halt_unreadable', wasHalted: undefined });
  });

  it('the backlog projection maps every nested count', async () => {
    const { client } = fakeClient({
      status: 'ok',
      admission: { control_present: true, halted: false, halt_reason: null },
      engagements_by_state: { eligible: 3, dialing: 1, bogus: 'not-a-number' },
      attempts: {
        live: 2, live_with_unexpired_lease: 2, max_concurrent: 10, oldest_live_age_seconds: 41,
      },
      appointments: { live: 1, overdue: 0 },
      events: {
        ignored_last_24h: 5, unknown_attempt_last_24h: 0, stale_epoch_last_24h: 4,
        terminal_last_24h: 1, unexpected_event_last_24h: 0,
      },
      window_open: true,
      ist_date: '2026-08-22',
    });
    const result = await createPhoneStores(client).backlog({ now: NOW });
    expect(result.admission).toEqual({ controlPresent: true, halted: false, haltReason: null });
    // A non-numeric count is dropped, never coerced to zero.
    expect(result.engagementsByState).toEqual({ eligible: 3, dialing: 1 });
    expect(result.attempts?.maxConcurrent).toBe(10);
    expect(result.events?.staleEpochLast24h).toBe(4);
    expect(result.windowOpen).toBe(true);
  });

  it('a MISSING control singleton reads as halted, never as running normally', async () => {
    const { client } = fakeClient({ status: 'ok', admission: {} });
    const result = await createPhoneStores(client).backlog({ now: NOW });
    expect(result.admission).toEqual({
      controlPresent: false, halted: true, haltReason: null,
    });
  });
});

describe('the parsers narrow against the SHARED vocabularies', () => {
  it('every engagement state and attempt state round-trips through applyEvent', async () => {
    // A locally re-declared vocabulary drifting from `vocabulary.ts` would make
    // these fields silently VANISH rather than raise, so every member is
    // exercised — not just the two the happy path happens to use.
    for (const engagementState of PHONE_ENGAGEMENT_STATES) {
      const { client } = fakeClient({
        status: 'applied', applied: true, ignored_reason: null, event_id: 'ev',
        duplicate: false, engagement_state: engagementState, attempt_state: 'ended',
      });
      const result = await createPhoneStores(client).applyEvent({
        source: 'internal', eventType: 'x.y', attemptId: 'a1', now: NOW,
      });
      expect(result.engagementState, engagementState).toBe(engagementState);
    }
    for (const attemptState of PHONE_ATTEMPT_STATES) {
      const { client } = fakeClient({
        status: 'applied', applied: true, ignored_reason: null, event_id: 'ev',
        duplicate: false, engagement_state: 'in_call', attempt_state: attemptState,
      });
      const result = await createPhoneStores(client).applyEvent({
        source: 'internal', eventType: 'x.y', attemptId: 'a1', now: NOW,
      });
      expect(result.attemptState, attemptState).toBe(attemptState);
    }
  });

  it('every ignored reason and every attempt kind round-trips', async () => {
    for (const reason of PHONE_EVENT_IGNORED_REASONS) {
      const { client } = fakeClient({
        status: 'ignored', applied: false, ignored_reason: reason,
        event_id: 'ev', duplicate: false,
      });
      const result = await createPhoneStores(client).applyEvent({
        source: 'internal', eventType: 'x.y', attemptId: 'a1', now: NOW,
      });
      expect(result.ignoredReason, reason).toBe(reason);
    }
    for (const kind of PHONE_ATTEMPT_KINDS) {
      const { client } = fakeClient({ status: 'ok', attempt_id: 'a1', kind });
      const result = await createPhoneStores(client).admitAttempt({
        engagementId: 'e1', kind, now: NOW,
      });
      expect(result.kind, kind).toBe(kind);
    }
  });

  it('a value OUTSIDE the vocabulary is dropped, never forwarded', async () => {
    const { client } = fakeClient({
      status: 'applied', applied: true, ignored_reason: 'a_reason_from_the_future',
      event_id: 'ev', duplicate: false, engagement_state: 'not_a_state',
      attempt_state: 'not_a_state',
    });
    const result = await createPhoneStores(client).applyEvent({
      source: 'internal', eventType: 'x.y', attemptId: 'a1', now: NOW,
    });
    expect(result.engagementState).toBeUndefined();
    expect(result.attemptState).toBeUndefined();
    // Present-but-unrecognised is reported as null, not as the raw value.
    expect(result.ignoredReason).toBeNull();
  });
});

describe('objective coverage adapter', () => {
  it('uses the atomic coverage RPC only when future keys are supplied', async () => {
    const { client, calls } = fakeClient({
      status: 'applied', applied: true, duplicate: false, cursor: 2,
      question_key: 'k1', question_index: 0, first_turn_index: 0,
      last_turn_index: 1, question_count: 3, plan_complete: false,
    });
    const result = await createPhoneStores(client).commitQuestionBoundary({
      sessionId: 's', questionKey: 'k1', expectedIndex: 0,
      sourceEventId: 'q:k1',
      turns: [{ speaker: 'bot', text: 'How much experience?' }, { speaker: 'candidate', text: 'Three years.' }],
      coveredQuestionKeys: ['k2'], now: NOW,
    });
    expect(calls[0]).toEqual({
      name: 'commit_phone_question_boundary_with_coverage',
      args: {
        p_session_id: 's', p_question_key: 'k1', p_expected_index: 0,
        p_source_event_id: 'q:k1',
        p_turns: [
          { speaker: 'bot', text: 'How much experience?', turn_started_at_ms: null },
          { speaker: 'candidate', text: 'Three years.', turn_started_at_ms: null },
        ],
        p_covered_question_keys: ['k2'], p_now: NOW.toISOString(),
      },
    });
    expect(result.cursor).toBe(2);
  });

  it('0086 (Finding B): a disposition rides the RPC args; omission omits the key', async () => {
    const { client, calls } = fakeClient({ status: 'applied', applied: true, cursor: 1 });
    await createPhoneStores(client).commitQuestionBoundary({
      sessionId: 's', questionKey: 'k1', expectedIndex: 0,
      sourceEventId: 'q:k1',
      turns: [{ speaker: 'bot', text: 'Q?' }, { speaker: 'candidate', text: 'A.' }],
      disposition: 'asked_declined', now: NOW,
    });
    expect(calls[0].args).toMatchObject({ p_disposition: 'asked_declined' });
    // Omitted: the key is ABSENT (the RPC default records NULL), never null.
    const { client: c2, calls: calls2 } = fakeClient({ status: 'applied', applied: true, cursor: 1 });
    await createPhoneStores(c2).commitQuestionBoundary({
      sessionId: 's', questionKey: 'k1', expectedIndex: 0,
      sourceEventId: 'q:k1',
      turns: [{ speaker: 'bot', text: 'Q?' }, { speaker: 'candidate', text: 'A.' }],
      now: NOW,
    });
    expect('p_disposition' in (calls2[0].args as Record<string, unknown>)).toBe(false);
  });
});

describe('errors and malformed answers', () => {
  it('a transport error becomes a stable sanitized code, never the raw object', async () => {
    const raw = {
      message: 'permission denied for table phone_engagements',
      details: `candidate ${NON_DIALABLE} row 42`,
      hint: 'connection string postgres://user:pw@host',
      code: '42501',
    };
    const stores = createPhoneStores(fakeClient(null, raw).client);
    const attempts: Array<[string, () => Promise<unknown>]> = [
      ['phone_admit_attempt_error', () => stores.admitAttempt({ engagementId: 'e', kind: 'initial', now: NOW })],
      ['phone_admit_test_attempt_error', () => stores.admitTestAttempt!({
        testGateId: 'g', engagementId: 'e', kind: 'initial', now: NOW })],
      ['phone_arm_test_gate_error', () => stores.armTestGate!({
        candidateId: 'c', engagementId: 'e', actorId: 'a', requestId: 'r',
        expiresAt: new Date(NOW.getTime() + 60000), now: NOW })],
      ['phone_heartbeat_attempt_error', () => stores.heartbeatAttempt({ attemptId: 'a', leaseToken: 't', now: NOW })],
      ['phone_reclaim_leases_error', () => stores.reclaimAttemptLeases({ now: NOW })],
      ['phone_apply_event_error', () => stores.applyEvent({ source: 'internal', eventType: 'x.y', now: NOW })],
      ['phone_schedule_appointment_error', () => stores.scheduleAppointment({
        engagementId: 'e', startsAt: NOW, endsAt: NOW, source: 'hr_manual', now: NOW })],
      ['phone_confirm_callback_error', () => stores.confirmCandidateVoiceCallback!({
        attemptId: 'a', startsAt: NOW, now: NOW })],
      ['phone_request_rescreen_error', () => stores.requestRescreen({
        candidateId: 'c', reason: 'technical_issue', requestId: 'r', source: 'hr_manual', now: NOW })],
      ['phone_cancel_appointment_error', () => stores.cancelAppointment({
        appointmentId: 'ap', reason: 'hr_cancelled', now: NOW })],
      ['phone_expire_appointments_error', () => stores.expireAppointments({ now: NOW })],
      ['phone_set_halt_error', () => stores.setHalt({ reason: 'operator_pause', now: NOW })],
      ['phone_clear_halt_error', () => stores.clearHalt({ now: NOW })],
      ['phone_backlog_error', () => stores.backlog({ now: NOW })],
      // 0043's recording-artifact RPCs. These carry OBJECT KEYS, so a leaked
      // driver error here would be the one place a storage path could escape
      // alongside a candidate row.
      ['phone_attach_recording_error', () => stores.attachAttemptRecording({
        attemptId: 'a', objectKey: 'phone-a-egress.ogg', role: 'authoritative', now: NOW })],
      ['phone_finalize_recording_error', () => stores.finalizeAttemptRecording({
        attemptId: 'a', egressStatus: 'complete', now: NOW })],
      ['phone_stamp_session_egress_error', () => stores.stampSessionEgress({
        sessionId: 's', attemptId: 'a', egressId: 'EG_test', now: NOW })],
      ['phone_list_recordings_error', () => stores.listEngagementRecordings({
        engagementId: 'e' })],
      ['phone_clear_recordings_error', () => stores.clearAttemptRecordings({
        engagementId: 'e', now: NOW })],
      // 0044's assessment-persistence RPCs. These carry a candidate's own
      // words, so a leaked driver error here would quote a transcript row.
      ['phone_start_assessment_error', () => stores.startAssessment({
        attemptId: 'a', sessionId: 's', now: NOW })],
      ['phone_assessment_state_error', () => stores.assessmentState({ sessionId: 's' })],
      ['phone_commit_boundary_error', () => stores.commitQuestionBoundary({
        sessionId: 's', questionKey: 'k1', expectedIndex: 0, sourceEventId: 'ev-1',
        turns: [{ speaker: 'bot', text: 'A?' }, { speaker: 'candidate', text: 'Y' }],
        now: NOW })],
      ['phone_commit_boundary_error', () => stores.commitQuestionBoundary({
        sessionId: 's', questionKey: 'k1', expectedIndex: 0, sourceEventId: 'ev-1',
        coveredQuestionKeys: ['k2'],
        turns: [{ speaker: 'bot', text: 'A?' }, { speaker: 'candidate', text: 'Y' }],
        now: NOW })],
      // 0045. The heartbeat carries no transcript, but it DOES carry an
      // attempt id and an epoch, and a leaked PostgREST error quotes the
      // failing statement — which would put both in a thrown message that
      // the worker route forwards nowhere but a log.
      ['phone_heartbeat_attempt_error', () => stores.heartbeatAttemptByEpoch({
        attemptId: 'a', epoch: 1, sessionId: 's', now: NOW })],
      ['phone_sweep_day_rolled_error', () => stores.sweepDayRolled({ now: NOW })],
      ['phone_sweep_stranded_error', () => stores.sweepStrandedSessions({ now: NOW })],
      ['phone_claim_sweep_error', () => stores.claimSweep({
        sweep: 'reconcile', owner: 'o', now: NOW })],
      ['phone_record_probe_error', () => stores.recordProbe!({
        sessionId: 's', questionKey: 'q1', expectedIndex: 0,
        sourceEventId: 'ev-1', now: NOW })],
      ['phone_consent_start_error', () => stores.consentAndStart!({
        attemptId: 'a', sessionId: 's', epoch: 0, now: NOW })],
      // 0071 / X4. The per-item writer carries a candidate's own words, so a
      // leaked driver error here would quote a transcript row exactly as the
      // boundary would.
      ['phone_commit_item_turn_error', () => stores.commitItemTurn!({
        sessionId: 's', speaker: 'candidate', text: 'a word',
        sourceItemId: 'phone-item-1', now: NOW })],
      // 0071 / X5b. The recording sweep carries no transcript, but a leaked
      // PostgREST error still quotes the failing statement.
      ['phone_sweep_stranded_recordings_error', () => stores.sweepStrandedRecordings!({
        now: NOW })],
      // 0072. The partial-finalize sweep returns session ids in its `sessions`
      // array, so a leaked PostgREST error must not escape either.
      ['phone_finalize_partial_sessions_error', () => stores.finalizePartialSessions!({
        now: NOW })],
      // 0083. The same-IST-day infra abandon; a leaked driver error would quote
      // the failing statement (attempt id), so it too must be sanitized.
      ['phone_abandon_infra_error', () => stores.abandonAttemptInfra!({
        attemptId: 'a', now: NOW })],
    ];
    expect(attempts).toHaveLength(PHONE_RPC_NAMES.length);
    for (const [code, run] of attempts) {
      await expect(run()).rejects.toThrow(new RegExp(`^${code}$`));
      // Nothing from the raw error survives: no message, no hint, no `cause`.
      await run().catch((e: unknown) => {
        const err = e as Error & { cause?: unknown };
        expect(err.message).toBe(code);
        expect(err.cause).toBeUndefined();
        expect(JSON.stringify(err.message)).not.toContain(NON_DIALABLE.slice(1));
      });
    }
  });

  it('an unrecognised status is stable and sanitized, on every adapter', async () => {
    const stores = createPhoneStores(fakeClient({ status: 'from_a_future_migration' }).client);
    expect((await stores.admitAttempt({ engagementId: 'e', kind: 'initial', now: NOW })).status)
      .toBe(PHONE_RPC_UNKNOWN_STATUS);
    expect((await stores.heartbeatAttempt({ attemptId: 'a', leaseToken: 't', now: NOW })).status)
      .toBe(PHONE_RPC_UNKNOWN_STATUS);
    expect((await stores.backlog({ now: NOW })).status).toBe(PHONE_RPC_UNKNOWN_STATUS);
  });

  it('a null, scalar or array body never throws and never looks like success', async () => {
    for (const body of [null, undefined, 'ok', 7, [{ status: 'ok' }]]) {
      const stores = createPhoneStores(fakeClient(body).client);
      const result = await stores.admitAttempt({ engagementId: 'e', kind: 'initial', now: NOW });
      expect(result.status).toBe(PHONE_RPC_UNKNOWN_STATUS);
      expect(result.attemptId).toBeUndefined();
    }
  });

  it('an invalid injected instant is refused before any call is made', async () => {
    const { client, calls } = fakeClient({ status: 'ok' });
    await expect(createPhoneStores(client).admitAttempt({
      engagementId: 'e', kind: 'initial', now: new Date(Number.NaN),
    })).rejects.toThrow('phone_now_invalid');
    expect(calls).toHaveLength(0);
  });
});
