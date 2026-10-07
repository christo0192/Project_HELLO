/**
 * R1Section: the Send R1 card and the R1 rounds panel on the candidate page.
 *
 * Pins, in order: who sees what by role; the disabled state for every
 * availability answer; a server that does not run R1 (no card at all, and no
 * flash of one); the send flow (attestation, one-time link, copy, dismissal,
 * focus); what Send does beside existing rounds, including the one-retake
 * rule for a round that ended after counting an attempt; the lifecycle
 * actions, their confirmations and who is offered them (an admin, or the
 * interviewer who created the round); the results placeholder; failure
 * handling; and keyboard and axe coverage of every visible state.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { R1Round } from '../../../lib/r1-types';
import { ApiError } from '../../../api';
import { R1Section } from '../R1Section';

const api = vi.hoisted(() => ({
  listR1Rounds: vi.fn(),
  getR1Availability: vi.fn(),
  sendR1Round: vi.fn(),
  cancelR1Round: vi.fn(),
  reissueR1Round: vi.fn(),
  grantR1Retake: vi.fn(),
}));

vi.mock('../../../api', () => ({
  api,
  ApiError: class extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

const LINK = `https://app.example.test/candidate/r1#${'ab12'.repeat(16)}`;

function round(over: Partial<R1Round> = {}): R1Round {
  return {
    id: 'round-1',
    status: 'invited',
    expires_at: '2026-10-09T10:00:00.000Z',
    attempts_allowed: 2,
    attempts_counted: 0,
    recommendation: null,
    overall: null,
    created_at: '2026-10-06T10:00:00.000Z',
    created_by: 'user-1',
    ...over,
  };
}

function renderSection(
  role: 'admin' | 'interviewer' | 'viewer' = 'interviewer',
  userId: string | null = 'user-1',
) {
  return render(
    <MemoryRouter>
      <R1Section candidateId="cand-1" candidateName="Ava Rao" role={role} userId={userId} />
    </MemoryRouter>,
  );
}

/** The card has finished its reads and is on screen (it draws nothing before that). */
async function settled() {
  await screen.findByRole('heading', { name: 'R1 interview' });
}

const sendButton = () => screen.getByRole('button', { name: 'Send R1' });

beforeEach(() => {
  vi.clearAllMocks();
  api.listR1Rounds.mockResolvedValue({ rounds: [] });
  api.getR1Availability.mockResolvedValue({ state: 'ready', hold_minutes: 55 });
  api.sendR1Round.mockResolvedValue({
    id: 'round-9',
    status: 'invited',
    expires_at: '2026-10-09T10:00:00.000Z',
    join_url: LINK,
  });
  api.cancelR1Round.mockResolvedValue({ ok: true });
  api.reissueR1Round.mockResolvedValue({ id: 'round-1', join_url: LINK });
  api.grantR1Retake.mockResolvedValue({ ok: true });
});

describe('who sees what', () => {
  it('shows an interviewer the card with Send R1 and the plan facts', async () => {
    renderSection('interviewer');
    expect(await screen.findByRole('heading', { name: 'R1 interview' })).toBeInTheDocument();
    await settled();
    expect(sendButton()).toBeEnabled();
    expect(screen.getByText(/shown once, valid for 72 hours, with one retake/)).toBeInTheDocument();
    expect(screen.getByText('No R1 round has been sent yet.')).toBeInTheDocument();
  });

  it('renders nothing for a viewer with no rounds, and never reads availability', async () => {
    const { container } = renderSection('viewer');
    await waitFor(() => expect(api.listR1Rounds).toHaveBeenCalledWith('cand-1'));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(api.getR1Availability).not.toHaveBeenCalled();
  });

  it('shows a viewer the rounds read-only, with no buttons at all', async () => {
    api.listR1Rounds.mockResolvedValue({ rounds: [round()] });
    renderSection('viewer');
    expect(await screen.findByRole('list', { name: 'R1 rounds' })).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders nothing when the API says the candidate is not theirs (403)', async () => {
    api.listR1Rounds.mockRejectedValue(new ApiError('access_denied', 403));
    const { container } = renderSection('interviewer');
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});

describe('the disabled state', () => {
  it.each([
    ['disabled', 'R1 is switched off'],
    ['paused', 'R1 is paused'],
    ['capacity_exhausted', 'This month’s R1 allowance is used up'],
    ['role_not_configured', 'R1 is not set up yet'],
    ['config_invalid', 'R1 is off because of a configuration problem'],
  ])('shows why for %s and keeps the button inert but focusable', async (state, title) => {
    api.getR1Availability.mockResolvedValue({ state, hold_minutes: 55 });
    const user = userEvent.setup();
    renderSection('interviewer');
    expect(await screen.findByText(title)).toBeInTheDocument();
    const button = sendButton();
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).not.toBeDisabled();
    // The reason is the button's description, so it is read, not just seen.
    const reasonId = button.getAttribute('aria-describedby')!;
    expect(document.getElementById(reasonId)).toHaveTextContent(title);
    await user.click(button);
    expect(screen.queryByRole('group', { name: /Send R1 to/ })).not.toBeInTheDocument();
  });

  it('points an admin at R1 settings when the fix lives there, and nobody else', async () => {
    api.getR1Availability.mockResolvedValue({ state: 'paused', hold_minutes: 55 });
    const { unmount } = renderSection('admin');
    const link = await screen.findByRole('link', { name: 'Open R1 settings' });
    expect(link).toHaveAttribute('href', '/admin/r1');
    unmount();
    renderSection('interviewer');
    await screen.findByText('R1 is paused');
    expect(screen.queryByRole('link', { name: 'Open R1 settings' })).not.toBeInTheDocument();
  });

  it('offers no settings link for states an admin cannot fix there', async () => {
    api.getR1Availability.mockResolvedValue({ state: 'role_not_configured', hold_minutes: 55 });
    renderSection('admin');
    await screen.findByText('R1 is not set up yet');
    expect(screen.queryByRole('link', { name: 'Open R1 settings' })).not.toBeInTheDocument();
  });

  it('shows why, beside a past unused round, when the server is not deployed', async () => {
    api.getR1Availability.mockResolvedValue({ state: 'not_deployed', hold_minutes: 55 });
    api.listR1Rounds.mockResolvedValue({ rounds: [round({ status: 'expired' })] });
    renderSection('admin');
    expect(await screen.findByText('R1 is not live on this server yet')).toBeInTheDocument();
    expect(sendButton()).toHaveAttribute('aria-disabled', 'true');
    // Flipping the switch in R1 settings would do nothing, so an admin is not sent there.
    expect(screen.queryByRole('link', { name: 'Open R1 settings' })).not.toBeInTheDocument();
    expect(screen.queryByText(/switch R1 on in R1 settings/)).not.toBeInTheDocument();
  });

  it('treats an unreadable availability as unknown: no reason, Send still offered', async () => {
    api.getR1Availability.mockRejectedValue(new ApiError('service_unavailable', 503));
    renderSection('interviewer');
    await settled();
    expect(sendButton()).not.toHaveAttribute('aria-disabled');
    expect(screen.queryByText(/R1 is (switched off|paused)/)).not.toBeInTheDocument();
  });
});

describe('a server that does not run R1 (not_deployed: production today)', () => {
  beforeEach(() => {
    api.getR1Availability.mockResolvedValue({ state: 'not_deployed', hold_minutes: 55 });
  });

  it.each(['admin', 'interviewer'] as const)('draws no card for %s, no rounds', async (role) => {
    const { container } = renderSection(role);
    await waitFor(() => expect(api.getR1Availability).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(api.listR1Rounds).toHaveBeenCalledTimes(1));
    // Let both answers land; the card must never have been drawn for them.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('heading', { name: 'R1 interview' })).not.toBeInTheDocument();
    expect(screen.queryByText('R1 is not live on this server yet')).not.toBeInTheDocument();
  });

  it('keeps the card, with its reason, when a round already exists to show', async () => {
    api.listR1Rounds.mockResolvedValue({ rounds: [round({ status: 'completed' })] });
    renderSection('interviewer');
    expect(await screen.findByRole('list', { name: 'R1 rounds' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'R1 interview' })).toBeInTheDocument();
  });

  it('never flashes the card while availability is still unknown', async () => {
    let answer: (value: unknown) => void = () => undefined;
    api.getR1Availability.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const { container } = renderSection('interviewer');
    await waitFor(() => expect(api.listR1Rounds).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The rounds are in; the card waits for what decides whether it exists at all.
    expect(container).toBeEmptyDOMElement();
    answer({ state: 'not_deployed', hold_minutes: 55 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container).toBeEmptyDOMElement();
  });

  it('draws the card once a live server answers ready', async () => {
    let answer: (value: unknown) => void = () => undefined;
    api.getR1Availability.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const { container } = renderSection('interviewer');
    await waitFor(() => expect(api.listR1Rounds).toHaveBeenCalledTimes(1));
    expect(container).toBeEmptyDOMElement();
    answer({ state: 'ready', hold_minutes: 55 });
    expect(await screen.findByRole('heading', { name: 'R1 interview' })).toBeInTheDocument();
    expect(sendButton()).toBeEnabled();
  });

  it('still draws the card, with Send offered, when availability cannot be read', async () => {
    api.getR1Availability.mockRejectedValue(new ApiError('service_unavailable', 503));
    renderSection('interviewer');
    await settled();
    expect(sendButton()).toBeEnabled();
  });

  it('shows a rounds failure at once, without waiting for availability', async () => {
    api.getR1Availability.mockReturnValue(new Promise(() => undefined));
    api.listR1Rounds.mockRejectedValue(new ApiError('service_unavailable', 503));
    renderSection('interviewer');
    expect(await screen.findByRole('alert')).toHaveTextContent('R1 rounds could not be loaded.');
  });
});

describe('sending R1', () => {
  it('asks for the India attestation before it will create a link', async () => {
    const user = userEvent.setup();
    renderSection();
    await settled();
    await user.click(sendButton());

    const well = await screen.findByRole('group', { name: 'Send R1 to Ava Rao' });
    expect(within(well).getByText(/valid for 72 hours and allows one retake/)).toBeInTheDocument();
    expect(within(well).getByText(/reserves 55 minutes/)).toBeInTheDocument();
    const attest = within(well).getByRole('checkbox', {
      name: 'I confirm this candidate is located in India.',
    });
    expect(attest).toHaveFocus();
    const create = within(well).getByRole('button', { name: 'Create link' });
    expect(create).toBeDisabled();
    await user.click(attest);
    expect(create).toBeEnabled();
    expect(api.sendR1Round).not.toHaveBeenCalled();
  });

  it('closes on Escape and on Cancel, returning focus to Send R1', async () => {
    const user = userEvent.setup();
    renderSection();
    await settled();
    await user.click(sendButton());
    await screen.findByRole('group', { name: /Send R1 to/ });
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('group', { name: /Send R1 to/ })).not.toBeInTheDocument();
    expect(sendButton()).toHaveFocus();

    await user.click(sendButton());
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('group', { name: /Send R1 to/ })).not.toBeInTheDocument();
    expect(sendButton()).toHaveFocus();
  });

  it('can be driven by keyboard alone', async () => {
    const user = userEvent.setup();
    renderSection();
    await settled();
    sendButton().focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('checkbox')).toHaveFocus();
    await user.keyboard(' ');
    await user.tab();
    expect(screen.getByRole('button', { name: 'Create link' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(await screen.findByLabelText('R1 link for the candidate')).toHaveFocus();
    expect(api.sendR1Round).toHaveBeenCalledWith('cand-1', { india_location_attested: true });
  });

  it('shows the link once, selected and focused, with the 72-hour warning', async () => {
    const user = userEvent.setup();
    renderSection();
    await settled();
    await user.click(sendButton());
    await user.click(await screen.findByRole('checkbox'));
    api.listR1Rounds.mockResolvedValue({ rounds: [round({ id: 'round-9' })] });
    await user.click(screen.getByRole('button', { name: 'Create link' }));

    expect(api.sendR1Round).toHaveBeenCalledTimes(1);
    expect(api.sendR1Round).toHaveBeenCalledWith('cand-1', { india_location_attested: true });
    const field = await screen.findByLabelText('R1 link for the candidate');
    expect(field).toHaveValue(LINK);
    expect(field).toHaveAttribute('readonly');
    expect(field).toHaveFocus();
    const group = screen.getByRole('group', { name: 'Candidate link' });
    expect(group).toHaveTextContent(/shown once/);
    expect(group).toHaveTextContent(/valid for 72 hours/);
    expect(screen.getByText('R1 link created. Copy it now: it is shown once.')).toBeInTheDocument();
    // The new round is read back, and Send R1 gives way to the round's actions.
    await waitFor(() => expect(api.listR1Rounds).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('button', { name: 'Send R1' })).not.toBeInTheDocument();
  });

  it('copies the link, and drops it for good once the person says they have it', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText');
    renderSection();
    await settled();
    await user.click(sendButton());
    await user.click(await screen.findByRole('checkbox'));
    api.listR1Rounds.mockResolvedValue({ rounds: [round({ id: 'round-9' })] });
    await user.click(screen.getByRole('button', { name: 'Create link' }));
    await screen.findByLabelText('R1 link for the candidate');

    await user.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(writeText).toHaveBeenCalledWith(LINK);
    expect(await screen.findByText('Link copied to the clipboard.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'I have copied the link' }));
    expect(screen.queryByLabelText('R1 link for the candidate')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue(LINK)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(LINK);
    // Focus lands on the card, not on a control that just vanished.
    expect(screen.getByRole('heading', { name: 'R1 interview' })).toHaveFocus();
  });

  it('says so, and keeps the link selected, when the clipboard is refused', async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    renderSection();
    await settled();
    await user.click(sendButton());
    await user.click(await screen.findByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Create link' }));
    await screen.findByLabelText('R1 link for the candidate');
    await user.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(await screen.findByText(/Copy failed/)).toBeInTheDocument();
    expect(screen.getByLabelText('R1 link for the candidate')).toHaveFocus();
  });

  it.each([
    ['r1_capacity_exhausted', /allowance is used up/],
    ['r1_paused', /R1 is paused/],
    ['phone_engagement_active', /phone screening is in progress or scheduled/],
    ['phone_assessment_pending', /still being scored/],
    ['decision_use_blocked', /Decision use is blocked/],
    ['candidate_ownership_conflict', /claimed this candidate/],
    ['Insufficient permissions', /Your role cannot do this/],
    ['something_new', /R1 could not be sent/],
  ])('explains a refusal of %s in words, never the raw code', async (code, words) => {
    api.sendR1Round.mockRejectedValue(new ApiError(code, 409));
    const user = userEvent.setup();
    renderSection();
    await settled();
    await user.click(sendButton());
    await user.click(await screen.findByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Create link' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(words);
    expect(alert).not.toHaveTextContent(code === 'something_new' ? 'something_new' : `${code}_`);
    expect(screen.queryByLabelText('R1 link for the candidate')).not.toBeInTheDocument();
  });

  it('re-reads availability when the refusal says the card was out of date', async () => {
    api.sendR1Round.mockRejectedValue(new ApiError('r1_capacity_exhausted', 409));
    const user = userEvent.setup();
    renderSection();
    await settled();
    await user.click(sendButton());
    await user.click(await screen.findByRole('checkbox'));
    api.getR1Availability.mockResolvedValue({ state: 'capacity_exhausted', hold_minutes: 55 });
    await user.click(screen.getByRole('button', { name: 'Create link' }));
    expect(await screen.findByText('This month’s R1 allowance is used up')).toBeInTheDocument();
    expect(sendButton()).toHaveAttribute('aria-disabled', 'true');
    // The confirmation for a send that cannot happen is gone.
    expect(screen.queryByRole('group', { name: /Send R1 to/ })).not.toBeInTheDocument();
  });

  it('reads the rounds again when another tab already sent one (round_active)', async () => {
    api.sendR1Round.mockRejectedValue(new ApiError('round_active', 409));
    const user = userEvent.setup();
    renderSection();
    await settled();
    await user.click(sendButton());
    await user.click(await screen.findByRole('checkbox'));
    api.listR1Rounds.mockResolvedValue({ rounds: [round()] });
    await user.click(screen.getByRole('button', { name: 'Create link' }));
    await waitFor(() => expect(api.listR1Rounds).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('list', { name: 'R1 rounds' })).toBeInTheDocument();
  });
});

describe('what Send R1 does beside existing rounds', () => {
  it('offers no Send beside a live round', async () => {
    api.listR1Rounds.mockResolvedValue({ rounds: [round({ status: 'in_progress' })] });
    renderSection();
    await screen.findByRole('list', { name: 'R1 rounds' });
    expect(screen.queryByRole('button', { name: 'Send R1' })).not.toBeInTheDocument();
  });

  it('offers a new Send after a round expired or was cancelled', async () => {
    api.listR1Rounds.mockResolvedValue({
      rounds: [round({ id: 'r-b', status: 'cancelled' }), round({ id: 'r-a', status: 'expired' })],
    });
    renderSection();
    await screen.findByRole('list', { name: 'R1 rounds' });
    expect(sendButton()).toBeEnabled();
  });

  it('does not offer a new Send once a round has completed, and says why', async () => {
    api.listR1Rounds.mockResolvedValue({
      rounds: [round({ status: 'completed', attempts_counted: 2 })],
    });
    renderSection();
    await screen.findByRole('list', { name: 'R1 rounds' });
    expect(screen.queryByRole('button', { name: 'Send R1' })).not.toBeInTheDocument();
    expect(screen.getByText(/has completed R1, so a new link cannot be sent/)).toBeInTheDocument();
  });

  describe('a round that ended without completing but counted an attempt (one retake)', () => {
    // A granted retake the candidate never took expires with attempts_counted 1, and a call
    // cancelled mid-way keeps its counted attempt. The server would accept a new round, so
    // Send would hand the candidate two fresh attempts: this card is the only guard.
    it.each(['expired', 'cancelled'] as const)(
      'offers no Send after a %s round that counted an attempt, and says why',
      async (status) => {
        api.listR1Rounds.mockResolvedValue({
          rounds: [round({ status, attempts_counted: 1 })],
        });
        renderSection('admin');
        await screen.findByRole('list', { name: 'R1 rounds' });
        expect(screen.queryByRole('button', { name: 'Send R1' })).not.toBeInTheDocument();
        expect(
          screen.getByText(/already used an R1 attempt, so a new link cannot be sent/),
        ).toBeInTheDocument();
      },
    );

    it.each(['expired', 'cancelled'] as const)(
      'still offers Send after a %s round that never counted an attempt',
      async (status) => {
        api.listR1Rounds.mockResolvedValue({
          rounds: [round({ status, attempts_counted: 0 })],
        });
        renderSection('admin');
        await screen.findByRole('list', { name: 'R1 rounds' });
        expect(sendButton()).toBeEnabled();
        expect(screen.queryByText(/already used an R1 attempt/)).not.toBeInTheDocument();
      },
    );

    it('offers no retake grant either (only a completed round can grant one)', async () => {
      api.listR1Rounds.mockResolvedValue({
        rounds: [round({ status: 'expired', attempts_counted: 1 })],
      });
      renderSection('admin');
      await screen.findByRole('list', { name: 'R1 rounds' });
      expect(screen.queryByRole('button', { name: 'Grant retake' })).not.toBeInTheDocument();
    });

    it('says nothing about it to a viewer, who has no Send to withhold', async () => {
      api.listR1Rounds.mockResolvedValue({
        rounds: [round({ status: 'expired', attempts_counted: 1 })],
      });
      renderSection('viewer');
      await screen.findByRole('list', { name: 'R1 rounds' });
      expect(screen.queryByText(/already used an R1 attempt/)).not.toBeInTheDocument();
    });
  });
});

describe('the rounds panel', () => {
  it('lists status, sent time, attempts and expiry', async () => {
    api.listR1Rounds.mockResolvedValue({ rounds: [round()] });
    renderSection();
    const list = await screen.findByRole('list', { name: 'R1 rounds' });
    const row = within(list).getByRole('listitem');
    expect(row).toHaveTextContent(/Sent .*2026/);
    expect(row).toHaveTextContent('Status: Link sent');
    expect(row).toHaveTextContent('0 of 2 attempts used');
    expect(row).toHaveTextContent(/Link valid until .*2026/);
  });

  it('shows a results placeholder until scoring has produced something', async () => {
    api.listR1Rounds.mockResolvedValue({
      rounds: [round({ status: 'completed', attempts_counted: 1 })],
    });
    renderSection();
    expect(
      await screen.findByText(/No results yet\. The scorecard and recommendation will appear here/),
    ).toBeInTheDocument();
  });

  it('shows the recommendation and score once the scorer has written them', async () => {
    api.listR1Rounds.mockResolvedValue({
      rounds: [
        round({ status: 'completed', attempts_counted: 1, recommendation: 'hold', overall: 58.5 }),
      ],
    });
    renderSection();
    expect(
      await screen.findByText('Recommendation: Hold · Overall 58.5 of 100'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/No results yet/)).not.toBeInTheDocument();
  });

  it('shows no results line for a round that never started', async () => {
    api.listR1Rounds.mockResolvedValue({ rounds: [round({ status: 'expired' })] });
    renderSection();
    await screen.findByRole('list', { name: 'R1 rounds' });
    expect(screen.queryByText(/No results yet/)).not.toBeInTheDocument();
  });

  it('orders rows as the API did, newest first', async () => {
    api.listR1Rounds.mockResolvedValue({
      rounds: [
        round({ id: 'new', status: 'invited', created_at: '2026-10-06T10:00:00.000Z' }),
        round({ id: 'old', status: 'expired', created_at: '2026-09-01T10:00:00.000Z' }),
      ],
    });
    renderSection();
    const list = await screen.findByRole('list', { name: 'R1 rounds' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Link sent');
    expect(rows[1]).toHaveTextContent('Expired');
  });
});

describe('reissue, cancel and grant retake', () => {
  it('reissues after a confirmation, showing the new link once', async () => {
    api.listR1Rounds.mockResolvedValue({ rounds: [round()] });
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole('button', { name: 'Reissue link' }));
    const well = await screen.findByRole('group', { name: 'Reissue the link?' });
    expect(well).toHaveFocus();
    expect(well).toHaveTextContent(/current link stops working immediately/);
    expect(api.reissueR1Round).not.toHaveBeenCalled();

    await user.click(within(well).getByRole('button', { name: 'Reissue link' }));
    expect(api.reissueR1Round).toHaveBeenCalledWith('round-1');
    const group = await screen.findByRole('group', { name: 'New candidate link' });
    expect(group).toHaveTextContent(/previous link has stopped working/);
    // The reissue answer carries no expiry, so it is read from the refreshed round.
    expect(group).toHaveTextContent(/valid for 72 hours \(until .*2026.*\)/);
    expect(screen.getByLabelText('R1 link for the candidate')).toHaveValue(LINK);
  });

  it('keeps the current link when the person backs out, and refocuses the opener', async () => {
    api.listR1Rounds.mockResolvedValue({ rounds: [round()] });
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole('button', { name: 'Reissue link' }));
    await user.click(await screen.findByRole('button', { name: 'Keep current link' }));
    expect(api.reissueR1Round).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Reissue link' })).toHaveFocus();
  });

  it('closes a confirmation on Escape and returns focus to the button that opened it', async () => {
    api.listR1Rounds.mockResolvedValue({ rounds: [round()] });
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole('button', { name: 'Cancel round' }));
    await screen.findByRole('group', { name: 'Cancel this R1 round?' });
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('group', { name: 'Cancel this R1 round?' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel round' })).toHaveFocus();
  });

  it('cancels after a confirmation, announces it, and re-reads both sources', async () => {
    api.listR1Rounds.mockResolvedValue({ rounds: [round()] });
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole('button', { name: 'Cancel round' }));
    const well = await screen.findByRole('group', { name: 'Cancel this R1 round?' });
    expect(well).toHaveTextContent(/reserved minutes are released/);
    expect(well).not.toHaveTextContent(/does not end a call/);
    api.listR1Rounds.mockResolvedValue({ rounds: [round({ status: 'cancelled' })] });
    await user.click(within(well).getByRole('button', { name: 'Cancel round' }));
    expect(api.cancelR1Round).toHaveBeenCalledWith('round-1');
    expect(
      await screen.findByText('R1 round cancelled. Its reserved minutes were released.'),
    ).toBeInTheDocument();
    await waitFor(() => expect(api.listR1Rounds).toHaveBeenCalledTimes(2));
    expect(api.getR1Availability).toHaveBeenCalledTimes(2);
    // A new round can be sent afterwards.
    expect(await screen.findByRole('button', { name: 'Send R1' })).toBeEnabled();
    expect(screen.getByRole('heading', { name: 'R1 interview' })).toHaveFocus();
  });

  it('warns that cancelling does not end a call that is already running', async () => {
    api.listR1Rounds.mockResolvedValue({ rounds: [round({ status: 'in_progress' })] });
    const user = userEvent.setup();
    renderSection();
    expect(screen.queryByRole('button', { name: 'Reissue link' })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Cancel round' }));
    expect(
      await screen.findByRole('group', { name: 'Cancel this R1 round?' }),
    ).toHaveTextContent(/does not end a call that is already running/);
  });

  it('offers the one retake only for a completed round with one counted attempt', async () => {
    api.listR1Rounds.mockResolvedValue({
      rounds: [round({ status: 'completed', attempts_counted: 1 })],
    });
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole('button', { name: 'Grant retake' }));
    const well = await screen.findByRole('group', { name: 'Grant the one retake?' });
    expect(well).toHaveTextContent(/original link again for 72 hours/);
    api.listR1Rounds.mockResolvedValue({
      rounds: [round({ status: 'invited', attempts_counted: 1 })],
    });
    await user.click(within(well).getByRole('button', { name: 'Grant retake' }));
    expect(api.grantR1Retake).toHaveBeenCalledWith('round-1');
    expect(await screen.findByText(/Retake granted\. The candidate’s original link works again/))
      .toBeInTheDocument();
  });

  it.each([
    ['status', round({ status: 'completed', attempts_counted: 2 })],
    ['attempt count', round({ status: 'completed', attempts_counted: 0 })],
    ['attempts allowed', round({ status: 'completed', attempts_counted: 1, attempts_allowed: 1 })],
    ['status', round({ status: 'expired', attempts_counted: 1 })],
  ])('offers no retake when the %s rules it out', async (_why, candidate) => {
    api.listR1Rounds.mockResolvedValue({ rounds: [candidate] });
    renderSection();
    await screen.findByRole('list', { name: 'R1 rounds' });
    expect(screen.queryByRole('button', { name: 'Grant retake' })).not.toBeInTheDocument();
  });

  it('explains a retake the server refuses and re-reads the round', async () => {
    api.listR1Rounds.mockResolvedValue({
      rounds: [round({ status: 'completed', attempts_counted: 1 })],
    });
    api.grantR1Retake.mockRejectedValue(new ApiError('retake_not_allowed', 409));
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole('button', { name: 'Grant retake' }));
    const well = await screen.findByRole('group', { name: 'Grant the one retake?' });
    await user.click(within(well).getByRole('button', { name: 'Grant retake' }));
    expect(await within(well).findByRole('alert')).toHaveTextContent(/retake can be granted once/);
    await waitFor(() => expect(api.listR1Rounds).toHaveBeenCalledTimes(2));
  });

  it('closes a confirmation whose action stopped being possible after a refresh', async () => {
    api.listR1Rounds.mockResolvedValue({ rounds: [round()] });
    api.cancelR1Round.mockRejectedValue(new ApiError('round_transition_conflict', 409));
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole('button', { name: 'Cancel round' }));
    const well = await screen.findByRole('group', { name: 'Cancel this R1 round?' });
    api.listR1Rounds.mockResolvedValue({ rounds: [round({ status: 'expired' })] });
    await user.click(within(well).getByRole('button', { name: 'Cancel round' }));
    await waitFor(() =>
      expect(
        screen.queryByRole('group', { name: 'Cancel this R1 round?' }),
      ).not.toBeInTheDocument(),
    );
  });

  describe('who is offered the actions (the API only lets the creator or an admin act)', () => {
    const THEIRS = 'someone-else';
    const rows = () => ({
      rounds: [
        round({ id: 'r-live', status: 'invited', created_by: THEIRS }),
        round({ id: 'r-done', status: 'completed', attempts_counted: 1, created_by: THEIRS }),
      ],
    });
    const ACTIONS = ['Reissue link', 'Cancel round', 'Grant retake'];

    it('hides every action from an interviewer on another person’s round', async () => {
      api.listR1Rounds.mockResolvedValue(rows());
      renderSection('interviewer', 'user-1');
      await screen.findByRole('list', { name: 'R1 rounds' });
      for (const name of ACTIONS) {
        expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
      }
    });

    it('still lists that round, read-only, with its status', async () => {
      api.listR1Rounds.mockResolvedValue(rows());
      renderSection('interviewer', 'user-1');
      const list = await screen.findByRole('list', { name: 'R1 rounds' });
      expect(within(list).getAllByRole('listitem')).toHaveLength(2);
      expect(within(list).getByText('Link sent')).toBeInTheDocument();
    });

    it('offers every action to an admin, on a round an interviewer created', async () => {
      api.listR1Rounds.mockResolvedValue(rows());
      renderSection('admin', 'admin-1');
      for (const name of ACTIONS) {
        expect(await screen.findByRole('button', { name })).toBeInTheDocument();
      }
    });

    it('offers the actions to the interviewer who created the round', async () => {
      api.listR1Rounds.mockResolvedValue({
        rounds: [round({ id: 'r-mine', created_by: 'user-1' })],
      });
      renderSection('interviewer', 'user-1');
      expect(await screen.findByRole('button', { name: 'Reissue link' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Cancel round' })).toBeInTheDocument();
    });

    it('offers nothing to an interviewer whose identity is not known', async () => {
      api.listR1Rounds.mockResolvedValue({ rounds: [round({ created_by: 'user-1' })] });
      renderSection('interviewer', null);
      await screen.findByRole('list', { name: 'R1 rounds' });
      expect(screen.queryByRole('button', { name: 'Cancel round' })).not.toBeInTheDocument();
    });
  });

  it('shows no actions to a viewer', async () => {
    api.listR1Rounds.mockResolvedValue({
      rounds: [round(), round({ id: 'r2', status: 'completed', attempts_counted: 1 })],
    });
    renderSection('viewer');
    await screen.findByRole('list', { name: 'R1 rounds' });
    for (const name of ['Reissue link', 'Cancel round', 'Grant retake', 'Send R1']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
  });
});

describe('failure and reload', () => {
  it('shows a retryable error when the rounds cannot be read', async () => {
    api.listR1Rounds.mockRejectedValueOnce(new ApiError('service_unavailable', 503));
    const user = userEvent.setup();
    renderSection();
    expect(await screen.findByRole('alert')).toHaveTextContent('R1 rounds could not be loaded.');
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No R1 round has been sent yet.')).toBeInTheDocument();
  });

  it('survives an API adapter that lacks the R1 endpoints (the page must stay up)', async () => {
    api.listR1Rounds.mockImplementation(() => {
      throw new TypeError('api.listR1Rounds is not a function');
    });
    renderSection();
    expect(await screen.findByRole('alert')).toHaveTextContent('R1 rounds could not be loaded.');
  });

  it('starts over when the candidate changes, dropping a link held for the last one', async () => {
    const user = userEvent.setup();
    const view = renderSection();
    await settled();
    await user.click(sendButton());
    await user.click(await screen.findByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Create link' }));
    await screen.findByLabelText('R1 link for the candidate');
    view.rerender(
      <MemoryRouter>
        <R1Section
          candidateId="cand-2"
          candidateName="Ben Iyer"
          role="interviewer"
          userId="user-1"
        />
      </MemoryRouter>,
    );
    await waitFor(() => expect(api.listR1Rounds).toHaveBeenCalledWith('cand-2'));
    await waitFor(() =>
      expect(screen.queryByLabelText('R1 link for the candidate')).not.toBeInTheDocument(),
    );
    expect(document.body.textContent).not.toContain(LINK);
  });
});

describe('accessibility', () => {
  it('has no axe violations when ready', async () => {
    const { container } = renderSection();
    await settled();
    await screen.findByText('No R1 round has been sent yet.');
    await expect(container).toHaveNoViolations();
  });

  it.each([
    ['disabled', 'R1 is switched off'],
    ['paused', 'R1 is paused'],
    ['capacity_exhausted', 'This month’s R1 allowance is used up'],
    ['role_not_configured', 'R1 is not set up yet'],
    ['config_invalid', 'R1 is off because of a configuration problem'],
  ])('has no axe violations in the %s state', async (state, title) => {
    api.getR1Availability.mockResolvedValue({ state, hold_minutes: 55 });
    const { container } = renderSection('admin');
    await screen.findByText(title);
    await expect(container).toHaveNoViolations();
  });

  it('has no axe violations with the send confirmation open', async () => {
    const user = userEvent.setup();
    const { container } = renderSection();
    await settled();
    await user.click(sendButton());
    await screen.findByRole('group', { name: /Send R1 to/ });
    await expect(container).toHaveNoViolations();
  });

  it('has no axe violations with the one-time link showing', async () => {
    const user = userEvent.setup();
    const { container } = renderSection();
    await settled();
    await user.click(sendButton());
    await user.click(await screen.findByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Create link' }));
    await screen.findByLabelText('R1 link for the candidate');
    await expect(container).toHaveNoViolations();
  });

  it('has no axe violations for a populated panel with a confirmation open', async () => {
    api.listR1Rounds.mockResolvedValue({
      rounds: [
        round({ id: 'a', status: 'completed', attempts_counted: 1 }),
        round({ id: 'b', status: 'expired', created_at: '2026-09-01T10:00:00.000Z' }),
      ],
    });
    const user = userEvent.setup();
    const { container } = renderSection();
    await user.click(await screen.findByRole('button', { name: 'Grant retake' }));
    await screen.findByRole('group', { name: 'Grant the one retake?' });
    await expect(container).toHaveNoViolations();
  });
});
