/**
 * The TypeScript callers and the 0122 SQL functions agree on argument names, and the TS
 * handling covers every status the SQL can answer. A rename on either side fails here, in
 * `npm test`, instead of at runtime against a real database.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runR1Assessment } from '../services/r1-assessment.js';
import { createR1Runtime } from '../lib/r1/runtime.js';
import { Queue } from '../lib/queue/index.js';
import { MemoryAdapter } from '../lib/queue/memory-adapter.js';
import {
  SESSION_ID,
  ROUND_ID,
  baseTables,
  createFakeDb,
  happyRpc,
} from './support/r1-fake-db.js';
import { cleanLogRows, interviewRows, modelAnswer } from './support/r1-scorer.js';
import { R1_METRICS } from '../lib/r1/rubric.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(
  path.resolve(here, '../../../supabase/migrations/0122_r1_scorer.sql'),
  'utf8',
).replace(/\r\n/g, '\n');

interface SqlParam { name: string; hasDefault: boolean }

function sqlParams(fn: string): SqlParam[] {
  const start = SQL.indexOf(`create or replace function screening_v2.${fn}(`);
  expect(start, fn).toBeGreaterThan(-1);
  const open = SQL.indexOf('(', start);
  const close = SQL.indexOf('\n)\nreturns', open);
  return SQL.slice(open + 1, close)
    .split(/,\s*\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({ name: line.split(/\s+/)[0] as string, hasDefault: /\bdefault\b/.test(line) }));
}

function expectArgsMatch(fn: string, args: Record<string, unknown>): void {
  const params = sqlParams(fn);
  const names = params.map((param) => param.name);
  // No unknown argument (PostgREST would answer PGRST202) ...
  for (const key of Object.keys(args)) expect(names, `${fn}: ${key}`).toContain(key);
  // ... and every parameter without a default is supplied.
  for (const param of params) {
    if (!param.hasDefault) expect(Object.keys(args), `${fn}: ${param.name}`).toContain(param.name);
  }
}

const rows = interviewRows();
const allScores = (score: number) => Object.fromEntries(R1_METRICS.map((metric) => [metric.key, score]));

describe('RPC argument contract', () => {
  it('the scorer service calls r1_attach_assessment and r1_apply_status_effect with the SQL parameter names', async () => {
    const tables = baseTables();
    tables.transcript_turns = rows.map((row) => ({ ...row, session_id: SESSION_ID, is_gate: false }));
    tables.r1_admin_log = cleanLogRows().map((row) => ({ ...row, session_id: SESSION_ID, round_id: ROUND_ID }));
    const db = createFakeDb(tables, happyRpc());
    await runR1Assessment(SESSION_ID, {
      client: db.client,
      infer: async () => modelAnswer(rows, allScores(3)),
    });
    expectArgsMatch('r1_attach_assessment', db.rpcCalls[0]!.args);
    expectArgsMatch('r1_apply_status_effect', db.rpcCalls[1]!.args);
    expect(sqlParams('r1_attach_assessment').map((p) => p.name)).toEqual(Object.keys(db.rpcCalls[0]!.args));
    expect(sqlParams('r1_apply_status_effect').map((p) => p.name)).toEqual(Object.keys(db.rpcCalls[1]!.args));
  });

  it('the status loop calls r1_apply_due_pending_rejects with the SQL parameter names', async () => {
    const db = createFakeDb(baseTables(), () => ({ data: 0 }));
    const queue = new Queue(new MemoryAdapter());
    const runtime = createR1Runtime({
      config: { enabled: true, status: 'enabled' },
      client: db.client as never,
      queue,
    })!;
    await runtime.tickAll();
    await runtime.runner.stop();
    expectArgsMatch('r1_apply_due_pending_rejects', db.rpcCalls[0]!.args);
  });

  it('the cancel route calls r1_cancel_pending_reject with the SQL parameter names', () => {
    const route = readFileSync(path.resolve(here, '../routes/r1.ts'), 'utf8');
    const call = /rpc\('r1_cancel_pending_reject', \{([^}]*)\}\)/.exec(route)!;
    const keys = [...call[1]!.matchAll(/(p_\w+):/g)].map((match) => match[1] as string);
    expectArgsMatch('r1_cancel_pending_reject', Object.fromEntries(keys.map((key) => [key, 1])));
  });

  it('parses the SQL signatures it relies on', () => {
    expect(sqlParams('r1_attach_assessment').map((p) => p.name)).toEqual([
      'p_round_id', 'p_session_id', 'p_assessment_id', 'p_recommendation', 'p_overall', 'p_valid', 'p_audit', 'p_now',
    ]);
    expect(sqlParams('r1_check_override_rate').filter((p) => !p.hasDefault)).toEqual([]);
  });
});

describe('status vocabulary contract', () => {
  function statusesOf(fn: string): string[] {
    const start = SQL.indexOf(`create or replace function screening_v2.${fn}(`);
    const body = SQL.slice(start, SQL.indexOf('\n$$;', start));
    return [...new Set([...body.matchAll(/jsonb_build_object\('status', '(\w+)'/g)].map((match) => match[1] as string))];
  }

  it('every status r1_attach_assessment can answer is handled (ok and superseded_by_newer, the rest fail closed)', () => {
    expect(statusesOf('r1_attach_assessment').sort()).toEqual([
      'assessment_not_for_session', 'ok', 'round_not_found', 'session_not_in_round',
      'settings_missing', 'superseded_by_newer',
    ]);
    const service = readFileSync(path.resolve(here, '../services/r1-assessment.ts'), 'utf8');
    expect(service).toContain("attachStatus === 'superseded_by_newer'");
    expect(service).toContain("attachStatus !== 'ok'");
  });

  it('every status r1_apply_status_effect can answer is handled (ok, already_applied, superseded; the rest fail closed)', () => {
    expect(statusesOf('r1_apply_status_effect').sort()).toEqual([
      'already_applied', 'ok', 'recommendation_mismatch', 'round_not_found', 'settings_missing', 'superseded',
    ]);
    const service = readFileSync(path.resolve(here, '../services/r1-assessment.ts'), 'utf8');
    for (const handled of ["appliedStatus === 'ok'", "appliedStatus === 'already_applied'", "appliedStatus === 'superseded'"]) {
      expect(service).toContain(handled);
    }
  });

  it('every status r1_cancel_pending_reject can answer maps to a route response', () => {
    expect(statusesOf('r1_cancel_pending_reject').sort()).toEqual([
      'actor_required', 'not_pending', 'ok', 'round_not_found', 'settings_missing',
    ]);
    const route = readFileSync(path.resolve(here, '../routes/r1.ts'), 'utf8');
    expect(route).toContain("data?.status === 'not_pending'");
    expect(route).toContain("data?.status !== 'ok'");
  });

  it('the status_write values the SQL can write are the CHECK vocabulary', () => {
    const check = /status_write is null or status_write in \(([\s\S]*?)\)\)/.exec(SQL)![1]!;
    const allowed = new Set([...check.matchAll(/'(\w+)'/g)].map((match) => match[1]));
    const written = new Set([
      ...[...SQL.matchAll(/v_write := '(\w+)'/g)].map((match) => match[1]),
      ...[...SQL.matchAll(/status_write = '(\w+)'(?=,|\n\s+where)/g)].map((match) => match[1]),
    ]);
    for (const value of written) expect(allowed, String(value)).toContain(value);
  });
});
