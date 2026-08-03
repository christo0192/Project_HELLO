/**
 * Themed loading / empty / error states for data-driven chart views.
 * Uses the semantic token system (index.css) so states re-theme in dark mode.
 */

export interface ChartErrorProps {
  message: string;
  onRetry?: () => void;
}

export function ChartError({ message, onRetry }: ChartErrorProps) {
  return (
    <div
      role="alert"
      className="flex h-full min-h-40 flex-col items-center justify-center gap-3 rounded-xl border border-error/30 bg-error-soft px-4 text-center"
    >
      <p className="max-w-md text-sm text-error">{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center rounded-lg border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink transition-colors hover:bg-surface-tertiary"
        >
          Try again
        </button>
      )}
    </div>
  );
}

export interface ChartEmptyProps {
  title: string;
  hint?: string;
}

export function ChartEmpty({ title, hint }: ChartEmptyProps) {
  return (
    <div className="flex h-full min-h-40 flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-line-strong bg-surface-secondary px-4 text-center">
      <p className="text-sm font-medium text-ink-secondary">{title}</p>
      {hint && <p className="max-w-sm text-xs text-ink-tertiary">{hint}</p>}
    </div>
  );
}
