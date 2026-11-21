import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { anchorClock, type R1Clock } from '../../lib/r1/r1-clock';
import {
  R1_NO_PHASE_LABELS,
  R1_PHASES,
  R1_PHASE_LABELS,
  type R1Phase,
} from '../../lib/r1/r1-phase';
import { R1_MEET_TILE_COPY } from './r1-meet-copy';
import { R1_SCENARIO_COPY } from './r1-scenario';
import { R1MeetTile, type MeetStage } from './R1MeetTile';

const LEAD = 'Meera Iyer';

function renderTile(overrides: Partial<Parameters<typeof R1MeetTile>[0]> = {}) {
  const props = {
    stage: { name: 'live' } as MeetStage,
    phase: 'icebreaker' as R1Phase | null,
    agentPresent: true,
    leadName: LEAD as string | null,
    leadVisible: false,
    roleplayClock: null as R1Clock | null,
    ...overrides,
  };
  return render(<R1MeetTile {...props} />);
}

/** Every stage the page can be in, with the heading it must show. */
const STAGES: Array<[string, MeetStage, string]> = [
  ['idle without a ticket', { name: 'idle', reason: 'no_ticket' }, R1_MEET_TILE_COPY.idle.title],
  ['idle with the switch off', { name: 'idle', reason: 'disabled' }, R1_MEET_TILE_COPY.idle.title],
  ['connecting', { name: 'connecting', preparing: false }, R1_MEET_TILE_COPY.connecting.title],
  ['preparing', { name: 'connecting', preparing: true }, R1_MEET_TILE_COPY.connecting.title],
  ['live', { name: 'live' }, R1_MEET_TILE_COPY.live.title],
  ['ended by the agent', { name: 'ended', reason: 'agent_ended' }, R1_MEET_TILE_COPY.ended.agent_ended.title],
  ['aborted', { name: 'ended', reason: 'aborted' }, R1_MEET_TILE_COPY.ended.aborted.title],
  ['disconnected', { name: 'ended', reason: 'disconnected' }, R1_MEET_TILE_COPY.ended.disconnected.title],
  ['unavailable (claimed)', { name: 'unavailable', reason: 'claimed' }, R1_MEET_TILE_COPY.unavailable.title],
  ['unavailable (no audio)', { name: 'unavailable', reason: 'no_audio' }, R1_MEET_TILE_COPY.unavailable.title],
];

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

/** All the text the tile may ever show: its own copy, phase labels, the scenario card, the lead name. */
const ALLOWED = new Set<string>([
  ...strings(R1_MEET_TILE_COPY),
  ...Object.values(R1_PHASE_LABELS).map((copy) => copy.label),
  ...Object.values(R1_NO_PHASE_LABELS).map((copy) => copy.label),
  ...strings(R1_SCENARIO_COPY),
  LEAD,
]);

function textNodes(root: HTMLElement): string[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const found: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent?.trim() ?? '';
    if (text) found.push(text);
  }
  return found;
}

describe('every stage', () => {
  it.each(STAGES)('%s shows its heading and no control at all', async (_name, stage, title) => {
    const { container } = renderTile({ stage, leadVisible: true, roleplayClock: anchorClock(480, 0) });
    const heading = screen.getByRole('heading', { level: 1, name: title });
    expect(heading).toHaveAttribute('id', 'r1-meet-title');
    expect(screen.getByRole('region', { name: title })).toHaveAttribute('data-state', stage.name);
    expect(screen.getByText(R1_MEET_TILE_COPY.eyebrow)).toBeVisible();
    for (const role of ['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox'] as const) {
      expect(screen.queryAllByRole(role), role).toEqual([]);
    }
    expect(container.querySelectorAll('button, a, input, select, textarea, [tabindex]')).toHaveLength(0);
    await expect(container).toHaveNoViolations();
  });

  it.each(STAGES)('%s shows only the tile copy, phase labels and the scenario card', (_name, stage) => {
    for (const phase of [null, ...R1_PHASES]) {
      const { container, unmount } = renderTile({
        stage,
        phase,
        leadVisible: true,
        roleplayClock: anchorClock(480, 0),
      });
      for (const text of textNodes(container)) {
        if (/^Role-play · /.test(text)) continue;
        expect(ALLOWED.has(text), `unexpected text "${text}" (${stage.name}, ${phase})`).toBe(true);
      }
      unmount();
    }
  });

  it('carries the machine reason in data-reason only, never in the copy', () => {
    const cases: Array<[MeetStage, string | null]> = [
      [{ name: 'idle', reason: 'no_ticket' }, 'no_ticket'],
      [{ name: 'idle', reason: 'disabled' }, 'disabled'],
      [{ name: 'connecting', preparing: false }, null],
      [{ name: 'connecting', preparing: true }, 'preparing'],
      [{ name: 'live' }, null],
      [{ name: 'ended', reason: 'aborted' }, 'aborted'],
      [{ name: 'unavailable', reason: 'claimed' }, 'claimed'],
      [{ name: 'unavailable', reason: 'timeout' }, 'timeout'],
      [{ name: 'unavailable', reason: 'connect_failed' }, 'connect_failed'],
    ];
    for (const [stage, reason] of cases) {
      const { container, unmount } = renderTile({ stage });
      const root = container.querySelector('section.r1-meet-tile');
      if (reason === null) expect(root).not.toHaveAttribute('data-reason');
      else expect(root).toHaveAttribute('data-reason', reason);
      expect(container.textContent ?? '').not.toMatch(/no_ticket|disabled|claimed|timeout|connect_failed/);
      unmount();
    }
  });

  it('says the same thing for every failure', () => {
    const titles = new Set<string>();
    for (const reason of ['invalid', 'claimed', 'expired', 'unsupported', 'connect_failed'] as const) {
      const { unmount } = renderTile({ stage: { name: 'unavailable', reason } });
      titles.add(screen.getByRole('heading', { level: 1 }).textContent ?? '');
      expect(screen.getByText(R1_MEET_TILE_COPY.unavailable.body)).toBeVisible();
      unmount();
    }
    expect([...titles]).toEqual([R1_MEET_TILE_COPY.unavailable.title]);
  });

  it('gives each ending its own words', () => {
    for (const reason of ['agent_ended', 'aborted', 'disconnected'] as const) {
      const { unmount } = renderTile({ stage: { name: 'ended', reason } });
      const copy = R1_MEET_TILE_COPY.ended[reason];
      expect(screen.getByRole('heading', { level: 1, name: copy.title })).toBeVisible();
      expect(screen.getByText(copy.body)).toBeVisible();
      unmount();
    }
  });
});

describe('the live tile', () => {
  it('shows the phase LABEL in a polite, atomic status region, never its detail line', () => {
    for (const phase of R1_PHASES) {
      const { unmount } = renderTile({ phase });
      const panel = screen.getByRole('status');
      expect(panel).toHaveClass('r1-phase');
      expect(panel).toHaveAttribute('aria-live', 'polite');
      expect(panel).toHaveAttribute('aria-atomic', 'true');
      expect(panel).toHaveAttribute('data-phase', phase);
      expect(panel).toHaveTextContent(R1_PHASE_LABELS[phase].label);
      expect(screen.queryByText(R1_PHASE_LABELS[phase].detail)).toBeNull();
      unmount();
    }
  });

  it('says connecting until an interviewer joins, then in progress until it names a phase', () => {
    const { rerender } = renderTile({ phase: null, agentPresent: false });
    expect(screen.getByRole('status')).toHaveTextContent(R1_NO_PHASE_LABELS.waiting.label);
    expect(screen.getByRole('status')).toHaveAttribute('data-phase', 'none');
    expect(screen.queryByText(R1_NO_PHASE_LABELS.waiting.detail)).toBeNull();
    rerender(
      <R1MeetTile
        stage={{ name: 'live' }}
        phase={null}
        agentPresent
        leadName={null}
        leadVisible={false}
        roleplayClock={null}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(R1_NO_PHASE_LABELS.inProgress.label);
    expect(screen.getByRole('status')).toHaveAttribute('data-phase', 'unannounced');
  });

  it('shows the scenario card and the role-play clock only while the lead card is visible', () => {
    const clock = anchorClock(480, performance.now());
    const { unmount } = renderTile({ phase: 'icebreaker', leadVisible: false, roleplayClock: clock });
    expect(screen.queryByRole('heading', { name: R1_SCENARIO_COPY.heading })).toBeNull();
    expect(screen.queryByRole('timer')).toBeNull();
    unmount();

    renderTile({ phase: 'transition', leadVisible: true, roleplayClock: clock });
    const card = screen.getByRole('region', { name: R1_SCENARIO_COPY.heading });
    expect(within(card).getByText(LEAD)).toBeVisible();
    expect(within(card).getByText(R1_SCENARIO_COPY.price)).toBeVisible();
    // The briefing shows the whole card.
    expect(within(card).getByText(R1_SCENARIO_COPY.intro)).toBeVisible();
    expect(screen.getByRole('timer')).toHaveTextContent('Role-play · 8 min left');
    // The clock sits outside the phase region, so it never re-announces the panel.
    expect(screen.getByRole('timer').closest('[aria-live]')).toBeNull();
  });

  it('shrinks the card to the facts strip once the role-play is on', () => {
    renderTile({ phase: 'roleplay', leadVisible: true, roleplayClock: null });
    const card = screen.getByRole('region', { name: R1_SCENARIO_COPY.heading });
    expect(card).toHaveClass('r1-scenario--compact');
    expect(within(card).queryByText(R1_SCENARIO_COPY.intro)).toBeNull();
    // No clock published: no timer, the card still shows.
    expect(screen.queryByRole('timer')).toBeNull();
  });

  it('names the learner only as the interviewer published it', () => {
    renderTile({ phase: 'transition', leadVisible: true, leadName: null });
    expect(screen.getByText(R1_SCENARIO_COPY.unnamedLearner)).toBeVisible();
  });

  it('passes axe with the briefing card and the clock on screen', async () => {
    const { container } = renderTile({
      phase: 'transition',
      leadVisible: true,
      roleplayClock: anchorClock(480, performance.now()),
    });
    await expect(container).toHaveNoViolations();
  });
});

describe('outside the room', () => {
  it('shows no phase, clock or scenario card, whatever the interviewer last said', () => {
    for (const [, stage] of STAGES.filter(([, stage]) => stage.name !== 'live')) {
      const { unmount } = renderTile({
        stage,
        phase: 'roleplay',
        leadVisible: true,
        roleplayClock: anchorClock(480, 0),
      });
      expect(screen.queryByRole('status')).toBeNull();
      expect(screen.queryByRole('timer')).toBeNull();
      expect(screen.queryByRole('heading', { name: R1_SCENARIO_COPY.heading })).toBeNull();
      unmount();
    }
  });
});
