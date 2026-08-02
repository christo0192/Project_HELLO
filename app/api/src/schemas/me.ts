/**
 * GET /api/me response shape — recruiter-authenticated ONLY (never public).
 * Returns the current validated JWT email plus the authoritative membership
 * role/active (from the membership resolver threaded through requireAuth).
 */
export interface MeResponse {
  userId: string;
  email: string | null;
  role: 'admin' | 'interviewer' | 'viewer';
  active: boolean;
}
