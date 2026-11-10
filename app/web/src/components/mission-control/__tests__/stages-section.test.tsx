/**
 * StagesSection (Mission Control, M031 S2): what each Ashby stage counts as on
 * Business impact.
 *
 * Covers: the 18 live stages in plan order with position, title, Ashby type,
 * milestone and who set it; the stage ids never reach the DOM; labelling with
 * the picker (a label, and "Not labelled", which returns a stage to its
 * default); a refused label; Refresh from Ashby with its counts, its partial
 * and total failures and an integration that is off; the loading, empty,
 * unread and failed states; and axe.
 */
import { StrictMode } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { missionApi, apiFns } from './apiMock';
import { catalogResponse, liveStages } from './stagesFixture';
import { pickOption } from '../../design/__tests__/helpers';
import { StagesSection } from '../StagesSection';
import type { AshbyStageCatalogRefresh } from '../../../lib/ashby-stages';

vi.mock('../../../api', () => ({
  api: missionApi.api,
  ApiError: missionApi.ApiError,
}));

const REFRESH: AshbyStageCatalogRefresh = {
  mappings: { enabled: 3, truncated: false },
  jobs: { attempted: 3, read: 3, failed: 0, notTried: 0 },
  failures: [],
  stages: { seen: 18, inserted: 18, updated: 0, defaulted: 10, redefaulted: 0, leftPlan: 0 },
  deadlineHit: false,
};

function renderSection() {
  return render(
    <MemoryRouter>
      <StagesSection />
    </MemoryRouter>,
  );
}

async function table() {
  return screen.findByRole('table', { name: /Ashby stages in plan order/ });
}

function bodyRows(t: HTMLElement) {
  return within(t).getAllByRole('row').slice(1);
}

describe('StagesSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiFns.listAshbyStageCatalog.mockResolvedValue(catalogResponse());
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows a loading state, then the 18 stages in plan order', async () => {
    let resolve!: (v: unknown) => void;
    apiFns.listAshbyStageCatalog.mockReturnValue(new Promise((r) => { resolve = r; }));
    renderSection();
    expect(screen.getByText('Loading stages…')).toBeInTheDocument();
    resolve(catalogResponse());
    const t = await table();
    const rows = bodyRows(t);
    expect(rows).toHaveLength(18);
    expect(rows.map((r) => within(r).getAllByRole('cell')[1].textContent)).toEqual(liveStages().map((s) => s.title));
    expect(screen.queryByText('Loading stages…')).not.toBeInTheDocument();
  });

  it('loads under StrictMode, which runs its effects twice (the dev app does)', async () => {
    render(
      <StrictMode>
        <MemoryRouter>
          <StagesSection />
        </MemoryRouter>
      </StrictMode>,
    );
    expect(bodyRows(await table())).toHaveLength(18);
    expect(screen.queryByText('Loading stages…')).not.toBeInTheDocument();
  });

  it('prints position, title, Ashby type, the milestone and who set it, in ink', async () => {
    renderSection();
    const t = await table();
    const headers = within(t).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['#', 'Stage', 'Ashby type', 'Counts as', 'Set by']);
    const r1 = bodyRows(t)[8];
    const cells = within(r1).getAllByRole('cell');
    expect(cells[0]).toHaveTextContent('9');
    expect(cells[1]).toHaveTextContent('R1');
    expect(cells[2]).toHaveTextContent('Active');
    expect(within(cells[3]).getByRole('button', { name: 'What R1 counts as R1' })).toBeInTheDocument();
    expect(cells[4]).toHaveTextContent('Default');
    const christy = within(bodyRows(t)[4]).getAllByRole('cell');
    expect(christy[2]).toHaveTextContent('Pre-interview screen');
    expect(within(christy[3]).getByRole('button', { name: 'What Hello Christy counts as Christy stage' })).toBeInTheDocument();
    const hm = within(bodyRows(t)[6]).getAllByRole('cell');
    expect(within(hm[3]).getByRole('button', { name: 'What HM Review counts as Not labelled' })).toBeInTheDocument();
    expect(hm[4]).toHaveTextContent('—');
    // Plain words and figures: no state colour on a label.
    for (const cell of [...cells, ...christy, ...hm]) {
      expect(cell.className).not.toMatch(/text-(ready|unresolved|closed|moving|success|warning|error)/);
    }
  });

  it('names how many stages there are and how many are labelled', async () => {
    renderSection();
    await table();
    expect(screen.getByText('18 stages · 10 labelled')).toBeInTheDocument();
  });

  it('a stage Ashby removed is listed last, marked, and left out of the counts (S2-4)', async () => {
    const live = liveStages().map((s) => (s.title === 'R5' ? { ...s, id: 'stage-13-panel', title: 'Panel', milestone: null, milestoneSource: null } : s));
    const gone = { ...liveStages()[12], id: 'stage-13-r5-gone', inPlan: false };
    apiFns.listAshbyStageCatalog.mockResolvedValue(catalogResponse({ stages: [...live, gone] }));
    renderSection();
    const rows = bodyRows(await table());
    expect(rows).toHaveLength(19);
    // Panel is the live stage at position 13; the removed R5 has no position any more.
    expect(within(rows[12]).getAllByRole('cell')[0]).toHaveTextContent('13');
    expect(within(rows[12]).getAllByRole('cell')[1]).toHaveTextContent('Panel');
    const cells = within(rows[18]).getAllByRole('cell');
    expect(cells[0]).toHaveTextContent('—');
    expect(cells[1]).toHaveTextContent('R5');
    expect(cells[1]).toHaveTextContent('No longer in the Ashby plan');
    // Its label is kept and can still be changed, and its picker says which R5 it is.
    expect(within(cells[3]).getByRole('button', { name: 'What R5, no longer in the Ashby plan, counts as R5' })).toBeInTheDocument();
    expect(cells[4]).toHaveTextContent('Default');
    expect(screen.queryByText('No longer in the Ashby plan', { selector: 'tr:not(:last-child) *' })).not.toBeInTheDocument();
    expect(screen.getByText('18 stages · 9 labelled · 1 no longer in the plan')).toBeInTheDocument();
  });

  it('never puts a stage id in the page', async () => {
    const { container } = renderSection();
    await table();
    for (const s of liveStages()) expect(container.innerHTML).not.toContain(s.id);
  });

  it('labels a stage with the picker and says so', async () => {
    const user = userEvent.setup();
    const hm = liveStages()[6];
    apiFns.labelAshbyStage.mockResolvedValue({ ok: true, stage: { ...hm, milestone: 'other', milestoneSource: 'admin' } });
    renderSection();
    await table();
    await pickOption(user, /^What HM Review counts as/, 'Other');
    expect(apiFns.labelAshbyStage).toHaveBeenCalledWith(hm.id, 'other');
    expect(await screen.findByText('HM Review now counts as Other.')).toBeInTheDocument();
    const row = bodyRows(await table())[6];
    expect(within(row).getByRole('button', { name: 'What HM Review counts as Other' })).toBeInTheDocument();
    expect(within(row).getAllByRole('cell')[4]).toHaveTextContent('Admin');
  });

  it('while a label saves, its picker keeps keyboard focus and says it is busy, and takes no second choice (S2-5)', async () => {
    const user = userEvent.setup();
    const hm = liveStages()[6];
    let release!: () => void;
    apiFns.labelAshbyStage.mockReturnValue(new Promise((r) => { release = () => r({ ok: true, stage: { ...hm, milestone: 'other', milestoneSource: 'admin' } }); }));
    renderSection();
    await table();
    const trigger = screen.getByRole('button', { name: /^What HM Review counts as/ });
    trigger.focus();
    await user.keyboard('{Enter}');
    await user.keyboard('oo{Enter}');
    expect(apiFns.labelAshbyStage).toHaveBeenCalledWith(hm.id, 'other');
    // Not `disabled`: a disabled button drops focus to the page body.
    expect(trigger).not.toBeDisabled();
    expect(trigger).toHaveAttribute('aria-busy', 'true');
    expect(trigger).toHaveAttribute('aria-disabled', 'true');
    expect(trigger).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(apiFns.labelAshbyStage).toHaveBeenCalledTimes(1);
    release();
    expect(await screen.findByText('HM Review now counts as Other.')).toBeInTheDocument();
    const after = screen.getByRole('button', { name: 'What HM Review counts as Other' });
    expect(after).toBe(trigger);
    expect(after).toHaveFocus();
    expect(after).not.toHaveAttribute('aria-busy');
  });

  it('"Not labelled" clears the label and shows the default the stage returns to', async () => {
    const user = userEvent.setup();
    const offer = liveStages()[15];
    apiFns.listAshbyStageCatalog.mockResolvedValue(catalogResponse({
      stages: liveStages().map((s) => (s.id === offer.id ? { ...s, milestone: 'other', milestoneSource: 'admin' } : s)),
    }));
    apiFns.labelAshbyStage.mockResolvedValue({ ok: true, stage: { ...offer, milestone: 'offer', milestoneSource: 'default' } });
    renderSection();
    await table();
    await pickOption(user, /^What Offer counts as Other/, 'Not labelled');
    expect(apiFns.labelAshbyStage).toHaveBeenCalledWith(offer.id, null);
    expect(await screen.findByText("Offer's label is cleared. It counts as Offer by default.")).toBeInTheDocument();
  });

  it('a refused label says why and leaves the row as it was', async () => {
    const user = userEvent.setup();
    apiFns.labelAshbyStage.mockRejectedValue(new missionApi.ApiError('not_found', 404));
    renderSection();
    await table();
    await pickOption(user, /^What R2 counts as/, 'R3');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Couldn't save the label for R2. This stage is no longer in the catalogue. Refresh from Ashby and try again.",
    );
    expect(within(bodyRows(await table())[9]).getByRole('button', { name: 'What R2 counts as R2' })).toBeInTheDocument();
  });

  it('Refresh from Ashby reads the plan again, reloads the list and reports the counts', async () => {
    const user = userEvent.setup();
    let release!: () => void;
    apiFns.refreshAshbyStageCatalog.mockReturnValue(new Promise((r) => { release = () => r({ ok: true, refresh: REFRESH }); }));
    renderSection();
    await table();
    await user.click(screen.getByRole('button', { name: 'Refresh from Ashby' }));
    expect(screen.getByRole('button', { name: 'Refreshing…' })).toBeDisabled();
    release();
    expect(await screen.findByText('Read 3 jobs from Ashby: 18 stages, 18 new stages, 10 labelled by default.')).toBeInTheDocument();
    await waitFor(() => expect(apiFns.listAshbyStageCatalog).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: 'Refresh from Ashby' })).toBeEnabled();
  });

  it('a refresh that Ashby partly refused says which jobs and why, in words', async () => {
    const user = userEvent.setup();
    apiFns.refreshAshbyStageCatalog.mockResolvedValue({
      ok: true,
      refresh: { ...REFRESH, jobs: { attempted: 3, read: 2, failed: 1, notTried: 0 }, failures: [{ code: 'missing_permission', count: 1 }] },
    });
    renderSection();
    await table();
    await user.click(screen.getByRole('button', { name: 'Refresh from Ashby' }));
    expect(await screen.findByText(/Ashby didn't return the stages for 1 of 3 jobs: HELLO's Ashby key is missing the Jobs read permission\./)).toBeInTheDocument();
    expect(screen.queryByText(/missing_permission/)).not.toBeInTheDocument();
  });

  it('a refresh with the integration off says so', async () => {
    const user = userEvent.setup();
    apiFns.refreshAshbyStageCatalog.mockRejectedValue(new missionApi.ApiError('integration_disabled', 503));
    renderSection();
    await table();
    await user.click(screen.getByRole('button', { name: 'Refresh from Ashby' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Couldn't refresh from Ashby. The Ashby integration is turned off, so HELLO can't read the interview plans.",
    );
    expect(apiFns.listAshbyStageCatalog).toHaveBeenCalledTimes(1);
  });

  it('with no live mapping, says there is nothing to read', async () => {
    apiFns.listAshbyStageCatalog.mockResolvedValue(catalogResponse({ stages: [], enabledMappings: 0, unreadMappings: 0 }));
    renderSection();
    expect(await screen.findByText('No live Ashby jobs')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('with live mappings but no plan read yet, asks for a refresh', async () => {
    apiFns.listAshbyStageCatalog.mockResolvedValue(catalogResponse({ stages: [], enabledMappings: 2, unreadMappings: 2 }));
    renderSection();
    expect(await screen.findByText('Stages not read yet')).toBeInTheDocument();
    expect(screen.getByText(/Press Refresh from Ashby/)).toBeInTheDocument();
  });

  it('with some plans unread, lists what it has and says how many are missing', async () => {
    apiFns.listAshbyStageCatalog.mockResolvedValue(catalogResponse({ unreadMappings: 1 }));
    renderSection();
    await table();
    expect(screen.getByText("1 live job's interview plan hasn't been read yet. Refresh from Ashby to read it.")).toBeInTheDocument();
  });

  it('a failed load is an error with retry, never an empty list', async () => {
    const user = userEvent.setup();
    apiFns.listAshbyStageCatalog.mockRejectedValueOnce(new missionApi.ApiError('mission_control_read_error', 500));
    renderSection();
    expect(await screen.findByRole('alert')).toHaveTextContent("The stages couldn't load.");
    expect(screen.queryByText('No live Ashby jobs')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(await table()).toBeInTheDocument();
  });

  it('is reachable by keyboard: Tab reaches Refresh and the first picker, and Enter opens it', async () => {
    const user = userEvent.setup();
    renderSection();
    await table();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Refresh from Ashby' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: /^What New Lead counts as/ })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = renderSection();
    await table();
    await expect(container).toHaveNoViolations();
  });
});
