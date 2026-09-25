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
  functionBody,
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
    // 0096 (live-call protection) is the newest entry — it re-declares
    // reclaim_phone_attempt_leases IN FULL over 0071's, so anything ahead of it
    // would make the extractors read the ungraced reaper that abandoned a live
    // conversation. Then 0095 (call-outcome hygiene) — it re-declares
    // apply_phone_event, admit_phone_attempt AND finalize_phone_partial_sessions
    // IN FULL, so anything ahead of it would make the extractors read 0067's,
    // 0094's and 0072's superseded bodies. Then 0094 (dial scope + fleet cap),
    // which re-declares admit_phone_attempt over 0083's; then 0092 (end of the
    // temporary 24/7 window), then 0086 (boundary disposition); 0085, 0083 and
    // 0082 sit after them in order. What matters for the newest-first scheme is
    // that 0082 still precedes every OLDER migration it could shadow —
    // asserted via its index, which must be below any pre-0082 entry.
    const idx082 = PHONE_MIGRATIONS.findIndex((m) => m.name === '0082');
    const idx083 = PHONE_MIGRATIONS.findIndex((m) => m.name === '0083');
    const idx085 = PHONE_MIGRATIONS.findIndex((m) => m.name === '0085');
    const idx086 = PHONE_MIGRATIONS.findIndex((m) => m.name === '0086');
    const idx092 = PHONE_MIGRATIONS.findIndex((m) => m.name === '0092');
    const idx094 = PHONE_MIGRATIONS.findIndex((m) => m.name === '0094');
    const idx095 = PHONE_MIGRATIONS.findIndex((m) => m.name === '0095');
    const idx096 = PHONE_MIGRATIONS.findIndex((m) => m.name === '0096');
    // ORDER, NOT POSITION. These were once pinned to absolute indices 0-4,
    // which encoded "these five are the newest" — a fact that expires the next
    // time a phone migration is registered, as 0103 and 0104 just did. The
    // invariant the extractors actually depend on is that the list is sorted
    // newest-first, so assert THAT, over every entry rather than eight picked
    // ones: a misplacement anywhere is a superseded body read somewhere.
    const names = PHONE_MIGRATIONS.map((m) => m.name);
    expect(names).toEqual([...names].sort().reverse());
    expect(new Set(names).size, 'a migration registered twice').toBe(names.length);
    // PRESENT, not merely ordered. `findIndex` returns -1 for a missing entry
    // and -1 is less than everything, so the comparisons below are all
    // satisfied by DELETING 0096 — which sortedness does not catch either.
    const registered = { idx096, idx095, idx094, idx092, idx086, idx085, idx083, idx082 };
    for (const [label, idx] of Object.entries(registered)) {
      expect(idx, `${label} is not registered at all`).toBeGreaterThan(-1);
    }
    // Spelled out for the four whose order this file's comment explains.
    expect(idx096).toBeLessThan(idx095);
    expect(idx095).toBeLessThan(idx094);
    expect(idx094).toBeLessThan(idx092);
    expect(idx092).toBeLessThan(idx086);
    expect(idx085).toBeGreaterThan(idx086);
    expect(PHONE_MIGRATIONS[idx082]).toEqual({ name: '0082', sql: MIGRATION_0082 });
    expect(idx083).toBeGreaterThan(idx085);
    expect(idx082).toBeGreaterThan(idx083);
    // Every registered migration still has non-empty SQL (the harness guard).
    expect(PHONE_MIGRATIONS.every((m) => m.sql.length > 0)).toBe(true);
    // And its text is present in the concatenated corpus the extractors walk.
    expect(PHONE_MIGRATIONS_TEXT).toContain('call_sessions.observability');
  });

  it("RESOLVES start_phone_assessment TO 0103, not 0044's superseded body", () => {
    // THE TRIPWIRE THE REGISTRATION NEVER HAD. 0103 re-declares
    // `start_phone_assessment` IN FULL, so from #307 until it was registered
    // in PHONE_MIGRATIONS every extractor read 0044's body — for the function
    // whose output IS the conversation. Nothing caught it, because 0103 kept
    // 0044's parameters and status vocabulary byte-for-byte: the contract
    // suite cannot tell which body it read, and a sortedness check does not
    // care whether an entry exists at all.
    //
    // So anchor on text only the NEW body has. Deleting the 0103 line from
    // PHONE_MIGRATIONS now fails here instead of silently reverting.
    const body = functionBody('start_phone_assessment');
    expect(body).toContain('candidate_screening_questions');
    expect(body).toContain('candidate_resume');
  });
});
