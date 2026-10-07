/**
 * The R1 candidate limiter (plan section 8.3: "R1 candidate routes get their
 * own limiter").
 *
 * Candidate routes carry no recruiter session. It is separate from the global
 * per-IP limiter and from the recruiter/phone buckets: R1 traffic can never
 * spend another lane's allowance, and a burst against R1 cannot throttle the
 * phone surface.
 *
 * Two buckets, fixed here rather than read from the environment so that R1
 * adds no API configuration surface (and therefore nothing for a malformed
 * value to break at boot):
 *
 *  - ALL `/api/r1/*`: per client IP, generous, because the page polls `status`
 *    and the exchange answers 202 `preparing` while a worker boots. It is the
 *    looser per-IP backstop in front of everything.
 *  - the two routes that create work (preflight room, attempt admission):
 *    tight, shared between them, and keyed on the LINK the request names (a
 *    digest of its body token), not on the IP. The per-link preflight cap (10
 *    per link, 3 per minute) is enforced in the database; this bucket is the
 *    cheap front of it. It is not keyed on the IP because `req.ip` is only the
 *    client's address when the proxy chain is configured to say so: if it is
 *    the proxy's, every candidate shares one IP bucket and any caller, link or
 *    not, could exhaust it and lock everybody out. A request without a
 *    well-formed token has no link to charge and falls back to the IP, which no
 *    real candidate ever uses.
 */

import type { NextFunction, Request, Response } from 'express';
import { hashInviteToken } from '../invite-token.js';
import { createRateLimitMiddleware, getClientIp } from '../rate-limit.js';

export const R1_CANDIDATE_LIMIT = 60;
export const R1_CANDIDATE_START_LIMIT = 10;

type Middleware = (req: Request, res: Response, next: NextFunction) => void;

/** Per-IP bucket for every `/api/r1/*` request. */
export function createR1RateLimit(windowSec: number): Middleware {
  return createRateLimitMiddleware({
    config: { limit: R1_CANDIDATE_LIMIT, windowSec, maxKeys: 100_000 },
    prefix: 'r1:',
    useUserKey: false,
  });
}

const LINK_TOKEN = /^[a-f0-9]{64}$/;

/**
 * The bucket a start request is charged to: the link its body names, as a
 * digest (the plaintext token is never stored, not even in memory), else the
 * client IP. Reads `req.body`, so the JSON parser must run first.
 */
export function r1StartKey(req: Request): string {
  const token = (req.body as { token?: unknown } | undefined)?.token;
  if (typeof token === 'string' && LINK_TOKEN.test(token)) {
    return `link:${hashInviteToken(token)}`;
  }
  return `ip:${getClientIp(req)}`;
}

/**
 * Tighter bucket, per LINK, for the routes that create a room or an attempt.
 * Both routes share ONE budget (same key prefix), so a candidate cannot spend
 * the allowance twice by alternating them.
 */
export function createR1StartRateLimit(windowSec: number): Middleware {
  return createRateLimitMiddleware({
    config: { limit: R1_CANDIDATE_START_LIMIT, windowSec, maxKeys: 100_000 },
    prefix: 'r1-start:',
    useUserKey: false,
    getIpOverride: r1StartKey,
  });
}
