/**
 * M017 S02-T03 (ADR-0018) — the workflow-store seams for the two Ashby intake
 * types, driven against a recording PostgREST double (no network, no
 * database):
 *
 *   A. `bindLinkResumeHandle` binds only onto a `resume_parsing` link, so a
 *      resume that arrives after phone parsing was armed is never bound.
 *   B. `readLink` and `findLinkByApplicationId` select `intake_type` and map
 *      it to `intakeType`.
 *   C. `applyAshbyCandidateProfile` maps onto the 0130 §5 parameters exactly,
 *      re-applies the strict gate, sends no number with a skip reason and no
 *      name or email for resume_parsing, and fails with a fixed code.
 *   D. `recordAshbyProfileOutcome` and `claimAshbyProfileDue` (0130 §6): the
 *      write, the claim parameters, and their fixed codes.
 *   E. The TypeScript vocabularies equal the 0130 CHECK and the RPC allowlist.
 *
 * Synthetic contact data only. Every failure assertion is anchored on the bare
 * code, so an error message that forwarded a value could not pass.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createWorkflowStores } from '../integrations/ashby/workflow-stores.js';
import type {
  AshbyCandidateProfileInput,
  AshbyProfileOutcome,
  AshbyProfileSkipReason,
} from '../integrations/ashby/orchestration.js';

const MIGRATION_0130 = readFileSync(
  fileURLToPath(new URL('../../../supabase/migrations/0130_ashby_phone_parsing_intake.sql', import.meta.url)),
  'utf8',
);

const NOW = new Date('2026-10-20T06:00:00.000Z');
const LINK_ID = '11111111-1111-4111-8111-111111111111';
const ENGAGEMENT_ID = '22222222-2222-4222-8222-222222222222';
const NAME = 'Test Person';
const EMAIL = 'test.person@example.com';
const RAW = '+91 98123 45670';
const E164 = '+919812345670';

/** A recording PostgREST double: every builder and rpc call is captured in order. */
function recordingClient(answer: { data: unknown; error: unknown }) {
  const ops: Array<[string, ...unknown[]]> = [];
  const builder: Record<string, unknown> = {};
  for (const m of ['insert', 'update', 'select', 'eq', 'is', 'limit', 'single', 'maybeSingle']) {
    builder[m] = (...args: unknown[]) => { ops.push([m, ...args]); return builder; };
  }
  builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve(answer).then(resolve);
  const client = {
    from(table: string) { ops.push(['from', table]); return builder; },
    rpc(name: string, params: unknown) { ops.push(['rpc', name, params]); return Promise.resolve(answer); },
  } as unknown as SupabaseClient;
  return { client, ops };
}

/** The single rpc call a seam made: its name and parameter object. */
function onlyRpc(ops: ReadonlyArray<[string, ...unknown[]]>): { name: string; params: Record<string, unknown> } {
  const calls = ops.filter((o) => o[0] === 'rpc');
  expect(calls).toHaveLength(1);
  return { name: calls[0][1] as string, params: calls[0][2] as Record<string, unknown> };
}

/** Parameter names of a 0130 function, in declaration order. */
function signatureParameters(fn: string): string[] {
  const start = MIGRATION_0130.indexOf(`create or replace function screening_v2.${fn}(`);
  expect(start, fn).toBeGreaterThan(-1);
  const header = MIGRATION_0130.slice(start, MIGRATION_0130.indexOf('returns', start));
  return [...header.matchAll(/\b(p_[a-z0-9_]+)\s+[a-z]/g)].map((m) => m[1]);
}

/** The quoted members between `anchor` and the next `)`, from the 0130 text. */
function quotedMembersAfter(anchor: string): string[] {
  const start = MIGRATION_0130.indexOf(anchor);
  expect(start, anchor).toBeGreaterThan(-1);
  const list = MIGRATION_0130.slice(start + anchor.length, MIGRATION_0130.indexOf(')', start + anchor.length));
  return [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

function profileInput(overrides: Partial<AshbyCandidateProfileInput> = {}): AshbyCandidateProfileInput {
  return {
    applicationLinkId: LINK_ID,
    intake: 'phone_parsing',
    name: NAME,
    email: EMAIL,
    phoneRaw: RAW,
    phoneE164: E164,
    skipReason: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

// ═══════════════════════════════════════════════════════════════════════
// A. bindLinkResumeHandle
// ═══════════════════════════════════════════════════════════════════════

describe('A. bindLinkResumeHandle binds only onto a resume_parsing link', () => {
  it('adds the intake filter to the compare-and-set and writes the handle only', async () => {
    const rc = recordingClient({ data: null, error: null });
    await createWorkflowStores(rc.client).bindLinkResumeHandle!(LINK_ID, 'handle_1');
    expect(rc.ops).toEqual([
      ['from', 'ashby_application_links'],
      ['update', { external_resume_file_handle: 'handle_1' }],
      ['eq', 'provider', 'ashby'],
      ['eq', 'id', LINK_ID],
      ['eq', 'intake_type', 'resume_parsing'],
      ['is', 'external_resume_file_handle', null],
    ]);
  });

  it('a failure throws its bare code', async () => {
    const rc = recordingClient({ data: null, error: { message: 'boom handle_secret' } });
    await expect(createWorkflowStores(rc.client).bindLinkResumeHandle!(LINK_ID, 'handle_secret'))
      .rejects.toThrow(/^ashby_link_handle_backfill_error$/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// B. intake reads
// ═══════════════════════════════════════════════════════════════════════

const LINK_ROW = {
  id: LINK_ID,
  external_application_id: 'app_1',
  external_job_id: 'job_1',
  job_mapping_id: 'map_1',
  candidate_id: 'cand_1',
  session_id: null,
  invite_id: null,
  lifecycle: 'imported',
  terminal_state: null,
  external_resume_file_handle: null,
  external_candidate_id: 'ashby_cand_1',
};

describe('B. readLink and findLinkByApplicationId surface intake_type as intakeType', () => {
  it('readLink selects intake_type and maps both values', async () => {
    for (const value of ['phone_parsing', 'resume_parsing'] as const) {
      const rc = recordingClient({ data: { ...LINK_ROW, intake_type: value }, error: null });
      const row = await createWorkflowStores(rc.client).readLink(LINK_ID);
      expect(row?.intakeType).toBe(value);
      expect(row?.id).toBe(LINK_ID);
      const select = rc.ops.find((o) => o[0] === 'select')![1] as string;
      expect(select.split(',').map((s) => s.trim())).toContain('intake_type');
    }
  });

  it('readLink leaves intakeType unset for a missing or unknown value', async () => {
    for (const value of [undefined, null, 'other']) {
      const rc = recordingClient({ data: { ...LINK_ROW, intake_type: value }, error: null });
      const row = await createWorkflowStores(rc.client).readLink(LINK_ID);
      expect(row).not.toBeNull();
      expect('intakeType' in row!).toBe(false);
    }
  });

  it('findLinkByApplicationId selects intake_type and maps it', async () => {
    const rc = recordingClient({ data: { ...LINK_ROW, intake_type: 'phone_parsing' }, error: null });
    const row = await createWorkflowStores(rc.client).findLinkByApplicationId('app_1');
    expect(row?.intakeType).toBe('phone_parsing');
    expect(row?.externalCandidateId).toBe('ashby_cand_1');
    const select = rc.ops.find((o) => o[0] === 'select')![1] as string;
    expect(select.split(',').map((s) => s.trim())).toContain('intake_type');

    const legacy = recordingClient({ data: { ...LINK_ROW }, error: null });
    const legacyRow = await createWorkflowStores(legacy.client).findLinkByApplicationId('app_1');
    expect('intakeType' in legacyRow!).toBe(false);
  });

  it('a read failure keeps its bare code', async () => {
    const rc = recordingClient({ data: null, error: { message: 'column does not exist' } });
    await expect(createWorkflowStores(rc.client).readLink(LINK_ID)).rejects.toThrow(/^ashby_link_read_error$/);
    await expect(createWorkflowStores(rc.client).findLinkByApplicationId('app_1'))
      .rejects.toThrow(/^ashby_link_read_error$/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// C. applyAshbyCandidateProfile
// ═══════════════════════════════════════════════════════════════════════

describe('C. applyAshbyCandidateProfile maps onto 0130 §5', () => {
  it('the parameter names are the §5 signature, exactly and in order', async () => {
    const rc = recordingClient({ data: { status: 'eligible' }, error: null });
    await createWorkflowStores(rc.client).applyAshbyCandidateProfile!(profileInput());
    const { name, params } = onlyRpc(rc.ops);
    expect(name).toBe('apply_ashby_candidate_profile');
    expect(signatureParameters('apply_ashby_candidate_profile')).toEqual([
      'p_application_link_id', 'p_intake', 'p_name', 'p_email',
      'p_phone_raw', 'p_phone_e164', 'p_skip_reason', 'p_now',
    ]);
    expect(Object.keys(params)).toEqual(signatureParameters('apply_ashby_candidate_profile'));
  });

  it('phone_parsing with a dialable number sends name, email, raw and the strict number', async () => {
    const rc = recordingClient({ data: { status: 'eligible' }, error: null });
    await createWorkflowStores(rc.client).applyAshbyCandidateProfile!(profileInput());
    expect(onlyRpc(rc.ops).params).toEqual({
      p_application_link_id: LINK_ID,
      p_intake: 'phone_parsing',
      p_name: NAME,
      p_email: EMAIL,
      p_phone_raw: RAW,
      p_phone_e164: E164,
      p_skip_reason: null,
      p_now: NOW.toISOString(),
    });
  });

  it('resume_parsing (D3) never sends a name or an email, even when handed one', async () => {
    const rc = recordingClient({ data: { status: 'eligible' }, error: null });
    await createWorkflowStores(rc.client).applyAshbyCandidateProfile!(profileInput({ intake: 'resume_parsing' }));
    const { params } = onlyRpc(rc.ops);
    expect(params.p_intake).toBe('resume_parsing');
    expect(params.p_name).toBeNull();
    expect(params.p_email).toBeNull();
    expect(params.p_phone_e164).toBe(E164);
  });

  it('absent name and email are sent as null', async () => {
    const rc = recordingClient({ data: { status: 'eligible' }, error: null });
    await createWorkflowStores(rc.client).applyAshbyCandidateProfile!(
      profileInput({ name: undefined, email: undefined }),
    );
    const { params } = onlyRpc(rc.ops);
    expect(params.p_name).toBeNull();
    expect(params.p_email).toBeNull();
  });

  it('a skip reason sends no number, but keeps the raw value and the reason', async () => {
    for (const skipReason of ['name_missing', 'number_invalid', 'number_placeholder'] as const) {
      const rc = recordingClient({ data: { status: 'pending_prereqs' }, error: null });
      await createWorkflowStores(rc.client).applyAshbyCandidateProfile!(profileInput({ skipReason }));
      const { params } = onlyRpc(rc.ops);
      expect(params.p_phone_e164).toBeNull();
      expect(params.p_skip_reason).toBe(skipReason);
      expect(params.p_phone_raw).toBe(RAW);
    }
  });

  it('the strict gate is re-applied at the write: a non-strict number is never sent', async () => {
    for (const phoneE164 of ['+14155552671', '+912212345678', '+915876543210', 'garbage', null]) {
      const rc = recordingClient({ data: { status: 'pending_prereqs' }, error: null });
      await createWorkflowStores(rc.client).applyAshbyCandidateProfile!(profileInput({ phoneE164 }));
      expect(onlyRpc(rc.ops).params.p_phone_e164).toBeNull();
    }
  });

  it('maps the answer to codes and flags only', async () => {
    const rc = recordingClient({
      data: {
        status: 'eligible', engagement_id: ENGAGEMENT_ID, profile_outcome: 'applied',
        number_applied: true, identity_applied: true, intake_stamped: true,
      },
      error: null,
    });
    await expect(createWorkflowStores(rc.client).applyAshbyCandidateProfile!(profileInput())).resolves.toEqual({
      status: 'eligible',
      engagementId: ENGAGEMENT_ID,
      profileOutcome: 'applied',
      numberApplied: true,
      identityApplied: true,
      intakeStamped: true,
    });
  });

  it('an early exit has no outcome, no engagement and every flag false', async () => {
    const rc = recordingClient({ data: { status: 'invalid_request' }, error: null });
    const result = await createWorkflowStores(rc.client).applyAshbyCandidateProfile!(profileInput());
    expect(result).toEqual({
      status: 'invalid_request',
      profileOutcome: null,
      numberApplied: false,
      identityApplied: false,
      intakeStamped: false,
    });
    expect('engagementId' in result).toBe(false);

    const empty = recordingClient({ data: null, error: null });
    expect((await createWorkflowStores(empty.client).applyAshbyCandidateProfile!(profileInput())).status).toBe('error');
  });

  it('an outcome outside the closed vocabulary reads as null, never echoed', async () => {
    // The profile job logs this value, so anything but a 0130 code is dropped.
    for (const profile_outcome of ['resume_bound', 'Applied', `dialled ${E164}`, 7]) {
      const rc = recordingClient({ data: { status: 'eligible', profile_outcome }, error: null });
      const result = await createWorkflowStores(rc.client).applyAshbyCandidateProfile!(profileInput());
      expect(result.profileOutcome).toBeNull();
    }
  });

  it('flags are true only when the RPC answers a boolean true', async () => {
    const rc = recordingClient({
      data: { status: 'pending_prereqs', number_applied: 'true', identity_applied: 1, intake_stamped: null },
      error: null,
    });
    const result = await createWorkflowStores(rc.client).applyAshbyCandidateProfile!(profileInput());
    expect(result.numberApplied).toBe(false);
    expect(result.identityApplied).toBe(false);
    expect(result.intakeStamped).toBe(false);
  });

  it('an RPC error throws the bare fixed code, never the database message', async () => {
    const rc = recordingClient({
      data: null,
      error: { message: `failing row contains (${NAME}, ${EMAIL}, ${E164})`, code: '23514' },
    });
    const attempt = createWorkflowStores(rc.client).applyAshbyCandidateProfile!(profileInput());
    await expect(attempt).rejects.toThrow(/^ashby_candidate_profile_error$/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// D. recordAshbyProfileOutcome and claimAshbyProfileDue
// ═══════════════════════════════════════════════════════════════════════

describe('D. recordAshbyProfileOutcome is a plain write of the two columns', () => {
  it('updates profile_outcome and profile_checked_at on the one Ashby link', async () => {
    const rc = recordingClient({ data: null, error: null });
    await createWorkflowStores(rc.client).recordAshbyProfileOutcome!(LINK_ID, 'resume_shape_unknown');
    expect(rc.ops).toEqual([
      ['from', 'ashby_application_links'],
      ['update', { profile_outcome: 'resume_shape_unknown', profile_checked_at: NOW.toISOString() }],
      ['eq', 'provider', 'ashby'],
      ['eq', 'id', LINK_ID],
    ]);
  });

  it('a failure throws its bare code', async () => {
    const rc = recordingClient({ data: null, error: { message: 'violates check constraint' } });
    await expect(createWorkflowStores(rc.client).recordAshbyProfileOutcome!(LINK_ID, 'stage_moved'))
      .rejects.toThrow(/^ashby_profile_outcome_write_error$/);
  });
});

describe('D. claimAshbyProfileDue calls the 0130 §6 claim', () => {
  it('passes the limit and the fixed age, backoff and attempt parameters', async () => {
    const rc = recordingClient({ data: [], error: null });
    await createWorkflowStores(rc.client).claimAshbyProfileDue!({ limit: 25 });
    const { name, params } = onlyRpc(rc.ops);
    expect(name).toBe('claim_ashby_profile_due');
    expect(params).toEqual({
      p_limit: 25,
      p_min_age_seconds: 900,
      p_retry_seconds: 21_600,
      p_max_attempts: 4,
      p_now: NOW.toISOString(),
    });
    expect(Object.keys(params)).toEqual(signatureParameters('claim_ashby_profile_due'));
  });

  it('returns the claimed link ids and drops malformed rows', async () => {
    const other = '33333333-3333-4333-8333-333333333333';
    const rc = recordingClient({
      data: [{ application_link_id: LINK_ID }, { application_link_id: null }, null, {}, { application_link_id: other }],
      error: null,
    });
    await expect(createWorkflowStores(rc.client).claimAshbyProfileDue!({ limit: 25 }))
      .resolves.toEqual([LINK_ID, other]);
  });

  it('an empty or non-array answer claims nothing', async () => {
    for (const data of [null, [], { application_link_id: LINK_ID }]) {
      const rc = recordingClient({ data, error: null });
      await expect(createWorkflowStores(rc.client).claimAshbyProfileDue!({ limit: 25 })).resolves.toEqual([]);
    }
  });

  it('a failure throws its bare code', async () => {
    const rc = recordingClient({ data: null, error: { message: 'canceling statement due to lock timeout' } });
    await expect(createWorkflowStores(rc.client).claimAshbyProfileDue!({ limit: 25 }))
      .rejects.toThrow(/^ashby_profile_due_claim_error$/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// E. vocabularies
// ═══════════════════════════════════════════════════════════════════════

describe('E. the TypeScript vocabularies are the 0130 ones', () => {
  it('AshbyProfileOutcome is exactly the profile_outcome CHECK', () => {
    // A Record over the union fails to compile when a member is missing or
    // extra, so the keys are the union.
    const outcomes: Record<AshbyProfileOutcome, true> = {
      applied: true, number_invalid: true, number_placeholder: true, number_shared: true,
      name_missing: true, resume_found: true, resume_shape_unknown: true, stage_moved: true,
      application_inactive: true, mapping_inactive: true, subject_request_hold: true,
      engagement_active: true, not_applicable: true, ashby_unavailable: true,
      identity_unconfirmed: true, application_terminal: true, candidate_missing: true,
    };
    const check = quotedMembersAfter('chk_ashby_application_links_profile_outcome check (profile_outcome is null or profile_outcome in (');
    expect(check.length).toBe(17);
    expect(Object.keys(outcomes).sort()).toEqual([...check].sort());
  });

  it('AshbyProfileSkipReason is exactly what the §5 RPC accepts', () => {
    const reasons: Record<AshbyProfileSkipReason, true> = {
      number_invalid: true, number_placeholder: true, name_missing: true,
    };
    const accepted = quotedMembersAfter('and p_skip_reason not in (');
    expect(Object.keys(reasons).sort()).toEqual([...accepted].sort());
  });
});
