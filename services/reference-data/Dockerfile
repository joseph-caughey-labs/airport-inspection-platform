# syntax=docker/dockerfile:1.6

# ─── Build stage ────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app

# Enable corepack so packageManager-pinned pnpm is used.
RUN corepack enable

# Copy workspace root manifests first for better caching.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY services/reference-data ./services/reference-data

RUN pnpm install --frozen-lockfile --filter @aip/reference-data...

# ─── Runtime stage ──────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

RUN apk add --no-cache curl \
 && addgroup -S aip -g 1001 \
 && adduser  -S aip -G aip -u 1001

COPY --from=build --chown=aip:aip /app /app

USER aip
ENV NODE_ENV=production
EXPOSE 3002

HEALTHCHECK --interval=10s --timeout=3s --retries=5 --start-period=10s \
  CMD curl -fsS http://localhost:3002/ready || exit 1

CMD ["services/reference-data/node_modules/.bin/tsx", "services/reference-data/src/main.ts"]
