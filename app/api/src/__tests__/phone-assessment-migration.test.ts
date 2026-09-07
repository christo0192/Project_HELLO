/**
 * P4b — what 0044 actually says, read from the migration text.
 *
 * These are the assertions that stay true when a later edit looks harmless.
 * They read the SQL rather than the database, so they fail in `npm test`
 * rather than three hours later in the Supabase job — and, more importantly,
 * they pin the two places where a well-meaning simplification would be a
 * safety regression:
 *
 *   1. The `assessment.completed` interlock is a PRE-INSERT refusal. Recording
 *      it would be the obvious "improvement" and would wedge the call
 *      permanently, because the `internal` source mints a DETERMINISTIC event
 *      id and every later delivery of the same claim reads the refusal back.
 *   2. The uniqueness on `assessments` is PARTIAL. Making it global is the
 *      other obvious "improvement", and it would fail to build on any database
 *      where the browser path has ever produced two rows for one session.
 */

import { describe, it, expect } from 'vitest';
import {
  MIGRATION_0042,
  MIGRATION_0043,
  MIGRATION_0044,
  MIGRATION_0070,
  PHONE_MIGRATIONS_TEXT,
  functionBody,
  functionParameters,
  RPC_NAMES,
} from './support/phone-migration.js';

// ═══════════════════════════════════════════════════════════════════
describe('the interlock on assessment.completed', () => {
  const body = functionBody('apply_phone_event');

  it('resolves to 0044 — the newest declaration is the effective one', () => {
    expect(MIGRATION_0044).toContain('create or replace function screening_v2.apply_phone_event(');
    expect(body).toContain('v_needs_assessment');
  });

  it('is decided BEFORE the insert, beside `attempt_required`', () => {
    const guard = body.indexOf("'status', 'assessment_missing'");
    const insert = body.indexOf('insert into screening_v2.phone_call_events');
    expect(guard).toBeGreaterThan(-1);
    expect(insert).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(insert);
  });

  it('RETURNS rather than setting an ignored reason — nothing is recorded', () => {
    // The distinction the whole design turns on. `internal` events carry a
    // DETERMINISTIC provider_event_id, so a recorded refusal is read back
    // verbatim by every later delivery of the same claim, and a worker that
    // posted one moment too early could never complete the call at all.
    expect(body).not.toContain("v_ignored := 'assessment_missing'");
    expect(body).toContain("return jsonb_build_object('status', 'assessment_missing'");
  });

  it('and the ignored-reason CHECK was NOT widened to admit it', () => {
    expect(PHONE_MIGRATIONS_TEXT).not.toMatch(
      /chk_phone_call_events_ignored_reason[\s\S]{0,400}assessment_missing/,
    );
  });

  it('requires a bound session AND a phone-sourced row, not one or the other', () => {
    const guard = body.slice(
      body.indexOf('if v_ignored is null and v_needs_assessment'),
      body.indexOf("'status', 'assessment_missing'"),
    );
    expect(guard.length).toBeGreaterThan(60);
    expect(guard).toContain('v_eng.session_id is null');
    expect(guard).toContain('from screening_v2.assessments a');
    expect(guard).toContain("a.source = 'phone'");
  });

  it('the flag is set by exactly ONE branch', () => {
    expect([...body.matchAll(/v_needs_assessment := true/g)]).toHaveLength(1);
    const branch = body.slice(
      body.indexOf("p_event_type = 'assessment.completed' then"),
      body.indexOf('v_needs_assessment := true'),
    );
    expect(branch).toContain("v_new_state := 'completed'");
    // …and it is NOT the aborted branch, which must keep working with no
    // assessment at all: that is the whole point of a truthful failure.
    const aborted = body.slice(body.indexOf("p_event_type = 'assessment.aborted' then"));
    expect(aborted.slice(0, 400)).not.toContain('v_needs_assessment');
  });

  it('charges nothing — the refusal must leave every budget where it was', () => {
    const guard = body.slice(
      body.indexOf('if v_ignored is null and v_needs_assessment'),
      body.indexOf("'engagement_state', v_eng.state);",
        body.indexOf('if v_ignored is null and v_needs_assessment')),
    );
    expect(guard).not.toContain('v_charge');
    expect(guard).not.toContain('update screening_v2.phone_engagements');
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('0044 replaces apply_phone_event and changes ONE thing', () => {
  // 0043 replaced 0042's body to add one branch and asserted the branch was
  // the sole change. 0044 replaces 0043's, and the same claim needs the same
  // proof — otherwise a second, unrelated edit could ride along inside a
  // 520-line copy nobody reads.
  const anchor = 'create or replace function screening_v2.apply_phone_event(';
  const extract = (sql: string): string[] => {
    const start = sql.indexOf(anchor);
    const end = sql.indexOf('\n$$;', start);
    return sql.slice(start, end).split('\n');
  };
  const before = extract(MIGRATION_0043);
  const after = extract(MIGRATION_0044);

  it('the extractor is not vacuous', () => {
    expect(before.length).toBeGreaterThan(400);
    expect(after.length).toBeGreaterThan(400);
    expect(MIGRATION_0042).toContain(anchor);
  });

  it('removes exactly the ONE line the guard replaces, and nothing else', () => {
    const removed = before.filter((line) => !after.includes(line));
    expect(removed).toEqual([
      "        v_new_state := 'completed'; v_att_state := 'ended'; v_outcome := 'completed'; -- #22",
    ]);
  });

  it('every ADDED line belongs to the interlock', () => {
    const added = after.filter((line) => !before.includes(line));
    expect(added.length).toBeGreaterThan(0);
    for (const line of added) {
      const text = line.trim();
      const belongs =
        text === ''
        || text.startsWith('--')
        || text.includes('v_needs_assessment')
        || text.includes('assessment_missing')
        || text.includes("v_new_state := 'completed'")
        || text.includes('screening_v2.assessments')
        || text.includes("a.source = 'phone'")
        || text.includes('a.session_id = v_eng.session_id')
        || text.includes('v_eng.session_id is null')
        || text.includes('select 1 from')
        || text === 'or not exists ('
        || text.includes('end if;')
        || text.includes("'event_type', p_event_type,")
        || text.includes("'engagement_state', v_eng.state);");
      expect(belongs, `unexpected added line: ${line}`).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('the assessment uniqueness', () => {
  it('is PARTIAL over the phone partition, never global', () => {
    expect(MIGRATION_0044).toContain(
      'create unique index if not exists uq_assessments_phone_session',
    );
    const index = MIGRATION_0044.slice(
      MIGRATION_0044.indexOf('create unique index if not exists uq_assessments_phone_session'),
    ).slice(0, 200);
    expect(index).toContain("where source = 'phone'");
  });

  it('is preceded by a duplicate PREFLIGHT that can actually raise', () => {
    const preflight = MIGRATION_0044.slice(
      MIGRATION_0044.indexOf('v_phone_dupes'),
      MIGRATION_0044.indexOf('create unique index if not exists uq_assessments_phone_session'),
    );
    expect(preflight).toContain('raise exception');
    expect(preflight).toContain('having count(*) > 1');
    // …and it REPORTS the browser duplicate count rather than ignoring it, so
    // an operator can see the number that would have blocked a global index.
    expect(preflight).toContain('raise notice');
  });

  it('the source column defaults to browser and is NOT NULL', () => {
    expect(MIGRATION_0044).toContain(
      "add column if not exists source text not null default 'browser'",
    );
    expect(MIGRATION_0044).toContain("source in ('browser','phone')");
  });

  it('no CHECK on call_sessions.terminal_reason was touched', () => {
    // The contract is explicit: no new terminal reason and no new failure
    // policy. A persistence failure stays retryable through 0042's existing
    // reconnect budget. The DOC COMMENT names the constraint to say it is
    // untouched, so the assertion is about DDL, not about the word.
    expect(MIGRATION_0044).not.toMatch(
      /alter table screening_v2\.call_sessions[\s\S]{0,200}chk_call_sessions_terminal_reason/,
    );
    expect(MIGRATION_0044).not.toContain("add constraint chk_call_sessions_terminal_reason");
    expect(MIGRATION_0044).not.toContain('residency_timeout');
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('the two new tables', () => {
  it('are both service-role-only, with RLS enabled and browser roles revoked', () => {
    for (const table of ['phone_session_plans', 'phone_session_progress']) {
      expect(MIGRATION_0044).toContain(`alter table screening_v2.${table}`);
      expect(MIGRATION_0044).toMatch(
        new RegExp(`alter table screening_v2\\.${table}\\s+enable row level security`),
      );
      expect(MIGRATION_0044).toMatch(
        new RegExp(`revoke all on screening_v2\\.${table}\\s+from anon, authenticated, public`),
      );
      expect(MIGRATION_0044).toMatch(
        new RegExp(`grant all privileges on screening_v2\\.${table}\\s+to service_role`),
      );
    }
    expect(MIGRATION_0044).not.toMatch(/create policy/);
  });

  it('block UPDATE and deliberately still permit DELETE', () => {
    // An editable plan is a conversation that can be silently renumbered
    // mid-call. A row nothing can delete makes an erasure request
    // unsatisfiable. Both matter, and they pull in opposite directions.
    for (const fn of ['prevent_phone_plan_update', 'prevent_phone_progress_update']) {
      const body = MIGRATION_0044.slice(
        MIGRATION_0044.indexOf(`create or replace function screening_v2.${fn}()`),
      ).slice(0, 500);
      expect(body).toContain('raise exception');
      expect(body).not.toContain('DELETE');
    }
    expect(MIGRATION_0044).toMatch(/before update on screening_v2\.phone_session_plans/);
    expect(MIGRATION_0044).toMatch(/before update on screening_v2\.phone_session_progress/);
    expect(MIGRATION_0044).not.toMatch(/before delete on screening_v2\.phone_session_(plans|progress)/);
  });

  it('carry NO escape hatch — unlike the 0042 event ledger, which needs one', () => {
    const region = MIGRATION_0044.slice(0, MIGRATION_0044.indexOf('3. assessments'));
    expect(region).not.toContain('allow_phone_event_mutation');
    expect(region).not.toContain('current_setting');
  });

  it('carry no phone, provider or answer-text column', () => {
    const plans = MIGRATION_0044.slice(
      MIGRATION_0044.indexOf('create table if not exists screening_v2.phone_session_plans'),
      MIGRATION_0044.indexOf('create index if not exists idx_phone_session_plans_engagement'),
    );
    const progress = MIGRATION_0044.slice(
      MIGRATION_0044.indexOf('create table if not exists screening_v2.phone_session_progress'),
      MIGRATION_0044.indexOf('create index if not exists idx_phone_session_progress_session'),
    );
    expect(plans.length).toBeGreaterThan(200);
    expect(progress.length).toBeGreaterThan(200);
    for (const region of [plans, progress]) {
      for (const forbidden of ['phone_e164', 'msisdn', 'sip_call_id', 'egress', 'answer_text']) {
        expect(region, forbidden).not.toContain(forbidden);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('the three new RPCs', () => {
  const NEW = [
    'start_phone_assessment',
    'get_phone_assessment_state',
    'commit_phone_question_boundary',
  ] as const;

  it('are declared, granted to service_role and to nobody else', () => {
    for (const name of NEW) {
      expect(RPC_NAMES, name).toContain(name);
      expect(PHONE_MIGRATIONS_TEXT, name).toContain(
        `grant execute on function screening_v2.${name}`,
      );
      expect(PHONE_MIGRATIONS_TEXT, name).toContain(
        `revoke all on function screening_v2.${name}`,
      );
    }
    // The pattern that would open one of them to a browser session.
    expect(MIGRATION_0044).not.toMatch(/grant execute on function[^;]*to (anon|authenticated)/);
  });

  it('the boundary RPC takes the CAS and the idempotency key as parameters', () => {
    expect(functionParameters('commit_phone_question_boundary')).toEqual([
      'p_session_id', 'p_question_key', 'p_expected_index',
      'p_source_event_id', 'p_turns',
      // 0086 (Finding B): the per-key outcome, defaulted; p_now stays FINAL
      // per the repo-wide time-injection invariant.
      'p_disposition', 'p_now',
    ]);
  });

  it('0086: the boundary RPC validates and records the per-key disposition', () => {
    const body = functionBody('commit_phone_question_boundary');
    // The closed vocabulary is refused BEFORE anything is written.
    expect(body).toContain("'status', 'invalid_disposition'");
    for (const member of [
      'asked_answered', 'volunteered_with_evidence', 'asked_declined',
      'asked_unanswered', 'not_delivered', 'skipped_bounded',
    ]) {
      expect(body).toContain(`'${member}'`);
    }
    // The progress INSERT carries the value.
    expect(body).toMatch(/turn_count, committed_at, disposition\)/);
    // Volunteered-coverage rows are volunteered_with_evidence BY CONSTRUCTION.
    const coverage = functionBody('commit_phone_question_boundary_with_coverage');
    expect(coverage).toContain("'volunteered_with_evidence'");
  });

  it('the boundary RPC refuses a NULL expected index — an absent CAS is not a CAS', () => {
    const body = functionBody('commit_phone_question_boundary');
    expect(body).toContain('if p_expected_index is null or p_expected_index <> v_cursor then');
    expect(body).toContain("'status', 'stale_cursor'");
  });

  it('the boundary RPC binds the key to the CURSOR, not merely to the plan', () => {
    const body = functionBody('commit_phone_question_boundary');
    expect(body).toContain("v_expected := v_plan.questions -> v_cursor ->> 'key';");
    expect(body).toContain('if p_question_key <> v_expected then');
    expect(body).toContain("'status', 'key_not_current'");
    // Nothing anywhere searches the plan for the key, which is what would
    // let a model answer questions out of order.
    expect(body).not.toContain('jsonb_array_elements(v_plan.questions)');
  });

  it('the boundary RPC RAISES rather than returning when the cursor CAS is lost', () => {
    // A returned status would COMMIT the half-boundary it was reporting.
    const body = functionBody('commit_phone_question_boundary');
    const cas = body.slice(body.indexOf('get diagnostics v_updated = row_count;'));
    expect(cas).toContain('raise exception');
    expect(cas).not.toMatch(/return jsonb_build_object\('status', '(stale_cursor|session_not_active)'/);
  });

  it('the start RPC gates on `in_call` — the SAME consent gate 0043 uses', () => {
    const body = functionBody('start_phone_assessment');
    expect(body).toContain("if v_eng.state <> 'in_call' then");
    expect(body).toContain("'status', 'disclosure_not_delivered'");
    expect(functionBody('attach_phone_attempt_recording')).toContain("'in_call'");
  });

  it('the start RPC VERIFIES the session binding rather than trusting it', () => {
    const body = functionBody('start_phone_assessment');
    expect(body).toContain("v_sess.external_call_id is distinct from ('phone-' || p_session_id::text)");
    expect(body).toContain('v_sess.candidate_id <> v_eng.candidate_id');
    expect(body).toContain("'status', 'session_candidate_mismatch'");
  });

  it('the start RPC REFUSES a malformed role template instead of using the defaults', () => {
    const body = functionBody('start_phone_assessment');
    const refusal = body.indexOf("'status', 'invalid_role_template'");
    expect(refusal).toBeGreaterThan(-1);
    // The fallback exists, but only for an EMPTY template.
    expect(body).toContain('jsonb_array_length(v_template) = 0');
    expect(body).toContain('screening_v2.phone_default_question_plan()');
    const fallback = body.indexOf('screening_v2.phone_default_question_plan()');
    const invalidFlag = body.indexOf('v_invalid := true');
    expect(fallback).toBeLessThan(invalidFlag);
  });

  it('the plan snapshot is written ON CONFLICT DO NOTHING — first wins, always', () => {
    const body = functionBody('start_phone_assessment');
    expect(body).toContain('on conflict (session_id) do nothing');
    // No upsert, no "latest wins": that is how a conversation gets renumbered
    // halfway through.
    expect(body).not.toContain('do update set');
  });

  it('the read RPC takes no clock at all', () => {
    expect(functionParameters('get_phone_assessment_state')).toEqual(['p_session_id']);
    expect(functionBody('get_phone_assessment_state')).not.toMatch(/\bnow\s*\(/);
  });

  it('the read RPC returns no phone, provider or lease field', () => {
    const body = functionBody('get_phone_assessment_state');
    for (const forbidden of [
      'phone_e164', 'sip_call_id', 'participant_identity', 'egress_id',
      'lease_token', 'room_name', 'attempt_id',
    ]) {
      expect(body, forbidden).not.toContain(forbidden);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// 0070 — gate-free resume context + the durable-consent signal.
//
// The effective declaration of `get_phone_assessment_state` is now 0070's,
// which the extractor reads because it is registered NEWEST-FIRST. These pin
// the two behaviours the migration exists for: the resume `turns` exclude the
// pre-consent gate turns (the 2026-08-29 cross-leg leak), and `gate_recorded`
// exposes whether the gate has run so a re-dispatched leg can skip a second
// consent ask.
// ═══════════════════════════════════════════════════════════════════
describe('0070 — the resume projection is gate-free and reports gate_recorded', () => {
  const body = functionBody('get_phone_assessment_state');

  it('resolves to 0070 — the newest declaration is the effective one', () => {
    expect(MIGRATION_0070).toContain(
      'create or replace function screening_v2.get_phone_assessment_state(',
    );
    // The 0070-only locals prove the extractor read the new body, not 0044/0049.
    expect(body).toContain('v_gate');
  });

  it('EXCLUDES gate turns from the resume context, NULL treated as not-a-gate', () => {
    // The turns aggregation must filter is_gate; a NULL (a legacy row) reads as
    // false so it stays in the resume context, exactly as before 0067.
    const agg = body.slice(body.indexOf("'turn_index'"));
    expect(agg).toContain('coalesce(t.is_gate, false) = false');
    // The filter sits inside the transcript_turns read, not somewhere inert.
    const turnsRead = body.indexOf('from screening_v2.transcript_turns t');
    const filter = body.indexOf('coalesce(t.is_gate, false) = false');
    expect(turnsRead).toBeGreaterThan(-1);
    expect(filter).toBeGreaterThan(turnsRead);
  });

  it('DERIVES gate_recorded from the UNFILTERED is_gate = true rows', () => {
    // The durable-consent signal counts the gate rows themselves — the ones the
    // resume context excludes — so it must NOT carry the coalesce=false filter.
    expect(body).toContain("'gate_recorded', v_gate");
    const gateSelect = body.slice(body.indexOf('into v_gate'));
    expect(body).toMatch(/where g\.session_id = p_session_id and g\.is_gate = true/);
    void gateSelect;
  });

  it('still takes no clock and returns no forbidden field — the guardrails hold', () => {
    expect(functionParameters('get_phone_assessment_state')).toEqual(['p_session_id']);
    expect(body).not.toMatch(/\bnow\s*\(/);
    for (const forbidden of [
      'phone_e164', 'sip_call_id', 'participant_identity', 'egress_id',
      'lease_token', 'room_name', 'attempt_id',
    ]) {
      expect(body, forbidden).not.toContain(forbidden);
    }
  });

  it('is granted to service_role only and revoked from everyone else', () => {
    expect(MIGRATION_0070).toContain(
      'grant execute on function screening_v2.get_phone_assessment_state(uuid)',
    );
    expect(MIGRATION_0070).toContain(
      'revoke all on function screening_v2.get_phone_assessment_state(uuid)',
    );
    expect(MIGRATION_0070).not.toMatch(
      /grant execute on function[^;]*to (anon|authenticated)/,
    );
  });
});
