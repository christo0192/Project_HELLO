/**
 * URL-addressable contract for the phone calendar.
 *
 * Five dimensions live in the query string so an operator can bookmark a
 * week, send a colleague "the missed calls on this date", and use browser
 * back/forward without losing their place:
 *
 *   `week`   — the IST date of the Monday the grid starts on.
 *   `view`   — `week` (the grid) or `queue` (the chronological list).
 *   `agent`  — one role id: only calls in that agent's (role's) pipeline.
 *   `status` — comma-separated appointment statuses.
 *   `state`  — comma-separated engagement states.
 *
 * ── FILTERING ADDS NO REQUESTS ────────────────────────────────────────
 * `week` is the only dimension the API knows about: it decides the `from`/`to`
 * bounds of the ONE calendar read. `view`, `agent`, `status` and `state` are
 * applied client-side over the rows that read already returned. Changing them
 * re-runs no effect and issues no request — a test pins that, because a
 * filter that quietly refetches is how a list view becomes an N+1.
 *
 * ── UNKNOWN VALUES ARE DROPPED, NOT ECHOED ────────────────────────────
 * A hand-edited `?status=nonsense` parses to "no status filter" rather than
 * to a filter matching nothing. An operator who mistypes a link should see
 * the week, not an empty grid that looks like an outage. `agent` follows the
 * same rule twice: a value that is not a role id's SHAPE is dropped at parse
 * (so no free text reaches the URL), and a well-formed id that names no role
 * this operator can see is dropped by `resolvePhoneAgentFilter` once the
 * roles have loaded.
 */

import type {
  PhoneAppointmentStatus,
  PhoneCalendarAppointment,
  PhoneEngagementState,
  Role,
} from '../../types';
import { isIstDate, istWeekStart, type IstDate } from '../../lib/ist-datetime';
import { uniqueAgentLabels } from '../../lib/role-label';

/** Appointment statuses, in the order the filter offers them. */
export const PHONE_STATUS_ORDER = [
  'scheduled',
  'confirmed',
  'fulfilled',
  'missed',
  'cancelled',
  'superseded',
] as const satisfies ReadonlyArray<PhoneAppointmentStatus>;

/** Engagement states, in lifecycle order: pre-call, live, then terminal. */
export const PHONE_STATE_ORDER = [
  'pending_prereqs',
  'eligible',
  'scheduled',
  'dialing',
  'in_call',
  'reconnecting',
  'awaiting_retry',
  'completed',
  'abandoned_no_answer',
  'opted_out',
  'wrong_number',
  'failed',
  'cancelled',
] as const satisfies ReadonlyArray<PhoneEngagementState>;

const STATUS_SET = new Set<string>(PHONE_STATUS_ORDER);
const STATE_SET = new Set<string>(PHONE_STATE_ORDER);

/**
 * The SHAPE of a role id (a Postgres uuid). Checked before anything else looks
 * at the value, so the `agent` parameter is a closed shape like every other
 * parameter here — never free text echoed back into a link.
 */
const ROLE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type PhoneCalendarView = 'week' | 'queue';

export interface PhoneCalendarFilters {
  /** The Monday the grid starts on, IST. Never null — see `parse`. */
  weekStart: IstDate;
  view: PhoneCalendarView;
  /** The selected agent's role id (null = all agents). */
  agent: string | null;
  /** Selected appointment statuses (empty = all). */
  statuses: string[];
  /** Selected engagement states (empty = all). */
  states: string[];
}

function parseCsv(raw: string | null, allowed: ReadonlyArray<string>, set: Set<string>): string[] {
  if (!raw) return [];
  const requested = new Set(
    raw
      .split(',')
      .map((x) => x.trim())
      .filter((x) => set.has(x)),
  );
  // Canonical order, not the order the caller happened to type, so the same
  // filter always produces the same URL and the same cache key.
  return allowed.filter((value) => requested.has(value));
}

/**
 * Parse filters from URL search params.
 *
 * `week` is normalized to the Monday of whatever IST date it names, so
 * `?week=2026-08-26` (a Wednesday) resolves to the same grid as
 * `?week=2026-08-24`, and a malformed or absent value falls back to the week
 * containing `today`. There is no "no week" state: the grid always shows a
 * real week rather than an empty frame waiting for a parameter.
 */
export function parsePhoneCalendarFilters(
  params: URLSearchParams,
  today: IstDate,
): PhoneCalendarFilters {
  const rawWeek = params.get('week');
  const anchor = rawWeek && isIstDate(rawWeek) ? rawWeek : today;
  const rawView = params.get('view');
  const rawAgent = params.get('agent')?.trim().toLowerCase() ?? '';
  return {
    weekStart: istWeekStart(anchor),
    view: rawView === 'queue' ? 'queue' : 'week',
    agent: ROLE_ID.test(rawAgent) ? rawAgent : null,
    statuses: parseCsv(params.get('status'), PHONE_STATUS_ORDER, STATUS_SET),
    states: parseCsv(params.get('state'), PHONE_STATE_ORDER, STATE_SET),
  };
}

/**
 * Build search params from filters, in a stable canonical order.
 *
 * The default view is omitted rather than written as `view=week`: a URL
 * should carry what an operator chose, not restate the default, or every
 * plain visit produces a link that looks like a deliberate selection.
 */
export function buildPhoneCalendarSearch(filters: PhoneCalendarFilters): URLSearchParams {
  const params = new URLSearchParams();
  params.set('week', filters.weekStart);
  if (filters.view === 'queue') params.set('view', 'queue');
  if (filters.agent !== null) params.set('agent', filters.agent);
  if (filters.statuses.length > 0) params.set('status', filters.statuses.join(','));
  if (filters.states.length > 0) params.set('state', filters.states.join(','));
  return params;
}

/** True when any dimension other than the week is narrowing the view. */
export function hasActivePhoneFilters(filters: PhoneCalendarFilters): boolean {
  return filters.agent !== null || filters.statuses.length > 0 || filters.states.length > 0;
}

/** Client-side predicate over an already-loaded row. */
export function matchesPhoneFilters(
  appt: PhoneCalendarAppointment,
  filters: PhoneCalendarFilters,
): boolean {
  // A row whose role is unknown (a torn read, or an engagement with no role)
  // cannot satisfy an agent filter, for the same reason as the state rule
  // below: matching it would claim a pipeline the API did not report.
  if (filters.agent !== null && appt.role_id !== filters.agent) return false;
  if (filters.statuses.length > 0 && !filters.statuses.includes(appt.status)) {
    return false;
  }
  if (filters.states.length > 0) {
    // A torn read leaves `engagement_state` null. It cannot satisfy a state
    // filter — matching it would claim a state the API declined to report.
    if (appt.engagement_state === null) return false;
    if (!filters.states.includes(appt.engagement_state)) return false;
  }
  return true;
}

export interface PhoneFacet {
  value: string;
  count: number;
  /** True when this facet is currently selected. */
  active: boolean;
}

/**
 * Facets for one dimension, counted over the week's rows.
 *
 * ── WHY ZERO-COUNT FACETS ARE HIDDEN ──────────────────────────────────
 * A filter chip that matches nothing is a dead control: pressing it empties
 * the view and teaches the operator nothing. So a facet with a count of zero
 * is omitted — with ONE exception. A facet that is currently ACTIVE is always
 * kept, even at zero, because a deep link like `?status=missed` in a week
 * with no missed calls must still show the chip that is doing the filtering.
 * Without that exception the operator would see an empty grid and no visible
 * cause, and no way to switch the filter off short of editing the URL.
 *
 * Counts are computed against the OTHER dimensions' filters, so the numbers
 * describe what selecting the facet would actually yield rather than what the
 * unfiltered week contains.
 */
export function phoneFacets(
  appointments: ReadonlyArray<PhoneCalendarAppointment>,
  order: ReadonlyArray<string>,
  dimension: 'status' | 'state',
  filters: PhoneCalendarFilters,
): PhoneFacet[] {
  const selected = dimension === 'status' ? filters.statuses : filters.states;
  // Neutralize this dimension so a chip's count is not suppressed by itself.
  const others: PhoneCalendarFilters =
    dimension === 'status' ? { ...filters, statuses: [] } : { ...filters, states: [] };

  const counts = new Map<string, number>();
  for (const appt of appointments) {
    if (!matchesPhoneFilters(appt, others)) continue;
    const key = dimension === 'status' ? appt.status : appt.engagement_state;
    if (key === null) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return order
    .map((value) => ({
      value,
      count: counts.get(value) ?? 0,
      active: selected.includes(value),
    }))
    .filter((facet) => facet.count > 0 || facet.active);
}

/** Toggle one value of one dimension, preserving every other dimension. */
export function togglePhoneFacet(
  filters: PhoneCalendarFilters,
  dimension: 'status' | 'state',
  value: string,
): PhoneCalendarFilters {
  const key = dimension === 'status' ? 'statuses' : 'states';
  const current = filters[key];
  const next = current.includes(value)
    ? current.filter((v) => v !== value)
    : [...current, value];
  const order = dimension === 'status' ? PHONE_STATUS_ORDER : PHONE_STATE_ORDER;
  return { ...filters, [key]: order.filter((v) => next.includes(v)) };
}

// ══════════════════════════════════════════════════════════════════════
//  The agent dimension
// ══════════════════════════════════════════════════════════════════════

/**
 * What is known about the roles the `agent` parameter can name.
 *
 *   `'loading'`     — the roles read has not settled yet.
 *   `'unavailable'` — it failed; the calendar carries on without the filter.
 *   a set of ids    — every role this operator can see.
 */
export type PhoneAgentRoster = 'loading' | 'unavailable' | ReadonlySet<string>;

/**
 * The filters with the `agent` dimension resolved against the roster.
 *
 * ── A FILTER IS NEVER APPLIED WITHOUT ITS CONTROL ─────────────────────
 * Once the roles are known, a deep-linked agent is kept only if it names one
 * of them. A stale or foreign id falls back to "All agents" — the week, not
 * an empty grid narrowed by a filter the dropdown cannot show or switch off.
 * If the roles cannot be read at all there is no dropdown, so the agent
 * filter is dropped for the same reason.
 *
 * While the roles are still LOADING the requested agent is kept: a valid link
 * (the ordinary case) then shows its agent's calls from the first paint
 * instead of flashing the whole week and narrowing a moment later.
 */
export function resolvePhoneAgentFilter(
  filters: PhoneCalendarFilters,
  roster: PhoneAgentRoster,
): PhoneCalendarFilters {
  if (filters.agent === null || roster === 'loading') return filters;
  if (roster !== 'unavailable' && roster.has(filters.agent)) return filters;
  return { ...filters, agent: null };
}

/** One option of the agent dropdown. */
export interface PhoneAgentOption {
  /** The role id — what the filter and the URL carry. */
  id: string;
  /** The agent name, else the role title; duplicates are suffixed ` (2)`. */
  label: string;
}

/**
 * The agent dropdown's options: every role the operator can see, labelled by
 * `uniqueAgentLabels` (so two roles never show the same text) and sorted by
 * that label. The id breaks any tie so the order is stable.
 */
export function phoneAgentOptions(
  roles: ReadonlyArray<Pick<Role, 'id' | 'title' | 'agent_name'>>,
): PhoneAgentOption[] {
  const labels = uniqueAgentLabels(roles);
  return roles
    .map((role) => ({ id: role.id, label: labels.get(role.id) ?? role.title }))
    .sort(
      (a, b) =>
        a.label.localeCompare(b.label, undefined, { sensitivity: 'base', numeric: true }) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
}
