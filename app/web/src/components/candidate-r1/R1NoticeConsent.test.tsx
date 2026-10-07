import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { R1ConsentTemplate } from '../../lib/r1/r1-api';
import { R1NoticeConsent } from './R1NoticeConsent';

const TEMPLATE: R1ConsentTemplate = {
  version: 'r1-2026-10',
  locale: 'en-IN',
  title: 'Notice and consent for your AI interview',
  body_md: [
    '# What we collect',
    'Camera video, voice, transcript, scores, device and IP address.',
    '',
    '# Who processes it',
    '- Sarvam AI (speech)',
    '- DeepSeek (language model, People’s Republic of China)',
    '',
    '<script>window.__pwned = true</script>',
    'Withdraw any time: [withdraw link](https://example.test/withdraw)',
  ].join('\n'),
  required_consents: ['ai_interview', 'video_audio_recording', 'ai_evaluation', 'data_processing'],
  consent_items: [],
};

function renderNotice(overrides: Partial<Parameters<typeof R1NoticeConsent>[0]> = {}) {
  const props = {
    template: TEMPLATE,
    roleTitle: 'Sales Program Advisor',
    facts: ['About 20 minutes with an AI interviewer'],
    busy: false,
    error: null,
    onGrant: vi.fn(),
    onDecline: vi.fn(),
    ...overrides,
  };
  const view = render(
    <MemoryRouter>
      <R1NoticeConsent {...props} />
    </MemoryRouter>,
  );
  return { ...view, props };
}

describe('R1NoticeConsent', () => {
  it('shows the template title, the role and the format facts', () => {
    renderNotice();
    expect(
      screen.getByRole('heading', { level: 1, name: 'Notice and consent for your AI interview' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Interview for Sales Program Advisor')).toBeInTheDocument();
    const facts = screen.getByRole('list', { name: 'What to expect' });
    expect(within(facts).getByText('About 20 minutes with an AI interviewer')).toBeInTheDocument();
  });

  it('shows the whole notice as structured plain text in a focusable region', () => {
    renderNotice();
    const region = screen.getByRole('region', { name: 'Full notice' });
    expect(region).toHaveAttribute('tabindex', '0');
    const headings = within(region).getAllByRole('heading', { level: 2 });
    expect(headings.map((node) => node.textContent)).toEqual([
      'What we collect',
      'Who processes it',
    ]);
    expect(within(region).getAllByRole('listitem')).toHaveLength(2);
    expect(within(region).getByText(/DeepSeek/)).toBeInTheDocument();
  });

  it('never executes or renders markup from the template', () => {
    renderNotice();
    const region = screen.getByRole('region', { name: 'Full notice' });
    expect(region.querySelector('script')).toBeNull();
    expect(region.querySelector('a')).toBeNull();
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
    expect(region).toHaveTextContent('withdraw link (https://example.test/withdraw)');
  });

  it('offers each purpose as its own checkbox, with no select-all', () => {
    renderNotice();
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(4);
    expect(screen.getByRole('group', { name: /agree to each purpose separately/i })).toBeVisible();
    expect(screen.getByLabelText(/AI interviewer, including a sales role-play/)).toBeVisible();
    expect(screen.getByLabelText(/camera video and voice being recorded/)).toBeVisible();
    expect(screen.getByLabelText(/AI evaluation of my interview/)).toBeVisible();
    expect(screen.getByLabelText(/DeepSeek in the People's Republic of China/)).toBeVisible();
    expect(screen.queryByText(/select all/i)).toBeNull();
  });

  it('uses the template label for a purpose when it has one', () => {
    renderNotice({
      template: {
        ...TEMPLATE,
        required_consents: ['video_audio_recording'],
        consent_items: [
          { type: 'video_audio_recording', label: 'I allow IK to record my interview.' },
        ],
      },
    });
    expect(screen.getByLabelText('I allow IK to record my interview.')).toBeVisible();
  });

  it('enables agreeing only once every purpose is ticked, then grants all of them', async () => {
    const user = userEvent.setup();
    const { props } = renderNotice();
    const agree = screen.getByRole('button', { name: 'I agree and continue' });
    expect(agree).toBeDisabled();

    const boxes = screen.getAllByRole('checkbox');
    await user.click(boxes[0]);
    await user.click(boxes[1]);
    expect(agree).toBeDisabled();
    await user.click(boxes[2]);
    expect(agree).toBeDisabled();
    await user.click(boxes[3]);
    expect(agree).toBeEnabled();

    await user.click(agree);
    expect(props.onGrant).toHaveBeenCalledWith([
      'ai_interview',
      'video_audio_recording',
      'ai_evaluation',
      'data_processing',
    ]);
  });

  it('un-ticking a purpose disables agreeing again', async () => {
    const user = userEvent.setup();
    renderNotice();
    const boxes = screen.getAllByRole('checkbox');
    for (const box of boxes) await user.click(box);
    expect(screen.getByRole('button', { name: 'I agree and continue' })).toBeEnabled();
    await user.click(boxes[1]);
    expect(screen.getByRole('button', { name: 'I agree and continue' })).toBeDisabled();
  });

  it('lets the candidate decline without ticking anything', async () => {
    const user = userEvent.setup();
    const { props } = renderNotice();
    await user.click(screen.getByRole('button', { name: 'I do not agree' }));
    expect(props.onDecline).toHaveBeenCalledTimes(1);
    expect(props.onGrant).not.toHaveBeenCalled();
  });

  it('freezes the choices while a request is in flight', () => {
    renderNotice({ busy: true });
    for (const box of screen.getAllByRole('checkbox')) expect(box).toBeDisabled();
    expect(screen.getByRole('button', { name: 'I do not agree' })).toBeDisabled();
  });

  it('announces a failure and links the privacy notice', () => {
    renderNotice({ error: 'We could not record your choice. Please try again.' });
    expect(screen.getByRole('alert')).toHaveTextContent('We could not record your choice');
    expect(screen.getByRole('link', { name: 'Review the privacy notice' })).toHaveAttribute(
      'href',
      '/privacy-notice',
    );
  });

  it('has no accessibility violations', async () => {
    const { container } = renderNotice({ error: 'Something went wrong' });
    await expect(container).toHaveNoViolations();
  });
});
