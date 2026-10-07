/**
 * 0125 §5 (M013 S02, T06) — the zero-answer relabel, asserted against the
 * migration TEXT.
 *
 * enforce_phone_engagement_transition is LIFTED from 0114 §2 (0045 plus the
 * 0114 C2 late-score hunk). The phone-0114-ledger pins read the NEWEST
 * declaration, so the core assertion is a structural diff: remove the one
 * marked 0125 hunk and what is left must be BYTE-IDENTICAL to the 0114 body.
 * relabel_zero_answer_phone_engagement is new; its contract (parameters,
 * answers) is pinned against rpc-contract.ts, and what it must never do is
 * pinned against its body.
 *
 * Behaviour is proven on real Postgres: app/supabase/tests/
 * phone_0125_relabel.sql (scripts/test-phone-0125.sh). Text is not execution.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PHONE_PROGRESS_REASON_ALLOWLIST } from '../lib/candidate-phone-progress.js';
import {
  PHONE_RELABEL_RPC_PARAMETERS,
  RELABEL_ZERO_ANSWER_PHONE_ENGAGEMENT_STATUSES,
  SCREENING_ABANDONED_REASON,
} from '../lib/phone-screening/rpc-contract.js';
import {
  MIGRATION_0114,
  MIGRATION_0125,
  PHONE_MIGRATIONS,
  functionBody,
  functionStatuses,
} from './support/phone-migration.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const lf = (s: string) => s.replace(/\r\n/g, '\n');
const read = (rel: string) => lf(readFileSync(path.join(REPO, rel), 'utf8'));

const M0114 = lf(MIGRATION_0114);
const M0125 = lf(MIGRATION_0125);
const TRG = 'enforce_phone_engagement_transition';
const RPC = 'relabel_zero_answer_phone_engagement';

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

/** Remove every marked hunk of one migration; returns the residue and the hunks. */
function stripHunks(body: string, n: string): { residue: string; tags: string[]; hunks: Record<string, string> } {
  const tags: string[] = [];
  const hunks: Record<string, string> = {};
  const re = new RegExp(`^[ \\t]*-- ▼ ${n} ([^\\n]+)\\n([\\s\\S]*?)^[ \\t]*-- ▲ ${n} ([^\\n]+)\\n`, 'gm');
  const residue = body.replace(re, (_m, open: string, inner: string, close: string) => {
    if (open !== close) throw new Error(`hunk ${open} closed as ${close}`);
    tags.push(open);
    hunks[open] = inner;
    return '';
  });
  if (new RegExp(`▼ ${n}|▲ ${n}`).test(residue)) throw new Error(`unbalanced ${n} hunk marker`);
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
  const begin = `-- ==== 0125 §${n} BEGIN ====`;
  const end = `-- ==== 0125 §${n} END ====`;
  const b = M0125.indexOf(begin);
  const e = M0125.indexOf(end);
  if (b === -1 || e === -1 || e < b) throw new Error(`0125 §${n} markers missing`);
  return M0125.slice(b, e + end.length);
}

const TRG_0114 = bodyIn(M0114, TRG);
const TRG_0125 = bodyIn(M0125, TRG);
const T = stripHunks(TRG_0125, '0125');
const HUNK = T.hunks['S02-4 zero-answer relabel'] ?? '';
const RPC_BODY = bodyIn(M0125, RPC);
const S5 = section(5);

describe('0125 §5 — ownership and placement', () => {
  it('declares the trigger function and the RPC exactly once in 0125, inside §5', () => {
    for (const name of [TRG, RPC]) {
      expect(M0125.split(`create or replace function screening_v2.${name}(`).length - 1, name).toBe(1);
      expect(S5, name).toContain(`create or replace function screening_v2.${name}(`);
    }
    // The 0042 binding is not re-created; only the body changes.
    expect(S5).not.toMatch(/create trigger/i);
  });

  it('0125 is the newest registered migration, so the extractors read the 0125 bodies', () => {
    expect(PHONE_MIGRATIONS[0].name).toBe('0125');
    const resolved = functionBody(TRG);
    expect(resolved).toContain('-- ▼ 0125 S02-4 zero-answer relabel');
    // The 0114 C2 hunk the phone-0114-ledger pins read survives in it.
    expect(resolved).toContain('-- ▼ 0114 C2 late-score exception');
  });

  it('re-creates no CHECK and no audit vocabulary (0114 stays the last chk_audit_action re-creation)', () => {
    expect(S5).not.toMatch(/add constraint/i);
    expect(code(M0125)).not.toMatch(/constraint\s+chk_audit_action/i);
    // The state_reason CHECK is a regex (0042); the new reason satisfies it.
    expect(SCREENING_ABANDONED_REASON).toMatch(/^[a-z0-9_.:-]{1,64}$/);
  });
});

describe('0125 §5a — the trigger differs from 0114 ONLY by the one marked hunk', () => {
  it('has exactly the one planned hunk', () => {
    expect(T.tags).toEqual(['S02-4 zero-answer relabel']);
  });

  it('is byte-identical to the 0114 body once the 0125 hunk is removed', () => {
    expect(T.residue).toBe(TRG_0114);
  });

  it('keeps the 0114 C2 late-score hunk byte-identical', () => {
    const c2 = (b: string) => stripHunks(b, '0114').hunks['C2 late-score exception'];
    expect(c2(TRG_0114)).toBeTruthy();
    expect(c2(TRG_0125)).toBe(c2(TRG_0114));
  });

  it('sits after the C2 exception and before the terminal-immutability raise', () => {
    const at = TRG_0125.indexOf('-- ▼ 0125 S02-4 zero-answer relabel');
    expect(at).toBeGreaterThan(TRG_0125.indexOf('-- ▲ 0114 C2 late-score exception'));
    expect(TRG_0125.indexOf('-- ▲ 0125 S02-4 zero-answer relabel')).toBeLessThan(
      TRG_0125.indexOf("raise exception 'phone engagement % is terminal (%) and immutable'"),
    );
  });

  it('is a relabel of exactly completed -> failed/screening_abandoned, every other column fixed', () => {
    const h = squash(HUNK);
    for (const clause of [
      'old.terminal_at is not null',
      "old.state = 'completed'",
      "new.state = 'failed'",
      "new.state_reason = 'screening_abandoned'",
      "(to_jsonb(new) - '{state,state_reason,version,updated_at}'::text[]) = " +
        "(to_jsonb(old) - '{state,state_reason,version,updated_at}'::text[])",
      'old.session_id is not null',
    ]) {
      expect(h, clause).toContain(clause);
    }
    expect(h).toContain(`new.state_reason = '${SCREENING_ABANDONED_REASON}'`);
  });

  it('the interlock: the session\'s LATEST assessment is phone / insufficient / measured 0', () => {
    const h = squash(HUNK);
    expect(h).toContain(
      'from (select a.source, a.evidence_grade, a.evidence_answered from screening_v2.assessments a ' +
        'where a.session_id = old.session_id order by a.created_at desc, a.revision desc, a.id desc limit 1) l',
    );
    expect(h).toContain("where l.source = 'phone' and l.evidence_grade = 'insufficient' and l.evidence_answered = 0)");
    // NULL never qualifies: an equality, never a coalesce.
    expect(h).not.toMatch(/coalesce\([^)]*evidence_answered/);
  });

  it('the GUC names THIS engagement, and is documented as defence in depth only', () => {
    expect(squash(HUNK)).toContain(
      "pg_catalog.current_setting('screening_v2.zero_answer_relabel', true) = old.id::text",
    );
    expect(HUNK).toContain('NOT a security boundary');
  });

  it('SECURITY INVOKER, search_path = pg_catalog: every relation is schema-qualified', () => {
    expect(TRG_0125).toContain('returns trigger\nlanguage plpgsql\nsecurity invoker\nset search_path = pg_catalog\nas $$');
    const rels = [...code(HUNK).matchAll(/\bfrom\s+([a-z0-9_.]+)/g)].map((m) => m[1]);
    expect(rels).toEqual(['screening_v2.assessments']);
  });

  it('reads no machine clock', () => {
    expect(code(HUNK)).not.toMatch(MACHINE_CLOCK);
  });

  it('restates the comment, naming both exceptions', () => {
    expect(S5).toMatch(/comment on function screening_v2\.enforce_phone_engagement_transition is[\s\S]*TWO exceptions/);
    expect(S5).toContain('completed -> failed/screening_abandoned');
  });
});

describe('0125 §5b — relabel_zero_answer_phone_engagement', () => {
  it('parameters are exactly the registered contract, in order', () => {
    const sig = RPC_BODY.slice(0, RPC_BODY.indexOf(')\nreturns'));
    const params = [...sig.matchAll(/^\s*(p_[a-z_]+)\s/gm)].map((m) => m[1]);
    expect(params).toEqual([...PHONE_RELABEL_RPC_PARAMETERS[RPC]]);
  });

  it('answers exactly the registered status vocabulary', () => {
    expect([...functionStatuses(RPC)].sort()).toEqual([...RELABEL_ZERO_ANSWER_PHONE_ENGAGEMENT_STATUSES].sort());
    // The extractor resolves the RPC to this 0125 declaration.
    expect(RPC_BODY).toContain(lf(functionBody(RPC)));
  });

  it('SECURITY DEFINER, pinned search_path, service_role-only ACL', () => {
    expect(RPC_BODY).toContain('returns jsonb\nlanguage plpgsql\nsecurity definer\nset search_path = pg_catalog, screening_v2\nas $$');
    const s5 = squash(S5);
    const sig = `screening_v2.${RPC}(uuid, uuid, timestamptz)`;
    expect(s5).toContain(`revoke all on function ${sig} from public, anon, authenticated;`);
    expect(s5).toContain(`grant execute on function ${sig} to service_role;`);
    expect(s5).not.toMatch(/grant\s+execute[^;]*\bto\s+(anon|authenticated|public)\b/i);
  });

  it('locks the engagement, re-checks the predicate the trigger checks, sets then clears the GUC', () => {
    const b = squash(RPC_BODY);
    expect(b).toContain('where id = p_engagement_id for update;');
    expect(b).toContain(
      'from screening_v2.assessments a where a.session_id = v_eng.session_id ' +
        'order by a.created_at desc, a.revision desc, a.id desc limit 1;',
    );
    expect(b).toContain("v_asm_source is distinct from 'phone'");
    expect(b).toContain("v_asm_grade is distinct from 'insufficient'");
    expect(b).toContain('v_asm_answered is distinct from 0');
    const set = b.indexOf("set_config('screening_v2.zero_answer_relabel', v_eng.id::text, true)");
    const upd = b.indexOf('update screening_v2.phone_engagements');
    const clear = b.indexOf("set_config('screening_v2.zero_answer_relabel', '', true)");
    expect(set).toBeGreaterThan(-1);
    expect(upd).toBeGreaterThan(set);
    expect(clear).toBeGreaterThan(upd);
    expect(b).toContain(
      "set state = 'failed', state_reason = 'screening_abandoned', version = version + 1, updated_at = p_now",
    );
  });

  it('moves the candidate ONLY screened -> screening, under the 0114 §4e guards; never queued', () => {
    const b = squash(RPC_BODY);
    expect(b).toContain(
      "update screening_v2.candidates c set status = 'screening' where c.id = v_asm_cand and c.status = 'screened' " +
        'and c.decision_use_blocked_at is null',
    );
    expect(b).toContain('order by l.created_at desc, l.revision desc, l.id desc limit 1) = v_asm_id');
    expect(b).toContain("and ae.actor_type <> 'system' and ae.created_at >= v_asm_at");
    expect(code(RPC_BODY)).not.toMatch(/'queued'/);
    expect((code(RPC_BODY).match(/update screening_v2\.candidates/g) ?? []).length).toBe(1);
  });

  it('audits with EXISTING actions only, metadata {from,to,reason,migration} and no PII', () => {
    const b = code(RPC_BODY);
    const actions = [...b.matchAll(/'(screening_failed|candidate_status_changed|[a-z_]+)', '(phone_engagement|candidate)'/g)]
      .map((m) => m[1]);
    expect(actions).toEqual(['screening_failed', 'candidate_status_changed']);
    // Both are members of the 0114 chk_audit_action list.
    const chk = M0114.slice(M0114.indexOf('add constraint chk_audit_action check ('));
    for (const a of actions) expect(chk.slice(0, chk.indexOf(') not valid;'))).toContain(`'${a}'`);
    expect((b.match(/'reason', 'screening_abandoned', 'migration', '0125'/g) ?? []).length).toBe(2);
    expect(b).not.toMatch(/phone_e164|\bemail\b|\bname\b|external_call_id|room_name/);
  });

  it('never requeues, rescreens, dials, enqueues or touches the Ashby link', () => {
    const b = code(RPC_BODY);
    for (const forbidden of [
      /insert into screening_v2\.phone_call_attempts/,
      /insert into screening_v2\.phone_call_events/,
      /screening_v2\.job_queue/,
      /screening_v2\.phone_rescreen_requests/,
      /request_phone_rescreen/,
      /ensure_ashby_phone_engagement/,
      /ashby_application_links/,
      /next_eligible_at/,
      /terminal_at\s*=/,
    ]) {
      expect(b, String(forbidden)).not.toMatch(forbidden);
    }
    // The only writes: the engagement relabel, the candidate, two audits.
    expect([...b.matchAll(/\b(insert into|update)\s+screening_v2\.([a-z_]+)/g)].map((m) => `${m[1]} ${m[2]}`)).toEqual([
      'update phone_engagements',
      'insert into audit_events',
      'update candidates',
      'insert into audit_events',
    ]);
  });

  it('reads no machine clock (p_now only)', () => {
    expect(code(RPC_BODY)).not.toMatch(MACHINE_CLOCK);
  });
});

describe('0125 §5c — the stranded sweep converges the relabel in SQL', () => {
  const SWP = 'sweep_phone_stranded_sessions';
  const SWP_0114 = bodyIn(M0114, SWP);
  const SWP_0125 = bodyIn(M0125, SWP);
  const S = stripHunks(SWP_0125, '0125');

  it('is declared once in 0125, inside §5, and is what the extractors resolve', () => {
    expect(M0125.split(`create or replace function screening_v2.${SWP}(`).length - 1).toBe(1);
    expect(S5).toContain(`create or replace function screening_v2.${SWP}(`);
    expect(lf(functionBody(SWP))).toContain('-- ▼ 0125 S02-4 converge stranded');
  });

  it('has exactly the planned hunks, in order', () => {
    expect(S.tags).toEqual([
      'S02-4 converge declare',
      'S02-4 converge stranded',
      'S02-4 converge late',
      'S02-4 converge keys',
    ]);
  });

  it('is byte-identical to the 0114 body once the 0125 hunks are removed', () => {
    expect(S.residue).toBe(SWP_0114);
  });

  it('relabels right after the stranded completion, only for a scored session', () => {
    const h = squash(S.hunks['S02-4 converge stranded'] ?? '');
    expect(h.startsWith('if v_row.scored then begin v_relabel := screening_v2.relabel_zero_answer_phone_engagement( v_row.id,')).toBe(true);
    expect(h).toContain("'00000000-0000-0000-0000-000000000000'::uuid, p_now);");
    expect(h).toContain('exception when others then v_zero_relabel_errors := v_zero_relabel_errors + 1;');
    // Placed after the completed/failed counters of the stranded loop.
    const at = SWP_0125.indexOf('-- ▼ 0125 S02-4 converge stranded');
    expect(at).toBeGreaterThan(SWP_0125.indexOf('else v_failed := v_failed + 1;'));
    expect(at).toBeLessThan(SWP_0125.indexOf('-- ▼ 0114 C2-P5 late completion'));
  });

  it('relabels right after the C2-P5 late completion, inside its completed branch', () => {
    const h = squash(S.hunks['S02-4 converge late'] ?? '');
    expect(h).toContain('v_relabel := screening_v2.relabel_zero_answer_phone_engagement( v_late_row.id,');
    expect(h).toContain('exception when others then v_zero_relabel_errors := v_zero_relabel_errors + 1;');
    const at = SWP_0125.indexOf('-- ▼ 0125 S02-4 converge late');
    expect(at).toBeGreaterThan(SWP_0125.indexOf('v_late_completed := v_late_completed + 1;'));
    expect(at).toBeLessThan(SWP_0125.indexOf('-- ▲ 0114 C2-P5 late completion'));
  });

  it('reports both counters and reads no machine clock', () => {
    expect(squash(S.hunks['S02-4 converge keys'] ?? '')).toBe(
      "'zero_answer_relabelled', v_zero_relabelled, 'zero_answer_relabel_errors', v_zero_relabel_errors,",
    );
    for (const hunk of Object.values(S.hunks)) expect(code(hunk)).not.toMatch(MACHINE_CLOCK);
  });

  it('keeps the 0114 ACL and restates the comment', () => {
    const s5 = squash(S5);
    const sig = `screening_v2.${SWP}(integer, timestamptz, integer)`;
    expect(s5).toContain(`revoke all on function ${sig} from public, anon, authenticated;`);
    expect(s5).toContain(`grant execute on function ${sig} to service_role;`);
    expect(S5).toMatch(/comment on function screening_v2\.sweep_phone_stranded_sessions is[\s\S]*zero_answer_relabelled/);
  });

  it('the real-Postgres replay covers both late paths and the control', () => {
    const sql = read('app/supabase/tests/phone_0125_relabel.sql');
    for (const marker of [
      "fin_chain('cv-stranded'",
      "fin_chain('cv-answered'",
      "fin_chain('cv-late'",
      'p115r converge stranded',
      'p115r converge answered',
      'p115r converge late',
    ]) {
      expect(sql, marker).toContain(marker);
    }
  });
});

describe('0125 §5 — vocabulary and real-Postgres wiring', () => {
  it('the API reason allowlist carries screening_abandoned', () => {
    expect(PHONE_PROGRESS_REASON_ALLOWLIST).toContain(SCREENING_ABANDONED_REASON);
  });

  it('test-phone-0125.sh replays the relabel after the finalize fixture', () => {
    const script = read('scripts/test-phone-0125.sh');
    const fin = script.indexOf('run_sql phone_0125_finalize.sql');
    const rel = script.indexOf('run_sql phone_0125_relabel.sql');
    expect(fin).toBeGreaterThan(-1);
    expect(rel).toBeGreaterThan(fin);
    expect(existsSync(path.join(REPO, 'app/supabase/tests/phone_0125_relabel.sql'))).toBe(true);
  });

  it('the replay covers every acceptance case of the plan', () => {
    const sql = read('app/supabase/tests/phone_0125_relabel.sql');
    for (const marker of [
      "select ids into v_ids from _p115.fin_ids where slug = 'replay'",
      "raise exception 'p115r replay: the candidate must be back at screening (never queued)",
      'ensure_ashby_phone_engagement(v_link',
      "v_res->>'status' <> 'already'",
      'complete_phone_engagement_after_late_score(v_eng',
      "('ans1',",
      "('ansnull',",
      "('decision',",
      'p115r refuse browser',
      'p115r refuse rescored',
      'no GUC must refuse',
      'a GUC naming another engagement must refuse',
      'another target state must refuse',
      'another reason must refuse',
      'a terminal_at change must refuse',
      'a next_eligible_at change must refuse',
      'a non-completed terminal source state must refuse',
      "('screening', 21, 'screening', false)",
      'p115r cand blocked',
      'p115r cand human',
      'p115r cand newer',
      'p115r cand operator',
      'p115r acl',
    ]) {
      expect(sql, marker).toContain(marker);
    }
  });

  it('the fixtures are synthetic: example.test emails only, no full uuid of a real case', () => {
    const sql = read('app/supabase/tests/phone_0125_relabel.sql');
    for (const m of sql.matchAll(/[\w.+-]+@[\w.-]+/g)) expect(m[0]).toMatch(/@example\.test$/);
    expect(sql).not.toMatch(/9f60523d-|32757295-|fb3d0846-/);
  });
});
