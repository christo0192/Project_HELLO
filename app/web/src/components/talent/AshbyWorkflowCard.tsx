/**
 * AshbyWorkflowCard — a read-only Ashby screening pipeline/status card for an
 * Ashby-linked candidate.
 *
 * Where it renders: inside the NORMAL CandidateDetail Overview, and inside the
 * authenticated Ashby scoped-review Overview. Mission Control is unchanged and
 * remains the only surface with actions.
 *
 * What it is NOT:
 *   - not a control surface. There is no retry, cancel, resend, stage move, or
 *     any other button anywhere in this file — including on the error path,
 *     where a "Try again" button would be the only interactive element and
 *     would read like a workflow action.
 *   - not a second state model. Every label below maps a state the API already
 *     reports, which is in turn the raw 0029/0032 column value Mission Control
 *     reads. Unknown values fall through to their raw text with a neutral tone,
 *     never an invented label.
 *   - not a place PII, ids, or provider data can appear. The payload simply
 *     does not contain them (see `AshbyCandidateWorkflow`), and `errorCode` is
 *     re-validated here against the same sanitized-code shape before display.
 *
 * A candidate with no Ashby link renders NOTHING — not an error, not an empty
 * card. Same for an unauthorized/unknown read (404/403), which on this surface
 * can only mean the card is not applicable.
 *
 * Accessibility: the card is a labelled `section`; the async region is a
 * polite `role="status"` live region so the pipeline state is announced when it
 * arrives and when it changes; every state is conveyed by TEXT, with colour on
 * the badge as reinforcement only; the timestamp is a real `<time>` element.
 */

import { useEffect, useState } from 'react';
import { api, ApiError } from '../../api';
import type { AshbyCandidateWorkflow, AshbyCandidateWorkflowOperation } from '../../types';
import { Card } from '../ui';
import { StatusBadge, type StatusTone } from '../design';
import { formatDateTime } from '../../lib/datetime';
import { sessionStatusLabel, sessionStatusTone } from './status';

/** Which scope the card reads through. Both resolve to the same projection. */
export type AshbyWorkflowSource =
  | { kind: 'candidate'; candidateId: string }
  | { kind: 'applicationLink'; applicationLinkId: string };

/** Mirrors the 0029 CHECK on `ashby_operations.error_code`. */
const SANITIZED_CODE_RE = /^[a-z0-9_.:-]{1,64}$/;

/* ── Truthful label/tone maps (raw value is the fallback) ───────────── */
/* Module-local on purpose: these are presentation for THIS card only. A
   second surface that needs the same wording should import the card, not
   re-render the vocabulary its own way. */

function ashbyLifecycleLabel(lifecycle: string): string {
  switch (lifecycle) {
    case 'imported':
      return 'Imported from Ashby';
    case 'processing':
      return 'Processing';
    case 'ready':
      return 'Ready to screen';
    case 'completed':
      return 'Screening complete';
    case 'writeback_pending':
      return 'Writing results back to Ashby';
    case 'cancelled':
      return 'Cancelled';
    default:
      return lifecycle;
  }
}

function ashbyLifecycleTone(lifecycle: string): StatusTone {
  switch (lifecycle) {
    case 'completed':
      return 'success';
    case 'processing':
    case 'writeback_pending':
      return 'warning';
    case 'imported':
    case 'ready':
      return 'info';
    case 'cancelled':
      return 'danger';
    default:
      return 'neutral';
  }
}

function ashbyTerminalStateLabel(terminalState: string): string {
  switch (terminalState) {
    case 'withdrawn':
      return 'Application withdrawn';
    case 'deleted':
      return 'Application deleted in Ashby';
    case 'manual_stage_cancel':
      return 'Cancelled by an administrator';
    default:
      return terminalState;
  }
}

function ashbyIngestionLabel(state: string): string {
  switch (state) {
    case 'queued':
      return 'Queued';
    case 'fetching':
      return 'Fetching resume';
    case 'scanning':
      return 'Scanning resume';
    case 'extracting':
      return 'Extracting text';
    case 'structuring':
      return 'Structuring profile';
    case 'ready':
      return 'Ready';
    case 'failed_review':
      return 'Needs manual review';
    case 'cancelled':
      return 'Cancelled';
    default:
      return state;
  }
}

function ashbyIngestionTone(state: string): StatusTone {
  switch (state) {
    case 'ready':
      return 'success';
    case 'failed_review':
    case 'cancelled':
      return 'danger';
    case 'queued':
      return 'info';
    case 'fetching':
    case 'scanning':
    case 'extracting':
    case 'structuring':
      return 'warning';
    default:
      return 'neutral';
  }
}

function ashbyOperationLabel(type: AshbyCandidateWorkflowOperation['type']): string {
  switch (type) {
    case 'invite_delivery':
      return 'Screening invite';
    case 'scorecard_write':
      return 'Ashby scorecard';
    default:
      return type;
  }
}

function ashbyOperationStateLabel(state: string): string {
  switch (state) {
    case 'pending':
      return 'Pending';
    case 'running':
      return 'In progress';
    case 'succeeded':
      return 'Succeeded';
    case 'failed':
      return 'Failed';
    case 'blocked':
      return 'Blocked';
    case 'cancelled':
      return 'Cancelled';
    default:
      return state;
  }
}

function ashbyOperationStateTone(state: string): StatusTone {
  switch (state) {
    case 'succeeded':
      return 'success';
    case 'failed':
      return 'danger';
    case 'running':
    case 'blocked':
      return 'warning';
    case 'pending':
      return 'info';
    case 'cancelled':
      return 'neutral';
    default:
      return 'neutral';
  }
}

/* ── Presentational card ────────────────────────────────────────────── */

const HEADING_ID = 'ashby-workflow-heading';

export interface AshbyWorkflowCardViewProps {
  workflow: AshbyCandidateWorkflow;
}

/** The rendered card for a known workflow. Pure — no fetching, no actions. */
export function AshbyWorkflowCardView({ workflow }: AshbyWorkflowCardViewProps) {
  const errorCodeOf = (op: AshbyCandidateWorkflowOperation): string | null =>
    op.errorCode && SANITIZED_CODE_RE.test(op.errorCode) ? op.errorCode : null;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={HEADING_ID} className="text-sm font-semibold text-ink">
          Ashby screening pipeline
        </h2>
        <StatusBadge tone={ashbyLifecycleTone(workflow.lifecycle)}>
          {ashbyLifecycleLabel(workflow.lifecycle)}
        </StatusBadge>
      </div>

      {workflow.terminalState && (
        <p className="mt-2 text-sm text-error">
          {ashbyTerminalStateLabel(workflow.terminalState)}
        </p>
      )}

      <dl className="mt-3 space-y-2 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <dt className="text-ink-secondary">Resume ingestion</dt>
          <dd>
            {workflow.ingestionState ? (
              <StatusBadge tone={ashbyIngestionTone(workflow.ingestionState)}>
                {ashbyIngestionLabel(workflow.ingestionState)}
              </StatusBadge>
            ) : (
              <span className="text-ink-tertiary">Not started</span>
            )}
          </dd>
        </div>

        {workflow.operations.map((op) => {
          const code = errorCodeOf(op);
          return (
            <div key={op.type} className="flex flex-wrap items-start justify-between gap-2">
              <dt className="text-ink-secondary">{ashbyOperationLabel(op.type)}</dt>
              <dd className="text-right">
                <StatusBadge tone={ashbyOperationStateTone(op.state)}>
                  {ashbyOperationStateLabel(op.state)}
                </StatusBadge>
                {code && (
                  <p className="mt-1 text-xs text-ink-tertiary">
                    Error code: <code className="break-all">{code}</code>
                  </p>
                )}
              </dd>
            </div>
          );
        })}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <dt className="text-ink-secondary">Screening session</dt>
          <dd>
            {workflow.sessionStatus ? (
              <StatusBadge tone={sessionStatusTone(workflow.sessionStatus)}>
                {sessionStatusLabel(workflow.sessionStatus)}
              </StatusBadge>
            ) : (
              <span className="text-ink-tertiary">Not started</span>
            )}
          </dd>
        </div>
      </dl>

      {workflow.updatedAt && (
        // Only rendered when there is a real timestamp: `<time datetime="">`
        // is invalid HTML and would announce as an empty machine-readable date.
        <p className="mt-3 text-xs text-ink-tertiary">
          Updated{' '}
          <time dateTime={workflow.updatedAt}>{formatDateTime(workflow.updatedAt)}</time>
        </p>
      )}
      <p className="mt-1 text-xs text-ink-tertiary">
        Read-only status. Screening actions live in Ashby Mission Control.
      </p>
    </>
  );
}

/* ── Fetching container ─────────────────────────────────────────────── */

export interface AshbyWorkflowCardProps {
  source: AshbyWorkflowSource;
}

type LoadState =
  | { phase: 'loading' }
  | { phase: 'absent' }
  | { phase: 'ready'; workflow: AshbyCandidateWorkflow }
  | { phase: 'error'; message: string };

const ERROR_MESSAGE = 'Ashby screening status is unavailable right now.';

export function AshbyWorkflowCard({ source }: AshbyWorkflowCardProps) {
  const key = source.kind === 'candidate' ? source.candidateId : source.applicationLinkId;
  const [state, setState] = useState<LoadState>({ phase: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ phase: 'loading' });
    // Started inside a promise so that even a SYNCHRONOUS throw from the API
    // layer degrades to this card's own sanitized error state. A status card
    // must never be able to take down the Overview it is embedded in.
    Promise.resolve()
      .then(() =>
        source.kind === 'candidate'
          ? api.getCandidateAshbyWorkflow(source.candidateId)
          : api.getAshbyScopedReviewWorkflow(source.applicationLinkId),
      )
      .then((r) => {
        if (cancelled) return;
        setState(r.workflow ? { phase: 'ready', workflow: r.workflow } : { phase: 'absent' });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // 404/403 on this surface means "not applicable", never an incident to
        // report next to the candidate's profile — and reporting it would also
        // be the only way to tell a missing candidate from an unowned one.
        // Anything else — including a non-ApiError thrown by the API layer —
        // is reported as the same sanitized, detail-free message.
        const status = e instanceof ApiError ? e.status : undefined;
        setState(
          status === 404 || status === 403
            ? { phase: 'absent' }
            : { phase: 'error', message: ERROR_MESSAGE },
        );
      });
    return () => {
      cancelled = true;
    };
    // `key` re-runs the effect when the scoped identifier changes; `source.kind`
    // is fixed per call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, source.kind]);

  // A non-Ashby candidate contributes nothing to the Overview at all.
  if (state.phase === 'absent') return null;

  return (
    <Card className="p-5">
      <section aria-labelledby={HEADING_ID} aria-busy={state.phase === 'loading'}>
        {/* ONE live region, mounted for every phase and never replaced. A
            region inserted at the moment its content arrives is announced
            inconsistently across screen readers; swapping the children of a
            region that already exists is what actually gets announced. */}
        <div role="status" aria-live="polite">
          {state.phase === 'ready' ? (
            <AshbyWorkflowCardView workflow={state.workflow} />
          ) : (
            <>
              <h2 id={HEADING_ID} className="text-sm font-semibold text-ink">
                Ashby screening pipeline
              </h2>
              <p className="mt-2 text-sm text-ink-tertiary">
                {state.phase === 'loading' ? 'Loading Ashby screening status…' : state.message}
              </p>
            </>
          )}
        </div>
      </section>
    </Card>
  );
}
