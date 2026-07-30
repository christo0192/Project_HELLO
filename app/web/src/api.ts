/**
 * API surface for the Maya Screen recruiter dashboard.
 *
 * All requests are routed through `apiClient` which attaches the
 * Supabase bearer access token from the in-memory session.  No token
 * copy is stored in localStorage/sessionStorage/cookies by this module.
 *
 * 401 responses dispatch an `auth:unauthorized` custom event that the
 * AuthProvider listens for to clear the session and force re-login.
 */

import { apiClient, ApiError } from './lib/api-client';
import type {
  Assessment,
  Candidate,
  CandidateDetail,
  CandidateInviteExchangeResult,
  CandidateInviteResult,
  HealthResult,
  Role,
  RoleInput,
  SessionDetail,
  StartLiveKitResult,
  StartScreeningResult,
  TurnResult,
  UploadResumeResult,
} from './types';

export { ApiError };

const request = apiClient.request;

export const api = {
  health: () => request<HealthResult>('/api/health'),

  // Roles
  listRoles: () => request<Role[]>('/api/roles'),
  getRole: (id: string) => request<Role>(`/api/roles/${id}`),
  createRole: (body: RoleInput) =>
    request<Role>('/api/roles', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateRole: (id: string, body: Partial<RoleInput>) =>
    request<Role>(`/api/roles/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  // Resumes / candidates
  uploadResume: (file: File, roleId?: string) => {
    const form = new FormData();
    form.append('file', file);
    if (roleId) form.append('role_id', roleId);
    return request<UploadResumeResult>('/api/resumes', {
      method: 'POST',
      body: form,
    });
  },
  listCandidates: (roleId?: string) =>
    request<Candidate[]>(
      `/api/candidates${roleId ? `?role_id=${encodeURIComponent(roleId)}` : ''}`,
    ),
  getCandidate: (id: string) =>
    request<CandidateDetail>(`/api/candidates/${id}`),

  // Screening
  startScreening: (candidateId: string) =>
    request<StartScreeningResult>('/api/screening/start', {
      method: 'POST',
      body: JSON.stringify({ candidate_id: candidateId }),
    }),
  startLiveKitScreening: (candidateId: string) =>
    request<StartLiveKitResult>('/api/livekit/start', {
      method: 'POST',
      body: JSON.stringify({ candidate_id: candidateId }),
    }),
  issueLiveKitInvite: (candidateId: string, sessionId: string) =>
    request<CandidateInviteResult>('/api/livekit/invite', {
      method: 'POST',
      body: JSON.stringify({ candidate_id: candidateId, session_id: sessionId }),
    }),
  exchangeCandidateInvite: (token: string) =>
    request<CandidateInviteExchangeResult>('/api/livekit/exchange', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),
  turn: (sessionId: string, text: string) =>
    request<TurnResult>(`/api/screening/${sessionId}/turn`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
  getSession: (sessionId: string) =>
    request<SessionDetail>(`/api/screening/${sessionId}`),
  assess: (sessionId: string) =>
    request<Assessment>(`/api/assess/${sessionId}`, { method: 'POST' }),
};
