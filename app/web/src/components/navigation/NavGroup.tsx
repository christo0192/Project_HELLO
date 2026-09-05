/**
 * NavGroup — labelled sidebar navigation section.
 *
 * Groups related navigation under a small label (e.g. "Workspace" for
 * TA/HR daily items, "Operations" for the admin-only Mission Control area).
 * Sentence case, quiet weight — the label is a real heading for the group
 * so screen-reader users get section landmarks.
 */

import type { ReactNode } from 'react';

export interface NavGroupProps {
  label: string;
  children: ReactNode;
}

export function NavGroup({ label, children }: NavGroupProps) {
  return (
    <div role="group" aria-label={label} className="mt-6 first:mt-0">
      <p className="mb-1.5 px-3 text-xs font-medium text-ink-tertiary">{label}</p>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}
