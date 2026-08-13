/**
 * Ashby integration schema (0029) — domain unit tests + migration structural
 * proofs. The domain tests assert the DB-free parity logic; the structural
 * block reads the migration and proves the security/model invariants
 * (unique identities, fail-closed RLS, service-role-only RPCs with pinned
 * search_path, fixed 24h TTL, state/dependency/terminal enforcement, and the
 * absence of PII/token/body-shaped columns).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ASHBY_PROVIDER,
  ASHBY_INVITE_TTL_HOURS,
  DELIVERY_MODES,
  INGESTION_STATES,
  OPERATION_TYPES,
  OPERATION_STATES,
  APPLICATION_TERMINAL_STATES,
  isValidIngestionTransition,
  canOperationEnterState,
  isMappingComplete,
  isValidDeliveryMode,
  isValidInviteTtlHours,
  evaluateMappingEnable,
  canCreateOperation,
  findForbiddenOperationalKeys,
  isOperationalPayloadSafe,
  type IngestionState,
} from '../integrations/ashby/integration-schema.js';

const SQL = readFileSync(
  fileURLToPath(new URL('../../../../app/supabase/migrations/0029_ashby_integration.sql', import.meta.url)),
  'utf8',
);
const sql = SQL.toLowerCase();

// ═══════════════════════════════════════════════════════════════════════
// Domain: enumerations + parity anchors
// ═══════════════════════════════════════════════════════════════════════

describe('enumerations', () => {
  it('exposes the documented provider, TTL, and enums', () => {
    expect(ASHBY_PROVIDER).toBe('ashby');
    expect(ASHBY_INVITE_TTL_HOURS).toBe(24);
    expect(DELIVERY_MODES).toEqual(['email', 'manual', 'both']);
    expect(INGESTION_STATES).toEqual(['queued', 'fetching', 'scanning', 'extracting', 'structuring', 'ready', 'failed_review', 'cancelled']);
    expect(OPERATION_TYPES).toEqual(['invite_delivery', 'scorecard_write', 'stage_move']);
    expect(OPERATION_STATES).toEqual(['pending', 'running', 'succeeded', 'failed', 'blocked', 'cancelled']);
    expect(APPLICATION_TERMINAL_STATES).toEqual(['withdrawn', 'deleted', 'manual_stage_cancel']);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Domain: ingestion state machine (parity with the DB trigger)
// ═══════════════════════════════════════════════════════════════════════

describe('ingestion state machine', () => {
  it('permits the happy path and same-state no-ops', () => {
    const happy: IngestionState[] = ['queued', 'fetching', 'scanning', 'extracting', 'structuring', 'ready'];
    for (let i = 0; i < happy.length - 1; i++) {
      expect(isValidIngestionTransition(happy[i], happy[i + 1])).toBe(true);
    }
    for (const s of INGESTION_STATES) expect(isValidIngestionTransition(s, s)).toBe(true);
  });

  it('permits failure and cancel branches, and failed_review retry', () => {
    expect(isValidIngestionTransition('scanning', 'failed_review')).toBe(true);
    expect(isValidIngestionTransition('fetching', 'cancelled')).toBe(true);
    expect(isValidIngestionTransition('failed_review', 'queued')).toBe(true);
    expect(isValidIngestionTransition('failed_review', 'cancelled')).toBe(true);
  });

  it('rejects skips, backward moves, and transitions out of terminal states', () => {
    expect(isValidIngestionTransition('queued', 'ready')).toBe(false);        // skip
    expect(isValidIngestionTransition('extracting', 'fetching')).toBe(false); // backward
    expect(isValidIngestionTransition('ready', 'queued')).toBe(false);        // terminal
    expect(isValidIngestionTransition('cancelled', 'queued')).toBe(false);    // terminal
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Domain: operation dependency ordering (scorecard-before-stage)
// ═══════════════════════════════════════════════════════════════════════

describe('operation dependency ordering', () => {
  it('blocks running/succeeded until the dependency has succeeded', () => {
    expect(canOperationEnterState('running', 'pending')).toBe(false);
    expect(canOperationEnterState('running', 'running')).toBe(false);
    expect(canOperationEnterState('succeeded', 'failed')).toBe(false);
    expect(canOperationEnterState('running', 'succeeded')).toBe(true);
    expect(canOperationEnterState('succeeded', 'succeeded')).toBe(true);
  });

  it('does not restrict non-runnable transitions or dependency-free operations', () => {
    expect(canOperationEnterState('pending', 'pending')).toBe(true);
    expect(canOperationEnterState('blocked', undefined)).toBe(true);
    expect(canOperationEnterState('running', null)).toBe(true); // no dependency
    expect(canOperationEnterState('failed', 'pending')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Domain: mapping enable gate (completeness / delivery / TTL / drift)
// ═══════════════════════════════════════════════════════════════════════

describe('mapping enable gate', () => {
  const base = { deliveryMode: 'manual', inviteTtlHours: 24, aiScreeningStageId: 'ai_1', taScreeningStageId: 'ta_1' };

  it('allows paused regardless of completeness', () => {
    expect(evaluateMappingEnable({ ...base, status: 'paused', aiScreeningStageId: null, taScreeningStageId: null })).toEqual({ ok: true });
  });

  it('allows enabling a complete, valid mapping', () => {
    expect(evaluateMappingEnable({ ...base, status: 'enabled' })).toEqual({ ok: true });
  });

  it('rejects enabling an incomplete mapping', () => {
    expect(evaluateMappingEnable({ ...base, status: 'enabled', aiScreeningStageId: null })).toEqual({ ok: false, reason: 'incomplete_cannot_enable' });
    expect(isMappingComplete({ aiScreeningStageId: 'x', taScreeningStageId: null })).toBe(false);
  });

  it('rejects enabling a drifted mapping', () => {
    expect(evaluateMappingEnable({ ...base, status: 'enabled' }, 'drift')).toEqual({ ok: false, reason: 'drifted_cannot_enable' });
  });

  it('rejects unknown delivery mode and non-24h TTL', () => {
    expect(evaluateMappingEnable({ ...base, status: 'enabled', deliveryMode: 'sms' })).toEqual({ ok: false, reason: 'invalid_delivery_mode' });
    expect(evaluateMappingEnable({ ...base, status: 'enabled', inviteTtlHours: 48 })).toEqual({ ok: false, reason: 'invalid_invite_ttl' });
    expect(isValidDeliveryMode('both')).toBe(true);
    expect(isValidDeliveryMode('sms')).toBe(false);
    expect(isValidInviteTtlHours(24)).toBe(true);
    expect(isValidInviteTtlHours(1)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Domain: terminal-state gate + forbidden operational payload keys
// ═══════════════════════════════════════════════════════════════════════

describe('terminal-state gate', () => {
  it('blocks new operations for a terminal application link', () => {
    for (const t of APPLICATION_TERMINAL_STATES) expect(canCreateOperation(t)).toBe(false);
    expect(canCreateOperation(null)).toBe(true);
    expect(canCreateOperation(undefined)).toBe(true);
  });
});

describe('forbidden operational payload keys', () => {
  it('detects PII/token/body-shaped keys, including nested', () => {
    expect(findForbiddenOperationalKeys({ email: 'a@b.co' })).toContain('$.email');
    expect(findForbiddenOperationalKeys({ nested: { candidate_phone: '123' } })).toContain('$.nested.candidate_phone');
    expect(findForbiddenOperationalKeys({ list: [{ invite_token: 't' }] })).toContain('$.list[0].invite_token');
    expect(findForbiddenOperationalKeys({ webhook_body: '{}' }).length).toBeGreaterThan(0);
    expect(findForbiddenOperationalKeys({ signed_url: 'https://x' }).length).toBeGreaterThan(0);
    expect(isOperationalPayloadSafe({ resume_text: 'CV' })).toBe(false);
  });

  it('accepts opaque-id-only operational payloads', () => {
    expect(isOperationalPayloadSafe({ mapping_id: 'm1', status: 'enabled', operation_key: 'k', attempts: 2 })).toBe(true);
    expect(findForbiddenOperationalKeys({ external_application_id: 'app_1', external_resume_file_handle: 'h' })).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Migration 0029 structural proofs
// ═══════════════════════════════════════════════════════════════════════

describe('0029 migration — tables + unique identities', () => {
  const tables = ['ashby_job_mappings', 'ashby_application_links', 'ashby_event_receipts', 'ashby_resume_ingestions', 'ashby_operations'];

  it('creates all five integration tables', () => {
    for (const t of tables) expect(sql).toContain(`create table if not exists screening_v2.${t}`);
  });

  it('enforces unique workflow/event/operation identities (not email/phone)', () => {
    expect(sql).toContain('unique (provider, external_job_id)');
    expect(sql).toContain('unique (provider, external_application_id)');
    expect(sql).toContain('unique (provider, webhook_action_id, action)');
    expect(sql).toContain('unique (provider, operation_key)');
    expect(sql).toContain('unique (application_link_id)'); // one ingestion per application
    // No dedup by contact fields anywhere.
    expect(sql).not.toMatch(/unique \([^)]*\bemail\b[^)]*\)/);
    expect(sql).not.toMatch(/unique \([^)]*\bphone\b[^)]*\)/);
  });
});

describe('0029 migration — fail-closed RLS + privileges', () => {
  const tables = ['ashby_job_mappings', 'ashby_application_links', 'ashby_event_receipts', 'ashby_resume_ingestions', 'ashby_operations'];

  it('enables RLS, revokes browser roles, and grants only service_role on every table', () => {
    for (const t of tables) {
      expect(sql).toContain(`alter table screening_v2.${t} enable row level security`);
      expect(sql).toContain(`revoke all on screening_v2.${t} from anon, authenticated, public`);
      expect(sql).toContain(`grant all privileges on screening_v2.${t} to service_role`);
    }
    // No browser-role policy or unconditional RLS anywhere.
    expect(sql).not.toMatch(/create policy[\s\S]*?to\s+(anon|authenticated|public)/);
    expect(sql).not.toContain('using (true)');
    expect(sql).not.toContain('with check (true)');
  });
});

describe('0029 migration — model constraints', () => {
  it('fixes the invite TTL to 24h and constrains delivery mode + statuses', () => {
    expect(sql).toContain('check (invite_ttl_hours = 24)');
    expect(sql).toContain("check (delivery_mode in ('email','manual','both'))");
    expect(sql).toContain("check (status in ('paused','enabled','drift'))");
    // Completeness: enabled requires both stage IDs.
    expect(sql).toMatch(/status <> 'enabled'[\s\S]*ai_screening_stage_id is not null and ta_screening_stage_id is not null/);
  });

  it('constrains the ingestion state machine and operation type/state enums', () => {
    expect(sql).toContain("state in ('queued','fetching','scanning','extracting','structuring','ready','failed_review','cancelled')");
    expect(sql).toContain("operation_type in ('invite_delivery','scorecard_write','stage_move')");
    expect(sql).toContain("state in ('pending','running','succeeded','failed','blocked','cancelled')");
    expect(sql).toContain("terminal_state in ('withdrawn','deleted','manual_stage_cancel')");
  });

  it('installs the state-machine, dependency, and terminal-block triggers', () => {
    expect(sql).toContain('create trigger trg_ashby_ingestion_transition');
    expect(sql).toContain('create trigger trg_ashby_operation_dependency');
    expect(sql).toContain('create trigger trg_ashby_operation_not_terminal');
    // Dependency guard blocks running/succeeded before prerequisite succeeds.
    expect(sql).toMatch(/new\.state in \('running','succeeded'\)/);
  });

  it('declares no contact/token/resume-text/body columns on operational tables', () => {
    // Assert forbidden fragments never appear as a COLUMN DECLARATION (a name
    // at the start of a line followed by a type). Enum VALUES like
    // delivery_mode in ('email',…) are quoted and correctly not matched.
    const forbidden = ['email', 'phone', 'contact', 'resume_text', 'resume_url', 'signed_url', 'webhook_body', 'raw_body', 'token', 'secret'];
    for (const t of ['ashby_event_receipts', 'ashby_operations', 'ashby_resume_ingestions', 'ashby_job_mappings', 'ashby_application_links']) {
      const start = sql.indexOf(`create table if not exists screening_v2.${t}`);
      const block = sql.slice(start, sql.indexOf('\n);', start));
      for (const f of forbidden) {
        expect(new RegExp(`\\n\\s+[a-z0-9_]*${f}[a-z0-9_]*\\s+(uuid|text|jsonb|integer|boolean|timestamptz)`).test(block),
          `${t} must not declare a ${f} column`).toBe(false);
      }
    }
  });
});

describe('0029 migration — service-role-only SECURITY DEFINER RPCs', () => {
  const fns = ['upsert_ashby_job_mapping', 'mark_ashby_mapping_drift'];

  it('pins search_path, revokes browser roles, and grants service_role for each RPC', () => {
    for (const fn of fns) {
      expect(sql).toContain(`create or replace function screening_v2.${fn}`);
      expect(sql).toMatch(new RegExp(`revoke all on function screening_v2\\.${fn}\\([^)]*\\)\\s*\\n?\\s*from public, anon, authenticated`));
      expect(sql).toMatch(new RegExp(`grant execute on function screening_v2\\.${fn}\\([^)]*\\)\\s*\\n?\\s*to service_role`));
    }
    // Both RPCs are SECURITY DEFINER with a pinned search_path.
    expect((sql.match(/security definer/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((sql.match(/set search_path = pg_catalog, screening_v2/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('adds the two Ashby audit actions additively', () => {
    expect(sql).toContain("'ashby_mapping_update', 'ashby_mapping_drift'");
  });
});
