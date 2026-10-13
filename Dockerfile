# syntax=docker/dockerfile:1.7
# Two production images from one build: `--target server` and `--target bot-runner`.
# Node runs the TypeScript sources directly (type stripping), so there is no compile step
# except the Vite bundle for the browser client.

ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-alpine AS base
WORKDIR /app
ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

FROM base AS manifests
COPY package.json package-lock.json ./
COPY packages/game-engine/package.json packages/game-engine/
COPY packages/bot-sdk/package.json packages/bot-sdk/
COPY packages/protocol/package.json packages/protocol/
COPY apps/server/package.json apps/server/
COPY apps/bot-runner/package.json apps/bot-runner/
COPY apps/web/package.json apps/web/

FROM manifests AS web-build
RUN --mount=type=cache,target=/root/.npm npm ci --include=dev --ignore-scripts
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/web apps/web
RUN npm run build -w @bomberman/web

FROM manifests AS runtime
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --ignore-scripts
COPY packages packages
COPY apps/server apps/server
COPY apps/bot-runner apps/bot-runner

FROM base AS server
COPY --from=runtime /app /app
COPY --from=web-build /app/apps/web/dist /app/apps/web/dist
ENV PORT=8080 \
    WEB_DIST=/app/apps/web/dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "apps/server/src/index.ts"]

FROM base AS bot-runner
COPY --from=runtime /app /app
ENV PORT=8090
USER node
EXPOSE 8090
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8090/healthz || exit 1
CMD ["node", "apps/bot-runner/src/index.ts"]
