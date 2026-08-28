import { describe, expect, it } from 'vitest';
import { functionBody, functionParameters, functionStatuses, MIGRATION_0063 } from './support/phone-migration.js';

const ARM = functionBody('arm_phone_test_gate');
const ADMIT = functionBody('admit_phone_test_attempt');

describe('0063 candidate-scoped phone test gate', () => {
  it('declares the exact service-role RPC parameters', () => {
    expect(functionParameters('arm_phone_test_gate')).toEqual([
      'p_candidate_id', 'p_engagement_id', 'p_actor_id', 'p_request_id',
      'p_expires_at', 'p_now',
    ]);
    expect(functionParameters('admit_phone_test_attempt')).toEqual([
      'p_test_gate_id', 'p_engagement_id', 'p_kind', 'p_lease_owner',
      'p_lease_seconds', 'p_now',
    ]);
  });

  it('arms only during operator_pause and requires an eligible exact engagement', () => {
    expect(ARM).toContain("v_ctl.halt_reason <> 'operator_pause'");
    expect(ARM).toContain("v_state <> 'eligible'");
    expect(ARM).toContain('v_candidate_id <> p_candidate_id');
    expect(ARM).toContain('p_expires_at <= p_now + interval');
    expect(ARM).toContain('p_expires_at > p_now + interval');
    expect(new Set(functionStatuses('arm_phone_test_gate'))).toEqual(new Set([
      'ok', 'already_armed', 'actor_required', 'invalid_request_id', 'invalid_expiry',
      'halt_unreadable', 'test_gate_requires_halt', 'test_gate_halt_not_permitted',
      'candidate_mismatch', 'application_not_found', 'engagement_not_found',
      'test_gate_not_eligible', 'test_gate_already_armed', 'idempotency_conflict',
    ]));
  });

  it('consumes atomically and never bypasses non-operator halts', () => {
    expect(ADMIT).toContain("v_ctl.halt_reason <> 'operator_pause'");
    expect(ADMIT).toContain("set consumed_at = p_now");
    expect(ADMIT).toContain("return jsonb_build_object('status', 'halted'");
    expect(ADMIT).toContain('screening_v2.admit_phone_attempt(');
    expect(ADMIT).toContain("set halted_at = v_ctl.halted_at");
    expect(new Set(functionStatuses('admit_phone_test_attempt')))
      .toEqual(new Set(['ok', 'halted']));
  });

  it('keeps one unconsumed gate globally exclusive', () => {
    expect(MIGRATION_0063).toContain('uq_phone_test_gates_one_unconsumed');
    expect(MIGRATION_0063).toContain("where consumed_at is null");
    expect(ARM).toContain("return jsonb_build_object('status', 'test_gate_already_armed')");
  });
});
