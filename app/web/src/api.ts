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
  ConsentCheckResponse,
  ConsentSubmitInput,
  ConsentSubmitResponse,
  ConsentStatusResponse,
  ConsentTemplateResponse,
  ConsentType,
  ConsentWithdrawInput,
  ConsentWithdrawResponse,
  HealthResult,
  RecordingDownloadResponse,
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

  // MIG-06: On-demand recruiter recording download URL
  getRecordingDownloadUrl: (sessionId: string) =>
    request<RecordingDownloadResponse>(`/api/recordings/${sessionId}/download`),

  // ── Consent routes (GOV-03/GOV-08/GOV-09/GOV-10) ─────────────────

  /** Submit consent (accept or decline specific consent types). */
  submitConsent: (body: ConsentSubmitInput) =>
    request<ConsentSubmitResponse>('/api/consent/submit', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** Get candidate's current consent status. */
  getConsentStatus: (candidateId: string) =>
    request<ConsentStatusResponse>(`/api/consent/${candidateId}/status`),

  /** Check if candidate has granted required consent types (GOV-10). */
  checkConsent: (candidateId: string, required: ConsentType[]) =>
    request<ConsentCheckResponse>('/api/consent/check', {
      method: 'POST',
      body: JSON.stringify({ candidate_id: candidateId, required }),
    }),

  /** Withdraw previously granted consent (GOV-09). */
  withdrawConsent: (body: ConsentWithdrawInput) =>
    request<ConsentWithdrawResponse>('/api/consent/withdraw', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** Get active privacy notice templates (GOV-08). */
  getConsentTemplates: () =>
    request<ConsentTemplateResponse[]>('/api/consent/templates'),
};
