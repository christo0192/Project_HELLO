/**
 * 0130 (M017, ADR-0018) — the Ashby phone-parsing intake, asserted against the
 * migration TEXT.
 *
 * admit_phone_attempt and ensure_ashby_phone_engagement are LIFTED by script
 * from 0114, their newest declarations, plus marked hunks (`-- ▼ 0130 <id>` …
 * `-- ▲ 0130 <id>`). The core assertion is a structural diff: remove every
 * marked 0130 hunk and what is left must be BYTE-IDENTICAL (LF-normalised) to
 * the 0114 body, so every 0114 gate, lock and status survives and the hunks
 * are the whole change.
 *
 * Behaviour is proven in app/supabase/tests/policy_tests.sql (the 0130
 * block); text is not execution. The production drift check for the five
 * functions 0130 declares is pinned in phone-0130-prod-drift-check.test.ts.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import {
  MIGRATION_0114,
  MIGRATION_0130,
  MIGRATION_0130_PATH,
  PHONE_MIGRATIONS,
  functionBody,
  functionStatuses,
} from './support/phone-migration.js';

const lf = (s: string) => s.replace(/\r\n/g, '\n');
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const MIGRATIONS_DIR = `${ROOT}app/supabase/migrations/`;
const M0114 = lf(MIGRATION_0114);
const M0130 = lf(MIGRATION_0130);
const DRIFT_SCRIPT = lf(readFileSync(`${ROOT}scripts/verify-prod-function-drift.sh`, 'utf8'));

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

/** Remove every marked 0130 hunk; returns the residue and the hunks by tag, in order. */
function stripHunks(body: string): { residue: string; tags: string[]; hunks: Record<string, string> } {
  const tags: string[] = [];
  const hunks: Record<string, string> = {};
  const re = /^[ \t]*-- ▼ 0130 ([^\n]+)\n([\s\S]*?)^[ \t]*-- ▲ 0130 ([^\n]+)\n/gm;
  const residue = body.replace(re, (_m, open: string, inner: string, close: string) => {
    if (open !== close) throw new Error(`hunk ${open} closed as ${close}`);
    tags.push(open);
    hunks[open] = (hunks[open] ?? '') + inner;
    return '';
  });
  if (/▼ 0130|▲ 0130/.test(residue)) throw new Error('unbalanced 0130 hunk marker');
  return { residue, tags, hunks };
}

function section(n: number): string {
  const begin = `-- ==== 0130 §${n} BEGIN ====`;
  const end = `-- ==== 0130 §${n} END ====`;
  const b = M0130.indexOf(begin);
  const e = M0130.indexOf(end);
  if (b === -1 || e === -1 || e < b) throw new Error(`0130 §${n} markers missing or inverted`);
  return M0130.slice(b + begin.length, e);
}

/** Code with comments and the signature's `default now()` removed. */
function code(body: string): string {
  return body.replace(/--[^\n]*/g, '').replace(/timestamptz\s+default now\(\)/g, 'timestamptz');
}
const MACHINE_CLOCK =
  /\b(now|clock_timestamp|statement_timestamp|transaction_timestamp|timeofday)\s*\(|\bcurrent_(timestamp|date|time)\b|\blocaltimestamp\b/i;

/** The joined string literals of `comment on function screening_v2.<name> is ...;`. */
function commentText(sql: string, name: string): string {
  const anchor = `comment on function screening_v2.${name} is\n`;
  const start = sql.indexOf(anchor);
  if (start === -1) throw new Error(`${name} has no comment`);
  const end = sql.indexOf("';\n", start);
  return [...sql.slice(start + anchor.length, end + 2).matchAll(/'((?:[^']|'')*)'/g)]
    .map((m) => m[1])
    .join('');
}

/** The header of a declaration: from `create or replace function` through `as $$`. */
const header = (body: string) => body.slice(0, body.indexOf('\nas $$\n'));

/** The `'status'` literals a body (or a hunk) writes directly. */
const statusLiterals = (text: string) =>
  new Set([...text.matchAll(/'status',\s*'([a-z_]+)'/g)].map((m) => m[1]));

const ADMIT_0114 = bodyIn(M0114, 'admit_phone_attempt');
const ADMIT_0130 = bodyIn(M0130, 'admit_phone_attempt');
const ENSURE_0114 = bodyIn(M0114, 'ensure_ashby_phone_engagement');
const ENSURE_0130 = bodyIn(M0130, 'ensure_ashby_phone_engagement');

const ADMIT = stripHunks(ADMIT_0130);
const ENSURE = stripHunks(ENSURE_0130);

/** Every function 0130 declares, in file order, with its section and regprocedure arguments. */
const DECLARED = [
  { name: 'admit_phone_attempt', section: 3, sig: 'uuid, text, text, integer, timestamptz' },
  { name: 'ensure_ashby_phone_engagement', section: 4, sig: 'uuid, timestamptz' },
  {
    name: 'apply_ashby_candidate_profile',
    section: 5,
    sig: 'uuid, text, text, text, text, text, text, timestamptz',
  },
  { name: 'claim_ashby_profile_due', section: 6, sig: 'integer, integer, integer, integer, timestamptz' },
  { name: 'release_ashby_number_after_identity_mismatch', section: 7, sig: 'uuid, timestamptz' },
] as const;
const LIFTED = DECLARED.slice(0, 2);

/** The `CHECKS=( ... )` entries of the drift script: `<regprocedure>|<token>`. */
function driftChecks(): Array<{ signature: string; token: string }> {
  const block = /CHECKS=\(\n([\s\S]*?)\n\)/.exec(DRIFT_SCRIPT);
  if (!block) throw new Error('CHECKS array not found');
  return block[1]
    .split('\n')
    .map((line) => /^\s*"([^"|]+)\|([^"]+)"\s*$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ signature: m[1], token: m[2] }));
}

describe('0130 registration and frame', () => {
  it('is the one CI-legal 0130 file and the newest NON-R1 migration file', () => {
    const base = path.basename(MIGRATION_0130_PATH);
    expect(base).toMatch(/^0130_[a-z0-9_]+\.sql$/);
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(files.filter((f) => f.startsWith('0130_'))).toEqual([base]);
    const nonR1 = files.filter((f) => !/_r1_/.test(f));
    expect(nonR1[nonR1.length - 1]).toBe(base);
  });

  it('is the FIRST (newest) entry of PHONE_MIGRATIONS, so the extractors read the 0130 bodies', () => {
    const names = PHONE_MIGRATIONS.map((m) => m.name);
    expect(names[0]).toBe('0130');
    expect(names[1]).toBe('0125');
    expect(names.filter((n) => n === '0130')).toHaveLength(1);
    expect(PHONE_MIGRATIONS[0].sql).toBe(MIGRATION_0130);
    // The 0130 hunks AND the 0114 C8 markers are in whatever body is read.
    const admit = functionBody('admit_phone_attempt');
    expect(admit).toContain('-- ▼ 0130 M017-a intake gate open');
    expect(admit).toContain('-- ▼ 0114 C8-a guard A');
    const ensure = functionBody('ensure_ashby_phone_engagement');
    expect(ensure).toContain('-- ▼ 0130 M017-b intake gate open');
    expect(ensure).toContain('-- ▼ 0114 C8-b duplicate hold');
  });

  it('has §1..§7 BEGIN/END markers once each, in order; outside them only the lock timeout and the notify', () => {
    let last = -1;
    let outside = M0130;
    for (let n = 1; n <= 7; n += 1) {
      const begin = `-- ==== 0130 §${n} BEGIN ====`;
      const end = `-- ==== 0130 §${n} END ====`;
      expect(M0130.split(begin).length - 1, begin).toBe(1);
      expect(M0130.split(end).length - 1, end).toBe(1);
      expect(M0130.indexOf(begin), begin).toBeGreaterThan(last);
      expect(M0130.indexOf(end), end).toBeGreaterThan(M0130.indexOf(begin));
      last = M0130.indexOf(end);
      outside = outside.replace(`${begin}${section(n)}${end}`, '');
    }
    expect(M0130).not.toMatch(/-- ==== 0130 §8 BEGIN ====/);
    expect(code(outside).replace(/\s+/g, ' ').trim()).toBe(
      "set local lock_timeout = '10s'; notify pgrst, 'reload schema';",
    );
    expect(M0130.endsWith("\nnotify pgrst, 'reload schema';\n")).toBe(true);
  });

  it('declares exactly the five drift-checked functions, each once, inside its own section', () => {
    expect([...M0130.matchAll(/create or replace function screening_v2\.(\w+)\(/g)].map((m) => m[1])).toEqual(
      DECLARED.map((d) => d.name),
    );
    for (const { name, section: n } of DECLARED) {
      expect(section(n), name).toContain(`create or replace function screening_v2.${name}(`);
    }
  });

  it('never names a function other suites pin to its 0114 or earlier declaration', () => {
    expect(M0130).not.toMatch(
      /function screening_v2\.(request_phone_rescreen|schedule_phone_appointment|expire_phone_appointments)\b/,
    );
    for (const name of ['set_phone_halt', 'clear_phone_halt', 'admit_phone_test_attempt']) {
      expect(M0130, name).not.toMatch(new RegExp(`create (or replace )?function screening_v2\\.${name}\\(`));
    }
  });
});

describe('0130 §3/§4 — structural diff against 0114', () => {
  it('admit_phone_attempt = 0114 + the M017-a hunk pair only (pure insertion)', () => {
    expect(ADMIT.tags).toEqual(['M017-a intake gate open', 'M017-a intake gate close']);
    expect(ADMIT.residue).toBe(ADMIT_0114);
  });

  it('ensure_ashby_phone_engagement = 0114 + the M017-b hunk pair and M017-c only (pure insertion)', () => {
    expect(ENSURE.tags).toEqual([
      'M017-b intake gate open',
      'M017-b intake gate close',
      'M017-c consent basis',
    ]);
    expect(ENSURE.residue).toBe(ENSURE_0114);
  });
});

describe('0130 hunks — phone_parsing skips only the resume/ingestion gate', () => {
  const OPEN = "  if v_link.intake_type is distinct from 'phone_parsing' then\n";
  const CLOSE = '  end if;\n';

  /** The 0114 text a hunk pair wraps: between the open hunk's end and the close hunk's start. */
  function wrapped(body: string, id: string): string {
    const openEnd = `-- ▲ 0130 ${id} intake gate open\n`;
    const from = body.indexOf(openEnd) + openEnd.length;
    return body.slice(from, body.indexOf(`  -- ▼ 0130 ${id} intake gate close`));
  }

  it('each gate opens with one null-safe test of intake_type and closes with a bare end if', () => {
    for (const { hunks, id } of [
      { hunks: ADMIT.hunks, id: 'M017-a' },
      { hunks: ENSURE.hunks, id: 'M017-b' },
    ]) {
      expect(hunks[`${id} intake gate open`], id).toBe(OPEN);
      expect(hunks[`${id} intake gate close`], id).toBe(CLOSE);
    }
  });

  it('admit wraps exactly the handle and ingestion checks, after the mapping check', () => {
    const gate = wrapped(ADMIT_0130, 'M017-a');
    expect(gate).toContain('if v_link.external_resume_file_handle is null then');
    expect(gate).toContain('from screening_v2.ashby_resume_ingestions');
    expect(statusLiterals(gate)).toEqual(new Set(['ingestion_not_ready']));
    expect(code(gate)).not.toMatch(/phone_control|consent|phone_e164|pg_advisory|for update/);
    expect(ADMIT_0130.indexOf('-- ▼ 0130 M017-a intake gate open')).toBeGreaterThan(
      ADMIT_0130.indexOf("'status', 'mapping_not_enabled'"),
    );
  });

  it('ensure wraps exactly the ingestion check; phone_invalid, the C8-b hold and consent still run after it', () => {
    const gate = wrapped(ENSURE_0130, 'M017-b');
    expect(gate).toContain('from screening_v2.ashby_resume_ingestions');
    expect(statusLiterals(gate)).toEqual(new Set(['ingestion_not_ready']));
    expect(code(gate)).not.toMatch(/consent|phone_e164|pg_advisory|for update/);
    const close = ENSURE_0130.indexOf('-- ▲ 0130 M017-b intake gate close');
    expect(ENSURE_0130.indexOf("'status', 'phone_invalid'")).toBeGreaterThan(close);
    expect(ENSURE_0130.indexOf('-- ▼ 0114 C8-b duplicate hold')).toBeGreaterThan(close);
    expect(ENSURE_0130.indexOf('insert into screening_v2.consent_records')).toBeGreaterThan(close);
  });

  it('M017-c adds the proof basis for phone_parsing right after the consent insert, and nothing else', () => {
    const hunk = ENSURE.hunks['M017-c consent basis'];
    expect(hunk).toBe(
      [
        "    if v_link.intake_type = 'phone_parsing' then",
        '      update screening_v2.consent_records',
        "         set proof = proof || jsonb_build_object('basis','ashby_ai_stage_application','intake_type','phone_parsing')",
        '       where id = v_consent.id',
        '      returning * into v_consent;',
        '    end if;',
        '',
      ].join('\n'),
    );
    expect(ENSURE_0130).toContain(') returning * into v_consent;\n    -- ▼ 0130 M017-c consent basis\n');
    // resume_parsing keeps the 0114 basis; source and consent_source are untouched.
    expect(ENSURE_0130).toContain(
      "jsonb_build_object('basis', 'ashby_application_submission', 'application_link_id', v_link.id)",
    );
    expect(code(hunk)).not.toMatch(/\bsource\b|consent_source|consents|status/);
  });

  it('no hunk adds a status, a handler, a lock or a clock read', () => {
    for (const [tag, hunk] of Object.entries({ ...ADMIT.hunks, ...ENSURE.hunks })) {
      expect(hunk, tag).not.toMatch(/'status'/);
      expect(hunk, tag).not.toMatch(/exception/i);
      expect(code(hunk), tag).not.toMatch(/pg_advisory|for update|raise\b/);
      expect(code(hunk), tag).not.toMatch(MACHINE_CLOCK);
    }
  });
});

describe('0130 §3 — admit keeps its vocabulary and its lock order', () => {
  it('the status vocabulary is unchanged (29 statuses, as 0114)', () => {
    expect(functionStatuses('admit_phone_attempt').size).toBe(29);
    expect(statusLiterals(ADMIT_0130)).toEqual(statusLiterals(ADMIT_0114));
  });

  it('LOCK 1 is still the first statement and no exception handler precedes the halt read', () => {
    const src = code(ADMIT_0130);
    const begin = src.indexOf('\nbegin\n');
    const first = src.slice(begin + '\nbegin\n'.length).trimStart();
    expect(first.startsWith("perform pg_advisory_xact_lock(hashtext('phone_admission'));")).toBe(true);
    const halt = src.indexOf('from screening_v2.phone_control');
    expect(halt).toBeGreaterThan(-1);
    expect(src.slice(0, halt)).not.toMatch(/\bexception\b/);
  });

  it('0130 adds the word exception nowhere in §3: every occurrence is lifted 0114 text', () => {
    const count = (s: string) => s.split(/exception/i).length - 1;
    expect(count(ADMIT_0114)).toBeGreaterThan(0);
    expect(count(ADMIT_0130)).toBe(count(ADMIT_0114));
    expect(count(section(3).replace(ADMIT_0130, ''))).toBe(0);
  });
});

describe('0130 — signatures, grants and comments', () => {
  for (const { name, sig } of LIFTED) {
    it(`${name}: the 0114 signature, revoke/grant and comment are restated`, () => {
      expect(header(bodyIn(M0130, name))).toBe(header(bodyIn(M0114, name)));
      const grants =
        `revoke all on function screening_v2.${name}(${sig})\n  from public, anon, authenticated;\n` +
        `grant execute on function screening_v2.${name}(${sig})\n  to service_role;\n`;
      expect(M0114).toContain(grants);
      expect(M0130).toContain(grants);
      // The 0114 comment, with one 0130 sentence before its closing posture.
      const restated = commentText(M0130, name).replace(
        /0130 \(M017, ADR-0018\): .*?(?=Service-role-only\.$)/,
        '',
      );
      expect(restated).toBe(commentText(M0114, name));
      expect(commentText(M0130, name)).toContain('0130 (M017, ADR-0018): ');
    });
  }

  for (const { name, section: n, sig } of DECLARED) {
    it(`${name}: SECURITY DEFINER, pinned search_path, service_role-only, commented`, () => {
      const s = section(n);
      expect(bodyIn(M0130, name)).toMatch(/\nsecurity definer\nset search_path = pg_catalog, screening_v2\nas \$\$/);
      expect(s).toContain(`revoke all on function screening_v2.${name}(${sig})\n  from public, anon, authenticated;`);
      expect(s).toContain(`grant execute on function screening_v2.${name}(${sig})\n  to service_role;`);
      expect(s).not.toMatch(
        new RegExp(`grant execute on function screening_v2\\.${name}[^;]*to (?:anon|authenticated|public)`),
      );
      expect(s).toContain(`comment on function screening_v2.${name} is`);
    });
  }
});

describe('0130 — no machine clock and no catch-all handler', () => {
  for (const { name } of DECLARED) {
    it(`${name}: no machine-clock read in the body`, () => {
      expect(code(bodyIn(M0130, name))).not.toMatch(MACHINE_CLOCK);
    });
  }

  it('the only now() in the code is the signature default admit and ensure keep from 0114', () => {
    expect(M0130.replace(/--[^\n]*/g, '').match(/now\(\)/g)).toHaveLength(2);
    for (const { name } of LIFTED) {
      expect(header(bodyIn(M0130, name)), name).toMatch(/p_now\s+timestamptz default now\(\)\n\)/);
    }
    expect(code(M0130)).not.toMatch(MACHINE_CLOCK);
  });

  it('no `when others` anywhere in the code', () => {
    expect(code(M0130)).not.toMatch(/when\s+others/i);
  });
});

describe('0130 — phone_parsing is new in 0130', () => {
  it('no earlier migration mentions phone_parsing', { timeout: 60_000 }, () => {
    const earlier = readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f) && Number(f.slice(0, 4)) < 130)
      .sort();
    expect(earlier.length).toBeGreaterThan(0);
    const mentioning = earlier.filter((f) => readFileSync(MIGRATIONS_DIR + f, 'utf8').includes('phone_parsing'));
    expect(mentioning).toEqual([]);
    expect(M0130).toContain('phone_parsing');
  });
});

describe('0130 — the drift check names the 0130 text', () => {
  for (const { name, sig } of DECLARED) {
    it(`${name}: one check, whose signature is the 0130 revoke/grant signature and whose token is in the body`, () => {
      const checks = driftChecks().filter((c) => c.signature.startsWith(`screening_v2.${name}(`));
      expect(checks).toHaveLength(1);
      expect(checks[0].signature).toBe(`screening_v2.${name}(${sig.replace(/\s+/g, '')})`);
      expect(bodyIn(M0130, name)).toContain(checks[0].token);
    });
  }
});

describe('0130 Addendum B — the second-mismatch release (B2) and the unreadable-resume fallback (B3)', () => {
  const RELEASE = bodyIn(M0130, 'release_ashby_number_after_identity_mismatch');
  const APPLY = bodyIn(M0130, 'apply_ashby_candidate_profile');
  const CLAIM = bodyIn(M0130, 'claim_ashby_profile_due');

  it('§1 adds identity_mismatch_attempt_id as a nullable uuid with no foreign key, commented', () => {
    const s1 = code(section(1));
    expect(s1).toMatch(/add column if not exists identity_mismatch_attempt_id uuid;/);
    expect(s1).not.toMatch(/identity_mismatch_attempt_id[^,;]*references/);
    expect(section(1)).toContain(
      'comment on column screening_v2.ashby_application_links.identity_mismatch_attempt_id is',
    );
  });

  it('§7 answers released, first_mismatch_retry, not_applicable, not_found and invalid_request only', () => {
    expect(statusLiterals(RELEASE)).toEqual(
      new Set(['invalid_request', 'not_found', 'not_applicable', 'first_mismatch_retry', 'released']),
    );
  });

  it('§7 keeps the lock order and decides the mismatch count only after every guard', () => {
    const src = code(RELEASE);
    const at = (s: string) => {
      const i = src.indexOf(s);
      expect(i, s).toBeGreaterThan(-1);
      return i;
    };
    const advisory = at("hashtext('ashby_phone_engagement')");
    const link = at('from screening_v2.ashby_application_links\n   where id = v_link_id');
    const eng = at('from screening_v2.phone_engagements\n   where id = v_eng_id\n   for update');
    const cand = at('from screening_v2.candidates\n   where id = v_eng.candidate_id\n   for update');
    const verified = at('from screening_v2.phone_number_verifications');
    const replay = at('if v_link.identity_mismatch_attempt_id = p_attempt_id then');
    const record = at('set identity_mismatch_attempt_id = p_attempt_id');
    const clear = at('set phone_e164 = null, phone_valid = false');
    const cancel = at("set state = 'cancelled', state_reason = 'identity_unconfirmed'");
    expect(advisory).toBeLessThan(link);
    expect(link).toBeLessThan(eng);
    expect(eng).toBeLessThan(cand);
    expect(cand).toBeLessThan(verified);
    expect(verified).toBeLessThan(replay);
    expect(replay).toBeLessThan(record);
    expect(record).toBeLessThan(clear);
    expect(clear).toBeLessThan(cancel);
    // A recorded mismatch counts only for this engagement, on the number now applied.
    expect(src).toContain('and m.engagement_id = v_eng.id');
    expect(src).toContain('and m.admitted_at >= v_candidate.ashby_phone_applied_at');
  });

  it('§5 step 9 lets phone_parsing through a handle only when its ingestion rests in failed_review', () => {
    expect(code(APPLY)).toContain(
      [
        '    if (v_link.external_resume_file_handle is not null',
        "        or (v_ing_state is not null and v_ing_state <> 'queued'))",
        '       and not (v_link.external_resume_file_handle is not null',
        "                and v_ing_state is not distinct from 'failed_review') then",
      ].join('\n'),
    );
  });

  it('§6 has arm C: a link with a handle whose ingestion rested in failed_review, stamped or not', () => {
    const src = code(CLAIM);
    expect(src).toContain(
      "(l.intake_type in ('resume_parsing', 'phone_parsing')\n          and l.external_resume_file_handle is not null",
    );
    expect(src).toContain(
      "and i.state = 'failed_review'\n                         and i.updated_at <= p_now - make_interval(secs => p_min_age_seconds))",
    );
    // Arms B and C share the "no engagement past pending_prereqs" rule.
    expect(src.split("(e.terminal_at is not null or e.state <> 'pending_prereqs')").length - 1).toBe(2);
    expect(src).toContain('for update of l skip locked');
  });
});

describe('0130 §5-§7 — answers carry codes, never contact data', () => {
  it('no returned key in the new RPCs names a contact datum', () => {
    const keys: string[] = [];
    for (const n of [5, 6, 7]) {
      for (const m of code(section(n)).matchAll(/jsonb_build_object\(([^()]*)\)/g)) {
        const args = m[1].split(',').map((a) => a.trim());
        keys.push(...args.filter((_a, i) => i % 2 === 0));
      }
    }
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key).toMatch(/^'[a-z_]+'$/);
      expect(key).not.toMatch(/phone|email|contact|name/);
    }
  });
});
