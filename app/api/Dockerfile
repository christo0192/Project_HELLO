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
RUN apt-get update \
  && apt-get install -y --no-install-recommends clamav clamav-freshclam ca-certificates \
  && (freshclam --quiet || true) \
  && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --shell /usr/sbin/nologin appuser
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER appuser
EXPOSE 8787
CMD ["node", "dist/src/index.js"]
