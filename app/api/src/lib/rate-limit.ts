/**
 * SEC-04: Configurable token-bucket rate limiter.
 *
 * Features:
 *  - Per-IP and per-authenticated-user key buckets
 *  - Configurable limits per endpoint group
 *  - 429 with integer Retry-After header
 *  - Bounded memory with idle bucket expiry
 *  - Trusted proxy configuration (default: no trust)
 *  - No caller-controlled X-Forwarded-For trust by default
 *
 * Dependency-injectable store for testability.
 */

import type { NextFunction, Request, Response } from 'express';

// ── Types ────────────────────────────────────────────────────────────

export interface RateLimitConfig {
  /** Tokens per interval (max burst). */
  limit: number;
  /** Interval window in seconds (refill period). */
  windowSec: number;
  /** Max tokens per key (prevents unbounded storage). */
  maxKeys: number;
}

export interface BucketEntry {
  tokens: number;
  lastRefill: number; // epoch ms
}

/**
 * Rate limit store interface — injectable for tests.
 */
export interface RateLimitStore {
  get(key: string): BucketEntry | undefined;
  set(key: string, entry: BucketEntry): void;
  delete(key: string): void;
  size(): number;
  clear(): void;
}

// ── In-memory store with idle expiry ────────────────────────────────

const IDLE_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly store = new Map<string, { entry: BucketEntry; lastAccess: number }>();
  private maxSize: number;

  constructor(maxSize = 100_000) {
    this.maxSize = maxSize;
  }

  get(key: string): BucketEntry | undefined {
    const item = this.store.get(key);
    if (!item) return undefined;
    item.lastAccess = Date.now();
    return item.entry;
  }

  set(key: string, entry: BucketEntry): void {
    // Evict stale entries if at capacity
    if (this.store.size >= this.maxSize) {
      this.evictStale();
    }
    // If still over capacity, evict oldest
    if (this.store.size >= this.maxSize) {
      this.evictOldest();
    }
    this.store.set(key, { entry, lastAccess: Date.now() });
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  size(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  /** Exposed for tests: get internal count of all entries. */
  internalCount(): number {
    return this.store.size;
  }

  private evictStale(): void {
    const cutoff = Date.now() - IDLE_EXPIRY_MS;
    const entries = Array.from(this.store.entries());
    for (const [key, item] of entries) {
      if (item.lastAccess < cutoff) {
        this.store.delete(key);
      }
    }
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    const entries = Array.from(this.store.entries());
    for (const [key, item] of entries) {
      if (item.lastAccess < oldestTime) {
        oldestTime = item.lastAccess;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      this.store.delete(oldestKey);
    }
  }
}

// ── Global store ─────────────────────────────────────────────────────

let _store: RateLimitStore = new MemoryRateLimitStore();

export function setRateLimitStore(store: RateLimitStore): void {
  _store = store;
}

export function getRateLimitStore(): RateLimitStore {
  return _store;
}

// ── IP resolution ───────────────────────────────────────────────────

/**
 * Resolve client IP from request.
 *
 * By default, uses `req.ip` (Express' direct socket address). When
 * trustProxy is true and the app has `app.set('trust proxy', ...)`,
 * Express resolves X-Forwarded-For via the configured proxy trust.
 *
 * We NEVER read X-Forwarded-For directly — that would allow caller
 * spoofing. Instead, we rely on Express' built-in proxy trust.
 */
export function getClientIp(req: Request): string {
  // Use Express' built-in proxy-aware req.ip. Normalize IPv4-mapped IPv6 so
  // one client cannot obtain two buckets by address representation alone.
  const raw = req.ip ?? req.socket.remoteAddress ?? 'unknown';
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

export function getUserKey(req: Request): string | null {
  return req.authUser?.id ?? null;
}

// ── Bucket operations ───────────────────────────────────────────────

/**
 * Compute tokens for a bucket given elapsed time.
 */
export function refillBucket(
  entry: BucketEntry,
  nowMs: number,
  config: RateLimitConfig,
): BucketEntry {
  const elapsedSec = (nowMs - entry.lastRefill) / 1000;
  const refillTokens = elapsedSec * (config.limit / config.windowSec);
  const tokens = Math.min(config.limit, entry.tokens + refillTokens);
  return { tokens, lastRefill: nowMs };
}

/**
 * Attempt to consume one token from a bucket.
 * Returns remaining tokens (negative if over limit).
 */
export function consumeToken(
  key: string,
  config: RateLimitConfig,
  nowMs: number = Date.now(),
): { allowed: boolean; remaining: number; retryAfterSec: number } {
  let entry = _store.get(key);

  if (!entry) {
    entry = { tokens: config.limit - 1, lastRefill: nowMs };
    _store.set(key, entry);
    return { allowed: true, remaining: config.limit - 1, retryAfterSec: 0 };
  }

  // Refill
  entry = refillBucket(entry, nowMs, config);

  if (entry.tokens >= 1) {
    entry.tokens -= 1;
    _store.set(key, entry);
    return { allowed: true, remaining: Math.floor(entry.tokens), retryAfterSec: 0 };
  }

  // Over limit — compute Retry-After
  const tokensPerSec = config.limit / config.windowSec;
  const deficitSec = Math.ceil((1 - entry.tokens) / tokensPerSec);
  const retryAfterSec = Math.max(1, deficitSec);
  _store.set(key, entry);
  return { allowed: false, remaining: 0, retryAfterSec };
}

// ── Middleware factory ──────────────────────────────────────────────

export interface RateLimitMiddlewareOptions {
  /** Limit config. */
  config: RateLimitConfig;
  /** Optional key prefix for grouping (e.g., "api:roles:") */
  prefix?: string;
  /** Whether to use authenticated user key instead of IP. */
  useUserKey?: boolean;
  /** Override client IP resolution (for testing). */
  getIpOverride?: (req: Request) => string;
}

/**
 * Create Express middleware that enforces token-bucket rate limiting.
 *
 * Responds with 429 + Retry-After header when limit exceeded.
 */
export function createRateLimitMiddleware(opts: RateLimitMiddlewareOptions) {
  const { config, prefix = 'rl:', useUserKey = false, getIpOverride } = opts;

  return (req: Request, res: Response, next: NextFunction): void => {
    let key: string;
    if (useUserKey && req.authUser?.id) {
      key = `${prefix}user:${req.authUser.id}`;
    } else {
      const ip = getIpOverride ? getIpOverride(req) : getClientIp(req);
      key = `${prefix}${ip}`;
    }

    const result = consumeToken(key, config);
    res.setHeader('X-RateLimit-Limit', config.limit);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, result.remaining));

    if (!result.allowed) {
      // Integer Retry-After per spec
      const retryAfter = Math.ceil(result.retryAfterSec);
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({
        error: {
          type: 'rate_limit_exceeded',
          message: 'Too many requests. Please try again later.',
          retry_after_seconds: retryAfter,
        },
      });
      return;
    }

    next();
  };
}
