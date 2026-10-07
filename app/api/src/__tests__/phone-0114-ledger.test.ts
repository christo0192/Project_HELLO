/**
 * 0114 §2 (PR-C, S2) — the ledger: apply_phone_event and
 * enforce_phone_engagement_transition, asserted against the migration TEXT.
 *
 * Both bodies are LIFTED by script from their newest declaration (0113 and
 * 0045). A lift from an older file, or a "small tidy-up" while lifting,
 * silently reverts PR-A/PR-B or an older fix. So the core assertion here is a
 * structural diff: remove every marked 0114 hunk (`-- ▼ 0114 <id>` …
 * `-- ▲ 0114 <id>`), undo the named one-line edits, and what is left must be
 * BYTE-IDENTICAL to the source body. Any other drift fails.
 *
 * Behaviour is proven in app/supabase/tests/policy_tests.sql (block
 * 0114-§2); text is not execution.
 */
import { describe, it, expect } from 'vitest';

import {
  MIGRATION_0045,
  MIGRATION_0112,
  MIGRATION_0113,
  MIGRATION_0114,
  PHONE_MIGRATIONS,
  functionBody,
} from './support/phone-migration.js';

const lf = (s: string) => s.replace(/\r\n/g, '\n');
const M0113 = lf(MIGRATION_0113);
const M0045 = lf(MIGRATION_0045);
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

const BEGIN = '-- ==== 0114 §2 BEGIN ====';
const END = '-- ==== 0114 §2 END ====';
const SECTION = M0114.slice(M0114.indexOf(BEGIN), M0114.indexOf(END) + END.length);

const APE_0113 = bodyIn(M0113, 'apply_phone_event');
const APE_0114 = bodyIn(M0114, 'apply_phone_event');
const TRG_0045 = bodyIn(M0045, 'enforce_phone_engagement_transition');
const TRG_0114 = bodyIn(M0114, 'enforce_phone_engagement_transition');

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

const APE = stripHunks(APE_0114);
const TRG = stripHunks(TRG_0114);

describe('0114 §2 — ownership and placement', () => {
  it('is the newest registered migration after 0125, so the extractors read 0114 (or 0125-lifted) bodies', () => {
    // 0125 (M013 S02) is newest; its later sections re-lift
    // enforce_phone_engagement_transition with the C2 hunk byte-identical,
    // so the C2 marker must still be in whatever body the extractor reads.
    expect(PHONE_MIGRATIONS[0].name).toBe('0125');
    expect(PHONE_MIGRATIONS[1].name).toBe('0114');
    expect(functionBody('apply_phone_event')).toContain('-- ▼ 0114 C1-b');
    expect(functionBody('enforce_phone_engagement_transition')).toContain(
      '-- ▼ 0114 C2 late-score exception',
    );
  });

  it('declares both functions exactly once, inside §2', () => {
    for (const name of ['apply_phone_event', 'enforce_phone_engagement_transition']) {
      const decl = `create or replace function screening_v2.${name}(`;
      expect(M0114.split(decl).length - 1, name).toBe(1);
      expect(SECTION, name).toContain(decl);
    }
  });

  it('does not redeclare confirm_candidate_voice_callback or any 0112 function', () => {
    expect(M0114).not.toContain('function screening_v2.confirm_candidate_voice_callback(');
    const owned0112 = [
      ...lf(MIGRATION_0112).matchAll(/create or replace function screening_v2\.(\w+)\(/g),
    ].map((m) => m[1]);
    expect(owned0112.length).toBeGreaterThan(0);
    for (const name of owned0112) expect(M0114, name).not.toContain(`function screening_v2.${name}(`);
  });

  it('lifts from the newest declarations: 0113 for the ledger, 0045 for the trigger', () => {
    // 0113 carries PR-B's E6 pre-answer branch; a 0095 lift would lose it.
    expect(APE_0113).toContain("p_event_type in ('call.no_answer','call.busy','call.failed')");
    expect(APE_0114).toContain("p_event_type in ('call.no_answer','call.busy','call.failed')");
  });
});

describe('0114 §2 — apply_phone_event differs from 0113 ONLY by the C1/C2/C7 hunks', () => {
  it('has exactly the planned hunks, in order', () => {
    expect(APE.tags).toEqual([
      'C1-a/C2 declare',
      'C1-a consent read',
      'C1-c',
      'C1-b',
      'C1-e',
      'C7-a',
      'C2-a',
      'C1-d',
      'C2-a detach',
      'C7-a/C2-a/C7-b tail',
    ]);
  });

  it('is byte-identical to the 0113 body once the hunks and the C1-c reset edit are removed', () => {
    const reverted = replaceOnce(
      APE.residue,
      "                               when v_reset_reconnects\n                                    and coalesce(v_att.kind, 'initial') <> 'reconnect'\n",
      "                               when v_bump_epoch\n                                    and coalesce(v_att.kind, 'initial') <> 'reconnect'\n",
    );
    expect(reverted).toBe(APE_0113);
  });

  it('keeps SECURITY DEFINER, the pinned search_path and the service_role-only ACL', () => {
    expect(APE_0114).toContain(
      'returns jsonb\nlanguage plpgsql\nsecurity definer\nset search_path = pg_catalog, screening_v2\nas $$',
    );
    const sig = 'screening_v2.apply_phone_event(text, text, uuid, uuid, text, integer, jsonb, timestamptz)';
    expect(SECTION).toContain(`revoke all on function ${sig}\n  from public, anon, authenticated;`);
    expect(SECTION).toContain(`grant execute on function ${sig}\n  to service_role;`);
    expect(SECTION).not.toMatch(/grant execute[^;]*to\s+(public|anon|authenticated)/i);
  });

  it('reads no machine clock (p_now only)', () => {
    for (const body of [APE_0114, TRG_0114]) {
      const code = body
        .replace(/--[^\n]*/g, '')
        .replace('p_now               timestamptz default now()', '');
      expect(code).not.toMatch(
        /\b(now|clock_timestamp|statement_timestamp|transaction_timestamp|timeofday)\s*\(|\bcurrent_(timestamp|date|time)\b|\blocaltimestamp\b/i,
      );
    }
  });

  it('C1: R1 needs internal + an answered attempt + the consented-live read; bumps the epoch only', () => {
    const r1 = APE.hunks['C1-b'];
    expect(r1).toContain(
      "      when v_eng.state = 'dialing' and p_event_type = 'consent.resumed'\n" +
        "           and p_source = 'internal'\n" +
        "           and v_att.state in ('answered_unclassified','human')\n" +
        "           and v_consented_live then\n" +
        "        v_new_state := 'in_call'; v_bump_epoch := true;\n",
    );
    const read = APE.hunks['C1-a consent read'];
    expect(read).toContain("v_eng.state = 'dialing'");
    expect(read).toContain('v_eng.terminal_at is null');
    expect(read).toContain('p_attempt_id is not null');
    expect(read).toContain('s.phone_engagement_id = v_eng.id');
    expect(read).toContain('p.engagement_id = v_eng.id');
    expect(read).toContain("v_consented_live := coalesce(v_consent_session_status = 'in_progress', false);");
    expect(read).not.toMatch(/for update/i);
  });

  it('C1: the drop-race backstop is the in_call drop body VERBATIM, ahead of the pre-disclosure branch', () => {
    const head =
      "      when v_eng.state = 'in_call'\n" +
      "           and p_event_type in ('sip.participant_left','sip.connection_aborted') then\n";
    const s = APE_0113.indexOf(head) + head.length;
    const inCallDrop = APE_0113.slice(s, APE_0113.indexOf('      -- ── THE STRANDED PATH SETS NO ATTEMPT EDGE', s));
    expect(inCallDrop).toContain("v_new_state := 'reconnecting'; v_charge := 'reconnect';");
    const race =
      "           and v_att.state in ('answered_unclassified','human')\n" +
      '           and v_consented_live then\n';
    const hunk = APE.hunks['C1-b'];
    const at = hunk.lastIndexOf(race);
    expect(at).toBeGreaterThan(-1);
    expect(hunk.slice(at + race.length)).toBe(inCallDrop);

    const preDisclosure = APE_0114.indexOf('ANSWERED but PRE-DISCLOSURE (0043 / P3-1)');
    expect(APE_0114.indexOf('-- ▼ 0114 C1-b')).toBeLessThan(preDisclosure);
  });

  it('C1: only disclosure.delivered sets the reconnect reset; R1 binds the session to the attempt', () => {
    expect(APE.hunks['C1-c']).toContain('v_reset_reconnects := true;');
    expect(APE_0114.split('v_reset_reconnects := true;').length - 1).toBe(1);
    const bind = APE.hunks['C1-d'];
    expect(bind).toContain(
      '  if v_consented_live\n' +
        "     and v_att.state in ('answered_unclassified','human')\n" +
        '     and v_new_state is not null\n',
    );
    // Exactly the continuation edges' event types (R1, the drop race, C1-e).
    for (const ev of [
      'consent.resumed', 'sip.participant_left', 'sip.connection_aborted',
      'candidate.opt_out', 'callback.deferred_in_call',
    ]) {
      expect(bind, ev).toContain(`'${ev}'`);
    }
    expect(bind).toContain(
      '    update screening_v2.phone_call_attempts\n' +
        '       set session_id = coalesce(session_id, v_eng.session_id)\n',
    );
    // The bind runs after the ignored-verdict return (applied edges only).
    expect(APE_0114.indexOf('-- ▼ 0114 C1-d')).toBeGreaterThan(
      APE_0114.indexOf("  if v_ignored is not null then\n    return jsonb_build_object('status', 'ignored'"),
    );
  });

  it('C1-e: a fail-open continuation leg still lands opt-out / deferral, using the in_call bodies verbatim', () => {
    const h = APE.hunks['C1-e'];
    const gate =
      "           and p_source = 'internal'\n" +
      "           and v_att.state in ('answered_unclassified','human')\n" +
      '           and v_consented_live then\n';
    expect(h).toContain(
      "      when v_eng.state = 'dialing' and p_event_type = 'candidate.opt_out'\n" + gate +
        "        v_new_state := 'opted_out'; v_att_state := 'ended'; v_outcome := 'opt_out';  -- #24\n" +
        "        v_reason := 'candidate_opt_out';\n",
    );
    // The in_call #24 body is the same two lines.
    expect(APE_0113).toContain(
      "      when v_eng.state = 'in_call' and p_event_type = 'candidate.opt_out' then\n" +
        "        v_new_state := 'opted_out'; v_att_state := 'ended'; v_outcome := 'opt_out';  -- #24\n" +
        "        v_reason := 'candidate_opt_out';\n",
    );
    // The deferral body is C2-a's, after its own `when` line.
    const c2 = APE.hunks['C2-a'];
    const c2Body = c2.slice(c2.indexOf("        v_att_state := 'ended'; v_outcome := 'callback_deferred';"));
    const deferHead =
      "      when v_eng.state = 'dialing' and p_event_type = 'callback.deferred_in_call'\n" +
      "           and p_source = 'internal'\n" +
      "           and v_att.state in ('human','answered_unclassified')\n" +
      '           and v_consented_live then\n';
    expect(h).toContain(deferHead);
    const afterHead = h.slice(h.indexOf(deferHead) + deferHead.length);
    expect(afterHead.startsWith(c2Body.trimEnd())).toBe(true);
    expect(h).not.toContain('v_charge');
    // The reconciler's answered-dialing report outside a continuation is
    // recorded, never applied (pre-consent drops keep today's path).
    expect(h).toContain(
      "      when v_eng.state = 'dialing' and p_source = 'reconciliation'\n" +
        "           and p_event_type in ('sip.participant_left','sip.connection_aborted')\n" +
        "           and v_att.state in ('answered_unclassified','human')\n" +
        '           and not v_consented_live then\n' +
        "        v_ignored := 'unexpected_event';\n",
    );
    // Placed after C1-b and before the 0043 pre-disclosure branch.
    const preDisclosure = APE_0114.indexOf('ANSWERED but PRE-DISCLOSURE (0043 / P3-1)');
    expect(APE_0114.indexOf('-- ▲ 0114 C1-b')).toBeLessThan(APE_0114.indexOf('-- ▼ 0114 C1-e'));
    expect(APE_0114.indexOf('-- ▲ 0114 C1-e')).toBeLessThan(preDisclosure);
  });

  it('C2: deferral is uncharged, limit after 2 prior applied, next-IST-day window as deferred_pre_disclosure', () => {
    const h = APE.hunks['C2-a'];
    expect(h).toContain(
      "when v_eng.state = 'in_call' and p_event_type = 'callback.deferred_in_call'\n" +
        "           and v_att.state in ('human','answered_unclassified') then",
    );
    expect(h).toContain("v_att_state := 'ended'; v_outcome := 'callback_deferred';");
    expect(h).not.toContain('v_charge');
    expect(h).toMatch(/ev\.applied\) >= 2 then\n\s+v_new_state := 'failed'; v_reason := 'callback_deferral_limit';/);
    expect(h).toContain("v_new_state := 'eligible'; v_reason := 'callback_deferred_in_call';");
    // The deferred_pre_disclosure expression, token for token (indent differs).
    const ws = (s: string) => s.replace(/\s+/g, ' ');
    const nextDay = ws(
      "v_defer_at := screening_v2.phone_next_window_open( (screening_v2.phone_ist_date(p_now) + 1)::timestamp at time zone 'Asia/Kolkata');",
    );
    expect(ws(h)).toContain(nextDay);
    expect(ws(APE_0113)).toContain(nextDay);
    expect(APE.hunks['C2-a detach']).toContain(
      'session_id      = case when v_detach_session then null else session_id end,',
    );
  });

  it('C7: the race branch is internal, latest-attempt, ended/disconnected, epoch-fenced, R5-guarded, uncharged', () => {
    const h = APE.hunks['C7-a'];
    for (const clause of [
      "p_event_type = 'candidate.opt_out'",
      "p_source = 'internal'",
      'p_attempt_id is not null',
      "v_att.state = 'ended'",
      "v_att.outcome_class = 'disconnected'",
      '(p_epoch is null or p_epoch = v_eng.epoch)',
      'order by a.admitted_at desc, a.attempt_seq desc',
      "v_eng.state = 'reconnecting'",
      "v_eng.state_reason = 'window_closed'",
      "ap.source <> 'system_deferral'",
    ]) {
      expect(h, clause).toContain(clause);
    }
    expect(h).toContain("v_new_state := 'opted_out'; v_reason := 'candidate_opt_out';");
    expect(h).not.toMatch(/v_att_state|v_charge/);
  });

  it('tail: appointment cancel, then call_sessions LAST (claim release, bound-session cancel)', () => {
    const tail = APE.hunks['C7-a/C2-a/C7-b tail'];
    const apt = tail.indexOf('update screening_v2.phone_appointments');
    const claim = tail.indexOf('set phone_engagement_id = null');
    const cancel = tail.indexOf("set status          = 'cancelled'");
    expect(apt).toBeGreaterThan(-1);
    expect(claim).toBeGreaterThan(apt);
    expect(cancel).toBeGreaterThan(claim);
    expect(tail).toContain("cancel_reason = 'engagement_cancelled'");
    expect(tail).toContain("and source = 'system_deferral'");
    expect(tail).toContain('where phone_engagement_id = v_eng.id\n       and id in (v_eng.session_id, v_att.session_id);');
    expect(tail).toContain("and status = 'in_progress';");
    // The tail is after the suppression block and immediately before the return.
    const ret = APE_0114.indexOf("  return jsonb_build_object('status', 'applied', 'applied', true,");
    expect(APE_0114.indexOf("'phone_opt_out_recorded'")).toBeLessThan(APE_0114.indexOf('-- ▼ 0114 C7-a/C2-a/C7-b tail'));
    expect(APE_0114.indexOf('-- ▲ 0114 C7-a/C2-a/C7-b tail')).toBeLessThan(ret);
    // Only statements touching call_sessions after the engagement UPDATE are the tail's.
    const afterEng = APE_0114.slice(APE_0114.indexOf('update screening_v2.phone_engagements'));
    expect((afterEng.match(/update screening_v2\.call_sessions/g) ?? []).length).toBe(2);
  });

  it('writes no PII into returned jsonb or audit rows from the new hunks', () => {
    for (const tag of APE.tags) {
      expect(APE.hunks[tag], tag).not.toMatch(/phone_e164|\bemail\b|\bname\b|room_name|external_call_id/);
    }
  });
});

describe('0114 §2 — the transition trigger differs from 0045 ONLY by (i) and (ii)', () => {
  it('has exactly the (ii) hunk, placed before the terminal-immutability raise', () => {
    expect(TRG.tags).toEqual(['C2 late-score exception']);
    expect(TRG_0114.indexOf('-- ▲ 0114 C2 late-score exception')).toBeLessThan(
      TRG_0114.indexOf("raise exception 'phone engagement % is terminal (%) and immutable'"),
    );
  });

  it('is byte-identical to 0045 once (ii) is removed and (i) opted_out additions are undone', () => {
    let reverted = replaceOnce(
      TRG.residue,
      "                                                 'completed','failed','opted_out'];\n",
      "                                                 'completed','failed'];\n",
    );
    reverted = replaceOnce(
      reverted,
      "                                                 'cancelled','completed','opted_out'];\n",
      "                                                 'cancelled','completed'];\n",
    );
    expect(reverted).toBe(TRG_0045);
  });

  it('(ii) is guarded on every column, the phone assessment and the sweep\'s own ledger row', () => {
    const h = TRG.hunks['C2 late-score exception'];
    for (const clause of [
      "old.state = 'failed'",
      "old.state_reason = 'assessment_aborted'",
      "new.state = 'completed'",
      "new.state_reason = 'late_score_after_stranded_abort'",
      "(to_jsonb(new) - '{state,state_reason,version,updated_at}'::text[])\n" +
        "         = (to_jsonb(old) - '{state,state_reason,version,updated_at}'::text[])",
      'from screening_v2.assessments a',
      "a.source = 'phone'",
      'from screening_v2.phone_call_events ev',
      "'stranded:' || old.session_id::text || ':assessment.aborted'",
      'ev.applied',
    ]) {
      expect(h, clause).toContain(clause);
    }
    // SECURITY INVOKER with search_path=pg_catalog: every relation is qualified.
    const rels = [...h.matchAll(/\bfrom\s+([a-z0-9_.]+)/g)].map((m) => m[1]);
    expect(rels.length).toBe(2);
    for (const r of rels) expect(r).toMatch(/^screening_v2\./);
  });

  it('keeps SECURITY INVOKER and search_path = pg_catalog', () => {
    expect(TRG_0114).toContain(
      'returns trigger\nlanguage plpgsql\nsecurity invoker\nset search_path = pg_catalog\nas $$',
    );
    // The binding is 0042's and is not re-created here.
    expect(SECTION).not.toMatch(/create trigger/i);
  });
});
