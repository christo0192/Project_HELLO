import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migration = readFileSync(
  resolve(process.cwd(), '../supabase/migrations/0068_phone_voice_callback_confirmation.sql'),
  'utf8',
);
const repair = readFileSync(
  resolve(process.cwd(), '../supabase/migrations/0073_phone_owner_callback_ashby.sql'),
  'utf8',
);

describe('0068 candidate voice callback confirmation contract', () => {
  it('declares the dedicated service RPC and exact reservation rules', () => {
    expect(migration).toContain('create or replace function screening_v2.confirm_candidate_voice_callback(');
    expect(migration).toContain("extract(epoch from (ends_at - starts_at)) between 600 and 3600");
    expect(migration).toContain("p_now + interval '5 minutes'");
    expect(migration).toContain("p_starts_at + interval '10 minutes'");
    expect(migration).toContain("source,\n     confirmed_at, confirmed_from_attempt_id");
  });

  it('keeps booking atomic, idempotent, and service-role-only', () => {
    expect(migration).toContain("pg_advisory_xact_lock(hashtext('phone_callback_booking'))");
    expect(migration).toContain('uq_phone_appointments_confirmed_attempt');
    expect(migration).toContain("set state = 'ended', outcome_class = 'disconnected'");
    expect(migration).toContain("set state = 'scheduled', state_reason = 'candidate_callback_confirmed'");
    expect(migration).toContain('revoke all on function screening_v2.confirm_candidate_voice_callback');
    expect(migration).toContain('to service_role');
  });

  it('does not carry a phone value or an external calendar integration', () => {
    expect(migration).not.toMatch(/phone_e164|phone_raw|google|outlook|email|sms/i);
  });
  it('the owner repair restores the 900-second callback envelope', () => {
    expect(repair).toContain('between 900 and 3600');
    expect(repair).toContain("'duration_seconds', 900");
    expect(repair).toContain("interval '15 minutes'");
  });

});
