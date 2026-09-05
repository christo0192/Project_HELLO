import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api';
import type { AshbyMcMapping, AshbyMcWorkflow, AshbyFeedbackForm } from '../types';
import {
  Button,
  buttonClass,
  EmptyPanel,
  GlassPanel,
  InlineNotice,
  LoadingPanel,
  PageHeader,
  RevealGroup,
  RevealItem,
  ScrollArea,
  SectionHeader,
  StatusBadge,
  TextField,
} from '../components/design';
import type { StatusTone } from '../components/design';

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
 *
 * FEEDBACK-FORM DISCOVERY: `Discover feedback form` calls an admin-only
 * READ-ONLY endpoint that performs one provider read of the job's interview
 * plan and returns form SCHEMA — opaque ids, labels, input types, and scale
 * options. It never returns a submitted answer, score, or comment, and it
 * changes nothing: the result is unverified reference material an admin copies
 * by hand into the approved configuration process. The ids are held in
 * component state only and are never logged or sent to analytics.
 */

/** Row separator inside a glass panel — a hairline, never a card border. */
const ROW = 'border-b border-glass-ring py-3 last:border-0';
/** Small neutral pill for ingestion / operation state. */
/**
 * Operator-facing form of a backend enum: underscores become spaces and the
 * first letter is capitalised. The raw value is kept in a `title` so the
 * exact vocabulary the API used stays one hover away.
 */
function humanize(value: string): string {
  const spaced = value.replace(/_/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const PILL =
  'inline-flex items-center whitespace-nowrap rounded-full bg-ink/[0.05] px-2 py-0.5 text-xs text-ink-secondary';
/** Above this many rows the workflow list scrolls instead of running down the page. */
const WORKFLOW_SCROLL_AFTER = 6;

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
  /**
   * Discovered feedback-form schema for ONE mapping, held in component state
   * only. Never persisted, never logged, never sent to analytics — these are
   * tenant configuration ids, and this view is read-only reference material.
   */
  const [formSchema, setFormSchema] = useState<
    { jobId: string; forms: AshbyFeedbackForm[]; truncated: boolean } | null
  >(null);
  const [formError, setFormError] = useState<{ jobId: string; message: string } | null>(null);

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

  /**
   * Read the feedback-form schema for one job. Read-only end to end: the API
   * performs a single provider READ and writes nothing, and this handler binds
   * nothing — it only renders what came back.
   */
  const discoverForm = useCallback(async (externalJobId: string) => {
    setBusy(true);
    setFormError(null);
    setFormSchema(null);
    try {
      const res = await api.discoverAshbyFeedbackForm(externalJobId);
      if (res.ok) {
        setFormSchema({ jobId: externalJobId, forms: res.forms ?? [], truncated: res.truncated === true });
      } else {
        setFormError({ jobId: externalJobId, message: res.error ?? 'Could not read the feedback form' });
      }
    } catch (e) {
      setFormError({
        jobId: externalJobId,
        message: e instanceof ApiError ? e.message : 'Could not read the feedback form',
      });
    } finally {
      setBusy(false);
    }
  }, []);

  const mappingTone = (status: string): StatusTone =>
    status === 'enabled' ? 'success' : status === 'drift' ? 'danger' : 'warning';

  const workflowRows = (
    <ul>
      {workflows.map((w) => (
        <li key={w.applicationLinkId} className={ROW}>
          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="font-mono text-[13px] text-ink">{w.externalApplicationId}</span>
              <StatusBadge
                tone={
                  w.terminalState != null
                    ? 'danger'
                    : w.lifecycle === 'writeback_pending'
                      ? 'info'
                      : 'neutral'
                }
              >
                <span title={w.lifecycle}>{humanize(w.lifecycle)}</span>
              </StatusBadge>
              {w.terminalState && (
                <StatusBadge tone="danger">
                  <span title={w.terminalState}>{humanize(w.terminalState)}</span>
                </StatusBadge>
              )}
              {w.ingestionState && (
                <span className={PILL} title={w.ingestionState}>
                  Ingest · {humanize(w.ingestionState)}
                </span>
              )}
              {/* A completed screening whose link never reached
                  `writeback_pending` is a completion park that did not
                  land. The observer is best-effort by design (it must
                  never discard a scored assessment), so this is where that
                  case becomes visible instead of living only in a log. */}
              {w.sessionStatus === 'completed'
                && w.terminalState == null
                && w.lifecycle !== 'writeback_pending' && (
                <StatusBadge tone="warning">screened: not parked</StatusBadge>
              )}
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {w.sessionId && w.sessionStatus === 'completed' && (
                <a
                  href={`/sessions/${encodeURIComponent(w.sessionId)}`}
                  className={buttonClass('secondary', 'sm')}
                >
                  Review screening
                </a>
              )}
              <Button
                size="sm"
                disabled={busy || w.terminalState != null}
                onClick={() => void deliverInvite(w.applicationLinkId)}
              >
                {w.operations.some(
                  (op) => op.type === 'invite_delivery' && op.state === 'succeeded',
                )
                  ? 'Reissue invite link'
                  : 'Get invite link'}
              </Button>
              <Button
                variant="danger"
                size="sm"
                disabled={busy || w.terminalState != null}
                onClick={() => run(() => api.cancelAshbyWorkflow(w.applicationLinkId, 'manual_stage_cancel'))}
              >
                Cancel
              </Button>
            </div>
          </div>

          {inviteError?.linkId === w.applicationLinkId && (
            <InlineNotice tone="danger" role="alert" className="mt-3">
              {inviteError.message}
            </InlineNotice>
          )}

          {invite?.linkId === w.applicationLinkId && (
            <div className="glass-sunken mt-3 p-3">
              {/*
                The one-time candidate link. It lives in component state only —
                it is not stored, not logged, and the token sits in the URL
                fragment so it never reaches a server or an access log.
              */}
              <label
                htmlFor={`invite-${w.applicationLinkId}`}
                className="block text-[13px] font-medium text-ink-secondary"
              >
                Candidate link — shown once, expires{' '}
                {new Date(invite.expiresAt).toLocaleString()}
              </label>
              <div className="mt-2 flex items-center gap-2">
                <TextField
                  id={`invite-${w.applicationLinkId}`}
                  size="sm"
                  readOnly
                  value={invite.joinUrl}
                  onFocus={(e) => e.currentTarget.select()}
                  className="font-mono"
                />
                <Button size="sm" className="shrink-0" onClick={() => void copyInvite()}>
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
              <p className="mt-2 text-[13px] leading-5 text-ink-tertiary">
                Send this to the candidate yourself. It is not stored anywhere and cannot be
                shown again — reissue to get a new one, which revokes this link.
              </p>
            </div>
          )}
          {w.operations.length > 0 && (
            <ul className="mt-2 flex flex-wrap items-center gap-2">
              {w.operations.map((op) => (
                <li key={op.id} className="flex items-center gap-1.5">
                  <span className={PILL} title={`${op.type}:${op.state}`}>
                    {humanize(op.type)} · {humanize(op.state)}
                    {op.errorCode ? ` (${op.errorCode})` : ''}
                  </span>
                  {op.state === 'failed' && (
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => run(() => api.retryAshbyOperation(op.id))}
                    >
                      Retry
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );

  return (
    <div>
      <PageHeader
        eyebrow="Operations"
        title="Ashby Mission Control"
        description="Screening-workflow health and controls. Data is sanitized — no candidate PII or tokens."
        actions={
          <Link to="/mission-control" className={buttonClass('secondary', 'sm')}>
            Mission Control
          </Link>
        }
      />

      {!loaded && <LoadingPanel />}
      {error && (
        <InlineNotice tone="danger" role="alert" className="mt-6">
          {error}
        </InlineNotice>
      )}

      <RevealGroup className="mt-6 flex flex-col gap-6">
        <RevealItem>
          <GlassPanel>
            <SectionHeader
              level={2}
              title="Job mappings"
              meta={
                loaded ? (
                  <span className="text-[13px] text-ink-tertiary">{mappings.length}</span>
                ) : undefined
              }
            />
            {loaded && mappings.length === 0 ? (
              <EmptyPanel compact className="mt-4" title="No mappings." />
            ) : (
              <ul className="mt-2">
                {mappings.map((m) => (
                  <li key={m.id} className={ROW}>
                    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="font-mono text-[13px] text-ink">{m.externalJobId}</span>
                        {m.label && <span className="text-sm text-ink-secondary">{m.label}</span>}
                        <StatusBadge tone={mappingTone(m.status)}>{m.status}</StatusBadge>
                        {!(m.hasAiStage && m.hasTaStage) && <StatusBadge>incomplete</StatusBadge>}
                        {m.statusReason && (
                          <span className="text-[13px] text-ink-tertiary">{m.statusReason}</span>
                        )}
                      </div>
                      <div className="flex shrink-0 flex-wrap items-center gap-2">
                        <Button
                          size="sm"
                          disabled={busy || m.status === 'paused'}
                          onClick={() => run(() => api.pauseAshbyMapping(m.id))}
                        >
                          Pause
                        </Button>
                        <Button
                          size="sm"
                          disabled={busy || m.status === 'enabled' || !(m.hasAiStage && m.hasTaStage)}
                          onClick={() => run(() => api.resumeAshbyMapping(m.id))}
                        >
                          Resume
                        </Button>
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() => void discoverForm(m.externalJobId)}
                        >
                          Discover feedback form
                        </Button>
                      </div>
                    </div>

                    {formError?.jobId === m.externalJobId && (
                      <InlineNotice tone="danger" role="alert" className="mt-3">
                        {formError.message}
                      </InlineNotice>
                    )}

                    {formSchema?.jobId === m.externalJobId && (
                      <FeedbackFormSchema forms={formSchema.forms} truncated={formSchema.truncated} />
                    )}
                  </li>
                ))}
              </ul>
            )}
          </GlassPanel>
        </RevealItem>

        <RevealItem>
          <GlassPanel>
            <SectionHeader
              level={2}
              title="Application workflows"
              meta={
                loaded ? (
                  <span className="text-[13px] text-ink-tertiary">{workflows.length}</span>
                ) : undefined
              }
            />
            {loaded && workflows.length === 0 ? (
              <EmptyPanel compact className="mt-4" title="No workflows." />
            ) : workflows.length > WORKFLOW_SCROLL_AFTER ? (
              <ScrollArea maxHeight="36rem" label="Application workflows" className="mt-1">
                {workflowRows}
              </ScrollArea>
            ) : (
              <div className="mt-2">{workflowRows}</div>
            )}
          </GlassPanel>
        </RevealItem>
      </RevealGroup>
    </div>
  );
}

/**
 * Read-only rendering of discovered feedback-form SCHEMA.
 *
 * Every value here is form STRUCTURE that the API already sanitized — opaque
 * ids, bounded labels, input types, and scale options. There is no submitted
 * answer, score, comment, or candidate field in this data, and nothing is
 * persisted: an admin copies the ids by hand into the approved configuration
 * process. It is labelled unverified because a form the plan merely NAMES may
 * carry fields this read cannot see.
 */
function FeedbackFormSchema({ forms, truncated }: { forms: AshbyFeedbackForm[]; truncated: boolean }) {
  return (
    <div className="glass-sunken mt-3 p-4">
      <SectionHeader
        level={3}
        title="Feedback form schema — read-only, unverified"
        description="Structure only — no feedback content, scores, or comments are read. Nothing is saved or bound to write-back; copy the ids by hand into the approved configuration process."
      />
      {truncated && (
        <InlineNotice tone="warning" className="mt-3">
          Result was truncated by a safety bound — this view is partial.
        </InlineNotice>
      )}
      {forms.length === 0 ? (
        <p className="mt-3 text-[13px] text-ink-secondary">
          No feedback form is named in this job&apos;s interview plan.
        </p>
      ) : (
        <ul className="mt-3">
          {forms.map((f) => (
            <li
              key={f.formDefinitionId}
              className="border-t border-glass-ring pt-3 first:border-0 first:pt-0 [&+li]:mt-3"
            >
              <p className="text-sm font-medium text-ink">{f.title ?? 'Untitled form'}</p>
              <p className="font-mono text-[13px] text-ink-secondary">form id: {f.formDefinitionId}</p>
              {(f.stageTitle || f.stageId) && (
                <p className="text-[13px] text-ink-tertiary">
                  stage: {f.stageTitle ?? 'untitled'}
                  {f.stageId ? ` (${f.stageId})` : ''}
                </p>
              )}
              {(f.interviewTitle || f.interviewId) && (
                <p className="text-[13px] text-ink-tertiary">
                  interview: {f.interviewTitle ?? 'untitled'}
                  {f.interviewId ? ` (${f.interviewId})` : ''}
                </p>
              )}
              {!f.schemaAvailable ? (
                <p className="mt-2 text-[13px] leading-5 text-warning-text">
                  Field-level schema is not available from the interview plan for this form — only
                  its id could be read. This is not a claim that the form has no fields.
                </p>
              ) : (
                <>
                  <p className="mt-2 text-[13px] text-ink-tertiary">{f.fieldCount} field(s)</p>
                  {f.sections.map((sec, si) => (
                    <div key={sec.id ?? `section-${si}`} className="mt-2">
                      <p className="text-[13px] font-medium text-ink-secondary">
                        {sec.title ?? 'Untitled section'}
                      </p>
                      <ul className="mt-1 space-y-1">
                        {sec.fields.map((field) => (
                          <li key={field.id} className="text-[13px] leading-5 text-ink-secondary">
                            <span className="font-mono">{field.id}</span>
                            {' — '}
                            {field.title ?? 'untitled'}
                            {field.path ? ` [${field.path}]` : ''}
                            {field.type ? ` · ${field.type}` : ''}
                            {field.required === null
                              ? ' · required: unknown'
                              : field.required
                                ? ' · required'
                                : ' · optional'}
                            {field.options.length > 0 && (
                              <span className="text-ink-tertiary">
                                {' · scale: '}
                                {field.options
                                  .map((o) => (o.label ?? o.value ?? '').trim())
                                  .filter((t) => t.length > 0)
                                  .join(' | ')}
                                {field.optionsTruncated ? ' …' : ''}
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default AshbyMissionControlPage;
