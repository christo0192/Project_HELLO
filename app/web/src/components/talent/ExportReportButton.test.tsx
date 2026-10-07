import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CandidateDetail } from '../../types';
import type { GeneratedReport } from '../../lib/candidate-report/generateCandidateReport';
import type { CollectReportInput } from '../../lib/candidate-report/collectReportData';

const audit = vi.hoisted(() => vi.fn());
const generate = vi.hoisted(() => vi.fn());
const download = vi.hoisted(() => vi.fn());

vi.mock('../../api', () => ({
  api: { exportReportAudit: (...args: unknown[]) => audit(...args) },
  ApiError: class extends Error {
    status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
    }
  },
}));
vi.mock('../../lib/candidate-report/generateCandidateReport', () => ({
  generateCandidateReport: (...args: unknown[]) => generate(...args),
  downloadHtmlFile: (...args: unknown[]) => download(...args),
}));

import { ExportReportButton } from './ExportReportButton';
import { progressWords } from '../../lib/candidate-report/progress';

const detail = {
  candidate: { id: 'cand-1', name: 'Jane' },
  sessions: [],
  assessments: [],
} as unknown as CandidateDetail;

function report(overrides: Partial<GeneratedReport> = {}): GeneratedReport {
  return {
    html: '<!doctype html>',
    filename: 'screening-report-jane-2026-10-07.html',
    recordings: 2,
    transcript: true,
    bytes: 10,
    omissions: [],
    ...overrides,
  };
}

function renderButton() {
  return render(<ExportReportButton detail={detail} roleTitle="Role" role="admin" />);
}

describe('ExportReportButton', () => {
  beforeEach(() => {
    audit.mockReset().mockResolvedValue(undefined);
    generate.mockReset();
    download.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it('is a secondary "Export report" button and the old CSV label is gone', () => {
    generate.mockResolvedValue(report());
    renderButton();
    expect(screen.getByRole('button', { name: 'Export report' })).toBeEnabled();
    expect(screen.queryByText('Export CSV')).not.toBeInTheDocument();
  });

  it('shows progress, disables the button while running, then downloads and audits', async () => {
    let finish!: (r: GeneratedReport) => void;
    generate.mockImplementation((input: CollectReportInput) => {
      input.onProgress?.({ phase: 'recordings', done: 2, total: 4 });
      return new Promise<GeneratedReport>((resolve) => {
        finish = resolve;
      });
    });
    renderButton();
    fireEvent.click(screen.getByRole('button', { name: 'Export report' }));

    const running = await screen.findByRole('button', { name: 'Export report' });
    expect(running).toBeDisabled();
    expect(running).toHaveAttribute('aria-busy', 'true');
    expect(await screen.findByText('Preparing report… 2/4 recordings')).toBeInTheDocument();
    expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent('Preparing report… 2/4 recordings');

    // A second click while running starts nothing new.
    fireEvent.click(running);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(download).not.toHaveBeenCalled();

    await act(async () => finish(report()));
    await waitFor(() => expect(download).toHaveBeenCalledWith('<!doctype html>', 'screening-report-jane-2026-10-07.html'));
    expect(audit).toHaveBeenCalledWith('cand-1', { format: 'html', recordings: 2, transcript: true });
    expect(await screen.findByText('Report downloaded with recordings.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export report' })).toBeEnabled();
  });

  it('passes the signed-in role and an abort signal to the generator', async () => {
    generate.mockResolvedValue(report());
    renderButton();
    fireEvent.click(screen.getByRole('button', { name: 'Export report' }));
    await waitFor(() => expect(generate).toHaveBeenCalled());
    const input = generate.mock.calls[0][0] as CollectReportInput;
    expect(input.role).toBe('admin');
    expect(input.roleTitle).toBe('Role');
    expect(input.signal).toBeInstanceOf(AbortSignal);
  });

  it('a failing audit never blocks or undoes the download', async () => {
    generate.mockResolvedValue(report({ omissions: ['A recording could not be included.'] }));
    audit.mockRejectedValue(new Error('audit down'));
    renderButton();
    fireEvent.click(screen.getByRole('button', { name: 'Export report' }));
    await waitFor(() => expect(download).toHaveBeenCalled());
    expect(await screen.findByText(/Report downloaded\. Some items are marked as not included/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('reports a failure in an alert, downloads nothing, and can be retried', async () => {
    generate.mockRejectedValueOnce(new Error('boom'));
    renderButton();
    fireEvent.click(screen.getByRole('button', { name: 'Export report' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not build the report. Try again.');
    expect(download).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Export report' })).toBeEnabled();

    generate.mockResolvedValueOnce(report({ recordings: 0 }));
    fireEvent.click(screen.getByRole('button', { name: 'Export report' }));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('cancels the work when the page is left', async () => {
    let signal: AbortSignal | undefined;
    generate.mockImplementation((input: CollectReportInput) => {
      signal = input.signal;
      return new Promise<GeneratedReport>(() => {});
    });
    const { unmount } = renderButton();
    fireEvent.click(screen.getByRole('button', { name: 'Export report' }));
    await waitFor(() => expect(signal).toBeDefined());
    unmount();
    expect(signal?.aborted).toBe(true);
  });
});

describe('progressWords', () => {
  it('names the phase', () => {
    expect(progressWords(null)).toBe('Preparing report…');
    expect(progressWords({ phase: 'details', done: 0, total: 0 })).toBe('Preparing report…');
    expect(progressWords({ phase: 'recordings', done: 0, total: 3 })).toBe('Preparing report… 0/3 recordings');
    expect(progressWords({ phase: 'building', done: 3, total: 3 })).toBe('Building report…');
  });
});
