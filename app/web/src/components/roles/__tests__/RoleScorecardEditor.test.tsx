/**
 * RoleScorecardEditor — attach/tune the per-role scorecard.
 *
 * Load-bearing coverage, all of it about the TYPED weight boxes that replaced
 * the slider: typing one weight changes ONLY that metric (the old slider
 * silently rewrote the rest), the running total states how far off 100% the
 * set now is, and Save is blocked — with a message naming the direction and
 * the amount — until the owner has made it total exactly 100%.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { api } = vi.hoisted(() => ({
  api: {
    getRoleScorecard: vi.fn(),
    listScorecardMetrics: vi.fn(),
    putRoleScorecard: vi.fn(),
    redistributeRoleScorecardWeights: vi.fn(),
  },
}));

vi.mock('../../../api', () => ({
  api,
  ApiError: class extends Error {
    status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
    }
  },
}));

import { RoleScorecardEditor } from '../RoleScorecardEditor';

const RUBRIC = { 1: 'a', 2: 'b', 3: 'c', 4: 'd' };

function metric(i: number, name: string, key: string, weightBps: number) {
  return {
    id: `sm-${i}`,
    libraryMetricId: `lib-${i}`,
    key,
    name,
    instruction: `Instruction ${i}`,
    rubric: RUBRIC,
    weightBps,
    displayOrder: i,
  };
}

const SCORECARD = {
  id: 'ver-1',
  roleId: 'r1',
  version: 2,
  configurationHash: 'hash',
  metrics: [
    metric(0, 'Communication', 'communication', 3334),
    metric(1, 'Motivation', 'motivation', 3333),
    metric(2, 'Culture', 'culture', 3333),
  ],
};

/**
 * The COMMITTED weight for a metric, read off the row's `%` marker.
 *
 * Deliberately not read off the input's value: while the owner is typing, the
 * box shows a draft string that has not been committed, and several of these
 * tests exist precisely to pin that difference.
 */
function footerTotal(): HTMLElement {
  const el = document.querySelector('[data-weight-total-footer]');
  if (!el) throw new Error('no weight total beside Save');
  return el as HTMLElement;
}

function totalMeta(): HTMLElement {
  const el = document.querySelector('[data-weight-total-bps]');
  if (!el) throw new Error('no running weight total rendered');
  return el as HTMLElement;
}

function weightOf(name: string): number {
  const row = [...document.querySelectorAll('[data-metric-row]')].find((el) =>
    el.textContent?.includes(name),
  );
  if (!row) throw new Error(`no metric row for ${name}`);
  const marker = row.querySelector('[data-metric-weight-bps]');
  if (!marker) throw new Error(`no weight marker in the ${name} row`);
  return Number(marker.getAttribute('data-metric-weight-bps'));
}

const LIBRARY = [
  {
    id: 'lib-9',
    key: 'ownership',
    name: 'Ownership',
    default_instruction: 'Probe for end-to-end ownership.',
    rubric: RUBRIC,
  },
];

describe('RoleScorecardEditor', () => {
  beforeEach(() => {
    // MUST come first. Without it these hoisted `vi.fn()`s keep their call
    // history across tests, and every `not.toHaveBeenCalled()` silently turns
    // into "no test before me in file order happened to save" — an assertion
    // whose truth depends on where it sits in the file.
    vi.clearAllMocks();
    api.getRoleScorecard.mockResolvedValue({ scorecard: SCORECARD });
    // A NON-EMPTY library. With `[]` the add-select is disabled and Attach is
    // permanently `disabled={!addSelection}`, so every attach path — and the
    // weight arithmetic that goes with it — is unreachable by the suite.
    api.listScorecardMetrics.mockResolvedValue(LIBRARY);
    api.putRoleScorecard.mockResolvedValue({ scorecard: SCORECARD });
  });

  async function attachOwnership() {
    await userEvent.selectOptions(
      await screen.findByLabelText('Add a metric'),
      'lib-9',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Attach' }));
  }

  it('loads the active scorecard and shows weights totalling 100%', async () => {
    render(<RoleScorecardEditor roleId="r1" />);
    expect(await screen.findByText('Communication')).toBeInTheDocument();
    expect(screen.getByText('Motivation')).toBeInTheDocument();
    expect(screen.getByText('Culture')).toBeInTheDocument();
    expect(screen.getByText('Total 100%')).toBeInTheDocument();
  });

  it('TYPES a weight into one metric WITHOUT touching the others', async () => {
    // The point of the change. The slider redistributed on every move, so
    // 30/30/20/10/10 was unreachable — you could pin one number and the rest
    // were rewritten under you.
    render(<RoleScorecardEditor roleId="r1" />);
    await screen.findByText('Communication');

    fireEvent.change(screen.getByLabelText('Weight for Communication'), {
      target: { value: '50' },
    });

    expect(weightOf('Communication')).toBe(5000);
    // Motivation and Culture are UNCHANGED at their loaded 33.33%.
    expect(weightOf('Motivation')).toBe(3333);
    expect(weightOf('Culture')).toBe(3333);
  });

  it('states the running total, and how far OVER 100% it is', async () => {
    render(<RoleScorecardEditor roleId="r1" />);
    await screen.findByText('Communication');

    fireEvent.change(screen.getByLabelText('Weight for Communication'), {
      target: { value: '50' },
    });

    // 50 + 33.33 + 33.33 = 116.66.
    const meta = totalMeta();
    expect(meta.textContent).toContain('Total 116.66%');
    expect(meta.textContent).toContain('16.66% over');
    expect(meta.getAttribute('data-weight-delta-bps')).toBe('1666');
    // The total is announced — it is the only feedback a screen reader gets
    // that Save is about to refuse.
    expect(meta.getAttribute('role')).toBe('status');
    expect(meta.getAttribute('aria-live')).toBe('polite');
  });

  it('keeps the live region the SAME NODE across a total change', async () => {
    // A live region that is created at the same moment its content changes is
    // not reliably announced; the screen reader has to have been watching it.
    // Asserting role/aria-live alone would not catch this — a span remounted
    // on every change (a `key={total}`, or a re-created sibling) keeps both
    // attributes and loses the property. Node identity is the property.
    render(<RoleScorecardEditor roleId="r1" />);
    await screen.findByText('Communication');

    const before = totalMeta();
    expect(before.getAttribute('role')).toBe('status');
    expect(before.getAttribute('aria-live')).toBe('polite');

    fireEvent.change(screen.getByLabelText('Weight for Communication'), {
      target: { value: '50' },
    });

    expect(totalMeta()).toBe(before);
  });

  it('repeats the total BESIDE SAVE, where the header has scrolled out of view', async () => {
    // A scorecard runs to 20 metrics. A total that only lives in the section
    // header is not on screen at the moment the owner reaches for Save, which
    // is the moment the whole feature exists for.
    render(<RoleScorecardEditor roleId="r1" />);
    await screen.findByText('Communication');
    expect(footerTotal().textContent).toBe('Weights total 100%');

    fireEvent.change(screen.getByLabelText('Weight for Communication'), {
      target: { value: '50' },
    });

    expect(footerTotal().textContent).toBe('Weights total 116.66% — 16.66% over');
    // Both statements of the same fact agree.
    expect(totalMeta().textContent).toContain('16.66% over');
  });

  it('states how far SHORT of 100% it is', async () => {
    render(<RoleScorecardEditor roleId="r1" />);
    await screen.findByText('Communication');

    fireEvent.change(screen.getByLabelText('Weight for Communication'), {
      target: { value: '10' },
    });

    const meta = totalMeta();
    expect(meta.textContent).toContain('Total 76.66%');
    expect(meta.textContent).toContain('23.34% short');
    expect(meta.getAttribute('data-weight-delta-bps')).toBe('-2334');
  });

  it('REFUSES to save an incomplete set, naming the direction and the amount', async () => {
    render(<RoleScorecardEditor roleId="r1" />);
    await screen.findByText('Communication');

    fireEvent.change(screen.getByLabelText('Weight for Communication'), {
      target: { value: '50' },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Save scorecard' }));

    // Queried through the alert, because the footer total now says the SAME
    // words — which is the point (one derivation, three places) but makes a
    // bare text query ambiguous.
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      'Weights total 116.66% — 16.66% over. They must total exactly 100% before saving.',
    );
    // The whole point of blocking: nothing reached the server.
    expect(api.putRoleScorecard).not.toHaveBeenCalled();
  });

  it('REFUSES to save a metric weighted 0, even at a perfect 100% total', async () => {
    // The set the server 400s despite totalling exactly 10000 bps. The message
    // must name THAT problem, not repeat "must total 100%".
    render(<RoleScorecardEditor roleId="r1" />);
    await screen.findByText('Communication');

    fireEvent.change(screen.getByLabelText('Weight for Communication'), {
      target: { value: '66.66' },
    });
    fireEvent.change(screen.getByLabelText('Weight for Motivation'), {
      target: { value: '33.34' },
    });
    fireEvent.change(screen.getByLabelText('Weight for Culture'), { target: { value: '0' } });

    await userEvent.click(screen.getByRole('button', { name: 'Save scorecard' }));

    expect(
      await screen.findByText(/Every metric needs a weight above 0%/),
    ).toBeInTheDocument();
    expect(api.putRoleScorecard).not.toHaveBeenCalled();
  });

  it('saves the typed weights VERBATIM once they total exactly 100%', async () => {
    render(<RoleScorecardEditor roleId="r1" />);
    await screen.findByText('Communication');

    // A split the old slider could not produce: 50/30/20.
    fireEvent.change(screen.getByLabelText('Weight for Communication'), {
      target: { value: '50' },
    });
    fireEvent.change(screen.getByLabelText('Weight for Motivation'), {
      target: { value: '30' },
    });
    fireEvent.change(screen.getByLabelText('Weight for Culture'), { target: { value: '20' } });

    expect(screen.getByText('Total 100%')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save scorecard' }));

    await waitFor(() => expect(api.putRoleScorecard).toHaveBeenCalledTimes(1));
    const [roleId, body] = api.putRoleScorecard.mock.calls[0];
    expect(roleId).toBe('r1');
    expect(body.metrics).toHaveLength(3);
    const byLib = new Map(
      body.metrics.map((m: { libraryMetricId: string; weightBps: number }) => [
        m.libraryMetricId,
        m.weightBps,
      ]),
    );
    expect(byLib.get('lib-0')).toBe(5000);
    expect(byLib.get('lib-1')).toBe(3000);
    expect(byLib.get('lib-2')).toBe(2000);
    const total = body.metrics.reduce((s: number, m: { weightBps: number }) => s + m.weightBps, 0);
    expect(total).toBe(10000);
  });

  it('accepts a 2dp weight, so 33.33 round-trips instead of snapping to 33', async () => {
    // The slider stepped in whole percent. bps resolution is 0.01%, and a
    // three-way split needs it.
    render(<RoleScorecardEditor roleId="r1" />);
    await screen.findByText('Communication');

    fireEvent.change(screen.getByLabelText('Weight for Communication'), {
      target: { value: '33.33' },
    });
    expect(weightOf('Communication')).toBe(3333);
  });

  it('lets a box be CLEARED mid-edit without the weight jumping to 0', async () => {
    // A controlled numeric input that parses every keystroke turns "" into 0,
    // so backspacing to retype silently rewrites the weight. The draft state
    // is what prevents that; this pins it.
    render(<RoleScorecardEditor roleId="r1" />);
    await screen.findByText('Communication');

    const box = screen.getByLabelText('Weight for Communication') as HTMLInputElement;
    fireEvent.change(box, { target: { value: '' } });

    expect(box.value).toBe('');
    expect(weightOf('Communication')).toBe(3334); // committed value untouched
    // Blur discards the empty draft and re-renders from the committed weight.
    fireEvent.blur(box);
    expect(box.value).toBe('33.34');
  });

  it('BLURS the box on a scroll wheel, so scrolling the page cannot step a weight', async () => {
    // A focused number input consumes the wheel and increments itself. On a
    // 20-metric card, scrolling past the box you just typed into would move
    // the weight with no keystroke and no sign — exactly the silent
    // mis-total this whole screen is meant to prevent.
    render(<RoleScorecardEditor roleId="r1" />);
    await screen.findByText('Communication');

    const box = screen.getByLabelText('Weight for Communication') as HTMLInputElement;
    box.focus();
    expect(document.activeElement).toBe(box);

    fireEvent.wheel(box, { deltaY: -100 });
    expect(document.activeElement).not.toBe(box);
  });

  it('IGNORES an out-of-range typed value rather than committing it', async () => {
    render(<RoleScorecardEditor roleId="r1" />);
    await screen.findByText('Communication');

    const box = screen.getByLabelText('Weight for Communication') as HTMLInputElement;
    fireEvent.change(box, { target: { value: '150' } });
    expect(weightOf('Communication')).toBe(3334);

    fireEvent.blur(box);
    expect(box.value).toBe('33.34');
  });

  it('ATTACHING a metric does not touch a single typed weight', async () => {
    // The sin this PR exists to remove, in its last hiding place. Attach used
    // to re-split the WHOLE set evenly, so adding a sixth metric to a
    // hand-tuned five silently overwrote all five.
    render(<RoleScorecardEditor roleId="r1" />);
    await screen.findByText('Communication');

    fireEvent.change(screen.getByLabelText('Weight for Communication'), {
      target: { value: '50' },
    });
    fireEvent.change(screen.getByLabelText('Weight for Motivation'), {
      target: { value: '30' },
    });
    fireEvent.change(screen.getByLabelText('Weight for Culture'), { target: { value: '20' } });

    await attachOwnership();

    expect(weightOf('Communication')).toBe(5000);
    expect(weightOf('Motivation')).toBe(3000);
    expect(weightOf('Culture')).toBe(2000);
  });

  it('gives a newly attached metric WHAT IS LEFT of 100%', async () => {
    render(<RoleScorecardEditor roleId="r1" />);
    await screen.findByText('Communication');

    // Set sits at 80%: 50 + 30 + 0 leaves 20 for the newcomer, completing it.
    fireEvent.change(screen.getByLabelText('Weight for Communication'), {
      target: { value: '50' },
    });
    fireEvent.change(screen.getByLabelText('Weight for Motivation'), {
      target: { value: '30' },
    });
    fireEvent.change(screen.getByLabelText('Weight for Culture'), { target: { value: '0' } });

    await attachOwnership();

    expect(weightOf('Ownership')).toBe(2000);
    expect(footerTotal().textContent).toBe('Weights total 100%');
  });

  it('gives a newly attached metric 0 when the set is ALREADY complete', async () => {
    // There is nothing left to give, and inventing room by shaving the others
    // is exactly the overwrite this design forbids. Save then asks for a
    // weight via the zero-weight guard.
    render(<RoleScorecardEditor roleId="r1" />);
    await screen.findByText('Communication');
    expect(footerTotal().textContent).toBe('Weights total 100%');

    await attachOwnership();

    expect(weightOf('Ownership')).toBe(0);
    expect(weightOf('Communication')).toBe(3334);
    expect(footerTotal().textContent).toBe('Weights total 100%');

    await userEvent.click(screen.getByRole('button', { name: 'Save scorecard' }));
    expect(await screen.findByText(/Every metric needs a weight above 0%/)).toBeInTheDocument();
    expect(api.putRoleScorecard).not.toHaveBeenCalled();
  });

  it('REMOVING a metric leaves the others as typed and lets the total go short', async () => {
    // Removal used to re-split the survivors evenly — the same silent rewrite.
    // Going short is the honest outcome, and the running total is what reports
    // it.
    render(<RoleScorecardEditor roleId="r1" />);
    await screen.findByText('Communication');

    fireEvent.change(screen.getByLabelText('Weight for Communication'), {
      target: { value: '50' },
    });
    fireEvent.change(screen.getByLabelText('Weight for Motivation'), {
      target: { value: '30' },
    });
    fireEvent.change(screen.getByLabelText('Weight for Culture'), { target: { value: '20' } });

    await userEvent.click(screen.getByRole('button', { name: 'Remove Culture' }));

    expect(screen.queryByText('Culture')).not.toBeInTheDocument();
    expect(weightOf('Communication')).toBe(5000);
    expect(weightOf('Motivation')).toBe(3000);
    expect(footerTotal().textContent).toBe('Weights total 80% — 20% short');
  });

  it('ABANDONS an out-of-range edit instead of keeping the prefix it committed', async () => {
    // Every in-range keystroke commits so the total tracks live, which means
    // typing "1000" (meaning 10.00) commits 1 -> 10 -> 100 on the way past
    // before the final string is rejected. Without the restore value, blurring
    // there would leave the weight at 100% — a number never chosen.
    render(<RoleScorecardEditor roleId="r1" />);
    await screen.findByText('Communication');

    const box = screen.getByLabelText('Weight for Communication') as HTMLInputElement;
    // `type` APPENDS — clear first, or "33.34" + "1000" is what gets parsed.
    await userEvent.clear(box);
    await userEvent.type(box, '1000');

    // Mid-type, the committed weight really did walk up to 100%.
    expect(weightOf('Communication')).toBe(10000);

    fireEvent.blur(box);
    // ...and the abandoned edit puts it back where it started.
    expect(weightOf('Communication')).toBe(3334);
    expect(box.value).toBe('33.34');
  });

  it('KEEPS an in-range edit that was typed through an invalid prefix', async () => {
    // The mirror case: the restore must not fire on a perfectly good edit.
    render(<RoleScorecardEditor roleId="r1" />);
    await screen.findByText('Communication');

    const box = screen.getByLabelText('Weight for Communication') as HTMLInputElement;
    await userEvent.clear(box);
    await userEvent.type(box, '45');
    fireEvent.blur(box);

    expect(weightOf('Communication')).toBe(4500);
  });

  it('shows the SAVED confirmation, which the reload used to wipe before it painted', async () => {
    // `save()` set the message and then called `load()`, whose third statement
    // cleared it; React batches both into one render, so the only feedback
    // from an irreversible new-version write never appeared.
    render(<RoleScorecardEditor roleId="r1" />);
    await screen.findByText('Communication');

    fireEvent.change(screen.getByLabelText('Weight for Communication'), {
      target: { value: '50' },
    });
    fireEvent.change(screen.getByLabelText('Weight for Motivation'), {
      target: { value: '30' },
    });
    fireEvent.change(screen.getByLabelText('Weight for Culture'), { target: { value: '20' } });
    await userEvent.click(screen.getByRole('button', { name: 'Save scorecard' }));

    expect(await screen.findByText('Scorecard saved as a new version.')).toBeInTheDocument();
  });

  it('announces a save REFUSAL assertively, since it is mounted as it appears', async () => {
    // A polite `status` region created at the same instant its content appears
    // is not reliably announced — and the refusal is exactly that.
    render(<RoleScorecardEditor roleId="r1" />);
    await screen.findByText('Communication');

    fireEvent.change(screen.getByLabelText('Weight for Communication'), {
      target: { value: '50' },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Save scorecard' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/16\.66% over/);
  });

  it('reorders metrics with the move controls', async () => {
    render(<RoleScorecardEditor roleId="r1" />);
    await screen.findByText('Communication');

    // Move Motivation (index 1) up → it becomes first.
    fireEvent.click(screen.getByRole('button', { name: 'Move Motivation up' }));
    await waitFor(() => {
      const order = [...document.querySelectorAll('[data-metric-row] .text-sm.font-medium')].map(
        (el) => el.textContent,
      );
      expect(order[0]).toBe('Motivation');
    });
  });

  it('shows the legacy-fallback note when the role has no scorecard', async () => {
    api.getRoleScorecard.mockResolvedValue({ scorecard: null });
    render(<RoleScorecardEditor roleId="r1" />);
    expect(
      await screen.findByText(/This role uses the legacy scoring until a scorecard is saved\./),
    ).toBeInTheDocument();
  });

  it('does NOT cry "100% short" over an empty scorecard', async () => {
    // "No metrics attached yet" is a legitimate state the panel describes in
    // plain words. A red total complaining that nothing adds to 100% is an
    // alarm about nothing, and it would be the loudest thing on the panel.
    api.getRoleScorecard.mockResolvedValue({ scorecard: null });
    render(<RoleScorecardEditor roleId="r1" />);
    await screen.findByText(/This role uses the legacy scoring/);

    expect(document.querySelector('[data-weight-total-bps]')).toBeNull();
    expect(document.querySelector('[data-weight-total-footer]')).toBeNull();
    expect(screen.queryByText(/short/)).not.toBeInTheDocument();
  });
});
