/**
 * 0122: the R1 scorer migration, read from its text. The behavioural half (CAS, 24 h window,
 * override monitor, attach/supersede idempotency, funnel-view exclusion, DLQ visibility) is
 * proven on real Postgres by app/supabase/tests/r1_scorer_assert.sql through
 * scripts/test-r1-scorer.sh. These pin the contract that guards it, so a regression fails in
 * `npm test` first:
 *
 *   1. one number, additive, R1 tables only, short lock timeout, NOT VALID then VALIDATE;
 *   2. every new function is SECURITY DEFINER with a pinned search_path and is granted to
 *      service_role ONLY;
 *   3. the lock order is settings -> round -> candidate in every RPC;
 *   4. v_funnel_candidate is the 0090 text with ONLY the asmt CTE changed, and
 *      v_funnel_failures keeps the 0091 phone branches byte-for-byte;
 *   5. the audit actions it writes are in the newest chk_audit_action list;
 *   6. the admin-log vocabulary agrees across SQL, route and parser;
 *   7. the review fixes: the override window restarts on a re-enable, no status is written
 *      for a round that is not final, a stale window is dropped, the window's versions ride
 *      along on the close, and v_funnel_hr_state excludes R1 like v_funnel_candidate.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrations = path.resolve(here, '../../../supabase/migrations');
const read = (name: string) => readFileSync(path.join(migrations, name), 'utf8').replace(/\r\n/g, '\n');
const SQL = read('0122_r1_scorer.sql');
const stripComments = (sql: string) => sql.replace(/^\s*--.*$/gm, '');
const CODE = stripComments(SQL);

const FUNCTIONS = [
  'r1_attach_assessment(uuid, uuid, uuid, text, numeric, boolean, jsonb, timestamptz)',
  'r1_apply_status_effect(uuid, uuid, text, jsonb, timestamptz)',
  'r1_check_override_rate(timestamptz, integer, numeric)',
  'r1_apply_due_pending_rejects(timestamptz, integer)',
  'r1_cancel_pending_reject(uuid, uuid, timestamptz)',
];

function functionBody(name: string): string {
  const start = SQL.indexOf(`create or replace function screening_v2.${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  const end = SQL.indexOf('\n$$;', start);
  return SQL.slice(start, end);
}

describe('0122 shape', () => {
  it('is the only 0122 migration and follows 0121 in the assigned order', () => {
    const files = readdirSync(migrations).filter((file) => file.startsWith('0122_'));
    expect(files).toEqual(['0122_r1_scorer.sql']);
    expect(SQL.startsWith('-- ====')).toBe(true);
  });

  it('sets a short lock timeout before any DDL', () => {
    const lock = CODE.indexOf("set local lock_timeout = '10s';");
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(CODE.search(/\balter table\b/));
  });

  it('is additive: no destructive DDL, and only the two named constraints are dropped', () => {
    expect(CODE).not.toMatch(/\bdrop (table|column|schema|function|view|index|trigger)\b/i);
    expect(CODE).not.toMatch(/\b(delete from|truncate)\b/i);
    expect(CODE).not.toMatch(/alter column .* type/i);
    const dropped = [...CODE.matchAll(/drop constraint if exists (\w+)/g)].map((m) => m[1]);
    expect(dropped.sort()).toEqual([
      'chk_interview_rounds_status_write',
      'chk_r1_admin_log_event_type',
      'r1_admin_log_event_type_check',
    ]);
  });

  it('adds both CHECKs NOT VALID and validates them (shared-table convention)', () => {
    for (const name of ['chk_r1_admin_log_event_type', 'chk_interview_rounds_status_write']) {
      expect(CODE).toMatch(new RegExp(`add constraint ${name} check \\([\\s\\S]*?\\)\\) not valid;`));
      expect(CODE).toContain(`validate constraint ${name};`);
    }
  });

  it('touches no phone table, phone RPC or shared table outside the two restated views', () => {
    // Everything before the views: DDL and functions. (The v_funnel_failures restatement
    // legitimately carries the unchanged 0091 phone branches; the view tests pin those.)
    const beforeViews = CODE.slice(0, CODE.indexOf('create or replace view'));
    expect(beforeViews).not.toMatch(/phone_(call_attempts|engagements|appointments|control|session)/);
    expect(beforeViews).not.toMatch(/(admit|apply|start|request)_phone_/);
    expect(beforeViews).not.toMatch(/consent_(templates|records)/);
    expect(CODE).not.toMatch(/alter table screening_v2\.(candidates|call_sessions|assessments|roles|transcript_turns)/);
  });

  it('adds only R1 columns to interview_rounds', () => {
    const block = /alter table screening_v2\.interview_rounds\n\s+add column[\s\S]*?;/.exec(CODE)![0];
    expect([...block.matchAll(/add column if not exists (\w+)/g)].map((m) => m[1])).toEqual([
      'status_write',
      'status_write_assessment_id',
      'status_write_audit',
      'pending_reject_cancelled_at',
      'pending_reject_cancelled_by',
    ]);
  });

  it('adds only the override-window marker to r1_settings (R1-only, additive, nullable)', () => {
    const block = /alter table screening_v2\.r1_settings\n\s+add column[\s\S]*?;/.exec(CODE)![0];
    expect([...block.matchAll(/add column if not exists (\w+) (\w+)/g)].map((m) => `${m[1]} ${m[2]}`)).toEqual([
      'override_window_reset_at timestamptz',
    ]);
    expect(block).not.toMatch(/not null|default/);
  });
});

describe('0122 functions', () => {
  it('declares exactly the five RPCs, each SECURITY DEFINER with a pinned search_path', () => {
    const created = [...CODE.matchAll(/create or replace function screening_v2\.(\w+)\(/g)]
      .map((m) => m[1])
      .filter((name) => name !== 'r1_settings_stamp_override_reset');
    expect(created).toEqual([
      'r1_attach_assessment',
      'r1_apply_status_effect',
      'r1_check_override_rate',
      'r1_apply_due_pending_rejects',
      'r1_cancel_pending_reject',
    ]);
    for (const name of created as string[]) {
      const body = functionBody(name);
      expect(body, name).toContain('security definer');
      expect(body, name).toContain('set search_path = pg_catalog, screening_v2');
      expect(body, name).toContain('language plpgsql');
    }
  });

  it('the one other function is the settings trigger: security invoker, pinned search_path, closed to every role', () => {
    const body = functionBody('r1_settings_stamp_override_reset');
    expect(body).toContain('security invoker');
    expect(body).toContain('set search_path = pg_catalog');
    expect(body).not.toContain('security definer');
    expect(CODE).toContain(
      'revoke all on function screening_v2.r1_settings_stamp_override_reset()\n  from public, anon, authenticated;',
    );
    expect(CODE).not.toMatch(/grant execute on function screening_v2\.r1_settings_stamp_override_reset/);
    // Only R1's own table carries the trigger, and the migration stays free of destructive DDL.
    expect(CODE).toMatch(/create or replace trigger trg_r1_settings_override_reset\n\s+before update on screening_v2\.r1_settings/);
  });

  it('revokes from public/anon/authenticated and grants execute to service_role only', () => {
    const revoke = /revoke all on function([\s\S]*?)from public, anon, authenticated;/.exec(CODE)!;
    const grant = /grant execute on function([\s\S]*?)to service_role;/.exec(CODE)!;
    for (const signature of FUNCTIONS) {
      expect(revoke[1], signature).toContain(`screening_v2.${signature}`);
      expect(grant[1], signature).toContain(`screening_v2.${signature}`);
    }
    expect(CODE).not.toMatch(/grant [^;]* to (anon|authenticated|public)\b/i);
  });

  it('locks the settings row first in every RPC (admission order: settings, round, candidate)', () => {
    for (const fn of FUNCTIONS) {
      const name = fn.slice(0, fn.indexOf('('));
      const body = functionBody(name);
      const settings = body.indexOf('from screening_v2.r1_settings where singleton for update');
      expect(settings, name).toBeGreaterThan(-1);
      const round = body.indexOf('from screening_v2.interview_rounds where id');
      if (round > -1) expect(settings, name).toBeLessThan(round);
      const candidate = body.indexOf('from screening_v2.candidates where id');
      if (candidate > -1 && round > -1) expect(round, name).toBeLessThan(candidate);
    }
  });

  it('writes the candidate only through a compare-and-set on status and decision_use_blocked_at', () => {
    const apply = functionBody('r1_apply_status_effect');
    expect(apply).toMatch(/set status = 'advanced'\s+where id = v_cand\.id\s+and status = v_round\.candidate_status_at_send\s+and decision_use_blocked_at is null/);
    const due = functionBody('r1_apply_due_pending_rejects');
    expect(due).toMatch(/set status = 'rejected'\s+where id = v_cand\.id\s+and status = v_round\.candidate_status_at_send\s+and decision_use_blocked_at is null/);
    // The only two candidate writes in the whole migration.
    expect([...CODE.matchAll(/update screening_v2\.candidates/g)]).toHaveLength(2);
  });

  it('keeps the pending reject at exactly 24 hours, drops it when auto-status is off', () => {
    expect(functionBody('r1_apply_status_effect')).toContain("v_pending := p_now + interval '24 hours';");
    expect(functionBody('r1_apply_due_pending_rejects')).toContain("v_drop := 'auto_status_off';");
  });

  it('auto-disables at more than 10 percent over a rolling 20', () => {
    const monitor = functionBody('r1_check_override_rate');
    expect(monitor).toContain('p_window integer default 20');
    expect(monitor).toContain('p_threshold_pct numeric default 10');
    expect(monitor).toContain('v_over * 100 > p_threshold_pct * v_n');
    expect(monitor).toContain('set auto_status_enabled = false, updated_by = null');
  });

  describe('review fixes', () => {
    it('restarts the override window when auto-status is switched back on, and only then', () => {
      const trigger = functionBody('r1_settings_stamp_override_reset');
      expect(trigger).toContain('if new.auto_status_enabled and not old.auto_status_enabled then');
      expect(trigger).toContain('new.override_window_reset_at := now();');
      const monitor = functionBody('r1_check_override_rate');
      expect(monitor).toMatch(
        /coalesce\(r\.status_written_at, r\.pending_reject_cancelled_at\)\s+> coalesce\(v_settings\.override_window_reset_at, '-infinity'::timestamptz\)/,
      );
      // The monitor still never touches the marker: only the owner's re-enable stamps it.
      expect(monitor).not.toMatch(/override_window_reset_at\s*=/);
    });

    it('writes no candidate status for a round that is not final, in the apply and in the window close', () => {
      const apply = functionBody('r1_apply_status_effect');
      expect(apply).toContain("elsif v_round.status not in ('completed', 'expired') then");
      expect(apply).toContain("v_write := 'round_not_final';");
      // The final-round check sits before any candidate lock or write.
      expect(apply.indexOf("v_write := 'round_not_final';")).toBeLessThan(apply.indexOf('from screening_v2.candidates where id'));
      expect(apply.indexOf("v_write := 'round_not_final';")).toBeLessThan(apply.indexOf("v_write := 'flag_off';"));
      const due = functionBody('r1_apply_due_pending_rejects');
      expect(due).toContain("elsif v_round.status not in ('completed', 'expired') then");
      expect(due).toContain("v_drop := 'round_not_final';");
      expect(due.indexOf("v_drop := 'round_not_final';")).toBeLessThan(due.indexOf("v_drop := 'status_changed_by_human';"));
      expect(CODE).toMatch(/chk_interview_rounds_status_write check \(status_write is null or status_write in \([^)]*'round_not_final'/);
    });

    it('drops a window that is overdue by more than an hour instead of executing it late', () => {
      const due = functionBody('r1_apply_due_pending_rejects');
      expect(due).toContain("elsif v_round.pending_reject_until < p_now - interval '1 hour' then");
      expect(due).toContain("v_drop := 'window_stale';");
    });

    it('carries the versions the window was opened with onto every audit row written at its close', () => {
      const apply = functionBody('r1_apply_status_effect');
      expect(apply).toContain("status_write_audit = case when v_write = 'pending_reject' then v_audit else null end");
      const due = functionBody('r1_apply_due_pending_rejects');
      expect(due).toContain("v_audit := coalesce(v_round.status_write_audit, '{}'::jsonb);");
      // applied, dropped (both branches): each audit insert merges v_audit.
      const inserts = [...due.matchAll(/insert into screening_v2\.audit_events[\s\S]*?\);\n/g)].map((m) => m[0]);
      expect(inserts).toHaveLength(3);
      for (const insert of inserts) expect(insert).toContain('v_audit || jsonb_build_object(');
    });

    it('audits a lost compare-and-set at window close instead of dropping the window silently', () => {
      const due = functionBody('r1_apply_due_pending_rejects');
      expect(due).toContain("'reason', 'cas_lost'");
      expect(due).toMatch(/get diagnostics v_updated = row_count;[\s\S]*?else[\s\S]*?'reason', 'cas_lost'/);
    });

    it('documents the admission contract the later-attempt-wins rule depends on', () => {
      expect(SQL).toContain('CONTRACT WITH ADMISSION (PR-3');
      expect(SQL).toContain('refuse a new attempt while the latest counted attempt');
    });
  });

  it('writes only audit actions the newest chk_audit_action admits', () => {
    const latest = read('0114_phone_outcome_integrity.sql');
    const actions = new Set([...CODE.matchAll(/'(assessment_recorded|candidate_status_changed|config_changed)'/g)].map((m) => m[1]));
    expect([...actions].sort()).toEqual(['assessment_recorded', 'candidate_status_changed', 'config_changed']);
    const list = /add constraint chk_audit_action check \(\s*action = any \(array\[([\s\S]*?)\]\)/.exec(latest)![1]!;
    for (const action of actions) expect(list, action as string).toContain(`'${action}'`);
    // actor_type and result vocabularies from 0007.
    for (const actorType of ['system', 'recruiter']) expect(CODE).toContain(`'${actorType}'`);
    for (const result of ['success', 'failure', 'pending']) expect(CODE).toContain(`'${result}'`);
  });
});

describe('0122 funnel views', () => {
  const m0090 = read('0090_funnel_observability.sql');
  const m0091 = read('0091_scorecard_partial_scoring.sql');

  it('v_funnel_candidate is the 0090 text with ONLY the asmt CTE changed', () => {
    const start0090 = m0090.indexOf('create or replace view screening_v2.v_funnel_candidate');
    const original = m0090.slice(start0090, m0090.indexOf('from base;', start0090) + 'from base;'.length);
    const start = SQL.indexOf('create or replace view screening_v2.v_funnel_candidate');
    const restated = SQL.slice(start, SQL.indexOf('from base;', start) + 'from base;'.length);
    const cte = (text: string) => text.slice(text.indexOf('  asmt as ('), text.indexOf('  refchk as ('));
    expect(restated.replace(cte(restated), '')).toBe(original.replace(cte(original), ''));
    expect(cte(restated)).toContain('rs.interview_round_id is not null');
    expect(cte(restated)).toContain('screening_v2.call_sessions rs');
    expect(cte(original)).not.toContain('interview_round_id');
  });

  it('v_funnel_failures keeps every 0091 phone branch byte-for-byte and adds the r1.* branch', () => {
    const start0091 = m0091.indexOf('create or replace view screening_v2.v_funnel_failures');
    const original = m0091.slice(start0091, m0091.indexOf("where d.name like 'phone.assessment%';", start0091)
      + "where d.name like 'phone.assessment%'".length);
    const start = SQL.indexOf('create or replace view screening_v2.v_funnel_failures');
    const restated = SQL.slice(start, SQL.indexOf("where d.name like 'r1.%';", start));
    expect(restated.startsWith(original)).toBe(true);
    expect(restated).toContain("when d.name = 'r1.assessment' then 'scoring'");
    expect(restated).toContain("when d.name like 'r1.recording.%' then 'recording'");
    expect(restated).toContain("'r1:' || d.error_message");
    // Failure stages stay inside the vocabulary the funnel API validates.
    const stages = new Set([...restated.matchAll(/'(resume_parse|dial|recording|call|scoring)'/g)].map((m) => m[1]));
    expect([...stages].sort()).toEqual(['call', 'dial', 'recording', 'resume_parse', 'scoring']);
  });

  it('v_funnel_hr_state is the 0098 text with ONLY the latest_assessment CTE changed (R1 excluded)', () => {
    const m0098 = read('0098_funnel_hr_disposition.sql');
    const grant = 'grant select on screening_v2.v_funnel_hr_state to service_role;';
    const start0098 = m0098.indexOf('create or replace view screening_v2.v_funnel_hr_state');
    const original = m0098.slice(start0098, m0098.indexOf(grant, start0098) + grant.length);
    const start = SQL.indexOf('create or replace view screening_v2.v_funnel_hr_state');
    expect(start).toBeGreaterThan(-1);
    const restated = SQL.slice(start, SQL.indexOf(grant, start) + grant.length);
    const cte = (text: string) => text.slice(text.indexOf('with latest_assessment as ('), text.indexOf('stage as ('));
    expect(restated.replace(cte(restated), '')).toBe(original.replace(cte(original), ''));
    expect(cte(restated)).toContain('rs.interview_round_id is not null');
    expect(cte(restated)).toContain('screening_v2.call_sessions rs');
    expect(cte(original)).not.toContain('interview_round_id');
    // The column list is unchanged: the same final select.
    const columns = (text: string) => [...text.slice(text.lastIndexOf('select c.id')).matchAll(/\bas (\w+)/g)].map((m) => m[1]);
    expect(columns(restated)).toEqual(columns(original));
  });

  it('the two funnel views agree on which assessments count: both exclude R1 by the same predicate', () => {
    const predicate = /not exists \(\s*select 1 from screening_v2\.call_sessions rs\s+where rs\.id = a\.session_id and rs\.interview_round_id is not null\s*\)/g;
    expect(SQL.match(predicate)).toHaveLength(2);
  });

  it('keeps all three views service_role-only', () => {
    for (const view of ['v_funnel_candidate', 'v_funnel_hr_state', 'v_funnel_failures']) {
      expect(CODE).toContain(`revoke all on screening_v2.${view} from anon, authenticated, public;`);
      expect(CODE).toContain(`grant select on screening_v2.${view} to service_role;`);
    }
  });
});

describe('admin-log vocabulary agrees across SQL, route and parser', () => {
  it('lists the same event types in the CHECK, the route allowlist and the parser', () => {
    const sqlList = /check \(event_type in \(([\s\S]*?)\)\) not valid;/.exec(CODE)![1]!;
    const sqlEvents = [...sqlList.matchAll(/'(\w+)'/g)].map((m) => m[1]).sort();
    const route = readFileSync(path.resolve(here, '../routes/r1.ts'), 'utf8');
    const routeList = /const ADMIN_LOG_EVENTS = \[([^\]]*)\]/.exec(route)![1]!;
    const routeEvents = [...routeList.matchAll(/'(\w+)'/g)].map((m) => m[1]).sort();
    const parser = readFileSync(path.resolve(here, '../lib/r1/admin-log.ts'), 'utf8');
    const parsed = [...parser.matchAll(/case '(\w+)':/g)].map((m) => m[1]).sort();
    expect(routeEvents).toEqual(sqlEvents);
    expect(parsed).toEqual(sqlEvents);
    // 0117's original seven are all still admitted.
    const original = /event_type text not null check \(event_type in \(([\s\S]*?)\)\)/.exec(read('0117_r1_ledger_and_estimates.sql'))![1]!;
    for (const event of [...original.matchAll(/'(\w+)'/g)].map((m) => m[1])) {
      expect(sqlEvents, event as string).toContain(event);
    }
  });
});

describe('SQL test wiring', () => {
  const root = path.resolve(here, '../../../..');
  it('runs the assertions from supabase-test.sh and triggers supabase-ci on the helper', () => {
    expect(existsSync(path.join(root, 'scripts/test-r1-scorer.sh'))).toBe(true);
    expect(readFileSync(path.join(root, 'scripts/test-r1-scorer.sh'), 'utf8')).toContain('r1_scorer_assert.sql');
    expect(readFileSync(path.join(root, 'scripts/supabase-test.sh'), 'utf8')).toContain('bash scripts/test-r1-scorer.sh');
    const ci = readFileSync(path.join(root, '.github/workflows/supabase-ci.yml'), 'utf8');
    expect(ci.match(/scripts\/test-r1-scorer\.sh/g)).toHaveLength(2);
  });

  it('uses unique tags and sha256 digests, never repeat() digests, in the fixtures', () => {
    const assertions = readFileSync(path.join(root, 'app/supabase/tests/r1_scorer_assert.sql'), 'utf8');
    expect(assertions).not.toMatch(/repeat\(/);
    expect(assertions).toContain("encode(sha256(");
    expect(assertions).toContain('22000000-0000-4000-8000-');
  });
});
