# CSP Lifecycle — SEC-07

**Last updated:** 2026-07-28

## Architecture

The Content-Security-Policy is emitted as an HTTP header on HTML document
responses from the web frontend. It is NOT emitted on API JSON responses.

| Layer | Mechanism | Location |
|-------|-----------|----------|
| Development (`vite dev`) | Vite plugin `vite-csp-plugin.ts` | `app/web/vite-csp-plugin.ts` |
| Preview (`vite preview`) | Same Vite plugin | `app/web/vite-csp-plugin.ts` |
| Production | **External reverse proxy / CDN / serving layer** | NOT `vite preview` |
| Reporting endpoint | Bounded Express route | `app/api/src/routes/csp.ts` |

**Important:** Vite preview is a development convenience and is NOT a
production server. In production, the CSP header must be emitted by the
actual serving layer (NGINX, Cloudflare, Vercel, etc.) by replicating
the exact header value documented below.

## Configuration

All CSP configuration is in `app/web/.env` (or environment variables):

```
# CSP mode: "report-only" (default) or "enforce"
VITE_CSP_MODE=report-only

# Endpoint that receives CSP violation reports
VITE_CSP_REPORT_ENDPOINT=http://localhost:8787/api/csp-report

# Sources (derived from existing vars):
# VITE_API_BASE          → connect-src (canonical)
# VITE_SUPABASE_URL      → connect-src (https + wss), media-src (signed recording URLs)
# VITE_LIVEKIT_URL       → connect-src (wss)
```

## Generated Header (Example)

With default local development configuration, the generated header is:

```
Content-Security-Policy-Report-Only: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' http://localhost:8787 https://project.supabase.co wss://project.supabase.co wss://meet.example.com; media-src 'self' blob: https://project.supabase.co; frame-ancestors 'none'; form-action 'self'; base-uri 'self'; report-uri http://localhost:8787/api/csp-report
```

### Directive Rationale

| Directive | Value | Reason |
|-----------|-------|--------|
| `default-src` | `'self'` | Baseline — everything from same origin only |
| `script-src` | `'self'` | Bundled Vite scripts only; no inline |
| `style-src` | `'self'` | Bundled CSS; Tailwind is processed at build time |
| `img-src` | `'self' data:` | Self-hosted images + inline SVG favicon |
| `font-src` | `'self'` | Self-hosted fonts |
| `connect-src` | `'self'` + API + Supabase + LiveKit | API fetch, Supabase REST + Realtime, LiveKit WebSocket signalling |
| `media-src` | `'self' blob:` + Supabase | Recording playback via blob URLs + signed recording URLs from Supabase Storage |
| `frame-ancestors` | `'none'` | Matches `X-Frame-Options: DENY` |
| `form-action` | `'self'` | Forms only submit to same origin |
| `base-uri` | `'self'` | No base tag hijacking |

## Lifecycle: Foundation → Report-Only → Clean → Enforce

```
┌──────────────────┐
│ Phase 1: Deploy  │  Code foundation deployed with exact CORS + CSP
│   Code + Tests   │  Automated tests pass (186 tests); report endpoint live
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ Phase 2: Observe │  Deploy with VITE_CSP_MODE=report-only
│   Report-Only    │  Collect violations from real traffic
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ Phase 3: Fix     │  Fix legitimate violations (approved third-party
│   & Triage       │  sources added; unexpected sources investigated)
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ Phase 4: Clean   │  Owner-approved clean window with zero violations
│   Window         │  Duration confirmed by Security/Eng before proceeding
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ Phase 5: Enforce │  VITE_CSP_MODE=enforce deployed
│                  │  CSP violations block resources
└──────────────────┘
```

## Report Endpoint Security

The CSP report endpoint at `POST /api/csp-report` is:

- **Bounded:** 64 KiB maximum body size; oversized → exact 413 under stable error contract
- **Shape-validated:** Accepts legacy `csp-report` and Reporting API `reports` formats with meaningful field requirements
- **Safe:** Unknown shapes → 204, malformed JSON → 400, never crashes
- **Unrate-limited:** Currently no rate limiting (pending SEC-06); operational risk accepted for pre-production
- **Sanitized:** Structured JSON log via `console.warn`; URL origins only (no paths/queries/fragments); control characters stripped; no raw bodies ever logged
- **Content types:** `application/json`, `application/csp-report`, `application/reports+json`

This endpoint is NOT intended for multi-megabyte payloads or authenticated traffic.

## Adding New Sources

When a new service or origin is introduced:

1. Identify which directive(s) it affects (usually `connect-src` or `media-src`)
2. Add the canonical source to `app/web/src/csp.ts` `buildCspHeader()`
3. Add any associated env vars to `app/web/.env.example` and `config/environment.schema.json`
4. Run API tests (`cd app/api && npm test`) to verify CSP construction
5. Deploy in report-only mode and monitor for violations
6. After owner-approved clean window, switch to enforce

## Rollback

If CSP enforcement breaks production:

```bash
# Set back to report-only
export VITE_CSP_MODE=report-only
# Redeploy
```

Never disable CSP entirely — revert only to report-only mode. The rollback
path is approved per PLAN.md SEC-07: "Roll back only the offending CSP
directive to report-only under incident approval."

## Pending Verification (SEC-07 Not Complete)

The code foundation is implemented. These gates remain pending:

- [ ] Real deployed HTML response with CSP header (requires deployment)
- [ ] Real-browser unapproved-origin CORS denial test
- [ ] Approved media/connect smoke test with CSP enforce mode
- [ ] Owner-approved clean CSP report window
- [ ] Enforce mode deployed in production
- [ ] Mozilla Observatory B+ score (coordinated with SEC-07 CSP + SEC-09 headers)

SEC-07 is **not complete** until the deployed HTML response, browser denial,
clean report window, and enforce deployment are evidenced.
