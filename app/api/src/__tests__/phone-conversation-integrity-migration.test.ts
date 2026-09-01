import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SQL = readFileSync(fileURLToPath(new URL(
  '../../../supabase/migrations/0076_phone_conversation_integrity.sql',
  import.meta.url,
)), 'utf8').toLowerCase();

describe('0076 phone conversation integrity metadata', () => {
  it('derives duration from answered attempt intervals, not session provisioning time', () => {
    expect(SQL).toContain('set_phone_session_duration');
    expect(SQL).toContain('a.answered_at');
    expect(SQL).toContain('a.ended_at');
    expect(SQL).toContain('new.ended_at');
    expect(SQL).toContain("new.external_call_id !~ '^phone-");
    expect(SQL).not.toContain('new.ended_at - new.started_at');
  });

  it('runs once on phone completion and preserves existing duration', () => {
    expect(SQL).toContain('before update of status, ended_at');
    expect(SQL).toContain("new.status = 'completed'");
    expect(SQL).toContain('old.status is distinct from new.status');
    expect(SQL).toContain('new.duration_sec is not null');
  });

  it('excludes reconnect gaps and keeps the lifecycle duration bound', () => {
    expect(SQL).toContain('least(coalesce(a.ended_at, new.ended_at), new.ended_at)');
    expect(SQL).toContain('least(\n           86400');
    expect(SQL).toContain('and a.answered_at <= new.ended_at');
  });
});
