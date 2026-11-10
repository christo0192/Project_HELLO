/**
 * 0140: the business-impact read model (M031 S5), read from the migration's text.
 *
 * The numbers run for real on the complete schema in
 * app/supabase/tests/ashby_impact_assert.sql (scripts/test-ashby-impact.sh,
 * inside supabase-check), and the security posture in policy_tests.sql
 * (section "0140"). These checks pin what keeps the migration safe and in
 * step with the API:
 *
 *   1. additive only: two NEW tables, one NEW view, six NEW functions; nothing
 *      that exists is altered, dropped, updated or deleted; the only rows it
 *      writes outside the new tables are the switch's own audit rows;
 *   2. the tables are RLS-on and service-role only; the view runs as its
 *      caller; every function is SECURITY DEFINER with a pinned search_path
 *      and is executable by service_role only;
 *   3. the tables hold no personal data, and the one function that hands out
 *      a name hands out only the contract's fields;
 *   4. the visibility rule (D-M031-5) is the candidate page's: owner scope =
 *      owner_id equal, a row with no candidate hidden from it;
 *   5. the database's vocabulary is the API's (lib/impact.ts);
 *   6. the SQL suites are registered and run in CI.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IMPACT_OUTCOMES, IMPACT_STEPS, IMPACT_TIMINGS, IMPACT_VERDICTS } from '../lib/impact.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../../..');
const migrations = path.resolve(here, '../../../supabase/migrations');
const FILE = '0140_ashby_business_impact.sql';
const SQL = readFileSync(path.join(migrations, FILE), 'utf8').replace(/\r\n/g, '\n');
const CODE = SQL.replace(/--[^\n]*/g, '');
const FLAT = CODE.replace(/\s+/g, ' ').trim();
const read = (p: string) => readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
const POLICY = read('app/supabase/tests/policy_tests.sql');
const ASSERT = read('app/supabase/tests/ashby_impact_assert.sql');
const RUNNER = read('scripts/test-ashby-impact.sh');
const SUITE = read('scripts/supabase-test.sh');
const CI = read('.github/workflows/supabase-ci.yml');
const CLASSIFICATION = read('docs/data-classification.md');

const FUNCTIONS: Record<string, string> = {
  impact_application_rows: 'date, date, uuid, boolean, timestamptz',
  impact_summary: 'date, date, uuid, boolean, timestamptz',
  impact_candidates: 'date, date, uuid, text, text, text, text, boolean, text, uuid, integer, integer, boolean, timestamptz',
  ashby_impact_mapping_settings: '',
  set_ashby_impact_exclusion: 'uuid, boolean, uuid',
  mark_ashby_application_links_erased: 'uuid',
};

function functionBody(name: string): string {
  const start = CODE.indexOf(`create or replace function screening_v2.${name}(`);
  expect(start, `${name} must be created`).toBeGreaterThan(-1);
  const end = CODE.indexOf('\n$$;', start);
  expect(end).toBeGreaterThan(start);
  return CODE.slice(start, end);
}

describe('0140 shape', () => {
  it('is the only 0140 migration and the newest, and only S3\'s 0139 sits between it and 0138', () => {
    const files = readdirSync(migrations).filter((f) => f.endsWith('.sql')).sort();
    expect(files.filter((f) => f.startsWith('0140_'))).toEqual([FILE]);
    expect(files[files.length - 1]).toBe(FILE);
    const between = files.slice(files.indexOf('0138_ashby_pipeline_progress.sql') + 1, files.indexOf(FILE));
    expect(between).toEqual(['0139_ashby_progress_worker.sql']);
  });

  it('creates exactly two tables, one view and the six functions, and nothing else', () => {
    expect([...CODE.matchAll(/create table if not exists screening_v2\.([a-z0-9_]+)/g)].map((m) => m[1]))
      .toEqual(['ashby_impact_exclusions', 'ashby_erased_application_links']);
    expect([...CODE.matchAll(/create or replace view screening_v2\.([a-z0-9_]+)/g)].map((m) => m[1])).toEqual(['v_ashby_application_impact']);
    expect([...CODE.matchAll(/create or replace function screening_v2\.([a-z0-9_]+)\(/g)].map((m) => m[1]).sort())
      .toEqual(Object.keys(FUNCTIONS).sort());
    expect(CODE).not.toMatch(/create (unique )?index|create trigger|create type|create sequence|create policy/i);
  });

  it('is additive only: nothing that exists is altered, dropped, truncated, updated or deleted', () => {
    expect(CODE).not.toMatch(
      /\balter (table|view|function|type|index)\b(?! screening_v2\.(ashby_impact_exclusions|ashby_erased_application_links) enable row level security)/i,
    );
    expect(CODE).not.toMatch(/\bdrop\s+(table|view|function|index|trigger|type|column|constraint|policy|schema)\b/i);
    expect(CODE).not.toMatch(/\btruncate\b/i);
    expect(CODE).not.toMatch(/\bdelete\s+from\b/i);
    expect(CODE).not.toMatch(/\bupdate\s+(only\s+)?screening_v2\./i);
    // The only rows it inserts: the switch, the switch's own audit row, and the erasure list.
    expect([...CODE.matchAll(/insert into screening_v2\.([a-z0-9_]+)/g)].map((m) => m[1]).sort())
      .toEqual(['ashby_erased_application_links', 'ashby_impact_exclusions', 'audit_events']);
    // An update of the switch row is its upsert's ON CONFLICT, on its own table only; the list never updates.
    expect([...CODE.matchAll(/\bon conflict \(([a-z_]+)\) do update/g)].map((m) => m[1])).toEqual(['job_mapping_id']);
    expect([...CODE.matchAll(/\bon conflict \(([a-z_]+)\) do nothing/g)].map((m) => m[1])).toEqual(['application_link_id']);
  });

  it('never writes a link, candidate, assessment or request, and never re-creates the audit action CHECK', () => {
    for (const table of ['ashby_application_links', 'candidates', 'assessments', 'ashby_job_mappings', 'phone_engagements', 'call_sessions',
      'data_subject_requests', 'ashby_application_progress', 'ashby_application_stage_intervals']) {
      expect(FLAT).not.toMatch(new RegExp(`(insert into|update|delete from) screening_v2\\.${table}\\b`));
    }
    expect(CODE).not.toMatch(/chk_audit_action/);
    expect(functionBody('set_ashby_impact_exclusion')).toContain("'config_changed'");
  });

  it('the switch table: RLS on, service-role only, follows its mapping on delete, holds no personal data', () => {
    expect(FLAT).toContain('alter table screening_v2.ashby_impact_exclusions enable row level security;');
    expect(FLAT).toContain('revoke all on screening_v2.ashby_impact_exclusions from anon, authenticated, public;');
    expect(FLAT).toContain('grant all privileges on screening_v2.ashby_impact_exclusions to service_role;');
    expect(FLAT).toContain('job_mapping_id uuid primary key references screening_v2.ashby_job_mappings(id) on delete cascade');
    const body = CODE.slice(CODE.indexOf('create table if not exists screening_v2.ashby_impact_exclusions'), CODE.indexOf('\n);', CODE.indexOf('create table if not exists screening_v2.ashby_impact_exclusions')));
    const columns = [...body.matchAll(/^\s{2}([a-z_]+)\s/gm)].map((m) => m[1]).filter((c) => c !== 'constraint');
    expect(columns).toEqual(['job_mapping_id', 'excluded', 'created_at', 'updated_at']);
  });

  it('the erasure list: RLS on, service-role only, follows its link on delete, a link id and a time only', () => {
    expect(FLAT).toContain('alter table screening_v2.ashby_erased_application_links enable row level security;');
    expect(FLAT).toContain('revoke all on screening_v2.ashby_erased_application_links from anon, authenticated, public;');
    expect(FLAT).toContain('grant all privileges on screening_v2.ashby_erased_application_links to service_role;');
    expect(FLAT).toContain(
      'application_link_id uuid primary key references screening_v2.ashby_application_links(id) on delete cascade',
    );
    const at = CODE.indexOf('create table if not exists screening_v2.ashby_erased_application_links');
    const body = CODE.slice(at, CODE.indexOf('\n);', at));
    expect([...body.matchAll(/^\s{2}([a-z_]+)\s/gm)].map((m) => m[1])).toEqual(['application_link_id', 'created_at']);
    // The view reads it, so it must exist before the view does.
    expect(at).toBeLessThan(CODE.indexOf('create or replace view screening_v2.v_ashby_application_impact'));
  });

  it('the erasure list lists every link of the person, only under a deletion request, and writes nothing else', () => {
    const body = functionBody('mark_ashby_application_links_erased').replace(/\s+/g, ' ');
    expect(body).toContain(
      "if not exists ( select 1 from screening_v2.data_subject_requests d where d.candidate_id = p_candidate_id and d.request_type = 'delete' and d.request_status in ('pending', 'in_progress', 'fulfilled') ) then return jsonb_build_object('status', 'no_erasure_request');",
    );
    // Every link of the person: no terminal-state filter, so an already-terminal link is listed too.
    expect(body).toContain(
      'insert into screening_v2.ashby_erased_application_links (application_link_id) select l.id from screening_v2.ashby_application_links l where l.candidate_id = p_candidate_id on conflict (application_link_id) do nothing;',
    );
    expect(body).not.toMatch(/terminal_state|terminal_reason/);
    expect([...body.matchAll(/insert into screening_v2\.([a-z0-9_]+)/g)].map((m) => m[1])).toEqual(['ashby_erased_application_links']);
  });

  it('the view runs as its caller and only service_role reads it', () => {
    expect(FLAT).toContain('create or replace view screening_v2.v_ashby_application_impact with (security_invoker = true) as');
    expect(FLAT).toContain('revoke all on screening_v2.v_ashby_application_impact from anon, authenticated, public;');
    expect(FLAT).toContain('grant select on screening_v2.v_ashby_application_impact to service_role;');
  });

  it.each(Object.entries(FUNCTIONS))('%s is SECURITY DEFINER, pins search_path, and only service_role may run it', (name, sig) => {
    const body = functionBody(name).replace(/\s+/g, ' ');
    expect(body).toMatch(/ security definer set search_path = pg_catalog, screening_v2 as \$\$/);
    expect(FLAT).toContain(`revoke all on function screening_v2.${name}(${sig}) from public, anon, authenticated;`);
    expect(FLAT).toContain(`grant execute on function screening_v2.${name}(${sig}) to service_role;`);
  });

  it('only the switch and the erasure list write: every other function is STABLE', () => {
    for (const name of ['impact_application_rows', 'impact_summary', 'impact_candidates', 'ashby_impact_mapping_settings']) {
      expect(functionBody(name).replace(/\s+/g, ' '), name).toMatch(/\blanguage (sql|plpgsql) stable security definer\b/);
    }
    for (const name of ['set_ashby_impact_exclusion', 'mark_ashby_application_links_erased']) {
      expect(functionBody(name).replace(/\s+/g, ' '), name).toMatch(/\blanguage plpgsql security definer\b/);
    }
  });
});

describe('0140 personal data', () => {
  it('no code reads an email, a phone, a resume, an Ashby actor or a candidate free-text column', () => {
    // The COMMENT ON texts say what is NOT there ("no email, phone ..."), so they are left out.
    const statements = CODE.replace(/\bcomment on [\s\S]*?';\n/g, '');
    expect(statements).not.toMatch(/\bemail\b|phone_e164|phone_raw|\bparsed\b|resume|actorId|moved_by_person|external_candidate_id|custom_?fields|offer_amount|salary/i);
    // The one actor the migration names is the switch's audit row: the admin's own id, in audit_events.
    expect([...CODE.matchAll(/(?<!p_)\bactor_id\b/g)].length).toBe(1);
    expect(FLAT).toContain(
      'insert into screening_v2.audit_events (actor_id, actor_type, action, target_type, target_id, result, metadata) values (p_actor_id, ',
    );
  });

  it('the summary and its rows carry no candidate name, only counts, ids, codes, times and stage titles', () => {
    expect(functionBody('impact_summary')).not.toMatch(/\.name\b|candidates\b/);
    expect(functionBody('impact_application_rows')).not.toMatch(/\.name\b|screening_v2\.candidates/);
    const view = CODE.slice(CODE.indexOf('create or replace view'), CODE.indexOf('comment on view'));
    expect(view).not.toMatch(/\.name\b/);
    // The view reads ONE candidate column, the appeal block, as a flag.
    expect([...view.matchAll(/screening_v2\.candidates\b/g)]).toHaveLength(1);
    expect([...new Set([...view.matchAll(/\bcand\.([a-z_]+)/g)].map((m) => m[1]))].sort()).toEqual(['decision_use_blocked_at', 'id']);
  });

  it('a list row is built from the contract\'s eleven fields only: name and role from the candidate record', () => {
    const body = functionBody('impact_candidates');
    const row = body.slice(body.indexOf("'candidateId'"), body.indexOf("'lastMoveAt'") + 40);
    const keys = [...row.matchAll(/'([a-zA-Z]+)',/g)].map((m) => m[1]);
    expect(keys).toEqual([
      'candidateId', 'name', 'roleTitle', 'verdict', 'score', 'provisional',
      'currentStageTitle', 'currentMilestone', 'status', 'enteredChristyAt', 'lastMoveAt',
    ]);
    expect(body).toContain('c.name as cand_name');
    expect(body).toContain('ro.title as role_title');
  });

  it('archive reasons reach the summary from Ashby\'s catalogue only (ashby_archive_reasons.text), never typed text', () => {
    expect(FLAT).toContain('left join screening_v2.ashby_archive_reasons ar on ar.reason_id = base.archive_reason_id');
    expect(FLAT).toContain('ar.text as archive_reason_text');
    expect(functionBody('impact_summary').replace(/\s+/g, ' ')).toContain('limit 5');
  });

  it('erased and restricted subjects are left out: the erasure list, a link the erasure terminated, a request', () => {
    const view = CODE.slice(CODE.indexOf('create or replace view'), CODE.indexOf('comment on view')).replace(/\s+/g, ' ');
    expect(view).toContain(
      "where l.provider = 'ashby' and not exists ( select 1 from screening_v2.ashby_erased_application_links e where e.application_link_id = l.id) and l.terminal_reason is distinct from 'subject_erasure'",
    );
    expect(view).toContain("and d.request_type in ('restrict', 'delete') and d.request_status in ('pending', 'in_progress', 'fulfilled')");
  });
});

describe('0140 visibility (D-M031-5)', () => {
  it('owner scope is the candidate page\'s rule: owner_id equal, and a row with no candidate is hidden', () => {
    const body = functionBody('impact_candidates').replace(/\s+/g, ' ');
    expect(body).toContain("not (p_scope = 'owner' and (c.id is null or c.owner_id is distinct from p_owner_id)) as visible");
    expect(body).toContain("if p_scope is null or p_scope not in ('all', 'owner') or (p_scope = 'owner' and p_owner_id is null) then return jsonb_build_object('status', 'invalid_scope');");
  });

  it('what a viewer cannot open is counted and never paged: only visible rows are numbered', () => {
    const body = functionBody('impact_candidates').replace(/\s+/g, ' ');
    expect(body).toContain('count(*) filter (where s.visible)::integer as total, count(*) filter (where not s.visible)::integer as hidden');
    expect(body).toContain('from s where s.visible');
    expect(body).toContain('order by s.last_move_at desc nulls last, s.came_in_at desc, s.application_link_id');
  });

  it('an appeal-blocked verdict is suppressed everywhere: out of the verdict table and its lists, and blank on a row', () => {
    const body = functionBody('impact_candidates').replace(/\s+/g, ' ');
    // Out of the verdict cells and their lists alike, so no list can be subtracted from its cell.
    expect(functionBody('impact_summary').replace(/\s+/g, ' ')).toContain(
      'left join f on f.n_connected and f.verdict = r.verdict and not f.decision_blocked',
    );
    expect(body).toContain('f.ashby_read and f.n_connected and f.verdict = p_verdict and not f.decision_blocked and case p_outcome');
    expect(body).toContain("'verdict', case when p.decision_blocked then null else p.verdict end");
    expect(body).toContain("'score', case when not p.decision_blocked and p.has_assessment then p.score end");
    expect(body).toContain("'provisional', not p.decision_blocked and p.provisional");
    // Hidden means only "cannot open": the block never moves a row there.
    const visible = /, (not \(p_scope = 'owner'.*?\)\)) as visible/.exec(body);
    expect(visible?.[1]).toBe("not (p_scope = 'owner' and (c.id is null or c.owner_id is distinct from p_owner_id))");
  });

  it('the list reads the same nested rows as the summary', () => {
    expect(functionBody('impact_summary')).toContain('screening_v2.impact_application_rows(v_from, v_to, p_job, p_progress_enabled, v_now)');
    expect(functionBody('impact_candidates')).toContain('screening_v2.impact_application_rows(v_from, v_to, p_job, p_progress_enabled, v_now)');
  });
});

describe('0140 agrees with the API', () => {
  it('the pipeline steps, in order', () => {
    const body = functionBody('impact_summary');
    const steps = body.slice(body.indexOf('steps (idx, step, label) as ('), body.indexOf('sc as ('));
    expect([...steps.matchAll(/\(\d, '([a-z_0-9]+)'/g)].map((m) => m[1])).toEqual([...IMPACT_STEPS]);
    const list = functionBody('impact_candidates');
    expect([...list.matchAll(/when '([a-z_0-9]+)' then \d/g)].map((m) => m[1])).toEqual([...IMPACT_STEPS]);
  });

  it('the verdicts, the outcome columns and the timings', () => {
    const body = functionBody('impact_summary');
    const verdicts = body.slice(body.indexOf('vrows (ord, verdict, label) as ('), body.indexOf('vc as ('));
    expect([...verdicts.matchAll(/\(\d, '([a-z]+)'/g)].map((m) => m[1])).toEqual([...IMPACT_VERDICTS]);
    const columns = body.slice(body.indexOf("'columns', jsonb_build_array("), body.indexOf("'rows', jsonb_agg("));
    expect([...columns.matchAll(/'key', '([a-z_0-9]+)'/g)].map((m) => m[1])).toEqual([...IMPACT_OUTCOMES]);
    const timings = body.slice(body.indexOf('tkeys (ord, key, label) as ('), body.indexOf('tm as ('));
    expect([...timings.matchAll(/\(\d, '([a-z_0-9]+)'/g)].map((m) => m[1])).toEqual([...IMPACT_TIMINGS]);
  });

  it('each cohort week, job row and verdict row is gated on its own reads, not the window\'s', () => {
    const body = functionBody('impact_summary').replace(/\s+/g, ' ');
    // One gate per group: Ashby has been read for one of ITS applications (and the window's gate holds).
    expect([...body.matchAll(/coalesce\(bool_or\(f\.ashby_read and f\.ashby_known\), false\) as rd/g)]).toHaveLength(3);
    for (const k of ['c_fwd', 'c_r1', 'c_r2', 'c_offer', 'c_hired']) {
      expect(body).toContain(`case when wk.rd then round(wk.${k}::numeric / wk.came, 3) end`);
      expect(body).toContain(`case when bj.rd then round(bj.${k}::numeric / bj.came, 3) end`);
    }
    // A verdict row with applications, none read, is null; an empty row follows the window.
    expect(body).toContain("'cells', case when vc.rd or (vc.total = 0 and cov.rd) then jsonb_build_object(");
    // The window's gate is the pipeline's alone now.
    expect(body).not.toMatch(/case when cov\.rd then round\(/);
    expect(body).not.toContain("'cells', case when cov.rd");
  });

  it('medians and p90s are withheld under n 5, and meta says 5', () => {
    const body = functionBody('impact_summary').replace(/\s+/g, ' ');
    expect(body).toContain("'medianDays', case when tm.n >= 5 then round(tm.med::numeric, 2) end");
    expect(body).toContain("'p90Days', case when tm.n >= 5 then round(tm.p90::numeric, 2) end");
    expect(body).toContain("'minTimingN', 5");
  });

  it('Archived-type and Lead-type stages never count as reached', () => {
    expect(FLAT).toContain("(coalesce(c.stage_type, '') in ('Archived', 'Lead') or c.milestone is not distinct from 'archived') as never_reached");
    for (const step of ['r1', 'r2', 'offer', 'hired']) {
      expect(FLAT).toMatch(new RegExp(`\\(not iv\\.never_reached and coalesce\\(iv\\.milestone_rank, 0\\) >= \\d\\) as ${step}\\b`));
    }
  });
});

describe('0140 registration', () => {
  it('the SQL suite runs in supabase-check on the complete chain, in one rolled-back transaction', () => {
    expect(ASSERT.trimStart()).toMatch(/^-- 0140/);
    expect(ASSERT).toMatch(/\nbegin;\n/);
    expect(ASSERT.trimEnd().endsWith('rollback;')).toBe(true);
    expect(RUNNER).toContain('< "$TESTS/ashby_impact_assert.sql"');
    expect(RUNNER).toContain('ON_ERROR_STOP=1');
    expect(SUITE).toContain('bash scripts/test-ashby-impact.sh');
    expect(CI).toContain("- 'scripts/test-ashby-impact.sh'");
  });

  it('the SQL suite covers each case the slice names', () => {
    for (const label of [
      'nests under the step before it',
      'has no share over 100%',
      'a re-application keeps its OWN verdict',
      'a re-screen of the same application takes the newest verdict',
      'a job transfer counts under the job it came from',
      'a skipped stage still reaches R1 and R2',
      'a backward move still counts as moved forward',
      'an Archived stage late in the plan never counts as reaching Offer or R2',
      'archived from the Christy stage',
      'a provisional verdict counts under its verdict',
      'thin evidence is held',
      'browser_primary',
      'IST week edge',
      'under n 5 the median and p90 are null',
      'progress off',
      'coverage 0',
      'a job left out leaves every figure',
      'an interviewer lists only their own candidates',
      'no row of another owner, and no row without a candidate, ever reaches an interviewer',
      'erased and restricted subjects are not in the view',
      'an erased subject whose link was already terminal is in no row',
      'every link of the erased person is listed, the already-terminal one included',
      'listing needs a deletion request for that person',
      'a week none of whose applications Ashby has read shows null Ashby-side shares, never 0',
      'an unread week chosen alone is the same row as inside the 12-week view',
      'an unread job is the same row in the all-jobs view as chosen alone',
      'a row none of whose applications is read shows null cells, never 0',
    ]) {
      expect(ASSERT, label).toContain(label);
    }
  });

  it('the policy suite has a 0140 section for the posture', () => {
    for (const label of [
      '0140: ashby_impact_exclusions exists with RLS enabled, no policy and no browser privilege',
      '0140: ashby_erased_application_links exists with RLS enabled, no policy and no browser privilege',
      '0140: the erasure list holds a link id and a time only, and follows its link on delete (cascade)',
      '0140: v_ashby_application_impact runs as its caller and only service_role may read it',
      '0140: the six impact functions are SECURITY DEFINER, pin search_path, and only service_role may run them',
      '0140: a switch whose audit row is refused is not written',
      '0140: deleting a mapping takes its switch (cascade)',
      '0140: the erasure list lists nothing without a deletion request',
    ]) {
      expect(POLICY, label).toContain(label);
    }
  });

  it('docs/data-classification.md classifies the tables and the view', () => {
    expect(CLASSIFICATION).toContain('0140_ashby_business_impact.sql');
    expect(CLASSIFICATION).toContain('screening_v2.ashby_impact_exclusions');
    expect(CLASSIFICATION).toContain('screening_v2.ashby_erased_application_links');
    expect(CLASSIFICATION).toContain('screening_v2.v_ashby_application_impact');
  });
});
