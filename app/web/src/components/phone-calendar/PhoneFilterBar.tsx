/**
 * The calendar toolbar: which week, how it is read, and which rows are shown.
 *
 * Everything here except the week is a toggle over data that is ALREADY
 * loaded. Switching view, picking an agent or toggling a facet rewrites the
 * query string and re-filters rows in memory — no request is issued, which a
 * test pins.
 *
 * ── ONE SURFACE, TWO BANDS ────────────────────────────────────────────
 * One glass panel split by a hairline. The top band is the calendar's own
 * header: the week (supplied by the page as `header`, since changing it is a
 * read) and the view switch. The bottom band is the filters. Nothing here is a
 * card inside a card, and nothing is louder than it needs to be: the view
 * switch is a sunken segmented pair, the facets are quiet pills, and the one
 * filled accent on the page belongs to the page's primary action.
 *
 * Every toggle carries `aria-pressed`, so its on/off state is announced and
 * is never conveyed by fill colour alone; the agent picker is a native,
 * labelled `<select>`. Every control is at least 44px tall for touch.
 *
 * Zero-count facets are hidden, except an active one; see `phoneFacets` for
 * why that exception exists.
 */

import { useId, type ReactNode } from 'react';
import { hasActivePhoneFilters } from './phoneCalendarFilters';
import type {
  PhoneAgentOption,
  PhoneCalendarFilters,
  PhoneCalendarView,
  PhoneFacet,
} from './phoneCalendarFilters';
import { Button, GlassPanel, SelectField, cx } from '../design';
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
  /** The top band's leading content: the week and its navigation. */
  header?: ReactNode;
  /**
   * False while there are no rows to filter (loading, an error, the feature
   * off): the top band stays, so the week controls never unmount under a
   * keyboard user, and the filter band waits.
   */
  showFilters?: boolean;
}

/** The one label style in this toolbar: sentence case, 13px, tertiary ink. */
const legendClass = 'text-label font-medium text-ink-tertiary';

/**
 * A facet toggle: a quiet pill, the same shape and weight as the candidate
 * list's filter pills, so a filter reads as a filter and not as an action.
 */
function pillClass(active: boolean): string {
  return cx(
    'inline-flex min-h-[44px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 text-label font-medium',
    'transition-[color,background-color,box-shadow] duration-200 ease-soft',
    'focus:outline-none focus-visible:ring-2 focus-visible:ring-info focus-visible:ring-offset-2 focus-visible:ring-offset-surface-secondary',
    active
      ? 'bg-info text-white shadow-pill'
      : 'bg-white/70 text-ink-secondary shadow-[inset_0_0_0_1px_var(--glass-ring-strong)] hover:bg-white hover:text-ink',
  );
}

/** One half of the view switch: a segment in a sunken well, lifted when on. */
function segmentClass(active: boolean): string {
  return cx(
    'inline-flex min-h-[44px] items-center rounded-[10px] px-4 text-label font-medium',
    'transition-[color,background-color,box-shadow] duration-200 ease-soft',
    'focus:outline-none focus-visible:ring-2 focus-visible:ring-info focus-visible:ring-offset-1',
    active ? 'bg-white text-ink shadow-pill' : 'text-ink-secondary hover:text-ink',
  );
}

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
      <p className="max-w-xs self-end text-label text-ink-tertiary">
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
        className="mt-2 min-h-[44px] sm:w-56"
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
    <fieldset className="min-w-0 max-sm:w-full">
      <legend className={legendClass}>{legend}</legend>
      {/*
        On a phone, one swipeable row per group instead of four wrapped rows:
        thirteen pills stacked were ~570px of toolbar before the first call.
        The row bleeds to the panel edge so the cut-off pill reads as "more",
        and it is an ordinary scroll box — its pills are the focus stops.
      */}
      <div className="mt-2 flex gap-2 max-sm:-mx-4 max-sm:overflow-x-auto max-sm:px-4 max-sm:pb-1 sm:flex-wrap">
        {facets.map((facet) => (
          <button
            key={facet.value}
            type="button"
            aria-pressed={facet.active}
            onClick={() => onToggle(dimension, facet.value)}
            className={pillClass(facet.active)}
          >
            {labelFor(facet.value)}
            <span className={cx('tabular-nums', facet.active ? 'text-white' : 'text-ink-tertiary')}>
              {facet.count}
            </span>
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
  view,
  agents,
  onViewChange,
  onAgentChange,
  onToggle,
  onClear,
  header,
  showFilters = true,
}: PhoneFilterBarProps) {
  const anyActive = hasActivePhoneFilters(filters);

  return (
    <GlassPanel padding="none" className="mb-5 divide-y divide-[var(--glass-ring)]">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 px-4 py-3 sm:px-5">
        <div className="min-w-0">{header}</div>
        <fieldset className="min-w-0">
          {/* The two options name themselves; the legend is for the group. */}
          <legend className="sr-only">View</legend>
          <div className="glass-sunken inline-flex gap-1 rounded-control p-1">
            <button
              type="button"
              aria-pressed={view === 'week'}
              onClick={() => onViewChange('week')}
              className={segmentClass(view === 'week')}
            >
              Week grid
            </button>
            <button
              type="button"
              aria-pressed={view === 'queue'}
              onClick={() => onViewChange('queue')}
              className={segmentClass(view === 'queue')}
            >
              Queue
            </button>
          </div>
        </fieldset>
      </div>

      {showFilters && (
      <div className="flex flex-col gap-4 px-4 py-4 sm:flex-row sm:flex-wrap sm:items-start sm:gap-x-8 sm:px-5">
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
            className="self-start sm:ml-auto sm:self-end"
          >
            Clear filters
          </Button>
        )}
      </div>
      )}
    </GlassPanel>
  );
}
