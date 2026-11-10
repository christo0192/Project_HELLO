/**
 * 0138: the Ashby pipeline tables (M031 S2), read from the migration's text.
 *
 * No Postgres is available to this suite, so it cannot show that a CHECK accepts
 * or refuses a row: that runs on real Postgres in
 * app/supabase/tests/policy_tests.sql (section "0138"), value by value, with the
 * FK cascade, the uniques and the catalogue refresh. These checks pin what makes
 * the migration safe:
 *
 *   1. additive only: five NEW tables and two new functions, and no statement
 *      that alters, drops, updates or deletes anything that exists, so
 *      ashby_application_links, candidates and assessments are never written;
 *      the only rows added elsewhere are the functions' own audit rows;
 *   2. every table has row level security on and is service-role only, like the
 *      sibling Ashby tables (0029);
 *   3. progress and intervals follow their link: ON DELETE CASCADE;
 *   4. the closed vocabularies are CHECKs, and the open ones (Ashby's stage
 *      type, archive reason type) are format checks only;
 *   5. no column can hold a name, email, phone, resume, offer amount, staff id
 *      or text typed about a candidate;
 *   6. the refresh never deletes and never overwrites an admin's label;
 *   7. each function writes its change and its audit row in one transaction,
 *      under an action the live chk_audit_action already admits (S2-3).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STAGE_MILESTONES } from '../integrations/ashby/stage-catalog.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrations = path.resolve(here, '../../../supabase/migrations');
const FILE = '0138_ashby_pipeline_progress.sql';
const SQL = readFileSync(path.join(migrations, FILE), 'utf8').replace(/\r\n/g, '\n');
const CODE = SQL.replace(/--[^\n]*/g, '');
const FLAT = CODE.replace(/\s+/g, ' ').trim();
const POLICY = readFileSync(path.resolve(here, '../../../supabase/tests/policy_tests.sql'), 'utf8').replace(/\r\n/g, '\n');
const CLASSIFICATION = readFileSync(path.resolve(here, '../../../../docs/data-classification.md'), 'utf8');

const TABLES = [
  'ashby_stage_catalog',
  'ashby_application_progress',
  'ashby_application_stage_intervals',
  'ashby_archive_reasons',
  'ashby_progress_runs',
] as const;

/** The body of `create table if not exists screening_v2.<name> ( ... );`. */
function tableBody(name: string): string {
  const start = CODE.indexOf(`create table if not exists screening_v2.${name} (`);
  expect(start, `${name} must be created`).toBeGreaterThan(-1);
  const end = CODE.indexOf('\n);', start);
  expect(end).toBeGreaterThan(start);
  return CODE.slice(start, end + 3);
}

/** Column name -> its declaration line, for one table. */
function columns(name: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of tableBody(name).split('\n').slice(1)) {
    const m = /^\s{2}([a-z_][a-z0-9_]*)\s+(.*?),?\s*$/.exec(line);
    if (m && m[1] !== 'constraint') out.set(m[1], m[2]);
  }
  return out;
}

const FUNCTION = 'refresh_ashby_stage_catalog';
const LABEL_FUNCTION = 'set_ashby_stage_milestone';
const SIGNATURES: Record<string, string> = {
  [FUNCTION]: 'jsonb, uuid',
  [LABEL_FUNCTION]: 'text, text, text, uuid',
};
function functionBody(name: string = FUNCTION): string {
  const start = CODE.indexOf(`create or replace function screening_v2.${name}(`);
  expect(start, `${name} must be created`).toBeGreaterThan(-1);
  const end = CODE.indexOf('\n$$;', start);
  return CODE.slice(start, end);
}

describe('0138 shape', () => {
  it('is the only 0138 migration, and only the later M031 migrations follow it', () => {
    const files = readdirSync(migrations).filter((f) => f.endsWith('.sql')).sort();
    expect(files.filter((f) => f.startsWith('0138_'))).toEqual([FILE]);
    // 0139_ashby_progress_worker.sql (M031 S3) adds functions over these tables and nothing else;
    // 0140_ashby_business_impact.sql (M031 S5, the read model) follows it, and
    // 0141_ashby_progress_nudge.sql (M031 S4, the webhook nudge, one function over the progress table)
    // follows that. All by exact name, in that order.
    expect(files.slice(files.indexOf(FILE) + 1)).toEqual([
      '0139_ashby_progress_worker.sql',
      '0140_ashby_business_impact.sql',
      '0141_ashby_progress_nudge.sql',
    ]);
  });

  it('creates exactly the five tables and touches no other table', () => {
    const created = [...CODE.matchAll(/create table if not exists screening_v2\.([a-z0-9_]+)/g)].map((m) => m[1]);
    expect(created).toEqual([...TABLES]);
    const touched = [...CODE.matchAll(/\b(?:alter table|insert into|update|delete from|truncate|references|on table|comment on table|comment on column)\s+(?:only\s+)?(?:screening_v2\.)?([a-z0-9_]+)/g)]
      .map((m) => m[1]);
    const allowed = new Set<string>([...TABLES, 'ashby_application_links', 'c', 'catalog', 'audit_events']);
    for (const t of touched) expect(allowed.has(t), `unexpected table ${t}`).toBe(true);
    // audit_events is only ever appended to, by the two functions.
    expect([...FLAT.matchAll(/\b(alter table|update|delete from|truncate)\s+screening_v2\.audit_events\b/g)]).toEqual([]);
    expect([...FLAT.matchAll(/insert into screening_v2\.audit_events\b/g)]).toHaveLength(2);
  });

  it('is additive: no ALTER of an existing table, no DROP, no rewrite, no data change outside the function', () => {
    expect(FLAT).not.toMatch(/\bdrop (table|column|view|function|index|trigger|constraint|policy)\b/);
    expect(FLAT).not.toMatch(/\balter (column|view|function)\b/);
    // The only ALTERs enable RLS on the new tables.
    for (const m of FLAT.matchAll(/alter table screening_v2\.([a-z0-9_]+) ([a-z ]+?);/g)) {
      expect(TABLES as readonly string[]).toContain(m[1]);
      expect(m[2]).toBe('enable row level security');
    }
    let outside = FLAT;
    for (const name of [FUNCTION, LABEL_FUNCTION]) outside = outside.replace(functionBody(name).replace(/\s+/g, ' ').trim(), '');
    expect(outside).not.toMatch(/\b(insert into|update screening_v2|delete from|truncate|merge into)\b/);
  });

  it('never writes a link, a candidate or an assessment', () => {
    expect(FLAT).not.toMatch(/(insert into|update|delete from)\s+screening_v2\.(ashby_application_links|candidates|assessments)\b/);
    expect(FLAT).not.toMatch(/\bscreening_v2\.(candidates|assessments)\b/);
  });

  it('sets a short lock timeout before any DDL, and reloads the schema cache at the end', () => {
    const lock = CODE.indexOf("set local lock_timeout = '10s';");
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(CODE.indexOf('create table'));
    expect(CODE.trimEnd().endsWith("notify pgrst, 'reload schema';")).toBe(true);
  });
});

describe('0138 security posture', () => {
  it.each(TABLES)('%s: RLS on, no browser grant, service_role only', (table) => {
    expect(FLAT).toContain(`alter table screening_v2.${table} enable row level security;`);
    expect(FLAT).toContain(`revoke all on screening_v2.${table} from anon, authenticated, public;`);
    expect(FLAT).toContain(`grant all privileges on screening_v2.${table} to service_role;`);
    expect(FLAT).toMatch(new RegExp(`comment on table screening_v2\\.${table} is`));
  });

  it('declares no policy and grants nothing to a browser role', () => {
    expect(FLAT).not.toMatch(/\bcreate policy\b/);
    expect(FLAT).not.toMatch(/\bgrant [a-z, ]+ to (anon|authenticated|public)\b/);
  });

  it.each([FUNCTION, LABEL_FUNCTION])('%s is SECURITY DEFINER, pins search_path, and only service_role may run it', (name) => {
    const body = functionBody(name);
    expect(body).toMatch(/security definer/);
    expect(body).toMatch(/set search_path = pg_catalog, screening_v2/);
    expect(FLAT).toContain(`revoke all on function screening_v2.${name}(${SIGNATURES[name]}) from public, anon, authenticated;`);
    expect(FLAT).toContain(`grant execute on function screening_v2.${name}(${SIGNATURES[name]}) to service_role;`);
  });

  it.each([FUNCTION, LABEL_FUNCTION])('%s needs the admin, and writes its audit row after its change, in the same body (S2-3)', (name) => {
    const body = functionBody(name).replace(/\s+/g, ' ');
    // Refused before any write when no admin is named.
    const actor = body.indexOf("if p_actor_id is null then return jsonb_build_object('status', 'actor_required');");
    expect(actor).toBeGreaterThan(-1);
    const audit = body.indexOf('insert into screening_v2.audit_events');
    expect(audit).toBeGreaterThan(actor);
    expect(body.slice(audit)).toMatch(/^insert into screening_v2\.audit_events \(actor_id, actor_type, action, target_type, target_id, result, metadata\) values \(p_actor_id, 'recruiter', 'config_changed', /);
    // The change comes first; nothing is written to the catalogue after the audit row.
    const lastWrite = Math.max(body.lastIndexOf('update screening_v2.ashby_stage_catalog'), body.lastIndexOf('insert into screening_v2.ashby_stage_catalog'));
    expect(lastWrite).toBeGreaterThan(actor);
    expect(lastWrite).toBeLessThan(audit);
    // No exception handler: an audit insert Postgres refuses rolls the change back with it.
    expect(body).not.toMatch(/\bexception\b/);
  });

  it('audits under an action the newest chk_audit_action admits, so that constraint is not re-created', () => {
    const files = readdirSync(migrations).filter((f) => f.endsWith('.sql')).sort();
    let list = '';
    for (const f of files) {
      const m = /add constraint chk_audit_action check \(\s*action = any \(array\[([\s\S]*?)\]\)/.exec(readFileSync(path.join(migrations, f), 'utf8'));
      if (m) list = m[1];
    }
    expect(list).toContain("'config_changed'");
    expect(FLAT).not.toMatch(/chk_audit_action/);
  });

  it('the label function stores what it is given, refuses a label and a source that do not pair, and answers the label it replaced', () => {
    const body = functionBody(LABEL_FUNCTION).replace(/\s+/g, ' ');
    expect(body).toContain("p_milestone not in ('christy','r1','r2','r3','r4','r5','reference','offer','hired','archived','other')");
    expect(body).toContain("if (p_milestone is null) <> (p_milestone_source is null) or (p_milestone_source is not null and p_milestone_source not in ('admin','default')) then");
    expect(body).toContain('select * into v_from from screening_v2.ashby_stage_catalog where stage_id = p_stage_id for update;');
    expect(body).toContain("'milestone_from', v_from.milestone, 'milestone_source_from', v_from.milestone_source, 'milestone_to', v_to.milestone, 'milestone_source', v_to.milestone_source");
    expect(body).not.toMatch(/\bdelete\b/);
  });
});

describe('0138 columns, keys and constraints', () => {
  it('the catalogue has the plan columns, keyed on the Ashby stage id', () => {
    const cols = columns('ashby_stage_catalog');
    expect([...cols.keys()]).toEqual([
      'stage_id', 'provider', 'interview_plan_id', 'title', 'stage_type', 'order_in_plan', 'stage_group_id',
      'milestone', 'milestone_source', 'milestone_set_at', 'source', 'first_seen_at', 'last_seen_at', 'not_in_plan_since',
      'updated_at',
    ]);
    expect(cols.get('stage_id')).toMatch(/^text primary key/);
    // S2-4: a stage Ashby removes is marked, never deleted, and never before it was seen.
    expect(cols.get('not_in_plan_since')).toBe('timestamptz');
    expect(CODE).toMatch(/constraint chk_ashby_stage_catalog_not_in_plan check \(\s*not_in_plan_since is null or not_in_plan_since >= first_seen_at\)/);
  });

  it('the milestone CHECK is exactly the allowed set the API offers', () => {
    const m = /constraint chk_ashby_stage_catalog_milestone check \(\s*milestone is null or milestone in \(([^)]*)\)\s*\)/.exec(CODE);
    expect(m).not.toBeNull();
    const values = m![1].split(',').map((v) => v.trim().replace(/'/g, ''));
    expect(values).toEqual([...STAGE_MILESTONES]);
  });

  it('who set a label is admin or default, never a staff id, and is set exactly when a label is', () => {
    expect(CODE).toMatch(/constraint chk_ashby_stage_catalog_milestone_source check \(\s*milestone_source is null or milestone_source in \('admin','default'\)\)/);
    expect(CODE).toMatch(/constraint chk_ashby_stage_catalog_milestone_pair check \(\s*\(milestone is null\) = \(milestone_source is null\)\)/);
    expect(CODE).toMatch(/constraint chk_ashby_stage_catalog_source check \(source in \('plan','history'\)\)/);
  });

  it('every Ashby id is identifier-shaped and at most 256 long (the API rule), with no regex bound Postgres refuses', () => {
    // Postgres caps a regex bound at 255, so `{1,256}` raises 2201B on the first
    // row checked. The length is a separate test; the API's ID_RE is 256 too.
    const ids: Array<[string, string]> = [
      ['chk_ashby_stage_catalog_stage_id', 'stage_id'],
      ['chk_ashby_stage_catalog_plan_id', 'interview_plan_id'],
      ['chk_ashby_stage_catalog_group_id', 'stage_group_id'],
      ['chk_ashby_application_progress_stage', 'current_stage_id'],
      ['chk_ashby_application_progress_job', 'current_job_id'],
      ['chk_ashby_application_progress_reason', 'archive_reason_id'],
      ['chk_ashby_application_stage_intervals_history', 'history_id'],
      ['chk_ashby_application_stage_intervals_stage', 'stage_id'],
      ['chk_ashby_archive_reasons_id', 'reason_id'],
    ];
    for (const [name, col] of ids) {
      const check = new RegExp(`constraint ${name} check \\(([\\s\\S]*?)\\),?\\n`).exec(CODE)?.[1] ?? '';
      expect(check, name).toContain(`${col} ~ '^[A-Za-z0-9_.:-]+$' and length(${col}) <= 256`);
    }
    expect(CODE).not.toMatch(/\{\d+,(25[6-9]|2[6-9]\d|[3-9]\d\d|\d{4,})\}/);
  });

  it("Ashby's stage type is open text with an identifier shape, not a closed list", () => {
    const check = /constraint chk_ashby_stage_catalog_stage_type check \(([^\n]*)\)/.exec(CODE)?.[1] ?? '';
    expect(check).toContain("stage_type ~ '^[A-Za-z0-9_.:-]{1,64}$'");
    expect(check).not.toMatch(/\bin \(/);
  });

  it('progress: one row per link, cascades with it, closed status, claim order index', () => {
    const cols = columns('ashby_application_progress');
    expect([...cols.keys()]).toEqual([
      'id', 'application_link_id', 'status', 'current_stage_id', 'current_stage_entered_at', 'current_job_id',
      'archive_reason_id', 'archive_reason_type', 'archived_at', 'ashby_updated_at', 'last_checked_at',
      'next_check_at', 'check_error_code', 'attempts', 'created_at', 'updated_at',
    ]);
    expect(cols.get('application_link_id')).toBe('uuid not null references screening_v2.ashby_application_links(id) on delete cascade');
    expect(CODE).toMatch(/constraint uq_ashby_application_progress_link unique \(application_link_id\)/);
    expect(CODE).toMatch(/constraint chk_ashby_application_progress_status check \(\s*status is null or status in \('Active','Hired','Archived','Lead'\)\)/);
    expect(cols.get('next_check_at')).toBe('timestamptz not null default now()');
    expect(FLAT).toMatch(/create index if not exists idx_ashby_application_progress_due on screening_v2\.ashby_application_progress \(next_check_at\)/);
  });

  it('intervals: unique on the Ashby history id, cascade with the link, moved_by_person is a nullable boolean', () => {
    const cols = columns('ashby_application_stage_intervals');
    expect([...cols.keys()]).toEqual([
      'id', 'application_link_id', 'history_id', 'stage_id', 'stage_title_seen', 'entered_at', 'left_at',
      'stage_number', 'moved_by_person', 'first_seen_at', 'last_seen_at', 'gone_at',
    ]);
    expect(cols.get('application_link_id')).toBe('uuid not null references screening_v2.ashby_application_links(id) on delete cascade');
    expect(CODE).toMatch(/constraint uq_ashby_application_stage_intervals_history unique \(history_id\)/);
    // true, false or unknown: the type itself is the closed set.
    expect(cols.get('moved_by_person')).toBe('boolean');
    expect(FLAT).toMatch(/create index if not exists idx_ashby_application_stage_intervals_link on screening_v2\.ashby_application_stage_intervals \(application_link_id, entered_at\)/);
    expect(FLAT).toMatch(/create index if not exists idx_ashby_application_stage_intervals_stage on screening_v2\.ashby_application_stage_intervals \(stage_id\)/);
  });

  it("archive reasons hold Ashby's own catalogue, keyed on its id", () => {
    const cols = columns('ashby_archive_reasons');
    expect([...cols.keys()]).toEqual(['reason_id', 'text', 'reason_type', 'is_archived', 'first_seen_at', 'last_seen_at']);
    expect(cols.get('reason_id')).toMatch(/^text primary key/);
  });

  it('runs: counts and a closed mode, no ids', () => {
    const cols = columns('ashby_progress_runs');
    expect([...cols.keys()]).toEqual(['id', 'started_at', 'finished_at', 'checked', 'changed', 'errors_by_code', 'mode']);
    expect(CODE).toMatch(/constraint chk_ashby_progress_runs_mode check \(mode in \('sweep','backfill'\)\)/);
    expect(CODE).toMatch(/constraint chk_ashby_progress_runs_errors check \(\s*jsonb_typeof\(errors_by_code\) = 'object' and octet_length\(errors_by_code::text\) <= 2048\)/);
  });

  it('no column can hold personal data, a staff id or free text about a candidate', () => {
    const forbidden = /^(name|email|phone|phone_e164|phone_raw|resume|resume_text|candidate_name|actor_id|actorid|staff_id|user_id|owner_id|offer_amount|salary|compensation|notes?|comment|custom_fields|hiring_team|feedback)$/;
    for (const table of TABLES) {
      for (const col of columns(table).keys()) expect(col, `${table}.${col}`).not.toMatch(forbidden);
    }
    // Every text column is bounded or format-checked.
    for (const table of TABLES) {
      for (const [col, decl] of columns(table)) {
        if (!/^text\b/.test(decl)) continue;
        expect(CODE, `${table}.${col} must be bounded`).toMatch(new RegExp(`check \\([^;]*?(length\\(${col}\\)|\\b${col} ~ |\\b${col} in \\(|\\b${col} = )`));
      }
    }
  });
});

describe('0138 refresh function', () => {
  it('never deletes and never overwrites an admin label; every other label is the default computed today', () => {
    const body = functionBody().replace(/\s+/g, ' ');
    expect(body).not.toMatch(/\bdelete\b/);
    expect(body).toMatch(/on conflict \(stage_id\) do nothing/);
    // S2-2: a default frozen at first sight left a renamed R2, a retyped R4 and
    // a moved Christy stage on their old labels. Only an admin's label is kept.
    expect(body).toContain("milestone = case when c.milestone_source = 'admin' then c.milestone else r.default_milestone end");
    expect(body).toContain(
      "milestone_source = case when c.milestone_source = 'admin' then c.milestone_source when r.default_milestone is not null then 'default' end",
    );
    expect(body).not.toMatch(/coalesce\(c\.milestone,/);
    // first_seen_at keeps its insert default: the update never assigns it.
    expect(body).not.toMatch(/first_seen_at\s*=/);
  });

  it('marks a stage a plan it read no longer lists, only for plans it read, and clears the mark when the stage is back (S2-4)', () => {
    const body = functionBody().replace(/\s+/g, ' ');
    expect(body).toContain('not_in_plan_since = null,');
    expect(body).toContain('update screening_v2.ashby_stage_catalog as c set not_in_plan_since = greatest(now(), c.first_seen_at)');
    expect(body).toContain('where c.not_in_plan_since is null and c.interview_plan_id in ( select x.interview_plan_id from jsonb_to_recordset(p_stages) as x(interview_plan_id text) where x.interview_plan_id is not null)');
    expect(body).toContain('and not exists ( select 1 from jsonb_to_recordset(p_stages) as y(stage_id text) where y.stage_id = c.stage_id)');
  });

  it('refuses a default outside the allowed set before writing anything', () => {
    const body = functionBody();
    expect(body).toMatch(/invalid_default_milestone/);
    expect(body.indexOf('invalid_default_milestone')).toBeLessThan(body.indexOf('insert into'));
  });

  it('answers counts only, a moved default apart from a new one', () => {
    expect(functionBody().replace(/\s+/g, ' ')).toContain(
      "jsonb_build_object('status', 'ok', 'inserted', v_inserted, 'updated', v_updated, 'defaulted', v_defaulted, 'redefaulted', v_redefaulted, 'left_plan', v_left)",
    );
  });
});

describe('0138 registration', () => {
  it('the policy suite proves both functions audit in their own transaction', () => {
    expect(POLICY).toMatch(/0138: a label whose audit row is refused is not written/);
    expect(POLICY).toMatch(/0138: a refresh whose audit row is refused writes nothing/);
    expect(POLICY).toMatch(/0138: each label writes one audit row in its own transaction/);
  });

  it('the policy suite has a 0138 section covering RLS, grants, cascade, uniques and every closed value', () => {
    expect(POLICY).toContain('-- 0138:');
    for (const table of TABLES) expect(POLICY).toContain(`'${table}'`);
    for (const value of STAGE_MILESTONES) expect(POLICY).toContain(`'${value}'`);
    for (const status of ['Active', 'Hired', 'Archived', 'Lead']) expect(POLICY).toContain(`'${status}'`);
    expect(POLICY).toMatch(/0138: .*cascade/i);
    expect(POLICY).toMatch(/0138: .*refresh never overwrites an admin label/i);
  });

  it('docs/data-classification.md classifies all five tables', () => {
    expect(CLASSIFICATION).toContain('0138_ashby_pipeline_progress.sql');
    for (const table of TABLES) expect(CLASSIFICATION).toContain(`screening_v2.${table}`);
  });
});
