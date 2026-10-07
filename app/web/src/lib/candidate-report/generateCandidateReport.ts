import {
  buildReportHtml,
  reportIncludesTranscript,
  reportRecordingCount,
} from './buildReportHtml';
import { collectReportData } from './collectReportData';
import type { CollectReportInput } from './collectReportData';
import { reportFilename } from './escape';

export interface GeneratedReport {
  html: string;
  filename: string;
  /** Recordings embedded (what the audit row records). */
  recordings: number;
  /** Whether any transcript made it into the file. */
  transcript: boolean;
  /** Plain-language notes about anything left out. */
  omissions: string[];
}

/** Collect, build and name the report. No download here: the caller owns that. */
export async function generateCandidateReport(input: CollectReportInput): Promise<GeneratedReport> {
  const data = await collectReportData(input);
  const html = buildReportHtml(data);
  return {
    html,
    filename: reportFilename(data.candidate.name, data.candidate.id, data.generatedAt),
    recordings: reportRecordingCount(data),
    transcript: reportIncludesTranscript(data),
    omissions: data.omissions,
  };
}

/** Hand `html` to the browser as a file download. */
export function downloadHtmlFile(html: string, filename: string): void {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked a moment later: some browsers cancel a large download whose blob URL vanishes at once.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
