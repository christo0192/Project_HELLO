/**
 * Christy's verdict on the Business impact page, in words.
 *
 * Select, Borderline and Reject are `VerdictMark`: the circle (full, half,
 * empty) and the word in the verdict's family, Select `ready`, Borderline
 * `unresolved`, Reject `closed`, so colour is never the only signal and a
 * Reject is never red. Held (thin evidence) and No verdict have no hue: a held
 * card has none anywhere else either, and no verdict is nothing to colour.
 *
 * This file is on the design gate's verdict list
 * (scripts/validate-hr-design-system.mjs `VERDICT_FILES`): it may print a
 * verdict's family and no other colour.
 */
import { VerdictMark } from '../session/VerdictMark';
import { cx } from '../design/cx';
import type { ImpactVerdictKey } from '../../lib/impact';

/** The stored recommendation each contract verdict is. */
const RECOMMENDATION: Readonly<Record<ImpactVerdictKey, 'advance' | 'hold' | 'reject' | null>> = {
  select: 'advance',
  borderline: 'hold',
  reject: 'reject',
  held: null,
  none: null,
};

const PLAIN_LABEL: Readonly<Record<ImpactVerdictKey, string>> = {
  select: 'Select',
  borderline: 'Borderline',
  reject: 'Reject',
  held: 'Held (thin evidence)',
  none: 'No verdict',
};

export interface ImpactVerdictWordProps {
  verdict: ImpactVerdictKey | null | undefined;
  /** The row's own label from the response; the contract's words otherwise. */
  label?: string;
  /** Printed after the word; never a 0 for a score that is missing. */
  score?: number | null;
  size?: 'md' | 'lg';
  className?: string;
}

export function ImpactVerdictWord({ verdict, label, score, size = 'md', className }: ImpactVerdictWordProps) {
  const key: ImpactVerdictKey = verdict && Object.hasOwn(RECOMMENDATION, verdict) ? verdict : 'none';
  const recommendation = RECOMMENDATION[key];
  if (recommendation) {
    return <VerdictMark recommendation={recommendation} score={score ?? undefined} size={size} className={className} />;
  }
  return (
    <span
      data-recommendation={key}
      className={cx(
        'inline-flex items-center gap-1.5 whitespace-nowrap font-medium text-ink',
        size === 'lg' ? 'text-sm' : 'text-label',
        className,
      )}
    >
      <span>{label ?? PLAIN_LABEL[key]}</span>
      {typeof score === 'number' && Number.isFinite(score) && (
        <span className="ml-1 font-normal tabular-nums text-ink-secondary">{Math.round(score)}</span>
      )}
    </span>
  );
}

/** "Provisional": not firm, so a dashed pencil edge, and the needs-a-second-look family. */
export function ProvisionalMark({ className }: { className?: string }) {
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-chip border border-dashed border-unresolved px-1.5 text-meta text-unresolved-text',
        className,
      )}
    >
      Provisional
    </span>
  );
}
