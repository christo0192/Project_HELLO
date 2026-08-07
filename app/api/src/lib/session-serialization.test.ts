import { describe, it, expect } from 'vitest';
import {
  withSessionCreatedAt,
  withSessionCreatedAtList,
} from './session-serialization.js';

describe('withSessionCreatedAt', () => {
  it('aliases created_at from started_at when created_at is absent', () => {
    const row = { id: 's1', started_at: '2026-08-07T10:00:00+00:00', ended_at: null };
    const out = withSessionCreatedAt(row);
    expect(out).not.toBeNull();
    expect(out!.created_at).toBe('2026-08-07T10:00:00+00:00');
    // preserves all other fields untouched
    expect(out!.id).toBe('s1');
    expect(out!.ended_at).toBeNull();
    expect(out!.started_at).toBe('2026-08-07T10:00:00+00:00');
  });

  it('prefers an explicit created_at over started_at when present', () => {
    const row = {
      id: 's2',
      created_at: '2026-08-06T09:00:00+00:00',
      started_at: '2026-08-07T10:00:00+00:00',
    };
    expect(withSessionCreatedAt(row)!.created_at).toBe('2026-08-06T09:00:00+00:00');
  });

  it('falls back to null when neither created_at nor started_at exist', () => {
    const row = { id: 's3' };
    expect(withSessionCreatedAt(row)!.created_at).toBeNull();
  });

  it('treats a null created_at as absent and uses started_at', () => {
    const row = { id: 's4', created_at: null, started_at: '2026-08-07T10:00:00+00:00' };
    expect(withSessionCreatedAt(row)!.created_at).toBe('2026-08-07T10:00:00+00:00');
  });

  it('returns null for null/undefined input', () => {
    expect(withSessionCreatedAt(null)).toBeNull();
    expect(withSessionCreatedAt(undefined)).toBeNull();
  });
});

describe('withSessionCreatedAtList', () => {
  it('normalizes every row and returns [] for null/undefined', () => {
    expect(withSessionCreatedAtList(null)).toEqual([]);
    expect(withSessionCreatedAtList(undefined)).toEqual([]);
    const rows = [
      { id: 'a', started_at: '2026-08-07T10:00:00+00:00' },
      { id: 'b', created_at: '2026-08-06T09:00:00+00:00', started_at: '2026-08-07T10:00:00+00:00' },
    ];
    const out = withSessionCreatedAtList(rows);
    expect(out.map((r) => r.created_at)).toEqual([
      '2026-08-07T10:00:00+00:00',
      '2026-08-06T09:00:00+00:00',
    ]);
  });
});
