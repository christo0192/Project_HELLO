/**
 * One round's notes, read once for the Recording tab: the Notes panel lists them and the strip ticks
 * them. A failed read fails only the notes, and says so in their panel: the video and the transcript
 * carry on. `retry` reads again; `add` puts a saved note on the list, so a note needs no second read.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import type { Note } from '../../types';

export type RoundNotes =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; notes: readonly Note[] };

export function useRoundNotes(roundId: string) {
  const [state, setState] = useState<RoundNotes>({ status: 'loading' });
  const [readKey, setReadKey] = useState(0);

  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(() => api.listRoundNotes(roundId))
      .then(({ notes }) => {
        if (live) setState({ status: 'ready', notes });
      })
      .catch(() => {
        if (live) setState({ status: 'failed' });
      });
    return () => {
      live = false;
    };
  }, [roundId, readKey]);

  const retry = useCallback(() => {
    setState({ status: 'loading' });
    setReadKey((key) => key + 1);
  }, []);

  const add = useCallback((note: Note) => {
    setState((current) => (current.status === 'ready' ? { ...current, notes: [...current.notes, note] } : current));
  }, []);

  return { state, retry, add };
}
