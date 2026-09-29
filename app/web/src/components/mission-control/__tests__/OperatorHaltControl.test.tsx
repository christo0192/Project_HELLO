/**
 * OperatorHaltControl — the global operator halt in the Mission Control
 * header.
 *
 * Covers: the neutral loading state; every "unavailable" cause (failed read,
 * phone lane disabled, backlog unreadable, missing control row) with Retry and
 * NEITHER colour; red when live; green only for `operator_pause`; no action
 * for the four incident reasons; the confirmed halt and resume flows (right
 * endpoint, right reason, re-read, polite announcement, focus); Cancel and
 * Escape doing nothing; the in-flight lock; the 409 "changed elsewhere" path;
 * plain-English error copy with no raw codes; the admin-only render; and a
 * drift guard tying the reason labels to the API's published vocabulary.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { missionApi, apiFns } from './apiMock';
import { OperatorHaltControl } from '../OperatorHaltControl';
import {
  HALT_REASON_LABELS,
  haltFailureMessage,
  haltViewFrom,
  isHaltConflict,
} from '../operatorHalt';

vi.mock('../../../api', () => ({
  api: missionApi.api,
  ApiError: missionApi.ApiError,
}));

const auth = vi.hoisted(() => ({ role: 'admin' as 'admin' | 'interviewer' | 'viewer' | null }));
vi.mock('../../../lib/auth', () => ({
  useAuth: () => ({ role: auth.role }),
}));

const { ApiError } = missionApi;

// ── Fixtures: `GET /api/phone/health`, trimmed to what the control reads ──

type Admission = { control_present: boolean; halted: boolean; halt_reason: string | null };

function health(admission: Admission | null, overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    enabled: true,
    status: admission?.halted ? ('degraded' as const) : ('ok' as const),
    reasons: admission?.halted ? ['admission_halted'] : [],
    admission,
    ...overrides,
  };
}

const LIVE = health({ control_present: true, halted: false, halt_reason: null });
const PAUSED = health({ control_present: true, halted: true, halt_reason: 'operator_pause' });
const haltedFor = (reason: string | null) =>
  health({ control_present: true, halted: true, halt_reason: reason });
/** Phone screening switched off: the route answers 200 with admission null. */
const DISABLED = health(null, {
  enabled: false,
  status: 'disabled',
  reasons: ['phone_screening_disabled'],
});
/** Backlog unreadable: enabled, but admission null. */
const DEGRADED = health(null, { status: 'degraded', reasons: ['backlog_unavailable'] });
/** A missing control singleton: reported HALTED by the API, with no real reason. */
const NO_CONTROL = health(
  { control_present: false, halted: true, halt_reason: 'halt_unreadable' },
  { reasons: ['halt_unreadable', 'admission_halted'] },
);

function deferred<T>() {
  let resolveFn!: (value: T) => void;
  let rejectFn!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });
  return { promise, resolve: resolveFn, reject: rejectFn };
}

const liveRegion = () => {
  const region = document.querySelector('[data-operator-halt] [aria-live="polite"]');
  expect(region).not.toBeNull();
  return region as HTMLElement;
};

/** Any button painted with the danger (red) or success (green) fill. */
const colouredButtons = () =>
  Array.from(document.querySelectorAll('button')).filter(
    (b) => b.classList.contains('bg-error') || b.classList.contains('bg-success-text'),
  );

beforeEach(() => {
  vi.clearAllMocks();
  auth.role = 'admin';
  apiFns.getPhoneHealth.mockResolvedValue(LIVE);
  apiFns.setPhoneHalt.mockResolvedValue({
    ok: true,
    halted: true,
    already_halted: false,
    reason: 'operator_pause',
  });
  apiFns.clearPhoneHalt.mockResolvedValue({
    ok: true,
    halted: false,
    was_halted: true,
    previous_reason: 'operator_pause',
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  Reading the switch
// ═══════════════════════════════════════════════════════════════════════

describe('reading the switch', () => {
  it('shows a neutral, non-interactive "Checking calling status…" while loading', () => {
    apiFns.getPhoneHealth.mockReturnValue(new Promise(() => {}));
    render(<OperatorHaltControl />);

    expect(screen.getByText('Checking calling status…')).toBeInTheDocument();
    expect(screen.queryAllByRole('button')).toEqual([]);
    expect(screen.queryByText(/Calling is (live|halted)/)).toBeNull();
    expect(colouredButtons()).toEqual([]);
  });

  it.each([
    ['the read fails', () => apiFns.getPhoneHealth.mockRejectedValue(new ApiError('phone_read_error', 500)), 'The calling status could not be read.'],
    ['the server cannot be reached', () => apiFns.getPhoneHealth.mockRejectedValue(new ApiError('Could not reach the server.', 0)), 'The server could not be reached.'],
    ['phone screening is disabled (admission null)', () => apiFns.getPhoneHealth.mockResolvedValue(DISABLED), 'Phone screening is turned off.'],
    ['the backlog is unreadable (admission null)', () => apiFns.getPhoneHealth.mockResolvedValue(DEGRADED), 'The halt switch could not be read.'],
    ['the control row is missing (control_present false)', () => apiFns.getPhoneHealth.mockResolvedValue(NO_CONTROL), 'The halt switch could not be read.'],
  ])('is "Calling status unavailable" — never red or green — when %s', async (_label, arrange, detail) => {
    arrange();
    render(<OperatorHaltControl />);

    expect(await screen.findByText('Calling status unavailable')).toBeInTheDocument();
    expect(screen.getByText(detail)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Halt all calling' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Resume calling' })).toBeNull();
    expect(colouredButtons()).toEqual([]);
    expect(screen.queryByText(/Calling is (live|halted)/)).toBeNull();
  });

  it('re-reads on Retry, through the loading state, and then shows the real state', async () => {
    const user = userEvent.setup();
    apiFns.getPhoneHealth.mockRejectedValueOnce(new ApiError('phone_read_error', 500));
    const second = deferred<typeof LIVE>();
    apiFns.getPhoneHealth.mockReturnValueOnce(second.promise);
    render(<OperatorHaltControl />);

    await user.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(screen.getByText('Checking calling status…')).toBeInTheDocument();
    second.resolve(LIVE);

    expect(await screen.findByRole('button', { name: 'Halt all calling' })).toBeInTheDocument();
    expect(apiFns.getPhoneHealth).toHaveBeenCalledTimes(2);
    expect(apiFns.setPhoneHalt).not.toHaveBeenCalled();
  });

  it('is RED "Halt all calling" when calling is live, with the state in text beside it', async () => {
    render(<OperatorHaltControl />);
    const button = await screen.findByRole('button', { name: 'Halt all calling' });

    expect(button).toHaveClass('bg-error', 'text-white');
    expect(button).not.toHaveClass('bg-success-text');
    expect(button).toHaveAttribute('aria-haspopup', 'dialog');
    expect(screen.getByText('Calling is live')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resume calling' })).toBeNull();
  });

  it('is GREEN "Resume calling" when halted by an operator pause, with the state in text', async () => {
    apiFns.getPhoneHealth.mockResolvedValue(PAUSED);
    render(<OperatorHaltControl />);
    const button = await screen.findByRole('button', { name: 'Resume calling' });

    expect(button).toHaveClass('bg-success-text', 'text-white');
    expect(button).not.toHaveClass('bg-error');
    expect(screen.getByText('Calling is halted')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Halt all calling' })).toBeNull();
  });

  it.each([
    ['emergency_stop', 'emergency stop'],
    ['legal_hold', 'legal hold'],
    ['cost_control', 'cost control'],
    ['provider_incident', 'provider incident'],
  ])('offers NO action when halted for %s — status and runbook only', async (reason, label) => {
    apiFns.getPhoneHealth.mockResolvedValue(haltedFor(reason));
    render(<OperatorHaltControl />);

    expect(await screen.findByText(`Calling halted — ${label}`)).toBeInTheDocument();
    expect(screen.getByText(/can only be cleared through the phone halt runbook/)).toBeInTheDocument();
    expect(screen.queryAllByRole('button')).toEqual([]);
    expect(screen.queryByText(reason)).toBeNull();
  });

  it('describes an unrecognised halt reason as such, and still offers no action', async () => {
    apiFns.getPhoneHealth.mockResolvedValue(haltedFor('constructor'));
    render(<OperatorHaltControl />);
    expect(await screen.findByText('Calling halted — unrecognised reason')).toBeInTheDocument();
    expect(screen.queryAllByRole('button')).toEqual([]);
  });

  it('renders nothing, and reads nothing, for a non-admin', () => {
    auth.role = 'interviewer';
    const { container } = render(<OperatorHaltControl />);
    expect(container).toBeEmptyDOMElement();
    expect(apiFns.getPhoneHealth).not.toHaveBeenCalled();
  });

  it('mounts the polite live region before anything is announced', async () => {
    render(<OperatorHaltControl />);
    await screen.findByRole('button', { name: 'Halt all calling' });
    expect(liveRegion()).toHaveAttribute('role', 'status');
    expect(liveRegion()).toBeEmptyDOMElement();
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  Halting and resuming
// ═══════════════════════════════════════════════════════════════════════

describe('halting', () => {
  it('confirms first, then sends operator_pause, re-reads, announces, and hands focus to Resume', async () => {
    const user = userEvent.setup();
    apiFns.getPhoneHealth.mockResolvedValueOnce(LIVE).mockResolvedValueOnce(PAUSED);
    render(<OperatorHaltControl />);

    await user.click(await screen.findByRole('button', { name: 'Halt all calling' }));
    const dialog = screen.getByRole('dialog', { name: 'Halt all calling?' });
    // Opening the dialog writes nothing.
    expect(apiFns.setPhoneHalt).not.toHaveBeenCalled();

    // The copy is truthful about what a halt does and does not stop.
    expect(dialog).toHaveAccessibleDescription('No new calls will start until an admin resumes calling.');
    expect(within(dialog).getByText(/no first calls, retries, reconnects or scheduled calls will start/)).toBeInTheDocument();
    expect(within(dialog).getByText('Calls already in progress are not cut off. They carry on until they end.')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Yes, halt all calling' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(apiFns.setPhoneHalt).toHaveBeenCalledTimes(1);
    expect(apiFns.setPhoneHalt).toHaveBeenCalledWith({ reason: 'operator_pause' });
    expect(apiFns.clearPhoneHalt).not.toHaveBeenCalled();
    // Re-read AFTER the write, not before.
    expect(apiFns.getPhoneHealth).toHaveBeenCalledTimes(2);
    expect(apiFns.setPhoneHalt.mock.invocationCallOrder[0]).toBeLessThan(
      apiFns.getPhoneHealth.mock.invocationCallOrder[1],
    );

    const resume = screen.getByRole('button', { name: 'Resume calling' });
    expect(screen.getByText('Calling is halted')).toBeInTheDocument();
    expect(liveRegion()).toHaveTextContent('Calling halted.');
    await waitFor(() => expect(resume).toHaveFocus());
  });

  it('says so when a halt was already in force', async () => {
    const user = userEvent.setup();
    apiFns.getPhoneHealth.mockResolvedValueOnce(LIVE).mockResolvedValueOnce(PAUSED);
    apiFns.setPhoneHalt.mockResolvedValue({ ok: true, halted: true, already_halted: true, reason: 'operator_pause' });
    render(<OperatorHaltControl />);

    await user.click(await screen.findByRole('button', { name: 'Halt all calling' }));
    await user.click(screen.getByRole('button', { name: 'Yes, halt all calling' }));
    await waitFor(() => expect(liveRegion()).toHaveTextContent('Calling was already halted.'));
  });

  it('Cancel closes the dialog, writes nothing, re-reads nothing, and returns focus', async () => {
    const user = userEvent.setup();
    render(<OperatorHaltControl />);
    const trigger = await screen.findByRole('button', { name: 'Halt all calling' });

    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(apiFns.setPhoneHalt).not.toHaveBeenCalled();
    expect(apiFns.clearPhoneHalt).not.toHaveBeenCalled();
    expect(apiFns.getPhoneHealth).toHaveBeenCalledTimes(1);
    expect(liveRegion()).toBeEmptyDOMElement();
    expect(screen.getByRole('button', { name: 'Halt all calling' })).toHaveClass('bg-error');
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('Escape closes the dialog without writing', async () => {
    const user = userEvent.setup();
    render(<OperatorHaltControl />);
    await user.click(await screen.findByRole('button', { name: 'Halt all calling' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(apiFns.setPhoneHalt).not.toHaveBeenCalled();
  });

  it('locks every control while the request is in flight, and sends it once', async () => {
    const user = userEvent.setup();
    const pending = deferred<unknown>();
    apiFns.setPhoneHalt.mockReturnValue(pending.promise);
    apiFns.getPhoneHealth.mockResolvedValueOnce(LIVE).mockResolvedValueOnce(PAUSED);
    render(<OperatorHaltControl />);

    await user.click(await screen.findByRole('button', { name: 'Halt all calling' }));
    await user.click(screen.getByRole('button', { name: 'Yes, halt all calling' }));

    const dialog = screen.getByRole('dialog', { name: 'Halt all calling?' });
    const confirm = within(dialog).getByRole('button', { name: 'Halting…' });
    expect(confirm).toBeDisabled();
    expect(confirm).toHaveAttribute('aria-busy', 'true');
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeDisabled();
    // The trigger behind the dialog is locked too.
    const trigger = document.querySelector('[data-halt-action="halt"]') as HTMLButtonElement;
    expect(trigger).toBeDisabled();

    // Neither Escape nor a second press gets through.
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'Halt all calling?' })).toBeInTheDocument();
    await user.click(confirm);
    expect(apiFns.setPhoneHalt).toHaveBeenCalledTimes(1);

    pending.resolve({ ok: true, halted: true, already_halted: false, reason: 'operator_pause' });
    expect(await screen.findByRole('button', { name: 'Resume calling' })).toBeEnabled();
    expect(apiFns.setPhoneHalt).toHaveBeenCalledTimes(1);
  });

  it('re-reads after a failed halt, because an audit failure leaves the halt in force', async () => {
    const user = userEvent.setup();
    apiFns.getPhoneHealth.mockResolvedValueOnce(LIVE).mockResolvedValueOnce(PAUSED);
    apiFns.setPhoneHalt.mockRejectedValue(new ApiError('phone_audit_write_failed', 500));
    render(<OperatorHaltControl />);

    await user.click(await screen.findByRole('button', { name: 'Halt all calling' }));
    await user.click(screen.getByRole('button', { name: 'Yes, halt all calling' }));

    await waitFor(() =>
      expect(liveRegion()).toHaveTextContent(
        'Calling may have been halted, but the change could not be recorded in the audit log. Check the status shown here before trying again.',
      ),
    );
    expect(liveRegion()).toHaveClass('text-error-text');
    // The page shows what the server now has — halted — not what was hoped.
    expect(screen.getByRole('button', { name: 'Resume calling' })).toBeInTheDocument();
    expect(apiFns.getPhoneHealth).toHaveBeenCalledTimes(2);
    expect(document.body).not.toHaveTextContent('phone_audit_write_failed');
  });
});

describe('resuming', () => {
  it('confirms first, then sends the CURRENT reason to /halt/clear, re-reads and announces', async () => {
    const user = userEvent.setup();
    apiFns.getPhoneHealth.mockResolvedValueOnce(PAUSED).mockResolvedValueOnce(LIVE);
    render(<OperatorHaltControl />);

    await user.click(await screen.findByRole('button', { name: 'Resume calling' }));
    const dialog = screen.getByRole('dialog', { name: 'Resume calling?' });
    expect(apiFns.clearPhoneHalt).not.toHaveBeenCalled();
    expect(
      within(dialog).getByText(/Every eligible candidate may be dialled as soon as the scheduler next runs/),
    ).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Yes, resume calling' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(apiFns.clearPhoneHalt).toHaveBeenCalledTimes(1);
    expect(apiFns.clearPhoneHalt).toHaveBeenCalledWith({ reason: 'operator_pause' });
    expect(apiFns.setPhoneHalt).not.toHaveBeenCalled();
    expect(apiFns.getPhoneHealth).toHaveBeenCalledTimes(2);

    const halt = screen.getByRole('button', { name: 'Halt all calling' });
    expect(halt).toHaveClass('bg-error');
    expect(screen.getByText('Calling is live')).toBeInTheDocument();
    expect(liveRegion()).toHaveTextContent('Calling resumed.');
    await waitFor(() => expect(halt).toHaveFocus());
  });

  it('Cancel on the resume dialog does nothing', async () => {
    const user = userEvent.setup();
    apiFns.getPhoneHealth.mockResolvedValue(PAUSED);
    render(<OperatorHaltControl />);

    await user.click(await screen.findByRole('button', { name: 'Resume calling' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(apiFns.clearPhoneHalt).not.toHaveBeenCalled();
    expect(apiFns.getPhoneHealth).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Resume calling' })).toBeInTheDocument();
  });

  it('on 409 halt_reason_mismatch re-reads and says the status changed elsewhere', async () => {
    const user = userEvent.setup();
    // Between the read and the press, someone else swapped the pause for an
    // emergency stop.
    apiFns.getPhoneHealth
      .mockResolvedValueOnce(PAUSED)
      .mockResolvedValueOnce(haltedFor('emergency_stop'));
    apiFns.clearPhoneHalt.mockRejectedValue(new ApiError('halt_reason_mismatch', 409));
    render(<OperatorHaltControl />);

    await user.click(await screen.findByRole('button', { name: 'Resume calling' }));
    await user.click(screen.getByRole('button', { name: 'Yes, resume calling' }));

    await waitFor(() =>
      expect(liveRegion()).toHaveTextContent(
        'The calling status was changed elsewhere, so your change was not applied. Check the status shown here before trying again.',
      ),
    );
    expect(apiFns.getPhoneHealth).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Calling halted — emergency stop')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resume calling' })).toBeNull();
    expect(document.body).not.toHaveTextContent('halt_reason_mismatch');
  });

  it('lands on "unavailable" (not a guess) when the re-read after an action fails', async () => {
    const user = userEvent.setup();
    apiFns.getPhoneHealth
      .mockResolvedValueOnce(PAUSED)
      .mockRejectedValueOnce(new ApiError('Could not reach the server.', 0));
    render(<OperatorHaltControl />);

    await user.click(await screen.findByRole('button', { name: 'Resume calling' }));
    await user.click(screen.getByRole('button', { name: 'Yes, resume calling' }));

    expect(await screen.findByText('Calling status unavailable')).toBeInTheDocument();
    expect(liveRegion()).toHaveTextContent('Calling resumed.');
    expect(colouredButtons()).toEqual([]);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toHaveFocus());
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  The rules, without a DOM
// ═══════════════════════════════════════════════════════════════════════

describe('haltViewFrom', () => {
  it('maps each health shape to exactly one view', () => {
    expect(haltViewFrom(LIVE)).toEqual({ kind: 'live' });
    expect(haltViewFrom(PAUSED)).toEqual({ kind: 'paused' });
    expect(haltViewFrom(haltedFor('legal_hold'))).toEqual({ kind: 'locked', reason: 'legal_hold' });
    expect(haltViewFrom(haltedFor(null))).toEqual({ kind: 'locked', reason: null });
    expect(haltViewFrom(DISABLED).kind).toBe('unavailable');
    expect(haltViewFrom(DEGRADED).kind).toBe('unavailable');
    // Halted TRUE with no control row is a fail-closed read, not a pause.
    expect(haltViewFrom(NO_CONTROL).kind).toBe('unavailable');
    expect(
      haltViewFrom(health({ control_present: false, halted: true, halt_reason: 'operator_pause' })).kind,
    ).toBe('unavailable');
  });
});

describe('haltFailureMessage', () => {
  const cases: Array<[string, number, 'halt' | 'resume', string]> = [
    ['halt_reason_mismatch', 409, 'resume', 'The calling status was changed elsewhere, so your change was not applied. Check the status shown here before trying again.'],
    ['something_new', 409, 'resume', 'The calling status was changed elsewhere, so your change was not applied. Check the status shown here before trying again.'],
    ['invalid_reason', 409, 'halt', 'The server refused this halt reason, so nothing was changed. Report this to the engineering team.'],
    ['phone_screening_disabled', 503, 'halt', 'Phone screening is turned off, so calling cannot be halted or resumed from here.'],
    ['halt_state_unavailable', 503, 'resume', 'The halt switch could not be read, so calling was not resumed. Try again shortly.'],
    ['halt_unreadable', 503, 'resume', 'The halt switch could not be read, so calling was not resumed. Try again shortly.'],
    ['phone_audit_write_failed', 500, 'halt', 'Calling may have been halted, but the change could not be recorded in the audit log. Check the status shown here before trying again.'],
    ['phone_audit_write_failed', 500, 'resume', 'The change could not be recorded in the audit log, so the server tried to put the halt back. Check the status shown here before trying again.'],
    ['phone_rpc_unknown_status', 500, 'halt', 'The system did not get a clear answer about whether the change was applied. Check the status shown here before trying again.'],
    ['phone_action_error', 500, 'resume', 'The change could not be completed. Check the status shown here before trying again.'],
    ['anything', 429, 'halt', 'Too many requests in a short time. Wait a moment and try again.'],
    ['forbidden', 403, 'resume', 'Your role does not allow changing the calling status.'],
    ['Could not reach the server.', 0, 'halt', 'The server could not be reached, so the change may not have been sent. Check the status shown here before trying again.'],
    ['unmapped_code', 500, 'halt', 'Calling could not be halted. Check the status shown here before trying again.'],
    ['unmapped_code', 500, 'resume', 'Calling could not be resumed. Check the status shown here before trying again.'],
  ];

  it.each(cases)('maps %s (%i, %s) to plain English', (code, status, action, expected) => {
    const message = haltFailureMessage(new ApiError(code, status), action);
    expect(message).toBe(expected);
    // Never a raw snake_case code.
    expect(message).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
  });

  it('treats a non-ApiError as the generic failure for the action', () => {
    expect(haltFailureMessage(new Error('boom'), 'halt')).toBe(
      'Calling could not be halted. Check the status shown here before trying again.',
    );
  });

  it('counts every 409 as a conflict except invalid_reason', () => {
    expect(isHaltConflict(new ApiError('halt_reason_mismatch', 409))).toBe(true);
    expect(isHaltConflict(new ApiError('invalid_reason', 409))).toBe(false);
    expect(isHaltConflict(new ApiError('halt_reason_mismatch', 500))).toBe(false);
  });
});

/**
 * The labels are keyed by `PhoneHaltReason`, so tsc keeps them in step with
 * `types.ts` — and nothing keeps `types.ts` in step with the API. This does:
 * both halt bodies' published `reason` enums must equal the web union and the
 * label map, member for member. CRLF-safe on purpose (Windows checkouts).
 */
describe('halt reason vocabulary', () => {
  const openapi = readFileSync(resolve(__dirname, '../../../../../api/openapi/openapi.yaml'), 'utf8')
    .replace(/\r\n/g, '\n');
  const typesSource = readFileSync(resolve(__dirname, '../../../types.ts'), 'utf8');

  function reasonEnum(schema: string): string[] {
    const lines = openapi.split('\n');
    const start = lines.findIndex((l) => l === `    ${schema}:`);
    if (start === -1) throw new Error(`schema not found: ${schema}`);
    const endOffset = lines.slice(start + 1).findIndex((l) => /^ {4}\S/.test(l));
    const block = lines.slice(start, endOffset === -1 ? undefined : start + 1 + endOffset);
    const enumLine = block.find((l) => /^\s+enum:\s*\[.*\]\s*$/.test(l));
    if (!enumLine) throw new Error(`no enum in ${schema}`);
    return (/\[(.*)\]/.exec(enumLine)?.[1] ?? '').split(',').map((m) => m.trim()).filter(Boolean);
  }

  function union(typeName: string): string[] {
    const start = typesSource.indexOf(`export type ${typeName} =`);
    if (start === -1) throw new Error(`type not found: ${typeName}`);
    const end = typesSource.indexOf(';', start);
    return [...typesSource.slice(start, end).matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);
  }

  it('matches the API for both halt bodies, the web union and the labels', () => {
    const api = reasonEnum('PhoneHaltBody');
    expect(api).toHaveLength(5);
    expect(api).toContain('operator_pause');
    expect(reasonEnum('PhoneHaltClearBody').sort()).toEqual([...api].sort());
    expect(union('PhoneHaltReason').sort()).toEqual([...api].sort());
    expect(Object.keys(HALT_REASON_LABELS).sort()).toEqual([...api].sort());
  });
});
