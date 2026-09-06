/**
 * The calendar toolbar: how the week is read, and which rows are shown.
 *
 * Everything here is a toggle over data that is ALREADY loaded. Switching
 * view or toggling a facet rewrites the query string and re-filters rows in
 * memory — no request is issued, which a test pins.
 *
 * Every control carries `aria-pressed`, so its on/off state is announced and
 * is never conveyed by fill colour alone, and every control is at least 44px
 * tall for touch (`Button size="lg"`).
 *
 * Zero-count facets are hidden, except an active one; see `phoneFacets` for
 * why that exception exists.
 */

import { hasActivePhoneFilters } from './phoneCalendarFilters';
import type {
  PhoneCalendarFilters,
  PhoneCalendarView,
  PhoneFacet,
} from './phoneCalendarFilters';
import { Button, GlassPanel } from '../design';
import { appointmentStatusTerm, engagementStateTerm } from './phoneVocabulary';

export interface PhoneFilterBarProps {
  statusFacets: PhoneFacet[];
  stateFacets: PhoneFacet[];
  filters: PhoneCalendarFilters;
  /** The view actually in effect (a narrow viewport may default it). */
  view: PhoneCalendarView;
  onViewChange: (view: PhoneCalendarView) => void;
  onToggle: (dimension: 'status' | 'state', value: string) => void;
  onClear: () => void;
}

/** The one label style in this toolbar: sentence case, 13px, tertiary ink. */
const legendClass = 'text-[13px] font-medium text-ink-tertiary';

function FacetGroup({
  legend,
  facets,
  dimension,
  labelFor,
  onToggle,
}: {
  legend: string;
  facets: PhoneFacet[];
  dimension: 'status' | 'state';
  labelFor: (value: string) => string;
  onToggle: (dimension: 'status' | 'state', value: string) => void;
}) {
  if (facets.length === 0) return null;
  return (
    <fieldset className="min-w-0">
      <legend className={legendClass}>{legend}</legend>
      <div className="mt-2 flex flex-wrap gap-2">
        {facets.map((facet) => (
          <Button
            key={facet.value}
            size="lg"
            variant={facet.active ? 'primary' : 'secondary'}
            aria-pressed={facet.active}
            onClick={() => onToggle(dimension, facet.value)}
          >
            {labelFor(facet.value)}
            <span className={facet.active ? 'text-white' : 'text-ink-tertiary'}>
              {facet.count}
            </span>
          </Button>
        ))}
      </div>
    </fieldset>
  );
}

export function PhoneFilterBar({
  statusFacets,
  stateFacets,
  filters,
  view,
  onViewChange,
  onToggle,
  onClear,
}: PhoneFilterBarProps) {
  const anyActive = hasActivePhoneFilters(filters);

  return (
    <GlassPanel
      padding="sm"
      className="mb-5 flex flex-col gap-5 sm:flex-row sm:flex-wrap sm:items-start sm:gap-x-8"
    >
      <fieldset className="min-w-0">
        <legend className={legendClass}>View</legend>
        {/*
          A sunken well holding two toggles rather than a `SegmentedControl`:
          the segmented pill is 32px tall, and every control on this surface
          has to clear the 44px touch target.
        */}
        <div className="glass-sunken mt-2 inline-flex gap-1 rounded-control p-1">
          <Button
            size="lg"
            variant={view === 'week' ? 'primary' : 'ghost'}
            aria-pressed={view === 'week'}
            onClick={() => onViewChange('week')}
          >
            Week grid
          </Button>
          <Button
            size="lg"
            variant={view === 'queue' ? 'primary' : 'ghost'}
            aria-pressed={view === 'queue'}
            onClick={() => onViewChange('queue')}
          >
            Queue
          </Button>
        </div>
      </fieldset>

      <FacetGroup
        legend="Appointment"
        facets={statusFacets}
        dimension="status"
        labelFor={(v) => appointmentStatusTerm(v).label}
        onToggle={onToggle}
      />
      <FacetGroup
        legend="Engagement"
        facets={stateFacets}
        dimension="state"
        labelFor={(v) => engagementStateTerm(v).label}
        onToggle={onToggle}
      />
      {anyActive && (
        <Button
          size="lg"
          variant="ghost"
          onClick={onClear}
          className="self-end sm:ml-auto"
        >
          Clear filters
        </Button>
      )}
    </GlassPanel>
  );
}
