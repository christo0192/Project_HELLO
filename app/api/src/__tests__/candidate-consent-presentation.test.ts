import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), '../supabase/migrations/0069_candidate_consent_presentation.sql'),
  'utf8',
);

describe('candidate consent presentation migration', () => {
  it('adds bounded UX-only fields without changing the consent set', () => {
    expect(migration).toContain('add column if not exists summary text');
    expect(migration).toContain('add column if not exists consent_items jsonb');
    expect(migration).toContain("where is_active = true");
    expect(migration).toContain("'ai_interview'");
    expect(migration).toContain("'recording'");
    expect(migration).toContain("'rights'");
  });

  it('does not delete or rewrite consent history', () => {
    expect(migration).not.toMatch(/delete\s+from\s+.*consent_records/i);
    expect(migration).not.toMatch(/update\s+.*consent_records/i);
    expect(migration).not.toMatch(/drop\s+table\s+.*consent_records/i);
  });
});
