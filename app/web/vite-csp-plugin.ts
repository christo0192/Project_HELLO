/**
 * Vite plugin that emits Content-Security-Policy headers on HTML document
 * responses during development and preview.  Config derived from build-time
 * env vars processed through Vite's loadEnv.
 *
 * SEC-07: report-only by default.  Enforce mode via VITE_CSP_MODE.
 * Fails closed on any unrecognised mode value.
 *
 * All three origins (VITE_API_BASE, VITE_SUPABASE_URL, VITE_LIVEKIT_URL)
 * are required.  VITE_LIVEKIT_URL may be an http(s) URL (which is
 * converted to the WebSocket equivalent) or a native ws(s) URL.
 * There is no fallback to Supabase — if LiveKit is not configured,
 * the plugin refuses to start.
 *
 * The policy is built once during config resolution and never
 * recomputed at request time.  If construction fails, the dev/preview
 * server refuses to start (fail closed).
 */

import type { Plugin } from 'vite';
import { loadEnv } from 'vite';
import {
  buildCspHeader,
  cspHeaderName,
  canonicalizeOrigin,
  toWebSocketOrigin,
  parseCspMode,
  validateReportEndpoint,
} from './src/csp.js';

// ── HTML-request detection ───────────────────────────────────────────

function isHtmlRequest(req: {
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
}): boolean {
  const url = req.url ?? '';

  // Static asset extensions — never HTML documents.
  if (
    /\.(?:js|mjs|cjs|ts|tsx|css|map|ico|svg|png|jpg|jpeg|gif|webp|woff2?|json|xml|txt)(\?|$)/i.test(
      url,
    )
  ) {
    return false;
  }

  // Vite / Rollup internal paths.
  if (
    url.startsWith('/@') ||
    url.startsWith('/__') ||
    url.startsWith('/node_modules/')
  ) {
    return false;
  }

  // Explicit HTML accept header wins.
  const accept = req.headers?.['accept'] ?? req.headers?.['Accept'];
  if (typeof accept === 'string' && accept.includes('text/html')) {
    return true;
  }

  // SPA-friendly: root, index.html, or path without extension.
  if (
    url === '/' ||
    url === '/index.html' ||
    (!url.includes('.') && url.startsWith('/'))
  ) {
    return true;
  }

  return false;
}

// ── Plugin ───────────────────────────────────────────────────────────

function cspPlugin(): Plugin {
  // State built during config resolution and never mutated afterward.
  let cachedHeader: string | null = null;
  let cachedName: string | null = null;

  return {
    name: 'sec-07-csp',
    apply: (_config, { command }) => command === 'serve',

    configResolved(resolved) {
      const mode = resolved.mode;
      const root = resolved.root ?? process.cwd();
      const env = loadEnv(mode, root, '');

      // ── Origins ────────────────────────────────────────────────

      const apiOrigin = canonicalizeOrigin(env.VITE_API_BASE);
      if (!apiOrigin) {
        throw new Error(
          'CSP: VITE_API_BASE must be a canonical http(s)://host:port origin.',
        );
      }

      const supabaseOrigin = canonicalizeOrigin(env.VITE_SUPABASE_URL);
      if (!supabaseOrigin) {
        throw new Error(
          'CSP: VITE_SUPABASE_URL must be a canonical http(s)://host:port origin.',
        );
      }

      // VITE_LIVEKIT_URL is required. It may be an http(s) URL
      // (converted to ws(s)) or a native ws(s) URL.
      const livekitRaw = env.VITE_LIVEKIT_URL;
      if (!livekitRaw) {
        throw new Error(
          'CSP: VITE_LIVEKIT_URL is required. No fallback to Supabase.',
        );
      }
      const livekitOrigin = toWebSocketOrigin(livekitRaw);
      if (!livekitOrigin) {
        throw new Error(
          'CSP: VITE_LIVEKIT_URL must be a canonical ws(s):// origin or an http(s):// origin convertible to one.',
        );
      }

      // ── Mode ────────────────────────────────────────────────────

      const modeVal = parseCspMode(env.VITE_CSP_MODE);
      if (!modeVal) {
        throw new Error(
          'CSP: VITE_CSP_MODE must be "report-only" or "enforce".',
        );
      }

      // Enforce mode is only allowed when Vite is in production mode
      // (vite preview or deployment).  Development servers must use
      // report-only so tests and rapid iteration are never blocked.
      if (modeVal === 'enforce' && resolved.mode !== 'production') {
        throw new Error(
          'CSP: enforce mode is only allowed in production-mode Vite preview/deployment, not in development.',
        );
      }

      // ── Report endpoint ─────────────────────────────────────────

      const reportEndpoint = validateReportEndpoint(
        env.VITE_CSP_REPORT_ENDPOINT || undefined,
      );
      if (env.VITE_CSP_REPORT_ENDPOINT && !reportEndpoint) {
        throw new Error(
          'CSP: VITE_CSP_REPORT_ENDPOINT must be an absolute http(s) URL with no credentials, query, or fragment.',
        );
      }

      // ── Build (fail closed) ─────────────────────────────────────

      const config = {
        apiOrigin,
        supabaseOrigin,
        livekitOrigin,
        mode: modeVal,
        reportEndpoint,
        dev: resolved.mode !== 'production',
        devPort: resolved.server?.port ?? 5173,
      };

      const header = buildCspHeader(config);
      if (!header) {
        throw new Error(
          'CSP: failed to construct policy. Check all source URLs and report endpoint.',
        );
      }

      cachedHeader = header;
      cachedName = cspHeaderName(config);
    },

    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!cachedHeader || !cachedName || !isHtmlRequest(req)) return next();
        res.setHeader(cachedName, cachedHeader);
        next();
      });
    },

    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!cachedHeader || !cachedName || !isHtmlRequest(req)) return next();
        res.setHeader(cachedName, cachedHeader);
        next();
      });
    },
  };
}

export default cspPlugin;
