import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import type { AshbyMcMapping, AshbyMcWorkflow } from '../types';
import { Card } from '../components/ui';

/**
 * Ashby Mission Control — admin-gated HR surface for the Ashby screening
 * workflow. Shows job-mapping health (paused/drift/completeness) and the
 * per-application workflow state (lifecycle, terminal, ingestion, operations),
 * with audited actions (pause/resume/cancel/retry). All data is sanitized by
 * the API: no candidate PII, invite tokens, presigned URLs, or transcripts.
 * The APIs are authoritative; this UI is admin-gated for UX only.
 */
export function AshbyMissionControlPage() {
  const [mappings, setMappings] = useState<AshbyMcMapping[]>([]);
  const [workflows, setWorkflows] = useState<AshbyMcWorkflow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

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
                </div>
                <button
                  type="button"
                  disabled={busy || w.terminalState != null}
                  onClick={() => run(() => api.cancelAshbyWorkflow(w.applicationLinkId, 'manual_stage_cancel'))}
                  className="rounded border border-red-300 px-2 py-1 text-xs text-red-700 disabled:opacity-40"
                >
                  Cancel
                </button>
              </div>
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
