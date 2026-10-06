import { describe, it, expect } from 'vitest';
import {
  anyPhoneProgressUnknown,
  candidateStatusLabel,
  candidateStatusTone,
  sessionStatusLabel,
  sessionStatusTone,
  formatDurationSec,
  candidateStatusCounts,
  sessionStatusCounts,
  attemptOutcomeLabel,
  attemptRawStatus,
  engagementReasonLabel,
  appealStatusLabel,
  appealCategoryLabel,
  isAppealPending,
  candidateDisplayStatus,
  candidateStatusKey,
} from '../status';

describe('candidateStatusLabel', () => {
  it('labels the known status vocabulary', () => {
    expect(candidateStatusLabel('new')).toBe('New');
    expect(candidateStatusLabel('queued')).toBe('Queued');
    expect(candidateStatusLabel('screening')).toBe('Screening');
    expect(candidateStatusLabel('screened')).toBe('Screened');
    expect(candidateStatusLabel('advanced')).toBe('Advanced');
    expect(candidateStatusLabel('rejected')).toBe('Rejected');
  });

  it('falls back to the humanized raw value for unknown statuses (never invents)', () => {
    // The same words in sentence case, never a guessed label: an operator
    // still recognises the stored value, and the page keeps it in `title`.
    expect(candidateStatusLabel('custom_state')).toBe('Custom state');
    expect(candidateStatusLabel(null)).toBe('New');
    expect(candidateStatusLabel(undefined)).toBe('New');
    expect(candidateStatusLabel('  ')).toBe('New');
  });

  it('guards malformed runtime payloads without rendering objects', () => {
    expect(candidateStatusLabel({ value: 'new' } as unknown as string)).toBe('New');
  });
});

describe('candidateStatusTone', () => {
  it('maps screened/advanced to success, screening/queued to warning, rejected to danger, new to info', () => {
    expect(candidateStatusTone('screened')).toBe('success');
    expect(candidateStatusTone('advanced')).toBe('success');
    expect(candidateStatusTone('screening')).toBe('warning');
    expect(candidateStatusTone('queued')).toBe('warning');
    expect(candidateStatusTone('rejected')).toBe('danger');
    expect(candidateStatusTone('new')).toBe('info');
    expect(candidateStatusTone('mystery')).toBe('neutral');
  });
});

describe('sessionStatusLabel / tone', () => {
  it('labels the 7-state session vocabulary', () => {
    expect(sessionStatusLabel('created')).toBe('Created');
    expect(sessionStatusLabel('waiting')).toBe('Waiting');
    expect(sessionStatusLabel('in_progress')).toBe('In progress');
    expect(sessionStatusLabel('completed')).toBe('Completed');
    expect(sessionStatusLabel('failed')).toBe('Failed');
    expect(sessionStatusLabel('cancelled')).toBe('Cancelled');
    expect(sessionStatusLabel('expired')).toBe('Expired');
    expect(sessionStatusLabel('weird')).toBe('Weird');
    expect(sessionStatusLabel('some_new_state')).toBe('Some new state');
    expect(sessionStatusLabel(null)).toBe('—');
  });

  it('guards malformed runtime payloads without rendering objects', () => {
    expect(sessionStatusLabel({ value: 'completed' } as unknown as string)).toBe('—');
  });

  it('tones terminal failure states as danger', () => {
    expect(sessionStatusTone('completed')).toBe('success');
    expect(sessionStatusTone('in_progress')).toBe('warning');
    expect(sessionStatusTone('failed')).toBe('danger');
    expect(sessionStatusTone('cancelled')).toBe('danger');
    expect(sessionStatusTone('expired')).toBe('danger');
    expect(sessionStatusTone('created')).toBe('info');
  });
});

describe('formatDurationSec', () => {
  it('formats seconds without fabricating values', () => {
    expect(formatDurationSec(45)).toBe('45s');
    expect(formatDurationSec(360)).toBe('6m 0s');
    expect(formatDurationSec(385)).toBe('6m 25s');
    expect(formatDurationSec(null)).toBe('—');
    expect(formatDurationSec(undefined)).toBe('—');
  });
});

describe('candidateStatusCounts', () => {
  it('counts only statuses actually present, newest label maps, sorted desc', () => {
    const counts = candidateStatusCounts([
      { status: 'new' },
      { status: 'new' },
      { status: 'screened' },
      { status: null },
    ]);
    expect(counts).toEqual([
      { label: 'New', value: 3 },
      { label: 'Screened', value: 1 },
    ]);
  });

  it('returns an empty list for no candidates (no fabricated statuses)', () => {
    expect(candidateStatusCounts([])).toEqual([]);
  });
});

describe('sessionStatusCounts', () => {
  it('counts present session statuses only', () => {
    const counts = sessionStatusCounts([
      { status: 'completed' },
      { status: 'completed' },
      { status: 'in_progress' },
    ]);
    expect(counts).toEqual([
      { label: 'Completed', value: 2 },
      { label: 'In progress', value: 1 },
    ]);
  });

  it('keeps chart labels as strings for malformed runtime statuses', () => {
    const counts = sessionStatusCounts([
      { status: { value: 'completed' } as unknown as string },
    ]);
    expect(counts).toEqual([{ label: '—', value: 1 }]);
    expect(counts.every((row) => typeof row.label === 'string')).toBe(true);
  });
});

describe('attemptOutcomeLabel', () => {
  it("names every outcome in the closed allowlist in a recruiter's words", () => {
    // 0042 + 0043 + 0095 `chk_phone_call_attempts_outcome`, in full: no
    // member may fall through to a raw snake_case enum.
    const allowlist = [
      'completed', 'disconnected', 'no_answer', 'busy', 'voicemail', 'declined',
      'wrong_number', 'opt_out', 'provider_error', 'window_closed', 'cancelled',
      'abandoned_pre_disclosure', 'consent_failed',
      // 0114 (C2-P1).
      'callback_deferred',
    ];
    for (const outcome of allowlist) {
      const label = attemptOutcomeLabel(outcome, 'ended');
      expect(label, outcome).not.toMatch(/_/);
      expect(label.charAt(0), outcome).toBe(label.charAt(0).toUpperCase());
    }
    expect(attemptOutcomeLabel('no_answer', 'ended')).toBe('No answer');
    expect(attemptOutcomeLabel('provider_error', 'ended')).toBe("Couldn't connect");
  });

  it('keeps the two consent-gate outcomes apart', () => {
    // The candidate hanging up before the recording notice is not OUR gate
    // failing, and neither is the candidate declining (0095).
    const hungUp = attemptOutcomeLabel('abandoned_pre_disclosure', 'ended');
    const ourFault = attemptOutcomeLabel('consent_failed', 'ended');
    const declined = attemptOutcomeLabel('declined', 'ended');
    expect(new Set([hungUp, ourFault, declined]).size).toBe(3);
    expect(ourFault).toMatch(/our side/);
  });

  it('describes the fixture gate drop as a consent-check drop, not "Dropped at gate"', () => {
    expect(attemptOutcomeLabel('dropped_at_gate', 'completed')).toBe('Dropped at the consent check');
  });

  it('falls back to the attempt state while no outcome is recorded, then to humanizeEnum', () => {
    expect(attemptOutcomeLabel(null, 'ringing')).toBe('Ringing');
    expect(attemptOutcomeLabel(null, 'answered_unclassified')).toBe('Answered');
    expect(attemptOutcomeLabel('brand_new_outcome', 'ended')).toBe('Brand new outcome');
    expect(attemptOutcomeLabel(null, null)).toBe('Unknown');
  });

  it('keeps the raw pair for an operator tooltip', () => {
    expect(attemptRawStatus('no_answer', 'ended')).toBe('state: ended · outcome: no_answer');
    expect(attemptRawStatus(null, 'ringing')).toBe('state: ringing');
    expect(attemptRawStatus(null, 'abandoned', 'infra_deferred'))
      .toBe('state: abandoned · abandon_reason: infra_deferred');
    expect(attemptRawStatus(null, 'abandoned', null)).toBe('state: abandoned');
  });
});

describe('abandoned attempts (0083 abandon_reason)', () => {
  it('says "Not placed" only for an infra defer, where no carrier was contacted', () => {
    expect(attemptOutcomeLabel(null, 'abandoned', 'infra_deferred')).toBe('Not placed');
  });

  it('says "Call interrupted" for a lease-reclaimed attempt (reason null), never "Not placed"', () => {
    expect(attemptOutcomeLabel(null, 'abandoned', null)).toBe('Call interrupted');
    // A caller or payload without the field is not evidence of an infra
    // defer either: these calls were placed, often answered and recorded.
    expect(attemptOutcomeLabel(null, 'abandoned')).toBe('Call interrupted');
    expect(attemptOutcomeLabel(null, 'abandoned', undefined)).toBe('Call interrupted');
  });

  it('lets a recorded outcome win over the abandon reason', () => {
    expect(attemptOutcomeLabel('no_answer', 'abandoned', null)).toBe('No answer');
    expect(attemptOutcomeLabel('provider_error', 'abandoned', 'infra_deferred')).toBe("Couldn't connect");
  });

  it('ignores abandon_reason on non-abandoned states', () => {
    expect(attemptOutcomeLabel(null, 'ringing', 'infra_deferred')).toBe('Ringing');
  });
});

describe('callback_deferred (0114)', () => {
  it('reads as a callback request, distinct from a drop, a cancel and a completion', () => {
    const deferred = attemptOutcomeLabel('callback_deferred', 'ended');
    expect(deferred).toBe('Asked to be called back later');
    for (const other of ['disconnected', 'cancelled', 'completed', 'declined']) {
      expect(attemptOutcomeLabel(other, 'ended')).not.toBe(deferred);
    }
  });
});

describe('engagementReasonLabel', () => {
  it('names the three 0114 (C2) reasons in plain words', () => {
    expect(engagementReasonLabel('callback_deferred_in_call'))
      .toBe('Asked to be called back; redial next day');
    expect(engagementReasonLabel('callback_deferral_limit'))
      .toBe('Asked to be called back too many times');
    expect(engagementReasonLabel('late_score_after_stranded_abort'))
      .toBe('Completed (score arrived late)');
  });

  it('never renders a raw snake_case reason for the known vocabulary', () => {
    for (const reason of [
      'no_answer_budget_exhausted', 'reconnect_budget_exhausted', 'provider_budget_exhausted',
      'window_closed', 'assessment_aborted', 'wrong_number', 'disclosure_refused',
      'candidate_opt_out', 'hr_cancelled', 'emergency_stop', 'ashby_stage_left', 'prereq_lost',
      'abandoned_pre_disclosure', 'consent_gate_failed', 'callback_deferred_in_call',
      'callback_deferral_limit', 'late_score_after_stranded_abort', 'screening_abandoned',
    ]) {
      const label = engagementReasonLabel(reason);
      expect(label, reason).not.toMatch(/_/);
      expect(label.charAt(0), reason).toBe(label.charAt(0).toUpperCase());
    }
  });

  it('names the 0115 zero-answer relabel neutrally (never Queued, never Screened)', () => {
    const label = engagementReasonLabel('screening_abandoned');
    expect(label).toBe('Abandoned: dropped before screening');
    expect(label).not.toMatch(/queued|screened/i);
  });

  it('keeps the late completion apart from the abort it replaced', () => {
    expect(engagementReasonLabel('late_score_after_stranded_abort'))
      .not.toBe(engagementReasonLabel('assessment_aborted'));
  });

  it('humanizes an unknown reason and renders nothing for an absent one', () => {
    expect(engagementReasonLabel('some_new_reason')).toBe('Some new reason');
    expect(engagementReasonLabel(null)).toBe('');
    expect(engagementReasonLabel(undefined)).toBe('');
    expect(engagementReasonLabel('   ')).toBe('');
    expect(engagementReasonLabel({ v: 1 } as unknown as string)).toBe('');
  });
});

describe('appeal vocabulary', () => {
  it('labels the four appeal statuses (0015) and flags the pending two', () => {
    expect(appealStatusLabel('open')).toBe('Open');
    expect(appealStatusLabel('under_review')).toBe('Under review');
    expect(appealStatusLabel('granted')).toBe('Granted');
    expect(appealStatusLabel('denied')).toBe('Denied');
    expect(isAppealPending('open')).toBe(true);
    expect(isAppealPending('under_review')).toBe(true);
    expect(isAppealPending('granted')).toBe(false);
    expect(isAppealPending('denied')).toBe(false);
  });

  it('names the appeal by its category', () => {
    expect(appealCategoryLabel('recording')).toBe('Recording appeal');
    expect(appealCategoryLabel('other')).toBe('Appeal');
    expect(appealCategoryLabel('data_access')).toBe('Data access appeal');
    expect(appealCategoryLabel(null)).toBe('Appeal');
  });
});

describe('candidateDisplayStatus (stored status + phone progress)', () => {
  it('appends the reached-dial count to Queued', () => {
    expect(candidateDisplayStatus({ status: 'queued', dial_count: 3 }).label).toBe('Queued (dialed 3)');
    expect(candidateDisplayStatus({ status: 'queued', dial_count: 1 }).label).toBe('Queued (dialed 1)');
    const ds = candidateDisplayStatus({ status: 'queued', dial_count: 3, phone_state: 'awaiting_retry' });
    expect(ds).toMatchObject({ key: 'queued', label: 'Queued (dialed 3)', tone: 'warning' });
  });

  it('shows plain Queued when the count is 0 (never dialled) or unknown', () => {
    expect(candidateDisplayStatus({ status: 'queued', dial_count: 0 }).label).toBe('Queued');
    // null = the server could not stand behind a count; absent = an older payload.
    expect(candidateDisplayStatus({ status: 'queued', dial_count: null }).label).toBe('Queued');
    expect(candidateDisplayStatus({ status: 'queued' }).label).toBe('Queued');
    // Malformed runtime values are unknown too, never rendered.
    expect(
      candidateDisplayStatus({ status: 'queued', dial_count: '4' as unknown as number }).label,
    ).toBe('Queued');
    expect(candidateDisplayStatus({ status: 'queued', dial_count: -1 }).label).toBe('Queued');
    expect(candidateDisplayStatus({ status: 'queued', dial_count: 2.5 }).label).toBe('Queued');
  });

  it('turns an abandoned_no_answer cycle into its own filterable key, in exactly the owner wording', () => {
    const ds = candidateDisplayStatus({ status: 'queued', dial_count: 5, phone_state: 'abandoned_no_answer' });
    expect(ds.key).toBe('abandoned_no_answer');
    // No "(dialed N)" on a terminal phone key: the count is in detail/title.
    expect(ds.label).toBe('Abandoned: no answer');
    expect(ds.detail).toContain('Phone reached 5 times');
    expect(ds.tone).toBe('danger');
    expect(candidateStatusKey({ status: 'queued', phone_state: 'abandoned_no_answer' })).toBe(
      'abandoned_no_answer',
    );
    // Unknown count: the outcome still shows, without a number.
    expect(
      candidateDisplayStatus({ status: 'queued', dial_count: null, phone_state: 'abandoned_no_answer' }).label,
    ).toBe('Abandoned: no answer');
  });

  it('maps the other terminal phone states', () => {
    const cases: Array<[string, string, string, string]> = [
      ['failed', 'phone_failed', 'Phone screen failed', 'danger'],
      ['wrong_number', 'wrong_number', 'Wrong number', 'danger'],
      ['opted_out', 'opted_out', 'Opted out', 'neutral'],
      ['cancelled', 'phone_cancelled', 'Phone screen cancelled', 'neutral'],
    ];
    for (const [state, key, label, tone] of cases) {
      const ds = candidateDisplayStatus({
        status: 'queued',
        dial_count: 1,
        phone_state: state as 'failed',
      });
      expect(ds, state).toMatchObject({ key, label, tone });
    }
  });

  it('never overrides a decided stored status', () => {
    for (const status of ['screened', 'advanced', 'rejected', 'consent_declined']) {
      const ds = candidateDisplayStatus({ status, dial_count: 4, phone_state: 'failed' });
      expect(ds.key, status).toBe(status);
      // No dial suffix on a decided status either.
      expect(ds.label, status).not.toMatch(/dialed/);
    }
    expect(candidateDisplayStatus({ status: 'screened', phone_state: 'failed' }).label).toBe('Screened');
  });

  it('keeps the stored status for a completed cycle and for every non-terminal state', () => {
    expect(candidateDisplayStatus({ status: 'queued', phone_state: 'completed', dial_count: 2 }).key).toBe(
      'queued',
    );
    for (const state of [
      'pending_prereqs',
      'eligible',
      'scheduled',
      'dialing',
      'in_call',
      'reconnecting',
      'awaiting_retry',
    ] as const) {
      expect(candidateDisplayStatus({ status: 'queued', phone_state: state }).key, state).toBe('queued');
    }
    // An unrecognised state is not invented into a key.
    expect(
      candidateDisplayStatus({ status: 'queued', phone_state: 'bogus' as unknown as 'failed' }).key,
    ).toBe('queued');
  });

  it('normalizes a missing / blank stored status to new', () => {
    expect(candidateDisplayStatus({ status: null }).key).toBe('new');
    expect(candidateDisplayStatus({ status: '  ' }).key).toBe('new');
    expect(candidateDisplayStatus({ status: undefined }).label).toBe('New');
  });

  it('puts the raw status, phone state, reason and last dial in the tooltip', () => {
    const ds = candidateDisplayStatus({
      status: 'queued',
      dial_count: 5,
      phone_state: 'abandoned_no_answer',
      phone_state_reason: 'no_answer_budget_exhausted',
      last_dialed_at: '2026-10-01T09:30:00Z',
    });
    expect(ds.title).toContain('Status: queued');
    // The badge already says the phone outcome: no "Phone: Abandoned: no
    // answer" double colon in the tooltip.
    expect(ds.title).not.toContain('Phone:');
    expect(ds.title).not.toContain('Phone cycle');
    expect(ds.title).toContain('No answer after every attempt');
    expect(ds.title).toContain('Phone reached 5 times (all cycles, incl. reconnects)');
    expect(ds.title).toMatch(/Last dialed .*2026/);
    expect(candidateDisplayStatus({ status: 'new' }).title).toBe('Status: new');
  });

  it('puts the same phone facts in VISIBLE detail text (not hover-only), and none on a decided status', () => {
    const ds = candidateDisplayStatus({
      status: 'queued',
      dial_count: 5,
      phone_state: 'abandoned_no_answer',
      phone_state_reason: 'no_answer_budget_exhausted',
      last_dialed_at: '2026-10-01T09:30:00Z',
    });
    expect(ds.detail).toMatch(/^No answer after every attempt · Phone reached 5 times .* · Last dialed .*2026/);
    expect(ds.detail).not.toContain('Status:');
    expect(candidateDisplayStatus({ status: 'new' }).detail).toBe('');
    expect(
      candidateDisplayStatus({ status: 'screened', dial_count: 2, phone_state: 'completed' }).detail,
    ).toBe('');
  });

  it('says what the phone is doing while a queued candidate is on, or just off, a call', () => {
    const cases: Array<[string, string]> = [
      ['dialing', 'Calling now'],
      ['in_call', 'On a call now'],
      ['reconnecting', 'Reconnecting a dropped call'],
      ['completed', 'Call completed, awaiting score'],
    ];
    for (const [state, words] of cases) {
      const ds = candidateDisplayStatus({ status: 'queued', dial_count: 1, phone_state: state as 'in_call' });
      // The badge keeps the decided wording...
      expect(ds.label, state).toBe('Queued (dialed 1)');
      // ...and the visible detail and tooltip say what is actually happening.
      expect(ds.detail, state).toContain(words);
      expect(ds.title, state).toContain(words);
    }
    expect(
      candidateDisplayStatus({ status: 'queued', dial_count: 2, phone_state: 'awaiting_retry' }).detail,
    ).toContain('Phone cycle – Awaiting retry');
  });

  it('flags an UNKNOWN phone read (explicit null) on an unsettled status, and only there', () => {
    const unknown = candidateDisplayStatus({ status: 'queued', dial_count: null, phone_state: null });
    expect(unknown.phoneUnknown).toBe(true);
    expect(unknown.label).toBe('Queued');
    expect(unknown.title).toContain('Phone progress unavailable');
    // Never dialled (0) and an older payload (absent) are not "unknown".
    expect(candidateDisplayStatus({ status: 'queued', dial_count: 0 }).phoneUnknown).toBe(false);
    expect(candidateDisplayStatus({ status: 'queued' }).phoneUnknown).toBe(false);
    // A decided status cannot be changed by phone data, so nothing is hidden.
    expect(candidateDisplayStatus({ status: 'screened', dial_count: null }).phoneUnknown).toBe(false);
    expect(anyPhoneProgressUnknown([{ status: 'queued', dial_count: 1 }, { status: 'new', dial_count: null }])).toBe(true);
    expect(anyPhoneProgressUnknown([{ status: 'queued', dial_count: 1 }, { status: 'advanced', dial_count: null }])).toBe(false);
  });

  it('labels every new key in plain words (no underscores) and counts by display key', () => {
    for (const key of ['abandoned_no_answer', 'phone_failed', 'wrong_number', 'opted_out', 'phone_cancelled']) {
      expect(candidateStatusLabel(key)).not.toMatch(/_/);
    }
    expect(
      candidateStatusCounts([
        { status: 'queued', phone_state: 'abandoned_no_answer' },
        { status: 'queued', dial_count: 2 },
        { status: 'queued' },
      ]),
    ).toEqual([
      { label: 'Queued', value: 2 },
      { label: 'Abandoned: no answer', value: 1 },
    ]);
  });
});
