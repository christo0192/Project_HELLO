/**
 * usePhoneAttemptHistory — the candidate's phone-attempt list, loaded once.
 *
 * Its own module (not CandidateOverviewSections.tsx) so that component file
 * keeps exporting only components (react-refresh/only-export-components).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import type { CandidatePhoneAttempt } from '../../types';

/**
 * The attempt list for one candidate, loaded once and shareable.
 *
 * `CandidateDetailPage` renders the list in two places (the Overview rail,
 * and the Review tab's empty state), each mounted only while its tab is open
 * so there is one player on the page. Self-loading copies would refetch
 * `/phone-attempts` on every tab switch; the page calls this hook ONCE and
 * hands the result to both copies. A copy given no `source` loads its own
 * (`enabled` stays true).
 */
export interface PhoneAttemptHistorySource {
  attempts: CandidatePhoneAttempt[] | null;
  nextCursor: string | null;
  error: boolean;
  reload: () => void;
  loadOlder: () => void;
}

export function usePhoneAttemptHistory(candidateId: string, enabled = true): PhoneAttemptHistorySource {
  const [attempts, setAttempts] = useState<CandidatePhoneAttempt[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState(false);
  // A response for a previous candidate (or a superseded reload) is ignored.
  const generation = useRef(0);

  const load = useCallback((before?: string, append = false) => {
    if (!enabled) return;
    const gen = ++generation.current;
    setError(false);
    // Candidate-scoped embedded hosts can provide a reduced API adapter. The
    // production adapter always has this method; absence is a truthful empty
    // state for those legacy hosts rather than a render failure.
    if (typeof api.getCandidatePhoneAttempts !== 'function') {
      setAttempts([]);
      setNextCursor(null);
      return;
    }
    Promise.resolve()
      .then(() => api.getCandidatePhoneAttempts(candidateId, before))
      .then((result) => {
        if (gen !== generation.current) return;
        setAttempts((current) => append && current ? [...current, ...result.attempts] : result.attempts);
        setNextCursor(result.next_cursor);
      })
      .catch(() => {
        if (gen !== generation.current) return;
        setAttempts(null);
        setError(true);
      });
  }, [candidateId, enabled]);

  // A different candidate (or the list being switched off) starts from
  // nothing: never render, or offer to play, the previous candidate's
  // attempts while the next one's fetch is in flight.
  useEffect(() => {
    setAttempts(null);
    setNextCursor(null);
    setError(false);
    load();
    return () => { generation.current += 1; };
  }, [load]);

  return {
    attempts,
    nextCursor,
    error,
    reload: () => load(),
    loadOlder: () => { if (nextCursor) load(nextCursor, true); },
  };
}
