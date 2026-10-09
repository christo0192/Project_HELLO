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
 * Staying on the newest line while the list RESIZES. Three things change the height of the list
 * or of what is in it without a new caption arriving: a sibling renders (the scenario card grows
 * to its briefing form and takes room from the column), a web font arrives and the lines wrap
 * differently, and the window or the scrollbar changes the width. A list that is pinned must be
 * on the newest line after each of them, so:
 *   - after every commit of this component a pinned list whose size changed is re-pinned in a
 *     layout effect, which is the moment the DOM is final and before the browser can run any
 *     other task or paint. A ResizeObserver alone is too late for a render caused by a parent:
 *     its callback runs in the next rendering step, and anything that looks at the page in
 *     between (a test, an assistive tool, a screenshot) sees the newest line cut off;
 *   - a ResizeObserver on the list (its viewport) AND on its content re-pins for the changes no
 *     render of ours announces (a font swap, a resize of the window, a scroll bar appearing).
 *     Observing the list alone misses content that grows inside a box that keeps its size.
 *
 * "Changed size" is the scroll height or the client height differing from what they were when we
 * last pinned. A commit or an observer callback that finds the same sizes does not touch the
 * scroll position: the reader may be partway through a scroll that has not yet taken them past
 * the at-the-end tolerance, and an unrelated render (the interviewer's level meter) must not
 * undo it.
 *
 * Screen readers. A caption keeps growing while it is interim, and a live region that sees its
 * text change reads the whole paragraph again. So the log is a polite region that announces
 * ADDITIONS only, and a line is added to the accessibility tree only once it is final: an
 * interim line is `aria-hidden` and, when it turns final, remounts under a new key as the one
 * addition that is read. The text exists once in the DOM, so nothing is announced twice.
 */
export function R1Captions({ captions }: R1CaptionsProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stuckRef = useRef(true);
  // Where WE last put the list. A browser reports a programmatic scroll later, in its next
  // rendering step, by when the box may have changed height (the scenario card appeared and
  // the list got shorter): read against the new geometry that echo would look like the reader
  // scrolling away. It is recognised by its position and ignored while pinned.
  const pinnedTopRef = useRef<number | null>(null);
  // The size of the list and of what it holds the last time WE put it on the end. Whether the
  // list needs to be put there again is a question about this, not about whether a commit
  // happened: see repinIfResized.
  const pinnedSizeRef = useRef<{ scrollHeight: number; clientHeight: number } | null>(null);
  // The newest caption the reader had seen when they scrolled away; null while pinned.
  const [awayFrom, setAwayFrom] = useState<{ id: string | null } | null>(null);

  const unseen = awayFrom ? countAfter(captions, awayFrom.id) : 0;

  function pinToEnd(): void {
    const element = listRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    pinnedTopRef.current = element.scrollTop;
    pinnedSizeRef.current = { scrollHeight: element.scrollHeight, clientHeight: element.clientHeight };
  }

  /**
   * Puts a followed list back on the end, but only if it changed size since we last put it there.
   * `stuck` stays true until a scroll event shows the reader MORE than STICK_PX from the end, so
   * for the first moments of a keyboard, smooth-wheel or trackpad scroll the reader is already
   * moving away while the list still counts as followed. Re-pinning on every commit, or on an
   * observer callback that reports a size we have already dealt with, undid that scroll whenever
   * anything unrelated rendered (the interviewer's level meter updates several times a second).
   * With the size unchanged the list is exactly where we left it plus whatever the reader has
   * done, and that is theirs to keep.
   */
  function repinIfResized(): void {
    if (!stuckRef.current) return;
    const element = listRef.current;
    if (!element) return;
    const pinned = pinnedSizeRef.current;
    if (
      pinned &&
      pinned.scrollHeight === element.scrollHeight &&
      pinned.clientHeight === element.clientHeight
    ) {
      return;
    }
    pinToEnd();
  }

  // After EVERY commit, not only one that changed the captions: the parent re-renders this
  // component when the box around it changed (a new caption, the scenario card, the phase), and
  // the list has then already been given its new height. A reader who scrolled away is left alone,
  // and so is one who is on their way: nothing moves unless the list changed size.
  useLayoutEffect(() => {
    repinIfResized();
  });

  // What no render announces: a web font replacing the fallback re-wraps every line, a window
  // resize changes the width, a scroll bar appears. The list and its content are both watched,
  // because a box that keeps its size can hold content that does not. jsdom has no ResizeObserver.
  useEffect(() => {
    const list = listRef.current;
    const content = contentRef.current;
    if (!list || !content || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      repinIfResized();
    });
    observer.observe(list);
    observer.observe(content);
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
          <div ref={contentRef} className="r1-captions__content">
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
