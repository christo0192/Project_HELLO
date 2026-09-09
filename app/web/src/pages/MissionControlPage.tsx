/**
 * HELLO Mission Control — admin/SRE area for nontechnical operators.
 *
 * Every section below is writable ONLY through the existing audited admin
 * API plus the Lane-2 allowlist endpoints. No direct DB/cloud/provider/
 * deploy/rollback/reconciliation controls are offered — nothing here
 * invents capabilities the API does not expose.
 *
 * Sections (internal accessible sub-navigation, keyboard + mobile safe):
 * Overview · Access · Sessions · Quotas · Audit · Maintenance. The active
 * section is mirrored into the URL hash (`#sessions`) so a section is
 * shareable and survives a refresh; unknown hashes fall back to Overview.
 *
 * Role gate: non-admin operators see a truthful "admin access required"
 * panel and NO admin API calls are made (403-free by construction).
 */

import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api';
import type { MeResponse } from '../types';
import {
  EmptyPanel,
  ErrorPanel,
  GlassPanel,
  LoadingPanel,
  PageHeader,
} from '../components/design';
import {
  AccessSection,
  AuditSection,
  MaintenanceSection,
  MissionControlSections,
  OverviewSection,
  QuotasSection,
  ScorebarSection,
  SessionsSection,
} from '../components/mission-control';
import { CalendarIcon } from '../components/navigation';

const SECTION_IDS = ['overview', 'access', 'sessions', 'quotas', 'scorebar', 'audit', 'maintenance'] as const;
type SectionId = (typeof SECTION_IDS)[number];

function sectionFromHash(hash: string): SectionId {
  const id = hash.replace(/^#/, '');
  return (SECTION_IDS as ReadonlyArray<string>).includes(id) ? (id as SectionId) : 'overview';
}

export function MissionControlPage() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const location = useLocation();
  const navigate = useNavigate();
  const selected = sectionFromHash(location.hash);

  const load = useCallback(() => {
    setLoadError(null);
    setMe(null);
    api
      .getMe()
      .then(setMe)
      .catch((e: ApiError) => setLoadError(e.message));
  }, []);

  useEffect(load, [load]);

  const selectSection = useCallback(
    (id: string) => {
      navigate({ pathname: location.pathname, search: location.search, hash: id === 'overview' ? '' : `#${id}` }, { replace: true });
    },
    [navigate, location.pathname, location.search],
  );

  if (loadError) {
    return <ErrorPanel message={loadError} onRetry={load} />;
  }
  if (!me) {
    return <LoadingPanel label="Checking access…" />;
  }

  if (me.role !== 'admin') {
    return (
      <div>
        <PageHeader
          eyebrow="Operations"
          title="Mission Control"
          description="Operational controls for the workspace."
        />
        <GlassPanel className="mt-6">
          <EmptyPanel
            title="Admin access required"
            hint="Mission Control is available to admin operators only. Ask an admin to add you to the access list, or use the Talent Workspace for your daily work."
          />
        </GlassPanel>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        eyebrow="Operations"
        title="Mission Control"
        description="Every control here writes through the audited admin API. Nothing is estimated."
        actions={
          <>
            {/*
              Quick links to the two sibling operator surfaces. Real <Link>s
              (keyboard reachable, open-in-new-tab friendly), rendered ABOVE
              the section tabs so they never disturb tab state or lazy
              mounting. Permissions are unchanged: both routes already sit
              inside the same admin-gated route group.
            */}
            <Link to="/ashby-mission-control" className={quickLinkClass}>
              <span aria-hidden="true" className="flex h-5 w-5 items-center justify-center rounded-md bg-info-soft text-[10px] font-semibold text-info">
                AS
              </span>
              Ashby Mission Control
              <ArrowIcon />
            </Link>
            <Link to="/phone-calendar" className={quickLinkClass}>
              <span aria-hidden="true" className="flex h-5 w-5 items-center justify-center rounded-md bg-info-soft text-info">
                <CalendarIcon className="h-3.5 w-3.5" />
              </span>
              Phone calendar
              <ArrowIcon />
            </Link>
          </>
        }
      />

      <MissionControlSections
        className="mt-6"
        ariaLabel="Mission Control sections"
        selectedId={selected}
        onSelect={selectSection}
        sections={[
          { id: 'overview', label: 'Overview', render: () => <OverviewSection /> },
          { id: 'access', label: 'Access', render: () => <AccessSection /> },
          { id: 'sessions', label: 'Sessions', render: () => <SessionsSection /> },
          { id: 'quotas', label: 'Quotas', render: () => <QuotasSection /> },
          { id: 'scorebar', label: 'Scorebar', render: () => <ScorebarSection /> },
          { id: 'audit', label: 'Audit', render: () => <AuditSection /> },
          { id: 'maintenance', label: 'Maintenance', render: () => <MaintenanceSection /> },
        ]}
      />
    </div>
  );
}

const quickLinkClass =
  'inline-flex h-9 items-center gap-2 rounded-control bg-white/70 pl-2 pr-3 text-[13px] font-medium text-ink shadow-[inset_0_0_0_1px_var(--glass-ring-strong)] transition-[background-color,box-shadow,transform] duration-200 ease-soft hover:-translate-y-px hover:bg-white hover:shadow-pill focus:outline-none focus-visible:ring-2 focus-visible:ring-info focus-visible:ring-offset-2 focus-visible:ring-offset-surface-secondary';

function ArrowIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-3.5 w-3.5 text-ink-tertiary" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 17 17 7M8 7h9v9" />
    </svg>
  );
}
