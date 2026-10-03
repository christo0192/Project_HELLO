/**
 * 0114 §3 (PR-C, S3) — outcome consistency: score suppression, partial
 * finalize (C2 + C7), late completion and the stranded sweep, asserted
 * against the migration TEXT.
 *
 * finalize_phone_partial_sessions and sweep_phone_stranded_sessions are
 * LIFTED by script from 0113 (the newest declarations: PR-B's E4 callback
 * flag, expired-arm skip and candidate_voice sweep guard live there). A lift
 * from an older file, or a tidy-up while lifting, silently reverts PR-B. So
 * the core assertion is a structural diff: remove every marked 0114 hunk
 * (`-- ▼ 0114 <id>` … `-- ▲ 0114 <id>`), restore the one replaced 0113 clause,
 * and what is left must be BYTE-IDENTICAL to the 0113 body.
 *
 * Behaviour is proven in app/supabase/tests/policy_tests.sql (block
 * 0114-§3); text is not execution.
 */
import { describe, it, expect } from 'vitest';

import {
  COMPLETE_PHONE_ENGAGEMENT_AFTER_LATE_SCORE_STATUSES,
  PHONE_ATTEMPT_SCORE_SUPPRESSION_RESULTS,
  PHONE_OUTCOME_RPC_PARAMETERS,
  PHONE_RPC_NAMES,
  PHONE_RPC_PARAMETERS,
} from '../lib/phone-screening/rpc-contract.js';
import { PHONE_SCORE_SUPPRESS_REASONS } from '../lib/phone-screening/vocabulary.js';
import { phoneAssessmentDedupKey, PHONE_ASSESSMENT_QUEUE } from '../lib/phone-runtime/config.js';
import {
  MIGRATION_0113,
  MIGRATION_0114,
  functionBody,
  functionParameters,
  functionStatuses,
} from './support/phone-migration.js';

const lf = (s: string) => s.replace(/\r\n/g, '\n');
const M0113 = lf(MIGRATION_0113);
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

const BEGIN = '-- ==== 0114 §3 BEGIN ====';
const END = '-- ==== 0114 §3 END ====';
const SECTION = M0114.slice(M0114.indexOf(BEGIN), M0114.indexOf(END) + END.length);

const FIN_0113 = bodyIn(M0113, 'finalize_phone_partial_sessions');
const FIN_0114 = bodyIn(M0114, 'finalize_phone_partial_sessions');
const SWP_0113 = bodyIn(M0113, 'sweep_phone_stranded_sessions');
const SWP_0114 = bodyIn(M0114, 'sweep_phone_stranded_sessions');
const SUP = bodyIn(M0114, 'phone_attempt_score_suppression');
const LATE = bodyIn(M0114, 'complete_phone_engagement_after_late_score');

/** Remove every marked hunk; returns the residue and the hunk tags, in order. */
function stripHunks(body: string): { residue: string; tags: string[]; hunks: Record<string, string> } {
  const tags: string[] = [];
  const hunks: Record<string, string> = {};
  const re = /^[ \t]*-- ▼ 0114 ([^\n]+)\n([\s\S]*?)^[ \t]*-- ▲ 0114 ([^\n]+)\n/gm;
  const residue = body.replace(re, (_m, open: string, inner: string, close: string) => {
    if (open !== close) throw new Error(`hunk ${open} closed as ${close}`);
    tags.push(open);
    hunks[open] = inner;
    return '';
  });
  if (/▼ 0114|▲ 0114/.test(residue)) throw new Error('unbalanced 0114 hunk marker');
  return { residue, tags, hunks };
}

function replaceOnce(text: string, from: string, to: string): string {
  const n = text.split(from).length - 1;
  if (n !== 1) throw new Error(`expected exactly one ${JSON.stringify(from)}, found ${n}`);
  return text.replace(from, to);
}

/** Code with comments and the signature's `default now()` removed. */
function code(body: string): string {
  return body.replace(/--[^\n]*/g, '').replace(/timestamptz\s+default now\(\)/g, 'timestamptz');
}
const MACHINE_CLOCK =
  /\b(now|clock_timestamp|statement_timestamp|transaction_timestamp|timeofday)\s*\(|\bcurrent_(timestamp|date|time)\b|\blocaltimestamp\b/i;

const FIN = stripHunks(FIN_0114);
const SWP = stripHunks(SWP_0114);

const OWNED = [
  'phone_attempt_score_suppression',
  'finalize_phone_partial_sessions',
  'complete_phone_engagement_after_late_score',
  'sweep_phone_stranded_sessions',
] as const;

describe('0114 §3 — ownership and placement', () => {
  it('declares each owned function exactly once in 0114, inside §3, in dependency order', () => {
    let last = -1;
    for (const name of OWNED) {
      const decl = `create or replace function screening_v2.${name}(`;
      expect(M0114.split(decl).length - 1, name).toBe(1);
      const at = SECTION.indexOf(decl);
      expect(at, name).toBeGreaterThan(last);
      last = at;
    }
  });

  it('the newest-first extractors now read the 0114 bodies', () => {
    expect(functionBody('finalize_phone_partial_sessions')).toContain('-- ▼ 0114 C7 withdrawn');
    expect(functionBody('sweep_phone_stranded_sessions')).toContain('-- ▼ 0114 C2-P5 late completion');
  });

  it('lifts from 0113 (PR-B E4 survives in both bodies)', () => {
    expect(FIN_0113).toContain("'callback_booked',    v_callback_booked);");
    expect(FIN_0114).toContain("'callback_booked',    v_callback_booked);");
    expect(SWP_0114).toContain("and ap.source = 'candidate_voice'");
  });
});

describe('0114 §3 — finalize differs from 0113 ONLY by the C2/C7 hunks', () => {
  it('has exactly the planned hunks, in order', () => {
    expect(FIN.tags).toEqual([
      'C2/C7 declare',
      'C2/C7 expired arm',
      'C7 withdrawn',
      'C2 suppression',
      'C2 suppression keys',
      'C7 withdrawn key',
    ]);
  });

  it('is byte-identical to 0113 once the hunks are removed and the E4 NOT EXISTS restored', () => {
    const reverted = replaceOnce(
      FIN.residue,
      "         or (s.status = 'expired' and s.terminal_reason = 'grace_timeout'\n" +
        '             )\n',
      "         or (s.status = 'expired' and s.terminal_reason = 'grace_timeout'\n" +
        '             and not exists (\n' +
        '               select 1 from screening_v2.phone_appointments ap\n' +
        '                where ap.confirmed_from_attempt_id = a.id\n' +
        '             ))\n',
    );
    expect(reverted).toBe(FIN_0113);
  });

  it('C2: the expired arm uses the suppression and excludes withdrawn legs', () => {
    const h = FIN.hunks['C2/C7 expired arm'];
    expect(h).toContain('and screening_v2.phone_attempt_score_suppression(a.id) is null');
    expect(h).toContain("we.state in ('opted_out','wrong_number')");
    expect(h).toContain("ev.event_type = 'candidate.opt_out'");
    // Applied OR ignored: no `applied` filter on the opt-out row.
    expect(h).not.toMatch(/ev\.applied/);
  });

  it('C7: withdrawn is checked FIRST, cancels only an in_progress session, is counted and skipped', () => {
    const w = FIN.hunks['C7 withdrawn'];
    expect(FIN_0114.indexOf('-- ▼ 0114 C7 withdrawn\n')).toBeLessThan(
      FIN_0114.indexOf('select p.question_count into v_total'),
    );
    expect(FIN_0114.indexOf('-- ▲ 0114 C7 withdrawn\n')).toBeLessThan(
      FIN_0114.indexOf("set status          = 'completed',"),
    );
    expect(w).toContain("set status          = 'cancelled',");
    expect(w).toContain("then 'wrong_number' else 'candidate_opt_out' end,");
    expect(w).toContain("and s.status = 'in_progress';");
    expect(w).toContain('v_withdrawn_skipped := v_withdrawn_skipped + 1;');
    // It never reaches the sessions array.
    expect(w.indexOf('continue;')).toBeGreaterThan(w.indexOf('v_withdrawn_skipped := v_withdrawn_skipped + 1;'));
    expect(w).not.toContain('v_sessions');
  });

  it('C2: the suppression is read per session and emitted beside callback_booked; the transition is unchanged', () => {
    expect(FIN.hunks['C2 suppression']).toContain(
      'v_suppress := screening_v2.phone_attempt_score_suppression(v_row.attempt_id);',
    );
    expect(FIN.hunks['C2 suppression keys']).toContain("'score_suppressed',   v_suppress is not null,");
    expect(FIN.hunks['C2 suppression keys']).toContain("'suppress_reason',    v_suppress,");
    expect(FIN.hunks['C7 withdrawn key']).toContain("'withdrawn_skipped', v_withdrawn_skipped,");
    // The in_progress -> completed UPDATE (the MP3 trigger) is still there, verbatim.
    expect(FIN_0114).toContain(
      "    update screening_v2.call_sessions s\n" +
        "       set status          = 'completed',\n" +
        "           terminal_reason = 'conversation_complete',\n",
    );
  });

  it('keeps every 0113 result key', () => {
    for (const key of [
      'session_id', 'attempt_id', 'engagement_id', 'covered', 'total', 'disconnect_reason',
      'never_started', 'transitioned', 'assessment_present', 'recording_present', 'callback_booked',
      'examined', 'finalized', 'skipped', 'limit', 'grace_seconds', 'sessions',
    ]) {
      expect(FIN_0114, key).toContain(`'${key}',`);
    }
  });
});

describe('0114 §3 — the stranded sweep differs from 0113 ONLY by the C2 hunks', () => {
  it('has exactly the planned hunks, in order', () => {
    expect(SWP.tags).toEqual([
      'C2-P5 declare',
      'C2-P4 live job',
      'C2-P5 late completion',
      'C2-P5 keys',
    ]);
  });

  it('is byte-identical to the 0113 body once the hunks are removed', () => {
    expect(SWP.residue).toBe(SWP_0113);
  });

  it('keeps the p_now / p_grace_seconds comment layout, so the contract stays [p_limit, p_now]', () => {
    expect(functionParameters('sweep_phone_stranded_sessions')).toEqual(['p_limit', 'p_now']);
    expect(PHONE_RPC_PARAMETERS.sweep_phone_stranded_sessions).toEqual(['p_limit', 'p_now']);
  });

  it('C2-P4: the live-job guard matches the runtime enqueue key exactly', () => {
    const h = SWP.hunks['C2-P4 live job'];
    expect(PHONE_ASSESSMENT_QUEUE).toBe('phone.assessment');
    expect(phoneAssessmentDedupKey('S')).toBe('phone.assessment:S');
    expect(h).toContain("where q.name = 'phone.assessment'");
    expect(h).toContain("and q.dedup_key = 'phone.assessment:' || e.session_id::text");
    expect(h).toContain("and q.status in ('pending','active','delayed')");
    // Placed inside the first loop's selection, before its ORDER BY.
    expect(SWP_0114.indexOf('-- ▲ 0114 C2-P4 live job')).toBeLessThan(
      SWP_0114.indexOf('     order by e.updated_at asc\n     limit v_limit\n  loop\n    v_examined'),
    );
  });

  it('C2-P5: the late loop is bounded, after the stranded loop, and only calls the late-score RPC', () => {
    const h = SWP.hunks['C2-P5 late completion'];
    expect(h).toContain('limit v_limit');
    expect(h).toContain('screening_v2.complete_phone_engagement_after_late_score(v_late_row.id, p_now)');
    expect(h).not.toMatch(/update screening_v2|insert into/);
    expect(h).toContain("'stranded:' || e.session_id::text || ':assessment.aborted'");
    expect(h).toContain('n.cycle_number > e.cycle_number');
    expect(SWP.hunks['C2-P5 keys']).toContain("'late_completed',  v_late_completed,");
    expect(SWP.hunks['C2-P5 keys']).toContain("'late_superseded', v_late_superseded,");
  });
});

describe('0114 §3 — the two new RPCs', () => {
  it('phone_attempt_score_suppression: stable, definer, pinned, returns the three reasons or null', () => {
    expect(SUP).toContain(
      'returns text\nlanguage sql\nstable\nsecurity definer\nset search_path = pg_catalog, screening_v2\nas $$',
    );
    const answers = [...SUP.matchAll(/then '([a-z_]+)'/g)].map((m) => m[1]);
    expect(answers).toEqual([...PHONE_ATTEMPT_SCORE_SUPPRESSION_RESULTS]);
    expect([...PHONE_SCORE_SUPPRESS_REASONS]).toEqual([...PHONE_ATTEMPT_SCORE_SUPPRESSION_RESULTS]);
    expect(SUP).toContain('ap.confirmed_from_attempt_id = p_attempt_id');
    expect(SUP).toContain("a.outcome_class = 'callback_deferred'");
    // worker_aborted: applied, internal, THIS attempt (the stranded abort has none).
    for (const clause of [
      'ev.attempt_id = p_attempt_id',
      "ev.source = 'internal'",
      "ev.event_type = 'assessment.aborted'",
      'ev.applied',
    ]) {
      expect(SUP, clause).toContain(clause);
    }
    expect(SUP).not.toMatch(/insert |update |delete /i);
  });

  it('complete_phone_engagement_after_late_score: locks, re-checks, ledger + relabel + audit', () => {
    expect(LATE).toContain(
      'returns jsonb\nlanguage plpgsql\nsecurity definer\nset search_path = pg_catalog, screening_v2\nas $$',
    );
    const lock = LATE.indexOf('for update;');
    const ledger = LATE.indexOf('insert into screening_v2.phone_call_events');
    const relabel = LATE.indexOf('update screening_v2.phone_engagements');
    const audit = LATE.indexOf('insert into screening_v2.audit_events');
    expect(lock).toBeGreaterThan(-1);
    expect(ledger).toBeGreaterThan(lock);
    expect(relabel).toBeGreaterThan(ledger);
    expect(audit).toBeGreaterThan(relabel);
    for (const clause of [
      "v_eng.state is distinct from 'failed'",
      "v_eng.state_reason is distinct from 'assessment_aborted'",
      'v_eng.session_id is null',
      "'stranded:' || v_eng.session_id::text || ':assessment.aborted'",
      "a.source = 'phone'",
      'n.application_link_id = v_eng.application_link_id',
      'n.cycle_number > v_eng.cycle_number',
      "'late:' || v_eng.session_id::text || ':assessment.completed'",
      'on conflict do nothing',
      "state_reason = 'late_score_after_stranded_abort'",
      'version      = version + 1',
      "'phone_engagement_late_completed'",
      "jsonb_build_object('session_id', v_eng.session_id,",
      "'prior_reason', v_eng.state_reason",
    ]) {
      expect(LATE, clause).toContain(clause);
    }
    // A relabel: terminal_at is never written.
    expect(LATE.slice(relabel, audit)).not.toContain('terminal_at');
    expect([...functionStatuses('complete_phone_engagement_after_late_score')].sort()).toEqual(
      [...COMPLETE_PHONE_ENGAGEMENT_AFTER_LATE_SCORE_STATUSES].sort(),
    );
  });

  it('the rpc-contract registration matches the migration signatures, outside the store bijection', () => {
    for (const [name, params] of Object.entries(PHONE_OUTCOME_RPC_PARAMETERS)) {
      expect(functionParameters(name), name).toEqual([...params]);
      expect(PHONE_RPC_NAMES as readonly string[], name).not.toContain(name);
    }
  });
});

describe('0114 §3 — posture', () => {
  const sigs = [
    'screening_v2.phone_attempt_score_suppression(uuid)',
    'screening_v2.finalize_phone_partial_sessions(integer, integer, timestamptz)',
    'screening_v2.complete_phone_engagement_after_late_score(uuid, timestamptz)',
    'screening_v2.sweep_phone_stranded_sessions(integer, timestamptz, integer)',
  ];

  it('every function is revoked from public/anon/authenticated and granted to service_role only', () => {
    for (const sig of sigs) {
      expect(SECTION.replace(/\s+/g, ' '), sig).toContain(
        `revoke all on function ${sig} from public, anon, authenticated;`,
      );
      expect(SECTION.replace(/\s+/g, ' '), sig).toContain(`grant execute on function ${sig} to service_role;`);
    }
    expect(SECTION).not.toMatch(/grant execute[^;]*to\s+(public|anon|authenticated)/i);
  });

  it('every function is SECURITY DEFINER with the pinned search_path', () => {
    for (const body of [SUP, FIN_0114, LATE, SWP_0114]) {
      expect(body).toContain('security definer\nset search_path = pg_catalog, screening_v2\n');
    }
  });

  it('reads no machine clock (p_now only)', () => {
    for (const body of [SUP, FIN_0114, LATE, SWP_0114]) {
      expect(code(body)).not.toMatch(MACHINE_CLOCK);
    }
  });

  it('puts no PII in any new hunk, returned key or audit row', () => {
    const hunks = [
      ...Object.values(FIN.hunks),
      ...Object.values(SWP.hunks),
      SUP,
      LATE,
    ];
    for (const h of hunks) {
      // `q.name` is the job-queue name ('phone.assessment'), not a person's.
      expect(code(h).replace(/\bq\.name\b/g, 'q.queue')).not.toMatch(
        /phone_e164|\bemail\b|\bname\b|room_name|external_call_id/,
      );
    }
  });

  it('does not redeclare any function another section owns', () => {
    const declared = [...SECTION.matchAll(/create or replace function screening_v2\.(\w+)\(/g)].map((m) => m[1]);
    expect(declared).toEqual([...OWNED]);
  });
});
