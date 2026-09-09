/**
 * 0090 — funnel observability, read from the migration text.
 *
 * These assertions read the SQL rather than the database, so a regression
 * fails in `npm test` rather than later in the Supabase job. They pin the
 * contract the observability layer depends on:
 *
 *   1. The layer is DERIVED — three views + one stored rollup + one refresh
 *      RPC — so there is no second writer of operational truth to drift.
 *   2. Everything is service-role-only: RLS enabled, revoked from
 *      anon/authenticated/public, granted to service_role, and NO policy
 *      (service_role bypasses RLS). The static-security gate rejects broad
 *      browser-role grants; these assertions keep that true from the start.
 *   3. The refresh RPC is advisory-locked (safe across replicas) and
 *      SECURITY DEFINER with execute revoked from public.
 *   4. The reference-check success metric ships as an UNWIRED placeholder.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const MIGRATION = readFileSync(
  fileURLToPath(
    new URL('../../../supabase/migrations/0090_funnel_observability.sql', import.meta.url),
  ),
  'utf8',
);

describe('0090 funnel observability migration', () => {
  it('defines the read-only role-class analytics function, immutable', () => {
    expect(MIGRATION).toMatch(
      /create or replace function screening_v2\.funnel_role_class\(p_title text\)/,
    );
    expect(MIGRATION).toMatch(/language sql\s+immutable/);
  });

  it('adds reference_check_stage_id as an unwired placeholder with a length CHECK', () => {
    expect(MIGRATION).toMatch(
      /alter table screening_v2\.ashby_job_mappings\s+add column if not exists reference_check_stage_id text/,
    );
    expect(MIGRATION).toContain('chk_ashby_job_mappings_reference_stage_id');
  });

  it('captures recruiter sync-path parse failures with a sanitized code only', () => {
    expect(MIGRATION).toMatch(/create table if not exists screening_v2\.resume_intake_failures/);
    // Sanitized stable-code shape — never provider text or resume content.
    expect(MIGRATION).toContain("failed_reason ~ '^[a-z0-9_.:-]{1,64}$'");
  });

  it('creates the stored daily rollup and the three derived views', () => {
    expect(MIGRATION).toMatch(/create table if not exists screening_v2\.funnel_stage_daily/);
    expect(MIGRATION).toMatch(/create or replace view screening_v2\.v_funnel_intake/);
    expect(MIGRATION).toMatch(/create or replace view screening_v2\.v_funnel_candidate/);
    expect(MIGRATION).toMatch(/create or replace view screening_v2\.v_funnel_failures/);
  });

  it('reads reached_reference_check off the placeholder, defaulting false', () => {
    expect(MIGRATION).toContain('reference_check_stage_id is not null');
    expect(MIGRATION).toContain('l.external_stage_id = jm.reference_check_stage_id');
  });

  it('makes the refresh RPC advisory-locked, definer, and execute-revoked from public', () => {
    expect(MIGRATION).toMatch(
      /create or replace function screening_v2\.refresh_funnel_rollup\(/,
    );
    expect(MIGRATION).toContain('security definer');
    expect(MIGRATION).toContain("pg_try_advisory_xact_lock(hashtext('screening_v2.funnel_rollup_refresh'))");
    expect(MIGRATION).toMatch(
      /revoke all on function screening_v2\.refresh_funnel_rollup\(timestamptz, integer\) from public/,
    );
    expect(MIGRATION).toMatch(
      /grant execute on function screening_v2\.refresh_funnel_rollup\(timestamptz, integer\) to service_role/,
    );
  });

  it('grants the stored objects to service_role and revokes browser roles', () => {
    for (const rel of ['resume_intake_failures', 'funnel_stage_daily']) {
      expect(MIGRATION).toContain(`revoke all on screening_v2.${rel} from anon, authenticated, public`);
      expect(MIGRATION).toContain(`grant all privileges on screening_v2.${rel} to service_role`);
    }
    for (const view of ['v_funnel_intake', 'v_funnel_candidate', 'v_funnel_failures']) {
      expect(MIGRATION).toContain(`revoke all on screening_v2.${view} from anon, authenticated, public`);
      expect(MIGRATION).toContain(`grant select on screening_v2.${view} to service_role`);
    }
  });

  it('creates the views with security_invoker so they read as the caller, not the owner', () => {
    const invokerViews = MIGRATION.match(/with \(security_invoker = true\)/g) ?? [];
    expect(invokerViews).toHaveLength(3);
  });

  it('is service-role-only: no browser-role grants, no RLS policy, no unconditional expression', () => {
    expect(MIGRATION).not.toMatch(/grant[^\n]*to[^\n]*\b(anon|authenticated)\b/i);
    expect(MIGRATION).not.toMatch(/create policy/i);
    expect(MIGRATION).not.toMatch(/using \(true\)/i);
    expect(MIGRATION).not.toMatch(/with check \(true\)/i);
  });

  it('carries the adversarial-review fixes (success terminus, grants, grain, indexes, sanitization)', () => {
    // A: qualified is a success terminus, peeled BEFORE the failure/consent
    // branches so an advanced candidate is never mislabeled as a drop.
    expect(MIGRATION).toMatch(/when base\.qualified\s+then null/);
    // E: the role-class classifier is service-role-only (no default PUBLIC execute).
    expect(MIGRATION).toContain('revoke all on function screening_v2.funnel_role_class(text) from public');
    expect(MIGRATION).toContain('grant execute on function screening_v2.funnel_role_class(text) to service_role');
    // J: hard unique grain on the rollup, NULL-role bucket treated as one value.
    expect(MIGRATION).toMatch(/create unique index if not exists uq_funnel_stage_daily_grain[\s\S]*?nulls not distinct/);
    // C: the phone_call_attempts(session_id) semi-join index.
    expect(MIGRATION).toContain('idx_phone_call_attempts_session');
    // K: length-only Ashby failed_reason is structurally sanitized in BOTH views.
    const sanitized = (MIGRATION.match(/then i\.failed_reason else 'other' end/g) ?? []).length;
    expect(sanitized).toBe(2);
    // F: the nullable call end-time is coalesced in the failures view.
    expect(MIGRATION).toContain('coalesce(c.ended_at, c.started_at)');
  });
});
