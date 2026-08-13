/**
 * Migration 0030 structural proofs — offline security invariants for the
 * webhook receipt RPC + reconciliation checkpoint store. Complements the live
 * Docker policy suite: RLS-enabled + service-role-only table, SECURITY DEFINER
 * RPCs with pinned search_path revoked from browser roles, dedup-safe insert,
 * and the absence of PII/token/body-shaped columns.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SQL = readFileSync(
  fileURLToPath(new URL('../../../../app/supabase/migrations/0030_ashby_webhook_reconciliation.sql', import.meta.url)),
  'utf8',
);
const sql = SQL.toLowerCase();

describe('0030 checkpoint table security', () => {
  it('enables RLS and is service-role-only (no browser grants/policies)', () => {
    expect(sql).toContain('alter table screening_v2.ashby_sync_checkpoints enable row level security');
    expect(sql).toContain('revoke all on screening_v2.ashby_sync_checkpoints from anon, authenticated, public');
    expect(sql).toContain('grant all privileges on screening_v2.ashby_sync_checkpoints to service_role');
    // No CREATE POLICY for browser roles anywhere in the migration.
    expect(sql).not.toMatch(/create policy/);
  });

  it('carries no contact / resume / raw-body columns (opaque token only)', () => {
    // The checkpoint holds an opaque sync_token; it must not add PII/body columns.
    const forbidden = ['email', 'phone', 'resume', 'raw_body', 'signature', 'secret', 'password', 'api_key'];
    // Restrict the scan to the CREATE TABLE body.
    const start = sql.indexOf('create table if not exists screening_v2.ashby_sync_checkpoints');
    const body = sql.slice(start, sql.indexOf(');', start));
    for (const f of forbidden) expect(body, `checkpoint column must not contain ${f}`).not.toContain(f);
  });
});

describe('0030 RPC hardening', () => {
  const fns = ['record_ashby_event_receipt', 'advance_ashby_sync_checkpoint', 'mark_ashby_sync_full_resync'];

  it('every RPC is SECURITY DEFINER with a pinned search_path', () => {
    // Three functions, each declared security definer + a pinned search_path.
    // (The `language plpgsql\n security definer` sequence appears once per fn.)
    expect((sql.match(/language plpgsql\s+security definer/g) ?? []).length).toBe(3);
    expect((sql.match(/set search_path = pg_catalog, screening_v2/g) ?? []).length).toBe(3);
  });

  it('every RPC is revoked from browser roles and granted to service_role', () => {
    for (const fn of fns) {
      expect(sql).toContain(`revoke all on function screening_v2.${fn}`);
      expect(sql).toContain(`grant execute on function screening_v2.${fn}`);
      const revokeIdx = sql.indexOf(`revoke all on function screening_v2.${fn}`);
      expect(sql.slice(revokeIdx, revokeIdx + 200)).toContain('from public, anon, authenticated');
    }
  });

  it('receipt ingress is dedup-safe (insert-or-noop on the unique key)', () => {
    expect(sql).toContain('on conflict (provider, webhook_action_id, action) do nothing');
    expect(sql).toContain("jsonb_build_object('status', 'inserted'");
    expect(sql).toContain("jsonb_build_object('status', 'duplicate'");
  });

  it('is forward-only and additive (no destructive DDL)', () => {
    expect(sql).not.toMatch(/drop table/);
    expect(sql).not.toMatch(/drop column/);
    expect(sql).not.toMatch(/truncate/);
  });
});
