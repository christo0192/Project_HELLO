/**
 * The calendar toolbar: how the week is read, and which rows are shown.
 *
 * Everything here is a toggle over data that is ALREADY loaded. Switching
 * view, picking an agent or toggling a facet rewrites the query string and
 * re-filters rows in memory — no request is issued, which a test pins.
 *
 * Every toggle carries `aria-pressed`, so its on/off state is announced and
 * is never conveyed by fill colour alone; the agent picker is a native,
 * labelled `<select>`. Every control is at least 44px tall for touch.
 *
 * Zero-count facets are hidden, except an active one; see `phoneFacets` for
 * why that exception exists.
 */

import { useId } from 'react';
import { hasActivePhoneFilters } from './phoneCalendarFilters';
import type {
  PhoneAgentOption,
  PhoneCalendarFilters,
  PhoneCalendarView,
  PhoneFacet,
} from './phoneCalendarFilters';
import { Button, GlassPanel, SelectField } from '../design';
import { appointmentStatusTerm, engagementStateTerm } from './phoneVocabulary';

/**
 * What the Agent picker can offer.
 *
 *   `loading`     — the roles read is in flight: a disabled picker holds the
 *                   place, so the toolbar does not jump when it settles.
 *   `unavailable` — the roles read failed. No picker and no error wall: the
 *                   calendar is whole without it. `requested` is true only
 *                   when the URL asked for an agent, which is the one case
 *                   worth a word — the view is wider than the link asked for.
 *   `ready`       — one option per role the operator can see.
 */
export type PhoneAgentChoices =
  | { status: 'loading' }
  | { status: 'unavailable'; requested: boolean }
  | { status: 'ready'; options: PhoneAgentOption[] };

export interface PhoneFilterBarProps {
  statusFacets: PhoneFacet[];
  stateFacets: PhoneFacet[];
  filters: PhoneCalendarFilters;
  /** The view actually in effect (a narrow viewport may default it). */
  view: PhoneCalendarView;
  agents: PhoneAgentChoices;
  onViewChange: (view: PhoneCalendarView) => void;
  /** `null` selects "All agents". */
  onAgentChange: (agent: string | null) => void;
  onToggle: (dimension: 'status' | 'state', value: string) => void;
  onClear: () => void;
}

/** The one label style in this toolbar: sentence case, 13px, tertiary ink. */
const legendClass = 'text-[13px] font-medium text-ink-tertiary';

function AgentPicker({
  agents,
  value,
  onChange,
}: {
  agents: PhoneAgentChoices;
  value: string | null;
  onChange: (agent: string | null) => void;
}) {
  const rawId = useId();
  const id = `phone-agent-${rawId.replace(/:/g, '-')}`;

  if (agents.status === 'unavailable') {
    return agents.requested ? (
      <p className="max-w-xs self-end text-[13px] leading-5 text-ink-tertiary">
        Agents could not be loaded, so calls for every agent are shown.
      </p>
    ) : null;
  }
  // An operator who can see no role has nothing to choose between.
  if (agents.status === 'ready' && agents.options.length === 0) return null;

  const loading = agents.status === 'loading';
  return (
    <div className="flex min-w-0 flex-col">
      <label htmlFor={id} className={legendClass}>
        Agent
      </label>
      <SelectField
        id={id}
        value={loading ? '' : (value ?? '')}
        disabled={loading}
        onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
        className="mt-2 min-h-[44px] sm:w-60"
      >
        {agents.status === 'loading' ? (
          <option value="">Loading agents…</option>
        ) : (
          <>
            <option value="">All agents</option>
            {agents.options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </>
        )}
      </SelectField>
    </div>
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
  agents,
  onViewChange,
  onAgentChange,
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

      <AgentPicker agents={agents} value={filters.agent} onChange={onAgentChange} />

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
