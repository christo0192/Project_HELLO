/**
 * Mission Control — Funnel (observability, 0090 / PR2).
 *
 * Data: GET /api/admin/funnel/summary (stored rollup → totals + step
 * conversions + per-day series) and GET /api/admin/funnel/failures (the
 * unified failure taxonomy). Counts, sanitized codes and opaque ids only —
 * the views/rollup carry no PII by construction, so none is rendered.
 *
 * The rollup is refreshed by a background loop (off by default) OR on demand:
 * "Recompute" calls POST /api/admin/funnel/refresh, so an operator can
 * populate/refresh the funnel without waiting for the loop.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../api';
import type { FunnelSummaryResponse, FunnelFailuresResponse } from '../../types';
import {
  Button,
  EmptyPanel,
  ErrorPanel,
  LoadingPanel,
  SectionHeader,
  StatusBadge,
  TBody,
  THead,
  Table,
  Td,
  Th,
  Tr,
} from '../design';
import { formatDateTime } from './statusMeta';

function pct(r: number | null): string {
  return r == null ? '—' : `${(r * 100).toFixed(0)}%`;
}

function convTone(r: number | null): 'success' | 'neutral' | 'danger' {
  if (r == null) return 'neutral';
  if (r >= 0.6) return 'success';
  if (r >= 0.3) return 'neutral';
  return 'danger';
}

export function FunnelSection() {
  const [summary, setSummary] = useState<FunnelSummaryResponse | null>(null);
  const [failures, setFailures] = useState<FunnelFailuresResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [recomputing, setRecomputing] = useState(false);
  const [recomputeError, setRecomputeError] = useState<string | null>(null);

  const loadGen = useRef(0);
  const load = useCallback(() => {
    const gen = ++loadGen.current;
    setLoadError(null);
    setSummary(null);
    setFailures(null);
    Promise.all([api.getFunnelSummary(), api.listFunnelFailures()])
      .then(([s, f]) => {
        if (gen !== loadGen.current) return;
        setSummary(s);
        setFailures(f);
      })
      .catch((e: ApiError) => {
        if (gen === loadGen.current) setLoadError(e.message);
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const recompute = useCallback(() => {
    setRecomputing(true);
    setRecomputeError(null);
    api
      .refreshFunnel(30)
      .then(() => load())
      .catch((e: ApiError) => setRecomputeError(e.message))
      .finally(() => setRecomputing(false));
  }, [load]);

  if (loadError && !summary) {
    return <ErrorPanel message={loadError} onRetry={load} />;
  }
  if (!summary || !failures) {
    return <LoadingPanel label="Loading funnel…" />;
  }

  const t = summary.totals;
  const c = summary.conversions;
  const stages: Array<{ label: string; value: number; conv: number | null }> = [
    { label: 'Entered parser', value: t.entered_parse, conv: null },
    { label: 'Parsed OK', value: t.parsed_ok, conv: t.entered_parse > 0 ? t.parsed_ok / t.entered_parse : null },
    { label: 'Dialed', value: t.dialed, conv: c.parse_to_dial },
    { label: 'Connected', value: t.connected, conv: c.dial_to_connect },
    { label: 'Consent passed', value: t.consent_passed, conv: c.connect_to_consent },
    { label: 'Answered ≥1', value: t.answered_ge1, conv: c.consent_to_answered },
    { label: 'Scored', value: t.scored, conv: c.answered_to_scored },
    { label: 'Qualified', value: t.qualified, conv: c.scored_to_qualified },
    { label: 'Reached reference check', value: t.reached_reference_check, conv: c.qualified_to_reference_check },
  ];

  const dropBuckets: Array<{ label: string; value: number }> = [
    { label: 'Needs manual review', value: t.needs_review },
    { label: 'Parse failed', value: t.parse_failed },
    { label: 'Dropped at consent', value: t.consent_dropped },
    { label: 'Disqualified', value: t.disqualified },
    { label: 'On hold', value: t.on_hold },
    { label: 'Human review', value: t.human_review },
  ];

  const totalMinutes = Math.round(t.total_call_seconds / 60);
  const avgMinsPerConnect = t.connects_total > 0 ? (t.total_call_seconds / t.connects_total / 60).toFixed(1) : '—';
  const isEmpty = t.entered_parse === 0 && summary.series.length === 0;

  return (
    <div className="space-y-5">
      <SectionHeader
        level={2}
        title="Funnel"
        description={`Candidate funnel from resume parse to reference check, ${summary.range.from} → ${summary.range.to}. Derived from operational data; counts only, no PII.`}
        actions={
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" onClick={load}>
              Refresh
            </Button>
            <Button size="sm" variant="primary" onClick={recompute} disabled={recomputing}>
              {recomputing ? 'Recomputing…' : 'Recompute'}
            </Button>
          </div>
        }
      />

      {recomputeError ? (
        <p className="px-1 text-xs text-danger" role="alert">
          Recompute failed: {recomputeError}
        </p>
      ) : null}

      {isEmpty ? (
        <EmptyPanel
          title="No funnel data yet"
          hint="The rollup has not been computed for this window. Click Recompute to populate it (or enable the background refresh loop)."
        />
      ) : (
        <>
          {/* Stat strip */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { k: 'Total call minutes', v: String(totalMinutes) },
              { k: 'Avg mins / connect', v: String(avgMinsPerConnect) },
              { k: 'Attempts', v: String(t.attempts_total) },
              { k: 'Connects', v: String(t.connects_total) },
            ].map((s) => (
              <div key={s.k} className="rounded-control bg-surface-tertiary px-3 py-2">
                <p className="text-xs text-ink-tertiary">{s.k}</p>
                <p className="tabular-nums text-lg font-semibold text-ink">{s.v}</p>
              </div>
            ))}
          </div>

          <Table caption="Funnel stages with step-to-step conversion" maxHeight="30rem">
            <THead>
              <Tr>
                <Th>Stage</Th>
                <Th>Count</Th>
                <Th>Step conversion</Th>
              </Tr>
            </THead>
            <TBody>
              {stages.map((s) => (
                <Tr key={s.label}>
                  <Td className="text-ink">{s.label}</Td>
                  <Td className="tabular-nums text-ink">{s.value}</Td>
                  <Td>
                    {s.conv == null ? (
                      <span className="text-ink-tertiary">—</span>
                    ) : (
                      <StatusBadge tone={convTone(s.conv)}>{pct(s.conv)}</StatusBadge>
                    )}
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>

          {/* Disqualification / drop buckets */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {dropBuckets.map((b) => (
              <div key={b.label} className="rounded-control bg-surface-tertiary px-3 py-2">
                <p className="text-xs text-ink-tertiary">{b.label}</p>
                <p className="tabular-nums text-base font-semibold text-ink">{b.value}</p>
              </div>
            ))}
          </div>

          {/* Failure taxonomy */}
          <SectionHeader
            level={3}
            title="Failures by stage"
            description={`Pipeline failures grouped by stage and sanitized code (${failures.range.from} → ${failures.range.to}).`}
          />
          {failures.truncated ? (
            <p className="px-1 text-xs text-ink-secondary" role="status">
              Showing the most recent {failures.recent.length}+ failures in the window — counts are a lower bound. Narrow the date range for exact totals.
            </p>
          ) : null}
          {failures.groups.length === 0 ? (
            <EmptyPanel title="No failures recorded" hint="Nothing has failed in the fetched window." />
          ) : (
            <Table caption="Failure taxonomy — stage, code, count" maxHeight="24rem">
              <THead>
                <Tr>
                  <Th>Stage</Th>
                  <Th>Code</Th>
                  <Th>Count</Th>
                </Tr>
              </THead>
              <TBody>
                {failures.groups.map((g) => (
                  <Tr key={`${g.stage}:${g.code}`}>
                    <Td className="text-ink">{g.stage}</Td>
                    <Td>
                      <span className="inline-block rounded-md bg-surface-tertiary px-1.5 py-0.5 font-mono text-xs text-ink">
                        {g.code}
                      </span>
                    </Td>
                    <Td className="tabular-nums text-ink">{g.count}</Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          )}

          <p className="px-1 pt-1 text-xs text-ink-tertiary" role="status">
            Rollup last refreshed: {summary.refreshed_at ? formatDateTime(summary.refreshed_at) : 'never'} · {summary.series.length} day(s) in window.
          </p>
        </>
      )}
    </div>
  );
}
