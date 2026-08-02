import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import type { AppealCreateInput } from '../types';
import { Button, Card } from '../components/ui';

/**
 * Phase 9 L4 — candidate appeal submission (invariant 8).
 *
 * The one-time appeal grant token arrives in the URL FRAGMENT, is captured
 * into memory only (a ref), and the fragment is removed immediately. It is
 * never stored in state/local/session storage and never logged. Missing or
 * malformed fragment → no API call, fail closed.
 *
 * On success the server sets candidates.decision_use_blocked_at — the web
 * explicitly tells the candidate the decision is now under human review.
 */

const CATEGORIES: Array<{ value: AppealCreateInput['category']; label: string }> = [
  { value: 'scoring', label: 'Scoring concern' },
  { value: 'recording', label: 'Recording issue' },
  { value: 'accessibility', label: 'Accessibility' },
  { value: 'other', label: 'Other' },
];

export function AppealPage() {
  const tokenRef = useRef<string | null>(null);
  const [ready, setReady] = useState(false);
  const [category, setCategory] = useState<AppealCreateInput['category']>('scoring');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    const raw = window.location.hash.slice(1);
    const token = raw ? decodeURIComponent(raw) : '';
    tokenRef.current = token || null;
    // Fragment removed immediately — never stored/logged.
    window.history.replaceState(null, '', '/appeal');
    setReady(true);
  }, []);

  async function submit() {
    const token = tokenRef.current;
    if (!token || submitted) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.submitAppeal({
        appeal_grant_token: token,
        category,
        description,
      });
      // Token is single-use; drop it immediately.
      tokenRef.current = null;
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to submit your appeal.');
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <main className="mx-auto flex min-h-screen max-w-xl items-center px-4">
        <Card className="w-full p-6">
          <h1 className="text-xl font-semibold text-gray-900">Appeal submitted</h1>
          <p className="mt-2 text-sm text-gray-600">
            Your appeal has been recorded. While it is under review, automated
            decision use for this screening is paused and a human reviewer will
            assess it.
          </p>
        </Card>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-xl items-center px-4">
      <Card className="w-full p-6">
        <h1 className="text-xl font-semibold text-gray-900">Request a review</h1>
        <p className="mt-2 text-sm text-gray-600">
          If you believe a decision about your screening should be re-checked by
          a human, submit an appeal. A human reviewer will review it.
        </p>

        {!ready && (
          <p className="mt-4 text-sm text-gray-500" role="status">
            Checking your link…
          </p>
        )}

        {ready && !tokenRef.current && (
          <p className="mt-4 text-sm text-red-600" role="alert">
            This appeal link is missing, expired, revoked, or already used.
          </p>
        )}

        {ready && tokenRef.current && (
          <form
            className="mt-5 space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <div>
              <label htmlFor="appeal-category" className="block text-sm font-medium text-gray-700">
                Category
              </label>
              <select
                id="appeal-category"
                value={category}
                onChange={(e) => setCategory(e.target.value as AppealCreateInput['category'])}
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-accent-500 focus:outline-none focus:ring-accent-500"
              >
                {CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="appeal-description" className="block text-sm font-medium text-gray-700">
                Description
              </label>
              <textarea
                id="appeal-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={5}
                maxLength={2000}
                required
                placeholder="Explain what you would like a human to re-check…"
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-accent-500 focus:outline-none focus:ring-accent-500"
              />
              <p className="mt-1 text-right text-xs text-gray-400">{description.length}/2000</p>
            </div>

            {error && (
              <p className="text-sm text-red-600" role="alert">
                {error}
              </p>
            )}

            <Button type="submit" loading={submitting} disabled={description.trim().length === 0}>
              Submit appeal
            </Button>
          </form>
        )}
      </Card>
    </main>
  );
}
