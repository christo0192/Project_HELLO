/**
 * 0114 §6 (PR-C, S6) — person identity guards (C8), asserted against the
 * migration TEXT.
 *
 * admit_phone_attempt (from 0095), ensure_ashby_phone_engagement (from 0057)
 * and schedule_candidate_phone_appointment (from 0058) are LIFTED by script
 * from their newest declarations (asserted below). The core assertion is a
 * structural diff: remove every marked 0114 hunk (`-- ▼ 0114 <id>` …
 * `-- ▲ 0114 <id>`), remove the two 0095 guard statements the hunks REPLACE
 * (pinned here by exact text), and what is left must be BYTE-IDENTICAL to the
 * source body.
 *
 * Behaviour is proven in app/supabase/tests/policy_tests.sql (block
 * 0114-§6, cases 0114-1 … 0114-13); text is not execution.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import {
  MIGRATION_0057,
  MIGRATION_0095,
  MIGRATION_0114,
  functionBody,
  functionStatuses,
} from './support/phone-migration.js';

const lf = (s: string) => s.replace(/\r\n/g, '\n');
const MIGRATIONS_DIR = fileURLToPath(new URL('../../../supabase/migrations/', import.meta.url));
const M0057 = lf(MIGRATION_0057);
const M0058 = lf(readFileSync(`${MIGRATIONS_DIR}0058_phone_candidate_scheduling.sql`, 'utf8'));
const M0095 = lf(MIGRATION_0095);
const M0114 = lf(MIGRATION_0114);

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

const BEGIN = '-- ==== 0114 §6 BEGIN ====';
const END = '-- ==== 0114 §6 END ====';
const SECTION = M0114.slice(M0114.indexOf(BEGIN), M0114.indexOf(END) + END.length);

/** Remove every marked hunk; returns the residue and the hunks by tag, in order. */
function stripHunks(body: string): { residue: string; tags: string[]; hunks: Record<string, string> } {
  const tags: string[] = [];
  const hunks: Record<string, string> = {};
  const re = /^[ \t]*-- ▼ 0114 ([^\n]+)\n([\s\S]*?)^[ \t]*-- ▲ 0114 ([^\n]+)\n/gm;
  const residue = body.replace(re, (_m, open: string, inner: string, close: string) => {
    if (open !== close) throw new Error(`hunk ${open} closed as ${close}`);
    tags.push(open);
    hunks[open] = (hunks[open] ?? '') + inner;
    return '';
  });
  if (/▼ 0114|▲ 0114/.test(residue)) throw new Error('unbalanced 0114 hunk marker');
  return { residue, tags, hunks };
}

function removeOnce(text: string, chunk: string): string {
  const n = text.split(chunk).length - 1;
  if (n !== 1) throw new Error(`expected exactly one ${JSON.stringify(chunk.slice(0, 60))}, found ${n}`);
  return text.replace(chunk, '');
}

/** Code with comments and the signature's `default now()` removed. */
function code(body: string): string {
  return body.replace(/--[^\n]*/g, '').replace(/timestamptz\s+default now\(\)/g, 'timestamptz');
}
const MACHINE_CLOCK =
  /\b(now|clock_timestamp|statement_timestamp|transaction_timestamp|timeofday)\s*\(|\bcurrent_(timestamp|date|time)\b|\blocaltimestamp\b/i;

const ADMIT_0095 = bodyIn(M0095, 'admit_phone_attempt');
const ADMIT_0114 = bodyIn(M0114, 'admit_phone_attempt');
const ENSURE_0057 = bodyIn(M0057, 'ensure_ashby_phone_engagement');
const ENSURE_0114 = bodyIn(M0114, 'ensure_ashby_phone_engagement');
const SCHED_0058 = bodyIn(M0058, 'schedule_candidate_phone_appointment');
const SCHED_0114 = bodyIn(M0114, 'schedule_candidate_phone_appointment');
const RELEASE = bodyIn(M0114, 'release_phone_identity_hold');

const ADMIT = stripHunks(ADMIT_0114);
const ENSURE = stripHunks(ENSURE_0114);
const SCHED = stripHunks(SCHED_0114);

/** The ONLY 0095 admit text the 0114 hunks replace: the two guard statements. */
const ADMIT_REPLACED_0095 = [
  `  if exists (
    select 1
      from screening_v2.phone_call_attempts a
      join screening_v2.phone_engagements e on e.id = a.engagement_id
     where e.candidate_id = v_eng.candidate_id
       and a.engagement_id <> p_engagement_id
       and a.state in ('admitted','ringing','answered_unclassified','human','machine')
       and a.lease_expires_at > p_now
  ) then
    return jsonb_build_object('status', 'candidate_call_in_flight');
  end if;
`,
  `  if p_kind in ('initial','no_answer_retry')
     and exists (
    select 1
      from screening_v2.phone_call_attempts a
      join screening_v2.phone_engagements e on e.id = a.engagement_id
     where e.candidate_id = v_eng.candidate_id
       and a.engagement_id <> p_engagement_id
       and a.ist_date = v_ist_date
       and a.kind in ('initial','no_answer_retry','scheduled')
       -- NULL-SAFE: see the index predicate (reclaim rows carry NULL reason).
       and (a.state <> 'abandoned'
            or a.abandon_reason is distinct from 'infra_deferred')
  ) then
    return jsonb_build_object('status', 'candidate_daily_attempt_exists',
                              'ist_date', v_ist_date);
  end if;
`,
];

const OWNED = [
  'admit_phone_attempt',
  'ensure_ashby_phone_engagement',
  'schedule_candidate_phone_appointment',
  'release_phone_identity_hold',
] as const;

describe('0114 §6 — ownership and lift source', () => {
  it('declares each owned function exactly once in 0114, inside §6', () => {
    for (const name of OWNED) {
      const decl = `create or replace function screening_v2.${name}(`;
      expect(M0114.split(decl).length - 1, name).toBe(1);
      expect(SECTION.indexOf(decl), name).toBeGreaterThan(-1);
    }
  });

  it('the lift sources are the newest prior declarations (0095, 0057, 0058)', () => {
    // Each file is read ONCE (a bind-mounted tree makes repeated reads slow).
    const texts = readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f) && f !== '0114_phone_outcome_integrity.sql')
      .sort()
      .map((f) => ({ f, sql: readFileSync(MIGRATIONS_DIR + f, 'utf8') }));
    const newestBefore0114 = (name: string) => {
      const re = new RegExp(`function screening_v2\\.${name}\\b`);
      const declaring = texts.filter((t) => re.test(t.sql)).map((t) => t.f);
      return declaring[declaring.length - 1];
    };
    expect(newestBefore0114('admit_phone_attempt')).toBe('0095_phone_call_outcome_hygiene.sql');
    expect(newestBefore0114('ensure_ashby_phone_engagement')).toBe('0057_phone_rescreen_cycles.sql');
    expect(newestBefore0114('schedule_candidate_phone_appointment')).toBe(
      '0058_phone_candidate_scheduling.sql',
    );
  }, 30_000);

  it('the newest-first extractors now read the 0114 bodies', () => {
    expect(functionBody('admit_phone_attempt')).toContain('-- ▼ 0114 C8-a guard A');
    expect(functionBody('ensure_ashby_phone_engagement')).toContain('-- ▼ 0114 C8-b duplicate hold');
  });
});

describe('0114 §6 — structural diff against the lift sources', () => {
  it('admit_phone_attempt = 0095 + the C8-a hunks, minus exactly the two pinned guard statements', () => {
    expect(ADMIT.tags).toEqual(['C8-a declare', 'C8-a line set', 'C8-a guard A', 'C8-a guard B']);
    let expected = ADMIT_0095;
    for (const chunk of ADMIT_REPLACED_0095) expected = removeOnce(expected, chunk);
    expect(ADMIT.residue).toBe(expected);
  });

  it('ensure_ashby_phone_engagement = 0057 + the C8-b hunk only (pure insertion)', () => {
    expect(ENSURE.tags).toEqual(['C8-b duplicate hold']);
    expect(ENSURE.residue).toBe(ENSURE_0057);
  });

  it('schedule_candidate_phone_appointment = 0058 + the C8-d hunk only (pure insertion)', () => {
    expect(SCHED.tags).toEqual(['C8-d duplicate hold']);
    expect(SCHED.residue).toBe(SCHED_0058);
  });
});

describe('0114 §6 — C8-a admission guards key on the line', () => {
  const guardA = ADMIT.hunks['C8-a guard A'];
  const guardB = ADMIT.hunks['C8-a guard B'];

  it('the line set is every row on the validated number plus this row, built AFTER the halt read', () => {
    expect(ADMIT.hunks['C8-a line set']).toMatch(
      /select array_agg\(c\.id\) into v_line_candidates\s+from screening_v2\.candidates c\s+where c\.phone_e164 = v_phone\s+or c\.id = v_eng\.candidate_id;/,
    );
    const halt = ADMIT_0114.indexOf('from screening_v2.phone_control');
    expect(halt).toBeGreaterThan(-1);
    expect(ADMIT_0114.indexOf('-- ▼ 0114 C8-a line set')).toBeGreaterThan(halt);
  });

  it('both guards widen to the line and keep their predicates and statuses', () => {
    for (const g of [guardA, guardB]) {
      expect(g).toContain('where e.candidate_id = any (v_line_candidates)');
      expect(g).toContain('and a.engagement_id <> p_engagement_id');
      expect(g).toMatch(/'scope', case when v_hit_candidate = v_eng\.candidate_id\s+then 'candidate' else 'line' end/);
    }
    expect(guardA).toContain("and a.state in ('admitted','ringing','answered_unclassified','human','machine')");
    expect(guardA).toContain('and a.lease_expires_at > p_now');
    expect(guardA).toContain("'status', 'candidate_call_in_flight'");
    expect(guardB).toContain("if p_kind in ('initial','no_answer_retry') then");
    expect(guardB).toContain("and a.kind in ('initial','no_answer_retry','scheduled')");
    expect(guardB).toContain("or a.abandon_reason is distinct from 'infra_deferred')");
    expect(guardB).toContain("'status', 'candidate_daily_attempt_exists'");
  });

  it('the status vocabulary is unchanged (29 statuses, as 0095)', () => {
    expect(functionStatuses('admit_phone_attempt').size).toBe(29);
  });

  it('LOCK 1 is still the first statement and no exception handler precedes the halt read', () => {
    const src = code(ADMIT_0114);
    const begin = src.indexOf('\nbegin\n');
    const first = src.slice(begin + '\nbegin\n'.length).trimStart();
    expect(first.startsWith("perform pg_advisory_xact_lock(hashtext('phone_admission'));")).toBe(true);
    const halt = src.indexOf('from screening_v2.phone_control');
    expect(src.slice(0, halt)).not.toMatch(/\bexception\b/);
    // The global-lock comment the line guard's atomicity rests on is kept.
    expect(ADMIT_0114).toContain('-- ── LOCK 1: the global admission serialiser, FIRST statement');
    expect(ADMIT.hunks['C8-a line set']).toContain('it rests on LOCK 1, the global phone_admission serialiser');
  });
});

describe('0114 §6 — C8-b the duplicate hold in ensure', () => {
  const hold = ENSURE.hunks['C8-b duplicate hold'];

  it('is gated: pending_prereqs, cycle 1, not a rescreen child, not released', () => {
    expect(hold).toMatch(
      /if v_eng\.state = 'pending_prereqs'\s+and v_eng\.cycle_number = 1\s+and not exists \(select 1 from screening_v2\.phone_rescreen_requests r\s+where r\.new_engagement_id = v_eng\.id\)\s+and not exists \(select 1 from screening_v2\.phone_identity_hold_releases h\s+where h\.engagement_id = v_eng\.id\) then/,
    );
  });

  it('sits after the phone_invalid return and before the submitted_at / consent checks', () => {
    const at = ENSURE_0114.indexOf('-- ▼ 0114 C8-b duplicate hold');
    expect(at).toBeGreaterThan(ENSURE_0114.indexOf("'status', 'phone_invalid'"));
    expect(at).toBeLessThan(ENSURE_0114.indexOf('if v_link.submitted_at is null'));
    expect(at).toBeLessThan(ENSURE_0114.indexOf('insert into screening_v2.consent_records'));
  });

  it('takes the ashby_person_identity lock AFTER the link and engagement row locks', () => {
    const identity = ENSURE_0114.indexOf("hashtext('ashby_person_identity')");
    expect(identity).toBeGreaterThan(ENSURE_0114.indexOf('from screening_v2.ashby_application_links\n   where id = p_application_link_id'));
    expect(identity).toBeGreaterThan(ENSURE_0114.indexOf('limit 1\n   for update;'));
  });

  it('counts only a different same-role row, live past prerequisites or completed, matched on line / email / external id + mapping', () => {
    expect(hold).toContain('where c.id <> v_candidate.id');
    expect(hold).toContain('and c.role_id = v_candidate.role_id');
    expect(hold).toMatch(/\(\(o\.terminal_at is null and o\.state <> 'pending_prereqs'\)\s+or o\.state = 'completed'\)/);
    expect(hold).toContain('c.phone_e164 = v_candidate.phone_e164');
    expect(hold).toContain('lower(btrim(c.email)) = lower(btrim(v_candidate.email))');
    expect(hold).toContain('l2.external_candidate_id = v_link.external_candidate_id');
    expect(hold).toContain('l2.job_mapping_id = v_link.job_mapping_id');
  });

  it('holds in place (pending_prereqs, reason only) and names only this engagement', () => {
    expect(hold).toContain("set state_reason = 'duplicate_application', updated_at = p_now, version = version + 1");
    expect(code(hold)).not.toMatch(/\bset state\s*=/);
    expect(code(hold)).not.toMatch(/\bconsent_records\b/);
    expect(hold).toContain(
      "return jsonb_build_object('status', 'duplicate_application', 'engagement_id', v_eng.id);",
    );
  });

  it('the email index the match uses is declared on the same expression', () => {
    expect(SECTION).toMatch(
      /create index if not exists idx_v2_candidates_email_norm\s+on screening_v2\.candidates \(lower\(btrim\(email\)\)\)\s+where email is not null;/,
    );
  });
});

describe('0114 §6 — C8-d booking early return and the release RPC', () => {
  it('schedule_candidate returns duplicate_application before schedule_phone_appointment', () => {
    const hunk = SCHED.hunks['C8-d duplicate hold'];
    expect(hunk).toContain("if v_status = 'duplicate_application' then");
    expect(SCHED_0114.indexOf('-- ▼ 0114 C8-d')).toBeLessThan(
      SCHED_0114.indexOf('screening_v2.schedule_phone_appointment('),
    );
  });

  it('release: actor_required first, refuses unless held, records, audits, re-runs ensure', () => {
    const src = code(RELEASE);
    const begin = src.indexOf('\nbegin\n');
    expect(src.slice(begin).trimStart()).toMatch(
      /^begin\s+if p_actor_id is null then\s+return jsonb_build_object\('status', 'actor_required'\);/,
    );
    expect(RELEASE).toContain("or v_eng.state_reason is distinct from 'duplicate_application' then");
    expect(RELEASE).toContain('on conflict (engagement_id) do nothing;');
    expect(RELEASE).toContain("'phone_identity_hold_release', 'phone_engagement'");
    expect(RELEASE).toContain('v_ensure := screening_v2.ensure_ashby_phone_engagement(v_link_id, p_now);');
    expect(new Set(functionStatuses('release_phone_identity_hold'))).toEqual(
      new Set(['actor_required', 'invalid_request', 'not_found', 'not_held', 'ok']),
    );
  });

  it('release takes ensure\'s lock order: link advisory lock, link row, engagement row', () => {
    const adv = RELEASE.indexOf("hashtext('ashby_phone_engagement')");
    const link = RELEASE.indexOf('from screening_v2.ashby_application_links\n   where id = v_link_id\n   for update;');
    const eng = RELEASE.indexOf('from screening_v2.phone_engagements\n   where id = p_engagement_id\n   for update;');
    expect(adv).toBeGreaterThan(-1);
    expect(link).toBeGreaterThan(adv);
    expect(eng).toBeGreaterThan(link);
  });

  it('the release audit carries opaque ids only, and the action is in the 0114 chk_audit_action', () => {
    const audit = RELEASE.slice(RELEASE.indexOf('insert into screening_v2.audit_events'));
    expect(code(audit)).not.toMatch(/phone_e164|email|\bname\b|external_candidate_id|room_name/);
    const s1 = M0114.slice(M0114.indexOf('-- ==== 0114 §1 BEGIN ===='), M0114.indexOf('-- ==== 0114 §1 END ===='));
    expect(s1).toContain("'phone_identity_hold_release'");
  });
});

describe('0114 §6 — posture', () => {
  const SIGS: Record<(typeof OWNED)[number], string> = {
    admit_phone_attempt: 'uuid, text, text, integer, timestamptz',
    ensure_ashby_phone_engagement: 'uuid, timestamptz',
    schedule_candidate_phone_appointment: 'uuid, timestamptz, timestamptz, uuid, timestamptz',
    release_phone_identity_hold: 'uuid, uuid, timestamptz',
  };
  const BODIES: Record<(typeof OWNED)[number], string> = {
    admit_phone_attempt: ADMIT_0114,
    ensure_ashby_phone_engagement: ENSURE_0114,
    schedule_candidate_phone_appointment: SCHED_0114,
    release_phone_identity_hold: RELEASE,
  };

  for (const name of OWNED) {
    it(`${name}: SECURITY DEFINER, pinned search_path, service_role-only, no machine clock`, () => {
      const body = BODIES[name];
      expect(body).toMatch(/\nsecurity definer\nset search_path = pg_catalog, screening_v2\nas \$\$/);
      expect(SECTION).toContain(
        `revoke all on function screening_v2.${name}(${SIGS[name]})\n  from public, anon, authenticated;`,
      );
      expect(SECTION).toContain(`grant execute on function screening_v2.${name}(${SIGS[name]})\n  to service_role;`);
      expect(SECTION).not.toMatch(
        new RegExp(`grant execute on function screening_v2\\.${name}[^;]*to (?:anon|authenticated|public)`),
      );
      expect(code(body)).not.toMatch(MACHINE_CLOCK);
    });
  }

  it('the release table: RLS on, no browser grant, service_role only, opaque columns', () => {
    expect(SECTION).toContain(
      'alter table screening_v2.phone_identity_hold_releases enable row level security;',
    );
    expect(SECTION).toContain(
      'revoke all on table screening_v2.phone_identity_hold_releases from public, anon, authenticated;',
    );
    expect(SECTION).toContain(
      'grant select, insert on table screening_v2.phone_identity_hold_releases to service_role;',
    );
    const table = SECTION.slice(
      SECTION.indexOf('create table if not exists screening_v2.phone_identity_hold_releases'),
      SECTION.indexOf(');', SECTION.indexOf('create table if not exists screening_v2.phone_identity_hold_releases')),
    );
    expect([...table.matchAll(/^\s{2}([a-z_]+)\s/gm)].map((m) => m[1])).toEqual([
      'engagement_id',
      'actor_id',
      'created_at',
    ]);
  });

  it('no returned key in the section names a contact datum', () => {
    for (const m of code(SECTION).matchAll(/jsonb_build_object\(([^;]*?)\);/g)) {
      expect(m[1]).not.toMatch(/'(phone|phone_e164|email|name|external_candidate_id|room_name)'/);
    }
  });

  it('COMMENT ON states the policy for ensure, the release RPC and the table', () => {
    expect(SECTION).toContain('comment on function screening_v2.ensure_ashby_phone_engagement is');
    expect(SECTION).toContain('comment on function screening_v2.release_phone_identity_hold is');
    expect(SECTION).toContain('comment on table screening_v2.phone_identity_hold_releases is');
  });
});
