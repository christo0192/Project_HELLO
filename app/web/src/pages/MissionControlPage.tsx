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
 * Header: the global operator halt (`OperatorHaltControl`) on the right. It
 * replaced two quick links (Ashby Mission Control, Phone calendar); both
 * surfaces are in the sidebar's Operations group.
 *
 * Role gate: non-admin operators see a truthful "admin access required"
 * panel and NO admin API calls are made (403-free by construction).
 */

import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
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
  FunnelSection,
  MissionControlSections,
  OperatorHaltControl,
  OverviewSection,
  QuotasSection,
  SessionsSection,
} from '../components/mission-control';

// `scorebar` is deliberately absent: the metric library moved to the Roles
// page, where the person editing a role can reach it without changing pages.
// An old `#scorebar` bookmark falls through `sectionFromHash` to `overview`
// rather than 404-ing, which is the right failure for a deep link.
const SECTION_IDS = ['overview', 'access', 'sessions', 'quotas', 'funnel', 'audit', 'maintenance'] as const;
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
          /*
            The global operator halt: red to halt, green to resume an operator
            pause, neither while the switch cannot be read. Rendered ABOVE the
            section tabs so it never disturbs tab state or lazy mounting.
          */
          <OperatorHaltControl />
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
          { id: 'funnel', label: 'Funnel', render: () => <FunnelSection /> },
          { id: 'audit', label: 'Audit', render: () => <AuditSection /> },
          { id: 'maintenance', label: 'Maintenance', render: () => <MaintenanceSection /> },
        ]}
      />
    </div>
  );
}
