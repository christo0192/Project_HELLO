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
    expect(PHONE_MIGRATIONS[0]).toEqual({ name: '0082', sql: MIGRATION_0082 });
    // Every registered migration still has non-empty SQL (the harness guard).
    expect(PHONE_MIGRATIONS.every((m) => m.sql.length > 0)).toBe(true);
    // And its text is present in the concatenated corpus the extractors walk.
    expect(PHONE_MIGRATIONS_TEXT).toContain('call_sessions.observability');
  });
});
