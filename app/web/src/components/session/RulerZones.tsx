/**
 * The three zones of a verdict ruler, painted so the verdicts can be read off it at a glance:
 * Reject, then Borderline, then Select. The stored verdict's zone takes its family's mark and the
 * other two their light step, so the ruler can never say more than the word above it. That is the
 * zone the score falls in, unless a rule capped the verdict (R1's integrity floor), and the score
 * mark, which the caller draws, still stands at the raw score. With no verdict to show, no zone has
 * a hue. A word under each says which is which, so a zone is decoration.
 *
 * The mark of Borderline beside the light step of Select is under the validator's floor
 * (logsheet-tokens.test.ts), so a 2px gap keeps neighbours apart, as on the Candidates bars.
 *
 * Each zone is a `data-fill`, so a Windows contrast theme still draws it. There every fill takes one
 * colour, and the transparent edge is the gap between neighbours.
 */

import { cx } from '../design/cx';
import { FAMILY_CLASSES, type JudgementFamily } from '../design/tones';

export interface RulerZonesProps {
  /** The family of the stored verdict. Null when there is none to show. */
  current: JudgementFamily | null;
  /** Where Borderline starts, on a 0-100 scale. */
  borderline: number;
  /** Where Select starts, on a 0-100 scale. */
  select: number;
  className?: string;
}

export function RulerZones({ current, borderline, select, className }: RulerZonesProps) {
  const low = Math.min(100, Math.max(0, borderline));
  const high = Math.min(100, Math.max(low, select));
  const zones: ReadonlyArray<readonly [JudgementFamily, number]> = [
    ['closed', low],
    ['unresolved', high - low],
    ['ready', 100 - high],
  ];
  const paint = (family: JudgementFamily) => {
    if (current === null) return 'bg-rule-2';
    return family === current ? FAMILY_CLASSES[family].fill : FAMILY_CLASSES[family].lightFill;
  };
  return (
    <div className={cx('flex overflow-hidden rounded-evidence', className)}>
      {zones.map(([family, width]) => (
        <span
          key={family}
          data-ruler-zone={family}
          data-current={family === current ? '' : undefined}
          className={cx('data-fill h-full border-l-2 border-transparent bg-clip-padding first:border-l-0', paint(family))}
          style={{ width: `${width}%` }}
        />
      ))}
    </div>
  );
}
