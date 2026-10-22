/**
 * 0131 (M019, PR #378) is proven under REAL parallel sessions by scripts/test-r1-concurrency.sh
 * (job r1-concurrency-test in supabase-ci.yml, fixtures app/supabase/tests/r1_concurrency_setup.sql).
 * Text is not execution: these checks only keep that job wired, triggered on its own files, and
 * asserting the exact counts the owner's cap and 0128's single slot demand.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const read = (rel: string) => readFileSync(path.join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');

const workflow = read('.github/workflows/supabase-ci.yml');
const script = read('scripts/test-r1-concurrency.sh');
const setup = read('app/supabase/tests/r1_concurrency_setup.sql');

function job(yaml: string, name: string): string {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start < 0) return '';
  const end = lines.findIndex((l, i) => i > start && /^ {2}[a-z0-9-]+:$/.test(l));
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

describe('r1-concurrency-test (0131 under real parallel sessions)', () => {
  it('is a job in supabase-ci.yml that runs the script, and both path filters name it', () => {
    const body = job(workflow, 'r1-concurrency-test');
    expect(body).toContain('runs-on: ubuntu-latest');
    expect(body).toContain('run: bash scripts/test-r1-concurrency.sh');
    expect(workflow.split("- 'scripts/test-r1-concurrency.sh'").length - 1).toBe(2);
    // The R1 fixtures live under app/supabase/**, which both filters already cover.
    expect(workflow.split("- 'app/supabase/**'").length - 1).toBe(2);
  });

  it('applies every migration to a fresh Postgres and seeds its own fixtures', () => {
    expect(script).toContain('for f in "$MIG"/*.sql; do');
    expect(script).toContain('"$TESTS/r1_concurrency_setup.sql"');
    expect(script).toContain('ON_ERROR_STOP=1');
    expect(script).toMatch(/^set -euo pipefail$/m);
  });

  it('waits for the REAL server over TCP, not the first pg_isready of the init server', () => {
    expect(script).toContain('psql -h 127.0.0.1 -U postgres -d postgres -t -A -c \'select 1\'');
    expect(script).toContain('[ "$ready" -ge 3 ] && break');
    expect(script).not.toMatch(/docker exec [^\n]*pg_isready/);
  });

  it('starts every racer as its own session behind one settings-row blocker', () => {
    expect(script).toContain("'select 1 from screening_v2.r1_settings where singleton for update;'");
    expect(script).toContain('await_lock_waiters "r1c-race-$tag-" "$n"');
    expect(script).toContain('screening_v2.r1_admit_attempt(');
  });

  it('pins the exact admitted counts of every scenario', () => {
    const races: Array<[string, string, string, string]> = [
      ['s1-limit3-pool3', "1 '2046-01-15T12:00:00Z' r1 3 3 12", '3', "'r1_in_flight' $(seq_list 12)"],
      ['s2-limit15-pool15', "2 '2046-02-15T12:00:00Z' r1 15 15 20", '15', "'r1_in_flight' $(seq_list 20)"],
      ['s3-limit15-pool4', "3 '2046-03-15T12:00:00Z' r1 15 4 10", '4', "'r1_in_flight' $(seq_list 10)"],
      ['s4-cloud-limit15', "4 '2046-04-15T12:00:00Z' cloud 15 15 12", '1', "'r1_in_flight' $(seq_list 12)"],
      ['s5-default-limit1', "5 '2046-05-15T12:00:00Z' r1 null 3 10", '1', "'r1_in_flight' 1 1 2 2"],
      ['s6-same-round', "6 '2046-06-15T12:00:00Z' r1 3 3 1", '1', "'round_live' 1 1 1 1 1"],
      ['s6b-mixed-tabs', "7 '2046-07-15T12:00:00Z' r1 3 3 8", '3', "'r1_in_flight|round_live' 1 1 2 2 3 3 4 4"],
    ];
    for (const [tag, scenario, ok, rest] of races) {
      expect(script).toContain(`scenario ${tag} ${scenario}`);
      expect(script).toContain(`race ${tag} ${ok} ${rest}`);
    }
  });

  it('races retire_voice_worker against claim_voice_worker both ways and free-running', () => {
    expect(script).toContain('blocker_open r1c-claim-first');
    expect(script).toContain('blocker_open r1c-retire-first');
    expect(script).toContain('"claim:no_capacity retire:retired 0 0 absent")');
    expect(script).toContain('"claim:claimed retire:not_stopped 0 0 starting:$sid")');
  });

  it('verifies the 65-minute charge per admitted round from the database, never twice', () => {
    expect(setup).toContain('b.minutes_used <> 65 * p_ok');
    expect(setup).toContain('b.minutes_reserved <> 65 * (v_n - p_ok)');
    expect(setup).toContain("(snap->>'outstanding_holds')::numeric <> 65 * (v_n - p_ok)");
    expect(script).toContain('psql_q -c "select _r1c.verify(\'$tag\', $want_ok);"');
  });

  it('keeps the fixtures synthetic and asserts the shipped default first', () => {
    expect(setup).toContain('r1-concurrency@example.test');
    expect(setup).not.toMatch(/@(?!example\.test)[a-z0-9-]+\.[a-z]/i);
    expect(setup).toContain('max_concurrent_sessions = 1');
    expect(setup.indexOf('the shipped r1_settings row reads max_concurrent_sessions = 1')).toBeLessThan(
      setup.indexOf('create or replace function _r1c.scenario('),
    );
  });
});
