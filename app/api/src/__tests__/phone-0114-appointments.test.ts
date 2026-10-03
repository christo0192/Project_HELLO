/**
 * 0114 §5 (PR-C, S5) — appointment truthfulness (C5), asserted against the
 * migration TEXT.
 *
 * schedule_phone_appointment and expire_phone_appointments are LIFTED by
 * script from 0042, their newest declaration (no later migration redeclares
 * either; asserted below). The core assertion is a structural diff: remove
 * every marked 0114 hunk (`-- ▼ 0114 <id>` … `-- ▲ 0114 <id>`), remove the
 * few 0042 lines the hunks REPLACE (pinned here by exact text), and what is
 * left must be BYTE-IDENTICAL on both sides.
 *
 * Behaviour is proven in app/supabase/tests/policy_tests.sql (block
 * 0114-§5); text is not execution.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import {
  MIGRATION_0042,
  MIGRATION_0095,
  MIGRATION_0114,
  functionBody,
  functionStatuses,
} from './support/phone-migration.js';

const lf = (s: string) => s.replace(/\r\n/g, '\n');
const M0042 = lf(MIGRATION_0042);
const M0095 = lf(MIGRATION_0095);
const M0114 = lf(MIGRATION_0114);

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../supabase/migrations/', import.meta.url));

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

const BEGIN = '-- ==== 0114 §5 BEGIN ====';
const END = '-- ==== 0114 §5 END ====';
const SECTION = M0114.slice(M0114.indexOf(BEGIN), M0114.indexOf(END) + END.length);

const SCHED_0042 = bodyIn(M0042, 'schedule_phone_appointment');
const SCHED_0114 = bodyIn(M0114, 'schedule_phone_appointment');
const EXP_0042 = bodyIn(M0042, 'expire_phone_appointments');
const EXP_0114 = bodyIn(M0114, 'expire_phone_appointments');

/** Remove every marked hunk; returns the residue and the hunk tags, in order. */
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

function removeOnce(text: string, line: string): string {
  const n = text.split(line).length - 1;
  if (n !== 1) throw new Error(`expected exactly one ${JSON.stringify(line)}, found ${n}`);
  return text.replace(line, '');
}

/** Code with comments and the signature's `default now()` removed. */
function code(body: string): string {
  return body.replace(/--[^\n]*/g, '').replace(/timestamptz\s+default now\(\)/g, 'timestamptz');
}
const MACHINE_CLOCK =
  /\b(now|clock_timestamp|statement_timestamp|transaction_timestamp|timeofday)\s*\(|\bcurrent_(timestamp|date|time)\b|\blocaltimestamp\b/i;

const SCHED = stripHunks(SCHED_0114);
const EXP = stripHunks(EXP_0114);

/** The ONLY 0042 expire lines the 0114 hunks replace (rather than add to). */
const EXPIRE_REPLACED_0042_LINES = [
  "           cancel_reason = 'system_deferral_expired',\n",
  '    select id into v_eng_id\n',
  "  return jsonb_build_object('status', 'ok', 'expired', v_count,\n" +
    "                            'grace_seconds', v_grace, 'limit', v_limit);\n",
];

describe('0114 §5 — ownership and lift source', () => {
  it('declares each owned function exactly once in 0114, inside §5', () => {
    for (const name of ['schedule_phone_appointment', 'expire_phone_appointments']) {
      const decl = `create or replace function screening_v2.${name}(`;
      expect(M0114.split(decl).length - 1, name).toBe(1);
      expect(SECTION.indexOf(decl), name).toBeGreaterThan(-1);
    }
  });

  it('0042 is the newest prior declaration of both (no 0043..0113 redeclaration)', () => {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .sort();
    for (const name of ['schedule_phone_appointment', 'expire_phone_appointments']) {
      const re = new RegExp(`function screening_v2\\.${name}\\b`);
      const declaring = files.filter((f) => re.test(readFileSync(MIGRATIONS_DIR + f, 'utf8')));
      expect(declaring, name).toEqual(['0042_phone_screening.sql', '0114_phone_outcome_integrity.sql']);
    }
  });

  it('the newest-first extractors now read the 0114 bodies', () => {
    expect(functionBody('schedule_phone_appointment')).toContain('-- ▼ 0114 C5-b booking refusals');
    expect(functionBody('expire_phone_appointments')).toContain('-- ▼ 0114 C5-c wedge release');
  });
});

describe('0114 §5 — structural diff against 0042', () => {
  it('schedule_phone_appointment = 0042 + the C5-b hunks only (pure insertion)', () => {
    expect(SCHED.tags).toEqual(['C5-b declare', 'C5-b booking refusals']);
    expect(SCHED.residue).toBe(SCHED_0042);
  });

  it('expire_phone_appointments = 0042 + the C5-a/C5-c hunks, minus exactly the pinned replaced lines', () => {
    expect(new Set(EXP.tags)).toEqual(
      new Set([
        'C5-a declare',
        'C5-a control read',
        'C5-a hold (scan)',
        'C5-a engagement lock reads terminal_at',
        'C5-a hold (locked re-check)',
        'C5-a cause',
        'C5-a audit cause',
        'C5-a held count',
        'C5-c wedge release',
        'C5-a/C5-c return keys',
      ]),
    );
    let expected = EXP_0042;
    for (const line of EXPIRE_REPLACED_0042_LINES) expected = removeOnce(expected, line);
    expect(EXP.residue).toBe(expected);
  });

  it('each replaced line has its replacement inside a hunk', () => {
    expect(EXP.hunks['C5-a cause']).toContain('cancel_reason = v_cause,');
    expect(EXP.hunks['C5-a engagement lock reads terminal_at']).toContain(
      'select id, terminal_at into v_eng_id, v_eng_terminal',
    );
    expect(EXP.hunks['C5-a/C5-c return keys']).toMatch(
      /'grace_seconds', v_grace, 'limit', v_limit,\s*'held', v_held, 'released', v_released\);/,
    );
  });

  it("keeps the literal status = 'missed' (residuals R-c) and writes no other appointment status", () => {
    expect(EXP_0114).toMatch(/set status {8}= 'missed',/);
    expect(functionBody('expire_phone_appointments')).toMatch(/status\s*=\s*'missed'/);
    for (const body of [EXP_0114, SCHED_0114]) {
      expect(body).not.toMatch(/=\s*'fulfilled'/);
      expect(body).not.toMatch(/=\s*'confirmed'/);
    }
  });
});

describe('0114 §5 — posture', () => {
  for (const [name, body, sig] of [
    ['schedule_phone_appointment', SCHED_0114, 'uuid, timestamptz, timestamptz, text, uuid, integer, timestamptz'],
    ['expire_phone_appointments', EXP_0114, 'integer, integer, timestamptz'],
  ] as const) {
    it(`${name}: SECURITY DEFINER, pinned search_path, service_role-only, no machine clock`, () => {
      expect(body).toMatch(/\nsecurity definer\nset search_path = pg_catalog, screening_v2\nas \$\$/);
      expect(SECTION).toContain(
        `revoke all on function screening_v2.${name}(${sig})\n  from public, anon, authenticated;`,
      );
      expect(SECTION).toContain(
        `grant execute on function screening_v2.${name}(${sig})\n  to service_role;`,
      );
      expect(code(body)).not.toMatch(MACHINE_CLOCK);
    });
  }

  it('the section names no PII column and logs no identity', () => {
    expect(code(SECTION)).not.toMatch(/phone_e164|\bemail\b|\bname\b|room_name|sip_call_id|participant_identity/);
  });

  it('the new audit action is in the 0114 chk_audit_action', () => {
    expect(EXP_0114).toContain("'phone_scheduled_engagement_released', 'phone_engagement'");
    const s1 = M0114.slice(M0114.indexOf('-- ==== 0114 §1 BEGIN ===='), M0114.indexOf('-- ==== 0114 §1 END ===='));
    expect(s1).toContain("'phone_scheduled_engagement_released'");
  });
});

describe('0114 §5 — C5-a expiry hold', () => {
  const hold = EXP.hunks['C5-a control read'];

  it('reads phone_control and fails closed on a missing row', () => {
    expect(hold).toMatch(/from screening_v2\.phone_control c\s+where c\.control_key = 'default';/);
    expect(hold).toMatch(/if not found then\s+v_halted\s+:= true;/);
  });

  it('applies the same hold predicate in the scan, the locked re-check and the held count', () => {
    const norm = (s: string) =>
      code(s)
        .replace(/\ba\./g, '')
        .replace(/exists \(select 1 from screening_v2\.phone_engagements e\s+where e\.id = (phone_appointments\.|)engagement_id and e\.terminal_at is not null\)/, 'TERMINAL')
        .replace(/v_eng_terminal is not null/, 'TERMINAL')
        .replace(/\s+/g, ' ')
        .trim();
    const scan = norm(EXP.hunks['C5-a hold (scan)']).replace(/^and /, '');
    const recheck = norm(EXP.hunks['C5-a hold (locked re-check)']).replace(/^and /, '');
    expect(scan).toBe(recheck);
    expect(scan).toContain('phone_ist_window_close_at()');
    expect(scan).toContain("at time zone 'Asia/Kolkata'");
    expect(scan).toContain('not v_halted and greatest(ends_at, v_ctl_at)');
    const held = norm(EXP.hunks['C5-a held count']);
    expect(held).toContain(`and not ${scan.replace(/;$/, '')}`);
  });

  it('a control stamp later than p_now is ignored, not clamped', () => {
    expect(hold).toContain('v_ctl_at := case when v_ctl_updated <= p_now then v_ctl_updated end;');
  });

  it('the cause is terminal -> engagement_cancelled, halted/lane change -> emergency_stop, else system_deferral_expired', () => {
    expect(code(EXP.hunks['C5-a cause'])).toMatch(
      /when v_eng_terminal is not null then 'engagement_cancelled'\s+when v_halted or v_ctl_at > v_apt\.starts_at then 'emergency_stop'\s+else 'system_deferral_expired'/,
    );
    expect(EXP.hunks['C5-a audit cause']).toMatch(
      /'cause', v_cause,\s+'lane_halted', v_halted,\s+'control_updated_at', v_ctl_updated,/,
    );
  });

  it('still answers only status ok', () => {
    expect(functionStatuses('expire_phone_appointments')).toEqual(new Set(['ok']));
  });
});

describe('0114 §5 — C5-c wedge release', () => {
  const wedge = EXP.hunks['C5-c wedge release'];

  it('is bounded, skip-locked, re-checked under the lock, and respects any time hold', () => {
    expect(wedge).toContain('limit v_limit');
    expect(wedge).toContain('for update skip locked;');
    expect(wedge.split("coalesce(next_eligible_at, '-infinity'::timestamptz) <= p_now").length - 1).toBe(1);
    expect(wedge).toContain("coalesce(e.next_eligible_at, '-infinity'::timestamptz) <= p_now");
    expect(wedge.split("ap.status in ('scheduled', 'confirmed')").length - 1).toBe(2);
  });

  it('releases to eligible/appointment_lost no sooner than the next IST-day window open (0095 expression)', () => {
    expect(wedge).toContain("state_reason     = 'appointment_lost'");
    expect(wedge).toMatch(
      /greatest\(next_eligible_at,\s+screening_v2\.phone_next_window_open\(\s+\(screening_v2\.phone_ist_date\(p_now\) \+ 1\)::timestamp\s+at time zone 'Asia\/Kolkata'\)\)/,
    );
    expect(wedge).toContain("'phone_scheduled_engagement_released'");
  });
});

describe('0114 §5 — C5-b booking refusals', () => {
  const refusals = SCHED.hunks['C5-b booking refusals'];

  it('sit after the engagement lock and the dialing check and BEFORE any supersede', () => {
    const at = (s: string) => {
      const i = SCHED_0114.indexOf(s);
      if (i === -1) throw new Error(`missing ${s}`);
      return i;
    };
    const lock = at('where id = p_engagement_id for update;');
    const dialing = at("'attempt_in_flight'");
    const notYet = at("'slot_not_yet_eligible'");
    const daily = at("'daily_attempt_exists'");
    const live = at('select * into v_live from screening_v2.phone_appointments');
    const supersede = at("set status        = 'superseded'");
    expect(lock).toBeLessThan(dialing);
    expect(dialing).toBeLessThan(notYet);
    expect(notYet).toBeLessThan(daily);
    expect(daily).toBeLessThan(live);
    expect(live).toBeLessThan(supersede);
  });

  it('slot_not_yet_eligible mirrors admission not_yet_eligible on the slot start', () => {
    expect(code(refusals)).toMatch(
      /if v_eng\.next_eligible_at is not null and p_starts_at < v_eng\.next_eligible_at then/,
    );
  });

  it('daily_attempt_exists uses the exact 0095:513-519 predicate, on the slot IST date, with the cap 2', () => {
    const norm = (s: string) => code(s).replace(/\s+/g, ' ').trim();
    const a0095 = M0095.indexOf('select coalesce(max(a.ist_day_seq), 0) + 1 into v_day_seq');
    expect(a0095).toBeGreaterThan(-1);
    const w0095 = M0095.indexOf('where a.engagement_id = p_engagement_id', a0095);
    const e0095 = M0095.indexOf("or a.abandon_reason is distinct from 'infra_deferred');", w0095);
    const pred0095 = norm(M0095.slice(w0095, e0095)).replace(
      'a.ist_date = v_ist_date',
      'a.ist_date = screening_v2.phone_ist_date(p_starts_at)',
    );
    const w = refusals.indexOf('where a.engagement_id = p_engagement_id');
    const e = refusals.indexOf("or a.abandon_reason is distinct from 'infra_deferred');", w);
    expect(w).toBeGreaterThan(-1);
    expect(norm(refusals.slice(w, e))).toBe(pred0095);
    expect(refusals).toContain('select coalesce(max(a.ist_day_seq), 0) into v_dials_on_day');
    expect(M0095).toContain('if v_day_seq > 2 then');
    expect(refusals).toContain('if v_dials_on_day >= 2 then');
    expect(refusals).toContain("'max_per_day', 2);");
    expect(refusals).toMatch(/0095:522/);
  });

  it('adds exactly the two statuses to the extracted vocabulary', () => {
    const s = functionStatuses('schedule_phone_appointment');
    expect(s.has('slot_not_yet_eligible')).toBe(true);
    expect(s.has('daily_attempt_exists')).toBe(true);
    const before = new Set(
      [...SCHED_0042.matchAll(/'status',\s*'([a-z_]+)'/g)].map((m) => m[1]),
    );
    const after = new Set([...SCHED_0114.matchAll(/'status',\s*'([a-z_]+)'/g)].map((m) => m[1]));
    expect([...after].filter((x) => !before.has(x)).sort()).toEqual([
      'daily_attempt_exists',
      'slot_not_yet_eligible',
    ]);
  });
});
