# syntax=docker/dockerfile:1.6

# ─── Build stage ────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app

RUN corepack enable

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY services/api-gateway ./services/api-gateway

RUN pnpm install --frozen-lockfile --filter @aip/api-gateway...

# ─── Runtime stage ──────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

RUN apk add --no-cache curl \
 && addgroup -S aip -g 1001 \
 && adduser  -S aip -G aip -u 1001

COPY --from=build --chown=aip:aip /app /app

USER aip
ENV NODE_ENV=production
EXPOSE 3001

HEALTHCHECK --interval=10s --timeout=3s --retries=5 --start-period=10s \
  CMD curl -fsS http://localhost:3001/ready || exit 1

CMD ["node", "--enable-source-maps", "--loader=tsx", "services/api-gateway/src/main.ts"]
