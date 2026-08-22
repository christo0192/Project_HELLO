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
import { Link } from 'react-router-dom';
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

      {/*
        Ashby Mission Control lives on its own route. Until now the only way
        to reach it was to type the URL, which is not a navigation model.

        This is a LINK, not a button with an onClick handler: it must be
        keyboard reachable, focusable, and openable in a new tab by the same
        habits every other link obeys. It renders ABOVE the section tabs so it
        cannot disturb their state or lazy mounting.

        PERMISSIONS ARE UNCHANGED. `/mission-control` and
        `/ashby-mission-control` already sit inside the SAME
        `<ProtectedRoute requireRole="admin">` in App.tsx, so surfacing the
        destination grants nothing that was not already reachable — and the
        API behind it stays authoritative regardless.

        ICON: the repository carries no Ashby brand asset (`public/icons.svg`
        holds unused social glyphs only), and fetching one would be an
        unlicensed third-party mark. So the treatment is a neutral, decorative
        glyph drawn from the page's own palette tokens and marked
        `aria-hidden` — it is deliberately NOT an imitation of the Ashby logo,
        and the accessible name comes from the text.
      */}
      <Link
        to="/ashby-mission-control"
        className="mb-6 flex items-center gap-4 rounded-xl border border-line bg-surface p-5 shadow-card transition-colors hover:border-ink-tertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-ink-primary sm:mb-8 sm:p-6"
      >
        <span
          aria-hidden="true"
          className="flex h-10 w-10 flex-none items-center justify-center rounded-lg border border-line text-sm font-semibold text-ink-secondary"
        >
          AS
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-medium text-ink-primary">
            Ashby Mission Control
          </span>
          <span className="mt-0.5 block text-xs text-ink-tertiary">
            Job mappings, application workflows and resume ingestion for the
            Ashby integration.
          </span>
        </span>
        <span aria-hidden="true" className="ml-auto hidden flex-none text-ink-tertiary sm:block">
          &rarr;
        </span>
      </Link>

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
