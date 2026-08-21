import express from 'express';
import cors from 'cors';
import { env } from './lib/env.js';
import { correlationMiddleware } from './lib/correlation.js';
import { rolesRouter } from './routes/roles.js';
import { resumesRouter } from './routes/resumes.js';
import { candidatesRouter } from './routes/candidates.js';
import { screeningRouter } from './routes/screening.js';
import { assessRouter, workerAssessRouter } from './routes/assess.js';
import { livekitRouter } from './routes/livekit.js';
import { invitesRouter } from './routes/invites.js';
import { recordingsRouter } from './routes/recordings.js';
import { dsarRouter } from './routes/dsar.js';
import { consentRouter } from './routes/consent.js';
import { cspReportRouter } from './routes/csp.js';
import { adminRouter } from './routes/admin.js';
import { statusRouter } from './routes/status.js';
import { meRouter } from './routes/me.js';
import { notesRouter } from './routes/notes.js';
import { candidateConsentRouter } from './routes/candidate-consent.js';
import { notificationsRouter } from './routes/notifications.js';
import { exportRouter } from './routes/export.js';
import { appealsRouter } from './routes/appeals.js';
import { ashbyWebhookRouter } from './routes/ashby-webhook.js';
import { ashbyMissionControlRouter } from './routes/ashby-mission-control.js';
import { ashbyReviewRouter } from './routes/ashby-review.js';
import {
  malformedJsonHandler,
  oversizedJsonHandler,
  multerErrorHandler,
  zodErrorHandler,
  finalErrorHandler,
} from './lib/validation.js';
import { createRequireAuth, isPublicRoute, setAuthSupabaseClient, type MembershipResolver, type TokenVerifier } from './lib/auth.js';
import { createRateLimitMiddleware, type RateLimitConfig } from './lib/rate-limit.js';
import { viewerReadOnly } from './lib/rbac.js';
import { supabase } from './lib/supabase.js';
import { setAuditSink, createDbAuditSink } from './lib/audit.js';

export interface CreateAppOptions {
  /** Override NODE_ENV for testing. Defaults to process.env.NODE_ENV. */
  nodeEnv?: string;
  /** Override WEB_ORIGIN for isolated CORS tests. */
  webOrigin?: string;
  /**
   * Injected auth dependencies for the token verifier.
   * When provided, the middleware uses this instead of the live Supabase Auth
   * client — enabling DI test seams without a live provider.
   */
  authDeps?: { getUser?: TokenVerifier; resolveMembership?: MembershipResolver };
  /**
   * Injected audit sink override (for testing).
   * When provided, replaces the default DB-backed sink.
   */
  auditSinkOverride?: (entry: any) => Promise<void> | void;
}

/**
 * Parse a WEB_ORIGIN entry into a canonical origin (scheme://host:port).
 * Returns undefined when the entry contains path, query, hash, credentials,
 * or is otherwise not a clean http/https origin.
 */
function parseOrigin(raw: string): string | undefined {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    if (u.username || u.password) return undefined;
    if (u.pathname !== '/' && u.pathname !== '') return undefined;
    if (u.search || u.hash) return undefined;
    // Use URL.origin: default ports (80 / 443) are omitted per the URL Standard.
    return u.origin;
  } catch {
    return undefined;
  }
}

function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export function createApp(opts: CreateAppOptions = {}) {
  const app = express();
  const nodeEnv = opts.nodeEnv ?? process.env.NODE_ENV;

  // Validate NODE_ENV against the restricted set.
  if (nodeEnv && nodeEnv !== 'development' && nodeEnv !== 'test' && nodeEnv !== 'production') {
    throw new Error('NODE_ENV must be "development", "test", or "production".');
  }
  const webOriginRaw = opts.webOrigin ?? env.webOrigin;

  // Suppress Express fingerprinting.
  app.disable('x-powered-by');

  // Trust forwarded client addresses only through an explicit allowlist.
  const trustedProxyRaw = process.env.TRUSTED_PROXY?.trim();
  if (trustedProxyRaw) {
    const entries = trustedProxyRaw.split(',').map((entry) => entry.trim()).filter(Boolean);
    const valid = entries.length > 0 && entries.every((entry) =>
      ['loopback', 'linklocal', 'uniquelocal'].includes(entry)
      || /^[0-9a-f:.]+(?:\/\d{1,3})?$/i.test(entry),
    );
    if (!valid) throw new Error('TRUSTED_PROXY contains an invalid proxy address or range.');
    app.set('trust proxy', entries);
  }

  // ── Security headers (SEC-09) ──────────────────────────────────
  // Must run before CORS so headers cover OPTIONS preflight and
  // CORS-blocked responses as well as normal routes.
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (nodeEnv === 'production') {
      res.setHeader(
        'Strict-Transport-Security',
        'max-age=31536000; includeSubDomains',
      );
    }
    next();
  });

  // ── OBS-02: Correlation ID middleware ─────────────────────────────
  // Must run before CORS so X-Correlation-ID is set on every response
  // including preflight, CORS-blocked, and all error paths.
  app.use(correlationMiddleware);

  // ── Configure audit sink ─────────────────────────────────────────
  if (opts.auditSinkOverride) {
    setAuditSink(opts.auditSinkOverride);
  } else {
    // Wire DB-backed audit sink to audit_events table
    setAuditSink(createDbAuditSink(supabase as any));
  }

  // ── Parse and validate allowed origins ─────────────────────────
  // Reject credentials, path, query, hash. Fail closed on empty production set.

  const isProduction = nodeEnv === 'production';
  const entries = webOriginRaw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  if (entries.length === 0) {
    throw new Error('WEB_ORIGIN is empty — at least one canonical origin is required.');
  }

  const allowedOrigins = new Set<string>();
  for (const entry of entries) {
    const canonical = parseOrigin(entry);
    if (!canonical) {
      throw new Error(
        'WEB_ORIGIN contains a malformed entry. ' +
        'Use canonical http(s)://host:port with no path, query, hash, or credentials.',
      );
    }
    // Production must never allow loopback / unspecified hosts even
    // when explicitly listed — no localhost / 0.0.0.0 in deploy.
    if (isProduction && /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)(:\d+)?$/.test(canonical)) {
      throw new Error(
        'WEB_ORIGIN contains a loopback entry disallowed in production.',
      );
    }
    // Production must use HTTPS exclusively.
    if (isProduction && canonical.startsWith('http://')) {
      throw new Error('WEB_ORIGIN must use https in production.');
    }
    allowedOrigins.add(canonical);
  }

  // ── CORS (SEC-07) ──────────────────────────────────────────────
  // Production: only exact canonical origins. Non-production: also localhost.

  app.use(
    cors({
      origin(origin, callback) {
        // No Origin header → allow (server-to-server, curl, health checks).
        if (!origin) return callback(null, true);

        // Exact match against canonical allowlist.
        if (allowedOrigins.has(origin)) return callback(null, origin);

        // Non-production: localhost/127.0.0.1 any port.
        if (!isProduction && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) {
          return callback(null, origin);
        }

        // Disallowed: no ACAO. Browser blocks; API returns 200 (not 500).
        callback(null, false);
      },
    }),
  );

  // ── Global per-IP rate limiter (after CORS, before auth — SEC-06) ─
  const rateWindowSec = boundedInt(process.env.RATE_LIMIT_WINDOW_SEC, 60, 1, 3600);
  const globalIpLimit: RateLimitConfig = {
    limit: boundedInt(process.env.RATE_LIMIT_IP, 300, 1, 100_000),
    windowSec: rateWindowSec,
    maxKeys: 100_000,
  };
  app.use(createRateLimitMiddleware({
    config: globalIpLimit,
    prefix: 'global:ip:',
    useUserKey: false,
  }));

  // Internal scoring callback for the Fly voice worker. It is mounted before
  // recruiter auth because it uses a separate constant-time shared-secret
  // boundary and is still covered by the global per-IP limiter.
  app.use('/api/internal/assess', workerAssessRouter);

  // Inbound Ashby webhook receiver. Mounted before recruiter auth because its
  // trust boundary is the HMAC-SHA256 Ashby-Signature verified over the raw
  // request bytes (not a recruiter session). It reads the raw body itself and
  // is still covered by the global per-IP limiter. Disabled by default: it
  // fails closed (503) unless ASHBY_INTEGRATION_ENABLED + a secret are set.
  app.use('/api/integrations/ashby', ashbyWebhookRouter);

  // ── Auth middleware: runs after CORS so preflight succeeds ─────
  // Uses DI seam when authDeps is provided (tests).
  setAuthSupabaseClient(supabase as any);
  const requireAuth = createRequireAuth(opts.authDeps);

  app.use((req, res, next) => {
    if (isPublicRoute(req.method, req.path)) {
      next();
      return;
    }
    requireAuth(req, res, next);
  });

  // ── Viewer read-only guard: applies to all non-public routes ───
  app.use((req, res, next) => {
    if (isPublicRoute(req.method, req.path)) {
      next();
      return;
    }
    viewerReadOnly(req, res, next);
  });

  // ── Rate limit middleware: per-user for authenticated requests ─
  const defaultRateLimit: RateLimitConfig = {
    limit: boundedInt(process.env.RATE_LIMIT_DEFAULT, 100, 1, 100_000),
    windowSec: rateWindowSec,
    maxKeys: 100_000,
  };
  const strictRateLimit: RateLimitConfig = {
    limit: boundedInt(process.env.RATE_LIMIT_STRICT, 20, 1, 100_000),
    windowSec: rateWindowSec,
    maxKeys: 100_000,
  };

  app.use('/api/roles', createRateLimitMiddleware({ config: defaultRateLimit, prefix: 'roles:', useUserKey: true }));
  app.use('/api/candidates', createRateLimitMiddleware({ config: defaultRateLimit, prefix: 'candidates:', useUserKey: true }));
  app.use('/api/screening', createRateLimitMiddleware({ config: strictRateLimit, prefix: 'screening:', useUserKey: true }));
  app.use('/api/assess', createRateLimitMiddleware({ config: strictRateLimit, prefix: 'assess:', useUserKey: true }));
  app.use('/api/resumes', createRateLimitMiddleware({ config: strictRateLimit, prefix: 'resumes:', useUserKey: true }));
  app.use('/api/livekit', createRateLimitMiddleware({ config: strictRateLimit, prefix: 'livekit:', useUserKey: true }));
  // Recordings: the download/revoke paths keep the STRICT bucket, but the
  // 0038 operator health surface must not sit behind it. An ops poller on a
  // tight interval would exhaust 20 requests/window, and a throttled read is
  // indistinguishable from `backlog_unavailable` → `degraded` — i.e. the
  // limiter would manufacture the exact false alarm the surface exists to
  // avoid. `/health` gets the default bucket with its own prefix (so it also
  // cannot consume the download bucket); an over-limit caller gets a plain
  // 429, which the client contract must NOT read as degraded.
  const recordingsStrictLimiter = createRateLimitMiddleware({
    config: strictRateLimit, prefix: 'recordings:', useUserKey: true,
  });
  const recordingsHealthLimiter = createRateLimitMiddleware({
    config: defaultRateLimit, prefix: 'recordings-health:', useUserKey: true,
  });
  app.use('/api/recordings', (req, res, next) => (
    req.path === '/health'
      ? recordingsHealthLimiter(req, res, next)
      : recordingsStrictLimiter(req, res, next)
  ));
  app.use('/api/dsar', createRateLimitMiddleware({ config: defaultRateLimit, prefix: 'dsar:', useUserKey: true }));
  // GOV-08/09/10: consent routes are recruiter/authenticated-only (fail-closed).
  // Candidate consent-before-join is a synthetic client-side mechanism (see
  // CandidateJoinPage) — these API routes carry no per-candidate grant and are
  // deliberately NOT added to the public allowlist. Legal D-010 remains an
  // unwaived go-live gate.
  app.use('/api/consent', createRateLimitMiddleware({ config: defaultRateLimit, prefix: 'consent:', useUserKey: true }));
  // Phase 9 L2/L3/L4: mount rate limits for the new routers. Public
  // candidate-facing paths (candidate-consent, appeals) get the strict
  // per-IP/per-user bucket; recruiter/admin paths use the default bucket.
  app.use('/api/admin', createRateLimitMiddleware({ config: defaultRateLimit, prefix: 'admin:', useUserKey: true }));
  app.use('/api/me', createRateLimitMiddleware({ config: defaultRateLimit, prefix: 'me:', useUserKey: true }));
  app.use('/api/status', createRateLimitMiddleware({ config: defaultRateLimit, prefix: 'status:', useUserKey: true }));
  app.use('/api/notes', createRateLimitMiddleware({ config: defaultRateLimit, prefix: 'notes:', useUserKey: true }));
  app.use('/api/candidate-consent', createRateLimitMiddleware({ config: strictRateLimit, prefix: 'candidate-consent:', useUserKey: true }));
  app.use('/api/notifications', createRateLimitMiddleware({ config: defaultRateLimit, prefix: 'notifications:', useUserKey: true }));
  app.use('/api/export', createRateLimitMiddleware({ config: defaultRateLimit, prefix: 'export:', useUserKey: true }));
  app.use('/api/appeals', createRateLimitMiddleware({ config: strictRateLimit, prefix: 'appeals:', useUserKey: true }));
  // Ashby Mission Control (recruiter/admin-authenticated; distinct from the
  // pre-auth webhook path). Reads are interviewer+, actions admin-only.
  app.use('/api/integrations/ashby/mission-control', createRateLimitMiddleware({ config: defaultRateLimit, prefix: 'ashby-mc:', useUserKey: true }));
  app.use('/api/integrations/ashby/review', createRateLimitMiddleware({ config: defaultRateLimit, prefix: 'ashby-review:', useUserKey: true }));

  // Public: health endpoint (no auth). Bounded — `{ ok: true }` only, so
  // no model/provider/internal dependency leaks to unauthenticated callers.
  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  // CSP violation report endpoint: 64 KiB bound, runs before the
  // main JSON parser so oversized CSP reports are rejected at 64 KiB.
  app.use(
    '/api/csp-report',
    express.json({
      limit: '64kb',
      type: ['application/json', 'application/csp-report', 'application/reports+json'],
    }),
    cspReportRouter,
  );

  app.use(express.json({ limit: '2mb' }));

  app.use('/api/roles', rolesRouter);
  app.use('/api/resumes', resumesRouter);
  app.use('/api/candidates', candidatesRouter);
  app.use('/api/screening', screeningRouter);
  app.use('/api/livekit', invitesRouter);
  app.use('/api/livekit', livekitRouter);
  app.use('/api/recordings', recordingsRouter);
  app.use('/api/dsar', dsarRouter);
  app.use('/api', consentRouter);
  app.use('/api/assess', assessRouter);

  // Phase 9 L4 wiring: admin/status/me + L3 domain routers. Mounted after the
  // global auth + viewer-read-only + rate-limit middleware; each router keeps
  // its own per-route role guards (admin/me enforce at the router boundary).
  app.use('/api/admin', adminRouter);
  app.use('/api/status', statusRouter);
  app.use('/api/me', meRouter);
  app.use('/api/notes', notesRouter);
  app.use('/api/candidate-consent', candidateConsentRouter);
  app.use('/api/notifications', notificationsRouter);
  app.use('/api/export', exportRouter);
  app.use('/api/appeals', appealsRouter);
  app.use('/api/integrations/ashby/mission-control', ashbyMissionControlRouter);
  app.use('/api/integrations/ashby/review', ashbyReviewRouter);

  // ── 401/403/429 error paths still carry existing headers (CORS/CSP) ─
  // Handled inline by the auth/rate-limit middleware, no stack traces.

  // ── Global error handlers (order matters: specific first) ─────────
  app.use(malformedJsonHandler);
  app.use(oversizedJsonHandler);
  app.use(multerErrorHandler);
  app.use(zodErrorHandler);
  app.use(finalErrorHandler);

  return app;
}
