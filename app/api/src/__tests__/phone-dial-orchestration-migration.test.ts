/**
 * 0112 — phone dial orchestration hardening, asserted against the migration
 * TEXT (M009 / S01, PR-A: E1 index narrowing, E2 agent name, E3 redial hold).
 *
 * The three redeclared functions are pinned as "the previous body plus ONLY
 * the stated deltas": each is diffed line-by-line against the migration that
 * last declared it (0079 for the two voice-worker RPCs, 0096 for the reaper).
 * A silent edit anywhere else in a lifted body — a dropped grace predicate, a
 * reordered lock, a lost audit key — fails here rather than shipping as a
 * "verbatim" copy that is not.
 *
 * WHAT THIS FILE CANNOT DO is prove behaviour — text is not execution. The
 * real-Postgres cases live in app/supabase/tests/policy_tests.sql (run on the
 * full chain by scripts/supabase-test.sh), and the DROP INDEX sanction is
 * pinned by scripts/migrate-rollback.test.mjs.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { MIGRATION_0112, PHONE_MIGRATIONS, functionBody } from './support/phone-migration.js';

const read = (file: string): string =>
  readFileSync(
    fileURLToPath(new URL(`../../../supabase/migrations/${file}`, import.meta.url)),
    'utf8',
  ).replace(/\r\n/g, '\n');

// Normalised to LF so a Windows (CRLF) checkout diffs the same as CI.
const M0112 = MIGRATION_0112.replace(/\r\n/g, '\n');
const M0079 = read('0079_voice_worker_leases.sql');
const M0096 = read('0096_phone_live_call_protection.sql');

/** One `create or replace function` from its header to its own `\n$$;`. */
function bodyIn(sql: string, name: string): string {
  const anchor = `create or replace function screening_v2.${name}(`;
  const start = sql.indexOf(anchor);
  if (start === -1) throw new Error(`function not declared: ${name}`);
  if (sql.indexOf(anchor, start + 1) !== -1) throw new Error(`declared twice: ${name}`);
  const end = sql.indexOf('\n$$;', start);
  if (end === -1) throw new Error(`function unterminated: ${name}`);
  return sql.slice(start, end + 4);
}

/**
 * Lines in `next` that are not in `prev`, and lines in `prev` that are not in
 * `next`, as a multiset LCS-free diff. Good enough to pin "only these lines
 * were added, none removed or edited" for a verbatim lift.
 */
function lineDelta(prev: string, next: string): { added: string[]; removed: string[] } {
  const a = prev.split('\n');
  const b = next.split('\n');
  // Classic LCS so a moved line counts as removed + added, not as unchanged.
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const added: string[] = [];
  const removed: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      removed.push(a[i]);
      i += 1;
    } else {
      added.push(b[j]);
      j += 1;
    }
  }
  removed.push(...a.slice(i));
  added.push(...b.slice(j));
  return { added, removed };
}

/** Comment-only and blank lines carry no behaviour. */
const code = (lines: string[]): string[] =>
  lines.map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('--'));

/** SQL with `--` comments stripped (no string in this file contains `--`). */
const stripComments = (sql: string): string => sql.replace(/--[^\n]*/g, '');

describe('0112 — harness registration', () => {
  it('is registered ahead of 0096, so the extractors read its reclaim body', () => {
    // ORDER, NOT POSITION: 0113 (PR-B) now leads. What the extractors depend
    // on is that 0112 is present and outranks the body it supersedes.
    expect(PHONE_MIGRATIONS.findIndex((m) => m.name === '0112')).toBeGreaterThan(-1);
    expect(PHONE_MIGRATIONS.findIndex((m) => m.name === '0112')).toBeLessThan(
      PHONE_MIGRATIONS.findIndex((m) => m.name === '0096'),
    );
  });

  it("RESOLVES reclaim_phone_attempt_leases TO 0112, not 0096's superseded body", () => {
    // Anchored on text only the new body has: deleting the 0112 line from
    // PHONE_MIGRATIONS fails here instead of silently reverting to 0096.
    const body = functionBody('reclaim_phone_attempt_leases');
    expect(body).toContain('v_redial_at');
    expect(body).toContain("'redial_not_before'");
  });
});

describe('0112 — file shape', () => {
  it('opens with a LOCAL lock_timeout and ends by reloading the PostgREST schema', () => {
    const statements = stripComments(M0112).trim();
    expect(statements.startsWith("set local lock_timeout = '10s';")).toBe(true);
    expect(statements.endsWith("notify pgrst, 'reload schema';")).toBe(true);
  });

  it('writes no rows: no DML outside function bodies', () => {
    // Remove every $$ ... $$ body (functions and the DO guard), then look for
    // top-level DML.
    const topLevel = stripComments(M0112).replace(/\$\$[\s\S]*?\$\$/g, '$$$$');
    expect(topLevel).not.toMatch(/^\s*(insert|update|delete|truncate)\b/im);
  });

  it('redeclares exactly the four functions the plan names, and nothing reserved for PR-B', () => {
    const declared = [...M0112.matchAll(/create or replace function screening_v2\.(\w+)\(/g)].map((m) => m[1]);
    expect(declared.sort()).toEqual([
      'claim_voice_worker',
      'reclaim_phone_attempt_leases',
      'reset_voice_worker',
      'set_voice_worker_agent_name',
    ]);
    // PR-B / 0113 owns these. The verbatim reclaim body still CALLS
    // apply_phone_event on its scored branch (unchanged from 0096); what must
    // not happen is a redeclaration or a new reference outside that call.
    for (const reserved of [
      'apply_phone_event',
      'finalize_phone_partial_sessions',
      'confirm_candidate_voice_callback',
      'sweep_phone_stranded_sessions',
      'admit_phone_attempt',
      'mark_voice_worker_ready_machine',
      'mark_voice_worker_busy',
      'list_reapable_voice_workers',
      'list_terminal_session_leases',
      'list_orphaned_voice_worker_leases',
    ]) {
      expect(M0112, reserved).not.toContain(`function screening_v2.${reserved}(`);
    }
    const applyRefs = [...stripComments(M0112).matchAll(/apply_phone_event/g)];
    expect(applyRefs).toHaveLength(1);
  });

  it('keeps the three blocks in order E1, E2, E3', () => {
    const e1 = M0112.indexOf('drop index if exists screening_v2.uq_call_sessions_phone_engagement;');
    const e2 = M0112.indexOf('add column if not exists registered_agent_name');
    const e3 = M0112.indexOf('create or replace function screening_v2.reclaim_phone_attempt_leases(');
    expect(e1).toBeGreaterThan(-1);
    expect(e2).toBeGreaterThan(e1);
    expect(e3).toBeGreaterThan(e2);
  });
});

describe('0112 E1 — the engagement claim is unique over LIVE sessions only', () => {
  const sql = stripComments(M0112);

  it('drops the table-wide index and re-creates it, after the drop, with the live predicate', () => {
    const drop = sql.indexOf('drop index if exists screening_v2.uq_call_sessions_phone_engagement;');
    const create = sql.search(
      /create unique index if not exists uq_call_sessions_phone_engagement\s+on screening_v2\.call_sessions \(phone_engagement_id\)\s+where phone_engagement_id is not null and status in \('created', 'waiting', 'in_progress'\);/,
    );
    expect(drop).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(drop);
  });

  it("the live set equals bind_phone_attempt_recording_session's live precondition (0107)", () => {
    const bind = read('0107_phone_attempt_evidence.sql');
    expect(bind).toContain("if v_sess.status not in ('created', 'waiting', 'in_progress') then");
  });

  it('adds the plain lookup index over every claimed row', () => {
    expect(sql).toMatch(
      /create index if not exists idx_call_sessions_phone_engagement\s+on screening_v2\.call_sessions \(phone_engagement_id\)\s+where phone_engagement_id is not null;/,
    );
  });

  it('carries the sanction marker as prose only (the CREATE is not quoted in a comment)', () => {
    expect(M0112).toContain('-- INDEX-NARROW SANCTION (E1)');
    const comments = [...M0112.matchAll(/--[^\n]*/g)].map((m) => m[0]).join('\n');
    expect(comments).not.toMatch(/create\s+unique\s+index/i);
  });
});

describe('0112 E2 — the per-machine agent name on the lease', () => {
  it('adds the nullable column and a guarded, validated format CHECK', () => {
    expect(M0112).toContain(
      'alter table screening_v2.voice_worker_leases\n  add column if not exists registered_agent_name text null;',
    );
    expect(M0112).toMatch(
      /if not exists \(\s*select 1\s+from pg_catalog\.pg_constraint\s+where conname = 'voice_worker_leases_registered_agent_name_format'/,
    );
    expect(M0112).toContain(
      "or registered_agent_name ~ '^[A-Za-z0-9_-]{1,64}-[0-9a-z]{8,32}$')\n      not valid;",
    );
    expect(M0112).toContain(
      'validate constraint voice_worker_leases_registered_agent_name_format;',
    );
  });

  it('set_voice_worker_agent_name: posture, injected clock, fail-closed checks, status vocabulary', () => {
    const body = bodyIn(M0112, 'set_voice_worker_agent_name');
    expect(body).toMatch(
      /\(\n  p_app        text,\n  p_machine_id text,\n  p_agent_name text,\n  p_now        timestamptz default now\(\)\n\)\nreturns jsonb\n/,
    );
    expect(body).toContain('security definer');
    expect(body).toContain('set search_path = pg_catalog, screening_v2');
    // The machine clock is read only as the p_now default.
    expect([...body.matchAll(/\bnow\(\)/g)]).toHaveLength(1);
    expect(body).not.toMatch(/clock_timestamp|current_timestamp/);
    // A machine can only record ITS OWN name.
    expect(body).toContain("if right(p_agent_name, length(p_machine_id) + 1) <> '-' || p_machine_id then");
    expect(body).toContain("p_agent_name !~ '^[A-Za-z0-9_-]{1,64}-[0-9a-z]{8,32}$'");
    expect(body).toContain("and state in ('starting', 'ready');");
    const statuses = [...body.matchAll(/'status', '([a-z_]+)'/g)].map((m) => m[1]);
    expect(new Set(statuses)).toEqual(new Set(['invalid_request', 'ok', 'stale']));
    const sig = 'screening_v2.set_voice_worker_agent_name(text, text, text, timestamptz)';
    expect(M0112).toContain(`revoke all on function ${sig}\n  from public, anon, authenticated;`);
    expect(M0112).toContain(`grant execute on function ${sig}\n  to service_role;`);
    expect(M0112).not.toMatch(/grant execute on function screening_v2\.set_voice_worker_agent_name[^;]*to (?:anon|authenticated|public)/);
  });

  it('claim_voice_worker is 0079 verbatim plus ONLY the name reset on a NEW claim and least-recently-stopped order', () => {
    const prev = bodyIn(M0079, 'claim_voice_worker');
    const next = bodyIn(M0112, 'claim_voice_worker');
    const { added, removed } = lineDelta(prev, next);
    // The ONE edited line: lowest-id-first becomes least-recently-stopped
    // first (a just-stopped, possibly still-draining machine is the last pick).
    expect(code(removed)).toEqual(['order by machine_id']);
    expect(code(added)).toEqual(['order by updated_at, machine_id', 'registered_agent_name = null,']);
    // Still the stopped-only, skip-locked single-row pick.
    expect(stripComments(next)).toMatch(
      /state = 'stopped'\s+order by updated_at, machine_id\s+limit 1\s+for update skip locked;/,
    );
    // ...and it landed in the NEW-claim update, not the idempotent branch.
    const idempotent = next.slice(0, next.indexOf("set state              = 'starting',"));
    expect(idempotent).not.toContain('registered_agent_name');
  });

  it('reset_voice_worker is 0079 verbatim plus ONLY the name reset', () => {
    const { added, removed } = lineDelta(bodyIn(M0079, 'reset_voice_worker'), bodyIn(M0112, 'reset_voice_worker'));
    expect(removed).toEqual([]);
    expect(code(added)).toEqual(['registered_agent_name = null,']);
  });

  it("re-issues 0079's exact privileges for both replaced RPCs", () => {
    for (const sig of [
      'screening_v2.claim_voice_worker(text, text, uuid, bigint, timestamptz)',
      'screening_v2.reset_voice_worker(text, text, timestamptz)',
    ]) {
      const grant = `revoke all on function ${sig}\n  from public, anon, authenticated;\ngrant execute on function ${sig}\n  to service_role;`;
      expect(M0079).toContain(grant);
      expect(M0112).toContain(grant);
    }
  });
});

describe('0112 E3 — a reclaimed engagement is held before its next dial', () => {
  const prev = bodyIn(M0096, 'reclaim_phone_attempt_leases');
  const next = bodyIn(M0112, 'reclaim_phone_attempt_leases');

  it('is 0096 verbatim plus ONLY the hold (declare, compute, SET line, audit key)', () => {
    const { added, removed } = lineDelta(prev, next);
    expect(removed).toEqual([]);
    expect(code(added)).toEqual([
      'v_redial_at timestamptz;',
      'v_redial_at := case',
      "when v_att.prior_engagement_state = 'eligible'",
      'and v_att.ist_day_seq = 1',
      "and v_att.kind in ('initial', 'no_answer_retry')",
      'then p_now + screening_v2.phone_same_day_retry_delay()',
      "when v_att.prior_engagement_state = 'eligible'",
      'then screening_v2.phone_next_window_open(',
      '(screening_v2.phone_ist_date(p_now) + 1)::timestamp',
      "at time zone 'Asia/Kolkata')",
      "when v_att.prior_engagement_state = 'scheduled'",
      "then p_now + interval '15 minutes'",
      'else null',
      'end;',
      'next_eligible_at = case when v_redial_at is null then next_eligible_at',
      'else greatest(coalesce(next_eligible_at, p_now), v_redial_at) end,',
      "'redial_not_before',",
      'case when v_restored > 0 then v_redial_at end,',
    ]);
  });

  it("uses 0095's exact next-IST-day window-open expression", () => {
    const m0095 = read('0095_phone_call_outcome_hygiene.sql');
    const expr =
      "screening_v2.phone_next_window_open(\n                         (screening_v2.phone_ist_date(p_now) + 1)::timestamp\n                           at time zone 'Asia/Kolkata')";
    expect(m0095).toContain(expr);
    const norm = (s: string) => s.replace(/\s+/g, ' ');
    expect(norm(next)).toContain(norm(expr));
  });

  it('computes the hold only in the RESTORE branch, before the engagement update', () => {
    const elseAt = next.indexOf('    else\n');
    const compute = next.indexOf('v_redial_at := case');
    const restore = next.indexOf('update screening_v2.phone_engagements');
    const scored = next.indexOf("p_event_type        => 'assessment.completed'");
    expect(scored).toBeGreaterThan(-1);
    expect(scored).toBeLessThan(elseAt);
    expect(compute).toBeGreaterThan(elseAt);
    expect(compute).toBeLessThan(restore);
  });

  it('still charges no budget and keeps the reclaim invariants', () => {
    expect(next).toContain("'budget_charged', false,");
    expect(next).not.toMatch(/no_answer_attempts|connected_attempts|budget_used/);
    expect(next).toContain('screening_v2.phone_answered_reclaim_grace()');
    // Engagement locked before the attempt (the 7374/9201 lock order).
    const engLock = next.indexOf('from screening_v2.phone_engagements\n     where id = v_row.engagement_id\n     for update skip locked;');
    const attLock = next.indexOf('select * into v_att');
    expect(engLock).toBeGreaterThan(-1);
    expect(attLock).toBeGreaterThan(engLock);
    expect(next).toContain("terminal_reason = 'grace_timeout',");
    expect([...next.matchAll(/\bnow\(\)/g)]).toHaveLength(1);
    expect(next).toMatch(/p_now\s+timestamptz default now\(\)/);
  });

  it("re-issues 0096's privileges", () => {
    const grant =
      'revoke all on function screening_v2.reclaim_phone_attempt_leases(integer, timestamptz)\n  from public, anon, authenticated;\ngrant execute on function screening_v2.reclaim_phone_attempt_leases(integer, timestamptz)\n  to service_role;';
    expect(M0096).toContain(grant);
    expect(M0112).toContain(grant);
  });
});
