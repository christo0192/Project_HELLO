/**
 * 0114 §4 (C3, M009/S03 task S4) — the assessment evidence gate's SQL half.
 *
 * The behaviour (backfill grades per seeded production shape, the candidate
 * repair and its guards, CHECK refusals, idempotency) is proven against a
 * real Postgres in policy_tests.sql block 0114-§4. These tests pin what that
 * suite cannot see: that the SQL mirrors app/api/src/lib/scorecards/evidence.ts
 * BY NAME — the same closed vocabularies and the same two thresholds — so a
 * change on one side without the other turns red here, and the section's
 * posture (grants, search_path, no machine clock, phone-only, the audit
 * shape, the only DML of the file).
 */
import { describe, it, expect } from 'vitest';

import { MIGRATION_0114 } from './support/phone-migration.js';
import {
  ANSWERED_DISPOSITIONS,
  AUTO_REJECT_MIN,
  EVIDENCE_COLUMN_NAMES,
  EVIDENCE_GRADES,
  EVIDENCE_REASONS,
  INFRA_DISCONNECT_REASON,
  PARTIAL_DECISION,
} from '../lib/scorecards/evidence.js';

const lf = (s: string) => s.replace(/\r\n/g, '\n');
const SQL = lf(MIGRATION_0114);

function section(n: number): string {
  const begin = `-- ==== 0114 §${n} BEGIN ====`;
  const end = `-- ==== 0114 §${n} END ====`;
  const b = SQL.indexOf(begin);
  const e = SQL.indexOf(end);
  if (b === -1 || e === -1 || e < b) throw new Error(`0114 §${n} markers missing or inverted`);
  return SQL.slice(b + begin.length, e);
}

const S4 = section(4);
/** §4 with line comments removed — for code assertions. */
const CODE = S4.replace(/--[^\n]*/g, '');

function fnBody(name: string): string {
  const anchor = `create or replace function screening_v2.${name}(`;
  const start = CODE.indexOf(anchor);
  if (start === -1) throw new Error(`§4 does not declare ${name}`);
  const open = CODE.indexOf('$$', start);
  const close = CODE.indexOf('$$;', open + 2);
  if (open === -1 || close === -1) throw new Error(`${name}: body not delimited`);
  return CODE.slice(start, close + 3);
}

function quotedList(re: RegExp): string[] {
  const m = CODE.match(re);
  if (!m) throw new Error(`list not found: ${re}`);
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
}

describe('0114 §4 — columns, CHECKs and index', () => {
  it('adds exactly the four nullable evidence columns evidence.ts writes', () => {
    const added = [...CODE.matchAll(/add column if not exists (evidence_\w+) (\w+)/g)].map((m) => m[1]);
    expect(added).toEqual([...EVIDENCE_COLUMN_NAMES]);
    expect(CODE).not.toMatch(/add column if not exists evidence_\w+ \w+ (?:not null|default)/);
    expect(CODE).not.toMatch(/alter column evidence_\w+ set (?:not null|default)/);
  });

  it('the grade and reason CHECKs are exactly EVIDENCE_GRADES / EVIDENCE_REASONS', () => {
    expect(quotedList(/chk_assessments_evidence_grade check \(\s*evidence_grade is null or evidence_grade in \(([^)]*)\)/))
      .toEqual([...EVIDENCE_GRADES]);
    expect(quotedList(/chk_assessments_evidence_reason check \(\s*evidence_reason is null or evidence_reason in \(([^)]*)\)/))
      .toEqual([...EVIDENCE_REASONS]);
  });

  it('every CHECK is dropped-if-exists, added NOT VALID, then VALIDATED', () => {
    for (const name of [
      'chk_assessments_evidence_grade',
      'chk_assessments_evidence_reason',
      'chk_assessments_evidence_shape',
      'chk_assessments_evidence_counts',
    ]) {
      const drop = CODE.indexOf(`drop constraint if exists ${name};`);
      const add = CODE.indexOf(`add constraint ${name} check (`);
      const validate = CODE.indexOf(`validate constraint ${name};`);
      expect(drop, name).toBeGreaterThan(-1);
      expect(add, name).toBeGreaterThan(drop);
      expect(validate, name).toBeGreaterThan(add);
      expect(CODE.slice(add, validate), name).toMatch(/\) not valid;/);
    }
  });

  it('the coherence CHECK cannot evaluate to NULL (CASE + coalesce, else false)', () => {
    const m = CODE.match(/add constraint chk_assessments_evidence_shape check \(([\s\S]*?)\) not valid;/);
    expect(m).not.toBeNull();
    const body = m![1];
    expect(body).toMatch(/\bcase\b/);
    expect(body).toMatch(/else false/);
    expect([...body.matchAll(/coalesce\(evidence_reason in/g)]).toHaveLength(2);
  });

  it('creates the partial index idx_assessments_evidence_insufficient', () => {
    expect(CODE).toMatch(
      /create index if not exists idx_assessments_evidence_insufficient\s+on screening_v2\.assessments \([^)]*\)\s+where evidence_grade = 'insufficient';/,
    );
  });
});

describe('0114 §4 — the backfill mirrors gradeEvidence by name', () => {
  const body = fnBody('backfill_assessment_evidence_grades');

  it('uses PARTIAL_DECISION as `answered * den >= planned * num`', () => {
    const want = `m.answer_count * ${PARTIAL_DECISION.den} >= m.planned * ${PARTIAL_DECISION.num}`;
    // Once for the grade, once for the reason — the two CASEs must agree.
    expect(body.split(want).length - 1).toBe(2);
    // ...and no other threshold comparison hides beside them.
    expect([...body.matchAll(/answer_count \* \d+ >= m\.planned \* \d+/g)]).toHaveLength(2);
  });

  it('counts exactly ANSWERED_DISPOSITIONS and keys infra on INFRA_DISCONNECT_REASON', () => {
    expect(quotedList(/r\.disposition in \(([^)]*)\)/)).toEqual([...ANSWERED_DISPOSITIONS]);
    expect(body.split(`m.disconnect = '${INFRA_DISCONNECT_REASON}'`).length - 1).toBe(2);
  });

  it('reads non-gate, non-bot turns, the plan count and the progress rows', () => {
    expect(body).toMatch(/t\.is_gate = false/);
    expect(body).toMatch(/t\.speaker <> 'bot'/);
    expect(body).toMatch(/from screening_v2\.phone_session_plans p/);
    expect(body).toMatch(/r\.disposition is null/);
  });

  it('grades PHONE rows that are still ungraded, and nothing else', () => {
    expect(body).toMatch(/a2\.source = 'phone'\s+and a2\.evidence_grade is null/);
    expect(body).toMatch(/a\.source = 'phone'\s+and a\.evidence_grade is null;/);
  });
});

describe('0114 §4 — the candidate repair', () => {
  const body = fnBody('repair_evidence_gated_candidate_status');

  it('uses AUTO_REJECT_MIN as `answered * den >= planned * num`', () => {
    expect(body).toContain(
      `l.evidence_answered * ${AUTO_REJECT_MIN.den} >= l.evidence_planned * ${AUTO_REJECT_MIN.num}`,
    );
  });

  it('carries the blocked, human-audit, latest-assessment and auto-reject guards', () => {
    expect(body).toMatch(/distinct on \(a\.candidate_id\)/);
    expect(body).toMatch(/order by a\.candidate_id, a\.created_at desc, a\.revision desc, a\.id desc/);
    expect(body).toMatch(/c\.status = 'rejected'/);
    expect(body.split('decision_use_blocked_at is null').length - 1).toBe(2);
    expect(body).toMatch(/l\.source = 'phone'/);
    expect(body).toMatch(/l\.recommendation = 'reject'/);
    expect(body).toMatch(/l\.scoring_status = 'complete'/);
    expect(body).toMatch(/ae\.actor_type <> 'system'/);
    expect(body).toMatch(/ae\.created_at >= l\.created_at/);
    expect(body).toMatch(/set status = 'screened'/);
    expect(body).toMatch(/returning c\.id/);
  });

  it('writes one system candidate_status_changed audit per reverted id with the stated metadata only', () => {
    expect(body).toMatch(/'00000000-0000-0000-0000-000000000000'::uuid, 'system',\s+'candidate_status_changed', 'candidate', r\.id::text, 'success'/);
    const meta = body.match(/jsonb_build_object\(([^)]*)\)/);
    expect(meta).not.toBeNull();
    const keys = [...meta![1].matchAll(/'([a-z_0-9]+)'/g)].map((m) => m[1]);
    expect(keys).toEqual(['from', 'rejected', 'to', 'screened', 'reason', 'evidence_gate', 'migration', '0114']);
    expect(body).toMatch(/from reverted r;/);
  });

  it('returns counts only — no candidate ids, names, emails or phones', () => {
    expect(body).toMatch(/return jsonb_build_object\('status', 'ok', 'reverted', v_n\);/);
    expect(body).not.toMatch(/\b(email|phone_e164|name)\b/);
  });
});

describe('0114 §4 — posture', () => {
  const FNS = [
    ['backfill_assessment_evidence_grades', ''],
    ['repair_evidence_gated_candidate_status', 'uuid[], timestamptz'],
  ] as const;

  it('both functions pin search_path and are service_role-only', () => {
    for (const [name, sig] of FNS) {
      expect(fnBody(name), name).toMatch(/set search_path = pg_catalog, screening_v2/);
      expect(CODE).toContain(`revoke all on function screening_v2.${name}(${sig})\n  from public, anon, authenticated;`);
      expect(CODE).toContain(`grant execute on function screening_v2.${name}(${sig})\n  to service_role;`);
      expect(CODE).not.toMatch(new RegExp(`grant execute on function screening_v2\\.${name}[^;]*to (?:anon|authenticated|public)`));
    }
  });

  it('reads no machine clock (p_now default aside) and spells timestamptz', () => {
    const code = CODE.replace('p_now           timestamptz default now()', '');
    expect(code).not.toMatch(
      /\b(now|clock_timestamp|statement_timestamp|transaction_timestamp|timeofday)\s*\(|\bcurrent_(timestamp|date|time)\b|\blocaltimestamp\b/i,
    );
    expect(CODE).not.toMatch(/\btimestamp with time zone\b/);
  });

  it('runs the backfill BEFORE the repair, once, in a DO block', () => {
    const run = CODE.slice(CODE.lastIndexOf('do $$'));
    const b = run.indexOf('screening_v2.backfill_assessment_evidence_grades()');
    const r = run.indexOf('screening_v2.repair_evidence_gated_candidate_status(null)');
    expect(b).toBeGreaterThan(-1);
    expect(r).toBeGreaterThan(b);
  });

  it('touches only assessments, candidates and audit_events (no phone lifecycle table)', () => {
    const writes = [...CODE.matchAll(/\b(?:update|insert into|delete from)\s+screening_v2\.(\w+)/g)].map((m) => m[1]);
    expect(new Set(writes)).toEqual(new Set(['assessments', 'candidates', 'audit_events']));
  });
});
