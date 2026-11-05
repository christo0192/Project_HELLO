/**
 * AuditSection — bounded, redacted audit view.
 * Covers: only-bounded-fields rendering (metadata/emails never reach the
 * DOM), bounded pagination, loading/error/retry, empty state, axe.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AdminAuditRow } from '../../../types';
import { missionApi, apiFns } from './apiMock';
import { AuditSection } from '../AuditSection';
import { AUDIT_ACTION_LABELS, auditActionLabel } from '../statusMeta';

vi.mock('../../../api', () => ({
  api: missionApi.api,
  ApiError: missionApi.ApiError,
}));

const ROW: AdminAuditRow = {
  id: 'audit-1',
  action: 'admin_maintenance_toggle',
  actor_type: 'recruiter',
  actor_id: 'actor-user-0000-0000-000000000001',
  target_type: 'system',
  target_id: 'maintenance',
  result: 'success',
  created_at: '2026-01-01T00:00:00Z',
};

function renderAudit() {
  return render(<AuditSection />);
}

describe('AuditSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiFns.listAdminAudit.mockResolvedValue({ audit: [ROW] });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows a loading state until the page resolves', () => {
    apiFns.listAdminAudit.mockReturnValue(new Promise(() => {}));
    renderAudit();
    expect(screen.getByText('Loading audit log…')).toBeInTheDocument();
  });

  it('shows an error state with a retry action', async () => {
    apiFns.listAdminAudit.mockRejectedValue(new missionApi.ApiError('unauthorized', 403));
    renderAudit();
    expect(await screen.findByText(/your session has ended/i)).toBeInTheDocument();
    expect(screen.queryByText('unauthorized')).not.toBeInTheDocument();
    apiFns.listAdminAudit.mockResolvedValue({ audit: [ROW] });
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('Maintenance mode changed')).toBeInTheDocument();
  });

  it('renders only the bounded redacted fields', async () => {
    renderAudit();
    await screen.findByText('Maintenance mode changed');
    expect(screen.getByText('Recruiter')).toBeInTheDocument();
    expect(screen.getByText('System')).toBeInTheDocument();
    expect(screen.getByText('Success')).toBeInTheDocument();
    // Ids are short/opaque — the full actor id is never rendered.
    expect(
      screen.queryByText('actor-user-0000-0000-000000000001'),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/^actor-user-/)).toBeInTheDocument();
  });

  it.each([
    ['admin_allowlist_add', 'allowlist_entry', 'Access entry added'],
    ['admin_allowlist_update', 'allowlist_entry', 'Access entry changed'],
    ['allowlist_linked', 'allowlist_entry', 'Access entry linked to a sign-in'],
    ['admin_member_update', 'membership', 'Member access changed'],
    ['admin_member_update', 'allowlist_entry', 'Records handed over'],
    ['admin_session_override', 'session', 'Session status changed'],
    ['admin_session_override', 'phone_control', 'Calling halt changed'],
    ['admin_session_override', 'recording_finalize_control', 'Admin override'],
    ['admin_maintenance_toggle', 'config', 'Maintenance mode changed'],
    ['quota_override', 'quota_policy', 'Quota policy changed'],
  ])('names %s on %s in plain words', (action, target, label) => {
    expect(auditActionLabel(action, target)).toBe(label);
  });

  it('keys every label on a value the database can store', () => {
    const sql = readFileSync(
      resolve(process.cwd(), '../supabase/migrations/0114_phone_outcome_integrity.sql'),
      'utf8',
    );
    const stored = sql.slice(
      sql.indexOf('add constraint chk_audit_action'),
      sql.indexOf('validate constraint chk_audit_action'),
    );
    expect(stored).toContain("'resource_generate'");
    for (const action of Object.keys(AUDIT_ACTION_LABELS)) expect(stored).toContain(`'${action}'`);
  });

  it('keeps the stored action one hover away', async () => {
    renderAudit();
    expect(await screen.findByText('Maintenance mode changed')).toHaveAttribute('title', 'admin_maintenance_toggle');
  });

  it('never renders arbitrary metadata, IPs, tokens or emails — even if the payload contains them', async () => {
    const leaky = {
      ...ROW,
      // Hypothetical leaky fields a broken server might include:
      metadata: {
        reason: 'top-secret-reason',
        source_ip: '10.0.0.42',
        trace_id: 'trace-abc',
      },
      correlation_id: 'corr-xyz',
      token: 'opaque-jwt-value',
      email: 'private@interviewkickstart.com',
    } as AdminAuditRow;
    apiFns.listAdminAudit.mockResolvedValue({ audit: [leaky] });
    renderAudit();
    await screen.findByText('Maintenance mode changed');
    expect(screen.queryByText('top-secret-reason')).not.toBeInTheDocument();
    expect(screen.queryByText(/10\.0\.0\./)).not.toBeInTheDocument();
    expect(screen.queryByText('trace-abc')).not.toBeInTheDocument();
    expect(screen.queryByText('corr-xyz')).not.toBeInTheDocument();
    expect(screen.queryByText('opaque-jwt-value')).not.toBeInTheDocument();
    expect(screen.queryByText('private@interviewkickstart.com')).not.toBeInTheDocument();
  });

  it('pages forward and back with bounded 50-row offsets', async () => {
    apiFns.listAdminAudit.mockImplementation((_limit: number, offset: number) =>
      Promise.resolve({
        audit: Array.from({ length: 50 }, (_, i) => ({
          ...ROW,
          id: `r-${offset}-${i}`,
        })),
      }),
    );
    renderAudit();
    await screen.findByText(/Showing the most recent 50 events/);

    // Newest page: previous disabled, next enabled.
    expect(screen.getByRole('button', { name: /Previous page/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Next page/ })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: /Next page/ }));
    await waitFor(() => {
      expect(apiFns.listAdminAudit).toHaveBeenLastCalledWith(50, 50);
    });
    expect(await screen.findByText(/starting at #51/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Previous page/ })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: /Previous page/ }));
    await waitFor(() => {
      expect(apiFns.listAdminAudit).toHaveBeenLastCalledWith(50, 0);
    });
    expect(screen.queryByText(/starting at #51/)).not.toBeInTheDocument();
  });

  it('disables the next-page control when the page is not full (no more records)', async () => {
    renderAudit();
    await screen.findByText(/Showing the most recent 1 events/);
    expect(screen.getByRole('button', { name: /Next page/ })).toBeDisabled();
  });

  it('shows a truthful empty state', async () => {
    apiFns.listAdminAudit.mockResolvedValue({ audit: [] });
    renderAudit();
    expect(await screen.findByText('No audit events yet')).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = renderAudit();
    await screen.findByText('Maintenance mode changed');
    await expect(container).toHaveNoViolations();
  });
});
