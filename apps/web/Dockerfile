# syntax=docker/dockerfile:1.6

FROM node:20-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web
RUN pnpm install --frozen-lockfile --filter @aip/web...
RUN pnpm --filter @aip/web build

FROM node:20-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache curl \
 && addgroup -S aip -g 1001 \
 && adduser  -S aip -G aip -u 1001
COPY --from=build --chown=aip:aip /app/apps/web/.output /app/.output
USER aip
ENV NODE_ENV=production
ENV NITRO_PORT=3000
ENV NITRO_HOST=0.0.0.0
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --retries=5 --start-period=15s \
  CMD curl -fsS http://localhost:3000/ || exit 1
CMD ["node", ".output/server/index.mjs"]
