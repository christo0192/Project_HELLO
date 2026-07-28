import express from 'express';
import cors from 'cors';
import { env } from './lib/env.js';
import { rolesRouter } from './routes/roles.js';
import { resumesRouter } from './routes/resumes.js';
import { candidatesRouter } from './routes/candidates.js';
import { screeningRouter } from './routes/screening.js';
import { assessRouter } from './routes/assess.js';
import { livekitRouter } from './routes/livekit.js';
import { cspReportRouter } from './routes/csp.js';
import {
  malformedJsonHandler,
  oversizedJsonHandler,
  multerErrorHandler,
  zodErrorHandler,
  finalErrorHandler,
} from './lib/validation.js';

export interface CreateAppOptions {
  /** Override NODE_ENV for testing. Defaults to process.env.NODE_ENV. */
  nodeEnv?: string;
  /** Override WEB_ORIGIN for isolated CORS tests. */
  webOrigin?: string;
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

  app.get('/api/health', (_req, res) => res.json({ ok: true, model: env.claudeModel }));

  app.use('/api/roles', rolesRouter);
  app.use('/api/resumes', resumesRouter);
  app.use('/api/candidates', candidatesRouter);
  app.use('/api/screening', screeningRouter);
  app.use('/api/livekit', livekitRouter);
  app.use('/api/assess', assessRouter);

  // ── Global error handlers (order matters: specific first) ─────────
  app.use(malformedJsonHandler);
  app.use(oversizedJsonHandler);
  app.use(multerErrorHandler);
  app.use(zodErrorHandler);
  app.use(finalErrorHandler);

  return app;
}
