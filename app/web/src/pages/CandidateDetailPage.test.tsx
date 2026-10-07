/**
 * CandidateDetailPage — Overview + Review workspace.
 *
 * Covers: loading/error, profile, back link, live actions, session summary,
 * the Review tab (session scorecard + on-demand recording), decision-use
 * block suppression, notes, appeals, CSV export, axe.
 */

import { StrictMode } from 'react';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
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
  // The R1 card reads the candidate's rounds and whether R1 can take a send.
  // R1 off with no rounds is the quiet default; R1Section.test.tsx covers the rest.
  listR1Rounds: vi.fn().mockResolvedValue({ rounds: [] }),
  getR1Availability: vi.fn().mockResolvedValue({ state: 'disabled', hold_minutes: 55 }),
  requestCandidatePhoneCall: vi.fn().mockResolvedValue({ ok: true, status: 'requested' }),
  releaseCandidatePhoneDuplicateHold: vi.fn().mockResolvedValue({
    ok: true, status: 'released', engagement_id: 'engagement-1', prerequisite_status: 'eligible',
  }),
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
    listR1Rounds: (...args: any[]) => mockApi.listR1Rounds(...args),
    getR1Availability: (...args: any[]) => mockApi.getR1Availability(...args),
    requestCandidatePhoneCall: (...args: any[]) => mockApi.requestCandidatePhoneCall(...args),
    releaseCandidatePhoneDuplicateHold: (...args: any[]) => mockApi.releaseCandidatePhoneDuplicateHold(...args),
  },
  ApiError: class extends Error {
    status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
    }
  },
}));

/**
 * A realtime client that behaves like realtime-js where it matters here, so a
 * test can deliver the INSERT a new call session produces:
 *   - `channel(topic)` returns the channel ALREADY registered under that
 *     topic, if there is one (RealtimeClient.channel does exactly this);
 *   - `removeChannel` starts a leave and does NOT unregister the channel —
 *     the real client only drops it once the leave round-trip completes, and
 *     in a test that round-trip never happens;
 *   - a leaving channel delivers nothing.
 * Hoisted: `vi.mock` factories run before imports.
 */
interface MockChannel {
  topic: string;
  leaving: boolean;
  handlers: Array<(payload: unknown) => void>;
  on: (type: string, filter: unknown, handler: (payload: unknown) => void) => MockChannel;
  subscribe: () => MockChannel;
}
const realtime = vi.hoisted(() => ({
  channels: new Map<string, MockChannel>(),
  /** Every topic `channel()` was asked for, in order. */
  requested: [] as string[],
  reset() {
    this.channels.clear();
    this.requested.length = 0;
  },
}));

vi.mock('../lib/supabase', () => {
  const makeChannel = (topic: string): MockChannel => {
    const channel: MockChannel = {
      topic,
      leaving: false,
      handlers: [],
      on: (_type, _filter, handler) => {
        channel.handlers.push(handler);
        return channel;
      },
      // realtime-js returns the channel itself, and callers keep THAT.
      subscribe: () => channel,
    };
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
      channel: (topic: string) => {
        realtime.requested.push(topic);
        const existing = realtime.channels.get(topic);
        if (existing) return existing;
        const created = makeChannel(topic);
        realtime.channels.set(topic, created);
        return created;
      },
      removeChannel: (channel: MockChannel) => {
        channel.leaving = true;
        return Promise.resolve('ok');
      },
    },
  };
});

/** Every live-watch topic requested for a candidate, oldest first. */
function liveWatchTopics(candidateId: string): string[] {
  return realtime.requested.filter((topic) =>
    topic.startsWith(`candidate-live-watch:${candidateId}`),
  );
}

/** Deliver a call-session INSERT to every live-watch channel that is not leaving. */
function insertCallSession(candidateId: string, row: Record<string, unknown>) {
  act(() => {
    for (const channel of realtime.channels.values()) {
      if (channel.leaving) continue;
      if (!channel.topic.startsWith(`candidate-live-watch:${candidateId}`)) continue;
      channel.handlers.forEach((handler) => handler({ new: row }));
    }
  });
}

function renderDetailPage(id = 'candidate-1', search = '') {
  return render(
    <MemoryRouter initialEntries={[`/candidates/${id}${search}`]}>
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

  it('shows the dial count in the header and the Overview, like the list row', async () => {
    mockApi.getCandidate.mockResolvedValue({
      ...mockCandidateDetail,
      candidate: {
        ...mockCandidateDetail.candidate,
        status: 'queued',
        dial_count: 3,
        phone_state: 'awaiting_retry',
        last_dialed_at: '2026-10-01T09:30:00Z',
      },
    });
    renderDetailPage();
    await screen.findByText('Jane Doe');
    // Header badge + Overview "Status" field: one derivation, same words.
    const badges = screen.getAllByText('Queued (dialed 3)');
    expect(badges.length).toBe(2);
    expect(badges[0]).toHaveAttribute('title', expect.stringContaining('Phone cycle – Awaiting retry'));
    // The same facts are VISIBLE under the header badge, not hover-only.
    const detail = document.querySelector('[data-phone-status-detail]');
    expect(detail?.textContent).toMatch(/Phone reached 3 times .* · Last dialed/);
  });

  it('names an abandoned_no_answer cycle in the header, never "Queued"', async () => {
    mockApi.getCandidate.mockResolvedValue({
      ...mockCandidateDetail,
      candidate: {
        ...mockCandidateDetail.candidate,
        status: 'queued',
        dial_count: 5,
        phone_state: 'abandoned_no_answer',
      },
    });
    renderDetailPage();
    await screen.findByText('Jane Doe');
    expect(screen.getAllByText('Abandoned: no answer').length).toBe(2);
    expect(screen.queryByText('Queued')).toBeNull();
  });

  it('keeps a decided status even when a later cycle failed', async () => {
    mockApi.getCandidate.mockResolvedValue({
      ...mockCandidateDetail,
      candidate: {
        ...mockCandidateDetail.candidate,
        status: 'screened',
        dial_count: 2,
        phone_state: 'failed',
      },
    });
    renderDetailPage();
    await screen.findByText('Jane Doe');
    expect(screen.queryByText(/Phone screen failed/)).toBeNull();
    expect(screen.queryByText(/dialed/)).toBeNull();
  });

  it('renders Back to candidates link', async () => {
    renderDetailPage();
    expect(await screen.findByText('← Back to candidates')).toBeInTheDocument();
  });

  it('renders the browser voice screening card but NO empty Live call panel when no call is live', async () => {
    // The panel was permanent: every candidate page carried a large "No
    // active call" box, including candidates screened weeks ago.
    renderDetailPage();
    expect(await screen.findByText('Browser voice screening')).toBeInTheDocument();
    expect(screen.queryByText('Live call')).not.toBeInTheDocument();
    expect(screen.queryByText('No call in progress')).not.toBeInTheDocument();
  });

  it('shows the Live call panel while a session is live', async () => {
    mockApi.getCandidate.mockResolvedValue({
      ...mockCandidateDetail,
      sessions: [{ ...mockCandidateDetail.sessions[0], id: 's-live', status: 'in_progress', duration_sec: null }],
    });
    renderDetailPage();
    expect(await screen.findByText('Live call')).toBeInTheDocument();
  });

  it('mounts the Live call panel when a NEW session is inserted while the page is open', async () => {
    // The panel's own "auto-activate on a new session" behaviour: an invite
    // created here, or the dialler placing the call, inserts a call session.
    realtime.reset();
    renderDetailPage();
    await screen.findByText('Browser voice screening');
    expect(screen.queryByText('Live call')).not.toBeInTheDocument();
    // The subscription is made in an effect, which can flush after the text
    // above appears: wait for it rather than racing it.
    await waitFor(() => expect(liveWatchTopics('candidate-1').length).toBeGreaterThan(0));
    insertCallSession('candidate-1', { id: 's-new', status: 'created' });
    expect(await screen.findByText('Live call')).toBeInTheDocument();
  });

  it('gives every live-watch subscription its own topic, so a fast remount still hears the INSERT', async () => {
    // realtime-js `channel(topic)` returns the channel already registered
    // under that topic, and `removeChannel` unregisters it only after the
    // leave round-trip. With one fixed topic, StrictMode's mount, unmount,
    // mount handed the second subscription the first one's LEAVING channel,
    // and the watch never fired.
    realtime.reset();
    render(
      <StrictMode>
        <MemoryRouter initialEntries={['/candidates/candidate-1']}>
          <Routes>
            <Route path="/candidates/:id" element={<CandidateDetailPage />} />
          </Routes>
        </MemoryRouter>
      </StrictMode>,
    );
    await screen.findByText('Browser voice screening');
    // StrictMode runs the effect, its cleanup, and the effect again.
    await waitFor(() => expect(liveWatchTopics('candidate-1').length).toBeGreaterThanOrEqual(2));
    const topics = liveWatchTopics('candidate-1');
    expect(new Set(topics).size).toBe(topics.length);
    expect(realtime.channels.get(topics[0])?.leaving).toBe(true);

    // The surviving subscription hears the insert.
    insertCallSession('candidate-1', { id: 's-new', status: 'created' });
    expect(await screen.findByText('Live call')).toBeInTheDocument();
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

  it('C3: recommends a technical_issue re-screen when the newest scorecard is held for evidence', async () => {
    const terminalCycle = {
      cycle_number: 1, state: 'completed', state_reason: null, version: 2,
      no_answer_attempts: 0, no_answer_limit: 3, reconnects_used: 0, provider_failures: 0,
      next_eligible_at: null, last_attempt_at: null, terminal_at: '2026-08-27T10:00:00Z',
      created_at: '2026-08-27T09:00:00Z', updated_at: '2026-08-27T10:00:00Z',
      has_session: true, has_assessment: true, appointment: null,
    };
    mockApi.getCandidatePhoneScreenings.mockResolvedValue({
      ok: true, enabled: true, current_cycle: 1, cycles: [terminalCycle],
    });
    mockApi.getCandidate.mockResolvedValue({
      ...mockCandidateDetail,
      assessments: [{
        ...mockCandidateDetail.assessments[0],
        evidence_grade: 'insufficient',
        evidence_reason: 'infra_interrupted',
        evidence_answered: 1,
        evidence_planned: 5,
      }],
    });
    renderDetailPage();
    const button = await screen.findByRole('button', { name: 'Rescreen recommended' });
    expect(screen.getByText(/cut off on our side/)).toBeInTheDocument();
    // The ordinary governed form is still there.
    expect(screen.getByRole('button', { name: 'Request re-screen' })).toBeInTheDocument();
    await userEvent.click(button);
    await waitFor(() => expect(mockApi.requestPhoneRescreen).toHaveBeenCalledWith(
      'candidate-1',
      expect.objectContaining({ request_id: expect.stringMatching(/^ui-/), reason: 'technical_issue' }),
    ));
  });

  describe('C8: a same-role duplicate-application hold', () => {
    const heldCycle = {
      cycle_number: 1, state: 'pending_prereqs', state_reason: 'duplicate_application', version: 2,
      no_answer_attempts: 0, no_answer_limit: 3, reconnects_used: 0, provider_failures: 0,
      next_eligible_at: null, last_attempt_at: null, terminal_at: null,
      created_at: '2026-10-03T09:00:00Z', updated_at: '2026-10-03T09:00:00Z',
      has_session: false, has_assessment: false, appointment: null,
    };

    it('shows the hold without naming the other record, and Release calls the API', async () => {
      mockApi.getCandidatePhoneScreenings.mockResolvedValue({
        ok: true, enabled: true, current_cycle: 1, cycles: [heldCycle],
      });
      renderDetailPage();
      expect(await screen.findByText('Held: duplicate application')).toBeInTheDocument();
      expect(screen.getByText(/already has a phone screen for this role on another candidate record/)).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Release hold' }));
      await waitFor(() => expect(mockApi.releaseCandidatePhoneDuplicateHold).toHaveBeenCalledWith('candidate-1'));
      expect(await screen.findByRole('status')).toHaveTextContent(/Hold released/);
      // Re-read after the release.
      await waitFor(() => expect(mockApi.getCandidatePhoneScreenings.mock.calls.length).toBeGreaterThanOrEqual(2));
    });

    it('no hold banner for an ordinary pending cycle', async () => {
      mockApi.getCandidatePhoneScreenings.mockResolvedValue({
        ok: true, enabled: true, current_cycle: 1,
        cycles: [{ ...heldCycle, state_reason: 'consent_missing' }],
      });
      renderDetailPage();
      await screen.findByRole('button', { name: 'Book a slot' });
      expect(screen.queryByRole('button', { name: 'Release hold' })).toBeNull();
    });

    it('a request answered duplicate_application shows recruiter copy, not the raw code', async () => {
      const { ApiError } = await import('../api');
      mockApi.requestCandidatePhoneCall.mockRejectedValueOnce(new ApiError('duplicate_application', 409));
      renderDetailPage();
      await screen.findByText('Jane Doe');
      await userEvent.click(await screen.findByRole('button', { name: 'Call candidate' }));
      await userEvent.click(screen.getByRole('button', { name: 'Confirm call' }));
      const status = await screen.findByRole('status');
      expect(status).toHaveTextContent(/another candidate record/);
      expect(status).not.toHaveTextContent('duplicate_application');
    });
  });

  it('C3: no re-screen recommendation for a decision-graded (or ungraded) scorecard', async () => {
    mockApi.getCandidatePhoneScreenings.mockResolvedValue({
      ok: true, enabled: true, current_cycle: 1,
      cycles: [{
        cycle_number: 1, state: 'completed', state_reason: null, version: 2,
        no_answer_attempts: 0, no_answer_limit: 3, reconnects_used: 0, provider_failures: 0,
        next_eligible_at: null, last_attempt_at: null, terminal_at: '2026-08-27T10:00:00Z',
        created_at: '2026-08-27T09:00:00Z', updated_at: '2026-08-27T10:00:00Z',
        has_session: true, has_assessment: true, appointment: null,
      }],
    });
    renderDetailPage();
    await screen.findByRole('button', { name: 'Request re-screen' });
    expect(screen.queryByRole('button', { name: 'Rescreen recommended' })).toBeNull();
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
      const btn = await screen.findByRole('button', { name: 'Export CSV' });
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

describe('Candidate header: one primary action for the state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.listRoles.mockResolvedValue([]);
    mockApi.getCandidate.mockResolvedValue(mockCandidateDetail);
    mockApi.getMe.mockResolvedValue({ userId: 'u-admin', email: null, role: 'admin', active: true });
    mockApi.getCandidatePhoneScreenings.mockResolvedValue({
      ok: true,
      enabled: true,
      cycles: [],
      current_cycle: null,
    });
    mockApi.getSession.mockResolvedValue(mockSessionDetail);
    mockApi.listAppeals.mockResolvedValue({ appeals: [] });
  });

  it('offers "Review screening" when there is a screening to read, and it opens the Review tab', async () => {
    const user = userEvent.setup();
    renderDetailPage();
    const primary = await screen.findByRole('button', { name: 'Review screening' });
    // Export is the only other header action, and it is not a primary.
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeInTheDocument();
    await user.click(primary);
    const review = reviewTab();
    expect(review).toHaveAttribute('aria-selected', 'true');
    // Focus follows the change instead of being stranded on a vanished button.
    await waitFor(() => expect(review).toHaveFocus());
    expect(screen.queryByRole('button', { name: 'Review screening' })).not.toBeInTheDocument();
  });

  it('opens on the Review tab from ?tab=review (the table "Review & decide" link)', async () => {
    renderDetailPage('candidate-1', '?tab=review');
    await screen.findByText('Jane Doe');
    expect(reviewTab()).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('button', { name: 'Review screening' })).not.toBeInTheDocument();
  });

  it('offers "Call candidate" when nothing is screened yet, once on the page, through the same confirmation', async () => {
    const user = userEvent.setup();
    mockApi.getCandidate.mockResolvedValue({ ...mockCandidateDetail, sessions: [], assessments: [] });
    renderDetailPage();
    const header = await screen.findByRole('button', { name: 'Call candidate' });
    // The phone card does not repeat it: one call action on the page.
    expect(screen.getAllByRole('button', { name: 'Call candidate' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Review screening' })).not.toBeInTheDocument();

    await user.click(header);
    const dialog = await screen.findByRole('dialog', { name: 'Confirm phone screening' });
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Confirm call' })).toHaveFocus(),
    );
    expect(mockApi.requestCandidatePhoneCall).not.toHaveBeenCalled();

    // Escape closes it and hands focus back to the control that opened it.
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Confirm phone screening' })).not.toBeInTheDocument();
    expect(header).toHaveFocus();
  });

  it('moves focus into the call confirmation even when "Call candidate" is pressed from ?tab=review', async () => {
    // A "Review & decide" deep link can land on the Review tab of a candidate
    // with nothing to review, so the header offers "Call candidate" there.
    // The confirmation lives on the Overview, and the tab switch is a router
    // transition that commits AFTER the click's render: opening the
    // confirmation in that render focused a button inside a still-`hidden`
    // panel, which a browser refuses, leaving focus on the header button.
    //
    // jsdom does not implement that refusal (it focuses anything focusable,
    // rendered or not), so this test adds it: focus() inside a `hidden`
    // subtree is a no-op, as it is in every browser.
    const realFocus = HTMLElement.prototype.focus;
    const focusSpy = vi
      .spyOn(HTMLElement.prototype, 'focus')
      .mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
        if (this.closest('[hidden]')) return;
        realFocus.call(this, options);
      });
    try {
      const user = userEvent.setup();
      mockApi.getCandidate.mockResolvedValue({ ...mockCandidateDetail, sessions: [], assessments: [] });
      renderDetailPage('candidate-1', '?tab=review');
      const header = await screen.findByRole('button', { name: 'Call candidate' });
      expect(reviewTab()).toHaveAttribute('aria-selected', 'true');

      await user.click(header);

      expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
      const dialog = await screen.findByRole('dialog', { name: 'Confirm phone screening' });
      await waitFor(() =>
        expect(within(dialog).getByRole('button', { name: 'Confirm call' })).toHaveFocus(),
      );
      expect(mockApi.requestCandidatePhoneCall).not.toHaveBeenCalled();

      // Escape still hands focus back to the header button that opened it.
      await user.keyboard('{Escape}');
      expect(header).toHaveFocus();
    } finally {
      focusSpy.mockRestore();
    }
  });

  it('keeps "Request re-screen" secondary: the header owns the one filled action', async () => {
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
    const rescreen = await screen.findByRole('button', { name: 'Request re-screen' });
    const primary = screen.getByRole('button', { name: 'Review screening' });
    // `bg-info` is the filled primary's paint (Button.tsx `variants.primary`).
    expect(primary.className.split(/\s+/)).toContain('bg-info');
    expect(rescreen.className.split(/\s+/)).not.toContain('bg-info');
  });

  it('offers no primary at all when there is nothing to review and no call to make', async () => {
    mockApi.getCandidate.mockResolvedValue({ ...mockCandidateDetail, sessions: [], assessments: [] });
    mockApi.getCandidatePhoneScreenings.mockResolvedValue({
      ok: true,
      enabled: false,
      cycles: [],
      current_cycle: null,
    });
    renderDetailPage();
    await screen.findByText('Phone screening is turned off.');
    expect(screen.queryByRole('button', { name: 'Call candidate' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review screening' })).not.toBeInTheDocument();
  });

  it('shows the status in words beside the name', async () => {
    mockApi.getCandidate.mockResolvedValue({
      ...mockCandidateDetail,
      candidate: { ...mockCandidateDetail.candidate, status: 'consent_declined' },
    });
    renderDetailPage();
    const heading = await screen.findByRole('heading', { level: 1, name: 'Jane Doe' });
    const header = heading.parentElement!;
    expect(within(header).getByText('Consent declined')).toHaveAttribute(
      'title',
      'Status: consent_declined',
    );
  });
});

describe('Human words for machine values', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.listRoles.mockResolvedValue([]);
    mockApi.getCandidate.mockResolvedValue(mockCandidateDetail);
    mockApi.getMe.mockResolvedValue({ userId: 'u-admin', email: null, role: 'admin', active: true });
    mockApi.getCandidatePhoneScreenings.mockResolvedValue({
      ok: true,
      enabled: true,
      cycles: [],
      current_cycle: null,
    });
    mockApi.getSession.mockResolvedValue(mockSessionDetail);
  });

  it('names appeals and their states in words, keeping the stored value in title', async () => {
    mockApi.listAppeals.mockResolvedValue({
      appeals: [{
        id: 'ap1',
        candidate_id: 'candidate-1',
        session_id: 'session-1',
        assessment_id: null,
        category: 'recording',
        description: 'Please disregard the first call.',
        status: 'under_review',
        created_at: '2026-09-16T04:30:00Z',
        updated_at: '2026-09-16T05:00:00Z',
      }],
    });
    renderDetailPage();
    const state = await screen.findByText('Under review');
    expect(state).toHaveAttribute('title', 'under_review');
    expect(screen.getByText('Recording appeal')).toBeInTheDocument();
    expect(screen.queryByText('under_review')).not.toBeInTheDocument();
  });

  it('formats the phone number, with the E.164 value one hover away', async () => {
    mockApi.getCandidate.mockResolvedValue({
      ...mockCandidateDetail,
      candidate: { ...mockCandidateDetail.candidate, phone_e164: '+919876543210' },
    });
    renderDetailPage();
    const phone = await screen.findByText('+91 98765 43210');
    expect(phone).toHaveAttribute('title', '+919876543210');
    expect(screen.queryByText('+919876543210')).not.toBeInTheDocument();
  });

  it('names appeal-grant sessions by when they happened, never by an id prefix', async () => {
    renderDetailPage();
    const select = await screen.findByRole('combobox', { name: 'Session' });
    const option = within(select).getAllByRole('option')[0];
    expect(option).toHaveValue('session-1');
    expect(option.textContent).not.toContain('session-');
    expect(option.textContent).toContain('Completed');
  });
});

describe('Ashby pipeline card on the Overview', () => {
  beforeEach(() => {
    mockApi.getCandidate.mockResolvedValue(mockCandidateDetail);
  });

  it('renders no card at all for a candidate with no Ashby workflow', async () => {
    // WAIT FOR THE ABSENCE, not for the request. `AshbyWorkflowCard` starts in
    // `phase: 'loading'` and deliberately renders this heading in EVERY
    // non-ready phase — it is one live region mounted once so a screen reader
    // announces the content swap rather than the region's arrival. It only
    // disappears when the fetch resolves to `phase: 'absent'` and the component
    // returns null.
    //
    // So asserting absence right after the CALL was made asserted it during
    // `loading`, when the heading is legitimately present. It passed whenever
    // the microtask queue happened to flush first and failed when it did not —
    // which is why it failed under `--coverage` (slower) while passing in the
    // plain run of the same CI job, and why it twice turned `main` red.
    mockApi.getCandidateAshbyWorkflow.mockResolvedValue({ ok: true, workflow: null });
    renderDetailPage();
    await screen.findByText('Jane Doe');
    // Still asserted: the card is absent because we ASKED and got nothing, not
    // because nothing ever asked.
    await waitFor(() => expect(mockApi.getCandidateAshbyWorkflow).toHaveBeenCalledWith('candidate-1'));
    await waitFor(() =>
      expect(screen.queryByText('Ashby screening pipeline')).not.toBeInTheDocument(),
    );
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
