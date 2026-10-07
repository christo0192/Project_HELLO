/**
 * Wire types for the R1 (WebRTC sales role-play) HR surfaces.
 *
 * Kept out of `types.ts` so the R1 lane stays one self-contained unit: the
 * routes they describe live in `app/api/src/routes/r1.ts` (PR-2) and
 * `r1-hr.ts` (PR-7). Every field the API may add later is optional here, so
 * an older or newer API never makes the page throw.
 */

/** `interview_rounds.status` (0115 CHECK). */
export type R1RoundStatus = 'invited' | 'in_progress' | 'completed' | 'expired' | 'cancelled';

/** `interview_rounds.recommendation` (0115 CHECK). Written by the scorer (PR-5). */
export type R1Recommendation = 'advance' | 'hold' | 'reject';

/** One row of `GET /api/candidates/:id/interview-rounds`. */
export interface R1Round {
  id: string;
  status: R1RoundStatus;
  expires_at: string;
  attempts_allowed: number;
  attempts_counted: number;
  /** Null until the scorer has produced a gated result (PR-5). */
  recommendation: R1Recommendation | null;
  /** 0-100, null until scored. */
  overall: number | null;
  created_at: string;
  created_by?: string;
}

export interface R1RoundsResponse {
  rounds: R1Round[];
}

/** The only body `POST /api/candidates/:id/interview-rounds` accepts. */
export interface R1SendInput {
  /** HR attests the candidate is located in India (D14). Must be literally true. */
  india_location_attested: true;
}

/** 201 body. `join_url` is returned exactly once; the server keeps only a digest. */
export interface R1SendResponse {
  id: string;
  status: R1RoundStatus;
  expires_at: string;
  join_url: string;
}

/** 200 body of `POST /api/interview-rounds/:id/reissue`. */
export interface R1ReissueResponse {
  id: string;
  join_url: string;
}

/** 200 body of `POST /api/interview-rounds/:id/{cancel,grant-retake}`. */
export interface R1OkResponse {
  ok: true;
}

/**
 * Why the Send R1 card is, or is not, usable. See `routes/r1-hr.ts`.
 * `not_deployed` is the API process's own `R1_ENABLED` being off; `disabled` is
 * the admin's database switch. Only the second is fixable in R1 settings.
 */
export type R1AvailabilityState =
  | 'ready'
  | 'not_deployed'
  | 'disabled'
  | 'paused'
  | 'capacity_exhausted'
  | 'role_not_configured'
  | 'config_invalid';

export interface R1AvailabilityResponse {
  state: R1AvailabilityState;
  /** Minutes a send reserves from the monthly allowance. */
  hold_minutes: number;
}

/** `r1_settings` singleton as returned by the admin routes. */
export interface R1Settings {
  enabled: boolean;
  paused: boolean;
  auto_status_enabled: boolean;
  monthly_cap_minutes: number;
  pause_line_minutes: number;
  admission_hold_minutes?: number;
  advance_threshold: number;
  hold_threshold: number;
  livekit_target: 'cloud' | 'r1';
  dashboard_minutes: number;
  dashboard_read_at: string | null;
  updated_at?: string;
  updated_by?: string | null;
}

/** The API process's own R1 switch (`R1_ENABLED`); the database switch is separate. */
export interface R1RuntimeStatus {
  enabled: boolean;
  status: 'enabled' | 'disabled' | 'invalid';
  reason?: string;
}

/** `GET /api/admin/r1/settings` (200) and `PUT` (200, without `runtime`). */
export interface R1SettingsResponse extends R1Settings {
  runtime?: R1RuntimeStatus;
}

/** The fields `PUT /api/admin/r1/settings` accepts; send only what changed. */
export type R1SettingsPatch = Partial<
  Pick<
    R1Settings,
    | 'enabled'
    | 'paused'
    | 'auto_status_enabled'
    | 'monthly_cap_minutes'
    | 'pause_line_minutes'
    | 'advance_threshold'
    | 'hold_threshold'
    | 'dashboard_minutes'
    | 'dashboard_read_at'
  >
>;

/**
 * `GET /api/admin/r1/usage`: the current UTC month.
 *
 * The capacity figures are the 0119 capacity snapshot's own (the one function
 * Send and admission also call), not a second formula:
 *  - `committed_minutes` is R1's committed minutes (the larger of the booked and
 *    the estimated minutes, plus the links held) against the R1 ALLOCATION,
 *    `monthly_cap_minutes`, in both LiveKit targets. `r1_headroom_minutes` is
 *    what is left of it.
 *  - `guard_minutes` is the shared Cloud pool (phone, legacy browser and R1),
 *    checked against `pause_line_minutes` ONLY when `pool_check_applies` (the
 *    cloud target, Mode B). On the r1 target (Mode A, self-hosted) R1 spends no
 *    Cloud minutes, so the pool figures are informational and gate nothing.
 *  - `sends_left` is the whole sends that fit now under the limits that apply.
 *
 * The fields added with the snapshot are optional here, so an older API never
 * makes the page throw.
 */
export interface R1UsageResponse {
  month_start: string;
  monthly_cap_minutes: number;
  pause_line_minutes: number;
  hold_minutes: number;
  dashboard_minutes: number;
  dashboard_read_at: string | null;
  minutes_reserved: number;
  minutes_used: number;
  starts_admitted: number;
  r1_minutes: number;
  phone_minutes: number;
  legacy_browser_minutes: number;
  estimated_minutes: number;
  /** R1 ledger minutes recorded at or after `dashboard_read_at`. Informational since 0119. */
  ledger_since_minutes: number;
  /** The shared Cloud pool as the snapshot guards it; informational on the r1 target. */
  guard_minutes: number;
  /** R1's committed minutes, against the R1 allocation (`monthly_cap_minutes`). */
  committed_minutes: number;
  /** Whole sends that still fit under the limits that apply (never negative). */
  sends_left: number;
  /** `cloud` is Mode B (the pause line gates the pool); `r1` is Mode A (self-hosted). */
  livekit_target?: 'cloud' | 'r1';
  /** True only on the cloud target; absent from an older API, which is read as true. */
  pool_check_applies?: boolean;
  /** The allocation less `committed_minutes`; negative when over it. */
  r1_headroom_minutes?: number;
  pool_committed_minutes?: number;
  /** The pause line less `pool_committed_minutes`; gates a send only on the cloud target. */
  pool_headroom_minutes?: number;
  runtime: R1RuntimeStatus;
}
