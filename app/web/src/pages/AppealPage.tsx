import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import type { AppealCreateInput } from '../types';
import {
  Button,
  Field,
  GlassPanel,
  InlineNotice,
  SelectField,
  TextArea,
} from '../components/design';

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
      <div className="app-ground flex min-h-screen items-start justify-center px-4 py-10">
        <main className="w-full max-w-2xl">
          <GlassPanel level="strong" padding="lg">
            <h1 className="text-title text-ink">Appeal submitted</h1>
            <InlineNotice tone="success" className="mt-4">
              Your appeal has been recorded. While it is under review, automated
              decision use for this screening is paused and a human reviewer will
              assess it.
            </InlineNotice>
          </GlassPanel>
        </main>
      </div>
    );
  }

  return (
    <div className="app-ground flex min-h-screen items-start justify-center px-4 py-10">
      <main className="w-full max-w-2xl">
        <GlassPanel level="strong" padding="lg">
          <h1 className="text-title text-ink">Request a review</h1>
          <p className="mt-1.5 max-w-xl text-sm leading-6 text-ink-secondary">
            If you believe a decision about your screening should be re-checked by
            a human, submit an appeal. A human reviewer will review it.
          </p>

          {!ready && (
            <p className="mt-5 text-sm text-ink-tertiary" role="status">
              Checking your link…
            </p>
          )}

          {ready && !tokenRef.current && (
            <InlineNotice tone="danger" role="alert" className="mt-5">
              This appeal link is missing, expired, revoked, or already used.
            </InlineNotice>
          )}

          {ready && tokenRef.current && (
            <form
              className="mt-6 space-y-5"
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <Field id="appeal-category" label="Category" className="max-w-xs">
                {({ id }) => (
                  <SelectField
                    id={id}
                    value={category}
                    onChange={(e) =>
                      setCategory(e.target.value as AppealCreateInput['category'])
                    }
                  >
                    {CATEGORIES.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </SelectField>
                )}
              </Field>

              <Field id="appeal-description" label="Description">
                {({ id }) => (
                  <>
                    <TextArea
                      id={id}
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      rows={5}
                      maxLength={2000}
                      required
                      placeholder="Explain what you would like a human to re-check…"
                    />
                    <p className="text-right text-xs text-ink-tertiary">
                      {description.length}/2000
                    </p>
                  </>
                )}
              </Field>

              {error && (
                <InlineNotice tone="danger" role="alert">
                  {error}
                </InlineNotice>
              )}

              <Button
                type="submit"
                variant="primary"
                size="lg"
                loading={submitting}
                disabled={description.trim().length === 0}
              >
                Submit appeal
              </Button>
            </form>
          )}
        </GlassPanel>
      </main>
    </div>
  );
}
