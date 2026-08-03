/**
 * NavGroup — labelled sidebar navigation section.
 *
 * Groups related navigation under a small uppercase label (e.g.
 * "Workspace" for TA/HR daily items, "Operations" for the admin-only
 * Mission Control area). The label is hidden from the accessible tree
 * only when it duplicates surrounding context; here it is a real heading
 * so screen-reader users get section landmarks.
 */

import type { ReactNode } from 'react';

export interface NavGroupProps {
  label: string;
  children: ReactNode;
}

export function NavGroup({ label, children }: NavGroupProps) {
  return (
    <div role="group" aria-label={label} className="mt-5 first:mt-0">
      <p className="mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-wider text-ink-tertiary">
        {label}
      </p>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}
