import { useState } from 'react';
import { api, ApiError } from '../api';
import { Button, controlClass, cx } from './design';
import { SurfaceCard } from './design/candidate';
import { formatDateTime } from '../lib/datetime';

/** Recruiter control: create the room, then issue a one-time candidate invite. */
export function LiveKitCallCard({
  candidateId,
  candidateName,
}: {
  candidateId: string;
  candidateName?: string | null;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);

  async function createInvite() {
    setBusy(true);
    setError(null);
    setInviteUrl(null);
    try {
      const session = await api.startLiveKitScreening(candidateId);
      const invite = await api.issueLiveKitInvite(candidateId, session.session_id);
      // The secret is in the fragment, which is not sent in HTTP requests or Referer.
      const url = `${window.location.origin}/candidate/join#${encodeURIComponent(invite.token)}`;
      setInviteUrl(url);
      setExpiresAt(invite.expires_at);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create candidate invite.');
    } finally {
      setBusy(false);
    }
  }

  async function copyInvite() {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
    } catch {
      setError('Copy failed. Select and copy the invite manually.');
    }
  }

  return (
    <SurfaceCard as="section" labelledBy="browser-screening-title" className="p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          {/* Named for what the recruiter does, not the vendor behind it. */}
          <h2 id="browser-screening-title" className="text-section text-ink">
            Browser voice screening
          </h2>
          <p className="mt-1 text-label text-ink-secondary">
            Create a one-time invite for {candidateName || 'this candidate'}.
          </p>
        </div>
        <Button variant="secondary" onClick={createInvite} loading={busy} className="shrink-0">
          Create invite
        </Button>
      </div>
      {inviteUrl && (
        <div className="mt-4 space-y-2">
          <label className="block text-label font-medium text-ink" htmlFor="candidate-invite-url">
            Candidate invite (shown once)
          </label>
          <div className="flex flex-wrap gap-2">
            <input
              id="candidate-invite-url"
              readOnly
              value={inviteUrl}
              className={cx(controlClass, 'min-w-0 flex-1 font-mono text-xs')}
            />
            <Button onClick={copyInvite}>Copy invite</Button>
          </div>
          {expiresAt && (
            <p className="text-meta text-ink-tertiary">Expires {formatDateTime(expiresAt)}.</p>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-error-text">
          {error}
        </p>
      )}
    </SurfaceCard>
  );
}
