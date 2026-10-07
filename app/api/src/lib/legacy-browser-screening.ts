/**
 * Retirement of the legacy browser screening lane (R1 plan section 8.5, PR-L, D12).
 *
 * The legacy lane is the recruiter-created browser invite flow:
 *   POST /api/livekit/start      creates a legacy browser session + room
 *   POST /api/livekit/invite     mints the one-time candidate invite
 *   POST /api/livekit/preflight  candidate microphone check for that invite
 *   POST /api/livekit/exchange   candidate invite -> grant + join token
 *   POST /api/candidate-consent/status and /submit   the join page's consent step
 * plus the Ashby Mission Control manual invite delivery, which mints the same
 * kind of invite, and the Ashby invite_delivery operation worker, which would
 * materialize a browser session and invite.
 *
 * One switch, LEGACY_BROWSER_SCREENING_ENABLED, retires all of those entry
 * points at once. When it is "false" the HTTP ones answer 410
 * `browser_screening_retired`; the worker fails its operation with that code.
 *
 * INVARIANTS
 *  - This module is lazy and never throws, exactly like lib/r1/config.ts: the
 *    API process also runs phone dialing and scoring, so a malformed value must
 *    degrade a feature, never crash the boot. The value is deliberately NOT
 *    part of the exported `env` (env.ts throws at import).
 *  - DEFAULT IS ENABLED. An unset or empty variable leaves the legacy lane
 *    exactly as it was, so tests and local development are unchanged. Retiring
 *    the lane is the explicit act of setting the variable to "false".
 *  - A malformed value FAILS CLOSED (retired). The legacy lane bills the shared
 *    LiveKit Cloud minute pool that phone also uses; when in doubt it must not
 *    keep spending that pool.
 *  - Only the entry points above are gated. Everything an already-started
 *    legacy session needs to FINISH is deliberately left open: POST
 *    /api/livekit/worker-context, /:id/complete, /:id/recording and
 *    /grant/recording, GET /api/candidate-consent/template, the agent worker
 *    itself, scoring and recording finalization. That is the drain. Its one
 *    join-path step is the same-bearer re-exchange (allowDrain on /exchange).
 *  - The candidate-consent status and submit routes are NOT part of the drain.
 *    Both call validateInvite, which rejects a consumed invite, so they can
 *    only serve a link whose session never started. They are gated because an
 *    open one lets a dead link collect consent and write the candidate's latest
 *    consent_records row, which phone admission reads (fail-closed on the
 *    latest record), so a decline through a dead link would stop phone dialing.
 *  - R1 does not pass through here. R1 never creates candidate_invites or
 *    candidate_access_grants, and its routes live under /api/r1 and
 *    /api/internal/r1.
 *  - The phone lane never passes through here.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** Stable machine code returned in the 410 body (plan section 8.5). */
export const BROWSER_SCREENING_RETIRED = 'browser_screening_retired';

export type LegacyBrowserScreeningStatus = 'enabled' | 'retired' | 'invalid';

export interface LegacyBrowserScreeningConfig {
  /** True only when the legacy browser lane may create or join sessions. */
  enabled: boolean;
  status: LegacyBrowserScreeningStatus;
  reason?: string;
}

let reported: string | undefined;
function report(reason: string): void {
  if (reported === reason) return;
  reported = reason;
  // Never include the offending value: configuration may carry secrets later.
  console.error(`[legacy-browser-screening] retired: ${reason}`);
}

/**
 * Interpret the raw LEGACY_BROWSER_SCREENING_ENABLED value. Defaults to the live
 * process environment, read at CALL time, never at import. Never throws.
 */
export function getLegacyBrowserScreeningConfig(
  raw: string | undefined = process.env.LEGACY_BROWSER_SCREENING_ENABLED,
): LegacyBrowserScreeningConfig {
  if (raw === undefined || raw === '' || raw === 'true') {
    return { enabled: true, status: 'enabled' };
  }
  if (raw === 'false') return { enabled: false, status: 'retired' };
  const reason = 'LEGACY_BROWSER_SCREENING_ENABLED must be either "true" or "false"';
  report(reason);
  return { enabled: false, status: 'invalid', reason };
}

/** Convenience boolean for callers that only need the decision. */
export function legacyBrowserScreeningEnabled(): boolean {
  return getLegacyBrowserScreeningConfig().enabled;
}

export interface RetirementGuardOptions {
  /** Short route label for the log line; never a token, id or address. */
  route: string;
  /**
   * Extra fields merged into the 410 body for routes whose error envelope
   * carries them (Ashby Mission Control answers `{ ok: false, error }`).
   */
  bodyExtras?: Record<string, unknown>;
  /**
   * Drain exception, consulted ONLY while the lane is retired. Returning true
   * lets the request through to the unchanged route handler; false or a
   * rejection answers 410. Used by exchange so a candidate whose invite was
   * consumed moments ago can still re-issue the same join (the existing
   * five-minute same-bearer grace) and finish an already-started session.
   */
  allowDrain?: (req: Request) => Promise<boolean>;
}

function rejectRetired(res: Response, options: RetirementGuardOptions): void {
  console.warn(`[legacy-browser-screening] 410 ${options.route}`);
  res
    .status(410)
    .set('Cache-Control', 'no-store')
    .json({ ...(options.bodyExtras ?? {}), error: BROWSER_SCREENING_RETIRED });
}

/**
 * Express guard for one legacy entry point. When the lane is enabled it calls
 * next() synchronously and touches nothing else, so the enabled path is
 * byte-identical to a route without the guard.
 */
export function legacyBrowserScreeningGuard(options: RetirementGuardOptions): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (legacyBrowserScreeningEnabled()) {
      next();
      return;
    }
    const drain = options.allowDrain;
    if (!drain) {
      rejectRetired(res, options);
      return;
    }
    drain(req).then(
      (allowed) => {
        if (allowed) next();
        else rejectRetired(res, options);
      },
      () => rejectRetired(res, options),
    );
  };
}
