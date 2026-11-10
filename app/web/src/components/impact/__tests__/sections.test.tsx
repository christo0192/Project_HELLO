/**
 * The Business impact sections on their own: the rules each one prints by
 * (M031 S6). The page suite covers how they are wired together.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import {
  ImpactDefinitions,
  ImpactPipeline,
  ImpactTimings,
  ImpactVerdictWord,
  MaturingMark,
  ProvisionalMark,
  applicationStatusClass,
  impactDefinitions,
  nestedShares,
} from '..';
import { ImpactLeaves } from '../ImpactLeaves';
import { CountButton } from '../ImpactCount';
import { impactSummary } from './impactFixture';

describe('the pipeline', () => {
  it('takes out a share that cannot be true: a step bigger than the one before, or than came in', () => {
    const pipeline = impactSummary().pipeline.slice(0, 4);
    // A scored figure bigger than connected: the "Scored 136%" bug.
    pipeline[3] = { ...pipeline[3]!, reached: 326, ofPrevious: 1.36, ofCameIn: 0.786 };
    pipeline[2] = { ...pipeline[2]!, reached: 240 };
    const shares = nestedShares(pipeline);
    expect(shares[3]).toEqual({ ofPrevious: null, ofCameIn: 0.786 });
    expect(shares[0]).toEqual({ ofPrevious: null, ofCameIn: 1 });
    const overCameIn = nestedShares([{ ...pipeline[0]! }, { ...pipeline[1]!, reached: 500, ofCameIn: 1.2 }]);
    expect(overCameIn[1]).toEqual({ ofPrevious: null, ofCameIn: null });
  });

  it('prints such a share as a dash in the table, read out as not available', () => {
    const pipeline = impactSummary().pipeline.slice(0, 4);
    pipeline[3] = { ...pipeline[3]!, reached: 326, ofPrevious: 1.36, ofCameIn: 0.786 };
    render(<ImpactPipeline pipeline={pipeline} onOpen={vi.fn()} />);
    const scored = screen.getAllByRole('row').find((row) => row.getAttribute('data-step') === 'scored')!;
    expect(scored).not.toHaveTextContent('136%');
    expect(within(scored).getByText('Not available')).toBeInTheDocument();
  });

  it('prints Hired in the good-result family, and every other headline figure in ink', () => {
    render(<ImpactPipeline pipeline={impactSummary().pipeline} onOpen={vi.fn()} />);
    const strip = screen.getByRole('group', { name: 'Headline counts' });
    expect(within(strip).getByText('6')).toHaveClass('text-success-text');
    expect(within(strip).getByText('415')).toHaveClass('text-ink');
  });

  it('hands the pressed number and what is behind it to the page', async () => {
    const onOpen = vi.fn();
    render(<ImpactPipeline pipeline={impactSummary().pipeline} onOpen={onOpen} />);
    const button = screen.getByRole('button', { name: '12, dropped at R1 or later. Show these applications' });
    await userEvent.click(button);
    expect(onOpen).toHaveBeenCalledWith(
      { target: { kind: 'step', step: 'r1', dropped: true }, title: 'Dropped at: R1 or later', count: 12 },
      button,
    );
  });
});

describe('a row header', () => {
  it('drops its rule in the last row, as every other cell there does', () => {
    render(<ImpactPipeline pipeline={impactSummary().pipeline} onOpen={vi.fn()} />);
    const header = screen.getAllByRole('rowheader').at(-1)!;
    expect(header).toHaveClass('[tr:last-child>&]:border-b-0');
  });
});

describe('a count', () => {
  it('is a dash for a figure that is not known, a plain 0 for nobody, and a button otherwise', () => {
    const request = { target: { kind: 'step', step: 'hired' } as const, title: 'Reached: Hired' };
    const { rerender } = render(<CountButton count={null} name="hired" request={request} onOpen={vi.fn()} />);
    expect(screen.getByText('Not available')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    rerender(<CountButton count={0} name="hired" request={request} onOpen={vi.fn()} />);
    expect(screen.getByText('0')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    rerender(<CountButton count={1234} name="hired" request={request} onOpen={vi.fn()} />);
    expect(screen.getByRole('button', { name: /^1,234, hired\. Show these applications$/ })).toHaveClass('textlink');
  });
});

describe('a verdict', () => {
  it.each([
    ['select', 'Select', 'advance', 'text-ready-text'],
    ['borderline', 'Borderline', 'hold', 'text-unresolved-text'],
    ['reject', 'Reject', 'reject', 'text-closed-text'],
  ] as const)('prints %s as its word, its circle and its family', (verdict, word, stored, family) => {
    render(<ImpactVerdictWord verdict={verdict} score={64} />);
    const mark = screen.getByText(word).closest('[data-recommendation]')!;
    expect(mark).toHaveAttribute('data-recommendation', stored);
    expect(mark).toHaveClass(family);
    expect(mark.querySelector('svg[data-verdict-mark]')).not.toBeNull();
    expect(mark).toHaveTextContent('64');
  });

  it('never prints a Reject in crimson', () => {
    render(<ImpactVerdictWord verdict="reject" />);
    expect(screen.getByText('Reject').closest('[data-recommendation]')!.className).not.toMatch(/error|danger/);
  });

  it.each([
    ['held', 'Held (thin evidence)'],
    ['none', 'No verdict'],
    [null, 'No verdict'],
  ] as const)('prints %s in ink, with no circle', (verdict, word) => {
    render(<ImpactVerdictWord verdict={verdict} score={52} />);
    const mark = screen.getByText(word).closest('[data-recommendation]')!;
    expect(mark).toHaveClass('text-ink');
    expect(mark.querySelector('svg')).toBeNull();
    expect(mark).toHaveTextContent('52');
  });

  it('marks what is not firm with a dashed edge and words', () => {
    render(
      <>
        <ProvisionalMark />
        <MaturingMark />
      </>,
    );
    expect(screen.getByText('Provisional')).toHaveClass('border-dashed', 'text-unresolved-text');
    expect(screen.getByText('Still maturing')).toHaveClass('border-dashed', 'text-unresolved-text');
  });
});

describe('an application status', () => {
  it('takes the family of what it means, and ink when it means nothing', () => {
    expect(applicationStatusClass('Active')).toBe('text-moving-text');
    expect(applicationStatusClass('Hired')).toBe('text-ready-text');
    expect(applicationStatusClass('archived')).toBe('text-closed-text');
    expect(applicationStatusClass('Lead')).toBe('text-ink');
    expect(applicationStatusClass(null)).toBe('text-ink');
  });
});

describe('where candidates leave', () => {
  it('prints the stage, its milestone when it says more, the reason split and the top reasons', () => {
    render(
      <MemoryRouter>
        <ImpactLeaves leaves={impactSummary().leaves} ashbyRead onOpen={vi.fn()} />
      </MemoryRouter>,
    );
    const christy = screen.getAllByRole('row').find((row) => row.getAttribute('data-stage') === 'stage-christy')!;
    expect(christy).toHaveTextContent('Hello Christy');
    expect(christy).toHaveTextContent('Christy stage');
    expect(christy).toHaveTextContent('74%');
    expect(christy).toHaveTextContent('Not a fit for the role');
    const r1 = screen.getAllByRole('row').find((row) => row.getAttribute('data-stage') === 'stage-r1')!;
    // The milestone repeats the title, so it is not printed twice.
    expect(within(r1).getAllByText('R1')).toHaveLength(1);
    expect(r1).toHaveTextContent('None recorded');
  });

  it('says nobody was archived only when Ashby stages are being read', () => {
    const { rerender } = render(<ImpactLeaves leaves={[]} ashbyRead onOpen={vi.fn()} />);
    expect(screen.getByText('No application was archived in these weeks.')).toBeInTheDocument();
    rerender(<ImpactLeaves leaves={[]} ashbyRead={false} onOpen={vi.fn()} />);
    expect(screen.getByText(/Not known yet/)).toBeInTheDocument();
  });
});

describe('time between steps', () => {
  const cellsOf = (key: string) =>
    within(screen.getAllByRole('row').find((row) => row.getAttribute('data-timing') === key)!)
      .getAllByRole('cell')
      .map((cell) => cell.textContent);

  it('names the floor the API keeps, and prints n beside a withheld median', () => {
    render(<ImpactTimings timings={impactSummary().timings} minTimingN={5} ashbyRead />);
    expect(screen.getByText('Days, over completed steps only. A median needs at least 5 applications.')).toBeInTheDocument();
    expect(cellsOf('r1_to_r2')).toEqual(['n too small', '—Not available', '3']);
    expect(cellsOf('entry_to_first_call')).toEqual(['0.2', '1.5', '380']);
  });

  it('prints a missing median as not known when n is at the floor or above', () => {
    const timings = impactSummary().timings.map((timing) =>
      timing.key === 'christy_to_r1' ? { ...timing, medianDays: null, p90Days: null } : timing,
    );
    render(<ImpactTimings timings={timings} minTimingN={5} ashbyRead />);
    expect(cellsOf('christy_to_r1')).toEqual(['—Not available', '—Not available', '45']);
  });

  it('prints every Ashby-side timing as not known while Ashby stages are not read, never n too small or a 0', () => {
    const timings = impactSummary().timings.map((timing) =>
      timing.key === 'entry_to_first_call' ? timing : { ...timing, medianDays: null, p90Days: null, n: 0 },
    );
    render(<ImpactTimings timings={timings} minTimingN={5} ashbyRead={false} />);
    expect(screen.queryByText('n too small')).toBeNull();
    for (const key of ['christy_to_r1', 'r1_to_r2']) {
      expect(cellsOf(key)).toEqual(['—Not available', '—Not available', '—Not available']);
    }
    expect(cellsOf('entry_to_first_call')).toEqual(['0.2', '1.5', '380']);
  });
});

describe('a cell that does not apply', () => {
  it('says so, apart from a figure that is not known: the first step’s of previous, a decision’s still here, and Hired’s ends', () => {
    render(<ImpactPipeline pipeline={impactSummary().pipeline} onOpen={vi.fn()} />);
    const row = (step: string) => screen.getAllByRole('row').find((r) => r.getAttribute('data-step') === step)!;
    expect(within(row('came_in')).getAllByText('Does not apply')).toHaveLength(1);
    expect(within(row('decided')).getAllByText('Does not apply')).toHaveLength(1);
    expect(within(row('hired')).getAllByText('Does not apply')).toHaveLength(2);
    expect(within(screen.getByRole('table')).queryByText('Not available')).toBeNull();
  });

  it('still prints a figure the API sends for it', () => {
    const pipeline = impactSummary().pipeline.map((row) => (row.step === 'decided' ? { ...row, stillHere: 4 } : row));
    render(<ImpactPipeline pipeline={pipeline} onOpen={vi.fn()} />);
    const decided = screen.getAllByRole('row').find((r) => r.getAttribute('data-step') === 'decided')!;
    expect(within(decided).queryByText('Does not apply')).toBeNull();
    expect(within(decided).getByText('4')).toBeInTheDocument();
  });
});

describe('how these numbers are calculated', () => {
  it('states every rule of the contract in words', () => {
    const terms = impactDefinitions(5).map(([term]) => term);
    for (const term of [
      'Steps nest',
      'Came in',
      'Christy called',
      'Christy connected',
      'Scored',
      'A person decided in Ashby',
      'Moved forward in Ashby',
      'R1, R2 or Offer or later',
      'Where candidates leave',
      'Time between steps',
      'Ashby stages',
    ]) {
      expect(terms).toContain(term);
    }
    const text = impactDefinitions(5).map(([, definition]) => definition).join(' ');
    expect(text).toMatch(/consent/);
    expect(text).toMatch(/browser/);
    expect(text).toMatch(/provisional one included/);
    expect(text).toMatch(/Held \(thin evidence\) and No verdict/);
    expect(text).toMatch(/own calls/);
    expect(text).toMatch(/Archived and Lead stages never count/);
    expect(text).toMatch(/at most five/);
    expect(text).toMatch(/fewer than 5/);
    expect(text).toMatch(/dash, never a 0/);
  });

  it('is a closed disclosure that opens to the definitions', async () => {
    render(<ImpactDefinitions minTimingN={7} />);
    const summary = screen.getByText('How these numbers are calculated');
    expect(summary.closest('details')).not.toHaveAttribute('open');
    await userEvent.click(summary);
    expect(summary.closest('details')).toHaveAttribute('open');
    expect(screen.getByText(/With fewer than 7, the times are not shown/)).toBeVisible();
  });
});
