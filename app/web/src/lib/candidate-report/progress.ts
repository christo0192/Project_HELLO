import type { ReportProgress } from './types';

/** The words under the Export report button while a report is being prepared. */
export function progressWords(progress: ReportProgress | null): string {
  if (progress && progress.phase === 'recordings' && progress.total > 0) {
    return `Preparing report… ${progress.done}/${progress.total} recordings`;
  }
  if (progress && progress.phase === 'building') return 'Building report…';
  return 'Preparing report…';
}
