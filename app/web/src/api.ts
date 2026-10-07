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
  AdminAllowlistAddInput,
  AdminAllowlistAddResponse,
  AdminAllowlistListResponse,
  AdminAllowlistUpdateInput,
  AdminAllowlistUpdateResponse,
  AshbyMappingInput,
  AshbyMappingCreated,
  AshbyJobsResponse,
  AshbyMcMappingsResponse,
  AshbyMcWorkflowsResponse,
  AshbyMcActionResponse,
  AshbyMcArchiveResponse,
  AshbyManualInviteResponse,
  AshbyFeedbackFormResponse,
  AshbyScorecardBindingPreviewResponse,
  AshbyCandidateWorkflowResponse,
  AdminMaintenanceInput,
  AdminAuditListResponse,
  AdminMember,
  AdminMemberUpdateInput,
  AdminSessionListResponse,
  AdminSessionOverrideInput,
  FunnelSummaryResponse,
  FunnelFailuresResponse,
  FunnelCandidatesResponse,
  FunnelRefreshResponse,
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
  CandidatePreflightResult,
  CandidateDetail,
  CandidatePhoneAttemptsResponse,
  CandidatesSummary,
  CandidateInviteExchangeResponse,
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
  RoleDeleteResult,
  RoleInput,
  PhoneAppointmentCancelInput,
  PhoneAppointmentCreateInput,
  PhoneAppointmentPatchInput,
  PhoneAppointmentWriteResponse,
  PhoneCalendarResponse,
  PhoneCancelResponse,
  PhoneCandidateAppointmentCreateInput,
  PhoneCandidateAppointmentPatchInput,
  PhoneHaltClearResponse,
  PhoneHaltInput,
  PhoneHaltResponse,
  PhoneHealthResponse,
  PhoneRescreenInput,
  PhoneRescreenResponse,
  PhoneScreeningsResponse,
  PhoneVerificationInput,
  PhoneVerificationResponse,
  PhoneSlotsResponse,
  PutRoleScorecardInput,
  RedistributeWeightsInput,
  RedistributeWeightsResponse,
  RoleScorecardResponse,
  ScorecardMetricCreateInput,
  ScorecardMetricDraft,
  ScorecardMetricDraftInput,
  ScorecardMetricTemplate,
  ScorecardMetricUpdateInput,
  SessionDetail,
  StartLiveKitResult,
  StartScreeningResult,
  StatusTransitionResponse,
  TurnResult,
  UploadResumeResult,
  RoleDraftJob,
} from './types';
import type {
  R1AvailabilityResponse,
  R1OkResponse,
  R1ReissueResponse,
  R1RoundsResponse,
  R1SendInput,
  R1SendResponse,
  R1SettingsPatch,
  R1SettingsResponse,
  R1UsageResponse,
} from './lib/r1-types';

export { ApiError };

const request = apiClient.request;

export const api = {
  health: () => request<HealthResult>('/api/health'),

  // Phase 9: bounded public status + authoritative /api/me
  status: () => request<PublicStatus>('/api/status'),
  getMe: () => request<MeResponse>('/api/me'),

  // Roles
  listRoles: () => request<Role[]>('/api/roles'),
  /**
   * Ask Hello — START a drafting job. Returns as soon as the row exists.
   *
   * Three short calls instead of one ten-minute stream: the work outlives the
   * request, so a refresh picks it back up and a proxy idle timeout cannot
   * destroy it.
   */
  startRoleDraft: (jobRole: string) =>
    request<RoleDraftJob>('/api/roles/draft', {
      method: 'POST',
      body: JSON.stringify({ job_role: jobRole }),
    }),
  /**
   * The caller's live drafting job, if any.
   *
   * What a reload asks. The job id lives in component state and nowhere else,
   * so without this a refresh abandoned a running job that kept billing and
   * whose result no endpoint could name.
   */
  getActiveRoleDraft: () =>
    request<{ active: RoleDraftJob | null }>('/api/roles/draft'),
  getRoleDraft: (id: string) => request<RoleDraftJob>(`/api/roles/draft/${id}`),
  /** Stops the v4-pro spending, not just the spinner. */
  cancelRoleDraft: (id: string) =>
    request<{ cancelled: boolean }>(`/api/roles/draft/${id}/cancel`, { method: 'POST' }),
  /**
   * Rewrite one question so the phone gate will read it aloud.
   *
   * Synchronous, unlike drafting: one short sentence, one short generation,
   * no job row to poll. A 422 means the model tried twice and could not — the
   * caller shows that message rather than treating it as an outage.
   */
  rephraseQuestion: (question: string) =>
    request<{ question: string }>('/api/roles/questions/rephrase', {
      method: 'POST',
      body: JSON.stringify({ question }),
    }),
  /**
   * Remove a role. ARCHIVES it when candidates or sessions reference it.
   *
   * The caller must tell the operator WHICH happened — "gone from the list"
   * looks identical either way, and the difference decides whether they can
   * expect to find it again.
   */
  deleteRole: (id: string) =>
    request<RoleDeleteResult>(`/api/roles/${id}`, { method: 'DELETE' }),
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
  requestCandidatePhoneCall: (id: string) =>
    request<{ ok: true; status: 'requested' | 'already_requested' }>(
      `/api/candidates/${id}/phone-call`,
      { method: 'POST', body: JSON.stringify({ confirm: true }) },
    ),
  // 0114 (C8): lift a same-role duplicate-application hold. The server
  // resolves the held engagement from the candidate; nothing dials here.
  releaseCandidatePhoneDuplicateHold: (id: string) =>
    request<{ ok: true; status: 'released'; engagement_id: string; prerequisite_status: string | null }>(
      `/api/candidates/${encodeURIComponent(id)}/phone/release-duplicate-hold`,
      { method: 'POST', body: JSON.stringify({ confirm: true }) },
    ),
  getCandidatePhoneScreenings: (id: string) =>
    request<PhoneScreeningsResponse>(`/api/candidates/${encodeURIComponent(id)}/phone-cycles`),
  scheduleCandidatePhoneAppointment: (id: string, body: PhoneCandidateAppointmentCreateInput) =>
    request<PhoneAppointmentWriteResponse>(`/api/candidates/${encodeURIComponent(id)}/phone-appointments`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  rescheduleCandidatePhoneAppointment: (id: string, appointmentId: string, body: PhoneCandidateAppointmentPatchInput) =>
    request<PhoneAppointmentWriteResponse>(
      `/api/candidates/${encodeURIComponent(id)}/phone-appointments/${encodeURIComponent(appointmentId)}`,
      { method: 'PATCH', body: JSON.stringify(body) },
    ),
  cancelCandidatePhoneAppointment: (id: string, appointmentId: string, body: PhoneAppointmentCancelInput) =>
    request<PhoneCancelResponse>(
      `/api/candidates/${encodeURIComponent(id)}/phone-appointments/${encodeURIComponent(appointmentId)}`,
      { method: 'DELETE', body: JSON.stringify(body) },
    ),
  requestPhoneRescreen: (id: string, body: PhoneRescreenInput) =>
    request<PhoneRescreenResponse>(`/api/candidates/${encodeURIComponent(id)}/phone-rescreens`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  verifyCandidatePhone: (id: string, body: PhoneVerificationInput) =>
    request<PhoneVerificationResponse>(
      `/api/candidates/${encodeURIComponent(id)}/phone-number-verification`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  getCandidatesSummary: () =>
    request<CandidatesSummary>('/api/candidates/summary'),

  // ── R1 (WebRTC sales role-play): HR side ────────────────────────
  // Sends and lifecycle actions need interviewer or above (owner or admin);
  // reads need viewer. Settings and usage are admin-only. The API re-checks
  // the role and ownership on every request regardless of what is sent here.
  // `sendR1Round` and `reissueR1Round` return the candidate's join URL
  // exactly once: callers must hold it in memory only, never persist it.
  getR1Availability: () =>
    request<R1AvailabilityResponse>('/api/interview-rounds/availability'),
  listR1Rounds: (candidateId: string) =>
    request<R1RoundsResponse>(
      `/api/candidates/${encodeURIComponent(candidateId)}/interview-rounds`,
    ),
  sendR1Round: (candidateId: string, body: R1SendInput) =>
    request<R1SendResponse>(
      `/api/candidates/${encodeURIComponent(candidateId)}/interview-rounds`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  cancelR1Round: (roundId: string) =>
    request<R1OkResponse>(`/api/interview-rounds/${encodeURIComponent(roundId)}/cancel`, {
      method: 'POST',
    }),
  reissueR1Round: (roundId: string) =>
    request<R1ReissueResponse>(`/api/interview-rounds/${encodeURIComponent(roundId)}/reissue`, {
      method: 'POST',
    }),
  grantR1Retake: (roundId: string) =>
    request<R1OkResponse>(
      `/api/interview-rounds/${encodeURIComponent(roundId)}/grant-retake`,
      { method: 'POST' },
    ),
  getR1Settings: () => request<R1SettingsResponse>('/api/admin/r1/settings'),
  updateR1Settings: (patch: R1SettingsPatch) =>
    request<R1SettingsResponse>('/api/admin/r1/settings', {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
  getR1Usage: () => request<R1UsageResponse>('/api/admin/r1/usage'),

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
    // 200 → full CandidateInviteExchangeResult (join token). 202 → a
    // {status:'preparing'} body when on-demand orchestration could not confirm a
    // ready worker (design §2.3b B-i); the invite is not consumed, so the caller
    // shows "Preparing your interview…" and retries.
    request<CandidateInviteExchangeResponse>('/api/livekit/exchange', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),
  candidateLiveKitPreflight: (inviteToken: string) =>
    request<CandidatePreflightResult>('/api/livekit/preflight', {
      method: 'POST',
      body: JSON.stringify({ invite_token: inviteToken }),
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
  getAttemptRecordingDownloadUrl: (attemptId: string) =>
    request<RecordingDownloadResponse>(`/api/recordings/attempts/${attemptId}/download`),
  /**
   * `opts.sessionId` (M013 S02): only that session's legs (bound by consent
   * or by recording evidence), OLDEST first, as the Review tab lists them.
   */
  getCandidatePhoneAttempts: (
    candidateId: string,
    before?: string,
    opts?: { sessionId?: string; limit?: number },
  ) => {
    const query = new URLSearchParams();
    if (opts?.limit != null) query.set('limit', String(opts.limit));
    if (before) query.set('before', before);
    if (opts?.sessionId) query.set('session_id', opts.sessionId);
    const qs = query.toString();
    return request<CandidatePhoneAttemptsResponse>(
      `/api/candidates/${candidateId}/phone-attempts${qs ? `?${qs}` : ''}`,
    );
  },

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

  // ── Stakeholder report (built in the browser; this only records it) ──

  /** Fire-and-forget audit of a downloaded report: counts and a flag, never content. */
  exportReportAudit: (
    candidateId: string,
    body: { format: 'html'; recordings: number; transcript: boolean },
  ) =>
    request<void>(`/api/export/${encodeURIComponent(candidateId)}/report-audit`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

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
  /**
   * Recruiter-facing funnel summary (interviewer+). Same aggregation as the
   * admin read below — the dashboard KPIs must not be admin-only.
   */
  getScreeningFunnel: (params?: { from?: string; to?: string; role_id?: string }) => {
    const qs = new URLSearchParams();
    if (params?.from) qs.set('from', params.from);
    if (params?.to) qs.set('to', params.to);
    if (params?.role_id) qs.set('role_id', params.role_id);
    const q = qs.toString();
    return request<FunnelSummaryResponse>(`/api/funnel/summary${q ? `?${q}` : ''}`);
  },
  // Funnel observability (0090 / PR2) — admin-gated reads of the derived
  // funnel views + stored rollup, plus an on-demand rollup recompute.
  getFunnelSummary: (params?: { from?: string; to?: string; role_id?: string }) => {
    const qs = new URLSearchParams();
    if (params?.from) qs.set('from', params.from);
    if (params?.to) qs.set('to', params.to);
    if (params?.role_id) qs.set('role_id', params.role_id);
    const q = qs.toString();
    return request<FunnelSummaryResponse>(`/api/admin/funnel/summary${q ? `?${q}` : ''}`);
  },
  listFunnelFailures: (params?: { stage?: string; from?: string; to?: string; limit?: number }) => {
    const qs = new URLSearchParams();
    if (params?.stage) qs.set('stage', params.stage);
    if (params?.from) qs.set('from', params.from);
    if (params?.to) qs.set('to', params.to);
    if (params?.limit != null) qs.set('limit', String(params.limit));
    const q = qs.toString();
    return request<FunnelFailuresResponse>(`/api/admin/funnel/failures${q ? `?${q}` : ''}`);
  },
  listFunnelCandidates: (params?: {
    role_id?: string;
    furthest_stage?: string;
    drop_reason?: string;
    limit?: number;
    offset?: number;
  }) => {
    const qs = new URLSearchParams();
    if (params?.role_id) qs.set('role_id', params.role_id);
    if (params?.furthest_stage) qs.set('furthest_stage', params.furthest_stage);
    if (params?.drop_reason) qs.set('drop_reason', params.drop_reason);
    if (params?.limit != null) qs.set('limit', String(params.limit));
    if (params?.offset != null) qs.set('offset', String(params.offset));
    const q = qs.toString();
    return request<FunnelCandidatesResponse>(`/api/admin/funnel/candidates${q ? `?${q}` : ''}`);
  },
  refreshFunnel: (windowDays?: number) =>
    request<FunnelRefreshResponse>('/api/admin/funnel/refresh', {
      method: 'POST',
      body: JSON.stringify(windowDays != null ? { window_days: windowDays } : {}),
    }),
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
  // `limit=200` — the route's maximum. Its default is 50, and the Add-mapping
  // picker marks a job "already mapped" only if its mapping is in this list;
  // a mapping past a short page would read as free and 409 on save.
  listAshbyMappings: () =>
    request<AshbyMcMappingsResponse>('/api/integrations/ashby/mission-control/mappings?limit=200'),
  listAshbyWorkflows: () =>
    request<AshbyMcWorkflowsResponse>('/api/integrations/ashby/mission-control/workflows'),
  /**
   * The live Ashby job list (admin-gated server side): every status,
   * confidential jobs already removed. The add-mapping dialog offers only the
   * `Open` ones; the mapping rows use all of them to name a job instead of
   * showing its id. A live provider read, so callers treat it as best effort.
   */
  listAshbyJobs: () =>
    request<AshbyJobsResponse>('/api/integrations/ashby/mission-control/jobs'),
  /**
   * Create (or update) an Ashby job -> role mapping. ALWAYS lands paused.
   *
   * The endpoint has existed since the integration shipped and nothing called
   * it, so the only way to point a new Ashby job at a HELLO role was a hand
   * -rolled authenticated POST. Enabling stays a separate action, still gated
   * in the database on stage completeness and absence of drift.
   *
   * Refusals THROW `ApiError` with the route's code as the message — among
   * them 409 `conflict` (the job already has a live mapping) and 409
   * `archived` (an update addressed to a deleted mapping).
   */
  createAshbyMapping: (body: AshbyMappingInput) =>
    request<AshbyMappingCreated>('/api/integrations/ashby/mission-control/mappings', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
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
  /**
   * "Delete" a mapping: the route ARCHIVES it — gone from the list, history
   * kept and frozen. Adding the same job again later creates a NEW mapping,
   * paused; the archived one is never brought back. The database
   * refuses an ENABLED mapping (`mapping_enabled`, 409); pause it first.
   * Every refusal throws `ApiError` with the route's code as its message.
   */
  archiveAshbyMapping: (id: string) =>
    request<AshbyMcArchiveResponse>(`/api/integrations/ashby/mission-control/mappings/${id}/archive`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  previewAshbyBacklog: (id: string) =>
    request<import('./types').AshbyBacklogPreviewResponse>(`/api/integrations/ashby/mission-control/mappings/${id}/backlog/preview`, {
      method: 'POST', body: JSON.stringify({}),
    }),
  confirmAshbyBacklog: (id: string, runId: string, expectedCount: number) =>
    request<import('./types').AshbyBacklogConfirmResponse>(`/api/integrations/ashby/mission-control/mappings/${id}/backlog/confirm`, {
      method: 'POST', body: JSON.stringify({ run_id: runId, expected_count: expectedCount }),
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
  /**
   * Read-only preview of the v2 scorecard binding for one mapping's role
   * (issue #275): which dashboard metrics would land on which form Score
   * field, by name. Structure only; nothing is written or bound by viewing it.
   */
  previewAshbyScorecardBinding: (mappingId: string) =>
    request<AshbyScorecardBindingPreviewResponse>(
      `/api/integrations/ashby/mission-control/mappings/${encodeURIComponent(mappingId)}/scorecard-binding`,
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

  // ── Ashby candidate-scoped workflow card (read-only) ─────────────
  // Two addresses, ONE projection and one access rule. The normal candidate
  // page knows the candidate id; the scoped review shell only ever knows the
  // opaque application link, and the API resolves the candidate from it
  // server-side under the identical role + interviewer-ownership check.
  getCandidateAshbyWorkflow: (candidateId: string) =>
    request<AshbyCandidateWorkflowResponse>(
      `/api/candidates/${encodeURIComponent(candidateId)}/ashby-workflow`,
    ),
  getAshbyScopedReviewWorkflow: (applicationLinkId: string) =>
    request<AshbyCandidateWorkflowResponse>(
      `/api/integrations/ashby/review/${encodeURIComponent(applicationLinkId)}/workflow`,
    ),

  retryAshbyOperation: (id: string) =>
    request<AshbyMcActionResponse>(`/api/integrations/ashby/mission-control/operations/${id}/retry`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  // ── P7: internal phone screening calendar ────────────────────────
  // Exact P6 contracts. Reads need interviewer or above; every mutation
  // needs admin, and the API re-checks both on every request regardless of
  // what this client sends.
  //
  // ABORT SIGNALS AND WHY THE CALLER STILL NEEDS A STALE LATCH:
  // `signal` is forwarded into `fetch` through `init`. But `request` wraps
  // EVERY fetch rejection — an abort included — into
  // `ApiError('Could not reach the server…', 0)`, so an aborted request is
  // indistinguishable from a genuine network failure by its error alone. A
  // caller that renders errors must therefore keep its own "this effect is
  // stale" latch and drop the result before inspecting it; the signal is
  // only there to stop the request travelling, never to classify it.

  getPhoneCalendar: (from: string, to: string, signal?: AbortSignal) =>
    request<PhoneCalendarResponse>(
      `/api/phone/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      { signal },
    ),

  getPhoneSlots: (date: string, signal?: AbortSignal) =>
    request<PhoneSlotsResponse>(
      `/api/phone/calendar/slots?date=${encodeURIComponent(date)}`,
      { signal },
    ),

  createPhoneAppointment: (input: PhoneAppointmentCreateInput) =>
    request<PhoneAppointmentWriteResponse>('/api/phone/appointments', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  reschedulePhoneAppointment: (id: string, input: PhoneAppointmentPatchInput) =>
    request<PhoneAppointmentWriteResponse>(
      `/api/phone/appointments/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify(input) },
    ),

  // DELETE carries a body here because the substrate requires BOTH the
  // operator's reason and the optimistic-concurrency version, and neither
  // belongs in a URL: the reason is audit content and the version is a
  // precondition, not an address.
  cancelPhoneAppointment: (id: string, input: PhoneAppointmentCancelInput) =>
    request<PhoneCancelResponse>(
      `/api/phone/appointments/${encodeURIComponent(id)}`,
      { method: 'DELETE', body: JSON.stringify(input) },
    ),

  // ── The phone admission kill switch (operator halt) ──────────────
  // Health is interviewer or above; both writes are admin-only, and the API
  // re-checks the role on every request. Health answers 200 even when the
  // phone lane is degraded or disabled — `admission` is then null — so a
  // caller must read the BODY, not the status, to know whether the switch
  // could be described. `clearPhoneHalt` must send the reason currently in
  // force; any other answers 409 `halt_reason_mismatch`.
  getPhoneHealth: () => request<PhoneHealthResponse>('/api/phone/health'),

  setPhoneHalt: (input: PhoneHaltInput) =>
    request<PhoneHaltResponse>('/api/phone/halt', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  clearPhoneHalt: (input: PhoneHaltInput) =>
    request<PhoneHaltClearResponse>('/api/phone/halt/clear', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  // ── Scorecards (Phase 3) ─────────────────────────────────────────
  // Metric LIBRARY ("Scorebar") is admin-only server-side; GET returns a bare
  // array of snake_case rows. Role scorecard reads need interviewer+ (owner of
  // the role, admin all) and return camelCase domain objects. The API re-checks
  // the role and role-ownership on every request regardless of what is sent.

  listScorecardMetrics: () =>
    request<ScorecardMetricTemplate[]>('/api/scorecards/metrics'),
  createScorecardMetric: (body: ScorecardMetricCreateInput) =>
    request<ScorecardMetricTemplate>('/api/scorecards/metrics', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateScorecardMetric: (id: string, body: ScorecardMetricUpdateInput) =>
    request<ScorecardMetricTemplate>(`/api/scorecards/metrics/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  archiveScorecardMetric: (id: string) =>
    request<ScorecardMetricTemplate>(`/api/scorecards/metrics/${encodeURIComponent(id)}/archive`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  /**
   * Ask Hello: draft a metric's scoring instruction and 1-4 rubric from its
   * name and description. Synchronous, like `rephraseQuestion`, and it SAVES
   * NOTHING — the caller fills the form and the admin still presses Create. A
   * 422 carries operator-facing copy in its message; 429 means the strict
   * model-invoking bucket is empty.
   */
  draftMetricRubric: (body: ScorecardMetricDraftInput) =>
    request<ScorecardMetricDraft>('/api/scorecards/metrics/draft', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  getRoleScorecard: (roleId: string) =>
    request<RoleScorecardResponse>(
      `/api/scorecards/roles/${encodeURIComponent(roleId)}/scorecard`,
    ),
  putRoleScorecard: (roleId: string, body: PutRoleScorecardInput) =>
    request<RoleScorecardResponse>(
      `/api/scorecards/roles/${encodeURIComponent(roleId)}/scorecard`,
      { method: 'PUT', body: JSON.stringify(body) },
    ),
  redistributeRoleScorecardWeights: (roleId: string, body: RedistributeWeightsInput) =>
    request<RedistributeWeightsResponse>(
      `/api/scorecards/roles/${encodeURIComponent(roleId)}/scorecard/redistribute`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
};
