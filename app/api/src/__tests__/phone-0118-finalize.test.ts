/**
 * 0118 §4 (M013 S02, T05) — partial-finalize: the reconnect guard and the
 * truthful disconnect label, asserted against the migration TEXT.
 *
 * finalize_phone_partial_sessions is LIFTED from 0114 §3 (the newest
 * declaration before 0118: 0113's E4 callback flag and 0114's C2/C7 hunks
 * live there). A lift from an older file, or a tidy-up while lifting,
 * silently reverts those fixes, and the phone-0114-outcome pins read the
 * NEWEST declaration. So the core assertion is a structural diff: remove the
 * four marked 0118 hunks (`-- ▼ 0118 <id>` … `-- ▲ 0118 <id>`) and what is
 * left must be BYTE-IDENTICAL to the 0114 body.
 *
 * Behaviour is proven on real Postgres: app/supabase/tests/
 * phone_0118_finalize.sql (scripts/test-phone-0118.sh, the 9f60523d replay)
 * and phone_partial_finalize_{setup,assert}.sql (scripts/supabase-test.sh).
 * Text is not execution.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  INFRA_DISCONNECT_REASON,
  PHONE_DISCONNECT_REASONS,
  UNOBSERVED_DISCONNECT_REASON,
} from '../lib/scorecards/evidence.js';
import {
  MIGRATION_0114,
  MIGRATION_0118,
  PHONE_MIGRATIONS,
  functionBody,
} from './support/phone-migration.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const lf = (s: string) => s.replace(/\r\n/g, '\n');
const read = (rel: string) => lf(readFileSync(path.join(REPO, rel), 'utf8'));

const M0114 = lf(MIGRATION_0114);
const M0118 = lf(MIGRATION_0118);
const NAME = 'finalize_phone_partial_sessions';

/** One function declaration (header through the closing `$$;`) from a file. */
function bodyIn(sql: string, name: string): string {
  const anchor = `create or replace function screening_v2.${name}(`;
  const start = sql.indexOf(anchor);
  if (start === -1) throw new Error(`${name} not declared`);
  if (sql.indexOf(anchor, start + 1) !== -1) throw new Error(`${name} declared twice`);
  const end = sql.indexOf('\n$$;\n', start);
  if (end === -1) throw new Error(`${name} unterminated`);
  return sql.slice(start, end + '\n$$;\n'.length);
}

/** Remove every marked 0118 hunk; returns the residue and the hunks, in order. */
function stripHunks(body: string): { residue: string; tags: string[]; hunks: Record<string, string> } {
  const tags: string[] = [];
  const hunks: Record<string, string> = {};
  const re = /^[ \t]*-- ▼ 0118 ([^\n]+)\n([\s\S]*?)^[ \t]*-- ▲ 0118 ([^\n]+)\n/gm;
  const residue = body.replace(re, (_m, open: string, inner: string, close: string) => {
    if (open !== close) throw new Error(`hunk ${open} closed as ${close}`);
    tags.push(open);
    hunks[open] = inner;
    return '';
  });
  if (/▼ 0118|▲ 0118/.test(residue)) throw new Error('unbalanced 0118 hunk marker');
  return { residue, tags, hunks };
}

/** Code with comments and the signature's `default now()` removed. */
function code(body: string): string {
  return body.replace(/--[^\n]*/g, '').replace(/timestamptz\s+default now\(\)/g, 'timestamptz');
}
const squash = (s: string) => code(s).replace(/\s+/g, ' ').trim();
const MACHINE_CLOCK =
  /\b(now|clock_timestamp|statement_timestamp|transaction_timestamp|timeofday)\s*\(|\bcurrent_(timestamp|date|time)\b|\blocaltimestamp\b/i;

function section(n: number): string {
  const begin = `-- ==== 0118 §${n} BEGIN ====`;
  const end = `-- ==== 0118 §${n} END ====`;
  const b = M0118.indexOf(begin);
  const e = M0118.indexOf(end);
  if (b === -1 || e === -1 || e < b) throw new Error(`0118 §${n} markers missing`);
  return M0118.slice(b, e + end.length);
}

const FIN_0114 = bodyIn(M0114, NAME);
const FIN_0118 = bodyIn(M0118, NAME);
const FIN = stripHunks(FIN_0118);
const S4 = section(4);

describe('0118 §4 — ownership and placement', () => {
  it('declares finalize exactly once in 0118, inside §4', () => {
    expect(M0118.split(`create or replace function screening_v2.${NAME}(`).length - 1).toBe(1);
    expect(S4).toContain(`create or replace function screening_v2.${NAME}(`);
  });

  it('0118 is the newest registered migration, so the extractors read the 0118 body', () => {
    expect(PHONE_MIGRATIONS[0].name).toBe('0118');
    const resolved = functionBody(NAME);
    expect(resolved).toContain('-- ▼ 0118 S02-4 reconnect guard');
    // ...and every 0114 hunk the phone-0114-outcome pins read survives in it.
    expect(resolved).toContain('-- ▼ 0114 C7 withdrawn');
    expect(resolved).toContain('-- ▼ 0114 C2 suppression');
  });
});

describe('0118 §4 — finalize differs from 0114 ONLY by the marked hunks', () => {
  it('has exactly the planned hunks, in order', () => {
    expect(FIN.tags).toEqual([
      'S02-4 declare',
      'S02-4 label columns',
      'S02-4 reconnect guard',
      'S02-4 label',
    ]);
  });

  it('is byte-identical to the 0114 body once the 0118 hunks are removed', () => {
    expect(FIN.residue).toBe(FIN_0114);
  });

  it('keeps every 0114 hunk tag, in order', () => {
    const tags0114 = (b: string) => [...b.matchAll(/^[ \t]*-- ▼ 0114 ([^\n]+)$/gm)].map((m) => m[1]);
    expect(tags0114(FIN_0118)).toEqual(tags0114(FIN_0114));
    expect(tags0114(FIN_0118).length).toBe(6);
  });

  it('returns exactly the 0114 result keys (no new key, none dropped)', () => {
    // A jsonb_build_object key opens its line: `'session_id',         v_row…`.
    const keys = (b: string) => [...code(b).matchAll(/^[ \t]*'([a-z_]+)',[ \t]+\S/gm)].map((m) => m[1]).sort();
    expect(keys(FIN_0114)).toContain('disconnect_reason');
    expect(keys(FIN_0118)).toEqual(keys(FIN_0114));
  });

  it('adds no machine-clock read in any hunk', () => {
    for (const [tag, h] of Object.entries(FIN.hunks)) {
      expect(code(h), tag).not.toMatch(MACHINE_CLOCK);
    }
  });

  it('restates the service_role-only ACL and a 0118 comment in §4', () => {
    const s4 = squash(S4);
    expect(s4).toContain(
      `revoke all on function screening_v2.${NAME}(integer, integer, timestamptz) from public, anon, authenticated;`,
    );
    expect(s4).toContain(`grant execute on function screening_v2.${NAME}(integer, integer, timestamptz) to service_role;`);
    expect(S4).toMatch(/comment on function screening_v2\.finalize_phone_partial_sessions is[\s\S]*0118:/);
    expect(s4).not.toMatch(/grant\s+execute[^;]*\bto\s+(anon|authenticated|public)\b/i);
  });
});

describe('0118 §4 — the reconnect guard', () => {
  const guard = FIN.hunks['S02-4 reconnect guard'];
  const g = squash(guard);

  it('is a named, 30-minute bound', () => {
    expect(squash(FIN.hunks['S02-4 declare'])).toBe(
      "v_reconnect_hold constant interval := interval '30 minutes';",
    );
    expect(g).toContain('coalesce(a.ended_at, a.lease_expires_at) is not null');
    expect(g).toContain('and p_now < coalesce(a.ended_at, a.lease_expires_at) + v_reconnect_hold');
  });

  it('sits in the WHERE clause (a held row is never selected, so it cannot starve the window)', () => {
    const at = FIN_0118.indexOf('-- ▼ 0118 S02-4 reconnect guard');
    // After the selection arms and the call-over predicate, before ORDER BY /
    // LIMIT, and before the loop body.
    expect(at).toBeGreaterThan(FIN_0118.indexOf('-- ▲ 0114 C2/C7 expired arm'));
    expect(at).toBeGreaterThan(FIN_0118.indexOf("(a.state = 'abandoned'"));
    expect(at).toBeLessThan(FIN_0118.indexOf('     order by s.started_at asc\n     limit v_limit\n'));
    expect(at).toBeLessThan(FIN_0118.indexOf('  loop\n'));
    // A top-level conjunct, so it applies to BOTH arms (in_progress and
    // expired/grace_timeout), not inside the expired arm's parentheses.
    expect(FIN_0118).toContain('       )\n       -- ▼ 0118 S02-4 reconnect guard\n');
    expect(g.startsWith('and not (')).toBe(true);
  });

  it('(a) keys on the engagement BOUND to the session, in reconnecting or dialing', () => {
    expect(g).toContain('select 1 from screening_v2.phone_engagements re where re.session_id = s.id');
    expect(g).toContain("re.state in ('reconnecting','dialing')");
    // Never on the attempt's engagement id: a detached (callback-deferred)
    // session must not be held by its old engagement's next dial.
    expect(g).not.toMatch(/(?<![a-z_])a\.engagement_id/);
  });

  it('(b) a live attempt on that engagement admitted after the latest bound leg', () => {
    expect(g).toContain(
      'select 1 from screening_v2.phone_call_attempts na where na.engagement_id = re.id ' +
        'and na.id <> a.id and na.admitted_at > a.admitted_at and na.ended_at is null ' +
        "and na.state in ('admitted','ringing','answered_unclassified', 'human','machine')",
    );
  });

  it('documents 0095\'s starvation reasoning and the window_closed residue', () => {
    expect(guard).toContain("WHY THE WHERE CLAUSE (0095's reasoning");
    expect(guard).toContain('TIME-BOUNDED, on BOTH arms');
    expect(guard).toContain('`scheduled`/window_closed');
  });
});

describe('0118 §4 — the unobserved_disconnect label', () => {
  const label = squash(FIN.hunks['S02-4 label']);
  const cols = squash(FIN.hunks['S02-4 label columns']);

  it('selects the teardown-evidence columns of the latest attempt (and the session egress id) into v_row', () => {
    expect(cols).toBe(
      ', a.recording_ready as attempt_recording_ready ' +
        ', a.egress_status as attempt_egress_status ' +
        ', a.egress_id as attempt_egress_id ' +
        ', s.recording_egress_id as session_egress_id ' +
        ', a.observed_ended_at as attempt_observed_ended_at',
    );
  });

  it('rewrites ONLY worker_crash, and only on teardown evidence of THIS leg', () => {
    expect(label).toBe(
      "if v_reason = 'worker_crash' and (coalesce(v_row.attempt_recording_ready, false) " +
        "or (v_row.attempt_egress_status = 'complete' and v_row.attempt_egress_id is not null " +
        "and (v_row.attempt_egress_id = 'EG_worker_' || v_row.attempt_id::text " +
        'or v_row.attempt_egress_id is distinct from v_row.session_egress_id)) ' +
        'or v_row.attempt_observed_ended_at is not null) then ' +
        "v_reason := 'unobserved_disconnect'; end if;",
    );
    // The session's projected egress (0062) is never this leg's evidence.
    expect(label).not.toMatch(/or v_row\.attempt_egress_status = 'complete' or/);
  });

  it('runs after the 0113 reason CASE and before the session entry is built', () => {
    const at = FIN_0118.indexOf('-- ▼ 0118 S02-4 label\n');
    expect(at).toBeGreaterThan(FIN_0118.indexOf("        then 'worker_crash'\n      else 'disconnected'\n    end;\n"));
    expect(at).toBeLessThan(FIN_0118.indexOf("      'disconnect_reason',  v_reason,"));
  });

  it('the SQL tokens are exactly the API vocabulary (PHONE_DISCONNECT_REASONS)', () => {
    const body = code(FIN_0118);
    const tokens = new Set<string>([
      ...[...body.matchAll(/then '([a-z_]+)'\n/g)].map((m) => m[1]),
      ...[...body.matchAll(/else '([a-z_]+)'\n\s+end;/g)].map((m) => m[1]),
      ...[...body.matchAll(/v_reason := '([a-z_]+)';/g)].map((m) => m[1]),
    ]);
    expect([...tokens].sort()).toEqual([...PHONE_DISCONNECT_REASONS].sort());
    expect(UNOBSERVED_DISCONNECT_REASON).toBe('unobserved_disconnect');
  });

  it('the 0114 §4 SQL grade mirror treats only worker_crash as infra (no SQL change needed)', () => {
    const mirror = [...M0114.matchAll(/case when m\.disconnect = '([a-z_]+)'\s+then 'infra_interrupted'/g)];
    expect(mirror.length).toBe(2);
    for (const m of mirror) expect(m[1]).toBe(INFRA_DISCONNECT_REASON);
    expect(M0114).not.toContain('unobserved_disconnect');
  });
});

describe('0118 §4 — real-Postgres wiring', () => {
  it('test-phone-0118.sh replays the finalize fixture after the 0118 asserts', () => {
    const script = read('scripts/test-phone-0118.sh');
    const assertAt = script.indexOf('run_sql phone_0118_assert.sql');
    const finAt = script.indexOf('run_sql phone_0118_finalize.sql');
    expect(assertAt).toBeGreaterThan(-1);
    expect(finAt).toBeGreaterThan(assertAt);
    expect(existsSync(path.join(REPO, 'app/supabase/tests/phone_0118_finalize.sql'))).toBe(true);
  });

  it('the replay covers every acceptance case of the plan', () => {
    const sql = read('app/supabase/tests/phone_0118_finalize.sql');
    // 1. held while dialing; 2. call.failed via apply_phone_event, state pinned;
    // 3. unobserved_disconnect; 4. the 30-minute bound; 5. guard (b) alone.
    expect(sql).toContain("apply_phone_event('internal', 'call.failed'");
    expect(sql).toContain("v_state <> 'eligible'");
    expect(sql).toContain("v_e->>'disconnect_reason' <> 'unobserved_disconnect'");
    expect(sql).toContain("'2026-10-05T09:34:00Z'");
    expect(sql).toContain("'2026-10-05T09:36:00Z'");
    expect(sql).toContain("apply_phone_event('internal', 'call.answered'");
    expect(sql).toContain("v_state <> 'dialing'");
    expect(sql).toContain('Guard (b) ALONE');
    // 6. guard (a) `dialing` alone; an ENDED newer leg holds nothing.
    expect(sql).toContain('p115f edges dialing');
    expect(sql).toContain('p115f edges ended');
  });

  it('the fixtures are synthetic: example.test emails only, no full session uuid of a real case', () => {
    for (const rel of [
      'app/supabase/tests/phone_0118_finalize.sql',
      'app/supabase/tests/phone_partial_finalize_setup.sql',
    ]) {
      const sql = read(rel);
      for (const m of sql.matchAll(/[\w.+-]+@[\w.-]+/g)) expect(m[0], rel).toMatch(/@example\.test$/);
      expect(sql, rel).not.toMatch(/9f60523d-|32757295-|fb3d0846-/);
    }
  });

  it('the supabase-test partial-finalize fixture pins the held (reconnecting) session', () => {
    const setup = read('app/supabase/tests/phone_partial_finalize_setup.sql');
    const assert = read('app/supabase/tests/phone_partial_finalize_assert.sql');
    expect(setup).toContain("array['stranded','control','crash','lease','held']");
    expect(setup).toContain("case when v_s = 'held' then 'reconnecting' else 'in_call' end");
    expect(assert).toContain("where external_call_id = 'phone-pf72-held'");
    expect(assert).toContain('the held session (reconnect pending) was returned for scoring');
  });
});
