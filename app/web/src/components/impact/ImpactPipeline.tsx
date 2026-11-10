/**
 * The pipeline: a strip of the headline counts, then the ruled table of every
 * step with its shares and where applications stopped.
 *
 * Steps nest (each counts only applications that reached the step before), so
 * no share is over 100%. The API sends the shares; a share that would say more
 * than its whole, or a step that counts more than the one before it, is a bug,
 * and prints a dash rather than a figure someone might believe.
 */
import { GlassPanel, MetricStrip, SectionHeader, Table, TBody, Td, Th, THead, Tr, countTone } from '../design';
import type { FigureTone, MetricItem } from '../design';
import { formatCount, formatShare } from '../../lib/impact-format';
import type { ImpactPipelineStep, ImpactStepKey } from '../../lib/impact';
import { CountButton, Dash, NotApplicable, RowHead, Share, type OpenImpactList } from './ImpactCount';
import { doesNotApply, nestedShares } from './rules';

/** The strip: shorter words than the table's, for the glance. Hired is a good result. */
const STRIP: ReadonlyArray<{ step: ImpactStepKey; label: string; tone?: FigureTone }> = [
  { step: 'came_in', label: 'Came in' },
  { step: 'connected', label: 'Christy connected' },
  { step: 'scored', label: 'Scored' },
  { step: 'moved_forward', label: 'Moved forward' },
  { step: 'r1', label: 'R1 or later' },
  { step: 'r2', label: 'R2 or later' },
  { step: 'offer', label: 'Offer or later' },
  { step: 'hired', label: 'Hired', tone: 'success' },
];

const known = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export interface ImpactPipelineProps {
  pipeline: ImpactPipelineStep[];
  onOpen: OpenImpactList;
}

export function ImpactPipeline({ pipeline, onOpen }: ImpactPipelineProps) {
  const shares = nestedShares(pipeline);
  const byStep = new Map(pipeline.map((row, index) => [row.step, { row, share: shares[index] }]));

  const strip: MetricItem[] = STRIP.map(({ step, label, tone }) => {
    const entry = byStep.get(step);
    const reached = entry?.row.reached;
    const share = formatShare(entry?.share.ofCameIn);
    const opens = known(reached) && reached > 0 && entry;
    return {
      key: step,
      label,
      value: known(reached) ? formatCount(reached) : '—',
      figureTone: countTone(known(reached) ? reached : null, tone),
      context: step === 'came_in' ? 'Entered the Christy stage' : known(reached) && share !== '—' ? `${share} of came in` : undefined,
      onActivate: opens
        ? (button) => onOpen({ target: { kind: 'step', step }, title: `Reached: ${entry.row.label}`, count: reached }, button)
        : undefined,
      ariaLabel: opens ? `${label}: ${formatCount(reached)}. Show these applications` : undefined,
    };
  });

  return (
    <GlassPanel as="section" level="ruled" padding="md" aria-labelledby="impact-pipeline-heading" className="mt-6">
      <SectionHeader
        id="impact-pipeline-heading"
        title="The pipeline"
        description="Each step counts only the applications that reached the step before it, so no share is over 100%."
      />
      <MetricStrip label="Headline counts" hideLabel columns={STRIP.length} size="compact" bleed items={strip} className="mt-4" />
      <div className="mt-5">
        <Table bare flush focusWhenScrolling caption="The pipeline, step by step" style={{ minWidth: '46rem' }}>
          <THead>
            <Tr>
              <Th>Step</Th>
              <Th className="text-right">Reached</Th>
              <Th className="text-right">Of previous</Th>
              <Th className="text-right">Of came in</Th>
              <Th className="text-right">Still here</Th>
              <Th className="text-right">Dropped here</Th>
            </Tr>
          </THead>
          <TBody>
            {pipeline.map((row, index) => (
              <Tr key={row.step} data-step={row.step}>
                <RowHead>
                  <span className="block">{row.label}</span>
                  {row.sub && (
                    <span className="block text-meta text-ink-tertiary">
                      {row.sub.label} <span className="tabular-nums">{known(row.sub.reached) ? formatCount(row.sub.reached) : <Dash />}</span>
                    </span>
                  )}
                </RowHead>
                <Td className="text-right">
                  <CountButton
                    count={row.reached}
                    name={`reached ${row.label}`}
                    request={{ target: { kind: 'step', step: row.step }, title: `Reached: ${row.label}` }}
                    onOpen={onOpen}
                  />
                </Td>
                <Td className="text-right text-ink-secondary">
                  {doesNotApply('ofPrevious', row.step, row.ofPrevious) ? <NotApplicable /> : <Share share={shares[index]?.ofPrevious} />}
                </Td>
                <Td className="text-right text-ink-secondary">
                  <Share share={shares[index]?.ofCameIn} />
                </Td>
                <Td className="text-right tabular-nums">
                  {known(row.stillHere) ? formatCount(row.stillHere) : doesNotApply('stillHere', row.step, row.stillHere) ? <NotApplicable /> : <Dash />}
                </Td>
                <Td className="text-right">
                  {doesNotApply('droppedHere', row.step, row.droppedHere) ? (
                    <NotApplicable />
                  ) : (
                    <CountButton
                      count={row.droppedHere}
                      name={`dropped at ${row.label}`}
                      request={{ target: { kind: 'step', step: row.step, dropped: true }, title: `Dropped at: ${row.label}` }}
                      onOpen={onOpen}
                    />
                  )}
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      </div>
    </GlassPanel>
  );
}
