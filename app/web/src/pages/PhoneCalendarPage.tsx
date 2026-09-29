/**
 * Internal phone screening calendar (P7).
 *
 * The operator surface over the P6 phone API: one week of appointments, read
 * two ways, with admin booking, rescheduling and cancellation.
 *
 * ── ROLE BEHAVIOUR, EXACTLY AS THE API ENFORCES IT ────────────────────
 * The API's rule is: reads need interviewer or above, every mutation needs
 * admin. This page mirrors that rule rather than approximating it.
 *
 *   admin       — reads, and sees the write controls.
 *   interviewer — reads, and sees NO write controls (not disabled ones).
 *   viewer      — sees a truthful "not available to your role" panel, and
 *                 NO phone API call is made at all. A viewer's browser never
 *                 asks for phone data, so there is nothing to leak and no 403
 *                 to explain.
 *
 * The route itself sits in the plain authenticated block, NOT behind
 * `requireRole`. That is deliberate: `ProtectedRoute`'s gate is exact
 * equality (`role !== requireRole`), so there is no "interviewer or above"
 * route gate to use — `requireRole="admin"` would lock interviewers out of a
 * page the API is happy to serve them. The gate therefore lives here, where
 * three roles can be told apart, and the API stays authoritative regardless.
 *
 * ── ONE READ PER WEEK ─────────────────────────────────────────────────
 * The week is the ONLY dimension the server knows about. Both views, every
 * facet filter and the selection are computed over the rows that one read
 * returned. Switching view or toggling a filter issues no request; a test
 * pins the call count.
 *
 * ── THE AGENT FILTER ──────────────────────────────────────────────────
 * Each row carries the role id of the pipeline its call belongs to, and the
 * Agent picker narrows to one role, client-side like every other filter. The
 * picker's NAMES come from one `api.listRoles()` read per mount, issued in
 * parallel with the calendar read: the API's own role scoping decides which
 * agents an operator can pick, and every one of them is offered, not only
 * those with a call this week. That read is optional — if it fails the
 * picker is simply absent and the calendar is untouched.
 *
 * ── NOTHING IS APPLIED OPTIMISTICALLY ─────────────────────────────────
 * Every mutation awaits the real API call and is followed by a re-read. The
 * calendar never shows a change the substrate has not accepted — on this
 * surface an optimistic row would be a call at a time nothing will dial.
 *
 * ── WHAT NEVER APPEARS HERE ───────────────────────────────────────────
 * No phone number in any form, no suppression digest, no SIP call id, no room
 * name, no participant identity, no egress id, no lease token, no provider
 * event id, no provider metadata, no transcript — in the DOM, in a log, in an
 * error string or in the URL. The API achieves that by omission (it never
 * selects those columns), and this page never reintroduces them: it renders
 * only the sanitized projection, and its error copy is an allowlist of mapped
 * codes rather than a passthrough of whatever a failure carried.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import type {
  MeResponse,
  PhoneAppointmentCancelInput,
  PhoneCandidateAppointmentCreateInput,
  PhoneAppointmentPatchInput,
  PhoneCalendarResponse,
  Role,
} from '../types';
import {
  Button,
  EmptyPanel,
  ErrorPanel,
  GlassPanel,
  LoadingPanel,
  PageHeader,
  cx,
} from '../components/design';
import {
  PHONE_STATE_ORDER,
  PHONE_STATUS_ORDER,
  PhoneAppointmentDetail,
  PhoneBookingPanel,
  PhoneFilterBar,
  PhoneQueueList,
  PhoneWeekNav,
  PhoneWeekTable,
  buildPhoneCalendarSearch,
  matchesPhoneFilters,
  parsePhoneCalendarFilters,
  phoneAgentOptions,
  phoneErrorMessage,
  phoneErrorRequiresRefresh,
  phoneFacets,
  resolvePhoneAgentFilter,
  togglePhoneFacet,
  type PhoneAgentChoices,
  type PhoneAgentRoster,
} from '../components/phone-calendar';
import { useNarrowViewport } from '../components/phone-calendar/useNarrowViewport';
import {
  addIstDays,
  formatIstDayLabel,
  istDayStartUtcIso,
  istToday,
  istWeekDates,
} from '../lib/ist-datetime';

interface Message {
  text: string;
  tone: 'ok' | 'error';
}

/** The optional roles read behind the Agent picker. */
type RolesState =
  | { status: 'loading' }
  | { status: 'ready'; roles: Role[] }
  | { status: 'failed' };

/**
 * A tinted, announced banner.
 *
 * Deliberately not `InlineNotice`: the announcement has to sit on the SAME
 * element as the text, because that is what a test pins and, more to the
 * point, what makes the tone and the words inseparable. Hue lives in the tint
 * and the dot; the words are ink, never the tone colour.
 */
function Banner({
  tone,
  children,
  className,
}: {
  tone: 'warning' | 'success' | 'danger';
  children: React.ReactNode;
  className?: string;
}) {
  const tint =
    tone === 'warning'
      ? 'bg-warning-soft'
      : tone === 'success'
        ? 'bg-success-soft'
        : 'bg-error-soft';
  const dot =
    tone === 'warning' ? 'bg-warning' : tone === 'success' ? 'bg-success' : 'bg-error';
  return (
    <div
      role="status"
      className={cx(
        'flex items-start gap-3 rounded-[14px] px-3.5 py-2.5 text-sm leading-6 text-ink',
        tint,
        className,
      )}
    >
      <span aria-hidden="true" className={cx('mt-1.5 h-2 w-2 shrink-0 rounded-full', dot)} />
      {children}
    </div>
  );
}

/**
 * The hint under "No calls for this agent this week" — shown only when an
 * agent is picked and none of the week's rows are theirs.
 *
 * A row with no role (`role_id: null` — a torn read, or an engagement that
 * carries none) belongs to NO agent. Counting it as "other agents'" sent the
 * operator looking through the picker for an agent that does not exist, so it
 * is counted, and named, on its own.
 */
function otherAgentsHint(
  appointments: ReadonlyArray<{ role_id: string | null }>,
  weekLabel: string,
): string {
  const calls = (n: number) => `${n} ${n === 1 ? 'call' : 'calls'}`;
  const others = appointments.filter((appt) => appt.role_id !== null).length;
  const unassigned = appointments.length - others;
  const seeThem = `Choose All agents to see ${appointments.length === 1 ? 'it' : 'them'}.`;
  if (unassigned === 0) {
    return `Other agents have ${calls(others)} between ${weekLabel} IST. ${seeThem}`;
  }
  if (others === 0) {
    return `${calls(unassigned)} between ${weekLabel} IST ${
      unassigned === 1 ? 'has' : 'have'
    } no agent. ${seeThem}`;
  }
  return `Other agents have ${calls(others)} between ${weekLabel} IST, and ${calls(
    unassigned,
  )} ${unassigned === 1 ? 'has' : 'have'} no agent. ${seeThem}`;
}

export function PhoneCalendarPage() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [meError, setMeError] = useState<string | null>(null);

  const [data, setData] = useState<PhoneCalendarResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const [refreshing, setRefreshing] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [rolesState, setRolesState] = useState<RolesState>({ status: 'loading' });
  const [bookingOpen, setBookingOpen] = useState(false);
  /**
   * Whether phone screening was ON at the last calendar read that answered.
   * `null` until one has.
   *
   * Booking is offered only when this is `true`. The flag is deployment-wide,
   * not per week, so it is kept across a week change (where `data` is blanked
   * while the next week loads) rather than making "Book a screening" blink
   * out and back, and closing a half-filled form, on every "Next week". A read
   * that FAILS leaves it as it was: the failure says nothing about the flag,
   * and the booking POST stays authoritative either way. A read that says
   * `enabled: false` withdraws booking at once, because every POST would come
   * back 503 `phone_screening_disabled` while the banner says so.
   */
  const [screeningOn, setScreeningOn] = useState<boolean | null>(null);

  /** The header's "Book a screening" button: focus returns here on close. */
  const bookButtonRef = useRef<HTMLButtonElement | null>(null);
  /** The views' container: the chip of a closed detail is found inside it. */
  const contentRef = useRef<HTMLDivElement | null>(null);
  const bookingPanelId = `phone-booking-${useId().replace(/:/g, '-')}`;

  /**
   * The live region is mounted for the whole life of the page and starts
   * empty. A `role="status"` element inserted into the DOM *together with*
   * its text is frequently not announced at all — the assistive technology
   * has to be observing the region before the text arrives. Rendering the
   * container unconditionally and only changing its contents is what makes
   * the announcement reliable.
   */
  const liveRegionRef = useRef<HTMLDivElement | null>(null);

  /** The week the currently-held `data` belongs to. */
  const loadedWeekRef = useRef<string | null>(null);

  const [searchParams, setSearchParams] = useSearchParams();
  const narrow = useNarrowViewport();

  // The IST "today" is captured once per mount. Re-deriving it on every
  // render would let a render that happens to straddle IST midnight move the
  // default week under the operator mid-interaction.
  const [today] = useState(() => istToday());

  const parsedFilters = parsePhoneCalendarFilters(searchParams, today);
  const { weekStart } = parsedFilters;

  const agentOptions = useMemo(
    () => (rolesState.status === 'ready' ? phoneAgentOptions(rolesState.roles) : []),
    [rolesState],
  );
  const agentRoster = useMemo<PhoneAgentRoster>(
    () =>
      rolesState.status === 'ready'
        ? new Set(agentOptions.map((option) => option.id))
        : rolesState.status === 'failed'
          ? 'unavailable'
          : 'loading',
    [rolesState, agentOptions],
  );

  // The filters actually in force: the URL's, with a deep-linked agent kept
  // only while it names a role this operator can see (see
  // `resolvePhoneAgentFilter`). Every control writes FROM these, so a stale
  // agent id leaves the URL at the operator's next click rather than lingering
  // as a filter nobody can see.
  const filters = resolvePhoneAgentFilter(parsedFilters, agentRoster);
  const filterKey = buildPhoneCalendarSearch(filters).toString();

  /**
   * On a narrow viewport the queue is the default, because a seven-column
   * grid there is not readable. An EXPLICIT `?view=` always wins: a deep link
   * someone sent deliberately must not be overridden by the recipient's
   * screen size.
   */
  const view = searchParams.has('view') ? filters.view : narrow ? 'queue' : 'week';

  const role = me?.role ?? null;
  const canRead = role === 'admin' || role === 'interviewer';
  const canWrite = role === 'admin';

  const loadMe = useCallback(() => {
    setMeError(null);
    setMe(null);
    api
      .getMe()
      .then(setMe)
      .catch((e: ApiError) => setMeError(e.message));
  }, []);

  useEffect(loadMe, [loadMe]);

  // The Agent picker's names. Issued alongside the calendar read (both effects
  // run on the commit that first makes `canRead` true), never by a viewer, and
  // never allowed to break the page: a failure only removes the picker.
  useEffect(() => {
    if (!canRead) return;
    let live = true;
    api
      .listRoles()
      .then((roles) => {
        if (live) setRolesState({ status: 'ready', roles: Array.isArray(roles) ? roles : [] });
      })
      .catch(() => {
        if (live) setRolesState({ status: 'failed' });
      });
    return () => {
      live = false;
    };
  }, [canRead]);

  useEffect(() => {
    // A viewer never asks the phone API anything.
    if (!canRead) return;

    // See `api.getPhoneCalendar`: an abort is indistinguishable from a
    // network failure by its error, so this latch — not the signal — decides
    // whether a settled promise still belongs to the current week.
    let live = true;
    const controller = new AbortController();

    // Blank the view ONLY when moving to a different week, where the held
    // rows genuinely no longer describe what is being shown. A re-read of the
    // SAME week (after a mutation) keeps the current rows on screen while it
    // runs, for two reasons: it does not destroy the control the operator
    // just activated and drop keyboard focus to the document body, and it
    // does not mount a second `role="status"` — the shared loading state is
    // itself a live region, and two of them talk over each other.
    const weekChanged = loadedWeekRef.current !== weekStart;
    if (weekChanged) {
      setData(null);
      loadedWeekRef.current = weekStart;
    } else {
      setRefreshing(true);
    }
    setLoadError(null);

    const from = istDayStartUtcIso(weekStart);
    const to = istDayStartUtcIso(addIstDays(weekStart, 7));
    api
      .getPhoneCalendar(from, to, controller.signal)
      .then((res) => {
        if (!live) return;
        setData(res);
        setScreeningOn(res.enabled);
        setRefreshing(false);
      })
      .catch((e: ApiError) => {
        if (!live) return;
        setLoadError(phoneErrorMessage(e));
        setRefreshing(false);
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [canRead, weekStart, reloadToken]);

  const reload = useCallback(() => {
    setReloadToken((n) => n + 1);
  }, []);

  const applyFilters = useCallback(
    (next: Parameters<typeof buildPhoneCalendarSearch>[0]) => {
      setSearchParams(buildPhoneCalendarSearch(next));
    },
    [setSearchParams],
  );

  const appointments = useMemo(() => data?.appointments ?? [], [data]);
  /** This week's rows in the selected agent's pipeline — every row for "All agents". */
  const agentRows = useMemo(
    () =>
      filters.agent === null
        ? appointments
        : appointments.filter((appt) => appt.role_id === filters.agent),
    [appointments, filters.agent],
  );
  const visible = useMemo(
    () => appointments.filter((appt) => matchesPhoneFilters(appt, filters)),
    // `filterKey` is the dep rather than `filters`, which is a fresh object
    // every render and would re-run this on every keystroke elsewhere.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [appointments, filterKey],
  );

  const statusFacets = useMemo(
    () => phoneFacets(appointments, PHONE_STATUS_ORDER, 'status', filters),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [appointments, filterKey],
  );
  const stateFacets = useMemo(
    () => phoneFacets(appointments, PHONE_STATE_ORDER, 'state', filters),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [appointments, filterKey],
  );

  const weekDates = useMemo(() => istWeekDates(weekStart), [weekStart]);
  const selected = visible.find((appt) => appt.id === selectedId) ?? null;

  /**
   * A chip is a toggle (`aria-pressed`): pressing the selected one again
   * un-presses it and closes its detail, which is what the state it announces
   * promises.
   */
  const toggleSelected = useCallback((id: string) => {
    setSelectedId((current) => (current === id ? null : id));
  }, []);

  /**
   * Closing the detail from its own Close button. Focus goes back to the
   * chip that opened it BEFORE the detail unmounts, so the focused button
   * disappearing never drops a keyboard user onto <body>.
   */
  const closeDetail = useCallback(() => {
    const id = selectedId;
    if (id) {
      const chip = Array.from(
        contentRef.current?.querySelectorAll<HTMLElement>('[data-appointment-id]') ?? [],
      ).find((el) => el.dataset.appointmentId === id);
      chip?.focus();
    }
    setSelectedId(null);
  }, [selectedId]);

  const closeBooking = useCallback(() => {
    setBookingOpen(false);
    bookButtonRef.current?.focus();
  }, []);

  /**
   * The one place a mutation becomes a response.
   *
   * Success and failure both end with the calendar re-read and a message in
   * the live region. A refusal that means "your view is stale" re-reads too,
   * so the operator's next attempt starts from what is actually there rather
   * than from the row that just lost a race.
   */
  const runMutation = useCallback(
    async (action: () => Promise<string>): Promise<boolean> => {
      setMessage(null);
      let ok = false;
      try {
        const text = await action();
        reload();
        setMessage({ text, tone: 'ok' });
        ok = true;
      } catch (e) {
        if (phoneErrorRequiresRefresh(e)) reload();
        setMessage({ text: phoneErrorMessage(e), tone: 'error' });
      }
      // Move focus to the outcome. The control that was activated may have
      // been inside a panel that has now collapsed, and without this the
      // focus ring lands on <body> — leaving a keyboard operator at the top
      // of the document with no idea what happened. The region is
      // programmatically focusable only (`tabIndex={-1}`), so it never
      // becomes a stop in the normal tab order.
      liveRegionRef.current?.focus();
      return ok;
    },
    [reload],
  );

  const handleCreate = useCallback(
    (candidateId: string, input: PhoneCandidateAppointmentCreateInput): Promise<boolean> =>
      runMutation(async () => {
        const res = await api.scheduleCandidatePhoneAppointment(candidateId, input);
        return res.prereqs_pending
          ? 'Appointment booked, but this cycle’s prerequisites are not met, so nothing will dial at that time until they are.'
          : 'Appointment booked.';
      }),
    [runMutation],
  );

  const handleReschedule = useCallback(
    (id: string, input: PhoneAppointmentPatchInput) =>
      runMutation(async () => {
        const res = await api.reschedulePhoneAppointment(id, input);
        return res.prereqs_pending
          ? 'Appointment moved, but this engagement’s prerequisites are not met, so nothing will dial at the new time until they are.'
          : 'Appointment moved. The previous slot has been superseded.';
      }),
    [runMutation],
  );

  const handleCancel = useCallback(
    (id: string, input: PhoneAppointmentCancelInput) =>
      runMutation(async () => {
        const res = await api.cancelPhoneAppointment(id, input);
        return res.already_cancelled
          ? 'This appointment was already cancelled; nothing changed.'
          : 'Appointment cancelled.';
      }),
    [runMutation],
  );

  // ── Gates before any phone data is requested or rendered ────────────

  if (meError) return <ErrorPanel message={meError} onRetry={loadMe} />;
  if (!me) return <LoadingPanel label="Checking access…" />;

  if (!canRead) {
    return (
      <div>
        <PageHeader
          eyebrow="Operations"
          title="Phone calendar"
          description="Internal phone screening schedule."
        />
        <GlassPanel padding="sm" className="mt-6">
          <EmptyPanel
            title="Not available to your role"
            hint="The phone screening calendar is available to interviewers and admins. Nothing about the schedule has been loaded for this account."
          />
        </GlassPanel>
      </div>
    );
  }

  const weekLabel = `${formatIstDayLabel(weekStart)} – ${formatIstDayLabel(
    addIstDays(weekStart, 6),
  )}`;

  const agentChoices: PhoneAgentChoices =
    rolesState.status === 'ready'
      ? { status: 'ready', options: agentOptions }
      : rolesState.status === 'failed'
        ? { status: 'unavailable', requested: parsedFilters.agent !== null }
        : { status: 'loading' };

  const ready = !loadError && data !== null && data.enabled;

  /**
   * "Book a screening" and its form. Admin only, as before, AND only once a
   * read has said phone screening is on: the banner below tells the operator
   * nothing can be booked while it is off, so the page must not then open a
   * form whose every submit is refused. (Before the booking form moved up
   * under the header it lived inside the enabled-only subtree, which is what
   * enforced this.) See `screeningOn` for why this is not simply `ready`.
   */
  const canBook = canWrite && screeningOn === true;

  /**
   * Where the selected appointment's detail goes. In the week grid it opens
   * INLINE, as a row under the band that holds it (see `PhoneWeekTable`) —
   * except on a phone, where the grid scrolls sideways and a row inside it
   * would scroll away with it, so the detail follows the grid instead. The
   * queue is a single column, so its detail sits beside it on a wide screen
   * and after it on a narrow one.
   */
  const inlineDetail = !narrow;
  const detailProps = selected
    ? {
        appointment: selected,
        canWrite,
        onReschedule: handleReschedule,
        onCancel: handleCancel,
        today,
        onClose: closeDetail,
      }
    : null;

  return (
    <div>
      <PageHeader
        eyebrow="Operations"
        title="Phone calendar"
        description="Phone screenings in India Standard Time. Calls go out only within the approved calling window."
        actions={
          canBook ? (
            // The page's one primary action. It discloses the booking form
            // directly below the header, so focus stays here when it opens.
            <Button
              ref={bookButtonRef}
              size="lg"
              variant="primary"
              aria-expanded={bookingOpen}
              aria-controls={bookingOpen ? bookingPanelId : undefined}
              onClick={() => setBookingOpen((open) => !open)}
            >
              Book a screening
            </Button>
          ) : undefined
        }
      />

      {canBook && bookingOpen && (
        <div className="mt-6">
          <PhoneBookingPanel
            id={bookingPanelId}
            onCreate={handleCreate}
            onClose={closeBooking}
            today={today}
          />
        </div>
      )}

      {/*
        The live region. It is visible AND announced: one element, so a
        sighted operator and a screen-reader user are told the same thing at
        the same moment, and there is no second copy to drift out of step.
        `role="status"` is implicitly polite — it waits for a pause rather
        than interrupting, which is right for the outcome of an action the
        operator just took.
      */}
      <div
        ref={liveRegionRef}
        role="status"
        tabIndex={-1}
        className={
          message
            ? cx(
                'mt-5 rounded-[14px] px-3.5 py-2.5 text-sm leading-6 text-ink',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-info',
                message.tone === 'ok' ? 'bg-success-soft' : 'bg-error-soft',
              )
            : 'sr-only'
        }
      >
        {message?.text ?? ''}
      </div>

      {/*
        The toolbar is rendered in every state past the role gate, so the week
        controls never unmount while a new week loads — a keyboard user
        pressing "Next week" twice keeps focus on it. Only the filter band
        waits for rows to filter.
      */}
      <div className="mt-6">
        <PhoneFilterBar
          header={
            <PhoneWeekNav
              weekStart={weekStart}
              today={today}
              onPrevious={() =>
                applyFilters({ ...filters, weekStart: addIstDays(weekStart, -7) })
              }
              onThisWeek={() => applyFilters({ ...filters, weekStart: today })}
              onNext={() => applyFilters({ ...filters, weekStart: addIstDays(weekStart, 7) })}
              onRefresh={reload}
            />
          }
          showFilters={ready}
          statusFacets={statusFacets}
          stateFacets={stateFacets}
          filters={filters}
          view={view}
          agents={agentChoices}
          onAgentChange={(agent) => applyFilters({ ...filters, agent })}
          onViewChange={(next) => {
            // An explicit choice must always land in the URL — the
            // builder omits defaults, and on a narrow viewport the
            // default is "queue", so "week" would otherwise be a no-op.
            const params = buildPhoneCalendarSearch({ ...filters, view: next });
            params.set('view', next);
            setSearchParams(params);
          }}
          onToggle={(dimension, value) =>
            applyFilters(togglePhoneFacet(filters, dimension, value))
          }
          onClear={() =>
            applyFilters({ ...filters, agent: null, statuses: [], states: [] })
          }
        />
      </div>

      <div ref={contentRef}>
        {loadError && <ErrorPanel message={loadError} onRetry={reload} />}

        {!loadError && data === null && (
          <LoadingPanel label="Loading the phone calendar…" />
        )}

        {/*
          A re-read of the SAME week keeps the rows on screen, so this is a
          quiet marker rather than a blanking spinner. It is deliberately NOT
          a live region: the outcome message above is what should be
          announced, and a second one would talk over it.
        */}
        {!loadError && data !== null && refreshing && (
          <p aria-hidden="true" className="mb-3 text-label text-ink-tertiary">
            Refreshing…
          </p>
        )}

        {!loadError && data && !data.enabled && (
          <Banner tone="warning">
            Phone screening is turned off. No schedule has been read, and no
            appointments can be booked while it stays off.
          </Banner>
        )}

        {ready && (
          <>
            {data.truncated && (
              <Banner tone="warning" className="mb-5">
                This week holds more appointments than one read returns, so the
                view below is incomplete. Narrow the week before drawing any
                conclusion from what is shown.
              </Banner>
            )}

            {appointments.length === 0 ? (
              <GlassPanel padding="sm">
                <EmptyPanel
                  title="No phone screenings this week"
                  hint={`Nothing is scheduled between ${weekLabel} IST.`}
                />
              </GlassPanel>
            ) : agentRows.length === 0 ? (
              <GlassPanel padding="sm">
                <EmptyPanel
                  title="No calls for this agent this week"
                  hint={otherAgentsHint(appointments, weekLabel)}
                />
              </GlassPanel>
            ) : visible.length === 0 ? (
              <GlassPanel padding="sm">
                <EmptyPanel
                  title="No appointments match these filters"
                  hint={`This week has ${agentRows.length} ${
                    agentRows.length === 1 ? 'appointment' : 'appointments'
                  }${
                    filters.agent === null ? '' : ' for this agent'
                  }, none of which match the filters above.`}
                />
              </GlassPanel>
            ) : view === 'week' ? (
              <>
                {/*
                  The grid takes the full content width: seven days at 1280px
                  and up, with nothing beside it.
                */}
                <PhoneWeekTable
                  weekDates={weekDates}
                  appointments={visible}
                  window={data.window}
                  selectedId={selectedId}
                  onSelect={toggleSelected}
                  today={today}
                  detail={
                    inlineDetail && detailProps ? (
                      <PhoneAppointmentDetail
                        key={detailProps.appointment.id}
                        variant="inline"
                        {...detailProps}
                      />
                    ) : undefined
                  }
                />
                {!inlineDetail && detailProps && (
                  <div className="mt-5">
                    <PhoneAppointmentDetail key={detailProps.appointment.id} {...detailProps} />
                  </div>
                )}
              </>
            ) : (
              /*
                The queue is one column of rows, so it does not need the full
                width: on a wide screen the detail sits beside it (sticky, so
                it stays in view while the list scrolls), and on a narrow one
                it follows the list.
              */
              <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-start">
                <PhoneQueueList
                  weekDates={weekDates}
                  appointments={visible}
                  selectedId={selectedId}
                  onSelect={toggleSelected}
                  today={today}
                />
                {detailProps ? (
                  <aside className="min-w-0 lg:sticky lg:top-6">
                    <PhoneAppointmentDetail key={detailProps.appointment.id} {...detailProps} />
                  </aside>
                ) : (
                  <p className="glass-sunken hidden px-5 py-4 text-label text-ink-secondary lg:block">
                    {canWrite
                      ? 'Select an appointment to see its details, reschedule it or cancel it.'
                      : 'Select an appointment to see its details.'}
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
