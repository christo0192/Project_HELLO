/**
 * Time between steps: the median and the 90th percentile in days, over
 * completed steps only, with n. The API withholds both below `minTimingN`
 * (five), because a timing on a handful of applications can describe one
 * person; the page then says "n too small" and still prints n.
 *
 * "n too small" is said only when n is under the floor. A timing that ends in
 * Ashby while Ashby stages are not read is not known at all, and every column
 * is a dash, as the notice above the page says: its n of 0 is not a count.
 */
import { GlassPanel, SectionHeader, Table, TBody, Td, Th, THead, Tr, cx } from '../design';
import { DASH, timingView } from '../../lib/impact-format';
import type { ImpactTiming } from '../../lib/impact';
import { Dash, RowHead } from './ImpactCount';

export interface ImpactTimingsProps {
  timings: ImpactTiming[];
  minTimingN: number;
  /** Ashby stages are being read; while they are not, the Ashby-side timings are not known. */
  ashbyRead: boolean;
}

const figure = (text: string) => (text === DASH ? <Dash /> : text);

export function ImpactTimings({ timings, minTimingN, ashbyRead }: ImpactTimingsProps) {
  return (
    <GlassPanel as="section" level="ruled" padding="md" aria-labelledby="impact-timings-heading" className="mt-8">
      <SectionHeader
        id="impact-timings-heading"
        title="Time between steps"
        description={`Days, over completed steps only. A median needs at least ${minTimingN} applications.`}
      />
      <div className="mt-4 max-w-3xl">
        <Table bare flush focusWhenScrolling caption="Time between steps, in days" style={{ minWidth: '30rem' }}>
          <THead>
            <Tr>
              <Th>Between</Th>
              <Th className="text-right">Median, days</Th>
              <Th className="text-right">90th percentile, days</Th>
              <Th className="text-right">n</Th>
            </Tr>
          </THead>
          <TBody>
            {timings.map((timing) => {
              const view = timingView(timing, { minTimingN, ashbyRead });
              return (
                <Tr key={timing.key} data-timing={timing.key}>
                  <RowHead>{timing.label}</RowHead>
                  <Td className={cx('text-right tabular-nums', view.state === 'too_small' && 'text-ink-secondary')}>
                    {figure(view.median)}
                  </Td>
                  <Td className="text-right tabular-nums">{figure(view.p90)}</Td>
                  <Td className="text-right tabular-nums">{figure(view.n)}</Td>
                </Tr>
              );
            })}
          </TBody>
        </Table>
      </div>
    </GlassPanel>
  );
}
