import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { R1BookErrorSummary, type R1BookErrorItem } from '../components/candidate-r1/R1BookErrorSummary';
import { R1BookNotice } from '../components/candidate-r1/R1BookNotice';
import { R1BookSlotPicker } from '../components/candidate-r1/R1BookSlotPicker';
import { R1BookStatusCard } from '../components/candidate-r1/R1BookStatusCard';
import { R1_BOOK_COPY } from '../components/candidate-r1/r1-book-copy';
import { R1Shell } from '../components/candidate-r1/R1Screens';
import { Button } from '../components/ui';
import { istDateOf } from '../lib/ist-datetime';
import {
  classifyBookFailure,
  r1BookApi,
  type R1BookFailure,
  type R1BookGrid,
} from '../lib/r1/r1-book-api';
import {
  R1_BOOK_GRID_MIN_AGE_MS,
  bookAttemptKey,
  chooseRequestId,
  findBookSlot,
  firstOpenDay,
  formatBookSlot,
  gridDecision,
  gridHasOpenSlot,
  r1BookClock,
  validateBookForm,
  type BookAttemptMemo,
  type BookField,
  type BookFieldErrors,
} from '../lib/r1/r1-book';

/**
 * The public booking page, `/book` (M035 S07): one link for every candidate, sent by the hiring
 * team. The person registers (name, email, mobile number, their own consent and the India tick)
 * and picks an IST time for the first-round interview with Dex on Google Meet. Only people who
 * already have an open application in Ashby can book; the server decides that.
 *
 * Invariants (S07-PLAN.md section 3):
 *   - Dark by construction. On load the page sends the two GETs (the notice and the grid) and
 *     nothing else; a POST is sent only when a person submits. 503 `booking_disabled` from any
 *     call shows "Booking is not open yet"; every other refusal is told apart only as the closed
 *     words of `classifyBookFailure` (D-S07-M3, D-S07-M4).
 *   - Grid age (D-S07-M5). The page keeps the monotonic time it RECEIVED the grid
 *     (`r1BookClock`). Before a book it reloads a grid older than 25 minutes, then waits ONCE for
 *     the rest of 3.5 s if the grid is younger than that. One sleep, never a loop.
 *   - Slot check after a reload (D-S07-M6). When the reloaded grid no longer offers the chosen
 *     time, the page says so and does not post, EXCEPT for the retry of an uncertain attempt,
 *     which must be allowed to reach the server's replay by `request_id`.
 *   - `request_id` (D-S07-M7). A new UUID v4 per submit attempt; the same one only to retry the
 *     same attempt (same details, time, notice and trap) after an uncertain outcome.
 *   - Exactly what is sent (D-S07-M8). `slot_start` is the grid's `start_at` byte for byte;
 *     name, email and phone are trimmed only; the consents are the template's
 *     `required_consents` in template order with `in_india: true`; `website` is the honeypot's
 *     value (`''` for people); `grid_token` is the token of the grid that was shown.
 *   - Honeypot (D-S07-M9). An off-screen, aria-hidden text input named `website`, out of the Tab
 *     order. It is the only typed input with a `name`, and its value is read from the DOM.
 *   - A native submit can never leak (D-S07-M10). `noValidate`, `method="post"`, and the
 *     handler's first statement is `preventDefault`; the typed fields have autocomplete tokens
 *     but no `name`, so nothing typed can ever reach a URL query.
 *   - Error summary (D-S07-M11). A failed check shows the summary at the top of the form and
 *     focuses it; each item is a button that focuses its control (no `#id` links).
 *   - Live region and focus (D-S07-M12). One polite live region announces async results; each
 *     result card focuses its own heading when it mounts (each state has its own `key`).
 *   - PII in the browser (D-S07-M13). Typed values live in React state only. They are cleared on
 *     `booked` and `already_booked` and kept for every outcome the person can correct. The page
 *     never touches web storage, the URL or the console, and loads no third-party resource. It
 *     never shows a Meet link, an email address, a name or a seat count from the server: the
 *     booked card shows the time the server confirmed and says the invite goes to the email
 *     address on the application.
 *   - Fully booked (D-S07-M20). `fully_booked`, or a grid with no `available` slot, shows the
 *     "All interview times are taken" card. The page never computes availability.
 *   - Copy (D-S07-M22). Every string is a constant of r1-book-copy.ts.
 */

type BookTemplate = Awaited<ReturnType<typeof r1BookApi.consentTemplate>>;

/** What the person typed and picked. The honeypot is not here: its value is read from the DOM. */
interface BookValues {
  name: string;
  email: string;
  phone: string;
  slotStart: string | null;
  consents: Readonly<Record<string, boolean>>;
  inIndia: boolean;
}

const EMPTY_VALUES: BookValues = Object.freeze({
  name: '',
  email: '',
  phone: '',
  slotStart: null,
  consents: Object.freeze({}),
  inIndia: false,
});

type StageBody =
  | { name: 'loading' }
  | { name: 'closed'; kind: 'not_open' | 'unavailable' | 'fully_booked' }
  | { name: 'form' }
  | { name: 'done'; kind: 'booked'; startAt: string; endAt: string }
  | { name: 'done'; kind: 'already_booked' | 'not_found' | 'not_open' }
  | { name: 'retry' };

/** `seq` keys each result card, so every new result mounts its own card and focuses its heading. */
type Stage = StageBody & { seq: number };

/** A focus move to make after the next commit: the error summary, or an element by id. */
interface FocusRequest {
  target: string;
  seq: number;
}

const SUMMARY = 'summary';
const FORM_TITLE_ID = 'r1-book-title';
const NAME_ID = 'r1-book-name';
const EMAIL_ID = 'r1-book-email';
const PHONE_ID = 'r1-book-phone';
const SLOT_FIRST_ID = 'r1-book-slot-first';
const IN_INDIA_ID = 'r1-book-in-india';
const NOTICE_CHANGED_ID = 'r1-book-notice-changed';
const TRAP_ID = 'r1-book-website';

const FIELD_ORDER: readonly BookField[] = ['name', 'email', 'phone', 'slot', 'consents', 'in_india'];

const isTicked = (consents: Readonly<Record<string, boolean>>, type: string): boolean =>
  Object.prototype.hasOwnProperty.call(consents, type) && consents[type] === true;

/** The day to show for a grid: the current one while it still has an open time, else the first open one. */
function dayFor(grid: R1BookGrid, current: string | null): string | null {
  const kept = grid.days.find((entry) => entry.date === current);
  if (kept && kept.slots.some((slot) => slot.available)) return kept.date;
  return firstOpenDay(grid);
}

export function R1BookPage() {
  const [stage, setStage] = useState<Stage>({ name: 'loading', seq: 0 });
  const [template, setTemplate] = useState<BookTemplate | null>(null);
  const [grid, setGrid] = useState<R1BookGrid | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [values, setValues] = useState<BookValues>(EMPTY_VALUES);
  /** The honeypot's value at the last submit: restored if the form mounts again, sent on a retry. */
  const [trapValue, setTrapValue] = useState('');
  const [fieldErrors, setFieldErrors] = useState<BookFieldErrors>({});
  const [serverInvalid, setServerInvalid] = useState(false);
  const [slotNotice, setSlotNotice] = useState<string | null>(null);
  const [consentNotice, setConsentNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [live, setLive] = useState('');
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);

  const mountedRef = useRef(false);
  /** The first load has been started: StrictMode's second effect run must not repeat it. */
  const startedRef = useRef(false);
  /** Only the newest load may write its answer (a later "Try again" outdates an earlier one). */
  const loadSeqRef = useRef(0);
  const stageSeqRef = useRef(0);
  const focusSeqRef = useRef(0);
  /** `r1BookClock.now()` when the shown grid was received (D-S07-M5). */
  const gridReceivedAtRef = useRef(0);
  const templateVersionRef = useRef<string | null>(null);
  /** The previous submit attempt (D-S07-M7). */
  const memoRef = useRef<BookAttemptMemo | null>(null);
  const submittingRef = useRef(false);
  const summaryRef = useRef<HTMLDivElement>(null);
  const trapRef = useRef<HTMLInputElement>(null);

  const show = (next: StageBody): void => {
    stageSeqRef.current += 1;
    setStage({ ...next, seq: stageSeqRef.current });
  };

  const requestFocus = (target: string): void => {
    focusSeqRef.current += 1;
    setFocusRequest({ target, seq: focusSeqRef.current });
  };

  useEffect(() => {
    if (!focusRequest) return;
    if (focusRequest.target === SUMMARY) summaryRef.current?.focus();
    else document.getElementById(focusRequest.target)?.focus();
  }, [focusRequest]);

  const receiveTemplate = (next: BookTemplate): void => {
    // A different notice starts from unticked boxes: an agreement never carries over.
    if (templateVersionRef.current !== null && templateVersionRef.current !== next.version) {
      setValues((current) => ({ ...current, consents: {}, inIndia: false }));
    }
    templateVersionRef.current = next.version;
    setTemplate(next);
  };

  const receiveGrid = (next: R1BookGrid): void => {
    gridReceivedAtRef.current = r1BookClock.now();
    setGrid(next);
  };

  const closedByFailure = (failure: R1BookFailure): StageBody =>
    failure === 'disabled'
      ? { name: 'closed', kind: 'not_open' }
      : { name: 'closed', kind: 'unavailable' };

  /** Load the notice and the grid together (the page's only calls until a person submits). */
  const load = async (reload: boolean): Promise<void> => {
    loadSeqRef.current += 1;
    const seq = loadSeqRef.current;
    show({ name: 'loading' });
    const [templateResult, gridResult] = await Promise.allSettled([
      r1BookApi.consentTemplate(),
      r1BookApi.slots(),
    ]);
    if (!mountedRef.current || seq !== loadSeqRef.current) return;
    if (templateResult.status === 'rejected' || gridResult.status === 'rejected') {
      const failures: R1BookFailure[] = [];
      if (templateResult.status === 'rejected') {
        failures.push(classifyBookFailure('consentTemplate', templateResult.reason));
      }
      if (gridResult.status === 'rejected') {
        failures.push(classifyBookFailure('slots', gridResult.reason));
      }
      setLive('');
      show(closedByFailure(failures.includes('disabled') ? 'disabled' : 'unavailable'));
      return;
    }
    receiveTemplate(templateResult.value);
    const fresh = gridResult.value;
    receiveGrid(fresh);
    if (fresh.fully_booked || !gridHasOpenSlot(fresh)) {
      setLive('');
      show({ name: 'closed', kind: 'fully_booked' });
      return;
    }
    const kept = findBookSlot(fresh, values.slotStart);
    if (kept && kept.available) {
      setDay(istDateOf(kept.start_at));
    } else {
      setValues((current) => ({ ...current, slotStart: null }));
      setDay(firstOpenDay(fresh));
    }
    show({ name: 'form' });
    if (reload) {
      setLive(R1_BOOK_COPY.live.updated);
      requestFocus(FORM_TITLE_ID);
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void load(false);
    // The first load runs once per page (StrictMode included); later loads are a person's
    // "Try again", so `load` is deliberately not a dependency.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** The chosen time is gone: clear it, show the new grid and say so (values kept). */
  const showSlotTaken = (fresh: R1BookGrid): void => {
    setValues((current) => ({ ...current, slotStart: null }));
    if (fresh.fully_booked || !gridHasOpenSlot(fresh)) {
      setLive('');
      show({ name: 'closed', kind: 'fully_booked' });
      return;
    }
    setDay((current) => dayFor(fresh, current));
    setSlotNotice(R1_BOOK_COPY.inline.slotTaken);
    setLive(R1_BOOK_COPY.inline.slotTaken);
    show({ name: 'form' });
    requestFocus(SLOT_FIRST_ID);
  };

  /** What a refused or failed `POST /api/r1/book` leads to. */
  const onBookFailure = async (
    failure: R1BookFailure,
    attempt: { key: string; requestId: string },
  ): Promise<void> => {
    const definite: BookAttemptMemo = { ...attempt, uncertain: false };
    switch (failure) {
      case 'uncertain':
        memoRef.current = { ...attempt, uncertain: true };
        setLive('');
        show({ name: 'retry' });
        return;
      case 'unavailable':
      case 'not_allowed':
        memoRef.current = definite;
        setLive('');
        show({ name: 'retry' });
        return;
      case 'disabled':
        memoRef.current = null;
        setLive('');
        show({ name: 'done', kind: 'not_open' });
        return;
      case 'not_found':
        memoRef.current = definite;
        setLive('');
        show({ name: 'done', kind: 'not_found' });
        return;
      case 'already_booked':
        memoRef.current = null;
        setValues(EMPTY_VALUES);
        setTrapValue('');
        setLive('');
        show({ name: 'done', kind: 'already_booked' });
        return;
      case 'invalid':
        memoRef.current = definite;
        setFieldErrors({});
        setServerInvalid(true);
        setLive('');
        show({ name: 'form' });
        requestFocus(SUMMARY);
        return;
      case 'slot_unavailable': {
        memoRef.current = definite;
        let fresh: R1BookGrid;
        try {
          fresh = await r1BookApi.slots();
        } catch (error) {
          if (!mountedRef.current) return;
          setValues((current) => ({ ...current, slotStart: null }));
          setLive('');
          show(closedByFailure(classifyBookFailure('slots', error)));
          return;
        }
        if (!mountedRef.current) return;
        receiveGrid(fresh);
        showSlotTaken(fresh);
        return;
      }
      case 'consent_stale': {
        memoRef.current = definite;
        // The refusal's `template_version` is ignored: the page reads the notice again.
        setValues((current) => ({ ...current, consents: {}, inIndia: false }));
        let fresh: BookTemplate;
        try {
          fresh = await r1BookApi.consentTemplate();
        } catch (error) {
          if (!mountedRef.current) return;
          setLive('');
          show(closedByFailure(classifyBookFailure('consentTemplate', error)));
          return;
        }
        if (!mountedRef.current) return;
        receiveTemplate(fresh);
        setConsentNotice(R1_BOOK_COPY.inline.noticeChanged);
        setLive(R1_BOOK_COPY.inline.noticeChanged);
        show({ name: 'form' });
        requestFocus(NOTICE_CHANGED_ID);
        return;
      }
    }
  };

  /** One submit attempt, from the form or from the retry card's "Try again". */
  const submit = async (mode: 'form' | 'retry'): Promise<void> => {
    if (submittingRef.current) return;
    const shownTemplate = template;
    const shownGrid = grid;
    if (!shownTemplate || !shownGrid) return;
    const website = mode === 'form' ? (trapRef.current?.value ?? '') : trapValue;
    const snapshot = values;
    setTrapValue(website);

    const errors = validateBookForm({ ...snapshot, website }, shownTemplate.required_consents);
    if (Object.keys(errors).length > 0 || snapshot.slotStart === null) {
      setFieldErrors(errors);
      setServerInvalid(false);
      if (mode === 'retry') show({ name: 'form' });
      requestFocus(SUMMARY);
      return;
    }
    setFieldErrors({});
    setServerInvalid(false);
    setSlotNotice(null);
    setConsentNotice(null);

    const slotStart = snapshot.slotStart;
    const key = bookAttemptKey({
      name: snapshot.name,
      email: snapshot.email,
      phone: snapshot.phone,
      slotStart,
      templateVersion: shownTemplate.version,
      website,
    });
    const memo = memoRef.current;
    // The retry of an uncertain attempt: the server may already hold it under this id.
    const replay = memo !== null && memo.uncertain && memo.key === key;
    const requestId = chooseRequestId(memo, key);

    submittingRef.current = true;
    setSubmitting(true);
    setLive(R1_BOOK_COPY.live.booking);
    try {
      // 1. A grid older than 25 minutes is read again first (D-S07-M5), then checked (D-S07-M6).
      let gridToSend = shownGrid;
      let decision = gridDecision(gridReceivedAtRef.current, r1BookClock.now());
      if (decision.action === 'reload') {
        let fresh: R1BookGrid;
        try {
          fresh = await r1BookApi.slots();
        } catch (error) {
          if (!mountedRef.current) return;
          // Nothing was posted. A replay keeps its memo, so its next retry still uses its id.
          if (!replay) memoRef.current = { key, requestId, uncertain: false };
          setLive('');
          show(
            classifyBookFailure('slots', error) === 'disabled'
              ? { name: 'done', kind: 'not_open' }
              : { name: 'retry' },
          );
          return;
        }
        if (!mountedRef.current) return;
        receiveGrid(fresh);
        gridToSend = fresh;
        const chosen = findBookSlot(fresh, slotStart);
        if (!replay && !(chosen && chosen.available)) {
          memoRef.current = null;
          showSlotTaken(fresh);
          return;
        }
        decision = gridDecision(gridReceivedAtRef.current, r1BookClock.now());
      }

      // 2. Never a grid younger than 3.5 s: one wait for the remainder.
      const waitMs = decision.action === 'send' ? decision.waitMs : R1_BOOK_GRID_MIN_AGE_MS;
      if (waitMs > 0) {
        await r1BookClock.sleep(waitMs);
        if (!mountedRef.current) return;
      }

      // 3. Book.
      let booked: Awaited<ReturnType<typeof r1BookApi.book>>;
      try {
        booked = await r1BookApi.book({
          request_id: requestId,
          name: snapshot.name.trim(),
          email: snapshot.email.trim(),
          phone: snapshot.phone.trim(),
          slot_start: slotStart,
          grid_token: gridToSend.grid_token,
          consent: {
            template_version: shownTemplate.version,
            consents: [...shownTemplate.required_consents],
            in_india: true,
          },
          website,
        });
      } catch (error) {
        if (!mountedRef.current) return;
        await onBookFailure(classifyBookFailure('book', error), { key, requestId });
        return;
      }
      if (!mountedRef.current) return;
      memoRef.current = null;
      setValues(EMPTY_VALUES);
      setTrapValue('');
      setLive('');
      show({ name: 'done', kind: 'booked', startAt: booked.start_at, endAt: booked.end_at });
    } finally {
      submittingRef.current = false;
      if (mountedRef.current) setSubmitting(false);
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void submit('form');
  };

  const backToForm = (): void => {
    show({ name: 'form' });
    requestFocus(NAME_ID);
  };

  const setText = (field: 'name' | 'email' | 'phone', value: string): void => {
    setValues((current) => ({ ...current, [field]: value }));
  };

  const summaryItems = (): R1BookErrorItem[] => {
    const items: R1BookErrorItem[] = [];
    for (const field of FIELD_ORDER) {
      const code = fieldErrors[field];
      if (!code) continue;
      let focusId = NAME_ID;
      if (field === 'email') focusId = EMAIL_ID;
      else if (field === 'phone') focusId = PHONE_ID;
      else if (field === 'slot') focusId = SLOT_FIRST_ID;
      else if (field === 'in_india') focusId = IN_INDIA_ID;
      else if (field === 'consents') {
        const first = template?.required_consents.find((type) => !isTicked(values.consents, type));
        focusId = first ? `r1-book-consent-${first}` : IN_INDIA_ID;
      }
      items.push({ focusId, message: R1_BOOK_COPY.errors[code] });
    }
    if (serverInvalid) items.push({ focusId: NAME_ID, message: R1_BOOK_COPY.errors.serverInvalid });
    return items;
  };

  const describedBy = (...ids: (string | false)[]): string | undefined => {
    const list = ids.filter((id): id is string => typeof id === 'string');
    return list.length > 0 ? list.join(' ') : undefined;
  };

  const textError = (field: 'name' | 'email' | 'phone'): string | null => {
    const code = fieldErrors[field];
    return code ? R1_BOOK_COPY.errors[code] : null;
  };

  const renderForm = (shownTemplate: BookTemplate, shownGrid: R1BookGrid) => {
    const copy = R1_BOOK_COPY.form;
    const nameError = textError('name');
    const emailError = textError('email');
    const phoneError = textError('phone');
    const slotError = fieldErrors.slot ? R1_BOOK_COPY.errors[fieldErrors.slot] : undefined;
    return (
      <section className="candidate-glass-card r1-book" aria-labelledby={FORM_TITLE_ID}>
        <p className="candidate-eyebrow">{copy.eyebrow}</p>
        <h1 id={FORM_TITLE_ID} tabIndex={-1}>
          {copy.title}
        </h1>
        <p className="candidate-muted">{copy.intro}</p>

        <form noValidate method="post" onSubmit={onSubmit}>
          <R1BookErrorSummary items={summaryItems()} ref={summaryRef} />

          <fieldset className="r1-book__section">
            <legend>{copy.detailsLegend}</legend>
            <p className="r1-book__hint">{copy.detailsHint}</p>

            <div className="r1-book__field">
              <label className="candidate-field-label" htmlFor={NAME_ID}>
                {copy.nameLabel}
              </label>
              <input
                id={NAME_ID}
                className="r1-book__input"
                type="text"
                autoComplete="name"
                value={values.name}
                aria-invalid={nameError ? true : undefined}
                aria-describedby={describedBy(nameError !== null && `${NAME_ID}-error`)}
                onChange={(event) => setText('name', event.target.value)}
              />
              {nameError ? (
                <p id={`${NAME_ID}-error`} className="r1-book__field-error">
                  {nameError}
                </p>
              ) : null}
            </div>

            <div className="r1-book__field">
              <label className="candidate-field-label" htmlFor={EMAIL_ID}>
                {copy.emailLabel}
              </label>
              <input
                id={EMAIL_ID}
                className="r1-book__input"
                type="email"
                autoComplete="email"
                spellCheck={false}
                value={values.email}
                aria-invalid={emailError ? true : undefined}
                aria-describedby={describedBy(
                  `${EMAIL_ID}-hint`,
                  emailError !== null && `${EMAIL_ID}-error`,
                )}
                onChange={(event) => setText('email', event.target.value)}
              />
              <p id={`${EMAIL_ID}-hint`} className="r1-book__hint">
                {copy.emailHint}
              </p>
              {emailError ? (
                <p id={`${EMAIL_ID}-error`} className="r1-book__field-error">
                  {emailError}
                </p>
              ) : null}
            </div>

            <div className="r1-book__field">
              <label className="candidate-field-label" htmlFor={PHONE_ID}>
                {copy.phoneLabel}
              </label>
              <input
                id={PHONE_ID}
                className="r1-book__input"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                value={values.phone}
                aria-invalid={phoneError ? true : undefined}
                aria-describedby={describedBy(
                  `${PHONE_ID}-hint`,
                  phoneError !== null && `${PHONE_ID}-error`,
                )}
                onChange={(event) => setText('phone', event.target.value)}
              />
              <p id={`${PHONE_ID}-hint`} className="r1-book__hint">
                {copy.phoneHint}
              </p>
              {phoneError ? (
                <p id={`${PHONE_ID}-error`} className="r1-book__field-error">
                  {phoneError}
                </p>
              ) : null}
            </div>
          </fieldset>

          <fieldset className="r1-book__section">
            <legend>{copy.slotLegend}</legend>
            <R1BookSlotPicker
              grid={shownGrid}
              day={day}
              onDay={(date) => {
                setDay(date);
                setValues((current) =>
                  current.slotStart !== null && istDateOf(current.slotStart) !== date
                    ? { ...current, slotStart: null }
                    : current,
                );
              }}
              value={values.slotStart}
              onChange={(startAt) => {
                setSlotNotice(null);
                setValues((current) => ({ ...current, slotStart: startAt }));
              }}
              idPrefix="r1-book"
              disabled={submitting}
              error={slotError}
              notice={slotNotice ?? undefined}
            />
          </fieldset>

          {consentNotice ? (
            <p id={NOTICE_CHANGED_ID} className="r1-book__notice" tabIndex={-1}>
              {consentNotice}
            </p>
          ) : null}
          <R1BookNotice
            template={shownTemplate}
            checked={values.consents}
            inIndia={values.inIndia}
            onToggle={(type, ticked) =>
              setValues((current) => ({ ...current, consents: { ...current.consents, [type]: ticked } }))
            }
            onInIndia={(ticked) => setValues((current) => ({ ...current, inIndia: ticked }))}
            disabled={submitting}
            errors={{
              consents: fieldErrors.consents ? R1_BOOK_COPY.errors[fieldErrors.consents] : undefined,
              in_india: fieldErrors.in_india ? R1_BOOK_COPY.errors[fieldErrors.in_india] : undefined,
            }}
            idPrefix="r1-book"
          />

          <div className="r1-book__trap" aria-hidden="true">
            <label htmlFor={TRAP_ID}>{copy.trapLabel}</label>
            <input
              id={TRAP_ID}
              ref={trapRef}
              name="website"
              type="text"
              tabIndex={-1}
              autoComplete="off"
              defaultValue={trapValue}
            />
          </div>

          <div className="r1-book__actions">
            <Button type="submit" className="candidate-primary-cta" loading={submitting}>
              {copy.submit}
            </Button>
          </div>
          <p className="candidate-privacy-note">
            {copy.privacyLead} <Link to="/privacy-notice">{copy.privacyLink}</Link>.
          </p>
        </form>
      </section>
    );
  };

  const states = R1_BOOK_COPY.states;
  const cardKey = `${stage.name}-${stage.seq}`;

  return (
    <R1Shell>
      <meta name="referrer" content="no-referrer" />

      {stage.name === 'loading' && (
        <p className="candidate-glass-card candidate-status-card" role="status">
          {states.loading}
        </p>
      )}

      {stage.name === 'closed' && stage.kind === 'not_open' && (
        <R1BookStatusCard
          key={cardKey}
          id="r1-book-not-open-title"
          eyebrow={states.notOpen.eyebrow}
          title={states.notOpen.title}
          body={[states.notOpen.body]}
        />
      )}

      {stage.name === 'closed' && stage.kind === 'unavailable' && (
        <R1BookStatusCard
          key={cardKey}
          id="r1-book-unavailable-title"
          eyebrow={states.unavailable.eyebrow}
          title={states.unavailable.title}
          body={[states.unavailable.body]}
        >
          <Button type="button" className="candidate-primary-cta" onClick={() => void load(true)}>
            {states.unavailable.action}
          </Button>
        </R1BookStatusCard>
      )}

      {stage.name === 'closed' && stage.kind === 'fully_booked' && (
        <R1BookStatusCard
          key={cardKey}
          id="r1-book-fully-booked-title"
          eyebrow={states.fullyBooked.eyebrow}
          title={states.fullyBooked.title}
          body={[states.fullyBooked.body]}
        >
          <Button type="button" className="candidate-primary-cta" onClick={() => void load(true)}>
            {states.fullyBooked.action}
          </Button>
        </R1BookStatusCard>
      )}

      {stage.name === 'form' && template && grid && renderForm(template, grid)}

      {stage.name === 'done' && stage.kind === 'booked' && (
        <R1BookStatusCard
          key={cardKey}
          id="r1-book-booked-title"
          eyebrow={states.booked.eyebrow}
          title={states.booked.title}
          when={formatBookSlot(stage.startAt, stage.endAt)}
          body={[states.booked.body, states.booked.spam, states.booked.change]}
        />
      )}

      {stage.name === 'done' && stage.kind === 'already_booked' && (
        <R1BookStatusCard
          key={cardKey}
          id="r1-book-already-booked-title"
          eyebrow={states.alreadyBooked.eyebrow}
          title={states.alreadyBooked.title}
          body={[states.alreadyBooked.body]}
        />
      )}

      {stage.name === 'done' && stage.kind === 'not_found' && (
        <R1BookStatusCard
          key={cardKey}
          id="r1-book-not-found-title"
          eyebrow={states.notFound.eyebrow}
          title={states.notFound.title}
          body={[states.notFound.body]}
        >
          <Button type="button" className="candidate-primary-cta" onClick={backToForm}>
            {states.notFound.action}
          </Button>
        </R1BookStatusCard>
      )}

      {stage.name === 'done' && stage.kind === 'not_open' && (
        <R1BookStatusCard
          key={cardKey}
          id="r1-book-not-open-title"
          eyebrow={states.notOpen.eyebrow}
          title={states.notOpen.title}
          body={[states.notOpen.body]}
        />
      )}

      {stage.name === 'retry' && (
        <R1BookStatusCard
          key={cardKey}
          id="r1-book-retry-title"
          eyebrow={states.retry.eyebrow}
          title={states.retry.title}
          body={[states.retry.body]}
        >
          <Button
            type="button"
            className="candidate-primary-cta"
            loading={submitting}
            onClick={() => void submit('retry')}
          >
            {states.retry.action}
          </Button>
          <button type="button" className="r1-secondary-cta" disabled={submitting} onClick={backToForm}>
            {states.retry.back}
          </button>
        </R1BookStatusCard>
      )}

      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {live}
      </p>
    </R1Shell>
  );
}
