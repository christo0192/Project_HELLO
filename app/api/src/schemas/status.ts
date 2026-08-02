/**
 * GET /api/status response shape — bounded operational/maintenance/degraded
 * state only. Deliberately excludes model/provider/internal dependencies.
 */
export interface PublicStatusResponse {
  status: 'ok' | 'maintenance' | 'degraded';
  maintenance: {
    enabled: boolean;
    reason: string | null;
    updated_at: string | null;
  } | null;
  updated_at: string;
}
