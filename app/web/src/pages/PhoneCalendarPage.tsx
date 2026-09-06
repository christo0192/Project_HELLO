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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import type {
  MeResponse,
  PhoneAppointmentCancelInput,
  PhoneCandidateAppointmentCreateInput,
  PhoneAppointmentPatchInput,
  PhoneCalendarResponse,
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
  PhoneWeekTable,
  buildPhoneCalendarSearch,
  matchesPhoneFilters,
  parsePhoneCalendarFilters,
  phoneErrorMessage,
  phoneErrorRequiresRefresh,
  phoneFacets,
  togglePhoneFacet,
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

export function PhoneCalendarPage() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [meError, setMeError] = useState<string | null>(null);

  const [data, setData] = useState<PhoneCalendarResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const [refreshing, setRefreshing] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);

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

  const filters = parsePhoneCalendarFilters(searchParams, today);
  const filterKey = buildPhoneCalendarSearch(filters).toString();
  const { weekStart } = filters;

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

  const showAside = Boolean(selected) || canWrite;

  return (
    <div>
      <PageHeader
        eyebrow="Operations"
        title="Phone calendar"
        description="Internal phone screening schedule, in India Standard Time. Calls are placed within the approved calling window, every day of the week."
        actions={
          <>
            <Button size="lg" variant="secondary" onClick={reload}>
              Refresh
            </Button>
            <nav aria-label="Week" className="flex flex-wrap items-center gap-2">
              <Button
                size="lg"
                variant="secondary"
                onClick={() =>
                  applyFilters({ ...filters, weekStart: addIstDays(weekStart, -7) })
                }
              >
                Previous week
              </Button>
              <Button
                size="lg"
                variant="secondary"
                onClick={() => applyFilters({ ...filters, weekStart: today })}
              >
                This week
              </Button>
              <Button
                size="lg"
                variant="secondary"
                onClick={() =>
                  applyFilters({ ...filters, weekStart: addIstDays(weekStart, 7) })
                }
              >
                Next week
              </Button>
              <p className="text-[13px] font-medium text-ink-secondary">{weekLabel} IST</p>
            </nav>
          </>
        }
      />

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

      <div className="mt-6">
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
          <p aria-hidden="true" className="mb-3 text-[13px] text-ink-tertiary">
            Refreshing…
          </p>
        )}

        {!loadError && data && !data.enabled && (
          <Banner tone="warning">
            Phone screening is turned off. No schedule has been read, and no
            appointments can be booked while it stays off.
          </Banner>
        )}

        {!loadError && data && data.enabled && (
          <>
            {data.truncated && (
              <Banner tone="warning" className="mb-5">
                This week holds more appointments than one read returns, so the
                view below is incomplete. Narrow the week before drawing any
                conclusion from what is shown.
              </Banner>
            )}

            <PhoneFilterBar
              statusFacets={statusFacets}
              stateFacets={stateFacets}
              filters={filters}
              view={view}
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
              onClear={() => applyFilters({ ...filters, statuses: [], states: [] })}
            />

            {/*
              The week on the left, the inspector on the right. On a narrow
              viewport the inspector simply follows the list, so nothing is
              hidden behind a disclosure the operator has to find.
            */}
            <div
              className={cx(
                'grid grid-cols-1 gap-5',
                showAside && 'lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-start',
              )}
            >
              <div className="min-w-0">
                {appointments.length === 0 ? (
                  <GlassPanel padding="sm">
                    <EmptyPanel
                      title="No phone screenings this week"
                      hint={`Nothing is scheduled between ${weekLabel} IST.`}
                    />
                  </GlassPanel>
                ) : visible.length === 0 ? (
                  <GlassPanel padding="sm">
                    <EmptyPanel
                      title="No appointments match these filters"
                      hint={`This week has ${appointments.length} ${
                        appointments.length === 1 ? 'appointment' : 'appointments'
                      }, none of which match the filters above.`}
                    />
                  </GlassPanel>
                ) : view === 'week' ? (
                  <PhoneWeekTable
                    weekDates={weekDates}
                    appointments={visible}
                    window={data.window}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                    today={today}
                  />
                ) : (
                  <PhoneQueueList
                    weekDates={weekDates}
                    appointments={visible}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                    today={today}
                  />
                )}
              </div>

              {showAside && (
                <aside className="flex min-w-0 flex-col gap-5 lg:sticky lg:top-20">
                  {selected && (
                    <PhoneAppointmentDetail
                      key={selected.id}
                      appointment={selected}
                      canWrite={canWrite}
                      onReschedule={handleReschedule}
                      onCancel={handleCancel}
                      today={today}
                    />
                  )}
                  {canWrite && (
                    <PhoneBookingPanel onCreate={handleCreate} today={today} />
                  )}
                </aside>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
