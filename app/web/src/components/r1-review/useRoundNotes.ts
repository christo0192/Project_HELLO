/**
 * One round's notes, read once for the Recording tab: the Notes panel lists them and the strip ticks
 * them. A failed read fails only the notes, and says so in their panel: the video and the transcript
 * carry on. `retry` reads again.
 *
 * A saved note needs no second read: the keeper has it, and it joins the answer by id. That holds
 * whichever panel pressed Save, and for a read that began before the save and answers without the note.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { api } from '../../api';
import type { Note } from '../../types';
import type { NoteKeeper } from './noteKeeper';

export type RoundNotes =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; notes: readonly Note[] };

export function useRoundNotes(roundId: string, keeper: NoteKeeper) {
  const [read, setRead] = useState<RoundNotes>({ status: 'loading' });
  const [readKey, setReadKey] = useState(0);
  const saved = useSyncExternalStore(keeper.subscribe, keeper.saved);

  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(() => api.listRoundNotes(roundId))
      .then(({ notes }) => {
        if (live) setRead({ status: 'ready', notes });
      })
      .catch(() => {
        if (live) setRead({ status: 'failed' });
      });
    return () => {
      live = false;
    };
  }, [roundId, readKey]);

  const retry = useCallback(() => {
    setRead({ status: 'loading' });
    setReadKey((key) => key + 1);
  }, []);

  const state = useMemo<RoundNotes>(() => {
    if (read.status !== 'ready') return read;
    const listed = new Set(read.notes.map((note) => note.id));
    return { status: 'ready', notes: [...read.notes, ...saved.filter((note) => note.round_id === roundId && !listed.has(note.id))] };
  }, [read, roundId, saved]);

  return { state, retry };
}
