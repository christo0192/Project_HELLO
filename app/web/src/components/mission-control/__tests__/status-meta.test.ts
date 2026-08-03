/**
 * Pure status/message helpers — truthfulness and safety semantics.
 */
import { describe, it, expect } from 'vitest';
import {
  allowlistEntryState,
  allowlistStateLabel,
  allowlistStateTone,
  auditEventsInWindow,
  countLinkedActiveAdmins,
  formatDateTime,
  isSelfEntry,
  isTerminalSessionStatus,
  maintenanceMeta,
  normalizeEmailPreview,
  shortId,
  stableMutationMessage,
} from '../statusMeta';

describe('allowlistEntryState', () => {
  it('labels disabled entries first', () => {
    expect(
      allowlistEntryState({ active: false, linked_user_id: 'u1' }),
    ).toBe('disabled');
  });
  it('labels linked entries when active and signed in', () => {
    expect(
      allowlistEntryState({ active: true, linked_user_id: 'u1' }),
    ).toBe('linked');
  });
  it('labels pending entries when active but never linked', () => {
    expect(
      allowlistEntryState({ active: true, linked_user_id: null }),
    ).toBe('pending');
  });
  it('maps states to labels and tones', () => {
    expect(allowlistStateLabel('linked')).toBe('Linked');
    expect(allowlistStateLabel('pending')).toBe('Pending');
    expect(allowlistStateLabel('disabled')).toBe('Disabled');
    expect(allowlistStateTone('linked')).toBe('success');
    expect(allowlistStateTone('pending')).toBe('info');
    expect(allowlistStateTone('disabled')).toBe('neutral');
  });
});

describe('countLinkedActiveAdmins', () => {
  it('counts only active, linked admins — pending admins do not count', () => {
    const entries = [
      { id: '1', email: 'a@x.com', role: 'admin' as const, active: true, linked_user_id: 'u1', linked_at: '2026-01-01T00:00:00Z' },
      { id: '2', email: 'b@x.com', role: 'admin' as const, active: true, linked_user_id: null, linked_at: null },
      { id: '3', email: 'c@x.com', role: 'admin' as const, active: false, linked_user_id: 'u3', linked_at: '2026-01-01T00:00:00Z' },
      { id: '4', email: 'd@x.com', role: 'viewer' as const, active: true, linked_user_id: 'u4', linked_at: '2026-01-01T00:00:00Z' },
    ];
    expect(countLinkedActiveAdmins(entries)).toBe(1);
  });
});

describe('normalizeEmailPreview / isSelfEntry', () => {
  it('trims and lowercases the email preview', () => {
    expect(normalizeEmailPreview('  JOHN.DOE@INTERVIEWKICKSTART.COM ')).toBe(
      'john.doe@interviewkickstart.com',
    );
  });
  it('matches the self entry case-insensitively, trimmed', () => {
    expect(
      isSelfEntry('JOHN.DOE@INTERVIEWKICKSTART.COM', 'john.doe@interviewkickstart.com'),
    ).toBe(true);
    expect(isSelfEntry('other@interviewkickstart.com', 'john.doe@interviewkickstart.com')).toBe(
      false,
    );
  });
  it('never treats a null own email as self', () => {
    expect(isSelfEntry('a@x.com', null)).toBe(false);
  });
});

describe('terminal session statuses', () => {
  it('flags the immutable terminals', () => {
    expect(isTerminalSessionStatus('failed')).toBe(true);
    expect(isTerminalSessionStatus('cancelled')).toBe(true);
    expect(isTerminalSessionStatus('expired')).toBe(true);
    expect(isTerminalSessionStatus('deleted')).toBe(true);
  });
  it('does not flag live statuses or unknown values', () => {
    expect(isTerminalSessionStatus('waiting')).toBe(false);
    expect(isTerminalSessionStatus('in_progress')).toBe(false);
    expect(isTerminalSessionStatus(null)).toBe(false);
    expect(isTerminalSessionStatus(undefined)).toBe(false);
  });
});

describe('maintenanceMeta', () => {
  it('reports maintenance mode with the given reason', () => {
    const meta = maintenanceMeta({
      status: 'maintenance',
      maintenance: { enabled: true, reason: 'Deployment window', updated_at: '2026-01-01T00:00:00Z' },
      updated_at: '2026-01-01T00:00:00Z',
    });
    expect(meta.label).toBe('Maintenance mode');
    expect(meta.tone).toBe('warning');
    expect(meta.detail).toBe('Deployment window');
  });
  it('reports operational when disabled with no maintenance', () => {
    const meta = maintenanceMeta({
      status: 'ok',
      maintenance: { enabled: false, reason: null, updated_at: null },
      updated_at: '2026-01-01T00:00:00Z',
    });
    expect(meta.label).toBe('Operational');
    expect(meta.tone).toBe('success');
  });
  it('reports degraded status truthfully', () => {
    const meta = maintenanceMeta({
      status: 'degraded',
      maintenance: null,
      updated_at: '2026-01-01T00:00:00Z',
    });
    expect(meta.label).toBe('Degraded');
    expect(meta.tone).toBe('warning');
  });
  it('never fabricates data for a null status', () => {
    const meta = maintenanceMeta(null);
    expect(meta.label).toBe('Unknown');
    expect(meta.detail).toBe('No status data available.');
  });
});

describe('auditEventsInWindow', () => {
  const now = new Date('2026-01-10T12:00:00Z').getTime();
  it('counts only events inside the window', () => {
    const rows = [
      { id: '1', action: 'a', actor_type: 'recruiter', actor_id: 'x', target_type: 't', target_id: 'y', result: 'success', created_at: '2026-01-10T10:00:00Z' },
      { id: '2', action: 'b', actor_type: 'recruiter', actor_id: 'x', target_type: 't', target_id: 'y', result: 'success', created_at: '2026-01-09T00:00:00Z' },
      { id: '3', action: 'c', actor_type: 'recruiter', actor_id: 'x', target_type: 't', target_id: 'y', result: 'success', created_at: 'not-a-date' },
    ] as const;
    expect(auditEventsInWindow(rows as unknown as never[], 24, now)).toBe(1);
  });
});

describe('stableMutationMessage', () => {
  it('maps every stable 400/409 code to operator copy', () => {
    expect(stableMutationMessage('duplicate', 'fallback')).toContain('already on the access list');
    expect(stableMutationMessage('invalid_email', 'fallback')).toContain('interviewkickstart.com');
    expect(stableMutationMessage('invalid_role', 'fallback')).toContain("isn't supported");
    expect(stableMutationMessage('invalid_reason', 'fallback')).toContain('reason is required');
    expect(stableMutationMessage('invalid_target', 'fallback')).toContain('not allowed');
    expect(stableMutationMessage('no_changes', 'fallback')).toContain('already as requested');
    expect(stableMutationMessage('not_found', 'fallback')).toContain('no longer exists');
    expect(stableMutationMessage('session_not_found', 'fallback')).toContain('no longer exists');
    expect(stableMutationMessage('self_modification_denied', 'fallback')).toContain('own access entry');
    expect(stableMutationMessage('last_linked_active_admin', 'fallback')).toContain('last linked active admin');
    expect(stableMutationMessage('resurrection_denied', 'fallback')).toContain('terminal state');
    expect(stableMutationMessage('deleted_denied', 'fallback')).toContain('Deleted');
  });
  it('falls back for unknown codes — never leaks the raw code', () => {
    expect(stableMutationMessage('internal_nonsense', 'A friendly fallback.')).toBe('A friendly fallback.');
    expect(stableMutationMessage(null, 'A friendly fallback.')).toBe('A friendly fallback.');
    expect(stableMutationMessage(undefined, 'A friendly fallback.')).toBe('A friendly fallback.');
  });
});

describe('display helpers', () => {
  it('formats date-times and shows a truthful placeholder for missing data', () => {
    expect(formatDateTime('2026-01-01T00:00:00Z')).not.toBe('—');
    expect(formatDateTime(null)).toBe('—');
    expect(formatDateTime('garbage')).toBe('—');
  });
  it('shortens opaque ids but never fabricates', () => {
    expect(shortId('00000000-0000-4000-8000-000000000001')).toMatch(/^.{13}…$/);
    expect(shortId(null)).toBe('—');
    expect(shortId('short')).toBe('short');
  });
});
