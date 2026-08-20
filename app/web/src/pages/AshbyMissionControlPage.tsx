import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import type { AshbyMcMapping, AshbyMcWorkflow } from '../types';
import { Card } from '../components/ui';

/**
 * Ashby Mission Control — admin-gated HR surface for the Ashby screening
 * workflow. Shows job-mapping health (paused/drift/completeness) and the
 * per-application workflow state (lifecycle, terminal, ingestion, operations),
 * with audited actions (pause/resume/cancel/retry) and the manual invite
 * hand-off. All LIST data is sanitized by the API: no candidate PII, invite
 * tokens, presigned URLs, or transcripts. The APIs are authoritative; this UI
 * is admin-gated for UX only.
 *
 * INVITE HANDLING: `Get invite link` calls the admin-only delivery endpoint,
 * which returns a one-time candidate URL. That URL is held in component state
 * ONLY — never localStorage/sessionStorage, never the page URL, never
 * telemetry — and the token rides in the URL fragment so it is not sent to any
 * server or written to an access log. The server keeps only its SHA-256
 * digest, so the link genuinely cannot be shown again; reissuing revokes the
 * previous one.
 */
export function AshbyMissionControlPage() {
  const [mappings, setMappings] = useState<AshbyMcMapping[]>([]);
  const [workflows, setWorkflows] = useState<AshbyMcWorkflow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  /**
   * The one-time invite link for a single application, held in COMPONENT STATE
   * ONLY. It is never written to localStorage/sessionStorage, never put in the
   * URL, and never sent to analytics — the API returns it exactly once and the
   * server keeps only its SHA-256 digest.
   */
  const [invite, setInvite] = useState<
    { linkId: string; joinUrl: string; expiresAt: string } | null
  >(null);
  const [inviteError, setInviteError] = useState<{ linkId: string; message: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const [m, w] = await Promise.all([api.listAshbyMappings(), api.listAshbyWorkflows()]);
      setMappings(m.mappings);
      setWorkflows(w.workflows);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load Mission Control');
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(
    async (action: () => Promise<{ ok: boolean; error?: string }>) => {
      setBusy(true);
      try {
        const res = await action();
        if (!res.ok) setError(res.error ?? 'Action rejected');
        else setError(null);
        await load();
      } catch (e) {
        setError(e instanceof ApiError ? e.message : 'Action failed');
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  /** Request a fresh invite link for one application (admin-only server-side). */
  const deliverInvite = useCallback(
    async (linkId: string) => {
      setBusy(true);
      setInviteError(null);
      setCopied(false);
      try {
        const res = await api.deliverAshbyManualInvite(linkId);
        if (res.ok && res.join_url && res.expires_at) {
          setInvite({ linkId, joinUrl: res.join_url, expiresAt: res.expires_at });
        } else {
          setInvite(null);
          setInviteError({ linkId, message: res.error ?? 'Could not issue an invite link' });
        }
      } catch (e) {
        setInvite(null);
        setInviteError({
          linkId,
          message: e instanceof ApiError ? e.message : 'Could not issue an invite link',
        });
      } finally {
        setBusy(false);
        // Reload so the delivery operation's new state is reflected truthfully.
        await load();
      }
    },
    [load],
  );

  const copyInvite = useCallback(async () => {
    if (!invite) return;
    try {
      await navigator.clipboard.writeText(invite.joinUrl);
      setCopied(true);
    } catch {
      // Clipboard can be denied; the link stays selectable in the field.
      setCopied(false);
    }
  }, [invite]);

  const mappingTone = (status: string): string =>
    status === 'enabled'
      ? 'text-emerald-700'
      : status === 'drift'
        ? 'text-red-700'
        : 'text-amber-700';

  return (
    <main className="mx-auto max-w-5xl px-4 py-6">
      <h1 className="text-xl font-semibold text-gray-900">Ashby Mission Control</h1>
      <p className="mt-1 text-sm text-gray-500">
        Screening-workflow health and controls. Data is sanitized — no candidate PII or tokens.
      </p>

      {!loaded && (
        <p className="mt-4 text-sm text-gray-500" role="status">
          Loading…
        </p>
      )}
      {error && (
        <p className="mt-4 text-sm text-red-600" role="alert">
          {error}
        </p>
      )}

      <Card className="mt-6 p-4">
        <h2 className="text-base font-semibold text-gray-900">Job mappings</h2>
        {loaded && mappings.length === 0 && (
          <p className="mt-2 text-sm text-gray-500">No mappings.</p>
        )}
        <ul className="mt-3 divide-y divide-gray-100">
          {mappings.map((m) => (
            <li key={m.id} className="flex items-center justify-between py-2">
              <div>
                <span className="font-mono text-sm text-gray-800">{m.externalJobId}</span>
                <span className={`ml-3 text-sm font-semibold ${mappingTone(m.status)}`}>{m.status}</span>
                {!(m.hasAiStage && m.hasTaStage) && (
                  <span className="ml-2 text-xs text-amber-600">incomplete</span>
                )}
                {m.statusReason && <span className="ml-2 text-xs text-gray-400">{m.statusReason}</span>}
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={busy || m.status === 'paused'}
                  onClick={() => run(() => api.pauseAshbyMapping(m.id))}
                  className="rounded border border-gray-300 px-2 py-1 text-xs disabled:opacity-40"
                >
                  Pause
                </button>
                <button
                  type="button"
                  disabled={busy || m.status === 'enabled' || !(m.hasAiStage && m.hasTaStage)}
                  onClick={() => run(() => api.resumeAshbyMapping(m.id))}
                  className="rounded border border-gray-300 px-2 py-1 text-xs disabled:opacity-40"
                >
                  Resume
                </button>
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <Card className="mt-6 p-4">
        <h2 className="text-base font-semibold text-gray-900">Application workflows</h2>
        {loaded && workflows.length === 0 && (
          <p className="mt-2 text-sm text-gray-500">No workflows.</p>
        )}
        <ul className="mt-3 divide-y divide-gray-100">
          {workflows.map((w) => (
            <li key={w.applicationLinkId} className="py-2">
              <div className="flex items-center justify-between">
                <div>
                  <span className="font-mono text-sm text-gray-800">{w.externalApplicationId}</span>
                  <span className="ml-3 text-sm text-gray-600">{w.lifecycle}</span>
                  {w.terminalState && <span className="ml-2 text-xs text-red-600">{w.terminalState}</span>}
                  {w.ingestionState && (
                    <span className="ml-2 text-xs text-gray-500">ingest: {w.ingestionState}</span>
                  )}
                  {/* A completed screening whose link never reached
                      `writeback_pending` is a completion park that did not
                      land. The observer is best-effort by design (it must
                      never discard a scored assessment), so this is where that
                      case becomes visible instead of living only in a log. */}
                  {w.sessionStatus === 'completed'
                    && w.terminalState == null
                    && w.lifecycle !== 'writeback_pending' && (
                    <span className="ml-2 text-xs text-amber-700">screened: not parked</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {w.sessionId && w.sessionStatus === 'completed' && (
                    <a
                      href={`/sessions/${encodeURIComponent(w.sessionId)}`}
                      className="rounded border border-blue-300 px-2 py-1 text-xs text-blue-800"
                    >
                      Review screening
                    </a>
                  )}
                  <button
                    type="button"
                    disabled={busy || w.terminalState != null}
                    onClick={() => void deliverInvite(w.applicationLinkId)}
                    className="rounded border border-gray-300 px-2 py-1 text-xs disabled:opacity-40"
                  >
                    {w.operations.some(
                      (op) => op.type === 'invite_delivery' && op.state === 'succeeded',
                    )
                      ? 'Reissue invite link'
                      : 'Get invite link'}
                  </button>
                  <button
                    type="button"
                    disabled={busy || w.terminalState != null}
                    onClick={() => run(() => api.cancelAshbyWorkflow(w.applicationLinkId, 'manual_stage_cancel'))}
                    className="rounded border border-red-300 px-2 py-1 text-xs text-red-700 disabled:opacity-40"
                  >
                    Cancel
                  </button>
                </div>
              </div>

              {inviteError?.linkId === w.applicationLinkId && (
                <p role="alert" className="mt-2 text-xs text-red-700">
                  {inviteError.message}
                </p>
              )}

              {invite?.linkId === w.applicationLinkId && (
                <div className="mt-2 rounded border border-emerald-200 bg-emerald-50 p-2">
                  <label
                    htmlFor={`invite-${w.applicationLinkId}`}
                    className="block text-xs font-medium text-emerald-900"
                  >
                    Candidate link — shown once, expires{' '}
                    {new Date(invite.expiresAt).toLocaleString()}
                  </label>
                  <div className="mt-1 flex items-center gap-2">
                    <input
                      id={`invite-${w.applicationLinkId}`}
                      readOnly
                      value={invite.joinUrl}
                      onFocus={(e) => e.currentTarget.select()}
                      className="w-full rounded border border-emerald-300 bg-white px-2 py-1 font-mono text-xs"
                    />
                    <button
                      type="button"
                      onClick={() => void copyInvite()}
                      className="shrink-0 rounded border border-emerald-300 px-2 py-1 text-xs text-emerald-800"
                    >
                      {copied ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  <p className="mt-1 text-xs text-emerald-800">
                    Send this to the candidate yourself. It is not stored anywhere and cannot be
                    shown again — reissue to get a new one, which revokes this link.
                  </p>
                </div>
              )}
              {w.operations.length > 0 && (
                <ul className="mt-1 flex flex-wrap gap-2">
                  {w.operations.map((op) => (
                    <li key={op.id} className="flex items-center gap-1 text-xs text-gray-500">
                      <span>
                        {op.type}:{op.state}
                        {op.errorCode ? ` (${op.errorCode})` : ''}
                      </span>
                      {op.state === 'failed' && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => run(() => api.retryAshbyOperation(op.id))}
                          className="rounded border border-gray-300 px-1 text-xs disabled:opacity-40"
                        >
                          Retry
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </main>
  );
}

export default AshbyMissionControlPage;
