/**
 * Shared test helpers: mock API, mock router wrapper, fixture data.
 *
 * All external data boundaries (API fetch, Supabase, LiveKit) are mocked
 * here. Tests import from this module rather than reaching for real network.
 */

import { type ReactElement } from 'react';
import { render, type RenderOptions } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';

/* ── Wrapper with MemoryRouter for page/component tests ───────────────── */

interface WrapperOptions {
  initialEntries?: string[];
}

export function createWrapper({ initialEntries }: WrapperOptions = {}) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <MemoryRouter initialEntries={initialEntries ?? ['/']}>
        {children}
      </MemoryRouter>
    );
  };
}

export function renderWithRouter(
  ui: ReactElement,
  options?: WrapperOptions & Omit<RenderOptions, 'wrapper'>,
) {
  const { initialEntries, ...rest } = options ?? {};
  return render(ui, { wrapper: createWrapper({ initialEntries }), ...rest });
}

/* ── Mock API ──────────────────────────────────────────────────────────── */

export type MockApi = ReturnType<typeof createMockApi>;

/**
 * Create a fully stubbed api object. Each method returns a resolved or
 * rejected promise. Tests can override individual methods after creation.
 */
export function createMockApi() {
  return {
    health: vi.fn().mockResolvedValue({ ok: true, model: 'mock-model' }),
    listRoles: vi.fn().mockResolvedValue([]),
    getRole: vi.fn().mockResolvedValue(null),
    createRole: vi.fn().mockResolvedValue({ id: 'mock-role-id' }),
    updateRole: vi.fn().mockResolvedValue({ id: 'mock-role-id' }),
    uploadResume: vi.fn().mockResolvedValue({
      candidate: { id: 'c1', name: 'Test Candidate' },
      resume: { id: 'r1', candidate_id: 'c1' },
      phone: { raw: '+1234567890', e164: '+1234567890', valid: true },
    }),
    listCandidates: vi.fn().mockResolvedValue([]),
    getCandidate: vi.fn().mockRejectedValue(new Error('not mocked')),
    startScreening: vi.fn().mockResolvedValue({ session_id: 's1', message: 'ok', done: false }),
    startLiveKitScreening: vi.fn().mockRejectedValue(new Error('not mocked')),
    uploadLiveKitRecording: vi.fn().mockResolvedValue({ recording_url: 'https://example.com/rec' }),
    turn: vi.fn().mockResolvedValue({ message: 'Thanks!', done: false, assessment: null }),
    getSession: vi.fn().mockRejectedValue(new Error('not mocked')),
    assess: vi.fn().mockResolvedValue({}),
    // MIG-06: On-demand recording download
    getRecordingDownloadUrl: vi.fn().mockResolvedValue({ url: 'https://example.com/recording' }),
  };
}

// Replace the api module with a mock.
// Tests that need the real import should mock 'app/web/src/api' in their file.

/* ── Fixture data ─────────────────────────────────────────────────────── */

export const mockRole = {
  id: 'role-1',
  title: 'Senior Frontend Engineer',
  jd: 'We need a React expert.',
  required_skills: ['React', 'TypeScript', 'CSS'],
  screening_template: [
    { id: 'q1', question: 'Tell me about your React experience.', weight: 1 },
    { id: 'q2', question: 'How do you handle state?', weight: 2 },
  ],
  is_active: true,
  created_at: '2026-01-01T00:00:00Z',
};

export const mockCandidate = {
  id: 'candidate-1',
  name: 'Jane Doe',
  email: 'jane@example.com',
  phone_e164: '+1234567890',
  phone_valid: true,
  skills: ['React', 'TypeScript', 'Node.js'],
  experience_years: 5,
  status: 'new',
  role_id: 'role-1',
  created_at: '2026-01-01T00:00:00Z',
};

export const mockSession = {
  id: 'session-1',
  candidate_id: 'candidate-1',
  role_id: 'role-1',
  status: 'completed',
  mode: 'simulation',
  recording_url: null,
  duration_sec: 360,
  created_at: '2026-06-01T00:00:00Z',
};

export const mockAssessment = {
  id: 'assess-1',
  overall_score: 78,
  recommendation: 'advance' as const,
  summary: 'Strong communication and good role fit.',
  tone: {
    clarity: 8,
    confidence: 7,
    professionalism: 9,
    sentiment: 'positive',
    notes: 'Professional and clear.',
  },
  role_fit: {
    score: 8,
    matched_skills: ['React', 'TypeScript'],
    gaps: ['GraphQL'],
    red_flags: [],
    notes: 'Good match.',
  },
  communication: {
    score: 7,
    notes: 'Clear communicator.',
  },
  motivation: {
    score: 6,
    notes: 'Showed genuine interest.',
  },
  raw: null,
};

export const mockCandidateDetail = {
  candidate: mockCandidate,
  sessions: [mockSession],
  assessments: [mockAssessment],
};

export const mockTranscript = [
  { speaker: 'bot' as const, text: 'Welcome to the screening.' },
  { speaker: 'candidate' as const, text: 'Thank you!' },
  { speaker: 'bot' as const, text: 'Tell me about your experience.' },
];

export const mockSessionDetail = {
  session: mockSession,
  transcript: mockTranscript,
  assessment: mockAssessment,
};
