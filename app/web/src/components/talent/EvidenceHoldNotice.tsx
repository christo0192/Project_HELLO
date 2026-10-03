/**
 * EvidenceHoldNotice — C3 (migration 0114).
 *
 * A phone screening whose INTERVIEW coverage was too thin to decide on (the
 * call was cut off on our side, the candidate answered nothing, or fewer than
 * three in four planned questions were answered) still gets its scorecard,
 * but the server holds it: it is not written to Ashby and it does not move the
 * candidate's status. This notice says so above the scorecard, in plain words,
 * and offers the recruiter the one sensible next step — a re-screen — when the
 * host can perform it. Nothing here re-dials on its own: the action is the
 * existing HR re-screen request, and only when the host passes it.
 *
 * Candidate-scoped source: semantic tokens only (see
 * talent/__tests__/candidate-scope-palette.test.ts).
 */

import type { ReactNode } from 'react';
import type { Assessment } from '../../types';
import { evidenceHoldReason, isEvidenceInsufficient } from '../../lib/evidence-hold';

export interface EvidenceHoldNoticeProps {
  assessment: unknown;
  /** The re-screen action, when the host can request one. */
  action?: ReactNode;
}

export function EvidenceHoldNotice({ assessment, action }: EvidenceHoldNoticeProps) {
  if (!isEvidenceInsufficient(assessment)) return null;
  const row = assessment as Assessment;
  return (
    <div
      role="note"
      aria-label="Not enough interview evidence"
      data-evidence-hold=""
      className="mb-4 rounded-[14px] border border-glass-ring px-3.5 py-3 text-sm"
    >
      <p className="font-medium text-warning-text">Not enough interview evidence to decide</p>
      <p className="mt-1 max-w-prose leading-6 text-ink-secondary">
        {evidenceHoldReason(row)} This scorecard is held for review: it was not sent to Ashby and did
        not change the candidate&apos;s status. A re-screen is recommended.
      </p>
      {action ? <div className="mt-2.5">{action}</div> : null}
    </div>
  );
}
