/**
 * CandidateShell — the one structural boundary of the candidate experience.
 *
 * Applying `.candidate-scope` here (and only here) is what makes the
 * HR-approved palette both *apply* and *contain*: every `--c-*` token is
 * declared on this element, so descendants resolve them and nothing
 * outside this subtree can. Mission Control, Login, Session Detail and the
 * live-call surfaces are unreachable by construction, not by convention.
 *
 * The palette is fixed and light-only, so the shell renders identically
 * under the app's `.dark` root class — `.dark .candidate-scope` repeats
 * the same values (src/styles/candidate-palette.css).
 *
 * The shell also carries the shared page rhythm so the three candidate
 * surfaces read as one system rather than three pages that agree.
 */

import type { ElementType, ReactNode } from 'react';
import { cx } from '../design/cx';

export const CANDIDATE_SCOPE_CLASS = 'candidate-scope';

export interface CandidateShellProps {
  children: ReactNode;
  /** `main` for the standalone scoped shell, `div` inside the app Layout. */
  as?: ElementType;
  /**
   * `standalone` owns its own page rhythm (the Ashby-scoped route renders
   * outside `<Layout>`). `inset` cancels and re-applies `Layout`'s content
   * padding so the candidate ground reaches the column edges instead of
   * floating inside it — no padding is doubled and Layout is not touched.
   */
  variant?: 'standalone' | 'inset';
  /** Page width. `wide` for list/detail, `narrow` for single-message states. */
  width?: 'wide' | 'narrow';
  className?: string;
}

const RHYTHM: Record<'standalone' | 'inset', string> = {
  standalone: 'mx-auto w-full px-4 py-6 sm:px-6 sm:py-8',
  inset: '-mx-4 -my-6 px-4 py-6 sm:-mx-6 sm:-my-8 sm:px-6 sm:py-8',
};

export function CandidateShell({
  children,
  as,
  variant = 'standalone',
  width = 'wide',
  className,
}: CandidateShellProps) {
  const Component = (as ?? 'div') as ElementType;
  return (
    <Component
      data-candidate-shell={variant}
      className={cx(
        CANDIDATE_SCOPE_CLASS,
        'min-h-full bg-[var(--c-bg)] text-[var(--c-ink)]',
        RHYTHM[variant],
        variant === 'standalone' && (width === 'wide' ? 'max-w-6xl' : 'max-w-3xl'),
        className,
      )}
    >
      {children}
    </Component>
  );
}

export interface CandidateHeaderProps {
  /** Small uppercase label above the title. */
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  /** Rule under the header — used by the standalone scoped shell. */
  divided?: boolean;
}

/**
 * Candidate page header. Additive rather than a change to the shared
 * `design/PageHeader`, which eight out-of-scope pages render and which
 * paints its eyebrow with the IK brand scale.
 */
export function CandidateHeader({
  eyebrow,
  title,
  description,
  actions,
  divided = false,
}: CandidateHeaderProps) {
  return (
    <div
      className={cx(
        'flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4',
        divided && 'border-b border-[var(--c-border)] pb-5',
      )}
    >
      <div className="min-w-0">
        {eyebrow && (
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--c-accent)]">
            {eyebrow}
          </p>
        )}
        <h1 className="mt-1 truncate text-xl font-semibold tracking-tight text-[var(--c-ink)] sm:text-2xl">
          {title}
        </h1>
        {description && (
          <p className="mt-1 max-w-prose truncate text-sm text-[var(--c-ink-secondary)]">
            {description}
          </p>
        )}
      </div>
      {actions && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
      )}
    </div>
  );
}
