/**
 * Facet filters over the week that is already loaded.
 *
 * Every chip carries `aria-pressed`, so its on/off state is announced and is
 * never conveyed by fill colour alone. Each chip is at least 44px tall for
 * touch. Toggling one rewrites the query string and re-filters rows already
 * in memory — no request is issued, which a test pins.
 *
 * Zero-count facets are hidden, except an active one; see `phoneFacets` for
 * why that exception exists.
 */

import { hasActivePhoneFilters } from './phoneCalendarFilters';
import type { PhoneCalendarFilters, PhoneFacet } from './phoneCalendarFilters';
import { cx } from '../design';
import { appointmentStatusTerm, engagementStateTerm } from './phoneVocabulary';

export interface PhoneFilterBarProps {
  statusFacets: PhoneFacet[];
  stateFacets: PhoneFacet[];
  filters: PhoneCalendarFilters;
  onToggle: (dimension: 'status' | 'state', value: string) => void;
  onClear: () => void;
}

function chipClasses(active: boolean): string {
  return cx(
    'inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
    'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
    active
      ? 'border-brand-500 bg-brand-50 text-brand-800 dark:bg-brand-950 dark:text-brand-200'
      : 'border-line bg-surface text-ink-secondary hover:bg-surface-tertiary hover:text-ink',
  );
}

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
      <legend className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">
        {legend}
      </legend>
      <div className="mt-1.5 flex flex-wrap gap-2">
        {facets.map((facet) => (
          <button
            key={facet.value}
            type="button"
            aria-pressed={facet.active}
            onClick={() => onToggle(dimension, facet.value)}
            className={chipClasses(facet.active)}
          >
            {labelFor(facet.value)}
            <span className="text-ink-tertiary">{facet.count}</span>
          </button>
        ))}
      </div>
    </fieldset>
  );
}

export function PhoneFilterBar({
  statusFacets,
  stateFacets,
  filters,
  onToggle,
  onClear,
}: PhoneFilterBarProps) {
  const anyActive = hasActivePhoneFilters(filters);
  if (statusFacets.length === 0 && stateFacets.length === 0) return null;

  return (
    <div className="mb-4 flex flex-col gap-4 rounded-xl border border-line bg-surface p-4 shadow-card sm:flex-row sm:flex-wrap sm:items-start">
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
        <button
          type="button"
          onClick={onClear}
          className="inline-flex min-h-[44px] items-center self-end rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink-secondary transition-colors hover:bg-surface-tertiary hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          Clear filters
        </button>
      )}
    </div>
  );
}
