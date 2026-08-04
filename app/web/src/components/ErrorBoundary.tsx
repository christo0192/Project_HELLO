import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
  resetKey?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  resetKey?: string;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError(): Partial<ErrorBoundaryState> {
    return { hasError: true };
  }

  static getDerivedStateFromProps(
    props: ErrorBoundaryProps,
    state: ErrorBoundaryState,
  ): Partial<ErrorBoundaryState> | null {
    if (props.resetKey !== state.resetKey) {
      return { hasError: false, resetKey: props.resetKey };
    }
    return null;
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // Intentionally no console logging: production errors are surfaced through
    // the visible fallback without risking sensitive details in the DOM/logs.
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div
        role="alert"
        className="rounded-xl border border-error/30 bg-error-soft p-8 text-center shadow-card"
      >
        <p className="text-sm font-semibold text-error">
          Something went wrong loading this page.
        </p>
        <p className="mx-auto mt-2 max-w-md text-xs text-ink-tertiary">
          Refresh the page to load the latest dashboard bundle. If this keeps
          happening, contact an admin operator.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-4 inline-flex items-center rounded-lg border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink transition-colors hover:bg-surface-tertiary"
        >
          Try again
        </button>
      </div>
    );
  }
}
