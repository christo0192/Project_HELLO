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
import { supabase } from './lib/supabase';
import type {
  AdminAllowlistAddInput,
  AdminAllowlistAddResponse,
  AdminAllowlistListResponse,
  AdminAllowlistUpdateInput,
  AdminAllowlistUpdateResponse,
  AshbyMcMappingsResponse,
  AshbyMcWorkflowsResponse,
  AshbyMcActionResponse,
  AshbyManualInviteResponse,
  AshbyFeedbackFormResponse,
  AdminMaintenanceInput,
  AdminAuditListResponse,
  AdminMember,
  AdminMemberUpdateInput,
  AdminSessionListResponse,
  AdminSessionOverrideInput,
  AppealCreateInput,
  AppealCreateResponse,
  AppealGrantResult,
  AppealListResponse,
  AppealReviewInput,
  Assessment,
  Candidate,
  CandidateConsentStatus,
  CandidateConsentStatusInput,
  CandidateConsentSubmitInput,
  CandidateConsentSubmitResponse,
  CandidateConsentTemplate,
  CandidateDetail,
  CandidatesSummary,
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
  MeResponse,
  Note,
  NoteListResponse,
  NotificationIntentListResponse,
  PublicStatus,
  QuotaPolicyInput,
  QuotaPolicyListResponse,
  QuotaPolicyMutationResponse,
  RecordingDownloadResponse,
  Role,
  RoleInput,
  SessionDetail,
  StartLiveKitResult,
  StartScreeningResult,
  StatusTransitionResponse,
  TurnResult,
  UploadResumeResult,
} from './types';

export { ApiError };

const request = apiClient.request;
const BASE_URL = apiClient.BASE_URL;

/**
 * Fetch a raw text resource (CSV export) with the same in-memory bearer
 * token attachment as apiClient. Never stores the token; the CSV text is
 * returned to the caller which triggers a same-tab download.
 */
async function requestText(path: string, init?: RequestInit): Promise<string> {
  let token: string | null = null;
  try {
    const result = await supabase.auth.getSession();
    token = result?.data?.session?.access_token ?? null;
  } catch {
    token = null;
  }
  const headers: Record<string, string> = {
    Accept: 'text/csv',
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers });
  if (res.status === 401) {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('auth:unauthorized'));
    }
  }
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const data = (await res.json()) as { error?: unknown; message?: unknown };
      if (typeof data?.error === 'string' && data.error.trim()) {
        message = data.error;
      } else if (data?.error && typeof data.error === 'object') {
        const nested = data.error as { message?: unknown; type?: unknown };
        if (typeof nested.message === 'string' && nested.message.trim()) {
          message = nested.message;
        } else if (typeof nested.type === 'string' && nested.type.trim()) {
          message = nested.type;
        }
      } else if (typeof data?.message === 'string' && data.message.trim()) {
        message = data.message;
      }
    } catch {
      // non-JSON error body
    }
    throw new ApiError(message, res.status);
  }
  return res.text();
}

export const api = {
  health: () => request<HealthResult>('/api/health'),

  // Phase 9: bounded public status + authoritative /api/me
  status: () => request<PublicStatus>('/api/status'),
  getMe: () => request<MeResponse>('/api/me'),

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
  getCandidatesSummary: () =>
    request<CandidatesSummary>('/api/candidates/summary'),

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
  /**
   * Signal that the candidate's screening is over.
   *
   * `keepalive: true` is a MITIGATION, not the mechanism. A browser that is
   * being torn down (tab close, navigation, backgrounded mobile app) will
   * cancel an ordinary in-flight fetch, and this call was the only thing that
   * completed the session and finalized the recording from the client side.
   * `keepalive` lets the request survive the unload.
   *
   * It is explicitly not load-bearing: the server-side convergence path (the
   * 0038 terminal-transition trigger + finalize worker + sweeper) must remain
   * correct with this call deleted entirely, and the API suite asserts exactly
   * that. Treat this as shortening the common-case latency, never as the
   * reason the recording converges.
   */
  completeCandidateScreening: (sessionId: string, grantToken: string) =>
    request<{
      status: string;
      recording_status?: 'ready' | 'fallback_required' | 'pending';
    }>(`/api/livekit/${sessionId}/complete`, {
      method: 'POST',
      headers: { 'x-grant-token': grantToken },
      keepalive: true,
    }),
  uploadCandidateRecording: (sessionId: string, grantToken: string, blob: Blob) => {
    const form = new FormData();
    form.append('file', blob, 'screening.webm');
    return request<{ ok: true; object_key: string; sha256: string }>(
      `/api/livekit/${sessionId}/recording`,
      {
        method: 'POST',
        headers: { 'x-grant-token': grantToken },
        body: form,
      },
    );
  },
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

  // ── Phase 9: candidate pre-join consent (invite-opaque, public) ──

  /** Bounded consent/template status for an opaque invite token. */
  candidateConsentStatus: (body: CandidateConsentStatusInput) =>
    request<CandidateConsentStatus>('/api/candidate-consent/status', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** Active Legal-approved consent template for a bounded locale. */
  getCandidateConsentTemplate: (locale: string) =>
    request<CandidateConsentTemplate>(
      `/api/candidate-consent/template?locale=${encodeURIComponent(locale)}`,
    ),

  /** Append-only consent grant/decline bound to the invite (never consumes it). */
  submitCandidateConsent: (body: CandidateConsentSubmitInput) =>
    request<CandidateConsentSubmitResponse>('/api/candidate-consent/submit', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // ── Phase 9: recruiter notes + status transitions ────────────────

  listNotes: (candidateId: string) =>
    request<NoteListResponse>(
      `/api/notes?candidate_id=${encodeURIComponent(candidateId)}`,
    ),
  addNote: (candidateId: string, note: string) =>
    request<Note>('/api/notes', {
      method: 'POST',
      body: JSON.stringify({ candidate_id: candidateId, note }),
    }),
  updateCandidateStatus: (candidateId: string, status: string) =>
    request<StatusTransitionResponse>(`/api/notes/${candidateId}/status`, {
      method: 'POST',
      body: JSON.stringify({ status }),
    }),

  // ── Phase 9: notification intents ────────────────────────────────

  listNotificationIntents: () =>
    request<NotificationIntentListResponse>('/api/notifications'),

  // ── Phase 9: CSV scorecard export (ownership-scoped) ─────────────

  exportCsv: (candidateId: string) => requestText(`/api/export/${candidateId}/csv`),

  // ── Phase 9: appeals ─────────────────────────────────────────────

  listAppeals: (candidateId: string) =>
    request<AppealListResponse>(
      `/api/appeals?candidate_id=${encodeURIComponent(candidateId)}`,
    ),
  issueAppealGrant: (candidateId: string, sessionId: string, expiresInHours: number) =>
    request<AppealGrantResult>('/api/appeals/grants', {
      method: 'POST',
      body: JSON.stringify({
        candidate_id: candidateId,
        session_id: sessionId,
        expires_in_hours: expiresInHours,
      }),
    }),
  submitAppeal: (body: AppealCreateInput) =>
    request<AppealCreateResponse>('/api/appeals', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  reviewAppeal: (appealId: string, body: AppealReviewInput) =>
    request<{ ok: boolean }>(`/api/appeals/${appealId}/review`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // ── Phase 9: admin operations ────────────────────────────────────

  listAdminMembers: () => request<AdminMember[]>('/api/admin/members'),
  updateAdminMember: (userId: string, body: AdminMemberUpdateInput) =>
    request<{ ok: boolean }>(`/api/admin/members/${userId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  toggleMaintenance: (body: AdminMaintenanceInput) =>
    request<{ ok: boolean; enabled: boolean }>('/api/admin/maintenance', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  overrideSession: (sessionId: string, body: AdminSessionOverrideInput) =>
    request<{ ok: boolean; prior_status?: string | null }>(
      `/api/admin/sessions/${sessionId}/override`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    ),
  // Phase 9 review repair (OPS-01/OPS-05): admin audit / session / quota views
  listAdminAudit: (limit = 50, offset = 0) =>
    request<AdminAuditListResponse>(
      `/api/admin/audit?limit=${limit}&offset=${offset}`,
    ),
  listAdminSessions: (status?: string) =>
    request<AdminSessionListResponse>(
      `/api/admin/sessions${status ? `?status=${encodeURIComponent(status)}` : ''}`,
    ),
  listAdminQuotas: () => request<QuotaPolicyListResponse>('/api/admin/quotas'),
  createQuotaPolicy: (body: QuotaPolicyInput) =>
    request<QuotaPolicyMutationResponse>('/api/admin/quotas', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateQuotaPolicy: (id: string, body: QuotaPolicyInput) =>
    request<QuotaPolicyMutationResponse>(`/api/admin/quotas/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  // ── HELLO access allowlist (0016): normalized-email access gate ────
  listAdminAllowlist: () => request<AdminAllowlistListResponse>('/api/admin/allowlist'),
  addAdminAllowlistEntry: (body: AdminAllowlistAddInput) =>
    request<AdminAllowlistAddResponse>('/api/admin/allowlist', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateAdminAllowlistEntry: (id: string, body: AdminAllowlistUpdateInput) =>
    request<AdminAllowlistUpdateResponse>(`/api/admin/allowlist/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  // ── Ashby Mission Control ────────────────────────────────────────
  listAshbyMappings: () =>
    request<AshbyMcMappingsResponse>('/api/integrations/ashby/mission-control/mappings'),
  listAshbyWorkflows: () =>
    request<AshbyMcWorkflowsResponse>('/api/integrations/ashby/mission-control/workflows'),
  pauseAshbyMapping: (id: string, reason?: string) =>
    request<AshbyMcActionResponse>(`/api/integrations/ashby/mission-control/mappings/${id}/pause`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  resumeAshbyMapping: (id: string) =>
    request<AshbyMcActionResponse>(`/api/integrations/ashby/mission-control/mappings/${id}/resume`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  cancelAshbyWorkflow: (id: string, terminalState: string, reason?: string) =>
    request<AshbyMcActionResponse>(`/api/integrations/ashby/mission-control/workflows/${id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ terminal_state: terminalState, reason }),
    }),
  /**
   * Issue a usable manual invite link. The response body carries a one-time
   * token in `join_url`'s fragment; the caller must keep it in memory only.
   */
  deliverAshbyManualInvite: (id: string) =>
    request<AshbyManualInviteResponse>(`/api/integrations/ashby/mission-control/workflows/${id}/invite`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  /**
   * Read-only feedback-form SCHEMA discovery for one job (admin-gated server
   * side). Structure only — this never returns feedback content, and viewing
   * it binds nothing.
   */
  discoverAshbyFeedbackForm: (externalJobId: string) =>
    request<AshbyFeedbackFormResponse>(
      `/api/integrations/ashby/mission-control/jobs/${encodeURIComponent(externalJobId)}/feedback-form`,
    ),
  // ── Ashby candidate-scoped review ────────────────────────────────
  // Purpose-built READ endpoints. The candidate/session are resolved
  // server-side from the opaque application link id; no candidate id, email,
  // or token ever appears in these URLs.
  getAshbyScopedReview: (applicationLinkId: string) =>
    request<CandidateDetail>(
      `/api/integrations/ashby/review/${encodeURIComponent(applicationLinkId)}`,
    ),
  listAshbyScopedReviewNotes: (applicationLinkId: string) =>
    request<NoteListResponse>(
      `/api/integrations/ashby/review/${encodeURIComponent(applicationLinkId)}/notes`,
    ),

  retryAshbyOperation: (id: string) =>
    request<AshbyMcActionResponse>(`/api/integrations/ashby/mission-control/operations/${id}/retry`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
};
