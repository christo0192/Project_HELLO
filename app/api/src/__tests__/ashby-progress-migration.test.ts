/**
 * 0139: the Ashby progress worker's functions (M031 S3), read from the
 * migration's text.
 *
 * The functions run on real Postgres in app/supabase/tests/policy_tests.sql
 * (section "0139"): the claim and its lease, a stale read refused, intervals
 * marked gone and never deleted, the backfill (idempotent, audited) and the
 * overview. These checks pin what makes the migration safe:
 *
 *   1. additive only: six new functions (the five the API calls and the one
 *      coverage rule they share) and no table, column, view, policy or
 *      existing function created, altered or dropped;
 *   2. the SQL touches only the five 0138 tables, reads the links, mappings
 *      and data-subject requests, and appends one audit row (the backfill's):
 *      never a write to a link, a candidate or an assessment;
 *   3. each function is SECURITY DEFINER with a pinned search_path, executable
 *      by service_role only;
 *   4. the claim is FOR UPDATE SKIP LOCKED in next_check_at order, bounded,
 *      and every write checks the lease first;
 *   5. nothing is deleted, and the actor id of a history row is never a column.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrations = path.resolve(here, '../../../supabase/migrations');
const FILE = '0139_ashby_progress_worker.sql';
const SQL = readFileSync(path.join(migrations, FILE), 'utf8').replace(/\r\n/g, '\n');
const CODE = SQL.replace(/--[^\n]*/g, '');
const FLAT = CODE.replace(/\s+/g, ' ').trim();
const POLICY = readFileSync(path.resolve(here, '../../../supabase/tests/policy_tests.sql'), 'utf8').replace(/\r\n/g, '\n');

const NEW_TABLES = [
  'ashby_stage_catalog',
  'ashby_application_progress',
  'ashby_application_stage_intervals',
  'ashby_archive_reasons',
  'ashby_progress_runs',
] as const;

const SIGNATURES: Record<string, string> = {
  ashby_progress_covered_links: '',
  claim_ashby_progress_due: 'integer, integer, integer, timestamptz',
  record_ashby_application_progress: 'uuid, timestamptz, timestamptz, jsonb',
  record_ashby_progress_run: 'timestamptz, timestamptz, integer, integer, jsonb, timestamptz',
  start_ashby_progress_backfill: 'uuid, timestamptz',
  ashby_progress_overview: 'timestamptz, integer',
};
const FUNCTIONS = Object.keys(SIGNATURES);
/** The five the API calls; each takes its links from the shared coverage rule. */
const API_FUNCTIONS = FUNCTIONS.filter((f) => f !== 'ashby_progress_covered_links');

function functionBody(name: string): string {
  const start = CODE.indexOf(`create or replace function screening_v2.${name}(`);
  expect(start, `${name} must be created`).toBeGreaterThan(-1);
  const end = CODE.indexOf('\n$$;', start);
  return CODE.slice(start, end).replace(/\s+/g, ' ');
}

describe('0139 shape', () => {
  it('is the only 0139 migration', () => {
    const files = readdirSync(migrations).filter((f) => f.endsWith('.sql')).sort();
    expect(files.filter((f) => f.startsWith('0139_'))).toEqual([FILE]);
    expect(files.indexOf(FILE)).toBe(files.indexOf('0138_ashby_pipeline_progress.sql') + 1);
  });

  it('creates exactly the six functions, and no table, view, column, index, trigger or policy', () => {
    const created = [...CODE.matchAll(/create or replace function screening_v2\.([a-z0-9_]+)\(/g)].map((m) => m[1]);
    expect(created).toEqual(FUNCTIONS);
    expect(FLAT).not.toMatch(/\bcreate (table|view|materialized view|index|unique index|trigger|policy|type|sequence)\b/);
    expect(FLAT).not.toMatch(/\balter (table|column|view|function|type)\b/);
    expect(FLAT).not.toMatch(/\bdrop (table|column|view|function|index|trigger|constraint|policy|type)\b/);
    expect(FLAT).not.toMatch(/\b(truncate|merge into)\b/);
  });

  it('writes only the 0138 tables, and appends only the backfill audit row', () => {
    const writes = [...FLAT.matchAll(/\b(insert into|update|delete from)\s+screening_v2\.([a-z0-9_]+)/g)].map((m) => [m[1], m[2]]);
    expect(writes.length).toBeGreaterThan(0);
    for (const [verb, table] of writes) {
      if (table === 'audit_events') {
        expect(verb).toBe('insert into');
        continue;
      }
      expect(NEW_TABLES as readonly string[], `${verb} ${table}`).toContain(table);
    }
    expect([...FLAT.matchAll(/insert into screening_v2\.audit_events\b/g)]).toHaveLength(1);
    expect(functionBody('start_ashby_progress_backfill')).toContain('insert into screening_v2.audit_events');
    // Never a write to a link, a candidate, an assessment or a data-subject request.
    expect(FLAT).not.toMatch(/(insert into|update|delete from)\s+screening_v2\.(ashby_application_links|candidates|assessments|data_subject_requests|ashby_job_mappings)\b/);
    expect(FLAT).not.toMatch(/\bscreening_v2\.(candidates|assessments)\b/);
  });

  it('deletes nothing', () => {
    // String literals out first: 'delete' is a data-subject request type it reads.
    expect(FLAT.replace(/'[^']*'/g, "''")).not.toMatch(/\bdelete\b/);
  });

  it('audits the backfill under an action the newest chk_audit_action admits, so that constraint is not re-created', () => {
    const files = readdirSync(migrations).filter((f) => f.endsWith('.sql')).sort();
    let list = '';
    for (const f of files) {
      const m = /add constraint chk_audit_action check \(\s*action = any \(array\[([\s\S]*?)\]\)/.exec(readFileSync(path.join(migrations, f), 'utf8'));
      if (m) list = m[1];
    }
    expect(list).toContain("'resource_update'");
    expect(FLAT).not.toMatch(/chk_audit_action/);
    expect(functionBody('start_ashby_progress_backfill')).toMatch(
      /insert into screening_v2\.audit_events \(actor_id, actor_type, action, target_type, target_id, result, metadata\) values \(p_actor_id, 'recruiter', 'resource_update', 'ashby_progress', 'backfill', 'success',/,
    );
  });

  it('sets a short lock timeout first, and reloads the schema cache at the end', () => {
    const lock = CODE.indexOf("set local lock_timeout = '10s';");
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(CODE.indexOf('create or replace function'));
    expect(CODE.trimEnd().endsWith("notify pgrst, 'reload schema';")).toBe(true);
  });
});

describe('0139 security posture', () => {
  it.each(FUNCTIONS)('%s is SECURITY DEFINER, pins search_path, and only service_role may run it', (name) => {
    const body = functionBody(name);
    expect(body).toMatch(/security definer/);
    expect(body).toMatch(/set search_path = pg_catalog, screening_v2/);
    expect(FLAT).toContain(`revoke all on function screening_v2.${name}(${SIGNATURES[name]}) from public, anon, authenticated;`);
    expect(FLAT).toContain(`grant execute on function screening_v2.${name}(${SIGNATURES[name]}) to service_role;`);
    expect(FLAT).toMatch(new RegExp(`comment on function screening_v2\\.${name}\\(`));
  });

  it('grants nothing to a browser role', () => {
    expect(FLAT).not.toMatch(/\bgrant [a-z, ]+ to (anon|authenticated|public)\b/);
  });

  it('the backfill needs the admin before any write', () => {
    const body = functionBody('start_ashby_progress_backfill');
    const actor = body.indexOf("if p_actor_id is null then return jsonb_build_object('status', 'actor_required');");
    expect(actor).toBeGreaterThan(-1);
    expect(actor).toBeLessThan(body.indexOf('insert into'));
    expect(body).toContain("perform pg_advisory_xact_lock(hashtext('screening_v2.ashby_progress_backfill'));");
    expect(body).toContain("return jsonb_build_object('status', 'already_running'");
  });

  it('one coverage rule: a link an erasure ended, an ended link whose candidate is gone, or one whose candidate has a restriction or erasure request, is never seeded, claimed or counted', () => {
    const helper = functionBody('ashby_progress_covered_links');
    expect(helper).toContain(
      "from screening_v2.ashby_application_links l where l.provider = 'ashby' and l.terminal_reason is distinct from 'subject_erasure'"
      // S3-2: lib/dsar.ts leaves an already-ended link's state alone; deleting the
      // candidate nulls candidate_id and takes the erasure request with it.
      + ' and (l.terminal_state is null or l.candidate_id is not null)'
      + " and not exists ( select 1 from screening_v2.data_subject_requests d where d.candidate_id = l.candidate_id and d.request_type in ('restrict', 'delete') and d.request_status in ('pending', 'in_progress', 'fulfilled'))",
    );
    expect(helper).toMatch(/language sql stable security definer/);
    // Each function takes its links from the helper and repeats no part of the rule.
    for (const name of API_FUNCTIONS.filter((n) => n !== 'record_ashby_application_progress')) {
      const body = functionBody(name);
      expect(body, name).toContain('screening_v2.ashby_progress_covered_links() c');
      expect(body, name).not.toMatch(/subject_erasure|data_subject_requests|terminal_state|terminal_reason/);
    }
    // The claim applies it to the seed AND to the claim itself; the backfill to its seed and its marks.
    expect(functionBody('claim_ashby_progress_due').split('screening_v2.ashby_progress_covered_links() c')).toHaveLength(3);
    expect(functionBody('start_ashby_progress_backfill').split('screening_v2.ashby_progress_covered_links() c')).toHaveLength(3);
    expect(CODE.indexOf('create or replace function screening_v2.ashby_progress_covered_links(')).toBeLessThan(
      Math.min(...API_FUNCTIONS.map((n) => CODE.indexOf(`create or replace function screening_v2.${n}(`))),
    );
  });
});

describe('0139 claim and record', () => {
  it('the claim is bounded, FOR UPDATE SKIP LOCKED in next_check_at order, and moves next_check_at to the lease end', () => {
    const body = functionBody('claim_ashby_progress_due');
    expect(body).toContain('v_limit integer := least(greatest(coalesce(p_limit, 1), 1), 50);');
    expect(body).toContain('v_lease integer := least(greatest(coalesce(p_lease_seconds, 180), 30), 3600);');
    expect(body).toContain('v_seed integer := least(greatest(coalesce(p_seed_limit, 0), 0), 5000);');
    expect(body).toContain('order by p.next_check_at, p.id limit v_limit for update of p skip locked');
    expect(body).toContain('set next_check_at = v_now + make_interval(secs => v_lease), attempts = least(p.attempts + 1, 1000000)');
    expect(body).toContain('on conflict (application_link_id) do nothing');
    // The worker learns whether a backfill is open, so an empty pass can close it.
    expect(body).toContain("'backfill_open', exists (select 1 from screening_v2.ashby_progress_runs r where r.mode = 'backfill' and r.finished_at is null)");
    // And when it began, so every history read before then is read again (S3-4).
    expect(body).toContain("'backfill_started_at', (select r.started_at from screening_v2.ashby_progress_runs r where r.mode = 'backfill' and r.finished_at is null order by r.started_at desc limit 1)");
  });

  it('a record checks the lease under the row lock before it writes anything', () => {
    const body = functionBody('record_ashby_application_progress');
    const lock = body.indexOf('select * into v_row from screening_v2.ashby_application_progress where id = p_progress_id for update;');
    const lease = body.indexOf("if v_row.next_check_at is distinct from p_lease_until then return jsonb_build_object('status', 'lease_lost');");
    const firstWrite = Math.min(...['insert into', 'update screening_v2'].map((w) => body.indexOf(w)).filter((i) => i > -1));
    expect(lock).toBeGreaterThan(-1);
    expect(lease).toBeGreaterThan(lock);
    expect(firstWrite).toBeGreaterThan(lease);
    expect(body).toContain("v_outcome not in ('ok', 'error', 'gone', 'deferred')");
  });

  it('intervals are upserted on the Ashby history id, and a row a fresh read no longer returns is marked gone_at', () => {
    const body = functionBody('record_ashby_application_progress');
    expect(body).toContain('on conflict (history_id) do update set');
    expect(body).toContain('gone_at = null where i.application_link_id = excluded.application_link_id;');
    expect(body).toContain('update screening_v2.ashby_application_stage_intervals i set gone_at = greatest(v_now, i.first_seen_at) where i.application_link_id = v_row.application_link_id and i.gone_at is null and not exists (');
  });

  it('a stage a plan read wrote is never touched; a history stage only fills what it lacks', () => {
    const body = functionBody('record_ashby_application_progress');
    expect(body).toMatch(/'history', v_now, v_now, v_now\) on conflict \(stage_id\) do update set .* where c\.source = 'history';/);
    expect(body).toContain('interview_plan_id = coalesce(c.interview_plan_id, excluded.interview_plan_id)');
  });

  it('a gone application is not due again; a deferred row gets its claim back', () => {
    const body = functionBody('record_ashby_application_progress');
    expect(body).toContain("v_next := 'infinity'::timestamptz;");
    expect(body).toContain('next_check_at = v_next, attempts = greatest(attempts - 1, 0) where id = p_progress_id;');
  });

  it('no column, input or answer carries the history actor id', () => {
    // The worker's functions never name an actor; the history payload has moved_by_person only.
    for (const name of ['claim_ashby_progress_due', 'record_ashby_application_progress', 'record_ashby_progress_run', 'ashby_progress_overview']) {
      expect(functionBody(name), name).not.toMatch(/actor/i);
    }
    expect(functionBody('record_ashby_application_progress')).toContain('moved_by_person boolean');
    // The backfill names only the admin who asked, as the audit row's actor.
    const backfill = functionBody('start_ashby_progress_backfill');
    expect(backfill.replace(/p_actor_id/g, '').replace('(actor_id, actor_type, action,', '').replace("'actor_required'", '')).not.toMatch(/actor/i);
  });

  it('the overview answers counts and timestamps, never an id', () => {
    const body = functionBody('ashby_progress_overview');
    expect(body).toMatch(/language sql stable security definer/);
    expect(body).not.toMatch(/'(run_id|link_id|progress_id|application_id|candidate_id|stage_id)'/);
    // The passes skipped for the scanner over the last day, from the run rows (S3-3).
    expect(body).toContain("'scanner_pause', (select jsonb_build_object( 'skipped_passes',");
  });

  it('a run row may count rows handed back and passes skipped for the scanner, next to its failures', () => {
    const body = functionBody('record_ashby_progress_run');
    // Any count makes a row: a pass that only handed rows back is not invisible.
    expect(body).toContain("if p_checked > 0 or p_errors <> '{}'::jsonb then");
    expect(SQL).toMatch(/`deferred`/);
    expect(SQL).toMatch(/`scanner_paused`/);
  });
});

describe('0139 registration', () => {
  it('the policy suite runs every function for real', () => {
    expect(POLICY).toContain('-- 0139:');
    for (const name of FUNCTIONS) expect(POLICY).toContain(`screening_v2.${name}(`);
    for (const t of [
      '0139: the first claim seeds every readable link and takes the newest first',
      '0139: nothing is claimed again while its lease holds',
      '0139: a stale lease writes nothing (lease_lost)',
      '0139: an edited history marks the row Ashby stopped returning gone_at, and keeps it',
      '0139: a link an erasure ended, or whose candidate asked for restriction, is never seeded',
      '0139: a link already ended when its candidate was erased is never seeded, claimed or counted',
      '0139: a claim answers when the open backfill began',
      '0139: a pass that only handed rows back records its run',
      '0139: the overview counts the passes skipped for the scanner over the last day',
      '0139: a second backfill while one is open changes nothing (idempotent)',
      '0139: once every covered link is read the backfill closes with the summed counts',
      '0139: no function wrote a link or a candidate',
    ]) expect(POLICY).toContain(t);
  });
});
