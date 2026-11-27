/**
 * Meet bookings: the R1 interviews Lexy holds over Google Meet, booked by candidates on the public booking
 * link (M035) or scheduled by HR in Ashby (M034 S10), dark.
 *
 *   /interviews/meet-bookings?status=blocked&from=2026-11-24&to=2026-11-30
 *
 * It opens on every status, from today in India on, earliest slot first, which is the API's only order. An
 * empty `from` is no lower bound, and so is no `from` with a `to` before today (a From nobody chose never
 * refuses a To). Both days count, and are India days wherever the browser is
 * (lib/r1-meet-bookings). The API decides who sees which booking (`GET /api/interview-rounds/meet-bookings`).
 *
 * The server decides whether Meet is on, and this page only prints what it answered: there is nothing to
 * switch here. While it is off no booking is read or listed, so the filters go too. While it is on, a card
 * gives HR the public booking link to copy; it is static and asks nothing (MeetBookingsPublicLink).
 *
 * One read a visit, one per change of filter and one per "Load more". Nothing is read on a timer. A read
 * that changes what is shown clears the rows first: a list under the wrong filter reads as true. The next
 * page of the same list is added to it instead, and a failure there leaves the rows as they are. Dates that
 * cannot be asked for are said on their field, and nothing is asked.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Button, EmptyPanel, ErrorPanel, InlineNotice, RetryButton, Skeleton } from '../components/design';
import { MeetBookingsFilters } from '../components/r1/MeetBookingsFilters';
import { MeetBookingsPublicLink } from '../components/r1/MeetBookingsPublicLink';
import { MeetBookingsTable } from '../components/r1/MeetBookingsTable';
import { CandidateShell } from '../components/talent/CandidateShell';
import { apiErrorCopy } from '../lib/api-error-copy';
import { istToday } from '../lib/ist-datetime';
import {
  meetBookingsQuery,
  meetDateError,
  meetFiltersAreDefault,
  meetFiltersFrom,
  mergeMeetBookings,
} from '../lib/r1-meet-bookings';
import type { R1MeetBookingsBody } from '../lib/r1-meet-bookings';

const SKELETON_ROWS = 6;

type Load =
  | { status: 'loading' }
  | { status: 'ready'; key: string; body: R1MeetBookingsBody }
  | { status: 'error'; key: string; error: unknown };

/** The next page of the list on screen: on its way, or not to be had. */
type More = { status: 'loading'; key: string } | { status: 'failed'; key: string; error: unknown };

function statusOf(error: unknown): number {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : 0;
}

/** A 400 here is a filter the API refused, whatever code came with it. */
function failureWords(error: unknown): string {
  return statusOf(error) === 400 ? 'These filters were not accepted.' : apiErrorCopy(error);
}

const FOCUS_RING =
  'focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ink)]';

/** The rows at their final height, so the page does not move when the answer lands. */
function BookingsSkeleton() {
  return (
    <div role="status" aria-label="Loading Meet bookings" className="divide-y divide-line">
      {Array.from({ length: SKELETON_ROWS }, (_, index) => (
        <div key={index} className="flex h-16 items-center gap-6">
          <Skeleton width="22%" height={16} radius={3} />
          <Skeleton width="16%" height={16} radius={3} />
          <Skeleton width="26%" height={16} radius={3} />
        </div>
      ))}
    </div>
  );
}

export function R1MeetBookingsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  // Today is read with each address and not with each render: a tab can be left open past midnight, and
  // the list must not change under the person reading it.
  const filters = useMemo(() => meetFiltersFrom(searchParams, istToday()), [searchParams]);
  const { status, from, to } = filters;
  const isDefault = meetFiltersAreDefault(searchParams);
  const dateError = meetDateError(filters);

  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [more, setMore] = useState<More | null>(null);
  const [readKey, setReadKey] = useState(0);
  /** A later page that is not for the list now on screen is dropped. */
  const generation = useRef(0);

  const changeAddress = useCallback(
    (change: (params: URLSearchParams) => void) => {
      setSearchParams(
        (previous) => {
          const params = new URLSearchParams(previous);
          change(params);
          return params;
        },
        // Filtering a list is not a navigation: Back leaves the page.
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const requestKey = useMemo(() => JSON.stringify({ status, from, to, readKey }), [status, from, to, readKey]);

  useEffect(() => {
    if (dateError !== null) return undefined;
    let live = true;
    // It replaces the list, so a later page still on its way belongs to the one it replaced.
    const land = (next: Load) => {
      if (!live) return;
      generation.current += 1;
      setMore(null);
      setLoad(next);
    };
    Promise.resolve()
      .then(() => api.listR1MeetBookings(meetBookingsQuery({ status, from, to })))
      .then((body) => land({ status: 'ready', key: requestKey, body }))
      .catch((error: unknown) => land({ status: 'error', key: requestKey, error }));
    return () => {
      live = false;
      generation.current += 1;
    };
  }, [status, from, to, dateError, requestKey]);

  const current = load.status !== 'loading' && load.key === requestKey && dateError === null ? load : null;
  const body = current?.status === 'ready' ? current.body : null;
  const rows = body !== null && body.bookings.length > 0 ? body.bookings : null;
  const cursor = rows === null ? null : (body?.next_cursor ?? null);
  // The last answer's, through a change of filter: it is about the server and not about this list.
  const meetOn = load.status === 'ready' ? load.body.meet_enabled : null;
  const failed = current?.status === 'error' ? statusOf(current.error) : null;

  const moreHere = more?.key === requestKey ? more : null;
  const moreFailed = moreHere?.status === 'failed' ? moreHere : null;
  const moreStatus = moreFailed === null ? null : statusOf(moreFailed.error);

  const moreRef = useRef<HTMLButtonElement>(null);
  const countRef = useRef<HTMLParagraphElement>(null);
  const statusLineRef = useRef<HTMLParagraphElement>(null);
  /** Where focus goes once the answer to Load more is on the page. */
  const refocus = useRef<'list' | 'status line' | null>(null);

  useEffect(() => {
    const target = refocus.current;
    refocus.current = null;
    if (target === 'status line') statusLineRef.current?.focus();
    // No scroll: the rows that just arrived are above both.
    else if (target === 'list') (moreRef.current ?? countRef.current)?.focus({ preventScroll: true });
  }, [load, more]);

  const loadMore = () => {
    if (cursor === null) return;
    generation.current += 1;
    const mine = generation.current;
    // The button is off while it works, and may be gone after. Someone who has moved on keeps their place.
    const keepPlace = (target: 'list' | 'status line') => {
      const at = document.activeElement;
      if (at === null || at === document.body || at === moreRef.current) refocus.current = target;
    };
    setMore({ status: 'loading', key: requestKey });
    Promise.resolve()
      .then(() => api.listR1MeetBookings(meetBookingsQuery({ status, from, to }, cursor)))
      .then((next) => {
        if (mine !== generation.current) return;
        keepPlace(next.meet_enabled ? 'list' : 'status line');
        setMore(null);
        setLoad((shown) => {
          if (shown.status !== 'ready' || shown.key !== requestKey) return shown;
          if (!next.meet_enabled) return { ...shown, body: next };
          return { ...shown, body: { ...next, bookings: mergeMeetBookings(shown.body.bookings, next.bookings) } };
        });
      })
      .catch((error: unknown) => {
        if (mine !== generation.current) return;
        keepPlace('list');
        setMore({ status: 'failed', key: requestKey, error });
      });
  };

  const readAgain = useCallback(() => setReadKey((key) => key + 1), []);

  const setParam = (name: 'status' | 'from' | 'to', value: string | null) =>
    changeAddress((params) => {
      if (value === null) params.delete(name);
      else params.set(name, value);
    });

  const resetFilters = () =>
    changeAddress((params) => {
      params.delete('status');
      params.delete('from');
      params.delete('to');
    });

  /** Out of a refused read. A reset that changes what is asked reads by itself, and one that does not reads here. */
  const resetAndRead = () => {
    resetFilters();
    const opened = meetFiltersFrom(new URLSearchParams(), istToday());
    if (opened.status === status && opened.from === from && opened.to === to) readAgain();
  };

  const shown = rows?.length ?? 0;
  const countLine =
    rows === null
      ? ''
      : `Showing ${shown} ${shown === 1 ? 'booking' : 'bookings'}, earliest first.${cursor === null ? '' : ' More are available.'}`;

  return (
    <CandidateShell variant="inset">
      <nav aria-label="Breadcrumb" className="text-label text-ink-tertiary">
        <Link to="/interviews" className={`underline underline-offset-4 hover:text-ink-secondary ${FOCUS_RING}`}>
          R1 interviews
        </Link>{' '}
        <span aria-hidden="true">/</span> Meet bookings
      </nav>
      <h1 className="mt-1 text-title text-ink">Meet bookings</h1>
      <p className="mt-1 text-sm text-ink-secondary">
        Interviews with Lexy over Google Meet, booked by candidates on the public booking link or scheduled in
        Ashby. Times are India Standard Time.
      </p>
      <p ref={statusLineRef} tabIndex={-1} data-testid="meet-status" className={`mt-2 min-h-5 text-sm text-ink ${FOCUS_RING}`}>
        {meetOn !== null
          ? `Google Meet interviews are ${meetOn ? 'on' : 'off'}.`
          : current === null && dateError === null && <Skeleton width="14rem" height={16} radius={3} />}
      </p>

      {/* Shown only while the last answer says Meet is on, so the loading and off pages stay as they were. */}
      {meetOn === true && (
        <div className="mt-4">
          <MeetBookingsPublicLink />
        </div>
      )}

      {meetOn !== false && (
        <div className="mt-4">
          <MeetBookingsFilters
            filters={filters}
            dateError={dateError}
            canReset={!isDefault}
            onStatus={(next) => setParam('status', next)}
            // Emptied, it is said in the address: no `from` there is today.
            onFrom={(next) => setParam('from', next ?? '')}
            onTo={(next) => setParam('to', next)}
            onReset={resetFilters}
          />
        </div>
      )}

      <div className="mt-4">
        {dateError !== null ? null : current === null ? (
          <BookingsSkeleton />
        ) : current.status === 'error' ? (
          <ErrorPanel
            message={failureWords(current.error)}
            onRetry={failed === 403 ? undefined : failed === 400 ? resetAndRead : readAgain}
            retryLabel={failed === 400 ? 'Reset filters' : 'Try again'}
          />
        ) : !current.body.meet_enabled ? (
          // Under the line that says they are off.
          <EmptyPanel
            title="This page lists bookings only while they are on."
            hint="It is a server setting; R1 settings cannot change it."
          />
        ) : rows !== null ? (
          <MeetBookingsTable bookings={rows} />
        ) : isDefault ? (
          <EmptyPanel
            title="No Meet booking from today on."
            hint="A booking appears when a candidate books on the public booking link, or when an interview is scheduled in Ashby with Lexy as an interviewer."
          />
        ) : (
          <EmptyPanel
            title="No booking matches these filters."
            action={<RetryButton onRetry={resetFilters}>Reset filters</RetryButton>}
          />
        )}

        {moreFailed !== null && rows !== null && (
          <InlineNotice tone="warning" role="alert" className="mt-3">
            {moreStatus === 400
              ? 'The rest of this list couldn’t be read from here.'
              : `More bookings couldn’t load. ${apiErrorCopy(moreFailed.error)}`}
          </InlineNotice>
        )}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          {/* Always here, so a change in it is announced. */}
          <p ref={countRef} tabIndex={-1} aria-live="polite" className={`text-label text-ink-secondary ${FOCUS_RING}`}>
            {countLine}
          </p>
          {/* One button through all its words, so it keeps the focus it has. */}
          {cursor !== null && moreStatus !== 403 && (
            <Button
              ref={moreRef}
              variant="secondary"
              loading={moreHere?.status === 'loading'}
              onClick={(event) => {
                if (moreStatus !== 400) {
                  loadMore();
                  return;
                }
                // The list goes while it is read again, and this with it: the page keeps the focus.
                event.currentTarget.closest<HTMLElement>('[tabindex="-1"]')?.focus({ preventScroll: true });
                readAgain();
              }}
            >
              {moreFailed === null ? 'Load more' : moreStatus === 400 ? 'Start again from the first page' : 'Try again'}
            </Button>
          )}
        </div>
      </div>
    </CandidateShell>
  );
}
