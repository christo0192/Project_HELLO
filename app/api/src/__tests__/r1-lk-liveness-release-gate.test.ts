/**
 * PR-LK-liveness (R1, PR #345) — the RELEASE CONTRACT, asserted from the
 * repository itself.
 *
 * The round-3 gate review raised findings that no behavioural unit test can see:
 * what reaches CI, what the PR description may truthfully claim about the phone
 * lane, how a one-merge/three-deploy change is gated by hand, and the style of
 * the added production lines. Each block below fails when its claim stops being
 * true, so the PR description, the runbook and the code cannot drift apart:
 *
 *   1. CI wiring: the tests this PR adds exist, are collected by vitest, and the
 *      Quality, supabase-check and deploy-fly paths really execute what the PR
 *      relies on; the migration number is not duplicated (a rebase onto a main
 *      that gained its own 0118 turns red).
 *   2. Phone-shared RPCs: 0118 re-declares claim_voice_worker and
 *      reset_voice_worker as the 0112 text plus exactly one line; the opt-in
 *      defaults the PR description lists are the defaults the code ships; the
 *      phone-impact record (plan section 9) names exactly what agent.py does.
 *   3. The hand-run deploy gate: the runbook records the window, the pause, the
 *      zero checks and the recovery, and its claims about the workflow hold.
 *   4. Production line length (100 columns) and the wrapped host patterns that
 *      replaced two single-line regexes.
 *   5. The open S0-F3 observation is recorded where the code points at it.
 *
 * This file reads repository text only: no database, no network, no git.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { browserLiveKitEndpoint } from '../lib/livekit-endpoints.js';
import { LIVEKIT_HOST_RE } from '../routes/voice-worker.js';

const lf = (text: string): string => text.replace(/\r\n/g, '\n');
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const read = (relative: string): string => lf(readFileSync(`${ROOT}${relative}`, 'utf8'));
const MIGRATIONS = 'app/supabase/migrations/';

const migrationFiles = (): string[] =>
  readdirSync(`${ROOT}${MIGRATIONS}`).filter((f) => f.endsWith('.sql')).sort();
const migrationNamed = (prefix: string): string => {
  const matches = migrationFiles().filter((f) => f.startsWith(`${prefix}_`));
  if (matches.length !== 1) throw new Error(`expected exactly one ${prefix}_ migration`);
  return matches[0];
};

const M0112 = read(`${MIGRATIONS}${migrationNamed('0112')}`);
const M0118 = read(`${MIGRATIONS}${migrationNamed('0118')}`);
const RUNBOOK = read('docs/runbooks/r1-operations.md');
const DEPLOY = read('.github/workflows/deploy-fly.yml');
const DRIFT_SCRIPT = read('scripts/verify-prod-function-drift.sh');

/** The test files this PR adds. Untracked until committed: `git commit -a` drops them. */
const NEW_TEST_FILES = [
  'app/api/src/__tests__/r1-0118-prod-drift-check.test.ts',
  'app/api/src/__tests__/r1-lk-liveness-release-gate.test.ts',
] as const;

/** Collapse runs of whitespace, so a prose assertion survives re-wrapping. */
const flat = (text: string): string => text.replace(/\s+/g, ' ');

/** `text` contains `needle`, ignoring how either is wrapped. */
function expectFlatContains(text: string, needle: string, message = needle): void {
  expect(flat(text), message).toContain(flat(needle));
}

/** Section of `text` from `from` up to (not including) `to`. Throws when absent. */
function between(text: string, from: string, to: string): string {
  const start = text.indexOf(from);
  if (start === -1) throw new Error(`anchor not found: ${from}`);
  const end = text.indexOf(to, start + from.length);
  if (end === -1) throw new Error(`anchor not found: ${to}`);
  return text.slice(start, end);
}

// ── 1. CI wiring ────────────────────────────────────────────────────────

/** `src/**\/*.test.ts` style globs: `**` crosses directories, `*` does not. */
function globMatches(glob: string, path: string): boolean {
  const pattern = glob
    .split('**/')
    .map((part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
    .join('(?:.*/)?');
  return new RegExp(`^${pattern}$`).test(path);
}

describe('1. CI wiring: what this PR adds is collected and executed', () => {
  it.each(NEW_TEST_FILES)('%s exists, so a commit that omits it fails Quality', (file) => {
    expect(existsSync(`${ROOT}${file}`)).toBe(true);
  });

  it('the API vitest include collects every new test file', () => {
    const config = read('app/api/vitest.config.ts');
    const include = /include:\s*\['([^']+)'\]/.exec(config)?.[1];
    expect(include).toBeDefined();
    for (const file of NEW_TEST_FILES) {
      expect(globMatches(include!, file.replace('app/api/', ''))).toBe(true);
    }
    expect(globMatches(include!, 'scripts/not-a-test.mjs')).toBe(false);
  });

  it('Quality runs the whole API suite on every pull request (no path filter)', () => {
    const quality = read('.github/workflows/quality.yml');
    expect(JSON.parse(read('app/api/package.json')).scripts.test).toBe('vitest run');
    expect(quality).toMatch(/working-directory: app\/api\n\s+run: npm ci && .*npm test\b/);
    const triggers = between(quality, '\non:', '\npermissions:');
    expect(triggers).toContain('pull_request:');
    expect(triggers).not.toContain('paths');
  });

  it('supabase-check runs the 0118 assertions on a real Postgres for this PR', () => {
    const workflow = read('.github/workflows/supabase-ci.yml');
    const pullRequest = between(workflow, '  pull_request:', '  push:');
    expect(pullRequest).toContain("- 'app/supabase/**'");
    expect(between(workflow, '  supabase-check:', '  funnel-views-test:')).toContain(
      'bash scripts/supabase-test.sh',
    );
    expect(read('scripts/supabase-test.sh')).toContain(
      'bash scripts/test-r1-foundation.sh',
    );
    expect(read('scripts/test-r1-foundation.sh')).toContain(
      '"$TESTS/r1_foundation_assert.sql"',
    );
  });

  it('r1_foundation_assert.sql carries the discriminating 0118 assertions', () => {
    const sql = read('app/supabase/tests/r1_foundation_assert.sql');
    expect(sql.match(/_r1_tests\.assert\('0118 /g)?.length).toBeGreaterThanOrEqual(20);
    for (const title of [
      '0118 claim/reset keep the 0112 name reset and add the host reset',
      '0118 claim returns the claimed machine and nulls a stale host',
      '0118 reset nulls the host and releases the claim',
      '0118 RPC rejects a phone lease (invalid_pipeline) without a write',
      '0118 browser-only check rejects a direct phone host write',
    ]) {
      expect(sql, title).toContain(title);
    }
  });

  it('deploy-fly applies migrations, then drift-checks, before any app deploy', () => {
    const migrate = between(DEPLOY, '  migrate-production:', '\n  deploy-api:');
    expect(migrate).toContain('needs: detect');
    const push = migrate.indexOf('db push --db-url');
    const drift = migrate.indexOf('bash scripts/verify-prod-function-drift.sh');
    expect(push).toBeGreaterThan(-1);
    expect(drift).toBeGreaterThan(push);
    expect(DEPLOY.match(/needs: \[detect, migrate-production\]/g)).toHaveLength(3);
  });

  it('migration numbers are unique and gap-free, so a rebase collision turns red', () => {
    const numbers = migrationFiles().map((f) => Number(f.slice(0, 4)));
    expect(new Set(numbers).size).toBe(numbers.length);
    numbers.forEach((n, index) => expect(n).toBe(index + 1));
    expect(numbers).toContain(117);
    expect(numbers).toContain(118);
  });
});

// ── 2. Phone-shared RPCs and the opt-in defaults ────────────────────────

/** One `create or replace function screening_v2.<name>(` from header to `$$;`. */
function declarations(sql: string, name: string): string[] {
  const anchor = `create or replace function screening_v2.${name}(`;
  const found: string[] = [];
  let from = 0;
  for (;;) {
    const start = sql.indexOf(anchor, from);
    if (start === -1) return found;
    const end = sql.indexOf('\n$$;', start);
    if (end === -1) throw new Error(`${name} declaration is unterminated`);
    found.push(sql.slice(start, end + 4));
    from = end;
  }
}

/** Multiset line diff via LCS, so a moved line counts as removed plus added. */
function lineDelta(prev: string, next: string): { added: string[]; removed: string[] } {
  const a = prev.split('\n');
  const b = next.split('\n');
  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
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

/** The newest declaration of `name` in a migration numbered below 0118. */
function latestEarlier(name: string): { file: string; body: string } {
  let latest: { file: string; body: string } | undefined;
  for (const file of migrationFiles()) {
    if (Number(file.slice(0, 4)) >= 118) continue;
    const found = declarations(read(`${MIGRATIONS}${file}`), name);
    if (found.length > 0) latest = { file, body: found[found.length - 1] };
  }
  if (!latest) throw new Error(`${name} is not declared before 0118`);
  return latest;
}

describe('2. 0118 re-declares the two phone-shared RPCs as 0112 plus ONE line', () => {
  it.each(['claim_voice_worker', 'reset_voice_worker'])(
    '%s: 0112 is its latest earlier declaration, and 0118 only adds the host reset',
    (name) => {
      const earlier = latestEarlier(name);
      expect(earlier.file).toBe(migrationNamed('0112'));
      const [next, ...rest] = declarations(M0118, name);
      expect(rest).toEqual([]);
      const { added, removed } = lineDelta(earlier.body, next);
      expect(removed).toEqual([]);
      expect(added).toEqual(['         livekit_host       = null,']);
    },
  );

  it('the host reset sits in the NEW-claim UPDATE, never in the idempotent branch', () => {
    const [claim] = declarations(M0118, 'claim_voice_worker');
    const update = claim.indexOf("set state              = 'starting',");
    expect(update).toBeGreaterThan(-1);
    expect(claim.indexOf('livekit_host')).toBeGreaterThan(update);
    expect(claim.slice(0, update)).not.toContain('livekit_host');
  });

  it('re-issues the exact 0112 privileges for both replaced RPCs', () => {
    for (const sig of [
      'screening_v2.claim_voice_worker(text, text, uuid, bigint, timestamptz)',
      'screening_v2.reset_voice_worker(text, text, timestamptz)',
    ]) {
      const grant = `revoke all on function ${sig}\n  from public, anon, authenticated;\n`
        + `grant execute on function ${sig}\n  to service_role;`;
      expect(M0112).toContain(grant);
      expect(M0118).toContain(grant);
    }
  });

  it('the CHECK makes the added assignment a no-op for every phone lease', () => {
    expect(M0118).toContain(
      "check (livekit_host is null or pipeline = 'browser') not valid;",
    );
    expect(M0118).toContain("'invalid_pipeline'");
  });
});

/** The cells of the runbook table row that starts with `key`. */
function optInRow(key: string): string[] {
  const line = RUNBOOK.split('\n').find((l) => l.startsWith(`| \`${key}\``));
  if (!line) throw new Error(`runbook opt-in row not found: ${key}`);
  return line.split('|').map((cell) => cell.trim());
}

describe('2. the opt-in table in the runbook and the PR is what the code ships', () => {
  const originalTarget = process.env.BROWSER_LIVEKIT_TARGET;
  afterEach(() => {
    if (originalTarget === undefined) delete process.env.BROWSER_LIVEKIT_TARGET;
    else process.env.BROWSER_LIVEKIT_TARGET = originalTarget;
  });

  it('lists the three exact switches with the right owner and the off behaviour', () => {
    const readiness = optInRow('R1_READINESS_HOST=on');
    expect(readiness[1]).toContain('(exact)');
    expect(readiness[2]).toBe('browser worker');
    expect(readiness[3]).toContain('legacy');
    expect(readiness[3]).toContain('no `livekit_host` is ever sent');
    const oneJob = optInRow('BROWSER_WORKER_ONE_JOB=on');
    expect(oneJob[2]).toBe('browser worker');
    expect(oneJob[3]).toContain('SDK CPU load average');
    const target = optInRow('BROWSER_LIVEKIT_TARGET=r1');
    expect(target[2]).toBe('API');
    expect(target[3]).toContain('never run');
  });

  it('the worker switches default off in .env.example and are absent from both fly configs', () => {
    const example = read('app/voice-livekit/.env.example');
    expect(example).toMatch(/^R1_READINESS_HOST=off$/m);
    expect(example).toMatch(/^BROWSER_WORKER_ONE_JOB=off$/m);
    for (const file of ['app/voice-livekit/fly.toml', 'app/voice-livekit/fly.phone.toml']) {
      expect(read(file), file).not.toMatch(/^\s*(R1_READINESS_HOST|BROWSER_WORKER_ONE_JOB)\s*=/m);
    }
    const schema = read('config/environment.schema.json');
    expect(schema).toContain('"R1_READINESS_HOST"');
    expect(schema).toContain('"BROWSER_WORKER_ONE_JOB"');
  });

  it('the API target is Cloud unless it is exactly `r1`', () => {
    delete process.env.BROWSER_LIVEKIT_TARGET;
    expect(browserLiveKitEndpoint().target).toBe('cloud');
    for (const value of ['', 'R1', ' r1', 'r1 ', 'true', 'on', '1', 'cloud']) {
      process.env.BROWSER_LIVEKIT_TARGET = value;
      expect(browserLiveKitEndpoint().target, JSON.stringify(value)).toBe('cloud');
    }
    process.env.BROWSER_LIVEKIT_TARGET = 'r1';
    expect(browserLiveKitEndpoint().target).toBe('r1');
  });

  it('the dispatch verification default in .env.example is the 10 s the runbook states', () => {
    expect(read('app/api/.env.example')).toMatch(/^BROWSER_DISPATCH_VERIFY_SEC=10$/m);
    expectFlatContains(RUNBOOK, 'means the default of 10 s');
  });
});

// ── 3. The hand-run deploy gate ─────────────────────────────────────────

const PHONE_IMPACT_HEADING = '### PR-LK-liveness (PR #345): phone impact (plan section 9)';
const GATE_SECTION = between(
  RUNBOOK,
  '### PR-LK-liveness (PR #345): the gate for this merge is run by hand',
  PHONE_IMPACT_HEADING,
);
const PHONE_IMPACT_SECTION = between(
  RUNBOOK,
  PHONE_IMPACT_HEADING,
  '## Budget, cap, and reconciliation',
);

/** The five read-only queries of the generic merge gate, in order. */
const GATE_QUERIES = [
  { label: 'live R1 sessions', table: 'call_sessions', columns: ['interview_round_id', 'status'] },
  { label: 'live phone attempts', table: 'phone_call_attempts', columns: ['lease_expires_at'] },
  { label: 'phone.dial jobs', table: 'job_queue', columns: ['name', 'status', 'scheduled_at'] },
  { label: 'phone appointments', table: 'phone_appointments', columns: ['starts_at', 'status'] },
  { label: 'phone.assessment jobs', table: 'job_queue', columns: ['name', 'status'] },
] as const;

/** Is `column` declared on `screening_v2.<table>` by CREATE TABLE or ADD COLUMN? */
function migrationsDeclareColumn(table: string, column: string): boolean {
  const create = new RegExp(`create table (?:if not exists )?screening_v2\\.${table}\\s*\\(`);
  const add = new RegExp(
    `alter table (?:if exists )?(?:only )?screening_v2\\.${table}[^;]*?add column `
      + `(?:if not exists )?${column}\\b`,
  );
  const column_at_line_start = new RegExp(`^\\s+${column}\\s`, 'm');
  return migrationFiles().some((file) => {
    const sql = read(`${MIGRATIONS}${file}`);
    if (add.test(sql)) return true;
    const header = create.exec(sql);
    if (!header) return false;
    const body = sql.slice(header.index, sql.indexOf('\n);', header.index));
    return column_at_line_start.test(body);
  });
}

describe('3. the merge gate for this PR is run by hand, and the record says so', () => {
  it('records the window, the pause, the zero checks and the gate record template', () => {
    for (const text of [
      'between 07:00 and 08:00',
      'no Quality re-run or deploy dispatch is allowed after 08:15',
      'At least 30 minutes before the merge',
      '`r1_settings.paused = true`',
      'five read-only queries',
      'Abort on any row',
      'active `phone.assessment` jobs',
      'phone Canary-1 dry run',
      'Gate record, PR #345',
      '- Live R1 sessions: 0',
      '- Live phone attempts',
      '- phone.dial jobs active or due in 30 minutes: 0',
      '- Active phone.assessment jobs: 0',
      '- Quality and supabase-check green on commit',
    ]) {
      expectFlatContains(GATE_SECTION, text);
    }
  });

  it('states what one merge does: migration lock, drift check, three deploys, #334', () => {
    for (const text of [
      'ACCESS EXCLUSIVE lock on `voice_worker_leases`',
      '10 s `lock_timeout`',
      'three queries',
      'API, the browser voice app and the phone voice app all redeploy',
      '90 s drain',
      '#334',
    ]) {
      expectFlatContains(GATE_SECTION, text);
    }
  });

  it('those claims are true of the migration, the drift script and the workflow', () => {
    expect(M0118).toContain("set local lock_timeout = '10s';");
    expect(M0118).toMatch(
      /alter table screening_v2\.voice_worker_leases\n\s+add column if not exists livekit_host/,
    );
    const checks = /CHECKS=\(\n([\s\S]*?)\n\)/.exec(DRIFT_SCRIPT)?.[1].split('\n') ?? [];
    expect(checks).toHaveLength(3);
    expect(DRIFT_SCRIPT).toContain('drift check could not query');
    expect(DRIFT_SCRIPT).toContain('drift check got no readable position');
    expect(DRIFT_SCRIPT).toContain('PROD FUNCTION DRIFT');
    expect(GATE_SECTION).toContain('drift check could not query');
    expect(GATE_SECTION).toContain('drift check got no readable position');
    expect(GATE_SECTION).toContain('PROD FUNCTION DRIFT');
    expect(DEPLOY).toMatch(/^name: Deploy \(Fly\)$/m);
    expectFlatContains(GATE_SECTION, '`Deploy (Fly)` with service `all`');
    expect(DEPLOY).toMatch(/options: \[api, browser-voice, phone-voice, both, all\]/);
    expect(DEPLOY).toContain('--include-all');
  });

  it('TRIPWIRE: the doc says no automated zero-live pre-step exists, and none does', () => {
    // When one lands, this fails: update the runbook (and this test) in that PR.
    expectFlatContains(
      GATE_SECTION,
      'The automated zero-live pre-step named in the plan (section 9) does not exist yet',
    );
    const gateTables = ['phone_call_attempts', 'call_sessions', 'job_queue', 'phone_appointments'];
    for (const table of gateTables) {
      expect(DEPLOY, `deploy-fly.yml mentions ${table}`).not.toContain(table);
    }
  });

  it('the merge-gate SQL has the five checks and every table and column exists', () => {
    const gate = between(RUNBOOK, '## Merge and deploy gate', '### PR-LK-liveness (PR #345)');
    const sql = /```sql\n([\s\S]*?)```/.exec(gate)?.[1] ?? '';
    const statements = sql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
      .split(';')
      .map((statement) => statement.trim())
      .filter((statement) => statement !== '');
    expect(statements).toHaveLength(GATE_QUERIES.length);
    statements.forEach((statement, index) => {
      const query = GATE_QUERIES[index];
      expect(statement, query.label).toMatch(/^select id from /);
      expect(statement, query.label).toContain(`screening_v2.${query.table}`);
      expect(statement, query.label).not.toMatch(/\b(insert|update|delete|alter|drop)\b/i);
      for (const column of query.columns) {
        expect(statement, `${query.label}: ${column}`).toContain(column);
        expect(
          migrationsDeclareColumn(query.table, column),
          `${query.table}.${column} is declared by a migration`,
        ).toBe(true);
      }
    });
    expect(statements[2]).toContain("name = 'phone.dial'");
    expect(statements[4]).toContain("name = 'phone.assessment'");
  });
});

describe('2. the phone-impact record (plan section 9) says what the code does', () => {
  const AGENT = read('app/voice-livekit/agent.py');

  it('records the three departures from section 9 and why each is acceptable', () => {
    for (const text of [
      'This PR touches the phone-shared tier',
      '**R1 early return in `_prewarm_post_machine_ready`.**',
      'Section 9 says "no R1 work in prewarm"',
      '**`build_worker_options` and the `__main__` block.**',
      '**0118 re-declares `claim_voice_worker` and `reset_voice_worker`.**',
      'puts "the phone SQL RPCs" on the never-touch list',
      'plus exactly ONE added line, `livekit_host = null,`',
      'writes null over null: a no-op',
      'It modifies exactly three pre-existing definitions',
      'no new top-level imports',
    ]) {
      expectFlatContains(PHONE_IMPACT_SECTION, text);
    }
  });

  it('every agent.py definition the record names exists, and the launcher is wired', () => {
    for (const name of [
      '_prewarm_post_machine_ready',
      'build_worker_options',
      'run_worker_app',
      '_browser_r1_readiness',
      '_phone_agent_name',
    ]) {
      expect(AGENT, name).toMatch(new RegExp(`^def ${name}\\(`, 'm'));
    }
    expectFlatContains(PHONE_IMPACT_SECTION, '`__main__` block now calls `run_worker_app`');
    expect(AGENT).toMatch(/^if __name__ == "__main__":\n {4}run_worker_app\(\)\n*$/m);
  });

  it('the prewarm carve-out is a bare return behind the named-browser opt-in', () => {
    const prewarm = between(
      AGENT,
      'def _prewarm_post_machine_ready(',
      '\ndef build_worker_options(',
    );
    const branch = /\n {4}if _browser_r1_readiness\(\):\n((?: {8}.*\n| *\n)+)/.exec(prewarm);
    expect(branch).not.toBeNull();
    const body = branch![1]
      .split('\n')
      .filter((line) => line.trim() !== '' && !/^ *#/.test(line));
    expect(body).toEqual(['        return']);
    const predicate = between(
      AGENT,
      'def _browser_r1_readiness(',
      '\ndef _browser_livekit_host(',
    );
    expect(predicate).toContain(
      'return _browser_worker_named() and os.getenv("R1_READINESS_HOST") == "on"',
    );
  });

  it('the two opt-in options keys are written only behind BROWSER_WORKER_ONE_JOB=on', () => {
    const options = between(
      AGENT,
      'def build_worker_options(',
      '\ndef _phone_one_call_per_machine_load(',
    );
    // The named-browser branch ends at the first `return WorkerOptions(...)`, and the
    // phone keys (which have their own load gate) come only after it.
    const branchEnd = options.indexOf('return WorkerOptions(**options)');
    expect(branchEnd).toBeGreaterThan(-1);
    expect(branchEnd).toBeLessThan(options.indexOf('agent_name = _phone_agent_name()'));
    const browser = options.slice(0, branchEnd);
    expect(browser.match(/options\["load_(?:fnc|threshold)"\] = /g) ?? []).toHaveLength(2);
    const gate = browser.indexOf('if _browser_worker_one_job():');
    expect(gate).toBeGreaterThan(-1);
    for (const key of ['load_fnc', 'load_threshold']) {
      expect(browser.indexOf(`options["${key}"] = `), key).toBeGreaterThan(gate);
    }
    // The gate and the named predicate are the only way in: no unconditional write.
    expect(browser.slice(0, gate)).not.toMatch(/options\["load_/);
  });

  it('the shared worker_ready_api keyword is optional and sent only when set', () => {
    const api = read('app/voice-livekit/worker_ready_api.py');
    expect(api).toContain('livekit_host: Optional[str] = None,');
    expect(api).toMatch(/if livekit_host is not None:\n {8}body\["livekit_host"\] = livekit_host/);
  });
});

// ── 4. Line length and the wrapped host patterns ────────────────────────

const LINE_LIMIT = 100;

/**
 * Lines that were already over the limit on origin/main and are not this PR's to
 * reflow: matched by prefix, at most `max` of them per file, so a NEW long line
 * can never hide behind an entry.
 */
const GRANDFATHERED: Record<string, Array<{ prefix: string; max: number }>> = {
  'app/api/src/lib/browser-orchestration.ts': [
    { prefix: 'await service.releaseWorker({ app, machineId: input.machineId, sessionId:', max: 1 },
  ],
  'app/api/src/routes/voice-worker.ts': [
    { prefix: 'rpc(n: string, a: Record<string, unknown>): Promise<{ data: unknown;', max: 1 },
  ],
};

const LINE_LIMITED_FILES = [
  'app/api/src/lib/browser-orchestration.ts',
  'app/api/src/routes/voice-worker.ts',
  `${MIGRATIONS}${migrationNamed('0118')}`,
  ...NEW_TEST_FILES,
];

describe('4. added production lines stay within 100 columns', () => {
  it.each(LINE_LIMITED_FILES)('%s has no over-long line except grandfathered ones', (file) => {
    const allowed = GRANDFATHERED[file] ?? [];
    const used = new Map<string, number>();
    const offenders: string[] = [];
    read(file).split('\n').forEach((line, index) => {
      if (line.length <= LINE_LIMIT) return;
      const entry = allowed.find((a) => line.trim().startsWith(a.prefix));
      const count = entry ? (used.get(entry.prefix) ?? 0) + 1 : 0;
      if (entry) used.set(entry.prefix, count);
      if (!entry || count > entry.max) offenders.push(`${index + 1}: ${line.length} columns`);
    });
    expect(offenders).toEqual([]);
  });
});

/** The host pattern 0118 declares, as it was written before the lines were wrapped. */
const CANONICAL_SQL_HOST_PATTERN = [
  '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?',
  '([.][a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$',
].join('');

/** Every `~ ( 'a' || 'b' )` operand in the migration, its literals concatenated. */
function regexOperands(sql: string): string[] {
  const found: string[] = [];
  for (const match of sql.matchAll(/~ \(\s*((?:'[^']*'\s*(?:\|\|\s*)?)+)\)/g)) {
    found.push([...match[1].matchAll(/'([^']*)'/g)].map((part) => part[1]).join(''));
  }
  return found;
}

describe('4. the wrapped host patterns match what they replaced', () => {
  it('0118: the CHECK and the RPC both use the canonical pattern, split over two lines', () => {
    expect(regexOperands(M0118)).toEqual([CANONICAL_SQL_HOST_PATTERN, CANONICAL_SQL_HOST_PATTERN]);
    // No single-line regex literal is left behind in either place.
    expect(M0118).not.toMatch(/~ '/);
    expect(M0118).toContain("|| '([.][a-z0-9]");
  });

  it('the API pattern is the pre-wrap literal, character for character', () => {
    const preWrap = [
      String.raw`^(?=.{1,253}$)`,
      String.raw`(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)`,
      String.raw`(?:\.(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?))*$`,
    ].join('');
    expect(LIVEKIT_HOST_RE.source).toBe(new RegExp(preWrap).source);
    expect(LIVEKIT_HOST_RE.flags).toBe('');
  });

  it('the API accepts a host exactly when the lease CHECK accepts its lowercase form', () => {
    const sql = new RegExp(CANONICAL_SQL_HOST_PATTERN);
    const sqlAccepts = (host: string): boolean =>
      host.length >= 1 && host.length <= 253 && sql.test(host);
    const longest = [63, 63, 63, 61].map((n) => 'a'.repeat(n)).join('.');
    const corpus = [
      'r1.example.test', 'R1.Example.Test', '10.0.0.5', 'a', 'a-b.c1.example', 'xn--bcher-kva.test',
      '-a.example', 'a-.example', 'a..b', 'a.b.', '.a.b', 'under_score.test', 'host:7880',
      'host/path', 'user@host', ' host', 'host ', 'host\n', '', '[fdaa::3]',
      'a'.repeat(63), 'a'.repeat(64), `${'a'.repeat(63)}.test`, `${'a'.repeat(64)}.test`,
      longest, `${longest}a`,
    ];
    expect(longest).toHaveLength(253);
    for (const host of corpus) {
      expect(LIVEKIT_HOST_RE.test(host), JSON.stringify(host)).toBe(sqlAccepts(host.toLowerCase()));
    }
    // The corpus exercises both verdicts.
    expect(corpus.filter((h) => LIVEKIT_HOST_RE.test(h)).length).toBeGreaterThan(6);
    expect(corpus.filter((h) => !LIVEKIT_HOST_RE.test(h)).length).toBeGreaterThan(10);
  });
});

// ── 5. The open S0-F3 observation ───────────────────────────────────────

describe('5. the S0-F3 dispatch-matrix rerun is recorded where the code points', () => {
  const HEADING = 'S0-F3 dispatch-matrix rerun';

  it('the runbook names what the rerun must record and the decision rule', () => {
    const section = between(RUNBOOK, `### ${HEADING}`, '## Key rotation');
    for (const text of [
      '`JobStatus`',
      '`state.endedAt`',
      'Stop a worker machine in the middle of a job',
      'whether deleting a dispatch ends its running job',
      'JS_RUNNING',
      'two failures in a',
      'not implemented now',
      'not a blocker',
    ]) {
      expect(flat(section).toLowerCase(), text).toContain(flat(text).toLowerCase());
    }
  });

  it('jobIsLive points at that section, so the two cannot be separated', () => {
    const source = read('app/api/src/lib/browser-orchestration.ts');
    expect(source).toContain(`"${HEADING}"`);
    expect(source).toContain('RESIDUAL');
    expect(source).toContain('state.endedAt');
    expect(RUNBOOK).toContain('set `state.endedAt`');
  });
});
