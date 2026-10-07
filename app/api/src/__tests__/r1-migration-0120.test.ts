/**
 * Static guarantees for migration 0120 (R1 candidate-route primitives). The
 * behavioural SQL assertions run in supabase-ci
 * (app/supabase/tests/r1_candidate_routes_assert.sql, wired by
 * scripts/test-r1-foundation.sh); these checks keep the migration additive,
 * least-privilege and in step with the TypeScript contract it serves.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrations = path.resolve(here, '../../../supabase/migrations');
const FILE = '0120_r1_candidate_route_primitives.sql';
const sql = readFileSync(path.join(migrations, FILE), 'utf8').replace(/\r\n/g, '\n');
const code = sql.replace(/^\s*--.*$/gm, '');

const FUNCTIONS = [
  ['r1_reserve_preflight', 'uuid, text, timestamptz'],
  ['r1_settle_attempt', 'uuid, text, timestamptz'],
  ['r1_withdraw_consent', 'uuid, jsonb, timestamptz, text'],
] as const;

/** The one trigger function: it guards the audience column, and is not part of the route surface. */
const AUDIENCE_GUARD = 'reject_interview_round_audience_change';

const WORKER_OUTCOMES = [
  'complete',
  'candidate_left',
  'no_show',
  'provider_error',
  'residency_timeout',
  'shutdown_forced',
  'configuration_failed',
  'context_failed',
];

/** The code with all whitespace runs collapsed: matches survive line wrapping. */
const flat = code.replace(/\s+/g, ' ');

function between(text: string, from: string, to: string): string {
  const start = text.indexOf(from);
  expect(start, from).toBeGreaterThan(-1);
  const end = text.indexOf(to, start + from.length);
  expect(end, to).toBeGreaterThan(start);
  return text.slice(start + from.length, end);
}

function quotedList(text: string): string[] {
  return [...text.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]!);
}

describe('migration 0120', () => {
  it('uses the number assigned to PR-3 and no other migration claims it', () => {
    const claimed = readdirSync(migrations).filter((name) => name.startsWith('0120_'));
    expect(claimed).toEqual([FILE]);
  });

  it('sets a lock timeout and is additive: no drop, no shared DDL, no replaced function', () => {
    expect(code).toMatch(/set local lock_timeout = '10s';/);
    expect(code).not.toMatch(/\bdrop\b/i);
    // The one ALTER is the audience column on R1's own table (see the next test).
    expect(code.match(/\balter\s+table\b/gi)).toHaveLength(1);
    expect(flat).toContain('alter table screening_v2.interview_rounds add column if not exists');
    expect(code).not.toMatch(/\bdelete\s+from\b|\btruncate\b/i);
    for (const existing of [
      'r1_admit_attempt',
      'r1_send_round',
      'r1_transition_round',
      'r1_release_round_hold',
      'r1_record_usage',
      'r1_sweep_expired_rounds',
    ]) {
      expect(code, existing).not.toMatch(new RegExp(`function\\s+screening_v2\\.${existing}\\b`));
    }
    expect(code).not.toMatch(/phone_|consent_records|consent_templates\b/);
    expect(code.match(/create or replace function/g)).toHaveLength(FUNCTIONS.length + 1);
  });

  it('adds the server-owned consent audience: candidate by default, two values only', () => {
    const column = between(flat, 'alter table screening_v2.interview_rounds ', ';');
    expect(column).toContain("add column if not exists consent_locale text not null default 'en-IN'");
    expect(column).toContain('constraint chk_interview_rounds_consent_locale');
    // The same two locales PR-CT's 0123 ships and the route's allow-list names.
    const allowed = between(column, 'check (consent_locale in (', '))');
    expect([...allowed.matchAll(/'([^']+)'/g)].map((match) => match[1]).sort())
      .toEqual(['en-IN', 'en-IN-x-staff'].sort());
  });

  it('locks the audience once the round has a consent record or has left invited', () => {
    const guard = between(
      flat,
      `create or replace function screening_v2.${AUDIENCE_GUARD}() returns trigger`,
      '$$; create or replace trigger',
    );
    // SECURITY DEFINER with a pinned path, so row level security cannot hide the consent row.
    expect(guard).toContain('language plpgsql security definer set search_path = pg_catalog, screening_v2');
    // Only a CHANGE of the value is refused, and only after a consent exists or `invited` is left.
    expect(guard).toContain('new.consent_locale is distinct from old.consent_locale');
    expect(guard).toContain("old.status <> 'invited'");
    expect(guard).toMatch(
      /exists \( select 1 from screening_v2\.interview_round_consents c where c\.round_id = old\.id \)/,
    );
    expect(guard).toContain("errcode = 'P0001'");
    // Fired for any UPDATE that names the column, on every row, before the write.
    expect(flat).toContain(
      'create or replace trigger trg_interview_rounds_audience_locked '
        + 'before update of consent_locale on screening_v2.interview_rounds '
        + `for each row execute function screening_v2.${AUDIENCE_GUARD}();`,
    );
  });

  it.each(FUNCTIONS)('%s: SECURITY DEFINER, pinned path, service_role', (name, signature) => {
    const definition = new RegExp(
      `create or replace function screening_v2\\.${name}\\([\\s\\S]*?\\)\\s*returns jsonb`
        + '\\s*language plpgsql\\s*security definer'
        + '\\s*set search_path = pg_catalog, screening_v2\\s*as \\$\\$',
    );
    expect(code).toMatch(definition);
    expect(code).toContain(
      `revoke all on function screening_v2.${name}(${signature})\n`
        + '  from public, anon, authenticated;',
    );
    expect(code).toContain(
      `grant execute on function screening_v2.${name}(${signature})\n  to service_role;`,
    );
  });

  it('every security definer function in the file pins its search_path', () => {
    const definers = code.match(/security definer/g)?.length ?? 0;
    const pins = code.match(/set search_path = pg_catalog, screening_v2/g)?.length ?? 0;
    // The three route functions plus the audience guard.
    expect(definers).toBe(FUNCTIONS.length + 1);
    expect(pins).toBe(definers);
  });

  it('caps preflight at 10 per link and 3 per minute and charges 10 seconds', () => {
    expect(code).toMatch(/v_total >= 10/);
    expect(code).toMatch(/v_recent >= 3/);
    expect(code).toMatch(/interval '1 minute'/);
    expect(code).toMatch(/'preflight', 'usage', 10, p_event_key/);
    // chk_r1_usage_event_bounds allows at most 15 s for a preflight row.
    expect(10).toBeLessThanOrEqual(15);
    expect(code).toMatch(/for update/);
  });

  it('settles exactly the outcomes the worker and the route accept', () => {
    const list = /p_outcome not in \(([\s\S]*?)\)\s*then/.exec(code)!;
    expect(quotedList(list[1]!).sort()).toEqual([...WORKER_OUTCOMES].sort());
  });

  it('applies plan decision D1: complete counts; early exits and system failures do not', () => {
    const counted = /v_counted := ([\s\S]*?);\n/.exec(code)!;
    expect(counted[1]).toMatch(/p_outcome = 'complete'/);
    expect(quotedList(/p_outcome in \(([^)]*)\)/.exec(counted[1]!)![1]!).sort())
      .toEqual(['candidate_left', 'residency_timeout']);
    const neverCount = [
      'no_show', 'provider_error', 'shutdown_forced', 'configuration_failed', 'context_failed',
    ];
    for (const neverCounts of neverCount) {
      expect(counted[1], neverCounts).not.toContain(neverCounts);
    }
    // "TRANSITION reached" is derived from the phases the 0116 CHECK defines.
    const phases = quotedList(/t\.phase in \(([^)]*)\)/.exec(code)![1]!);
    const allowed = quotedList(
      /chk_transcript_turns_phase\s+check \(phase in \(([^)]*)\)/.exec(
        readFileSync(path.join(migrations, '0116_r1_shared_session_fields.sql'), 'utf8')
          .replace(/\r\n/g, '\n'),
      )![1]!,
    );
    expect(phases).toEqual(allowed.slice(allowed.indexOf('transition')));
    expect(code).toMatch(/v_round\.attempts_counted >= v_round\.attempts_allowed/);
  });

  it('settles idempotently, locking the round before the attempt, never settings', () => {
    expect(code).toMatch(/'status', 'duplicate'/);
    expect(code).toMatch(/'status', 'outcome_conflict'/);
    const roundLock = code.indexOf(
      'select * into v_round from screening_v2.interview_rounds where id = v_round_id for update',
    );
    const attemptLock = code.indexOf(
      'from screening_v2.interview_round_attempts\n'
        + '   where session_id = p_session_id\n     for update',
    );
    expect(roundLock).toBeGreaterThan(-1);
    expect(attemptLock).toBeGreaterThan(roundLock);
    expect(code).not.toMatch(/r1_settings|r1_budget_month/);
  });

  it('withdraws under the round lock so it serializes with admission', () => {
    expect(code).toMatch(
      /perform 1 from screening_v2\.interview_rounds where id = p_round_id for update;/,
    );
    expect(code).toMatch(/'created', 'waiting', 'in_progress'/);
  });

  describe('consent evidence (DPDP)', () => {
    const update = between(
      flat,
      'update screening_v2.interview_round_consents set withdrawn_at = p_now,',
      'where round_id = p_round_id and withdrawn_at is null;',
    );

    it('keeps the grant proof and nests the withdrawal context instead of merging over it', () => {
      // proof = <existing proof> || { decision, withdrawn_at, withdrawal: <request context> }:
      // the request's ip_prefix / user_agent can never replace the grant's.
      expect(update).toContain("proof = coalesce(proof, '{}'::jsonb) || jsonb_build_object(");
      expect(update).toContain("'withdrawal', coalesce(p_proof, '{}'::jsonb)");
      // p_proof is never concatenated at the top level.
      expect(update.replace("'withdrawal', coalesce(p_proof, '{}'::jsonb)", ''))
        .not.toContain('p_proof');
      expect(update).toContain("'decision', p_decision");
      expect(update).toContain("'withdrawn_at', p_now");
    });

    it('stores `withdrawn` by default and `declined` on request, refusing anything else', () => {
      expect(code).toMatch(/p_decision text default 'withdrawn'/);
      expect(flat).toContain(
        "if p_decision is null or p_decision not in ('withdrawn', 'declined') then "
          + "return jsonb_build_object('status', 'invalid_decision');",
      );
      // Validated before the round lock is taken: a bad call locks nothing.
      expect(code.indexOf("'invalid_decision'"))
        .toBeLessThan(code.indexOf('perform 1 from screening_v2.interview_rounds'));
    });
  });

  describe('settling: session state and round closing', () => {
    const settle = new RegExp(
      'create or replace function screening_v2\\.r1_settle_attempt[\\s\\S]*?\\n\\$\\$;',
    ).exec(code)![0];
    const flatSettle = settle.replace(/\s+/g, ' ');

    it('only settles a terminal browser session of the attempt\'s own round', () => {
      expect(flatSettle).toContain(
        'from screening_v2.call_sessions s where s.id = p_session_id',
      );
      expect(flatSettle).toContain("v_session_mode is distinct from 'browser'");
      expect(flatSettle).toContain('v_session_round is distinct from v_attempt.round_id');
      expect(flatSettle).toContain(
        "v_session_status not in ('completed', 'failed', 'cancelled', 'expired')",
      );
      expect(flatSettle).toContain(
        "(p_outcome = 'complete' and v_session_status <> 'completed') then "
          + "return jsonb_build_object('status', 'session_not_settled')",
      );
    });

    it('checks the session AFTER the idempotency answers and BEFORE any write', () => {
      const duplicate = settle.indexOf("'status', 'duplicate'");
      const conflict = settle.indexOf("'status', 'outcome_conflict'");
      const state = settle.indexOf("'session_not_settled'");
      const firstWrite = settle.indexOf('update screening_v2.interview_round_attempts');
      expect(duplicate).toBeGreaterThan(-1);
      expect(state).toBeGreaterThan(duplicate);
      expect(state).toBeGreaterThan(conflict);
      expect(firstWrite).toBeGreaterThan(state);
    });

    it('closes an open round in the same statement as the count, never a cancelled one', () => {
      const counted = between(
        flatSettle,
        'update screening_v2.interview_rounds set attempts_counted = attempts_counted + 1,',
        'where id = v_round_id;',
      );
      expect(counted).toContain(
        "status = case when status in ('invited', 'in_progress') then 'completed' "
          + 'else status end',
      );
      expect(counted).toContain('version = version + 1');
      // One UPDATE: the count and the closing can never be observed apart.
      expect(settle.match(/update screening_v2\.interview_rounds/g)).toHaveLength(1);
    });

    it('does not touch capacity: restoring an uncounted hold belongs to PR-5', () => {
      expect(settle).not.toMatch(/minutes_used|minutes_reserved|held_minutes/);
      expect(sql.replace(/\s+/g, ' ')).toContain("belongs to PR-5's r1.sweep");
    });
  });
});
