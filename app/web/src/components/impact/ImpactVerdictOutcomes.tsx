/**
 * Christy's verdict against what happened next: one row per verdict, one
 * column per outcome in Ashby, each cell a count with its share of the row.
 *
 * The verdict is a word with its family's colour and shape (`ImpactVerdictWord`).
 * The counts stay ink: a plain total says nothing good or bad, and a table
 * painted cell by cell would say less, not more.
 */
import { GlassPanel, SectionHeader, Table, TBody, Td, Th, THead, Tr } from '../design';
import { formatCount, shareOf } from '../../lib/impact-format';
import type { ImpactVerdictOutcomes as Outcomes } from '../../lib/impact';
import { CountButton, RowHead, Share, type OpenImpactList } from './ImpactCount';
import { ImpactVerdictWord } from './ImpactVerdict';

export interface ImpactVerdictOutcomesProps {
  outcomes: Outcomes;
  onOpen: OpenImpactList;
}

export function ImpactVerdictOutcomes({ outcomes, onOpen }: ImpactVerdictOutcomesProps) {
  const { columns, rows } = outcomes;
  return (
    <GlassPanel as="section" level="ruled" padding="md" aria-labelledby="impact-verdicts-heading" className="mt-8">
      <SectionHeader
        id="impact-verdicts-heading"
        title="Christy’s verdict against what happened next"
        description="How often each verdict went on in Ashby. Each cell is a count and its share of the row."
      />
      <div className="mt-4">
        <Table bare flush focusWhenScrolling caption="Christy’s verdict against what happened next, as counts and shares of each row" style={{ minWidth: '60rem' }}>
          <THead>
            <Tr>
              <Th>Christy’s verdict</Th>
              <Th className="text-right">Applications</Th>
              {columns.map((column) => (
                <Th key={column.key} className="text-right">
                  {column.label}
                </Th>
              ))}
            </Tr>
          </THead>
          <TBody>
            {rows.map((row) => (
              <Tr key={row.verdict} data-verdict={row.verdict}>
                <RowHead>
                  <ImpactVerdictWord verdict={row.verdict} label={row.label} />
                </RowHead>
                <Td className="text-right font-medium tabular-nums">{formatCount(row.total)}</Td>
                {columns.map((column) => {
                  const count = row.cells[column.key];
                  const isKnown = typeof count === 'number' && Number.isFinite(count);
                  return (
                    <Td key={column.key} className="py-1.5 text-right">
                      <CountButton
                        count={count}
                        name={`${row.label}, ${column.label}`}
                        request={{
                          target: { kind: 'verdict', verdict: row.verdict, outcome: column.key },
                          title: `${row.label} · ${column.label}`,
                        }}
                        onOpen={onOpen}
                      />
                      {isKnown && (
                        <span className="block text-meta text-ink-tertiary">
                          <Share share={shareOf(count, row.total)} />
                        </span>
                      )}
                    </Td>
                  );
                })}
              </Tr>
            ))}
          </TBody>
        </Table>
      </div>
    </GlassPanel>
  );
}
