import { useState } from 'react';
import { api, ApiError } from '../api';
import { Button, Card } from './ui';

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
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-gray-900">LiveKit voice screening</h2>
          <p className="mt-0.5 text-xs text-gray-500">
            Create a one-time invite for {candidateName || 'this candidate'}.
          </p>
        </div>
        <Button onClick={createInvite} loading={busy} className="shrink-0">
          Create Invite
        </Button>
      </div>
      {inviteUrl && (
        <div className="mt-3 space-y-2">
          <label className="block text-xs font-medium text-gray-700" htmlFor="candidate-invite-url">
            Candidate invite (shown once)
          </label>
          <input
            id="candidate-invite-url"
            readOnly
            value={inviteUrl}
            className="w-full rounded border border-gray-300 px-2 py-1 text-xs"
          />
          <Button onClick={copyInvite}>Copy Invite</Button>
          {expiresAt && <p className="text-xs text-gray-500">Expires {new Date(expiresAt).toLocaleString()}.</p>}
        </div>
      )}
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
    </Card>
  );
}
