/**
 * IssuedLink: the one place a candidate's R1 join link is ever shown.
 *
 * The API returns the link exactly once (it keeps only a digest), so this
 * component is a handover, not a display. Invariants:
 *  - The URL lives in the caller's state and in this input, nowhere else:
 *    never storage, never a URL query, never a log. Dismissing unmounts it.
 *  - Focus moves into the field on mount with the link selected, so a
 *    keyboard or screen-reader user can copy it without hunting for it.
 *  - The "shown once" warning is visible text tied to the field, not a
 *    tooltip, and copy success or failure is announced politely.
 *
 * Renders inside `.candidate-scope`: colour comes from `--c-*` tokens only,
 * and no motion library is imported (see candidate-scope-palette.test.ts).
 */
import { useEffect, useId, useRef, useState } from 'react';
import { CandidateButton, CandidateInput } from '../design/candidate';
import { formatDateTime } from '../../lib/datetime';
import { R1_LINK_VALID_HOURS } from '../../lib/r1';

export interface IssuedLinkProps {
  url: string;
  /**
   * ISO instant the link stops working, or null when the API did not say
   * (a reissue returns only the URL): the validity period is still stated.
   */
  expiresAt: string | null;
  /** `reissue` also says the previous link no longer works. */
  kind: 'send' | 'reissue';
  /** Called when the person confirms they have the link. The URL is then dropped. */
  onDismiss: () => void;
}

export function IssuedLink({ url, expiresAt, kind, onDismiss }: IssuedLinkProps) {
  const uid = useId().replace(/:/g, '');
  const headingId = `r1-link-${uid}-heading`;
  const inputId = `r1-link-${uid}-input`;
  const warningId = `r1-link-${uid}-warning`;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(url);
      setCopy('copied');
    } catch {
      setCopy('failed');
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }

  return (
    <div
      role="group"
      aria-labelledby={headingId}
      className="glass-sunken mt-4 space-y-3 p-4"
    >
      <h3 id={headingId} className="text-label font-medium text-ink">
        {kind === 'reissue' ? 'New candidate link' : 'Candidate link'}
      </h3>
      <p id={warningId} className="text-sm text-ink-secondary">
        This link is shown once. Copy it now and send it to the candidate; it cannot be
        shown again.
        {kind === 'reissue' ? ' The previous link has stopped working.' : ''} It is valid for{' '}
        {R1_LINK_VALID_HOURS} hours{expiresAt ? ` (until ${formatDateTime(expiresAt)})` : ''}.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1 basis-64">
          <label
            htmlFor={inputId}
            className="mb-1 block text-sm font-medium text-[var(--c-ink-secondary)]"
          >
            R1 link for the candidate
          </label>
          <CandidateInput
            id={inputId}
            ref={inputRef}
            readOnly
            value={url}
            autoComplete="off"
            spellCheck={false}
            aria-describedby={warningId}
            className="w-full font-mono text-xs"
          />
        </div>
        <CandidateButton variant="secondary" onClick={() => void copyLink()}>
          Copy link
        </CandidateButton>
      </div>
      {/* Mounted for the life of the group so the announcement is reliable. */}
      <p aria-live="polite" className="min-h-5 text-sm text-ink-secondary">
        {copy === 'copied' ? 'Link copied to the clipboard.' : null}
        {copy === 'failed'
          ? 'Copy failed. The link is selected; press Ctrl+C (or Cmd+C) to copy it.'
          : null}
      </p>
      <div>
        <CandidateButton variant="primary" onClick={onDismiss}>
          I have copied the link
        </CandidateButton>
      </div>
    </div>
  );
}
