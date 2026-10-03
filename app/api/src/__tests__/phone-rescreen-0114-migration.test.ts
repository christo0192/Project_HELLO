/**
 * 0114 §7 (PR-C, S7) — request_phone_rescreen drift (C6), asserted against the
 * migration TEXT, plus the two prevention controls that ship with it.
 *
 * PR #145 edited 0057 AFTER prod applied it (it added the ensure call). Prod
 * never re-runs an applied file, so its body never evaluated a rescreen
 * child. 0114 §7 redeclares the function, LIFTED from 0057: removing every
 * marked hunk (`-- ▼ 0114 C6-<id>` … `-- ▲ 0114 C6-<id>`) and the three 0057
 * chunks the hunks replace (pinned below by exact text) must leave the 0057
 * body BYTE-IDENTICAL.
 *
 * Behaviour is proven in app/supabase/tests/policy_tests.sql (block 0114-§7,
 * C6a-C6d, and 0114-8 in block 0114-§6); text is not execution. Prod itself is
 * checked by scripts/verify-prod-function-drift.sh after every migration run.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  MIGRATION_0057,
  MIGRATION_0114,
  functionBody,
  functionStatuses,
} from './support/phone-migration.js';

const lf = (s: string) => s.replace(/\r\n/g, '\n');
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const MIGRATIONS_DIR = `${ROOT}app/supabase/migrations/`;
const M0057 = lf(MIGRATION_0057);
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

const BEGIN = '-- ==== 0114 §7 BEGIN ====';
const END = '-- ==== 0114 §7 END ====';
const SECTION = M0114.slice(M0114.indexOf(BEGIN), M0114.indexOf(END) + END.length);

const RESCREEN_0057 = bodyIn(M0057, 'request_phone_rescreen');
const RESCREEN_0114 = bodyIn(M0114, 'request_phone_rescreen');
const RESCREEN = stripHunks(RESCREEN_0114);
const CODE = code(RESCREEN_0114);

/** The ONLY 0057 text the 0114 hunks replace. */
const REPLACED_0057 = [
  // C6-replay replaces the bare replay answer.
  `    return jsonb_build_object('status', 'already_requested',
      'request_id', v_request.request_id,
      'engagement_id', v_request.new_engagement_id,
      'cycle_number', (select cycle_number from screening_v2.phone_engagements where id = v_request.new_engagement_id));
`,
  // C6-lock replaces the link row lock taken BEFORE ensure's advisory lock.
  `  select * into v_link from screening_v2.ashby_application_links
   where provider = 'ashby' and candidate_id = p_candidate_id
   order by updated_at desc, id desc limit 1 for update;
  if not found then return jsonb_build_object('status', 'application_not_found'); end if;
`,
  // C6-ensure replaces the discarded-result ensure call and the ok answer.
  `  -- Re-run the ordinary Ashby prerequisite evaluator immediately so a new
  -- cycle does not remain pending forever. It may leave the child pending
  -- with a stable reason, but it never creates an attempt or a queue job.
  perform screening_v2.ensure_ashby_phone_engagement(v_link.id, p_now);

  return jsonb_build_object('status', 'ok', 'engagement_id', v_new_id,
    'cycle_number', v_cycle, 'predecessor_engagement_id', v_prev.id);
`,
];

const STATUS_LITERAL = /'status',\s*'([a-z_]+)'/g;
const statusesIn = (body: string) => new Set([...body.matchAll(STATUS_LITERAL)].map((m) => m[1]));

describe('0114 §7 — ownership and lift source', () => {
  it('declares request_phone_rescreen exactly once in 0114, inside §7', () => {
    const decl = 'create or replace function screening_v2.request_phone_rescreen(';
    expect(M0114.split(decl).length - 1).toBe(1);
    expect(SECTION.indexOf(decl)).toBeGreaterThan(-1);
  });

  it('the lift source is the newest prior declaration (0057)', () => {
    const declaring = readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f) && f !== '0114_phone_outcome_integrity.sql')
      .sort()
      .filter((f) =>
        /function screening_v2\.request_phone_rescreen\b/.test(readFileSync(MIGRATIONS_DIR + f, 'utf8')),
      );
    expect(declaring[declaring.length - 1]).toBe('0057_phone_rescreen_cycles.sql');
  }, 30_000);

  it('the newest-first extractor now reads the 0114 body', () => {
    expect(functionBody('request_phone_rescreen')).toContain('-- ▼ 0114 C6-ensure');
  });

  it('§7 does not redeclare ensure (C8 owns it in §6) or any other function', () => {
    const decls = [...SECTION.matchAll(/create or replace function screening_v2\.(\w+)\(/g)].map((m) => m[1]);
    expect(decls).toEqual(['request_phone_rescreen']);
  });
});

describe('0114 §7 — structural diff against 0057', () => {
  it('= 0057 + the C6 hunks, minus exactly the three pinned 0057 chunks', () => {
    expect(RESCREEN.tags).toEqual(['C6-declare', 'C6-replay', 'C6-lock', 'C6-ensure']);
    let expected = RESCREEN_0057;
    for (const chunk of REPLACED_0057) expected = removeOnce(expected, chunk);
    expect(RESCREEN.residue).toBe(expected);
  });

  it('keeps the signature, SECURITY DEFINER, pinned search_path and the service_role-only ACL', () => {
    const header = RESCREEN_0114.slice(0, RESCREEN_0114.indexOf('as $$'));
    expect(header).toBe(RESCREEN_0057.slice(0, RESCREEN_0057.indexOf('as $$')));
    expect(header).toContain('security definer');
    expect(header).toContain('set search_path = pg_catalog, screening_v2');
    expect(SECTION).toContain(
      'revoke all on function screening_v2.request_phone_rescreen(uuid, text, text, text, uuid, timestamptz)\n  from public, anon, authenticated;',
    );
    expect(SECTION).toContain(
      'grant execute on function screening_v2.request_phone_rescreen(uuid, text, text, text, uuid, timestamptz)\n  to service_role;',
    );
    expect(SECTION).not.toMatch(/grant [^;]*request_phone_rescreen[^;]*to (anon|authenticated|public)/i);
  });

  it('the refusal vocabulary is unchanged (same status literals as 0057, and as the extractor reads)', () => {
    expect(statusesIn(RESCREEN_0114)).toEqual(statusesIn(RESCREEN_0057));
    expect(functionStatuses('request_phone_rescreen')).toEqual(statusesIn(RESCREEN_0057));
  });

  it('a header and the function comment cite the #145 edit-after-apply', () => {
    expect(SECTION).toMatch(/PR #145 \(98596bc\) EDITED 0057 AFTER\s+-- production had applied/);
    expect(SECTION).toMatch(/comment on function screening_v2\.request_phone_rescreen\([^)]*\) is\s+'[^;]*PR #145 edited 0057 after prod applied it/);
  });
});

describe('0114 §7 — C6 behaviour in the text', () => {
  it('calls ensure AFTER the child, request and audit inserts, and keeps its answer', () => {
    const child = CODE.indexOf('insert into screening_v2.phone_engagements');
    const request = CODE.indexOf('insert into screening_v2.phone_rescreen_requests');
    const audit = CODE.indexOf("'phone_rescreen_requested'");
    const ensure = CODE.indexOf('v_prereq := screening_v2.ensure_ashby_phone_engagement(v_link.id, p_now);');
    expect(child).toBeGreaterThan(-1);
    expect(request).toBeGreaterThan(child);
    expect(audit).toBeGreaterThan(request);
    expect(ensure).toBeGreaterThan(audit);
    expect(CODE).not.toMatch(/perform\s+screening_v2\.ensure_ashby_phone_engagement/);
  });

  it('a result naming any other engagement raises rescreen_evaluator_target_mismatch (data_exception)', () => {
    const mismatch =
      /if \(v_prereq ->> 'engagement_id'\) is distinct from (v_new_id|v_child\.id)::text then\s+raise exception 'rescreen_evaluator_target_mismatch'\s+using errcode = 'data_exception';/g;
    const hits = [...CODE.matchAll(mismatch)].map((m) => m[1]);
    expect(hits).toEqual(['v_child.id', 'v_new_id']);
  });

  it('both answers carry prerequisite_status (ensure status on the fresh path, null unless self-healed on replay)', () => {
    expect(RESCREEN.hunks['C6-ensure']).toMatch(
      /return jsonb_build_object\('status', 'ok', 'engagement_id', v_new_id,\s+'cycle_number', v_cycle, 'predecessor_engagement_id', v_prev\.id,\s+'prerequisite_status', v_prereq_status\);/,
    );
    expect(RESCREEN.hunks['C6-replay']).toMatch(
      /return jsonb_build_object\('status', 'already_requested',[\s\S]*'prerequisite_status', v_prereq_status\);/,
    );
    expect(CODE.match(/v_prereq_status := v_prereq ->> 'status';/g)).toHaveLength(2);
    // Declared without a default, so a pure-read replay answers JSON null.
    expect(RESCREEN.hunks['C6-declare']).toMatch(/^\s+v_prereq_status text;$/m);
  });

  it('the replay self-heal is strictly predicated, checked unlocked AND re-checked under the locks', () => {
    const replay = code(RESCREEN.hunks['C6-replay']);
    const predicate =
      /v_child\.terminal_at is null\s+and v_child\.state = 'pending_prereqs'\s+and not exists \(select 1 from screening_v2\.phone_engagements n\s+where n\.application_link_id = v_child\.application_link_id\s+and n\.cycle_number > v_child\.cycle_number\)/g;
    const at = [...replay.matchAll(predicate)].map((m) => m.index ?? -1);
    expect(at).toHaveLength(2);
    const lock = replay.indexOf("hashtext('ashby_phone_engagement')");
    const linkRow = replay.search(/from screening_v2\.ashby_application_links\s+where id = v_child\.application_link_id\s+for update/);
    const engRow = replay.search(/from screening_v2\.phone_engagements\s+where id = v_request\.new_engagement_id\s+for update/);
    const ensure = replay.indexOf('screening_v2.ensure_ashby_phone_engagement(');
    expect(at[0]).toBeLessThan(lock);
    expect(lock).toBeLessThan(linkRow);
    expect(linkRow).toBeLessThan(engRow);
    expect(engRow).toBeLessThan(at[1]);
    expect(at[1]).toBeLessThan(ensure);
    // The idempotency_conflict refusal still precedes any of it.
    expect(CODE.indexOf("'idempotency_conflict'")).toBeGreaterThan(-1);
    expect(CODE.indexOf("'idempotency_conflict'")).toBeLessThan(CODE.indexOf('select * into v_child'));
  });

  it('canonical lock order on the fresh path: rescreen lock, unlocked resolve, link advisory lock, link row, engagement rows, ensure', () => {
    const fresh = CODE.slice(CODE.indexOf('select * into v_candidate'));
    const rescreenLock = CODE.indexOf("hashtext('phone_rescreen')");
    const resolve = fresh.search(
      /select id into v_link_id from screening_v2\.ashby_application_links\s+where provider = 'ashby' and candidate_id = p_candidate_id\s+order by updated_at desc, id desc limit 1;/,
    );
    const advisory = fresh.indexOf("hashtext('ashby_phone_engagement')");
    const linkRow = fresh.search(/select \* into v_link from screening_v2\.ashby_application_links\s+where id = v_link_id\s+for update;/);
    const revalidate = fresh.indexOf('if v_newest_link_id is distinct from v_link_id then');
    const engRow = fresh.search(/from screening_v2\.phone_engagements\s+where application_link_id = v_link\.id\s+order by cycle_number desc, created_at desc, id desc limit 1 for update;/);
    const ensure = fresh.indexOf('screening_v2.ensure_ashby_phone_engagement(');
    expect(rescreenLock).toBeGreaterThan(-1);
    expect(rescreenLock).toBeLessThan(CODE.indexOf('select * into v_candidate'));
    for (const i of [resolve, advisory, linkRow, revalidate, engRow, ensure]) expect(i).toBeGreaterThan(-1);
    expect(resolve).toBeLessThan(advisory);
    expect(advisory).toBeLessThan(linkRow);
    expect(linkRow).toBeLessThan(revalidate);
    expect(revalidate).toBeLessThan(engRow);
    expect(engRow).toBeLessThan(ensure);
    // The inverted 0057 shape (a link row lock with no advisory lock before it) is gone.
    expect(CODE).not.toMatch(/order by updated_at desc, id desc limit 1 for update/);
    expect(RESCREEN.hunks['C6-lock']).toMatch(/raise exception 'rescreen_application_link_moved'\s+using errcode = 'serialization_failure';/);
  });

  it('creates no attempt, no queue job and no dial work (code, comments excluded)', () => {
    expect(CODE).not.toMatch(/job_queue/i);
    expect(CODE).not.toMatch(/attempt/i);
    expect(CODE).not.toMatch(/dial/i);
  });

  it('reads no machine clock: every time is p_now', () => {
    expect(CODE).not.toMatch(MACHINE_CLOCK);
  });

  it('no backfill: §7 holds no DML outside the function body', () => {
    const outside = SECTION.replace(RESCREEN_0114, '').replace(/--[^\n]*/g, '');
    expect(outside).not.toMatch(/\b(insert into|update screening_v2|delete from)\b/i);
  });
});

describe('0114 §7 — prevention controls', () => {
  const ci = lf(readFileSync(`${ROOT}.github/workflows/supabase-ci.yml`, 'utf8'));
  const deploy = lf(readFileSync(`${ROOT}.github/workflows/deploy-fly.yml`, 'utf8'));
  const driftPath = `${ROOT}scripts/verify-prod-function-drift.sh`;

  function job(yaml: string, name: string): string {
    const lines = yaml.split('\n');
    const start = lines.findIndex((l) => l === `  ${name}:`);
    if (start === -1) return '';
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[i]) || /^[A-Za-z]/.test(lines[i])) {
        end = i;
        break;
      }
    }
    return lines.slice(start, end).join('\n');
  }

  it('CI migrations-immutable: PR-only, full history, merge-base diff, fails on M/D/R/T of a migration', () => {
    const j = job(ci, 'migrations-immutable');
    expect(j).not.toBe('');
    expect(j).toMatch(/if: github\.event_name == 'pull_request'/);
    expect(j).toMatch(/fetch-depth: 0/);
    expect(j).toContain('BASE_SHA: ${{ github.event.pull_request.base.sha }}');
    expect(j).toContain('HEAD_SHA: ${{ github.event.pull_request.head.sha }}');
    expect(j).toMatch(/git diff --no-color --name-status -M --diff-filter=MDRT \\\s+"\$BASE_SHA\.\.\.\$HEAD_SHA" -- app\/supabase\/migrations\//);
    expect(j).toMatch(/if \[ -n "\$changed" \]; then[\s\S]*exit 1/);
    // Additions are allowed: the filter never names A.
    expect(j).not.toMatch(/--diff-filter=[A-Z]*A/);
  });

  it('deploy-fly runs the read-only drift check right after the production db push', () => {
    const j = job(deploy, 'migrate-production');
    const push = j.indexOf('db push --db-url "$SUPABASE_DB_URL" --include-all');
    const drift = j.indexOf('run: bash scripts/verify-prod-function-drift.sh');
    expect(push).toBeGreaterThan(-1);
    expect(drift).toBeGreaterThan(push);
    expect(j.slice(push)).toContain('SUPABASE_DB_URL: ${{ secrets.SUPABASE_DB_URL }}');
  });

  it('the drift script queries the live position of ensure in request_phone_rescreen and fails on 0', () => {
    expect(existsSync(driftPath)).toBe(true);
    const s = lf(readFileSync(driftPath, 'utf8'));
    expect(s).toContain('set -euo pipefail');
    expect(s).toContain(
      '"screening_v2.request_phone_rescreen(uuid,text,text,text,uuid,timestamptz)|ensure_ashby_phone_engagement"',
    );
    expect(s).toContain("select position('${token}' in pg_get_functiondef('${fn}'::regprocedure)) as drift_position");
    expect(s).toMatch(/db query "\$\{target\[@\]\}"/);
    expect(s).toContain('target=(--db-url "$SUPABASE_DB_URL")');
    expect(s).toContain('target=(--linked)');
    expect(s).toMatch(/elif \[ "\$pos" -eq 0 \]; then[\s\S]*failures=\$\(\(failures \+ 1\)\)/);
    expect(s).toMatch(/if \[ "\$failures" -gt 0 \]; then[\s\S]*exit 1/);
    // Read-only: no DDL/DML keyword anywhere in the script's SQL.
    expect(s).not.toMatch(/\b(insert into|update screening_v2|delete from|create or replace|alter table|drop )\b/i);
  });
});
