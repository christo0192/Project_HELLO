/**
 * MetricAskHello — the "Ask Hello" button on the Scorebar's Add-a-metric form.
 *
 * From the Name and Description the admin has typed, Hello drafts the scoring
 * instruction and all four rubric levels (POST /api/scorecards/metrics/draft)
 * and this fills them in. It NEVER creates the metric: the admin reviews the
 * draft and still presses "Create metric".
 *
 * The rules it keeps, each for a reason the rest of the app already learned:
 *
 *   - `aria-disabled`, NOT `disabled`, with the handler as the guard. A real
 *     `disabled` blurs the button the instant it is pressed by keyboard and
 *     drops focus to <body>. Focus therefore STAYS ON THIS BUTTON throughout —
 *     while Hello drafts, after the fill, and after the replace dialog closes
 *     (its return-focus ref is this button). One place, every time.
 *   - Nothing fades. Unavailable is the measured flat `ask-hello--idle` fill;
 *     busy keeps the gradient and changes the glyph. See `AskHelloButton` and
 *     `ask-hello-contrast.test.ts` for why opacity is banned here.
 *   - The button's NAME AND LABEL NEVER CHANGE. Busy is said ONCE, by the
 *     status line beside the button — visible, and the polite live region —
 *     plus `aria-busy` and the ◐ glyph. An earlier version also swapped the
 *     focused button's `aria-label` to the same sentence, so a screen reader
 *     read the busy state twice (name change on the focused control, then the
 *     live region). A stable visible "Ask Hello" also keeps SC 2.5.3 true in
 *     both states: a static name over a visible label that changed to
 *     "Hello is drafting…" would put the label outside the name.
 *   - Text the admin already wrote is never replaced without asking — and the
 *     centred `Dialog` that asks is PORTALLED to <body>. This button lives
 *     inside a `.glass` panel, and `.glass` sets `backdrop-filter`, which makes
 *     that panel the containing block for every `position: fixed` descendant:
 *     rendered in place, the "full-screen" overlay would be clipped to the
 *     form card, leaving the rest of the page live behind an `aria-modal`.
 *   - A draft that comes back after the form CHANGED is discarded, not
 *     applied: the answer is about the name it was asked for, and applying it
 *     would overwrite whatever was typed during the wait. (RolesPage's
 *     Rephrase learned the same lesson the hard way.) So is one that comes
 *     back after this component UNMOUNTED — the host's list reload swaps the
 *     form out and back — because an unmounted instance can no longer see
 *     edits, and its "unchanged" check would be comparing against a stale
 *     form.
 *   - The status line and error describe the form AS IT IS. When the host
 *     resets the form (after Create), it bumps `resetKey` and both clear, so
 *     an empty form never says "Hello drafted… review before creating".
 */

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, ApiError } from '../../api';
import type { ScoreValue, ScorecardMetricDraft } from '../../types';
import { Button, Dialog, InlineNotice } from '../design';

const LEVELS: ScoreValue[] = [1, 2, 3, 4];

/** The slice of the create form this reads. Structurally ScorebarSection's draft. */
export interface MetricAskHelloDraft {
  name: string;
  description: string;
  instruction: string;
  rubric: Record<ScoreValue, string>;
}

export interface MetricAskHelloProps {
  /** Namespace for generated ids; unique on the page. */
  idPrefix: string;
  draft: MetricAskHelloDraft;
  /** Fill the scoring instruction and all four rubric levels. */
  onApply: (instruction: string, rubric: Record<ScoreValue, string>) => void;
  /**
   * Change it when the host RESETS the form (after a successful Create): the
   * status line and any error are about text that is gone, so both clear.
   */
  resetKey?: number;
}

export const ASK_HELLO_DRAFTED =
  'Hello drafted the scoring instruction and rubric — review before creating.';
export const ASK_HELLO_DRAFTING = 'Hello is drafting the scoring instruction and rubric…';
export const ASK_HELLO_DISCARDED =
  'The form changed while Hello was drafting, so the draft was not applied. Ask again when you are ready.';
export const ASK_HELLO_BUSY = 'Hello is busy — try again in a minute.';
export const ASK_HELLO_FAILED = 'Hello could not draft this right now. Try again, or write it yourself.';

/** Plain-English copy for a failed draft. The API's 422 message is already written for the admin. */
function errorCopy(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429) return ASK_HELLO_BUSY;
    if (err.status === 422 && err.message.trim()) return err.message;
    if (err.status === 0) return 'Hello could not be reached. Check your connection and try again.';
    if (err.status === 403) return 'Only admins can ask Hello to draft a metric.';
  }
  return ASK_HELLO_FAILED;
}

function hasWrittenText(draft: MetricAskHelloDraft): boolean {
  return draft.instruction.trim() !== '' || LEVELS.some((level) => draft.rubric[level].trim() !== '');
}

function sameForm(a: MetricAskHelloDraft, b: MetricAskHelloDraft): boolean {
  return (
    a.name === b.name &&
    a.description === b.description &&
    a.instruction === b.instruction &&
    LEVELS.every((level) => a.rubric[level] === b.rubric[level])
  );
}

/** All five strings present — never apply half a draft. */
function isCompleteDraft(value: unknown): value is ScorecardMetricDraft {
  if (!value || typeof value !== 'object') return false;
  const v = value as { default_instruction?: unknown; rubric?: Record<string, unknown> | null };
  if (typeof v.default_instruction !== 'string' || !v.default_instruction.trim()) return false;
  if (!v.rubric || typeof v.rubric !== 'object') return false;
  const rubric = v.rubric;
  return LEVELS.every((level) => {
    const text = rubric[String(level)];
    return typeof text === 'string' && text.trim() !== '';
  });
}

export function MetricAskHello({ idPrefix, draft, onApply, resetKey = 0 }: MetricAskHelloProps) {
  const [drafting, setDrafting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // The form was reset: what the status line and error describe is gone.
  // Adjusted DURING render (React's pattern for resetting state on a prop
  // change), so the stale sentence is never painted next to the empty form.
  const [seenResetKey, setSeenResetKey] = useState(resetKey);
  if (resetKey !== seenResetKey) {
    setSeenResetKey(resetKey);
    setStatus('');
    setError(null);
  }
  /** False once unmounted: a draft landing after that is never applied. */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  /**
   * The live form, readable after the await. The closure's `draft` is the one
   * from the render that STARTED the request, so comparing against it would
   * never notice an edit made during the wait.
   */
  const latest = useRef(draft);
  latest.current = draft;
  /** Synchronous double-press guard: state updates land a render too late. */
  const inFlight = useRef(false);
  const hintId = `${useId().replace(/:/g, '-')}-ask-hello-hint`;

  const nameReady = draft.name.trim() !== '';

  async function run() {
    if (inFlight.current) return;
    const asked = latest.current;
    if (!asked.name.trim()) return;
    inFlight.current = true;
    setDrafting(true);
    setError(null);
    setStatus('');
    try {
      const result = await api.draftMetricRubric({
        name: asked.name.trim(),
        description: asked.description.trim() ? asked.description.trim() : null,
      });
      // `latest` stopped following the form at unmount, so "unchanged" below
      // would be a comparison against a stale copy. Drop it silently.
      if (!mounted.current) return;
      if (!isCompleteDraft(result)) {
        setError(ASK_HELLO_FAILED);
        return;
      }
      if (!sameForm(latest.current, asked)) {
        setStatus(ASK_HELLO_DISCARDED);
        return;
      }
      onApply(result.default_instruction.trim(), {
        1: result.rubric[1].trim(),
        2: result.rubric[2].trim(),
        3: result.rubric[3].trim(),
        4: result.rubric[4].trim(),
      });
      setStatus(ASK_HELLO_DRAFTED);
    } catch (err) {
      setError(errorCopy(err));
    } finally {
      inFlight.current = false;
      setDrafting(false);
    }
  }

  function ask() {
    // THE GUARD IS THE DISABLE — `aria-disabled` leaves the button pressable.
    if (!nameReady || drafting || inFlight.current) return;
    setError(null);
    if (hasWrittenText(draft)) {
      setConfirmOpen(true);
      return;
    }
    void run();
  }

  function confirmReplace() {
    setConfirmOpen(false);
    void run();
  }

  return (
    // `w-full`: the host slot right-aligns; filling it keeps the status line
    // to the LEFT of the button rather than squeezing it under.
    <div className="w-full min-w-0 space-y-2">
      <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 text-[13px] leading-5">
          {/* Mounted from the first render, so it announces reliably. The
              ONLY place the busy state is put into words — on screen and to
              a screen reader alike — because the button's name and label
              stay "Ask Hello" throughout (see the header). */}
          <p aria-live="polite" data-ask-hello-status="" className="text-ink-secondary">
            {drafting ? ASK_HELLO_DRAFTING : status}
          </p>
          {!nameReady && !drafting && (
            <p id={hintId} className="text-ink-tertiary">
              Add a name and Hello can draft the instruction and rubric.
            </p>
          )}
        </div>
        <button
          ref={buttonRef}
          type="button"
          onClick={ask}
          aria-disabled={!nameReady || drafting}
          aria-busy={drafting}
          aria-describedby={!nameReady && !drafting ? hintId : undefined}
          // STABLE. Swapping it while busy made the focused button announce
          // the same sentence the live region was already announcing.
          aria-label="Ask Hello to draft the scoring instruction and rubric"
          data-ask-hello=""
          // The Ask Hello pill, verbatim — NO `opacity-*` anywhere in this
          // component (ask-hello-contrast.test.ts reads this class list).
          className={`ask-hello relative inline-flex min-h-11 shrink-0 items-center gap-2 overflow-hidden rounded-full px-5 text-sm font-semibold text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-info ${
            drafting ? 'cursor-progress' : !nameReady ? 'ask-hello--idle cursor-not-allowed' : ''
          }`}
        >
          <span aria-hidden="true" className="ask-hello__sheen" />
          <span aria-hidden="true" className="relative">
            {drafting ? '◐' : '✦'}
          </span>
          <span className="relative">Ask Hello</span>
        </button>
      </div>

      {error && (
        <InlineNotice tone="danger" role="alert">
          {error}
        </InlineNotice>
      )}

      {createPortal(
        <Dialog
          open={confirmOpen}
          onClose={() => setConfirmOpen(false)}
          idPrefix={`${idPrefix}-ask-hello`}
          title="Replace what you've written?"
          description="Hello will draft a new scoring instruction and all four rubric levels from the name and description, replacing the text already in those fields."
          returnFocusRef={buttonRef}
        >
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
              Keep my text
            </Button>
            <Button variant="primary" onClick={confirmReplace}>
              Replace with Hello's draft
            </Button>
          </div>
        </Dialog>,
        document.body,
      )}
    </div>
  );
}
