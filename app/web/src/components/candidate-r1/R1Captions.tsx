import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { R1_CAPTION_SPEAKER_LABELS, type R1Caption } from '../../lib/r1/r1-phase';

/** Within this many pixels of the end still counts as "reading the latest line". */
const STICK_PX = 48;

interface R1CaptionsProps {
  captions: readonly R1Caption[];
}

/** How many captions came in after `anchorId` (all of them when it is no longer in the list). */
function countAfter(captions: readonly R1Caption[], anchorId: string | null): number {
  const index = anchorId === null ? -1 : captions.findIndex((caption) => caption.id === anchorId);
  return index < 0 ? captions.length : captions.length - 1 - index;
}

/**
 * The captions card. The list is its OWN scroll region: the live view bounds the card, so a
 * long interview scrolls in here and the page never grows.
 *
 *   - It follows the newest line, including a line that is still growing, while the reader is
 *     within a line of the end.
 *   - Once the reader scrolls up to reread, the position is held and a "Jump to latest (N new)"
 *     button offers the way back. Using it re-pins the list and hands focus to the log, because
 *     the button unmounts and a keyboard user must not be dropped on the page.
 *   - The list is focusable (`tabIndex`) so a keyboard user can scroll it with the arrow keys.
 *
 * Screen readers. A caption keeps growing while it is interim, and a live region that sees its
 * text change reads the whole paragraph again. So the log is a polite region that announces
 * ADDITIONS only, and a line is added to the accessibility tree only once it is final: an
 * interim line is `aria-hidden` and, when it turns final, remounts under a new key as the one
 * addition that is read. The text exists once in the DOM, so nothing is announced twice.
 */
export function R1Captions({ captions }: R1CaptionsProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const stuckRef = useRef(true);
  // Where WE last put the list. A browser reports a programmatic scroll later, in its next
  // rendering step, by when the box may have changed height (the scenario card appeared and
  // the list got shorter): read against the new geometry that echo would look like the reader
  // scrolling away. It is recognised by its position and ignored while pinned.
  const pinnedTopRef = useRef<number | null>(null);
  // The newest caption the reader had seen when they scrolled away; null while pinned.
  const [awayFrom, setAwayFrom] = useState<{ id: string | null } | null>(null);

  const unseen = awayFrom ? countAfter(captions, awayFrom.id) : 0;

  function pinToEnd(): void {
    const element = listRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    pinnedTopRef.current = element.scrollTop;
  }

  // Follow new and growing lines while the reader is at the end.
  useLayoutEffect(() => {
    if (stuckRef.current) pinToEnd();
  }, [captions]);

  // The box can change height under a pinned log (the scenario card appears at the briefing and
  // takes room from it): stay on the newest line. jsdom has no ResizeObserver.
  useEffect(() => {
    const element = listRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      if (stuckRef.current) pinToEnd();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  function onScroll(): void {
    const element = listRef.current;
    if (!element) return;
    if (stuckRef.current && element.scrollTop === pinnedTopRef.current) return;
    const atEnd = element.scrollHeight - element.scrollTop - element.clientHeight <= STICK_PX;
    if (atEnd) {
      stuckRef.current = true;
      setAwayFrom(null);
      return;
    }
    if (stuckRef.current) {
      stuckRef.current = false;
      setAwayFrom({ id: captions.length > 0 ? captions[captions.length - 1].id : null });
    }
  }

  function jumpToLatest(): void {
    stuckRef.current = true;
    setAwayFrom(null);
    pinToEnd();
    // The button is about to unmount: keep the keyboard where the log is.
    listRef.current?.focus({ preventScroll: true });
  }

  return (
    <section className="candidate-glass-card candidate-interview__captions" aria-label="Live captions">
      <h2>Captions</h2>
      <div className="r1-captions__body">
        <div
          ref={listRef}
          className="candidate-caption-list r1-captions__list"
          role="log"
          aria-label="Transcript"
          aria-live="polite"
          aria-relevant="additions"
          tabIndex={0}
          onScroll={onScroll}
        >
          {captions.length === 0 ? (
            <p className="candidate-muted">Listening for the interviewer…</p>
          ) : (
            captions.map((caption) => (
              <p
                className="candidate-caption"
                key={caption.final ? `${caption.id}:final` : caption.id}
                aria-hidden={caption.final ? undefined : true}
              >
                <small data-speaker={caption.speaker}>
                  {R1_CAPTION_SPEAKER_LABELS[caption.speaker]}
                </small>
                {caption.text}
              </p>
            ))
          )}
        </div>
        {awayFrom && (
          <button type="button" className="r1-captions__jump" onClick={jumpToLatest}>
            {unseen > 0 ? `Jump to latest (${unseen} new)` : 'Jump to latest'}
          </button>
        )}
      </div>
    </section>
  );
}
