/**
 * 0113 — phone answer gate and callback-leg detach (M009 / S02, PR-B), shape
 * and harness registration, asserted against the migration TEXT.
 *
 * WHY THIS EXISTS (B0): 0113 redeclares four functions whose newest bodies
 * live in 0095 (apply_phone_event, finalize_phone_partial_sessions), 0073
 * (confirm_candidate_voice_callback) and 0045 (sweep_phone_stranded_sessions).
 * If 0113 is not the FIRST entry in PHONE_MIGRATIONS, every extractor keeps
 * reading the superseded bodies and the drift tests go blind to E4/E6. And if
 * 0113 ever redeclares something outside that set, it silently reverts a body
 * another migration (PR-A's 0112 above all) owns.
 *
 * Behaviour is proven in app/supabase/tests/policy_tests.sql; text is not
 * execution.
 */
import { describe, it, expect } from 'vitest';
import { basename } from 'node:path';

import {
  MIGRATION_0073,
  MIGRATION_0112,
  MIGRATION_0113,
  MIGRATION_0113_PATH,
  PHONE_MIGRATIONS,
} from './support/phone-migration.js';

// Normalised to LF so a Windows (CRLF) checkout reads the same as CI.
const M0113 = MIGRATION_0113.replace(/\r\n/g, '\n');

/** The only functions 0113 may redeclare (plan B0/B1/B3). */
const OWNED = [
  'apply_phone_event',
  'confirm_candidate_voice_callback',
  'finalize_phone_partial_sessions',
  'sweep_phone_stranded_sessions',
] as const;

describe('0113 — harness registration', () => {
  const idx = (name: string): number => PHONE_MIGRATIONS.findIndex((m) => m.name === name);

  it('is the newest entry after 0115 and 0114, ahead of every migration whose body it lifts', () => {
    // 0114 (M009 PR-C) re-lifts apply_phone_event, finalize and sweep FROM
    // 0113, and 0115 (M013 S02) re-lifts finalize from 0114, so those two sit
    // first; 0113 stays directly behind them.
    expect(PHONE_MIGRATIONS[0].name).toBe('0115');
    expect(PHONE_MIGRATIONS[1].name).toBe('0114');
    expect(PHONE_MIGRATIONS[2].name).toBe('0113');
    for (const older of ['0112', '0095', '0073', '0045']) {
      expect(idx(older), `${older} is not registered`).toBeGreaterThan(-1);
      expect(idx('0113'), older).toBeLessThan(idx(older));
    }
  });

  it('registers 0073, the newest confirm body before 0113, ahead of 0068', () => {
    expect(MIGRATION_0073).toContain(
      'create or replace function screening_v2.confirm_candidate_voice_callback(',
    );
    expect(idx('0073')).toBeLessThan(idx('0068'));
  });
});

describe('0113 — file shape', () => {
  it('has a CI-legal migration filename', () => {
    expect(basename(MIGRATION_0113_PATH)).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
  });

  it('ends by reloading the PostgREST schema cache', () => {
    expect(M0113.trimEnd().endsWith("notify pgrst, 'reload schema';")).toBe(true);
  });

  it('redeclares only the four functions it owns', () => {
    const declared = [...M0113.matchAll(/create or replace function screening_v2\.(\w+)\(/gi)].map(
      (m) => m[1],
    );
    for (const name of declared) expect(OWNED, name).toContain(name);
    expect(new Set(declared).size, 'a function redeclared twice').toBe(declared.length);
  });

  it("does not take over anything PR-A's 0112 owns", () => {
    const owned0112 = [...MIGRATION_0112.matchAll(/create or replace function screening_v2\.(\w+)\(/g)].map(
      (m) => m[1],
    );
    expect(owned0112.length).toBeGreaterThan(0);
    for (const name of owned0112) {
      expect(M0113, name).not.toContain(`function screening_v2.${name}(`);
    }
    // Index shape is PR-A's (E1); 0113 must not touch it.
    expect(M0113).not.toMatch(/\b(drop|create)\s+(unique\s+)?index\b/i);
  });
});
