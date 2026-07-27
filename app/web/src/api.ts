import type {
  Assessment,
  Candidate,
  CandidateDetail,
  HealthResult,
  Role,
  RoleInput,
  SessionDetail,
  StartLiveKitResult,
  StartScreeningResult,
  TurnResult,
  UploadResumeResult,
} from "./types";

const BASE_URL = import.meta.env.VITE_API_BASE ?? "http://localhost:8787";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function parseError(res: Response): Promise<never> {
  let message = `${res.status} ${res.statusText}`;
  try {
    const data = (await res.json()) as { error?: string; message?: string };
    if (data?.error) message = data.error;
    else if (data?.message) message = data.message;
  } catch {
    // ignore non-JSON error bodies
  }
  throw new ApiError(message, res.status);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: {
        ...(init?.body && !(init.body instanceof FormData)
          ? { "Content-Type": "application/json" }
          : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError(
      "Could not reach the server. Is the API running on " + BASE_URL + "?",
      0,
    );
  }
  if (!res.ok) return parseError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  health: () => request<HealthResult>("/api/health"),

  // Roles
  listRoles: () => request<Role[]>("/api/roles"),
  getRole: (id: string) => request<Role>(`/api/roles/${id}`),
  createRole: (body: RoleInput) =>
    request<Role>("/api/roles", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateRole: (id: string, body: Partial<RoleInput>) =>
    request<Role>(`/api/roles/${id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),

  // Resumes / candidates
  uploadResume: (file: File, roleId?: string) => {
    const form = new FormData();
    form.append("file", file);
    if (roleId) form.append("role_id", roleId);
    return request<UploadResumeResult>("/api/resumes", {
      method: "POST",
      body: form,
    });
  },
  listCandidates: (roleId?: string) =>
    request<Candidate[]>(
      `/api/candidates${roleId ? `?role_id=${encodeURIComponent(roleId)}` : ""}`,
    ),
  getCandidate: (id: string) =>
    request<CandidateDetail>(`/api/candidates/${id}`),

  // Screening
  startScreening: (candidateId: string) =>
    request<StartScreeningResult>("/api/screening/start", {
      method: "POST",
      body: JSON.stringify({ candidate_id: candidateId }),
    }),
  startLiveKitScreening: (candidateId: string) =>
    request<StartLiveKitResult>("/api/livekit/start", {
      method: "POST",
      body: JSON.stringify({ candidate_id: candidateId }),
    }),
  uploadLiveKitRecording: (sessionId: string, blob: Blob) => {
    const form = new FormData();
    const ext = blob.type.includes("mpeg")
      ? "mp3"
      : blob.type.includes("mp4")
        ? "mp4"
        : "webm";
    form.append("file", blob, `${sessionId}.${ext}`);
    return request<{ recording_url: string }>(
      `/api/livekit/${sessionId}/recording`,
      {
        method: "POST",
        body: form,
      },
    );
  },
  turn: (sessionId: string, text: string) =>
    request<TurnResult>(`/api/screening/${sessionId}/turn`, {
      method: "POST",
      body: JSON.stringify({ text }),
    }),
  getSession: (sessionId: string) =>
    request<SessionDetail>(`/api/screening/${sessionId}`),
  assess: (sessionId: string) =>
    request<Assessment>(`/api/assess/${sessionId}`, { method: "POST" }),
};
