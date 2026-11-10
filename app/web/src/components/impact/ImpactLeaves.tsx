/**
 * Where candidates leave: per stage, how many were archived there, the archive
 * reason type (rejected by us, withdrew, other, no reason recorded: Ashby lets
 * an application be archived with none), and Ashby's own top reasons.
 *
 * The reason text is Ashby's reason catalogue, never a recruiter's free text
 * (the contract), so it is safe to print to every role that sees the page.
 */
import { GlassPanel, SectionHeader, Table, TBody, Td, Th, THead, Tr } from '../design';
import { DASH, REASON_TYPE_LABEL, REASON_TYPE_ORDER, formatCount, milestoneLabel, reasonTypeRows } from '../../lib/impact-format';
import type { ImpactLeave } from '../../lib/impact';
import { CountButton, Dash, RowHead, type OpenImpactList } from './ImpactCount';

export interface ImpactLeavesProps {
  leaves: ImpactLeave[];
  /** False while Ashby stages are not being read: an archive is not known, not absent. */
  ashbyRead: boolean;
  onOpen: OpenImpactList;
}

export function ImpactLeaves({ leaves, ashbyRead, onOpen }: ImpactLeavesProps) {
  return (
    <GlassPanel as="section" level="ruled" padding="md" aria-labelledby="impact-leaves-heading" className="mt-8">
      <SectionHeader
        id="impact-leaves-heading"
        title="Where candidates leave"
        description="Applications archived at each stage, by the reason type Ashby recorded, with Ashby’s most used reasons."
      />
      {leaves.length === 0 ? (
        <p className="mt-4 text-sm text-ink-secondary">
          {ashbyRead
            ? 'No application was archived in these weeks.'
            : 'Not known yet: Ashby stages are not being read, so archives cannot be counted.'}
        </p>
      ) : (
        <div className="mt-4">
          <Table bare flush focusWhenScrolling caption="Archived applications by stage and reason type" style={{ minWidth: '56rem' }}>
            <THead>
              <Tr>
                <Th>Stage</Th>
                <Th className="text-right">Archived here</Th>
                {REASON_TYPE_ORDER.map((type) => (
                  <Th key={type} className="text-right">
                    {REASON_TYPE_LABEL[type]}
                  </Th>
                ))}
                <Th>Top reasons</Th>
              </Tr>
            </THead>
            <TBody>
              {leaves.map((leave) => {
                const milestone = milestoneLabel(leave.milestone);
                const showMilestone = milestone && milestone.toLowerCase() !== leave.stageTitle.trim().toLowerCase();
                return (
                  <Tr key={leave.stageId} data-stage={leave.stageId}>
                    <RowHead>
                      <span className="block">{leave.stageTitle}</span>
                      {showMilestone && <span className="block text-meta text-ink-tertiary">{milestone}</span>}
                    </RowHead>
                    <Td className="text-right">
                      <CountButton
                        count={leave.archived}
                        name={`archived at ${leave.stageTitle}`}
                        request={{ target: { kind: 'leave', stageId: leave.stageId }, title: `Archived at ${leave.stageTitle}` }}
                        onOpen={onOpen}
                      />
                    </Td>
                    {reasonTypeRows(leave.byReasonType, leave.archived).map((reason) => (
                      <Td key={reason.type} className="py-2 text-right tabular-nums">
                        <span className="block">{reason.count === DASH ? <Dash /> : reason.count}</span>
                        {reason.share !== DASH && <span className="block text-meta text-ink-tertiary">{reason.share}</span>}
                      </Td>
                    ))}
                    <Td className="py-2">
                      {leave.topReasons.length === 0 ? (
                        <span className="text-label text-ink-tertiary">None recorded</span>
                      ) : (
                        <ul className="min-w-[12rem] space-y-0.5 text-label">
                          {leave.topReasons.slice(0, 5).map((reason) => (
                            <li key={reason.text} className="flex justify-between gap-3">
                              <span className="text-ink">{reason.text}</span>
                              <span className="tabular-nums text-ink-secondary">{formatCount(reason.count)}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </Td>
                  </Tr>
                );
              })}
            </TBody>
          </Table>
        </div>
      )}
    </GlassPanel>
  );
}
