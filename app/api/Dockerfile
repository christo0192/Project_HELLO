FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# ── ClamAV: scanner binary + updater, no daemon ────────────────────────────
# `clamscan` is invoked directly by lib/malware-scanner.ts, so clamav-daemon
# and its socket are deliberately NOT installed.
#
# NO SIGNATURE DATABASE IS BAKED INTO THIS IMAGE, ON PURPOSE.
#
# The previous revision ran `(freshclam --quiet || true)` here. That was wrong
# twice over: `|| true` turned a failed download into a green build shipping an
# EMPTY database directory, and even a successful download froze the signatures
# at image-build time — a long-lived container screened resumes against
# ever-older signatures with no way to refresh, because the runtime is non-root
# and had no updater.
#
# The fix is NOT to drop the `|| true` and let the build fail. ClamAV's CDN
# rate-limits datacentre egress (HTTP 429), so a mandatory build-time download
# makes every image build a coin flip against a third party. Instead the
# database is owned entirely by the runtime updater (src/lib/av-updater.ts,
# started by the container supervisor): one attempt at start, then hourly.
#
# The consequence is deliberate and safe: a container that has not yet completed
# its first update has NO database, which lib/clamav-signatures.ts reports as
# `signatures_missing` and the scanner rejects. Resume ingestion is fail-closed
# during that window and the activation health surface says so, instead of a
# stale database quietly passing files.
RUN apt-get update \
  && apt-get install -y --no-install-recommends clamav clamav-freshclam ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /usr/sbin/nologin appuser

# Updater configuration: root-owned and read-only, so the unprivileged runtime
# user cannot repoint its own updater at another mirror.
COPY docker/freshclam.conf /etc/clamav/freshclam.conf
RUN chown root:root /etc/clamav/freshclam.conf \
  && chmod 0444 /etc/clamav/freshclam.conf \
  && rm -rf /var/lib/clamav \
  && mkdir -p /var/lib/clamav \
  && chown appuser:appuser /var/lib/clamav \
  && chmod 0700 /var/lib/clamav

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

USER appuser
EXPOSE 8787

# PID 1 is the supervisor, not the API: it owns the signature updater, forwards
# termination signals to the API child (a PID 1 with no handlers would ignore
# SIGTERM and stall every graceful stop), and exits with the API's own status.
CMD ["node", "dist/src/container/entrypoint.js"]
