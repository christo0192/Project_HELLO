/**
 * The second tab of Recording's right panel: a reviewer's own words, each pinned to a moment.
 *
 * Notes are human words, so nothing here is labelled AI, and they reach no AI (the API fences that). A
 * note is append-only: there is no edit and no delete, so a save must never run twice. A second press
 * while one is on its way does nothing, and a failed save keeps the words for Try again.
 *
 * THE MOMENT. "Add note at 7:42" follows the playhead, written straight to the DOM by the panel as the
 * clock is, so a playing video costs no render. Pressing it pins that second: the call can play on while
 * the reader types, and the note stays where they pressed. With nothing to play there is no second to
 * pin, so the button says "Add note" and the note belongs to the attempt alone.
 *
 * THE TIMECODE is the seek button and the words are plain text, as in the transcript, so a note can be
 * selected and copied. It moves the position and starts nothing: with no link yet it only cues, and the
 * first play starts from there.
 *
 * THE AUTHOR. No staff name may be shown here: emails stay with admins, and no other name is held, so a
 * note says You or a short id (`noteAuthor`).
 *
 * The rows scroll in their own box, by that box's scroll position, so the page behind never jumps.
 */
import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { Ref } from 'react';
import { Button, Field, InlineNotice, RetryButton, TextArea, cx } from '../design';
import { formatDateTime } from '../../lib/datetime';
import { clockText } from '../../lib/r1-recording';
import { noteAuthor } from '../../lib/r1-review';
import type { AttemptNote } from '../../lib/r1-review';

/** The API's bound on a note (0015). */
const NOTE_MAX_CHARS = 2000;

const plural = (count: number) => `${count} note${count === 1 ? '' : 's'}`;

interface Draft {
  /** The second the reader pressed. Null: this attempt has nothing to play. */
  sec: number | null;
  text: string;
}

/** A note to bring into view. `nonce` tells a second press on one tick from a re-render. */
export interface NoteCue {
  id: string;
  nonce: number;
}

export interface ReviewNotesProps {
  /** Null while there is no answer: `failed` says which kind of nothing that is. */
  notes: readonly AttemptNote[] | null;
  failed: boolean;
  /** The person reading, to say You. Null when that could not be read. */
  reviewerId: string | null;
  /** Viewers read. Nobody is offered a write when who is asking cannot be read. */
  mayAdd: boolean;
  /** Where the playhead is now. Null: this attempt has nothing to play, so nothing to seek or pin. */
  positionSec: (() => number) | null;
  /** The panel writes the playhead's clock here. */
  clockRef: Ref<HTMLSpanElement>;
  cue: NoteCue | null;
  onSeek: (sec: number) => void;
  /** Rejects when the note was not saved. */
  onAdd: (text: string, sec: number | null) => Promise<void>;
  onRetry: () => void;
  className?: string;
}

interface RowProps {
  note: AttemptNote;
  author: string;
  onSeek: ((sec: number) => void) | null;
}

function Row({ note, author, onSeek }: RowProps) {
  const { sec } = note;
  return (
    <li data-note-row={note.id} className="grid grid-cols-[3.75rem_minmax(0,1fr)] gap-x-3 px-4 py-2.5">
      <div className="font-mono text-meta leading-5">
        {sec === null ? (
          <span className="block font-sans text-ink-tertiary">No time</span>
        ) : onSeek ? (
          <button
            type="button"
            onClick={() => onSeek(sec)}
            aria-label={`Go to ${clockText(sec)}, note by ${author}`}
            className="block rounded-evidence text-ink-secondary hover:underline focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ink)]"
          >
            {clockText(sec)}
          </button>
        ) : (
          <span className="block text-ink-secondary">{clockText(sec)}</span>
        )}
      </div>
      <div className="min-w-0">
        <p className="flex flex-wrap items-baseline justify-between gap-x-2 text-meta leading-5">
          <span className="font-medium text-ink-secondary">{author}</span>
          <time dateTime={note.created_at} className="text-ink-tertiary">
            {formatDateTime(note.created_at)}
          </time>
        </p>
        <p className="whitespace-pre-wrap break-words text-sm leading-[1.3125rem] text-ink">{note.note}</p>
      </div>
    </li>
  );
}

export function ReviewNotes({
  notes,
  failed,
  reviewerId,
  mayAdd,
  positionSec,
  clockRef,
  cue,
  onSeek,
  onAdd,
  onRetry,
  className,
}: ReviewNotesProps) {
  const headingId = useId();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const savingRef = useRef(false);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const backToAddRef = useRef(false);

  // The box takes focus as it opens; the button gets it back when the box goes.
  const open = draft !== null;
  useLayoutEffect(() => {
    if (open) {
      boxRef.current?.focus({ preventScroll: true });
    } else if (backToAddRef.current) {
      backToAddRef.current = false;
      addRef.current?.focus({ preventScroll: true });
    }
  }, [open]);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || !cue) return;
    const row = scroller.querySelector<HTMLElement>(`[data-note-row="${cue.id}"]`);
    if (row) scroller.scrollTop = Math.max(0, row.offsetTop - scroller.clientHeight / 3);
  }, [cue]);

  const close = () => {
    backToAddRef.current = true;
    setDraft(null);
    setSaveFailed(false);
  };

  const save = async () => {
    const text = draft?.text.trim();
    if (!draft || !text || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveFailed(false);
    try {
      await onAdd(text, draft.sec);
      setAnnouncement(draft.sec === null ? 'Note added.' : `Note added at ${clockText(draft.sec)}.`);
      close();
    } catch {
      setSaveFailed(true);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const seek = positionSec ? onSeek : null;

  return (
    <section aria-labelledby={headingId} className={cx('flex min-h-0 flex-col', className)}>
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
      <h2 id={headingId} className="sr-only">
        Notes
      </h2>

      <div className="space-y-2 border-b border-line px-4 pb-3">
        <p className="text-meta tabular-nums text-ink-tertiary">{notes ? plural(notes.length) : 'Notes'}</p>
        {mayAdd && notes && !draft && (
          <Button
            ref={addRef}
            size="sm"
            onClick={() => {
              setAnnouncement('');
              setDraft({ sec: positionSec ? positionSec() : null, text: '' });
            }}
          >
            {/* One flex item: the button spaces its children apart. */}
            {positionSec ? (
              <span>
                Add note at{' '}
                <span ref={clockRef} className="font-mono">
                  {clockText(positionSec())}
                </span>
              </span>
            ) : (
              'Add note'
            )}
          </Button>
        )}
        {draft && (
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <Field label={draft.sec === null ? 'Note' : `Note at ${clockText(draft.sec)}`}>
              {({ id, describedBy }) => (
                <TextArea
                  ref={boxRef}
                  id={id}
                  aria-describedby={describedBy}
                  value={draft.text}
                  maxLength={NOTE_MAX_CHARS}
                  onChange={(event) => setDraft({ ...draft, text: event.target.value })}
                />
              )}
            </Field>
            {saveFailed && (
              <InlineNotice tone="danger" role="alert" action={<RetryButton onRetry={() => void save()} />}>
                This note was not saved. Your words are still here.
              </InlineNotice>
            )}
            <div className="flex gap-2">
              <Button type="submit" size="sm" loading={saving} disabled={!draft.text.trim()}>
                Save note
              </Button>
              <Button variant="ghost" size="sm" disabled={saving} onClick={close}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </div>

      <div
        ref={scrollerRef}
        role="region"
        aria-label="Notes list"
        tabIndex={0}
        className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--ink)]"
      >
        {failed ? (
          <div className="px-4 py-3">
            <InlineNotice tone="danger" role="alert" action={<RetryButton onRetry={onRetry} />}>
              These notes could not be read.
            </InlineNotice>
          </div>
        ) : !notes ? (
          <p className="px-4 py-6 text-sm text-ink-secondary">Loading notes…</p>
        ) : notes.length === 0 ? (
          <p className="px-4 py-6 text-sm text-ink-secondary">No notes on this attempt yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {notes.map((note) => (
              <Row key={note.id} note={note} author={noteAuthor(note.author_id, reviewerId)} onSeek={seek} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
