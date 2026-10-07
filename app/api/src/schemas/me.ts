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
  /**
   * PR-L: whether the legacy browser screening lane is still enabled
   * (LEGACY_BROWSER_SCREENING_ENABLED). The web hides the legacy "Browser voice
   * screening" card when this is `false`. Clients must treat an absent value as
   * enabled so an older API never hides the card.
   */
  legacyBrowserScreeningEnabled: boolean;
}
