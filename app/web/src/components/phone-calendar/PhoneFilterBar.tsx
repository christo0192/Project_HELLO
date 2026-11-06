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
 * ── ONE HEIGHT, LOADING OR LOADED ─────────────────────────────────────
 * The filters are two lines at a desk, the agent and appointments above the
 * engagements, whatever a week holds. While rows are on their way the same
 * markup is drawn invisibly around one placeholder pill per group, so what is
 * held is the band's real height at any width or pointer rather than a figure
 * that has to be kept in step with it. e2e pins that in a real browser.
 *
 * Every toggle carries `aria-pressed`, so its on/off state is announced and
 * is never conveyed by fill colour alone. Controls are the 36px control height
 * with a mouse and 44px on a touch screen: at 44 the band took 270px of the
 * first screen, about three hours of the day.
 *
 * Zero-count facets are hidden, except an active one; see `phoneFacets` for
 * why that exception exists.
 *
 * Each facet carries its family's swatch, as the Candidates chips do, so the two
 * vocabularies read the way their badges below do. The word stays the signal.
 */

import { useId, type ReactNode } from 'react';
import { hasActivePhoneFilters } from './phoneCalendarFilters';
import type {
  PhoneAgentOption,
  PhoneCalendarFilters,
  PhoneCalendarView,
  PhoneFacet,
} from './phoneCalendarFilters';
import { Button, Combobox, GlassPanel, RetryButton, cx, markVar, toneMark } from '../design';
import type { StatusTone } from '../design';
import { appointmentStatusTerm, engagementStateTerm } from './phoneVocabulary';

/**
 * What the Agent picker can offer.
 *
 *   `loading`     — the roles read is in flight: a disabled picker holds the
 *                   place, so the toolbar does not jump when it settles.
 *   `unavailable` — the roles read failed. No picker and no error wall, since
 *                   the calendar is whole without it, but one line and a
 *                   Retry where the picker was. `requested` is true when the
 *                   URL asked for an agent: the view is then wider than the
 *                   link asked for, and the line says so.
 *   `ready`       — one option per role the operator can see.
 */
export type PhoneAgentChoices =
  | { status: 'loading' }
  | { status: 'unavailable'; requested: boolean; onRetry: () => void }
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
  /** While rows are on their way, hold the band's height so the grid does not jump. */
  reserveFilters?: boolean;
}

/** What the held band draws in place of the week's facets. Never seen. */
const HELD_FACETS: PhoneFacet[] = [{ value: 'scheduled', count: 0, active: false }];

/** The one label style in this toolbar: sentence case, 13px, tertiary ink. */
const legendClass = 'text-label font-medium text-ink-tertiary';

/**
 * A facet toggle: a quiet pill, the same shape and weight as the candidate
 * list's filter pills, so a filter reads as a filter and not as an action.
 */
function pillClass(active: boolean): string {
  return cx(
    'inline-flex min-h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-control px-3 text-label font-medium [@media(pointer:coarse)]:min-h-11',
    'transition-[color,background-color,box-shadow] duration-hover ease-soft',
    'focus:outline-none focus-visible:ring-2 focus-visible:ring-info focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
    active
      ? 'bg-info text-surface'
      : 'bg-surface text-ink-secondary border border-[var(--control)] hover:bg-surface-secondary hover:text-ink',
  );
}

/**
 * A facet's key, the box the Candidates chips draw (talent/PipelineBar.tsx). The
 * class names it for forced colours, where every fill takes one colour.
 */
const SWATCH = 'data-fill h-2.5 w-3 shrink-0 rounded-sm border border-[var(--control)]';

/** One half of the view switch: a printed segment, an ink fill when on. */
function segmentClass(active: boolean): string {
  return cx(
    'inline-flex min-h-8 items-center rounded-evidence px-3.5 text-label font-medium [@media(pointer:coarse)]:min-h-10',
    'transition-colors duration-hover ease-out',
    'focus:outline-none focus-visible:ring-2 focus-visible:ring-inset',
    active
      ? 'bg-info text-surface focus-visible:ring-surface'
      : 'text-ink-secondary hover:bg-surface-secondary hover:text-ink focus-visible:ring-info',
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
    return (
      <div className="flex max-w-xs flex-col items-start gap-1.5 self-end">
        <p className="text-label text-ink-tertiary">
          {agents.requested
            ? "Agents couldn't load, so calls for every agent are shown."
            : "Agents couldn't load, so the agent filter is missing."}
        </p>
        <RetryButton onRetry={agents.onRetry} />
      </div>
    );
  }
  // An operator who can see no role has nothing to choose between.
  if (agents.status === 'ready' && agents.options.length === 0) return null;

  const loading = agents.status === 'loading';
  return (
    <div className="flex min-w-0 flex-col">
      <label id={`${id}-label`} htmlFor={id} className={legendClass}>
        Agent
      </label>
      <Combobox
        id={id}
        labelId={`${id}-label`}
        size="md"
        floating
        value={loading ? '' : (value ?? '')}
        disabled={loading}
        onChange={(next) => onChange(next === '' ? null : next)}
        options={
          agents.status === 'loading'
            ? []
            : [
                { value: '', label: 'All agents' },
                ...agents.options.map((option) => ({ value: option.id, label: option.label })),
              ]
        }
        placeholder={loading ? 'Loading agents…' : 'All agents'}
        searchLabel="Search agents"
        listLabel="Agents"
        noun={['agent', 'agents']}
        className="mt-1 sm:w-56"
      />
    </div>
  );
}

function FacetGroup({
  legend,
  facets,
  dimension,
  termFor,
  onToggle,
}: {
  legend: string;
  facets: PhoneFacet[];
  dimension: 'status' | 'state';
  termFor: (value: string) => { label: string; tone: StatusTone };
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
      <div className="mt-1 flex gap-1.5 max-sm:-mx-4 max-sm:overflow-x-auto max-sm:px-4 max-sm:pb-1 sm:flex-wrap">
        {facets.map((facet) => {
          const term = termFor(facet.value);
          return (
            <button
              key={facet.value}
              type="button"
              aria-pressed={facet.active}
              onClick={() => onToggle(dimension, facet.value)}
              className={pillClass(facet.active)}
            >
              {/* A ring in the pill's own text colour when pressed: on the ink fill,
                  the darker marks would otherwise disappear. */}
              <span
                aria-hidden="true"
                className={cx(SWATCH, facet.active && 'ring-[1.5px] ring-surface')}
                style={{ backgroundColor: markVar(toneMark(term.tone)) }}
              />
              {term.label}
              <span className={cx('tabular-nums', facet.active ? 'text-white' : 'text-ink-tertiary')}>
                {facet.count}
              </span>
            </button>
          );
        })}
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
  reserveFilters = false,
}: PhoneFilterBarProps) {
  const anyActive = hasActivePhoneFilters(filters);
  const holding = !showFilters && reserveFilters;
  const engagements = holding ? HELD_FACETS : stateFacets;

  return (
    <GlassPanel
      level="ruled"
      padding="none"
      className="mb-4 divide-y divide-[var(--glass-ring)]"
      data-phone-toolbar=""
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 py-2.5">
        <div className="min-w-0">{header}</div>
        <fieldset className="min-w-0">
          {/* The two options name themselves; the legend is for the group. */}
          <legend className="sr-only">View</legend>
          <div className="inline-flex gap-0.5 rounded-control border border-[var(--control)] bg-surface p-0.5">
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

      {(showFilters || holding) && (
        <div aria-hidden={holding || undefined} className={cx('flex flex-col gap-3 py-3', holding && 'invisible')}>
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start sm:gap-x-6">
            <AgentPicker
              agents={holding ? { status: 'loading' } : agents}
              value={filters.agent}
              onChange={onAgentChange}
            />
            <FacetGroup
              legend="Appointment"
              facets={holding ? HELD_FACETS : statusFacets}
              dimension="status"
              termFor={appointmentStatusTerm}
              onToggle={onToggle}
            />
          </div>
          {(engagements.length > 0 || anyActive) && (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-x-6">
              <FacetGroup
                legend="Engagement"
                facets={engagements}
                dimension="state"
                termFor={engagementStateTerm}
                onToggle={onToggle}
              />
              {anyActive && !holding && (
                <Button
                  variant="ghost"
                  onClick={onClear}
                  className="self-start sm:ml-auto sm:self-end"
                >
                  Clear filters
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </GlassPanel>
  );
}
