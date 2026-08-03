/**
 * HELLO Mission Control — premium admin/SRE area for nontechnical
 * operators (Lane 4).
 *
 * The page is a clear, separate surface from the legacy AdminDashboard:
 * every section below is writable ONLY through the existing audited admin
 * API plus the Lane-2 allowlist endpoints. No direct DB/cloud/provider/
 * deploy/rollback/reconciliation controls are offered — nothing here
 * invents capabilities the API does not expose.
 *
 * Sections (internal accessible sub-navigation, keyboard + mobile safe):
 * Overview · Access · Sessions · Quotas · Audit · Maintenance.
 *
 * Role gate: non-admin operators see a truthful "admin access required"
 * panel and NO admin API calls are made (403-free by construction).
 */

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import type { MeResponse } from '../types';
import { ErrorState, LoadingState } from '../components/ui';
import { PageHeader } from '../components/design';
import {
  AccessSection,
  AuditSection,
  MaintenanceSection,
  MissionControlSections,
  OverviewSection,
  QuotasSection,
  SessionsSection,
} from '../components/mission-control';

export function MissionControlPage() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    setMe(null);
    api
      .getMe()
      .then(setMe)
      .catch((e: ApiError) => setLoadError(e.message));
  }, []);

  useEffect(load, [load]);

  if (loadError) {
    return <ErrorState message={loadError} onRetry={load} />;
  }
  if (!me) {
    return <LoadingState label="Checking access…" />;
  }

  if (me.role !== 'admin') {
    return (
      <div>
        <PageHeader
          eyebrow="Mission Control"
          title="Mission Control"
          description="Operational controls for the workspace."
        />
        <div className="rounded-xl border border-line bg-surface p-10 text-center shadow-card">
          <p className="text-sm font-medium text-ink-secondary">
            Admin access required
          </p>
          <p className="mx-auto mt-1 max-w-md text-xs text-ink-tertiary">
            Mission Control is available to admin operators only. Ask an
            admin to add you to the access list, or use the Talent Workspace
            for your daily work.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        eyebrow="Mission Control"
        title="Mission Control"
        description="A clearly separated admin/SRE area for nontechnical operators. Every control writes through the audited admin API — nothing is estimated."
      />

      <MissionControlSections
        ariaLabel="Mission Control sections"
        defaultId="overview"
        sections={[
          {
            id: 'overview',
            label: 'Overview',
            render: () => <OverviewSection />,
          },
          {
            id: 'access',
            label: 'Access',
            render: () => <AccessSection />,
          },
          {
            id: 'sessions',
            label: 'Sessions',
            render: () => <SessionsSection />,
          },
          {
            id: 'quotas',
            label: 'Quotas',
            render: () => <QuotasSection />,
          },
          {
            id: 'audit',
            label: 'Audit',
            render: () => <AuditSection />,
          },
          {
            id: 'maintenance',
            label: 'Maintenance',
            render: () => <MaintenanceSection />,
          },
        ]}
      />
    </div>
  );
}
