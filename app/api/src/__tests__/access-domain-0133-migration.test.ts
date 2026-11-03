/**
 * Static guarantees for migration 0133 (company domain switch to dexity.com).
 * The behavioural cases — both domains accepted, same-login continuity
 * (email_updated / link_moved), every 0016 denial kept, and the records
 * handover — run against the real migrated schema in
 * app/supabase/tests/policy_tests.sql (section "0133"). These checks keep the
 * migration and its three enforcement layers honest:
 *
 *   - the accepted domain set is IDENTICAL in the DB helper, the DB CHECK,
 *     the API constant and the web UX helper (drift here means a person the
 *     login page welcomes is refused by the API, or the reverse);
 *   - add_allowlist_entry is 0016's body VERBATIM except the one domain test;
 *   - the handover RPC writes owner_id on exactly the five ownership tables
 *     and never rewrites a history column;
 *   - no new audit action (chk_audit_action stays pinned to 0114);
 *   - every new or replaced function is SECURITY DEFINER with a fixed
 *     search_path, revoked from browser roles and granted to service_role.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALLOWED_ACCESS_DOMAINS } from '../lib/auth.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrations = path.resolve(here, '../../../supabase/migrations');
/** Normalised to LF so a Windows (CRLF) checkout compares the same as CI. */
const lf = (text: string): string => text.replace(/\r\n/g, '\n');
const read = (name: string): string => lf(readFileSync(path.join(migrations, name), 'utf8'));

const M0133 = read('0133_dexity_access_domain.sql');
const M0016 = read('0016_dashboard_access_allowlist.sql');
const WEB_AUTH = lf(readFileSync(path.resolve(here, '../../../web/src/lib/auth.tsx'), 'utf8'));

const stripComments = (sql: string): string => sql.replace(/--[^\n]*/g, '');
const CODE = stripComments(M0133);

/** One `create or replace function screening_v2.<name>(` up to its own `\n$$;\n`. */
function declaration(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function screening_v2.${name}(`);
  expect(start, `${name} must be declared`).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf('\n$$;\n', start);
  expect(end, `${name} must close with $$;`).toBeGreaterThan(start);
  return sql.slice(start, end + 5);
}

describe('0133 — the accepted domain set is the same in all four places', () => {
  const expected = ['interviewkickstart.com', 'dexity.com'];

  it('the API constant is exactly the two company domains', () => {
    expect([...ALLOWED_ACCESS_DOMAINS]).toEqual(expected);
  });

  it('is_access_email_domain lists exactly those domains', () => {
    const fn = declaration(CODE, 'is_access_email_domain');
    const m = fn.match(/p_domain in \(([^)]*)\)/);
    expect(m).not.toBeNull();
    const listed = [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    expect(listed).toEqual(expected);
  });

  it('the CHECK pins exactly those domains, anchored, with escaped dots', () => {
    expect(CODE).toContain(
      "email_normalized ~ '^[a-z0-9._%+\\-]+@(interviewkickstart|dexity)\\.com$'",
    );
    expect(CODE).toMatch(/add constraint chk_email_allowlist_normalized check \([\s\S]*?\) not valid;/);
    expect(CODE).toContain('validate constraint chk_email_allowlist_normalized;');
  });

  it('the web UX helper lists exactly those domains (login hint == server gate)', () => {
    const m = WEB_AUTH.match(/export const ALLOWED_EMAIL_DOMAINS[^=]*=\s*Object\.freeze\(\[([^\]]*)\]\)/);
    expect(m, 'web ALLOWED_EMAIL_DOMAINS must be a frozen literal list').not.toBeNull();
    const listed = [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    expect(listed).toEqual(expected);
  });

  it('both RPCs gate on the helper, not a hard-coded domain', () => {
    for (const name of ['resolve_allowlist_access', 'add_allowlist_entry']) {
      const fn = declaration(CODE, name);
      expect(fn).toContain('screening_v2.is_access_email_domain(v_domain)');
      expect(fn).not.toMatch(/v_domain\s*<>\s*'/);
    }
  });
});

describe('0133 — add_allowlist_entry is 0016 verbatim except the domain test', () => {
  it('replacing the one line gives back 0016 byte for byte', () => {
    const now = declaration(M0133, 'add_allowlist_entry');
    const before = declaration(M0016, 'add_allowlist_entry');
    const restored = now.replace(
      'if not screening_v2.is_access_email_domain(v_domain) then',
      "if v_domain <> 'interviewkickstart.com' then",
    );
    expect(restored).toBe(before);
  });
});

describe('0133 — resolve_allowlist_access keeps every 0016 denial', () => {
  const fn = stripComments(declaration(M0133, 'resolve_allowlist_access'));

  it('still denies a null/blank input, non-ASCII, malformed and wrong-domain email', () => {
    expect(fn).toContain('if p_user_id is null or p_email is null or length(btrim(p_email)) = 0 then');
    expect(fn).toContain("if v_email ~ E'[^\\\\x20-\\\\x7E]' then");
    expect(fn).toContain("if v_email !~ '^[a-z0-9._%+\\-]+@[a-z0-9.\\-]+\\.[a-z]{2,}$' then");
    expect(fn).toContain('if not screening_v2.is_access_email_domain(v_domain) then');
  });

  it('still denies a disabled entry and an address linked to another login', () => {
    expect(fn).toContain('if not v_entry.active then');
    expect(fn).toContain('if v_entry.linked_user_id is not null and v_entry.linked_user_id <> p_user_id then');
  });

  it('continuity requires the prior link ACTIVE and Google proof of the new address, before ANY write', () => {
    const gate = fn.indexOf('if v_has_prior and (not v_has_entry or v_entry.linked_user_id is null) then');
    expect(gate).toBeGreaterThan(0);
    const gateBody = fn.slice(gate, fn.indexOf('if v_has_entry then', gate));
    expect(gateBody).toContain('if not v_prior.active then');
    expect(gateBody).toMatch(/from auth\.identities i\s+where i\.user_id = p_user_id\s+and i\.provider = 'google'/);
    // A verified, ASCII-only address equal to the presented one…
    expect(gateBody).toContain("and (i.identity_data->>'email') !~ E'[^\\\\x20-\\\\x7E]'");
    expect(gateBody).toContain("and lower(btrim(i.identity_data->>'email')) = v_email");
    expect(gateBody).toContain("and (i.identity_data->>'email_verified') = 'true'");
    // …on a COMPANY Workspace account (Google's server-side hd claim), not a
    // personal Google account that happens to use a company address.
    expect(gateBody).toMatch(
      /and screening_v2\.is_access_email_domain\(\s+lower\(btrim\(i\.identity_data->'custom_claims'->>'hd'\)\)\)/,
    );
    expect(gateBody).toContain('if not v_google_proof then');
    // No UPDATE of the allowlist may happen before the gate has run.
    expect(fn.slice(0, gate)).not.toMatch(/update screening_v2\.email_allowlist/);
  });

  it('link_moved retires the old entry (disabled, unlinked, viewer) BEFORE linking the new one', () => {
    const retire = fn.indexOf('set linked_user_id = null,');
    const link = fn.indexOf('set linked_user_id = p_user_id,');
    expect(retire).toBeGreaterThan(0);
    expect(link).toBeGreaterThan(retire);
    expect(fn.slice(retire, link)).toContain('active = false');
    expect(fn.slice(retire, link)).toContain("role = 'viewer'");
  });

  it('serialises the last-admin check with a transaction advisory lock', () => {
    expect(fn).toContain("perform pg_advisory_xact_lock(hashtext('screening_v2.allowlist_last_admin_guard'));");
  });

  it('link_moved never leaves zero linked active admins', () => {
    expect(fn).toMatch(
      /if v_prior\.role = 'admin' and v_entry\.role <> 'admin'\s+and not exists \(\s+select 1\s+from screening_v2\.email_allowlist\s+where role = 'admin' and active and linked_user_id is not null\s+and id <> v_prior\.id\s+\) then\s+v_entry\.role := 'admin';/,
    );
  });

  it('re-reads both rows WITH the lock (no unlocked read after the PERFORM)', () => {
    expect(fn).toMatch(/where email_normalized = v_email\s+for update;\s+v_has_entry := found;/);
    expect(fn).toMatch(/and email_normalized <> v_email\s+for update;\s+v_has_prior := found;/);
  });

  it('locks both rows in one statement, ordered by id', () => {
    expect(fn).toMatch(
      /perform 1\s+from screening_v2\.email_allowlist\s+where email_normalized = v_email\s+or linked_user_id = p_user_id\s+order by id\s+for update;/,
    );
  });
});

describe('0133 — handover moves ownership only', () => {
  const fn = stripComments(declaration(M0133, 'handover_allowlist_records'));

  it('moves exactly the six ownership columns, in the pinned lock order (round before candidate, sessions last)', () => {
    const tables = [...fn.matchAll(/update screening_v2\.([a-z_]+)\s+set ([a-z_]+) =/g)].map(
      (m) => `${m[1]}.${m[2]}`,
    );
    expect(tables).toEqual([
      'roles.owner_id',
      'ashby_job_mappings.owner_id',
      'role_drafts.owner_id',
      'interview_rounds.created_by',
      'candidates.owner_id',
      'call_sessions.owner_id',
    ]);
  });

  it('rewrites created_by ONLY on interview_rounds (R1 ownership), never a pure history column', () => {
    const createdBy = [...fn.matchAll(/update screening_v2\.([a-z_]+)\s+set created_by =/g)].map((m) => m[1]);
    expect(createdBy).toEqual(['interview_rounds']);
    expect(fn).not.toMatch(/\bset\s+(actor_id|updated_by|reviewer_id|placed_by|verified_by|granted_by|archived_by)\b/);
    expect(fn).not.toMatch(/audit_events\s+set|update screening_v2\.audit_events/);
  });

  it('leaves running Ask-Hello drafts alone (0101 one-running-per-owner index)', () => {
    expect(fn).toMatch(/update screening_v2\.role_drafts[\s\S]*?and status <> 'running';/);
  });

  it('requires both entries linked and the target active', () => {
    expect(fn).toContain("return jsonb_build_object('status', 'from_not_linked');");
    expect(fn).toContain("return jsonb_build_object('status', 'to_not_linked');");
    expect(fn).toContain("return jsonb_build_object('status', 'to_inactive');");
  });

  it('fails fast instead of queueing behind live traffic (function-level lock_timeout)', () => {
    expect(fn).toMatch(/set search_path = pg_catalog, screening_v2\nset lock_timeout = '5s'\nas \$\$/);
  });

  it('reports a count for every moved table', () => {
    for (const key of ['roles', 'candidates', 'call_sessions', 'ashby_job_mappings', 'role_drafts', 'interview_rounds']) {
      expect(fn).toContain(`'${key}', v_`);
    }
  });
});

describe('0133 — PostgREST sees the new RPC', () => {
  it('ends with the schema-cache reload every RPC-adding migration carries', () => {
    expect(M0133.trimEnd().endsWith("notify pgrst, 'reload schema';")).toBe(true);
  });
});

describe('0133 — security posture and audit vocabulary', () => {
  it('re-creates no audit constraint (chk_audit_action stays pinned to 0114)', () => {
    expect(CODE).not.toContain('chk_audit_action');
  });

  it('writes only existing audit actions', () => {
    const actions = [...CODE.matchAll(/'recruiter', '([a-z_]+)'/g)].map((m) => m[1]);
    expect(new Set(actions)).toEqual(new Set(['allowlist_linked', 'admin_allowlist_add', 'admin_member_update']));
  });

  it('every plpgsql RPC is SECURITY DEFINER with a fixed search_path', () => {
    for (const name of ['resolve_allowlist_access', 'add_allowlist_entry', 'handover_allowlist_records']) {
      const fn = declaration(CODE, name);
      expect(fn).toContain('security definer');
      expect(fn).toContain('set search_path = pg_catalog, screening_v2');
    }
    expect(declaration(CODE, 'is_access_email_domain')).toContain('set search_path = pg_catalog');
  });

  it('every function is revoked from browser roles and granted only to service_role', () => {
    const sigs = [
      'is_access_email_domain(text)',
      'resolve_allowlist_access(uuid, text)',
      'add_allowlist_entry(text, text, uuid)',
      'handover_allowlist_records(uuid, uuid, uuid)',
    ];
    for (const sig of sigs) {
      expect(CODE).toContain(`revoke all on function screening_v2.${sig}\n  from public, anon, authenticated;`);
      expect(CODE).toContain(`grant execute on function screening_v2.${sig}\n  to service_role;`);
    }
    expect(CODE).not.toMatch(/grant [^;]* to (anon|authenticated|public)\b/);
  });
});
