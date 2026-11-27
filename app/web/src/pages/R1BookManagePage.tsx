import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { R1BookErrorSummary, type R1BookErrorItem } from '../components/candidate-r1/R1BookErrorSummary';
import { R1BookNotice } from '../components/candidate-r1/R1BookNotice';
import { R1BookSlotPicker } from '../components/candidate-r1/R1BookSlotPicker';
import { R1BookStatusCard } from '../components/candidate-r1/R1BookStatusCard';
import { R1_BOOK_COPY, R1_BOOK_MANAGE_COPY } from '../components/candidate-r1/r1-book-copy';
import { R1Shell } from '../components/candidate-r1/R1Screens';
import { Button } from '../components/ui';
import { istDateOf } from '../lib/ist-datetime';
import {
  classifyBookFailure,
  r1BookApi,
  type R1BookConsentInput,
  type R1BookFailure,
  type R1BookGrid,
  type R1BookManageView,
  type R1BookSlot,
} from '../lib/r1/r1-book-api';
import {
  R1_BOOK_GRID_MIN_AGE_MS,
  R1_BOOK_UNSTAMPED,
  bookStamp,
  findBookSlot,
  firstOpenDay,
  formatBookSlot,
  gridDecision,
  r1BookClock,
  validateConsentOnly,
  type BookConsentErrors,
  type R1BookStamp,
} from '../lib/r1/r1-book';
import { captureManageToken } from '../lib/r1/r1-book-link';

/**
 * The manage page, `/book/manage#m=<token>` (M035 S07): the link in Dex's calendar invite. The
 * person sees their interview time and can change it, cancel it (and withdraw their consent),
 * or agree again when the notice changed after they booked.
 *
 * Invariants (S07-PLAN.md section 3):
 *   - Manage token (D-S07-M14). Read from the `#m=` fragment only and accepted only as 43
 *     base64url characters (`captureManageToken`), which also resets the address bar to
 *     `/book/manage` at once, whatever the fragment held. The token is kept in a ref: never
 *     state, the DOM, web storage or a URL; it travels only in the JSON body of a POST. A missing
 *     or malformed token shows "This link is no longer active" and calls nothing. StrictMode's
 *     double effect still reads the booking exactly once (`startedRef`).
 *   - After a move the token is spent (D-S07-M15). The move's updated invite carries a new manage
 *     link, so the moved card shows the new time and offers no further action; so does the
 *     cancelled card. After agreeing again (no new link) the page reads the booking ONCE more:
 *     the manage route is throttled, so it never polls.
 *   - Re-consent first (D-S07-M16). When `consent_current` is false the notice and its boxes come
 *     first, with move and cancel still below when the server allows them. `consent_stale`
 *     (the notice changed again while the page was open) reads the notice again and clears every
 *     box, India included; the refusal's own `template_version` is ignored (D-S07-M19).
 *   - Cancel and withdraw (D-S07-M17). "Cancel my interview" opens an inline confirm panel (not a
 *     modal) with an unticked "also withdraw" box; `withdraw_consent` is exactly that box.
 *     `cancelled` and `already_cancelled` read the same.
 *   - Move (D-S07-M5, D-S07-M6, D-S07-M18). The picker never offers the booking's own time. Before
 *     a move the page reads again a grid older than 25 minutes (the larger age of its monotonic
 *     and wall clocks: a phone's monotonic clock may pause in sleep) and does not post a time
 *     that grid no longer offers; it never posts a grid younger than 3.5 s by the monotonic clock
 *     (one wait, never a loop).
 *   - Errors are the closed words of `classifyBookFailure`: `not_found` reads as "no longer
 *     active", 503 `booking_disabled` as "online changes are not available", a refused move or
 *     cancel as "no longer possible". A change the server may have made (a dropped request, a
 *     gateway error, a malformed answer) reads as "we could not confirm your change", whose "Try
 *     again" repeats the same change; every other failure is "temporarily unavailable".
 *   - Nothing about the person is shown or kept: the server sends no name, email address or Meet
 *     link, and the page never stores anything, never writes the URL beyond the one strip and
 *     never logs. Every button is `type="button"`; there is no form to submit natively.
 *   - Copy: every string is a constant of r1-book-copy.ts, the tab title included (WCAG 2.4.2;
 *     the previous title comes back when the page unmounts).
 */

type ManageTemplate = Awaited<ReturnType<typeof r1BookApi.consentTemplate>>;

/** What a "Try again" repeats. */
type RetryAction =
  | { kind: 'manage' }
  | { kind: 'notice' }
  | { kind: 'slots' }
  | { kind: 'move'; slotStart: string }
  | { kind: 'cancel'; withdraw: boolean }
  | { kind: 'consent'; consent: R1BookConsentInput };

type StageBody =
  | { name: 'loading' }
  | { name: 'inactive' }
  | { name: 'view' }
  | { name: 'moved'; startAt: string; endAt: string }
  | { name: 'cancelled'; withdrew: boolean }
  | { name: 'not_allowed' }
  | { name: 'disabled' }
  | { name: 'unavailable'; retry: RetryAction }
  | { name: 'uncertain'; retry: RetryAction };

/** `seq` keys each result card, so every new result mounts its own card and focuses its heading. */
type Stage = StageBody & { seq: number };

type Panel = 'none' | 'move' | 'cancel';

/** A focus move for the next commit (a layout effect): the first of `targets` that exists. */
interface FocusRequest {
  targets: readonly string[];
  seq: number;
}

const SUMMARY = 'summary';
const TITLE_ID = 'r1-manage-title';
const RECONSENT_TITLE_ID = 'r1-manage-reconsent-title';
const NOTICE_CHANGED_ID = 'r1-manage-notice-changed';
const MOVE_OPEN_ID = 'r1-manage-move-open';
const MOVES_LEFT_ID = 'r1-manage-moves-left';
const MOVE_TITLE_ID = 'r1-manage-move-title';
const SLOT_FIRST_ID = 'r1-manage-slot-first';
const CANCEL_OPEN_ID = 'r1-manage-cancel-open';
const CANCEL_TITLE_ID = 'r1-manage-cancel-title';
const WITHDRAW_ID = 'r1-manage-withdraw';
const IN_INDIA_ID = 'r1-manage-in-india';

const isTicked = (consents: Readonly<Record<string, boolean>>, type: string): boolean =>
  Object.prototype.hasOwnProperty.call(consents, type) && consents[type] === true;

/** A time the person may move to: the server offers it and it is not the booking's own. */
const pickable = (slot: R1BookSlot, currentStart: string | null): boolean =>
  slot.available && slot.start_at !== currentStart;

/** The day to show: the current one while it still has a pickable time, else the first that has one. */
function dayFor(grid: R1BookGrid, current: string | null, currentStart: string | null): string | null {
  const kept = grid.days.find((entry) => entry.date === current);
  if (kept && kept.slots.some((slot) => pickable(slot, currentStart))) return kept.date;
  const open = grid.days.find((entry) => entry.slots.some((slot) => pickable(slot, currentStart)));
  return open?.date ?? firstOpenDay(grid);
}

export function R1BookManagePage() {
  const [stage, setStage] = useState<Stage>({ name: 'loading', seq: 0 });
  const [view, setView] = useState<R1BookManageView | null>(null);
  const [panel, setPanel] = useState<Panel>('none');
  const [template, setTemplate] = useState<ManageTemplate | null>(null);
  const [consents, setConsents] = useState<Readonly<Record<string, boolean>>>({});
  const [inIndia, setInIndia] = useState(false);
  const [consentErrors, setConsentErrors] = useState<BookConsentErrors>({});
  const [consentNotice, setConsentNotice] = useState<string | null>(null);
  const [consentDone, setConsentDone] = useState(false);
  const [grid, setGrid] = useState<R1BookGrid | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [moveSlot, setMoveSlot] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [slotNotice, setSlotNotice] = useState<string | null>(null);
  const [withdraw, setWithdraw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState('');
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);

  /** The manage token: in memory only, never state, the DOM, storage or a URL (D-S07-M14). */
  const tokenRef = useRef<string | null>(null);
  const mountedRef = useRef(false);
  /** The booking has been read for this page: StrictMode's second effect run must not repeat it. */
  const startedRef = useRef(false);
  const stageSeqRef = useRef(0);
  const focusSeqRef = useRef(0);
  /** Only the newest grid read for the move panel may write its answer. */
  const slotsSeqRef = useRef(0);
  const viewRef = useRef<R1BookManageView | null>(null);
  const gridRef = useRef<R1BookGrid | null>(null);
  /** Both clocks when the shown grid was received (D-S07-M5). */
  const gridReceivedAtRef = useRef<R1BookStamp>(R1_BOOK_UNSTAMPED);
  const busyRef = useRef(false);
  const summaryRef = useRef<HTMLDivElement>(null);

  const show = (next: StageBody): void => {
    stageSeqRef.current += 1;
    setStage({ ...next, seq: stageSeqRef.current });
  };

  const requestFocus = (...targets: string[]): void => {
    focusSeqRef.current += 1;
    setFocusRequest({ targets, seq: focusSeqRef.current });
  };

  // A layout effect, so focus lands in the same commit that shows its target (as the cards do).
  useLayoutEffect(() => {
    if (!focusRequest) return;
    for (const target of focusRequest.targets) {
      const element = target === SUMMARY ? summaryRef.current : document.getElementById(target);
      if (element) {
        element.focus();
        return;
      }
    }
  }, [focusRequest]);

  const keepView = (next: R1BookManageView | null): void => {
    viewRef.current = next;
    setView(next);
  };

  const receiveGrid = (next: R1BookGrid | null): void => {
    gridRef.current = next;
    if (next) gridReceivedAtRef.current = bookStamp();
    setGrid(next);
  };

  /** The link has done its job: forget the token, so nothing can be sent with it again. */
  const spendToken = (): void => {
    tokenRef.current = null;
    keepView(null);
    setPanel('none');
  };

  /** Where a refusal or a failure leads; `retry` is what that card's "Try again" repeats. */
  const showFailure = (failure: R1BookFailure, retry: RetryAction): void => {
    setLive('');
    setPanel('none');
    switch (failure) {
      case 'not_found':
        spendToken();
        show({ name: 'inactive' });
        return;
      case 'disabled':
        show({ name: 'disabled' });
        return;
      case 'not_allowed':
        show({ name: 'not_allowed' });
        return;
      case 'uncertain':
        show({ name: 'uncertain', retry });
        return;
      default:
        show({ name: 'unavailable', retry });
    }
  };

  /** Read the notice the person must agree to again; false (and a failure card) when it fails. */
  const loadNotice = async (): Promise<boolean> => {
    let fresh: ManageTemplate;
    try {
      fresh = await r1BookApi.consentTemplate();
    } catch (error) {
      if (!mountedRef.current) return false;
      showFailure(classifyBookFailure('consentTemplate', error), { kind: 'notice' });
      return false;
    }
    if (!mountedRef.current) return false;
    // A notice read again starts from unticked boxes: an agreement never carries over.
    setTemplate(fresh);
    setConsents({});
    setInIndia(false);
    setConsentErrors({});
    return true;
  };

  /** `POST manage`: the page's first call, a "Try again", and the one read after agreeing again. */
  const readBooking = async (after: 'start' | 'retry' | 'consented'): Promise<void> => {
    const token = tokenRef.current;
    if (!token) {
      show({ name: 'inactive' });
      return;
    }
    if (after !== 'consented') show({ name: 'loading' });
    let next: R1BookManageView;
    try {
      next = await r1BookApi.manage(token);
    } catch (error) {
      if (!mountedRef.current) return;
      const failure = classifyBookFailure('manage', error);
      // A read changes nothing, so an unsure answer is simply unavailable.
      showFailure(failure === 'uncertain' ? 'unavailable' : failure, { kind: 'manage' });
      return;
    }
    if (!mountedRef.current) return;
    keepView(next);
    setPanel('none');
    const asks = next.state === 'booked' && !next.consent_current;
    if (asks && !(await loadNotice())) return;
    if (!mountedRef.current) return;
    if (!asks) setConsentNotice(null);
    show({ name: 'view' });
    requestFocus(TITLE_ID);
    if (after === 'consented' && next.consent_current) {
      setConsentDone(true);
      setLive(R1_BOOK_MANAGE_COPY.reconsent.done);
    } else {
      setLive('');
    }
  };

  // Token capture. The fragment is stripped at once, whatever it held. Safe under StrictMode's
  // double effect: the second capture finds the fragment already stripped and must not
  // overwrite the token the first one kept (the R1MeetBridgePage.tsx pattern).
  useEffect(() => {
    const captured = captureManageToken();
    if (captured) tokenRef.current = captured;
    if (!tokenRef.current) show({ name: 'inactive' });
    // Runs once per mount; `show` only bumps a ref and sets state.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // The tab names this page, not the recruiter tool (WCAG 2.4.2); leaving puts the old one back.
  useEffect(() => {
    const previous = document.title;
    document.title = R1_BOOK_MANAGE_COPY.pageTitle;
    return () => {
      document.title = previous;
    };
  }, []);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    if (!tokenRef.current) return;
    void readBooking('start');
    // The first read runs once per page (StrictMode included); later reads are a person's
    // "Try again" or the one read after agreeing again, so `readBooking` is not a dependency.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Run one change at a time: a second click while one is on its way does nothing. */
  const guard = async (work: () => Promise<void>): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await work();
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };

  // ── Move ────────────────────────────────────────────────────────────────────────────────────

  /** The chosen time is gone: clear it, show the new grid in the move panel and say so. */
  const showMoveSlotTaken = (fresh: R1BookGrid): void => {
    const currentStart = viewRef.current?.start_at ?? null;
    setMoveSlot(null);
    setMoveError(null);
    setDay((current) => dayFor(fresh, current, currentStart));
    setSlotNotice(R1_BOOK_COPY.inline.slotTaken);
    setLive(R1_BOOK_COPY.inline.slotTaken);
    setPanel('move');
    show({ name: 'view' });
    requestFocus(SLOT_FIRST_ID, MOVE_TITLE_ID);
  };

  /** Open the move panel and read the grid for it. */
  const openMove = async (): Promise<void> => {
    slotsSeqRef.current += 1;
    const seq = slotsSeqRef.current;
    receiveGrid(null);
    setMoveSlot(null);
    setMoveError(null);
    setSlotNotice(null);
    setPanel('move');
    requestFocus(MOVE_TITLE_ID);
    setLive(R1_BOOK_COPY.live.loading);
    let fresh: R1BookGrid;
    try {
      fresh = await r1BookApi.slots();
    } catch (error) {
      if (!mountedRef.current || seq !== slotsSeqRef.current) return;
      showFailure(classifyBookFailure('slots', error), { kind: 'slots' });
      return;
    }
    if (!mountedRef.current || seq !== slotsSeqRef.current) return;
    receiveGrid(fresh);
    setDay(dayFor(fresh, null, viewRef.current?.start_at ?? null));
    setLive('');
  };

  /** One move to `slotStart` of the shown grid (D-S07-M5, D-S07-M6). */
  const doMove = async (slotStart: string): Promise<void> => {
    const token = tokenRef.current;
    let shown = gridRef.current;
    if (!token) return;
    if (!shown) {
      show({ name: 'view' });
      await openMove();
      return;
    }
    const currentStart = viewRef.current?.start_at ?? null;
    setMoveError(null);
    setSlotNotice(null);

    // 1. A grid older than 25 minutes is read again first, then checked.
    let decision = gridDecision(gridReceivedAtRef.current, bookStamp());
    if (decision.action === 'reload') {
      let fresh: R1BookGrid;
      try {
        fresh = await r1BookApi.slots();
      } catch (error) {
        if (!mountedRef.current) return;
        // Nothing was posted: "Try again" repeats the same move.
        showFailure(classifyBookFailure('slots', error), { kind: 'move', slotStart });
        return;
      }
      if (!mountedRef.current) return;
      receiveGrid(fresh);
      shown = fresh;
      const chosen = findBookSlot(fresh, slotStart);
      if (!(chosen && pickable(chosen, currentStart))) {
        showMoveSlotTaken(fresh);
        return;
      }
      decision = gridDecision(gridReceivedAtRef.current, bookStamp());
    }

    // 2. Never a grid younger than 3.5 s: one wait for the remainder.
    const waitMs = decision.action === 'send' ? decision.waitMs : R1_BOOK_GRID_MIN_AGE_MS;
    if (waitMs > 0) {
      await r1BookClock.sleep(waitMs);
      if (!mountedRef.current) return;
    }

    // 3. Move.
    let moved: Awaited<ReturnType<typeof r1BookApi.move>>;
    try {
      moved = await r1BookApi.move(token, slotStart, shown.grid_token);
    } catch (error) {
      if (!mountedRef.current) return;
      const failure = classifyBookFailure('move', error);
      if (failure !== 'slot_unavailable') {
        showFailure(failure, { kind: 'move', slotStart });
        return;
      }
      let fresh: R1BookGrid;
      try {
        fresh = await r1BookApi.slots();
      } catch (reloadError) {
        if (!mountedRef.current) return;
        showFailure(classifyBookFailure('slots', reloadError), { kind: 'slots' });
        return;
      }
      if (!mountedRef.current) return;
      receiveGrid(fresh);
      showMoveSlotTaken(fresh);
      return;
    }
    if (!mountedRef.current) return;
    // The updated invite carries a new manage link: this one is spent (D-S07-M15).
    spendToken();
    setLive('');
    show({ name: 'moved', startAt: moved.start_at, endAt: moved.end_at });
  };

  const onMoveConfirm = (): void => {
    if (moveSlot === null) {
      setMoveError(R1_BOOK_COPY.errors.slot_required);
      requestFocus(SLOT_FIRST_ID, MOVE_TITLE_ID);
      return;
    }
    const slotStart = moveSlot;
    void guard(() => doMove(slotStart));
  };

  // ── Cancel ──────────────────────────────────────────────────────────────────────────────────

  const openCancel = (): void => {
    slotsSeqRef.current += 1;
    setWithdraw(false);
    setPanel('cancel');
    requestFocus(CANCEL_TITLE_ID);
  };

  const doCancel = async (withdrawConsent: boolean): Promise<void> => {
    const token = tokenRef.current;
    if (!token) return;
    try {
      await r1BookApi.cancel(token, withdrawConsent);
    } catch (error) {
      if (!mountedRef.current) return;
      showFailure(classifyBookFailure('cancel', error), { kind: 'cancel', withdraw: withdrawConsent });
      return;
    }
    if (!mountedRef.current) return;
    // `cancelled` and `already_cancelled` read the same (D-S07-M17).
    spendToken();
    setLive('');
    show({ name: 'cancelled', withdrew: withdrawConsent });
  };

  const onCancelConfirm = (): void => {
    const withdrawConsent = withdraw;
    void guard(() => doCancel(withdrawConsent));
  };

  /** "Keep the current time" / "Keep my interview": close the panel, back to its button. */
  const closePanel = (opener: string): void => {
    slotsSeqRef.current += 1;
    setPanel('none');
    setMoveError(null);
    setSlotNotice(null);
    setLive('');
    requestFocus(opener, TITLE_ID);
  };

  // ── Re-consent ──────────────────────────────────────────────────────────────────────────────

  const doConsent = async (consent: R1BookConsentInput): Promise<void> => {
    const token = tokenRef.current;
    if (!token) return;
    try {
      await r1BookApi.consent(token, consent);
    } catch (error) {
      if (!mountedRef.current) return;
      const failure = classifyBookFailure('consent', error);
      if (failure !== 'consent_stale') {
        showFailure(failure, { kind: 'consent', consent });
        return;
      }
      // The notice changed again: read it again, clear every box and ask again (D-S07-M19).
      setConsentNotice(R1_BOOK_COPY.inline.noticeChanged);
      if (!(await loadNotice())) return;
      if (!mountedRef.current) return;
      show({ name: 'view' });
      setLive(R1_BOOK_COPY.inline.noticeChanged);
      requestFocus(NOTICE_CHANGED_ID, RECONSENT_TITLE_ID);
      return;
    }
    if (!mountedRef.current) return;
    setConsentNotice(null);
    // No new link after agreeing again: read the booking once more, never poll (D-S07-M15).
    await readBooking('consented');
  };

  const onConsentSubmit = (): void => {
    const shownTemplate = template;
    if (!shownTemplate) return;
    const errors = validateConsentOnly(consents, inIndia, shownTemplate.required_consents);
    setConsentErrors(errors);
    if (Object.keys(errors).length > 0) {
      requestFocus(SUMMARY);
      return;
    }
    const consent: R1BookConsentInput = {
      template_version: shownTemplate.version,
      consents: [...shownTemplate.required_consents],
      in_india: true,
    };
    void guard(() => doConsent(consent));
  };

  const consentSummaryItems = (): R1BookErrorItem[] => {
    const items: R1BookErrorItem[] = [];
    if (consentErrors.consents) {
      const first = template?.required_consents.find((type) => !isTicked(consents, type));
      items.push({
        focusId: first ? `r1-manage-consent-${first}` : IN_INDIA_ID,
        message: R1_BOOK_COPY.errors[consentErrors.consents],
      });
    }
    if (consentErrors.in_india) {
      items.push({ focusId: IN_INDIA_ID, message: R1_BOOK_COPY.errors[consentErrors.in_india] });
    }
    return items;
  };

  // ── Retry ───────────────────────────────────────────────────────────────────────────────────

  const runRetry = async (retry: RetryAction): Promise<void> => {
    switch (retry.kind) {
      case 'manage':
        await readBooking('retry');
        return;
      case 'notice':
        if (!(await loadNotice()) || !mountedRef.current) return;
        show({ name: 'view' });
        requestFocus(RECONSENT_TITLE_ID, TITLE_ID);
        return;
      case 'slots':
        show({ name: 'view' });
        await openMove();
        return;
      case 'move':
        await doMove(retry.slotStart);
        return;
      case 'cancel':
        await doCancel(retry.withdraw);
        return;
      case 'consent':
        await doConsent(retry.consent);
        return;
    }
  };

  // ── Render ──────────────────────────────────────────────────────────────────────────────────

  const copy = R1_BOOK_MANAGE_COPY;

  const renderReconsent = (shownTemplate: ManageTemplate) => (
    <section className="r1-book__section" aria-labelledby={RECONSENT_TITLE_ID}>
      <h2 id={RECONSENT_TITLE_ID} tabIndex={-1}>
        {copy.reconsent.title}
      </h2>
      <p className="candidate-muted">{copy.reconsent.body}</p>
      <R1BookErrorSummary items={consentSummaryItems()} ref={summaryRef} />
      {consentNotice ? (
        <p id={NOTICE_CHANGED_ID} className="r1-book__notice" tabIndex={-1}>
          {consentNotice}
        </p>
      ) : null}
      <R1BookNotice
        template={shownTemplate}
        checked={consents}
        inIndia={inIndia}
        onToggle={(type, ticked) => setConsents((current) => ({ ...current, [type]: ticked }))}
        onInIndia={setInIndia}
        disabled={busy}
        errors={{
          consents: consentErrors.consents ? R1_BOOK_COPY.errors[consentErrors.consents] : undefined,
          in_india: consentErrors.in_india ? R1_BOOK_COPY.errors[consentErrors.in_india] : undefined,
        }}
        idPrefix="r1-manage"
        headingLevel={3}
      />
      <div className="r1-book__actions">
        <Button type="button" className="candidate-primary-cta" loading={busy} onClick={onConsentSubmit}>
          {copy.reconsent.submit}
        </Button>
      </div>
    </section>
  );

  const renderMovePanel = (shownView: R1BookManageView) => {
    const noneFree =
      grid !== null
      && (grid.fully_booked
        || !grid.days.some((entry) => entry.slots.some((slot) => pickable(slot, shownView.start_at))));
    return (
      <section className="r1-book__section" aria-labelledby={MOVE_TITLE_ID}>
        <h2 id={MOVE_TITLE_ID} tabIndex={-1}>
          {copy.movePanel.title}
        </h2>
        {grid ? (
          <R1BookSlotPicker
            grid={grid}
            day={day}
            onDay={(date) => {
              setDay(date);
              setMoveSlot((current) =>
                current !== null && istDateOf(current) !== date ? null : current,
              );
            }}
            value={moveSlot}
            onChange={(startAt) => {
              setSlotNotice(null);
              setMoveError(null);
              setMoveSlot(startAt);
            }}
            currentStart={shownView.start_at}
            idPrefix="r1-manage"
            disabled={busy}
            error={moveError ?? undefined}
            notice={slotNotice ?? (noneFree ? R1_BOOK_COPY.states.fullyBooked.body : undefined)}
          />
        ) : (
          <p className="candidate-muted">{R1_BOOK_COPY.states.loading}</p>
        )}
        <div className="r1-book__actions">
          <Button
            type="button"
            className="candidate-primary-cta"
            loading={busy}
            disabled={grid === null}
            onClick={onMoveConfirm}
          >
            {copy.movePanel.confirm}
          </Button>
          <button
            type="button"
            className="r1-secondary-cta"
            disabled={busy}
            onClick={() => closePanel(MOVE_OPEN_ID)}
          >
            {copy.movePanel.keep}
          </button>
        </div>
      </section>
    );
  };

  const renderCancelPanel = () => (
    <section className="r1-book__section" aria-labelledby={CANCEL_TITLE_ID}>
      <h2 id={CANCEL_TITLE_ID} tabIndex={-1}>
        {copy.cancelPanel.title}
      </h2>
      <p className="candidate-muted">{copy.cancelPanel.body}</p>
      <div className="candidate-consent__items">
        <label className="candidate-consent__item">
          <input
            id={WITHDRAW_ID}
            type="checkbox"
            checked={withdraw}
            disabled={busy}
            onChange={(event) => setWithdraw(event.target.checked)}
          />
          <span>{copy.cancelPanel.withdraw}</span>
        </label>
      </div>
      <div className="r1-book__actions">
        <Button type="button" className="candidate-primary-cta" loading={busy} onClick={onCancelConfirm}>
          {copy.cancelPanel.confirm}
        </Button>
        <button
          type="button"
          className="r1-secondary-cta"
          disabled={busy}
          onClick={() => closePanel(CANCEL_OPEN_ID)}
        >
          {copy.cancelPanel.keep}
        </button>
      </div>
    </section>
  );

  const renderView = (shownView: R1BookManageView) => {
    const starting = shownView.state === 'in_progress';
    const asks = !starting && !shownView.consent_current;
    const canChange = !starting && (shownView.can_move || shownView.can_cancel);
    return (
      <section className="candidate-glass-card r1-book" aria-labelledby={TITLE_ID}>
        <p className="candidate-eyebrow">{copy.view.eyebrow}</p>
        <h1 id={TITLE_ID} tabIndex={-1}>
          {starting ? copy.inProgress.title : copy.view.title}
        </h1>
        <p className="r1-book__when">{formatBookSlot(shownView.start_at, shownView.end_at)}</p>
        <p className="candidate-muted">{starting ? copy.inProgress.body : copy.view.join}</p>
        {consentDone && !asks ? <p className="r1-book__notice">{copy.reconsent.done}</p> : null}

        {asks && template ? renderReconsent(template) : null}

        {!starting && !canChange ? <p className="candidate-muted">{copy.view.noChanges}</p> : null}

        {canChange && panel === 'move' && shownView.can_move ? renderMovePanel(shownView) : null}
        {canChange && panel === 'cancel' && shownView.can_cancel ? renderCancelPanel() : null}

        {canChange && panel === 'none' ? (
          <div className="r1-book__actions">
            {shownView.can_move ? (
              <Button
                type="button"
                id={MOVE_OPEN_ID}
                className="candidate-primary-cta"
                disabled={busy}
                aria-describedby={shownView.moves_left > 0 ? MOVES_LEFT_ID : undefined}
                onClick={() => void openMove()}
              >
                {copy.view.move}
              </Button>
            ) : null}
            {shownView.can_move && shownView.moves_left > 0 ? (
              <p id={MOVES_LEFT_ID} className="r1-book__hint">
                {copy.view.movesLeft(shownView.moves_left)}
              </p>
            ) : null}
            {shownView.can_cancel ? (
              <button
                type="button"
                id={CANCEL_OPEN_ID}
                className="r1-secondary-cta"
                disabled={busy}
                onClick={openCancel}
              >
                {copy.view.cancel}
              </button>
            ) : null}
          </div>
        ) : null}
      </section>
    );
  };

  const cardKey = `${stage.name}-${stage.seq}`;

  return (
    <R1Shell>
      <meta name="referrer" content="no-referrer" />

      {stage.name === 'loading' && (
        <p className="candidate-glass-card candidate-status-card" role="status">
          {copy.loading}
        </p>
      )}

      {stage.name === 'inactive' && (
        <R1BookStatusCard
          key={cardKey}
          id="r1-manage-inactive-title"
          eyebrow={copy.inactive.eyebrow}
          title={copy.inactive.title}
          body={[copy.inactive.body]}
        />
      )}

      {stage.name === 'view' && view && renderView(view)}

      {stage.name === 'moved' && (
        <R1BookStatusCard
          key={cardKey}
          id="r1-manage-moved-title"
          eyebrow={copy.moved.eyebrow}
          title={copy.moved.title}
          when={formatBookSlot(stage.startAt, stage.endAt)}
          body={[copy.moved.body, copy.moved.next]}
        />
      )}

      {stage.name === 'cancelled' && (
        <R1BookStatusCard
          key={cardKey}
          id="r1-manage-cancelled-title"
          eyebrow={copy.cancelled.eyebrow}
          title={copy.cancelled.title}
          body={
            stage.withdrew ? [copy.cancelled.body, copy.cancelled.withdrawn] : [copy.cancelled.body]
          }
        />
      )}

      {stage.name === 'not_allowed' && (
        <R1BookStatusCard
          key={cardKey}
          id="r1-manage-not-allowed-title"
          eyebrow={copy.notAllowed.eyebrow}
          title={copy.notAllowed.title}
          body={[copy.notAllowed.body]}
        />
      )}

      {stage.name === 'disabled' && (
        <R1BookStatusCard
          key={cardKey}
          id="r1-manage-disabled-title"
          eyebrow={copy.disabled.eyebrow}
          title={copy.disabled.title}
          body={[copy.disabled.body]}
        />
      )}

      {(stage.name === 'unavailable' || stage.name === 'uncertain') && (
        <R1BookStatusCard
          key={cardKey}
          id={`r1-manage-${stage.name}-title`}
          eyebrow={copy[stage.name].eyebrow}
          title={copy[stage.name].title}
          body={[copy[stage.name].body]}
        >
          <Button
            type="button"
            className="candidate-primary-cta"
            loading={busy}
            onClick={() => {
              const retry = stage.retry;
              void guard(() => runRetry(retry));
            }}
          >
            {copy[stage.name].action}
          </Button>
        </R1BookStatusCard>
      )}

      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {live}
      </p>
    </R1Shell>
  );
}
