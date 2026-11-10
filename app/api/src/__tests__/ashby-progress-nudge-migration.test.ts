/**
 * 0141: the Ashby progress worker's webhook nudge (M031 S4), read from the
 * migration's text.
 *
 * The function runs on real Postgres in app/supabase/tests/policy_tests.sql
 * (section "0141"): due now, created if missing, never later, idempotent, a
 * link the erasure rules leave out never nudged, a non-imported application
 * writing nothing, and the interplay with a row the worker is reading. These
 * checks pin what makes the migration safe:
 *
 *   1. additive only: one new function, and no table, column, view, index,
 *      trigger, policy or existing function created, altered or dropped;
 *   2. it writes ashby_application_progress and nothing else, in one
 *      statement, and only ever moves next_check_at earlier;
 *   3. it takes its links from S3's coverage rule and repeats no part of it;
 *   4. SECURITY DEFINER, pinned search_path, service_role only;
 *   5. it answers a status code, never an id.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROGRESS_NUDGE_RPC, PROGRESS_NUDGE_STATUSES } from '../integrations/ashby/progress-nudge.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrations = path.resolve(here, '../../../supabase/migrations');
const FILE = '0141_ashby_progress_nudge.sql';
const SQL = readFileSync(path.join(migrations, FILE), 'utf8').replace(/\r\n/g, '\n');
const CODE = SQL.replace(/--[^\n]*/g, '');
const FLAT = CODE.replace(/\s+/g, ' ').trim();
const POLICY = readFileSync(path.resolve(here, '../../../supabase/tests/policy_tests.sql'), 'utf8').replace(/\r\n/g, '\n');
const NAME = 'nudge_ashby_application_progress';
const SIGNATURE = 'text, timestamptz';

function body(): string {
  const start = CODE.indexOf(`create or replace function screening_v2.${NAME}(`);
  expect(start, `${NAME} must be created`).toBeGreaterThan(-1);
  const end = CODE.indexOf('\n$$;', start);
  return CODE.slice(start, end).replace(/\s+/g, ' ');
}

describe('0141 shape', () => {
  it('is the only 0141 migration, after the 0139 functions it builds on', () => {
    const files = readdirSync(migrations).filter((f) => f.endsWith('.sql')).sort();
    expect(files.filter((f) => f.startsWith('0141_'))).toEqual([FILE]);
    expect(files.indexOf(FILE)).toBeGreaterThan(files.indexOf('0139_ashby_progress_worker.sql'));
    expect(files.indexOf('0139_ashby_progress_worker.sql')).toBeGreaterThan(-1);
  });

  it('creates exactly one function, and no table, view, column, index, trigger or policy', () => {
    const created = [...CODE.matchAll(/create or replace function screening_v2\.([a-z0-9_]+)\(/g)].map((m) => m[1]);
    expect(created).toEqual([NAME]);
    expect(FLAT).not.toMatch(/\bcreate (table|view|materialized view|index|unique index|trigger|policy|type|sequence)\b/);
    expect(FLAT).not.toMatch(/\balter (table|column|view|function|type)\b/);
    expect(FLAT).not.toMatch(/\bdrop (table|column|view|function|index|trigger|constraint|policy|type)\b/);
    expect(FLAT).not.toMatch(/\b(truncate|merge into|delete)\b/);
  });

  it('writes ashby_application_progress and nothing else, in one statement', () => {
    const writes = [...FLAT.matchAll(/\b(insert into|update|delete from)\s+screening_v2\.([a-z0-9_]+)/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(writes).toEqual(['insert into ashby_application_progress']);
    // Never a link, a candidate, an assessment, a request, a mapping or an audit row.
    expect(FLAT).not.toMatch(/(insert into|update|delete from)\s+screening_v2\.(ashby_application_links|candidates|assessments|data_subject_requests|ashby_job_mappings|audit_events)\b/);
    expect(FLAT).not.toMatch(/\bscreening_v2\.(candidates|assessments|audit_events|ashby_application_stage_intervals|ashby_progress_runs)\b/);
  });

  it('sets a short lock timeout first, and reloads the schema cache at the end', () => {
    const lock = CODE.indexOf("set local lock_timeout = '10s';");
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(CODE.indexOf('create or replace function'));
    expect(CODE.trimEnd().endsWith("notify pgrst, 'reload schema';")).toBe(true);
  });
});

describe('0141 security posture', () => {
  it('is SECURITY DEFINER, pins search_path, and only service_role may run it', () => {
    expect(body()).toMatch(/language plpgsql volatile security definer set search_path = pg_catalog, screening_v2 as \$\$/);
    expect(FLAT).toContain(`revoke all on function screening_v2.${NAME}(${SIGNATURE}) from public, anon, authenticated;`);
    expect(FLAT).toContain(`grant execute on function screening_v2.${NAME}(${SIGNATURE}) to service_role;`);
    expect(FLAT).toContain(`comment on function screening_v2.${NAME}(${SIGNATURE}) is`);
  });

  it('grants nothing to a browser role', () => {
    expect(FLAT).not.toMatch(/\bgrant [a-z, ]+ to (anon|authenticated|public)\b/);
  });

  it('the API calls it by this name with these argument names', () => {
    expect(PROGRESS_NUDGE_RPC).toBe(NAME);
    expect(body()).toContain(`${NAME}( p_external_application_id text, p_now timestamptz ) returns jsonb`);
  });
});

describe('0141 the nudge', () => {
  it('refuses a malformed id before it reads anything', () => {
    const b = body();
    const guard = b.indexOf("if p_external_application_id is null or length(p_external_application_id) not between 1 and 256 then return jsonb_build_object('status', 'invalid_request');");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(b.indexOf('select'));
  });

  it('finds the link on its unique key, then applies S3\'s coverage rule, then writes', () => {
    const b = body();
    const lookup = b.indexOf("from screening_v2.ashby_application_links l where l.provider = 'ashby' and l.external_application_id = p_external_application_id;");
    const notImported = b.indexOf("if not found then return jsonb_build_object('status', 'not_imported');");
    const coverage = b.indexOf('if not exists (select 1 from screening_v2.ashby_progress_covered_links() c where c.link_id = v_link) then');
    const notCovered = b.indexOf("return jsonb_build_object('status', 'not_covered');");
    const write = b.indexOf('insert into screening_v2.ashby_application_progress');
    expect(lookup).toBeGreaterThan(-1);
    expect(notImported).toBeGreaterThan(lookup);
    // The coverage rule only for a link that exists: the common case (an
    // application HELLO never imported) costs one index probe.
    expect(coverage).toBeGreaterThan(notImported);
    expect(notCovered).toBeGreaterThan(coverage);
    expect(write).toBeGreaterThan(notCovered);
  });

  it('repeats no part of the coverage rule', () => {
    expect(body()).not.toMatch(/subject_erasure|data_subject_requests|terminal_state|terminal_reason|candidate_id/);
  });

  it('creates a missing row due now, the way the claim seeds one, and otherwise only ever moves next_check_at earlier', () => {
    const b = body();
    expect(b).toContain(
      'insert into screening_v2.ashby_application_progress as p (application_link_id, next_check_at, created_at, updated_at) values (v_link, v_now, v_now, v_now)'
      // Only next_check_at, and only to an earlier time: never status, attempts,
      // the error code or updated_at (the backfill's "read since" mark).
      + ' on conflict (application_link_id) do update set next_check_at = excluded.next_check_at where p.next_check_at > excluded.next_check_at;',
    );
    expect(b).toContain('v_now timestamptz := coalesce(p_now, now());');
  });

  it('answers a status code only, from a closed set the API knows', () => {
    const b = body();
    const keys = [...b.matchAll(/jsonb_build_object\(\s*'([a-z_]+)'/g)].map((m) => m[1]);
    expect(new Set(keys)).toEqual(new Set(['status']));
    const literals = new Set([...b.matchAll(/'(marked|created|already_due|not_imported|not_covered|invalid_request)'/g)].map((m) => m[1]));
    expect(literals).toEqual(new Set([...PROGRESS_NUDGE_STATUSES, 'invalid_request']));
  });
});

describe('0141 registration', () => {
  it('the policy suite runs it for real', () => {
    expect(POLICY).toContain('-- 0141:');
    expect(POLICY).toContain(`screening_v2.${NAME}(`);
    for (const t of [
      '0141: the nudge is SECURITY DEFINER, pins search_path, and only service_role may run it',
      '0141: a nudge marks an imported application due now and changes nothing else on its row',
      '0141: a nudge creates the missing row of an imported application, due now',
      '0141: a nudge is idempotent and never moves a due time later',
      '0141: a nudge only ever moves a due time earlier',
      '0141: a nudge never delays a row already due earlier',
      '0141: a nudge marks a gone application due once more',
      '0141: a nudge for an application HELLO never imported writes nothing',
      '0141: a link the erasure rules leave out is never nudged',
      '0141: a malformed nudge is refused and writes nothing',
      '0141: the next claim takes every nudged row',
      '0141: a nudge during a read marks it due again; the read is refused (lease_lost) and read again',
      '0141: a nudge writes nothing but the progress row',
    ]) expect(POLICY).toContain(t);
  });
});
