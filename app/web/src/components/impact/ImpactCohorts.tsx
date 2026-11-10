/**
 * Weekly cohorts (IST weeks) and the same columns by job: the share of each
 * group of applications that reached each step.
 *
 * A young week has not had time to reach the later steps, so it is marked
 * "Still maturing" with the dashed pencil edge the design keeps for what is not
 * firm. It is never to be read against older weeks as if it were finished.
 */
import { GlassPanel, SectionHeader, Table, TBody, Td, Th, THead, Tr, cx } from '../design';
import { addIstDays } from '../../lib/ist-datetime';
import { cohortWeekLabel, formatCount } from '../../lib/impact-format';
import { IMPACT_SHARE_KEYS, type ImpactCohort, type ImpactJobRow, type ImpactShareKey } from '../../lib/impact';
import { CountButton, RowHead, Share, type OpenImpactList } from './ImpactCount';

const SHARE_LABEL: Readonly<Record<ImpactShareKey, string>> = {
  connected: 'Connected',
  scored: 'Scored',
  moved_forward: 'Moved forward',
  r1: 'R1 or later',
  r2: 'R2 or later',
  offer: 'Offer or later',
  hired: 'Hired',
};

function ShareHeads() {
  return (
    <>
      {IMPACT_SHARE_KEYS.map((key) => (
        <Th key={key} className="text-right">
          {SHARE_LABEL[key]}
        </Th>
      ))}
    </>
  );
}

function ShareCells({ shares }: { shares: ImpactCohort['shares'] }) {
  return (
    <>
      {IMPACT_SHARE_KEYS.map((key) => (
        <Td key={key} className="text-right text-ink-secondary">
          <Share share={shares[key]} />
        </Td>
      ))}
    </>
  );
}

/** "Still maturing": not firm, so a dashed edge, in the needs-a-second-look family. */
export function MaturingMark({ className }: { className?: string }) {
  return (
    <span
      className={cx(
        'inline-flex items-center whitespace-nowrap rounded-chip border border-dashed border-unresolved px-1.5 text-meta text-unresolved-text',
        className,
      )}
    >
      Still maturing
    </span>
  );
}

export interface ImpactCohortsProps {
  cohorts: ImpactCohort[];
  byJob: ImpactJobRow[];
  /** The job the page is filtered to, which a cohort's list keeps. */
  job: string | null;
  onOpen: OpenImpactList;
}

export function ImpactCohorts({ cohorts, byJob, job, onOpen }: ImpactCohortsProps) {
  const weeks = [...cohorts].sort((a, b) => b.weekStart.localeCompare(a.weekStart));
  return (
    <>
      <GlassPanel as="section" level="ruled" padding="md" aria-labelledby="impact-cohorts-heading" className="mt-8">
        <SectionHeader
          id="impact-cohorts-heading"
          title="Weekly cohorts"
          description="Applications by the IST week they entered the Christy stage, newest first, and the share of each week that reached each step."
        />
        {weeks.length === 0 ? (
          <p className="mt-4 text-sm text-ink-secondary">No week in this range has an application.</p>
        ) : (
          <div className="mt-4">
            <Table bare flush focusWhenScrolling caption="Weekly cohorts: the share of each IST week that reached each step" style={{ minWidth: '60rem' }}>
              <THead>
                <Tr>
                  <Th>Week starting (IST)</Th>
                  <Th className="text-right">Age</Th>
                  <Th className="text-right">Came in</Th>
                  <ShareHeads />
                </Tr>
              </THead>
              <TBody>
                {weeks.map((cohort) => {
                  const label = cohortWeekLabel(cohort.weekStart);
                  return (
                    <Tr key={cohort.weekStart} data-week={cohort.weekStart}>
                      <RowHead>
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          <span className="whitespace-nowrap">{label}</span>
                          {cohort.maturing && <MaturingMark />}
                        </span>
                      </RowHead>
                      <Td className="whitespace-nowrap text-right tabular-nums text-ink-secondary">
                        {formatCount(cohort.ageDays)} {cohort.ageDays === 1 ? 'day' : 'days'}
                      </Td>
                      <Td className="text-right">
                        <CountButton
                          count={cohort.cameIn}
                          name={`came in, week of ${label}`}
                          request={{
                            target: { kind: 'step', step: 'came_in' },
                            title: `Came in · Week of ${label}`,
                            // Monday to Sunday; the page cuts the running week off at today.
                            scope: { from: cohort.weekStart, to: addIstDays(cohort.weekStart, 6), job },
                          }}
                          onOpen={onOpen}
                        />
                      </Td>
                      <ShareCells shares={cohort.shares} />
                    </Tr>
                  );
                })}
              </TBody>
            </Table>
          </div>
        )}
      </GlassPanel>

      <GlassPanel as="section" level="ruled" padding="md" aria-labelledby="impact-jobs-heading" className="mt-8">
        <SectionHeader
          id="impact-jobs-heading"
          title="By job"
          description="The same shares for each mapped Ashby job, over the weeks chosen above."
        />
        {byJob.length === 0 ? (
          <p className="mt-4 text-sm text-ink-secondary">No job has an application in these weeks.</p>
        ) : (
          <div className="mt-4">
            <Table bare flush focusWhenScrolling caption="By job: the share of each job's applications that reached each step" style={{ minWidth: '56rem' }}>
              <THead>
                <Tr>
                  <Th>Job</Th>
                  <Th className="text-right">Came in</Th>
                  <ShareHeads />
                </Tr>
              </THead>
              <TBody>
                {byJob.map((row) => (
                  <Tr key={row.jobId} data-job={row.jobId}>
                    <RowHead>{row.label}</RowHead>
                    <Td className="text-right">
                      <CountButton
                        count={row.cameIn}
                        name={`came in, ${row.label}`}
                        request={{
                          target: { kind: 'step', step: 'came_in' },
                          title: `Came in · ${row.label}`,
                          scope: { job: row.jobId },
                        }}
                        onOpen={onOpen}
                      />
                    </Td>
                    <ShareCells shares={row.shares} />
                  </Tr>
                ))}
              </TBody>
            </Table>
          </div>
        )}
      </GlassPanel>
    </>
  );
}
