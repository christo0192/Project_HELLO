/**
 * 0125 (M013 S02, PR-2) scaffold — T03: frame, registration, §1 columns,
 * §2 room_name stamp, §3 truthful duration, and the real-Postgres wiring.
 *
 * Asserted against the migration TEXT. Behaviour (the triggers, both
 * backfills over rows written under the old 0076 rule, idempotency on a
 * second apply, the CHECKs) is proven by execution in
 * scripts/test-phone-0125.sh; text is not execution.
 *
 * The migration number lives in ONE constant (N). If S01 or anything else
 * merges a 0125 first, S02 renumbers: change N, the file name, the head of
 * PHONE_MIGRATIONS and MIGRATION in scripts/test-phone-0125.sh.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { phoneRoomName } from '../integrations/livekit-phone-dial/phone-room.js';
import {
  MIGRATION_0042,
  MIGRATION_0125,
  MIGRATION_0125_PATH,
  PHONE_MIGRATIONS,
  functionBody,
} from './support/phone-migration.js';

const N = '0125';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const MIGRATIONS = path.join(REPO, 'app/supabase/migrations');
const TESTS = path.join(REPO, 'app/supabase/tests');

const lf = (s: string) => s.replace(/\r\n/g, '\n');
const read = (rel: string) => lf(readFileSync(path.join(REPO, rel), 'utf8'));
const stripComments = (s: string) => s.replace(/--[^\n]*/g, '');
const squash = (s: string) => stripComments(s).replace(/\s+/g, ' ').trim();

const SQL = lf(MIGRATION_0125);
const CLOCK = /\bnow\s*\(|clock_timestamp|current_timestamp|statement_timestamp|transaction_timestamp|localtimestamp/;

/** Section numbers present, in file order, each with its BEGIN/END pair. */
function sectionNumbers(): number[] {
  return [...SQL.matchAll(new RegExp(`^-- ==== ${N} §(\\d+) BEGIN ====$`, 'gm'))].map((m) =>
    Number(m[1]),
  );
}

function section(n: number): string {
  const begin = `-- ==== ${N} §${n} BEGIN ====`;
  const end = `-- ==== ${N} §${n} END ====`;
  const b = SQL.indexOf(begin);
  const e = SQL.indexOf(end);
  if (b === -1 || e === -1 || e < b) throw new Error(`${N} §${n} markers missing or inverted`);
  return SQL.slice(b + begin.length, e);
}

describe(`${N} registration`, () => {
  it('is the FIRST (newest) entry of PHONE_MIGRATIONS, directly ahead of 0114', () => {
    const names = PHONE_MIGRATIONS.map((m) => m.name);
    expect(names[0]).toBe(N);
    expect(names[1]).toBe('0114');
    expect(names.filter((n) => n === N)).toHaveLength(1);
    expect(PHONE_MIGRATIONS[0].sql).toBe(MIGRATION_0125);
  });

  it('is the one CI-legal 0125 file and the newest migration file', () => {
    const base = path.basename(MIGRATION_0125_PATH);
    expect(base).toMatch(new RegExp(`^${N}_[a-z0-9_]+\\.sql$`));
    const files = readdirSync(MIGRATIONS).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(files.filter((f) => f.startsWith(`${N}_`))).toEqual([base]);
    expect(files[files.length - 1]).toBe(base);
  });
});

describe(`${N} frame`, () => {
  it('has §1..§k BEGIN/END markers exactly once each, contiguous and in order (k >= 3)', () => {
    const nums = sectionNumbers();
    expect(nums.length).toBeGreaterThanOrEqual(3);
    expect(nums).toEqual(nums.map((_, i) => i + 1));
    let last = -1;
    for (const n of nums) {
      for (const kind of ['BEGIN', 'END']) {
        const marker = `-- ==== ${N} §${n} ${kind} ====`;
        expect(SQL.split(marker).length - 1, marker).toBe(1);
        const at = SQL.indexOf(marker);
        expect(at, marker).toBeGreaterThan(last);
        last = at;
      }
    }
  });

  it('sets a LOCAL lock_timeout before §1 and ends with the one PostgREST reload', () => {
    const lock = SQL.indexOf("set local lock_timeout = '10s';");
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(SQL.indexOf(`-- ==== ${N} §1 BEGIN ====`));
    expect(SQL.trimEnd().endsWith("notify pgrst, 'reload schema';")).toBe(true);
    expect(SQL.split("notify pgrst, 'reload schema';").length - 1).toBe(1);
  });

  it('carries no executable SQL outside the section markers except lock_timeout and notify', () => {
    let outside = SQL;
    for (const n of sectionNumbers()) outside = outside.replace(section(n), '');
    const statements = stripComments(outside)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('-- ===='));
    expect(statements).toEqual(["set local lock_timeout = '10s';", "notify pgrst, 'reload schema';"]);
  });

  it('no function body in T03 sections reads the machine clock', () => {
    for (const n of [1, 2, 3]) expect(stripComments(section(n)).toLowerCase(), `§${n}`).not.toMatch(CLOCK);
  });
});

describe(`${N} §1 — leg-timing columns`, () => {
  const s1 = squash(section(1));

  it('adds the four attempt columns and the session counter idempotently, with their types', () => {
    for (const col of [
      'add column if not exists observed_ended_at timestamptz',
      'add column if not exists recording_started_at_ms bigint',
      'add column if not exists recording_duration_ms integer',
      'add column if not exists recording_tail_flushed boolean',
      'add column if not exists duration_unobserved_legs smallint',
    ]) {
      expect(s1).toContain(col);
    }
    expect(s1).not.toMatch(/create\s+or\s+replace\s+function/);
  });

  it('drops-if-exists then adds each CHECK, so a second apply is clean', () => {
    for (const name of [
      'chk_phone_call_attempts_observed_ended_at',
      'chk_phone_call_attempts_recording_started_at_ms',
      'chk_phone_call_attempts_recording_duration_ms',
      'chk_call_sessions_duration_unobserved_legs',
    ]) {
      const drop = s1.indexOf(`drop constraint if exists ${name};`);
      const add = s1.indexOf(`add constraint ${name} check`);
      expect(drop, name).toBeGreaterThan(-1);
      expect(add, name).toBeGreaterThan(drop);
    }
  });

  it('bounds the values (never 0 ms, epoch-ms range, non-negative count)', () => {
    expect(s1).toContain('recording_duration_ms between 1 and 86400000');
    expect(s1).toContain('recording_started_at_ms between 1577836800000 and 4102444800000');
    expect(s1).toContain('duration_unobserved_legs is null or duration_unobserved_legs >= 0');
  });

  it('relates no CHECK to a column a later ledger event writes (answered_at, ended_at)', () => {
    // A CHECK tying observed_ended_at to answered_at would make an unrelated
    // apply_phone_event UPDATE fail on a row whose timing was stamped first.
    const checks = [...s1.matchAll(/add constraint (\w+) check \(([^;]*)\);/g)];
    expect(checks.length).toBe(4);
    for (const [, name, body] of checks) {
      expect(body, name).not.toMatch(/\banswered_at\b|\bended_at\b(?!_)/);
    }
  });
});

describe(`${N} §2 — room_name stamp`, () => {
  const s2 = section(2);
  const sq = squash(s2);
  const stamp = functionBody('stamp_phone_attempt_room_name');

  it('fires on INSERT and on UPDATE OF session_id, on phone_call_attempts', () => {
    expect(sq).toContain(
      'drop trigger if exists trg_phone_attempt_room_name on screening_v2.phone_call_attempts;',
    );
    expect(sq).toContain(
      'create trigger trg_phone_attempt_room_name before insert or update of session_id ' +
        'on screening_v2.phone_call_attempts for each row execute function ' +
        'screening_v2.stamp_phone_attempt_room_name();',
    );
  });

  it('fills room_name only when it is NULL and the leg is bound', () => {
    expect(squash(stamp)).toContain(
      "if new.session_id is not null and new.room_name is null then " +
        "new.room_name := 'phone-' || new.session_id::text;",
    );
    expect(squash(stamp)).toContain('set search_path = pg_catalog, screening_v2');
    expect(sq).toContain(
      'revoke all on function screening_v2.stamp_phone_attempt_room_name() from public, anon, authenticated;',
    );
  });

  it("matches the API's room name and the 0042 room_name CHECK", () => {
    const uuid = '00000000-0000-4000-8000-000000000115';
    // The SQL expression and phoneRoomName must name the same room.
    expect(phoneRoomName(uuid)).toBe(`phone-${uuid}`);
    const check = /constraint chk_phone_call_attempts_room_name check \(\s*room_name is null or room_name ~ '([^']+)'\)/.exec(
      lf(MIGRATION_0042),
    );
    expect(check).not.toBeNull();
    expect(new RegExp(check![1]).test(phoneRoomName(uuid))).toBe(true);
  });

  it('a reconnect dial joins phoneRoomName(session) — the room the stamp names', () => {
    // dial.ts provisions the room from the dial's session id; for a reconnect
    // that is the engagement's existing session (runtime ensureSession returns
    // `existingSessionId`, pinned in phone-runtime-session-port.test.ts).
    const dial = read('app/api/src/integrations/livekit-phone-dial/dial.ts');
    expect(dial).toMatch(/provisionPhoneRoom\(\s*\{ sessionId: request\.sessionId,/);
    const room = read('app/api/src/integrations/livekit-phone-dial/phone-room.ts');
    expect(room).toContain('const roomName = phoneRoomName(input.sessionId);');
  });

  it('backfills only bound legs with no room name', () => {
    expect(sq).toContain(
      "update screening_v2.phone_call_attempts set room_name = 'phone-' || session_id::text " +
        'where session_id is not null and room_name is null;',
    );
  });

  it('leaves EXACTLY two triggers on phone_call_attempts across all migrations (0055 + this)', () => {
    // The backfill updates room_name only, so it fires neither trigger. A
    // later attempt-immutability trigger would break that premise silently,
    // so the set is pinned here and by execution in test-phone-0125.sh.
    const triggers = new Set<string>();
    for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
      const sql = squash(readFileSync(path.join(MIGRATIONS, f), 'utf8'));
      for (const m of sql.matchAll(/create trigger (\w+) [^;]*? on screening_v2\.phone_call_attempts\b/g)) {
        triggers.add(m[1]);
      }
    }
    expect([...triggers].sort()).toEqual(['trg_phone_attempt_answered_at', 'trg_phone_attempt_room_name']);
  });
});

describe(`${N} §3 — truthful duration`, () => {
  const s3 = squash(section(3));
  const helper = squash(functionBody('phone_session_leg_duration'));
  const trigger = squash(functionBody('set_phone_session_duration'));
  const SQL_0076 = read('app/supabase/migrations/0076_phone_conversation_integrity.sql');

  it('re-declares set_phone_session_duration with the 0076 guards byte-for-byte', () => {
    // functionBody resolves newest-first; 0076 is not registered, so this
    // must be the 0125 body.
    expect(MIGRATION_0125).toContain('create or replace function screening_v2.set_phone_session_duration()');
    const guards = /( {2}if new\.status <> 'completed'\n[\s\S]*?then\n {4}return new;\n {2}end if;)/.exec(SQL_0076);
    expect(guards).not.toBeNull();
    expect(SQL).toContain(guards![1]);
    expect(trigger).toContain(
      'from screening_v2.phone_session_leg_duration(new.id, new.ended_at) d;',
    );
    expect(trigger).toContain('if v_duration > 0 then new.duration_sec := v_duration; end if;');
    expect(trigger).toContain('new.duration_unobserved_legs := v_unobserved;');
  });

  it('does NOT re-create the 0076 trigger, so it still fires only on first completion', () => {
    expect(SQL).not.toMatch(/create trigger trg_set_phone_session_duration/);
    expect(squash(SQL_0076)).toContain(
      "before update of status, ended_at on screening_v2.call_sessions for each row " +
        "when (new.status = 'completed' and old.status is distinct from new.status)",
    );
  });

  it('takes the earlier of the observed and ledger ends, and keeps 0076\'s session-end bound and 86400 cap', () => {
    expect(helper).toContain('least(a.observed_ended_at, a.ended_at, p_session_ended_at) as leg_end');
    expect(helper).toContain('and a.answered_at <= p_session_ended_at');
    expect(helper).toContain('least( 86400,');
    expect(helper).toContain('greatest(0, extract(epoch from (l.leg_end - l.answered_at)))');
    expect(helper).toContain('filter (where not l.unobserved)');
    // Unknown is NULL, never 0.
    expect(helper).toContain('case when t.observed_sec > 0 then t.observed_sec end');
  });

  it('excludes exactly the reclaim signature with no observed end, whatever the session end', () => {
    expect(helper).toContain(
      "( a.observed_ended_at is null and a.state = 'abandoned' and a.outcome_class is null " +
        'and a.abandon_reason is null and a.ended_at is not null) as unobserved',
    );
    // The API's per-leg rule has no session-end clause either (review, S02).
    expect(helper).not.toContain('a.ended_at <= p_session_ended_at');
  });

  it('the signature matches what reclaim_phone_attempt_leases actually writes', () => {
    // If a later migration changes how the reclaim ends a leg (sets an
    // outcome, an abandon_reason, a marker), this rule stops recognising it.
    const reclaim = squash(functionBody('reclaim_phone_attempt_leases'));
    expect(reclaim).toContain(
      "update screening_v2.phone_call_attempts set state = 'abandoned', outcome_class = null, " +
        'lease_token = null, lease_owner = null, ended_at = p_now where id = v_att.id;',
    );
    expect(reclaim).not.toContain('abandon_reason');
  });

  it('the helper is a definer, pinned, service-role-only, clock-free phone function', () => {
    expect(helper).toContain('language sql stable security definer set search_path = pg_catalog, screening_v2');
    expect(helper).not.toMatch(CLOCK);
    expect(s3).toContain(
      'revoke all on function screening_v2.phone_session_leg_duration(uuid, timestamptz) from public, anon, authenticated;',
    );
    expect(s3).toContain(
      'grant execute on function screening_v2.phone_session_leg_duration(uuid, timestamptz) to service_role;',
    );
    expect(s3).toContain(
      'revoke all on function screening_v2.set_phone_session_duration() from public, anon, authenticated;',
    );
  });

  it('backfills only completed phone sessions the rule never computed that have an unobserved leg', () => {
    // A plain UPDATE ... FROM (no CTE): TST-15's analyzer classifies it.
    const at = s3.indexOf('update screening_v2.call_sessions s set');
    expect(at).toBeGreaterThan(-1);
    const backfill = s3.slice(at, s3.indexOf(';', at) + 1);
    expect(backfill).toContain(
      'cross join lateral screening_v2.phone_session_leg_duration(c.id, c.ended_at) d',
    );
    for (const guard of [
      "where c.status = 'completed'",
      'and c.ended_at is not null',
      "and c.external_call_id ~ '^phone-[0-9a-fA-F-]{36}$'",
      // Idempotency: a backfilled row carries a count >= 1.
      'and c.duration_unobserved_legs is null',
      'and d.unobserved_legs > 0',
      'where s.id = t.id;',
    ]) {
      expect(backfill, guard).toContain(guard);
    }
    expect(backfill).toContain(
      'set duration_sec = t.duration_sec, duration_unobserved_legs = t.unobserved_legs',
    );
    // A data-only correction: it never touches status or terminal_reason.
    const setClause = backfill.slice(backfill.indexOf(' set '), backfill.indexOf(' from ('));
    expect(setClause).toBe(
      ' set duration_sec = t.duration_sec, duration_unobserved_legs = t.unobserved_legs',
    );
    expect(s3.split('update screening_v2.call_sessions').length - 1).toBe(1);
  });
});

describe(`${N} real-Postgres harness wiring`, () => {
  const script = read('scripts/test-phone-0125.sh');

  it('targets this migration number and runs the three fixture files in order', () => {
    expect(script).toContain(`readonly MIGRATION="${N}"`);
    const files = ['phone_0125_setup.sql', 'phone_0125_backfill_assert.sql', 'phone_0125_assert.sql'];
    let last = -1;
    for (const f of files) {
      expect(existsSync(path.join(TESTS, f)), f).toBe(true);
      const at = script.indexOf(`run_sql ${f}`);
      expect(at, f).toBeGreaterThan(last);
      last = at;
    }
    // History is seeded BEFORE the migration, and it is applied twice.
    expect(script.indexOf('run_sql phone_0125_setup.sql')).toBeLessThan(script.indexOf('apply "$TARGET"'));
    expect(script.split('apply "$TARGET"').length - 1).toBe(2);
  });

  it('is a job in supabase-ci.yml and in both path filters', () => {
    const ci = read('.github/workflows/supabase-ci.yml');
    expect(ci).toContain('run: bash scripts/test-phone-0125.sh');
    expect(ci.split("- 'scripts/test-phone-0125.sh'").length - 1).toBe(2);
  });

  it('fixtures are synthetic: example.test emails only, no full session uuid of a real case', () => {
    for (const f of ['phone_0125_setup.sql', 'phone_0125_backfill_assert.sql', 'phone_0125_assert.sql']) {
      const sql = lf(readFileSync(path.join(TESTS, f), 'utf8'));
      for (const m of sql.matchAll(/[\w.+-]+@[\w.-]+/g)) expect(m[0], f).toMatch(/@example\.test$/);
      expect(sql, f).not.toMatch(/9f60523d-|32757295-/);
    }
  });
});
