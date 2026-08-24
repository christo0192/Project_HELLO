/**
 * The consent preflight and the admission facade.
 *
 * The property under test is one sentence: THE PREFLIGHT CAN ONLY REFUSE, AND
 * ONLY THE RPC CAN GRANT. Everything below is a way of failing if that stops
 * being true — including the case the audit called out, where the advisory
 * layer says nothing is wrong and the database refuses anyway.
 */

import { describe, it, expect } from 'vitest';
import {
  CONSENT_PREFLIGHT_REFUSALS,
  consentPreflight,
  type ConsentReader,
  type ConsentRecordSnapshot,
  type ConsentTemplateSnapshot,
} from '../lib/phone-screening/consent.js';
import {
  PHONE_DEFERRAL_CODES,
  admitPhoneEngagement,
  type PhoneAdmissionRequest,
} from '../lib/phone-screening/admission.js';
import { loadPhoneScreeningConfig } from '../lib/phone-screening/config.js';
import { PHONE_OUTCOME_CLASSES } from '../lib/phone-screening/vocabulary.js';
import { narrowIstWindow } from '../lib/phone-screening/ist-window.js';
import { PHONE_RPC_UNKNOWN_STATUS } from '../lib/phone-screening/rpc-contract.js';
import type { AdmitPhoneAttemptResult, PhoneStores } from '../lib/phone-screening/ports.js';
import { functionBody } from './support/phone-migration.js';

const NOW = new Date('2026-08-22T09:30:00.000Z'); // 15:00 IST — inside the window.
const DIGEST = 'c'.repeat(64);

const ALL_SIX = ['ai_interview', 'recording', 'purpose', 'data_processing', 'retention', 'rights'];

function reader(
  record: ConsentRecordSnapshot | null | Error,
  template: ConsentTemplateSnapshot | null | Error = { requiredConsents: ALL_SIX },
): ConsentReader {
  return {
    async latestConsentRecord() {
      if (record instanceof Error) throw record;
      return record;
    },
    async activeConsentTemplate() {
      if (template instanceof Error) throw template;
      return template;
    },
  };
}

const granted: ConsentRecordSnapshot = {
  status: 'granted',
  consents: ALL_SIX,
  expiresAt: null,
};

/**
 * A fake `PhoneStores` that records how many times admission was asked and
 * answers what it was told. Every other method THROWS: the facade must not
 * reach for a capability it does not need, and a silent no-op fake would hide
 * that.
 */
interface FakeStores {
  readonly stores: PhoneStores;
  callsMade(): number;
}

function fakeStores(admit: AdmitPhoneAttemptResult): FakeStores {
  let calls = 0;
  const unreachable = async (): Promise<never> => {
    throw new Error('phone_store_method_not_expected');
  };
  const stores: PhoneStores = {
    async admitAttempt() {
      calls += 1;
      return admit;
    },
    heartbeatAttempt: unreachable,
    heartbeatAttemptByEpoch: unreachable,
    sweepDayRolled: unreachable,
    sweepStrandedSessions: unreachable,
    claimSweep: unreachable,
    reclaimAttemptLeases: unreachable,
    applyEvent: unreachable,
    // 0044. Admission never touches the assessment path.
    startAssessment: unreachable,
    assessmentState: unreachable,
    commitQuestionBoundary: unreachable,
    // 0043's recording methods are unreachable from admission by design:
    // admission happens BEFORE the disclosure that any recording depends on.
    attachAttemptRecording: unreachable,
    finalizeAttemptRecording: unreachable,
    listEngagementRecordings: unreachable,
    clearAttemptRecordings: unreachable,
    scheduleAppointment: unreachable,
    cancelAppointment: unreachable,
    expireAppointments: unreachable,
    setHalt: unreachable,
    clearHalt: unreachable,
    backlog: unreachable,
  };
  return { stores, callsMade: () => calls };
}

const enabledConfig = loadPhoneScreeningConfig({
  PHONE_SCREENING_ENABLED: 'true',
  PHONE_RUNTIME_ENABLED: 'true',
  PHONE_DIAL_MODE: 'synthetic',
});

const request: PhoneAdmissionRequest = {
  engagementId: '11111111-1111-4111-8111-111111111111',
  candidateId: '22222222-2222-4222-8222-222222222222',
  kind: 'initial',
  phoneDigest: DIGEST,
  now: NOW,
};

describe('consent preflight — the latest record wins, whatever its status', () => {
  it('a later withdrawn or declined record is the one that is read', async () => {
    for (const status of ['withdrawn', 'declined']) {
      const result = await consentPreflight(
        reader({ status, consents: ALL_SIX, expiresAt: null }),
        request.candidateId,
        NOW,
      );
      expect(result).toEqual({ decision: 'refused', code: 'consent_not_granted', consentStatus: status });
    }
  });

  it('mirrors the SQL: the record is read by recency, NOT filtered by status', () => {
    // A `where status = 'granted'` read would make a withdrawal invisible and
    // the gate would keep saying yes forever.
    const body = functionBody('admit_phone_attempt');
    expect(body).toContain('order by created_at desc, id desc');
    expect(body).not.toMatch(/consent_records\s+where[^;]*status\s*=\s*'granted'/s);
  });

  it('an expired grant refuses, and the boundary is inclusive on expiry', async () => {
    expect(await consentPreflight(
      reader({ ...granted, expiresAt: new Date(NOW.getTime() - 1) }), request.candidateId, NOW,
    )).toEqual({ decision: 'refused', code: 'consent_expired' });
    // `expires_at <= p_now` — expiring exactly now is expired.
    expect(await consentPreflight(
      reader({ ...granted, expiresAt: new Date(NOW.getTime()) }), request.candidateId, NOW,
    )).toEqual({ decision: 'refused', code: 'consent_expired' });
    expect(await consentPreflight(
      reader({ ...granted, expiresAt: new Date(NOW.getTime() + 1) }), request.candidateId, NOW,
    )).toEqual({ decision: 'no_local_objection' });
    expect(functionBody('admit_phone_attempt')).toContain('v_consent.expires_at <= p_now');
  });

  it('an absent record, an inactive template and a subset miss each refuse', async () => {
    expect(await consentPreflight(reader(null), request.candidateId, NOW))
      .toEqual({ decision: 'refused', code: 'consent_missing' });
    expect(await consentPreflight(reader(granted, null), request.candidateId, NOW))
      .toEqual({ decision: 'refused', code: 'consent_template_inactive' });
    expect(await consentPreflight(
      reader({ ...granted, consents: ['ai_interview', 'recording'] }), request.candidateId, NOW,
    )).toEqual({ decision: 'refused', code: 'consent_subset_missing' });
  });

  it('an ACTIVE template requiring nothing passes, exactly as the SQL does', async () => {
    // `'{}' <@ consents` is true in Postgres, so the SQL subset check refuses
    // nothing here. Refusing locally would make the preflight stricter than
    // the gate it mirrors, and a preflight that refuses what the RPC would
    // allow is a second, divergent policy.
    expect(await consentPreflight(
      reader(granted, { requiredConsents: [] }), request.candidateId, NOW,
    )).toEqual({ decision: 'no_local_objection' });
    expect(functionBody('admit_phone_attempt')).toContain('v_required is null');
    expect(functionBody('admit_phone_attempt')).toContain('not (v_required <@ v_consent.consents)');
  });

  it('a READ that throws is a refusal, not a pass', async () => {
    // A consent gate that fails open on a database blip is not a gate.
    expect(await consentPreflight(reader(new Error('db down')), request.candidateId, NOW))
      .toEqual({ decision: 'refused', code: 'consent_read_error' });
    expect(await consentPreflight(
      reader(granted, new Error('db down')), request.candidateId, NOW,
    )).toEqual({ decision: 'refused', code: 'consent_read_error' });
  });

  it('the clean answer authorises nothing — it is not named "allowed"', async () => {
    const result = await consentPreflight(reader(granted), request.candidateId, NOW);
    expect(result.decision).toBe('no_local_objection');
    expect(JSON.stringify(result)).not.toContain('allowed');
  });

  it('every refusal code except the local one matches an admit_phone_attempt status', () => {
    const body = functionBody('admit_phone_attempt');
    for (const code of CONSENT_PREFLIGHT_REFUSALS) {
      if (code === 'consent_read_error') {
        // The one member with no SQL counterpart: the preflight itself could
        // not answer. That is a local fail-closed refusal, not a DB verdict.
        expect(body).not.toContain(`'${code}'`);
        continue;
      }
      expect(body).toContain(`'${code}'`);
    }
  });
});

describe('admission facade — the gates defer, they never admit', () => {
  const okResult: AdmitPhoneAttemptResult = {
    status: 'ok',
    attemptId: '33333333-3333-4333-8333-333333333333',
    attemptSeq: 1,
    leaseToken: '44444444-4444-4444-8444-444444444444',
  };

  it('a disabled deployment defers without touching the database', async () => {
    for (const [source, code] of [
      [{}, 'screening_disabled'],
      [{ PHONE_SCREENING_ENABLED: 'true' }, 'runtime_disabled'],
      [{ PHONE_SCREENING_ENABLED: 'true', PHONE_RUNTIME_ENABLED: 'true' }, 'dial_mode_off'],
    ] as const) {
      const f = fakeStores(okResult);
      const result = await admitPhoneEngagement(
        { stores: f.stores, config: loadPhoneScreeningConfig(source), consentReader: reader(granted) },
        request,
      );
      expect(result).toMatchObject({ decision: 'deferred', code, charged: false });
      expect(f.callsMade()).toBe(0);
    }
  });

  it('a cold runtime defers, and the readiness signal is INJECTED', async () => {
    const f = fakeStores(okResult);
    const result = await admitPhoneEngagement(
      { stores: f.stores, config: enabledConfig, consentReader: reader(granted) },
      { ...request, runtimeReady: false },
    );
    expect(result).toMatchObject({ decision: 'deferred', code: 'cold_start', charged: false });
    expect(f.callsMade()).toBe(0);

    // A caller with nothing to warm is not blocked by the default.
    const g = fakeStores(okResult);
    expect((await admitPhoneEngagement(
      { stores: g.stores, config: enabledConfig, consentReader: reader(granted) },
      request,
    )).decision).toBe('admitted');
    expect((await admitPhoneEngagement(
      { stores: g.stores, config: enabledConfig, consentReader: reader(granted) },
      { ...request, runtimeReady: true },
    )).decision).toBe('admitted');
  });

  it('cold start is a WAIT: it is not an outcome and charges nothing', async () => {
    const f = fakeStores(okResult);
    const result = await admitPhoneEngagement(
      { stores: f.stores, config: enabledConfig, consentReader: reader(granted) },
      { ...request, runtimeReady: false },
    );
    if (result.decision !== 'deferred') throw new Error('unreachable');
    expect(result.charged).toBe(false);
    // Never `provider_error`: charging a candidate's budget for our own boot
    // time is the exact confusion the eleven-member CHECK prevents.
    expect(PHONE_OUTCOME_CLASSES).not.toContain(result.code as never);
  });

  it('live mode with an empty or non-matching allowlist defers', async () => {
    const config = loadPhoneScreeningConfig({
      PHONE_SCREENING_ENABLED: 'true',
      PHONE_RUNTIME_ENABLED: 'true',
      PHONE_DIAL_MODE: 'live',
    });
    const f = fakeStores(okResult);
    const result = await admitPhoneEngagement(
      { stores: f.stores, config, consentReader: reader(granted) },
      request,
    );
    expect(result).toMatchObject({ decision: 'deferred', code: 'dial_not_allowlisted' });
    expect(f.callsMade()).toBe(0);

    // A MISSING digest is treated exactly like a non-matching one: the
    // fail-closed reading of "we do not know which line this is".
    const g = fakeStores(okResult);
    expect(await admitPhoneEngagement(
      { stores: g.stores, config, consentReader: reader(granted) },
      { ...request, phoneDigest: undefined },
    )).toMatchObject({ decision: 'deferred', code: 'dial_not_allowlisted' });
    expect(g.callsMade()).toBe(0);

    // An allowlisted digest in live mode reaches the RPC, which then decides.
    const listed = loadPhoneScreeningConfig({
      PHONE_SCREENING_ENABLED: 'true',
      PHONE_RUNTIME_ENABLED: 'true',
      PHONE_DIAL_MODE: 'live',
      PHONE_DIAL_ALLOWLIST: DIGEST,
    });
    const h = fakeStores(okResult);
    expect((await admitPhoneEngagement(
      { stores: h.stores, config: listed, consentReader: reader(granted) },
      request,
    )).decision).toBe('admitted');
    expect(h.callsMade()).toBe(1);

    // ...and `synthetic` needs no allowlist at all, because it reaches no
    // carrier; requiring one there would block the rehearsal it exists for.
    const i = fakeStores(okResult);
    expect((await admitPhoneEngagement(
      { stores: i.stores, config: enabledConfig, consentReader: reader(granted) },
      { ...request, phoneDigest: undefined },
    )).decision).toBe('admitted');
  });

  it('a closed window defers with the next legal instant, and charges nothing', async () => {
    const f = fakeStores(okResult);
    // 2026-08-22T16:00:00Z is 21:30 IST — after close.
    const result = await admitPhoneEngagement(
      { stores: f.stores, config: enabledConfig, consentReader: reader(granted) },
      { ...request, now: new Date('2026-08-22T16:00:00.000Z') },
    );
    expect(result).toMatchObject({
      decision: 'deferred', code: 'window_closed_defer', charged: false,
    });
    if (result.decision !== 'deferred') throw new Error('unreachable');
    // Tomorrow 09:00 IST = 2026-08-23T03:30:00Z.
    expect(result.retryAfter?.toISOString()).toBe('2026-08-23T03:30:00.000Z');
    expect(f.callsMade()).toBe(0);
  });

  it('a WIDENED window bound is refused by the facade, not silently applied', async () => {
    // `IstWindowBounds` is structural, so a widening pair type-checks. The
    // facade re-narrows what it is handed, which is what makes "a local window
    // can only defer earlier" a control rather than a comment.
    const f = fakeStores(okResult);
    await expect(admitPhoneEngagement(
      { stores: f.stores, config: enabledConfig, consentReader: reader(granted) },
      { ...request, windowBounds: { openSeconds: 0, closeSeconds: 86_400 } },
    )).rejects.toThrow(/phone_ist_window_widened/);
    expect(f.callsMade()).toBe(0);

    // A genuine NARROWING is honoured: 15:00 IST is outside 09:00-14:00.
    const g = fakeStores(okResult);
    const narrowed = await admitPhoneEngagement(
      { stores: g.stores, config: enabledConfig, consentReader: reader(granted) },
      { ...request, windowBounds: narrowIstWindow({ closeSeconds: 14 * 3600 }) },
    );
    expect(narrowed).toMatchObject({ decision: 'deferred', code: 'window_closed_defer' });
    expect(g.callsMade()).toBe(0);
  });

  it('a consent refusal defers BEFORE the RPC, charging nothing', async () => {
    const f = fakeStores(okResult);
    const result = await admitPhoneEngagement(
      { stores: f.stores, config: enabledConfig, consentReader: reader(null) },
      request,
    );
    expect(result).toMatchObject({
      decision: 'deferred',
      code: 'consent_preflight_refused',
      consentRefusal: 'consent_missing',
      charged: false,
    });
    expect(f.callsMade()).toBe(0);
  });

  it('every deferral code matches the sanitized reason shape 0042 accepts', () => {
    for (const code of PHONE_DEFERRAL_CODES) {
      expect(code).toMatch(/^[a-z0-9_.:-]{1,64}$/);
    }
    // The two vocabularies are DISJOINT, and that is asserted over all of both
    // rather than over one convenient member: a deferral is not a call, so no
    // deferral code may ever be writable into the eleven-member
    // `outcome_class` CHECK. `window_closed_defer` is named that way precisely
    // to keep this true — 0042 declares `window_closed` as an outcome class.
    for (const code of PHONE_DEFERRAL_CODES) {
      expect(PHONE_OUTCOME_CLASSES, code).not.toContain(code as never);
    }
    expect(PHONE_DEFERRAL_CODES).toContain('cold_start');
    expect(functionBody('apply_phone_event')).not.toContain("'cold_start'");
  });
});

describe('admission facade — the DATABASE is authoritative', () => {
  it('the advisory layer says nothing is wrong and the RPC still refuses', async () => {
    // The exact disagreement the audit called out. The preflight sees a valid
    // granted record; the database, under its lock, sees an expired one.
    for (const status of ['consent_expired', 'consent_subset_missing'] as const) {
      const f = fakeStores({ status });
      const result = await admitPhoneEngagement(
        { stores: f.stores, config: enabledConfig, consentReader: reader(granted) },
        request,
      );
      expect(f.callsMade()).toBe(1);
      expect(result.decision).toBe('refused');
      if (result.decision !== 'refused') throw new Error('unreachable');
      // The RPC's answer, untranslated. Nothing was admitted.
      expect(result.status).toBe(status);
      expect(result.charged).toBe(false);
      expect(result).not.toHaveProperty('code');
    }
  });

  it('every non-ok status surfaces as a refusal, never as an admission', async () => {
    for (const status of [
      'halted', 'halt_unreadable', 'at_capacity', 'window_closed', 'suppressed',
      'phone_invalid', 'daily_attempt_exists', 'attempt_in_flight', 'not_yet_eligible',
      'no_answer_budget_exhausted', 'engagement_terminal', 'ingestion_not_ready',
    ] as const) {
      const f = fakeStores({ status });
      const result = await admitPhoneEngagement(
        { stores: f.stores, config: enabledConfig, consentReader: reader(granted) },
        request,
      );
      expect(result).toMatchObject({ decision: 'refused', status, charged: false });
    }
  });

  it('an unrecognised answer is a refusal, never an admission', async () => {
    const f = fakeStores({ status: PHONE_RPC_UNKNOWN_STATUS });
    const result = await admitPhoneEngagement(
      { stores: f.stores, config: enabledConfig, consentReader: reader(granted) },
      request,
    );
    expect(result).toMatchObject({ decision: 'refused', status: PHONE_RPC_UNKNOWN_STATUS });
  });

  it('ONLY an `ok` from the RPC admits, and it charges nothing', async () => {
    const ok: AdmitPhoneAttemptResult = {
      status: 'ok',
      attemptId: '33333333-3333-4333-8333-333333333333',
      attemptSeq: 1,
      leaseToken: '44444444-4444-4444-8444-444444444444',
    };
    const f = fakeStores(ok);
    const result = await admitPhoneEngagement(
      { stores: f.stores, config: enabledConfig, consentReader: reader(granted) },
      request,
    );
    expect(result).toEqual({ decision: 'admitted', result: ok, charged: false });
    expect(f.callsMade()).toBe(1);
    // Admission charges no budget: every refusal, and every grant, is free.
    expect(functionBody('admit_phone_attempt')).toContain('Budgets: checked, never charged, here');
  });
});
