/**
 * What outlives a Recording panel: the words in a note's box, a save on its way, and the notes saved.
 *
 * A panel goes with its attempt, and a save can outlive the panel that pressed it. So the page holds one
 * keeper above the key on RecordingPanel, and whichever panel is on screen follows it. A panel subscribes
 * rather than taking props, so typing renders the box and nothing above it.
 *
 * A note is append-only, so a save must never run twice. Words on their way stay in their draft, marked
 * `saving`: a panel that comes back shows the save still running, and a second press from any panel does
 * nothing. A failed save hands the words back as `failed`, for Try again.
 *
 * `saved` is every note saved on this visit. A read that began before a save answers without it, so the
 * list merges these in by id (`useRoundNotes`) and a saved note is never missing from the list.
 */
import type { Note } from '../../types';

export interface NoteDraft {
  /** The second the reader pressed. Null: this attempt has nothing to play. */
  sec: number | null;
  text: string;
  /** These words are on their way. */
  saving?: boolean;
  /** The last save of these words failed. */
  failed?: boolean;
}

export interface NoteKeeper {
  subscribe(listener: () => void): () => void;
  draft(sessionId: string): NoteDraft | null;
  setDraft(sessionId: string, draft: NoteDraft | null): void;
  saved(): readonly Note[];
  /** Sends the attempt's words, unless a save of them is already on its way. */
  save(sessionId: string, send: (text: string, sec: number | null) => Promise<Note>): Promise<void>;
}

export function createNoteKeeper(): NoteKeeper {
  const drafts = new Map<string, NoteDraft>();
  const listeners = new Set<() => void>();
  let saved: readonly Note[] = [];

  const setDraft = (sessionId: string, draft: NoteDraft | null) => {
    if (draft) drafts.set(sessionId, draft);
    else drafts.delete(sessionId);
    for (const listener of listeners) listener();
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    draft: (sessionId) => drafts.get(sessionId) ?? null,
    setDraft,
    saved: () => saved,
    async save(sessionId, send) {
      const draft = drafts.get(sessionId);
      const text = draft?.text.trim();
      if (!draft || !text || draft.saving) return;
      setDraft(sessionId, { ...draft, saving: true, failed: false });
      try {
        const note = await send(text, draft.sec);
        saved = [...saved, note];
        setDraft(sessionId, null);
      } catch {
        setDraft(sessionId, { ...draft, saving: false, failed: true });
      }
    },
  };
}
