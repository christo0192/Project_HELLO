/**
 * ExportReportButton: the candidate header's secondary action.
 *
 * Builds ONE self-contained HTML file in the browser (profile, role fit,
 * scorecards, transcripts, call list, and the call recordings embedded so they
 * play offline) and downloads it, for sharing with selection stakeholders.
 * "Print, Save as PDF" from that file also works; a PDF cannot play audio, so
 * HTML is the primary format.
 *
 * It is the secondary beside the header's one primary action. While it runs
 * the button is disabled and a polite live region says how far along it is
 * ("Preparing report… 2/4 recordings"); the result (downloaded, or why not) is
 * announced the same way. Failures never leave a half file: nothing downloads
 * unless the whole report was built.
 */

import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../api';
import { CandidateButton } from '../design/candidate';
import { plannedRecordingCount } from '../../lib/candidate-report/collectReportData';
import { downloadHtmlFile, generateCandidateReport } from '../../lib/candidate-report/generateCandidateReport';
import type { CandidateDetail, MembershipRole } from '../../types';
import { progressWords } from '../../lib/candidate-report/progress';
import type { ReportProgress } from '../../lib/candidate-report/types';

interface ExportReportButtonProps {
  detail: CandidateDetail;
  roleTitle: string | null;
  role: MembershipRole | null;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'running'; progress: ReportProgress | null }
  | { kind: 'done'; notes: number; recordings: number }
  | { kind: 'error'; message: string };

export function ExportReportButton({ detail, roleTitle, role }: ExportReportButtonProps) {
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const abortRef = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  // Viewers cannot export (the audit route is interviewer and above, like the old CSV).
  const canExport = role !== 'viewer';

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Leaving the page stops further recording requests.
      abortRef.current?.abort();
    };
  }, []);

  async function run() {
    if (status.kind === 'running') return;
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus({ kind: 'running', progress: null });
    try {
      // The audit is a precondition: no record, no file. It states what the
      // report is planned to contain (an upper bound for recordings, R1
      // role-play sessions excluded); the file is only built once the server
      // has accepted it.
      await api.exportReportAudit(detail.candidate.id, {
        format: 'html',
        planned_recordings: plannedRecordingCount(detail.sessions),
        transcript: detail.sessions.some((s) => s.interview_round_id == null && s.status === 'completed'),
      });
      const report = await generateCandidateReport({
        detail,
        roleTitle,
        role,
        api,
        signal: controller.signal,
        onProgress: (progress) => {
          if (mounted.current) setStatus({ kind: 'running', progress });
        },
      });
      downloadHtmlFile(report.html, report.filename);
      if (mounted.current) {
        setStatus({ kind: 'done', notes: report.omissions.length, recordings: report.recordings });
      }
    } catch (error) {
      if (!mounted.current || (error instanceof Error && error.name === 'AbortError')) return;
      setStatus({
        kind: 'error',
        message: error instanceof ApiError ? error.message : 'Could not build the report. Try again.',
      });
    }
  }

  if (!canExport) return null;

  const running = status.kind === 'running';
  let live = '';
  if (status.kind === 'running') live = progressWords(status.progress);
  else if (status.kind === 'done') {
    live =
      status.notes > 0
        ? 'Report downloaded. Some items are marked as not included.'
        : status.recordings > 0
          ? 'Report downloaded with recordings.'
          : 'Report downloaded.';
  }

  return (
    <div className="flex flex-col items-start">
      <CandidateButton
        variant="secondary"
        onClick={() => void run()}
        loading={running}
        title="Download a shareable report with the profile, scorecards, transcripts and playable recordings"
      >
        Export report
      </CandidateButton>
      {/* Always mounted so assistive tech announces changes to it. */}
      <p aria-live="polite" aria-atomic="true" className="mt-1 max-w-xs text-xs text-[var(--c-ink-secondary)] empty:mt-0">
        {live}
      </p>
      {status.kind === 'error' && (
        <p role="alert" className="mt-1 max-w-xs text-xs text-error-text">
          {status.message}
        </p>
      )}
    </div>
  );
}
