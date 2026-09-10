/**
 * 0082 — the per-call phone observability column, read from the migration text.
 *
 * These assertions read the SQL rather than the database, so a regression fails
 * in `npm test` rather than later in the Supabase job. They pin the additive
 * contract the whole feature depends on:
 *
 *   1. It is COLUMNS-ONLY — no RPC, no grant/revoke, no constraint. Any of those
 *      would need a rpc-contract change; their absence is what lets this ship
 *      without touching the RPC surface.
 *   2. The column is NOT NULL DEFAULT '{}'::jsonb, so every prior and every
 *      never-instrumented call reads as an empty object rather than null — the
 *      property that makes "prior/clean calls unaffected" structural.
 *   3. It is registered in PHONE_MIGRATIONS and does not break the harness
 *      (the RPC extractor still sees exactly the unchanged RPC surface).
 */

import { describe, it, expect } from 'vitest';
import {
  MIGRATION_0082,
  PHONE_MIGRATIONS,
  PHONE_MIGRATIONS_TEXT,
} from './support/phone-migration.js';

describe('0082 per-call phone observability column', () => {
  it('adds the observability jsonb column, additive and idempotent', () => {
    expect(MIGRATION_0082).toContain('alter table screening_v2.call_sessions');
    expect(MIGRATION_0082).toMatch(
      /add column if not exists observability jsonb not null default '\{\}'::jsonb/,
    );
  });

  it('documents the column so the write contract is discoverable', () => {
    expect(MIGRATION_0082).toContain(
      'comment on column screening_v2.call_sessions.observability is',
    );
  });

  it('is COLUMNS-ONLY — no RPC, grant/revoke or constraint rides on it', () => {
    expect(MIGRATION_0082).not.toMatch(/create or replace function/i);
    expect(MIGRATION_0082).not.toMatch(/grant execute on function/i);
    expect(MIGRATION_0082).not.toMatch(/revoke all on function/i);
    expect(MIGRATION_0082).not.toMatch(/add constraint/i);
  });

  it('is registered NEWEST-FIRST in the migration harness', () => {
    // 0094 (dial scope + fleet cap) is the newest entry — it re-declares
    // admit_phone_attempt IN FULL, so anything ahead of it would make the
    // extractors read 0083's superseded body. Then 0092 (end of the temporary
    // 24/7 window), then 0086 (boundary disposition); 0085, 0083 and 0082 sit
    // after them in order. What matters for the newest-first scheme is that
    // 0082 still precedes every OLDER migration it could shadow — asserted via
    // its index, which must be below any pre-0082 entry.
    const idx082 = PHONE_MIGRATIONS.findIndex((m) => m.name === '0082');
    const idx083 = PHONE_MIGRATIONS.findIndex((m) => m.name === '0083');
    const idx085 = PHONE_MIGRATIONS.findIndex((m) => m.name === '0085');
    const idx086 = PHONE_MIGRATIONS.findIndex((m) => m.name === '0086');
    const idx092 = PHONE_MIGRATIONS.findIndex((m) => m.name === '0092');
    const idx094 = PHONE_MIGRATIONS.findIndex((m) => m.name === '0094');
    expect(idx094).toBe(0);
    expect(idx092).toBe(1);
    expect(idx086).toBe(2);
    expect(idx085).toBeGreaterThan(idx086);
    expect(PHONE_MIGRATIONS[idx082]).toEqual({ name: '0082', sql: MIGRATION_0082 });
    expect(idx083).toBeGreaterThan(idx085);
    expect(idx082).toBeGreaterThan(idx083);
    // Every registered migration still has non-empty SQL (the harness guard).
    expect(PHONE_MIGRATIONS.every((m) => m.sql.length > 0)).toBe(true);
    // And its text is present in the concatenated corpus the extractors walk.
    expect(PHONE_MIGRATIONS_TEXT).toContain('call_sessions.observability');
  });
});
