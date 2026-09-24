/**
 * CandidateDetailPage — Overview + Review workspace.
 *
 * Covers: loading/error, profile, back link, live actions, session summary,
 * the Review tab (session scorecard + on-demand recording), decision-use
 * block suppression, notes, appeals, CSV export, axe.
 */

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CandidateDetailPage } from './CandidateDetailPage';
import { mockCandidateDetail, mockSessionDetail } from '../test/helpers';

const mockApi = {
  getCandidate: vi.fn(),
  // The Profile card shows the role a candidate applied for, which the detail
  // payload does not carry — the page resolves it from the roles list.
  listRoles: vi.fn(),
  getMe: vi.fn(),
  getCandidatePhoneScreenings: vi.fn(),
  getPhoneSlots: vi.fn(),
  scheduleCandidatePhoneAppointment: vi.fn().mockResolvedValue({
    ok: true, appointment_id: 'appointment-1', version: 1, engagement_state: 'scheduled',
    prereqs_pending: false, superseded_appointment_id: null,
  }),
  rescheduleCandidatePhoneAppointment: vi.fn().mockResolvedValue({
    ok: true, appointment_id: 'appointment-1', version: 2, engagement_state: 'scheduled',
    prereqs_pending: false, superseded_appointment_id: 'appointment-0',
  }),
  cancelCandidatePhoneAppointment: vi.fn().mockResolvedValue({
    ok: true, appointment_id: 'appointment-1', version: 2, already_cancelled: false,
  }),
  requestPhoneRescreen: vi.fn().mockResolvedValue({ ok: true, status: 'ok', cycle_number: 2 }),
  verifyCandidatePhone: vi.fn().mockResolvedValue({ ok: true }),
  getRecordingDownloadUrl: vi.fn(),
  getSession: vi.fn(),
  listNotes: vi.fn().mockResolvedValue({ notes: [] }),
  addNote: vi.fn().mockResolvedValue({ id: 'n1' }),
  listAppeals: vi.fn().mockResolvedValue({ appeals: [] }),
  issueAppealGrant: vi.fn().mockResolvedValue({
    appeal_grant_token: 'c'.repeat(64),
    expires_at: '2999-01-01T00:00:00.000Z',
  }),
  exportCsv: vi.fn().mockResolvedValue('﻿candidate_id,status\n'),
  // Default: this candidate is not Ashby-linked, so the read-only Ashby
  // pipeline card contributes nothing to the Overview.
  getCandidateAshbyWorkflow: vi.fn().mockResolvedValue({ ok: true, workflow: null }),
  requestCandidatePhoneCall: vi.fn().mockResolvedValue({ ok: true, status: 'requested' }),
};

vi.mock('../api', () => ({
  api: {
    getCandidate: (...args: any[]) => mockApi.getCandidate(...args),
    listRoles: (...args: any[]) => mockApi.listRoles(...args),
    getMe: (...args: any[]) => mockApi.getMe(...args),
    getCandidatePhoneScreenings: (...args: any[]) => mockApi.getCandidatePhoneScreenings(...args),
    getPhoneSlots: (...args: any[]) => mockApi.getPhoneSlots(...args),
    scheduleCandidatePhoneAppointment: (...args: any[]) => mockApi.scheduleCandidatePhoneAppointment(...args),
    rescheduleCandidatePhoneAppointment: (...args: any[]) => mockApi.rescheduleCandidatePhoneAppointment(...args),
    cancelCandidatePhoneAppointment: (...args: any[]) => mockApi.cancelCandidatePhoneAppointment(...args),
    requestPhoneRescreen: (...args: any[]) => mockApi.requestPhoneRescreen(...args),
    verifyCandidatePhone: (...args: any[]) => mockApi.verifyCandidatePhone(...args),
    getRecordingDownloadUrl: (...args: any[]) => mockApi.getRecordingDownloadUrl(...args),
    getSession: (...args: any[]) => mockApi.getSession(...args),
    listNotes: (...args: any[]) => mockApi.listNotes(...args),
    addNote: (...args: any[]) => mockApi.addNote(...args),
    listAppeals: (...args: any[]) => mockApi.listAppeals(...args),
    issueAppealGrant: (...args: any[]) => mockApi.issueAppealGrant(...args),
    exportCsv: (...args: any[]) => mockApi.exportCsv(...args),
    startLiveKitScreening: vi.fn().mockRejectedValue(new Error('mock')),
    listCandidates: vi.fn().mockResolvedValue([]),
    getCandidateAshbyWorkflow: (...args: any[]) => mockApi.getCandidateAshbyWorkflow(...args),
    requestCandidatePhoneCall: (...args: any[]) => mockApi.requestCandidatePhoneCall(...args),
  },
  ApiError: class extends Error {
    status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
    }
  },
}));

vi.mock('../lib/supabase', () => {
  const makeChannel = () => {
    const channel: any = {};
    channel.on = () => channel;
    channel.subscribe = () => 'mock-sub';
    return channel;
  };
  const makeQuery = () => {
    const q: any = {};
    q.select = () => q;
    q.eq = () => q;
    q.order = () => q;
    q.limit = () => Promise.resolve({ data: null, error: null });
    return q;
  };
  return {
    supabase: {
      from: () => makeQuery(),
      channel: () => makeChannel(),
      removeChannel: () => {},
    },
  };
});

function renderDetailPage(id = 'candidate-1') {
  return render(
    <MemoryRouter initialEntries={[`/candidates/${id}`]}>
      <Routes>
        <Route path="/candidates/:id" element={<CandidateDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function reviewTab() {
  return screen.getByRole('tab', { name: 'Review' });
}

describe('CandidateDetailPage', () => {
  beforeEach(() => {
    // The Profile card resolves the role title from this; an empty list
    // means the badge is simply absent, which no existing assertion reads.
    mockApi.listRoles.mockResolvedValue([]);
    vi.clearAllMocks();
    mockApi.getCandidate.mockResolvedValue(mockCandidateDetail);
    mockApi.getMe.mockResolvedValue({ userId: 'u-admin', email: null, role: 'admin', active: true });
    mockApi.getCandidatePhoneScreenings.mockResolvedValue({
      ok: true,
      enabled: true,
      cycles: [],
      current_cycle: null,
    });
    mockApi.getPhoneSlots.mockResolvedValue({
      ok: true,
      enabled: true,
      date: '2026-08-28',
      window: { time_zone: 'Asia/Kolkata', open_ist: '09:00:00', close_ist: '21:00:00', temporary_247_until_ist: '2026-09-06' },
      slot_seconds: 1800,
      max_concurrent: 10,
      booked_total: 0,
      occupancy_truncated: false,
      slots: [],
    });
    mockApi.getSession.mockResolvedValue(mockSessionDetail);
  });

  it('shows loading state initially', () => {
    mockApi.getCandidate.mockReturnValue(new Promise(() => {}));
    renderDetailPage();
    expect(screen.getByText('Loading candidate…')).toBeInTheDocument();
  });

  it('shows error state on API failure', async () => {
    mockApi.getCandidate.mockRejectedValue({ message: 'Candidate not found' });
    renderDetailPage();
    expect(await screen.findByText('Candidate not found')).toBeInTheDocument();
  });

  it('shows the ROLE and the CALL LENGTH on the left, not in the Live-call card', async () => {
    // These two answer "who is this and did we actually talk to them". The
    // length used to sit in the Live-call card on the far right, which is the
    // last place a manager scanning the left column looks.
    mockApi.listRoles.mockResolvedValue([{ id: 'role-1', title: 'Sales Advisor' }]);
    mockApi.getCandidate.mockResolvedValue({
      ...mockCandidateDetail,
      candidate: { ...mockCandidateDetail.candidate, role_id: 'role-1' },
      sessions: [{ ...mockCandidateDetail.sessions[0], duration_sec: 434, candidate_words: 450 }],
    });
    renderDetailPage();

    expect(await screen.findByText('Sales Advisor')).toBeInTheDocument();
    expect(document.querySelector('[data-candidate-call-length]')?.textContent).toContain('7m 14s');
    // Labelled for WHAT IT MEASURES. `duration_sec` is wall clock from session
    // start to finalize — bot speech, candidate speech, ring and silence — so
    // "candidate spoke for 7m 14s" would be a false claim about engagement.
    expect(document.querySelector('[data-candidate-call-length]')?.textContent).toContain(
      'on the call',
    );
    expect(document.querySelector('[data-candidate-call-length]')?.textContent).not.toMatch(
      /spoke|talk/i,
    );
  });

  it('shows the words the CANDIDATE said, which wall clock cannot give', async () => {
    // The pair is the point: a long call with very few candidate words is a
    // call where they could not get a word in. Praveetha's 2026-09-10 screen
    // had 8 of 8 bot turns barged-in and truncated and a healthy-looking
    // wall clock.
    mockApi.getCandidate.mockResolvedValue({
      ...mockCandidateDetail,
      sessions: [{ ...mockCandidateDetail.sessions[0], duration_sec: 480, candidate_words: 12 }],
    });
    renderDetailPage();
    await screen.findByText(/Profile/);
    const words = document.querySelector('[data-candidate-words]');
    expect(words?.textContent).toContain('12');
    expect(words?.textContent).toContain('words spoken');
  });

  it('reports the LONGEST session, not the latest', async () => {
    // A candidate can carry a cycle-2 rescreen plus a call that died at the
    // consent gate after nine seconds. The most recent would report "0m 9s"
    // for someone who completed a seven-minute screen.
    mockApi.getCandidate.mockResolvedValue({
      ...mockCandidateDetail,
      sessions: [
        { ...mockCandidateDetail.sessions[0], id: 's-new', duration_sec: 9, candidate_words: 3 },
        { ...mockCandidateDetail.sessions[0], id: 's-old', duration_sec: 434, candidate_words: 450 },
      ],
    });
    renderDetailPage();
    await screen.findByText(/Profile/);
    expect(document.querySelector('[data-candidate-call-length]')?.textContent).toContain('7m 14s');
    // ...and the words come from THE SAME session, or the two figures
    // describe different calls while sitting side by side.
    expect(document.querySelector('[data-candidate-words]')?.textContent).toContain('450');
  });

  it('shows no call badge at all when nothing completed', async () => {
    // Absent, not "0m 0s" — a zero-length call is a claim, and the wrong one.
    mockApi.getCandidate.mockResolvedValue({
      ...mockCandidateDetail,
      sessions: [{ ...mockCandidateDetail.sessions[0], duration_sec: null, candidate_words: 0 }],
    });
    renderDetailPage();
    await screen.findByText(/Profile/);
    expect(document.querySelector('[data-candidate-call-length]')).toBeNull();
  });

  it('puts those badges UNDER THE CANDIDATE NAME, not in a card further down', async () => {
    // The literal ask, and the reason the ask was made: the manager reads the
    // name, then wants the role and whether a call happened. A badge that is
    // correct but sits below the fold in the third card answers the question
    // after it has stopped being asked. Asserting the DOM relationship,
    // because "it renders somewhere" is what the previous placement satisfied.
    mockApi.listRoles.mockResolvedValue([{ id: 'role-1', title: 'Sales Advisor' }]);
    mockApi.getCandidate.mockResolvedValue({
      ...mockCandidateDetail,
      candidate: { ...mockCandidateDetail.candidate, role_id: 'role-1' },
      sessions: [{ ...mockCandidateDetail.sessions[0], duration_sec: 434, candidate_words: 450 }],
    });
    renderDetailPage();

    // The role arrives on its own request, AFTER the name renders — waiting on
    // the heading alone would assert against a half-filled header.
    await screen.findByText('Sales Advisor');
    const heading = screen.getByRole('heading', { level: 1, name: 'Jane Doe' });
    const role = document.querySelector('[data-candidate-role-title]');
    const length = document.querySelector('[data-candidate-call-length]');
    expect(role).not.toBeNull();
    expect(length).not.toBeNull();
    // Same header block as the name...
    expect(heading.parentElement?.contains(role!)).toBe(true);
    // ...and AFTER it, not above.
    expect(
      heading.compareDocumentPosition(role!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // ...and before the tab strip, so it is read without opening anything.
    const tabs = screen.getByRole('tablist');
    expect(
      role!.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('says NOTHING about words when the transcript was never read', async () => {
    // null is not 0. "0 words spoken" is an accusation about the candidate;
    // a missing transcript is a fact about us. The route returns null for the
    // second case precisely so this badge can stay away.
    mockApi.getCandidate.mockResolvedValue({
      ...mockCandidateDetail,
      sessions: [{ ...mockCandidateDetail.sessions[0], duration_sec: 434, candidate_words: null }],
    });
    renderDetailPage();
    await screen.findByText(/Profile/);
    // The call still happened, so its length is still shown...
    expect(document.querySelector('[data-candidate-call-length]')).not.toBeNull();
    // ...but nothing is claimed about what they said.
    expect(document.querySelector('[data-candidate-words]')).toBeNull();
  });

  it('shows a REAL zero — a candidate who said nothing on a real call', async () => {
    // The counterpart of the test above, and the reason null had to exist:
    // without the distinction this case would be unreportable.
    mockApi.getCandidate.mockResolvedValue({
      ...mockCandidateDetail,
      sessions: [{ ...mockCandidateDetail.sessions[0], duration_sec: 434, candidate_words: 0 }],
    });
    renderDetailPage();
    await screen.findByText(/Profile/);
    const words = document.querySelector('[data-candidate-words]');
    expect(words?.textContent).toContain('0');
    expect(words?.textContent).toContain('words spoken');
  });

  it('shows no call badge for a ZERO-length call either', async () => {
    // `duration_sec: null` was the only case covered, and the `typeof ===
    // "number"` half of the guard already rejects that — so `callSeconds > 0`
    // was free. Zero is REACHABLE: `0024_recovery_audit_system_actor.sql`
    // writes `greatest(0, floor(extract(epoch from (ended_at - started_at))))`.
    // The badge would read "0m 0s on the call", which the component header
    // explicitly forbids as a claim that is both precise and wrong.
    mockApi.getCandidate.mockResolvedValue({
      ...mockCandidateDetail,
      sessions: [{ ...mockCandidateDetail.sessions[0], duration_sec: 0, candidate_words: 0 }],
    });
    renderDetailPage();
    await screen.findByText(/Profile/);
    expect(document.querySelector('[data-candidate-call-length]')).toBeNull();
  });

  it('SHOWS THE RESUME SUMMARY above the numbers, which is where it was asked for', async () => {
    // The relocated summary had NO test anywhere: deleting the block left 303
    // tests green, and since the same change removed it from Resume evidence,
    // deleting it would make the summary vanish from the page entirely — the
    // one field the owner asked to be promoted.
    mockApi.getCandidate.mockResolvedValue({
      ...mockCandidateDetail,
      candidate: {
        ...mockCandidateDetail.candidate,
        parsed: { summary: 'Ten years selling enterprise software in India.' },
      },
    });
    renderDetailPage();

    const summary = await screen.findByText(/Ten years selling enterprise software/);
    expect(summary).toBeInTheDocument();
    // ...ABOVE the numbers. "Experience" is the figure it was asked to clear.
    const experience = screen.getByText('Experience');
    expect(
      summary.compareDocumentPosition(experience) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // ...and NOT duplicated further down in Resume evidence.
    expect(screen.getAllByText(/Ten years selling enterprise software/)).toHaveLength(1);
  });

  it('LABELS the role pill for a screen reader', async () => {
    // The other two pills caption themselves ("on the call", "words spoken").
    // This one is bare text in a coloured capsule, so without the prefix a
    // screen reader hears "Sales Advisor" with nothing saying what it is.
    mockApi.listRoles.mockResolvedValue([{ id: 'role-1', title: 'Sales Advisor' }]);
    mockApi.getCandidate.mockResolvedValue({
      ...mockCandidateDetail,
      candidate: { ...mockCandidateDetail.candidate, role_id: 'role-1' },
    });
    renderDetailPage();
    await screen.findByText('Sales Advisor');
    expect(document.querySelector('[data-candidate-role-title]')?.textContent).toContain('Role:');
  });

  it('does NOT claim a role it could not resolve', async () => {
    // A wrong role on a candidate page is worse than no role.
    mockApi.listRoles.mockResolvedValue([]);
    mockApi.getCandidate.mockResolvedValue({
      ...mockCandidateDetail,
      candidate: { ...mockCandidateDetail.candidate, role_id: 'role-gone' },
    });
    renderDetailPage();
    await screen.findByText(/Profile/);
    expect(document.querySelector('[data-candidate-role-title]')).toBeNull();
    expect(screen.queryByText('role-gone')).not.toBeInTheDocument();
  });

  it('renders candidate profile', async () => {
    renderDetailPage();
    expect(await screen.findByText('Jane Doe')).toBeInTheDocument();
    expect(screen.getByText('jane@example.com')).toBeInTheDocument();
    expect(screen.getByText('5 years')).toBeInTheDocument();
    expect(screen.getByText('Profile')).toBeInTheDocument();
  });

  /**
   * An Ashby import creates the candidate before its resume is parsed, so
   * Detail must open on a row whose name/email/phone are all null. The header
   * uses the SAME shared neutral copy as the list, and the profile keeps its
   * existing "not provided" fallbacks rather than inventing values.
   */
  it('falls back to the shared neutral title for a nullable shell', async () => {
    mockApi.getCandidate.mockResolvedValue({
      ...mockCandidateDetail,
      candidate: {
        ...mockCandidateDetail.candidate,
        name: null,
        email: null,
        phone_e164: null,
        phone_valid: false,
        skills: [],
        experience_years: null,
        status: 'queued',
      },
    });
    renderDetailPage();
    expect(
      await screen.findByRole('heading', { name: 'Awaiting resume details' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/unnamed/i)).toBeNull();
    // Profile fallbacks, not fabricated values.
    expect(screen.getByText('Not provided')).toBeInTheDocument();
    expect(screen.getByText('None parsed')).toBeInTheDocument();
    // Status vocabulary is unchanged: a queued shell is still queued.
    expect(screen.getAllByText('Queued').length).toBeGreaterThanOrEqual(1);
    // No recovery affordance on a candidate page — recovery is admin-only.
    expect(screen.queryByRole('button', { name: /retry|reprocess|re-?parse/i })).toBeNull();
  });

  it('renders Back to candidates link', async () => {
    renderDetailPage();
    expect(await screen.findByText('← Back to candidates')).toBeInTheDocument();
  });

  it('renders LiveKit voice screening + Live call panel', async () => {
    renderDetailPage();
    expect(await screen.findByText('LiveKit voice screening')).toBeInTheDocument();
    expect(screen.getByText('Live call')).toBeInTheDocument();
  });

  it('requires confirmation before requesting a phone screening', async () => {
    renderDetailPage();
    await screen.findByText('Jane Doe');
    await screen.findByRole('button', { name: 'Call candidate' });
    expect(mockApi.requestCandidatePhoneCall).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Call candidate' }));
    expect(screen.getByRole('dialog', { name: 'Confirm phone screening' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm call' }));
    await waitFor(() => expect(mockApi.requestCandidatePhoneCall).toHaveBeenCalledWith('candidate-1'));
    expect(await screen.findByRole('status')).toHaveTextContent(/Phone screening requested/);
  });

  it('requests a governed new cycle from an eligible terminal cycle', async () => {
    mockApi.getCandidatePhoneScreenings.mockResolvedValue({
      ok: true,
      enabled: true,
      current_cycle: 1,
      cycles: [{
        cycle_number: 1,
        state: 'completed',
        state_reason: null,
        version: 2,
        no_answer_attempts: 0,
        no_answer_limit: 3,
        reconnects_used: 0,
        provider_failures: 0,
        next_eligible_at: null,
        last_attempt_at: null,
        terminal_at: '2026-08-27T10:00:00Z',
        created_at: '2026-08-27T09:00:00Z',
        updated_at: '2026-08-27T10:00:00Z',
        has_session: true,
        has_assessment: true,
        appointment: null,
      }],
    });
    renderDetailPage();
    await screen.findByRole('button', { name: 'Request re-screen' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Reason for new cycle' }), {
      target: { value: 'technical_issue' },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Request re-screen' }));
    await waitFor(() => expect(mockApi.requestPhoneRescreen).toHaveBeenCalledWith(
      'candidate-1',
      expect.objectContaining({ request_id: expect.stringMatching(/^ui-/), reason: 'technical_issue' }),
    ));
  });

  it('renders the session summary in Overview', async () => {
    renderDetailPage();
    expect(await screen.findByText('Screening sessions')).toBeInTheDocument();
    // Session status is shown (also appears in the Review context header).
    expect(screen.getAllByText('Completed').length).toBeGreaterThanOrEqual(1);
  });

  it('shows the session scorecard in the Review tab', async () => {
    renderDetailPage();
    await screen.findByText('Jane Doe');
    fireEvent.click(reviewTab());
    expect(await screen.findByText('Scorecard for this session')).toBeInTheDocument();
    expect(screen.getByText('78')).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = renderDetailPage();
    await screen.findByText('Jane Doe');
    await expect(container).toHaveNoViolations();
  });

  describe('on-demand recording (MIG-06)', () => {
    it('does not fetch a recording URL until an explicit click', async () => {
      mockApi.getRecordingDownloadUrl.mockResolvedValue({ url: 'https://x.invalid/rec' });
      renderDetailPage();
      await screen.findByText('Jane Doe');
      fireEvent.click(reviewTab());
      const loadBtn = await screen.findByRole('button', { name: /load recording/i });
      expect(mockApi.getRecordingDownloadUrl).not.toHaveBeenCalled();
      fireEvent.click(loadBtn);
      await waitFor(() =>
        expect(mockApi.getRecordingDownloadUrl).toHaveBeenCalledWith('session-1'),
      );
      await waitFor(() => expect(document.querySelector('audio')).not.toBeNull());
    });

    it('shows an error when the recording fetch fails', async () => {
      mockApi.getRecordingDownloadUrl.mockRejectedValue({ message: 'expired' });
      renderDetailPage();
      await screen.findByText('Jane Doe');
      fireEvent.click(reviewTab());
      fireEvent.click(await screen.findByRole('button', { name: /load recording/i }));
      expect(await screen.findByText('expired')).toBeInTheDocument();
    });
  });

  describe('Phase 9 additions', () => {
    it('suppresses the scorecard under a decision-use block', async () => {
      mockApi.getCandidate.mockResolvedValue({
        ...mockCandidateDetail,
        candidate: {
          ...mockCandidateDetail.candidate,
          decision_use_blocked_at: '2026-01-02T00:00:00.000Z',
        },
      });
      renderDetailPage();
      expect(
        await screen.findByText(/Decision use is paused — open appeal/i),
      ).toBeInTheDocument();
      fireEvent.click(reviewTab());
      expect(
        await screen.findByText(/Scorecards are suppressed while an appeal is under review/i),
      ).toBeInTheDocument();
      expect(screen.queryByText('78')).not.toBeInTheDocument();
    });

    it('renders the notes section and adds a note', async () => {
      mockApi.listNotes.mockResolvedValue({
        notes: [{ id: 'n1', candidate_id: 'candidate-1', author_id: 'u1', note: 'Call back next week', created_at: '2026-01-01T00:00:00Z' }],
      });
      renderDetailPage();
      expect(await screen.findByText('Call back next week')).toBeInTheDocument();
      await userEvent.type(screen.getByPlaceholderText('Add a note…'), 'Follow up');
      await userEvent.click(screen.getByRole('button', { name: 'Add' }));
      await waitFor(() => expect(mockApi.addNote).toHaveBeenCalledWith('candidate-1', 'Follow up'));
    });

    it('exports the scorecard CSV on click', async () => {
      const createObjSpy = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:mock');
      const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
      renderDetailPage();
      const btn = await screen.findByRole('button', {
        name: 'Export screening data (scorecard + transcript)',
      });
      fireEvent.click(btn);
      await waitFor(() => expect(mockApi.exportCsv).toHaveBeenCalledWith('candidate-1'));
      await waitFor(() => expect(createObjSpy).toHaveBeenCalled());
      expect(revokeSpy).toHaveBeenCalled();
      createObjSpy.mockRestore();
      revokeSpy.mockRestore();
    });

    it('issues a one-time appeal grant and shows a fragment link', async () => {
      renderDetailPage();
      const issueBtn = await screen.findByRole('button', { name: 'Issue one-time appeal grant' });
      fireEvent.click(issueBtn);
      await waitFor(() => {
        expect(mockApi.issueAppealGrant).toHaveBeenCalledWith('candidate-1', 'session-1', 24);
      });
      expect(await screen.findByText(/\/appeal#/)).toBeInTheDocument();
      expect(screen.queryByText(/\/appeal\?/)).not.toBeInTheDocument();
    });
  });
});

describe('Ashby pipeline card on the Overview', () => {
  beforeEach(() => {
    mockApi.getCandidate.mockResolvedValue(mockCandidateDetail);
  });

  it('renders no card at all for a candidate with no Ashby workflow', async () => {
    mockApi.getCandidateAshbyWorkflow.mockResolvedValue({ ok: true, workflow: null });
    renderDetailPage();
    await screen.findByText('Jane Doe');
    await waitFor(() => expect(mockApi.getCandidateAshbyWorkflow).toHaveBeenCalledWith('candidate-1'));
    expect(screen.queryByText('Ashby screening pipeline')).not.toBeInTheDocument();
  });

  it('renders the read-only card for an Ashby-linked candidate, with no new controls', async () => {
    mockApi.getCandidateAshbyWorkflow.mockResolvedValue({
      ok: true,
      workflow: {
        lifecycle: 'ready',
        terminalState: null,
        ingestionState: 'ready',
        operations: [{ type: 'invite_delivery', state: 'pending', errorCode: null }],
        sessionStatus: null,
        updatedAt: '2026-08-20T10:00:00.000Z',
      },
    });
    renderDetailPage();
    // Wait for the resolved card, not the identically-headed loading state.
    expect(await screen.findByText('Ready to screen')).toBeInTheDocument();
    expect(screen.getByText('Ashby screening pipeline')).toBeInTheDocument();
    expect(screen.getByText('Screening invite')).toBeInTheDocument();
    // The card region itself contributes no control of any kind.
    const region = screen.getByRole('region', { name: 'Ashby screening pipeline' });
    expect(within(region).queryAllByRole('button')).toHaveLength(0);
    expect(within(region).queryAllByRole('link')).toHaveLength(0);
    expect(region.querySelectorAll('button, a, input, select, textarea')).toHaveLength(0);
  });
});
