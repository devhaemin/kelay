# syntax=docker/dockerfile:1
# Build from the repo root: docker build -f services/data-api/Dockerfile -t kelay/data-api .
# Runtime env: KELAY_ID_JWKS_URL, KELAY_ID_ISSUER, KELAY_CALLER_SECRET, KELAY_APPS_FILE (mounted), PORT.

FROM node:22-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/tokens/package.json packages/tokens/
COPY services/data-api/package.json services/data-api/
RUN pnpm install --frozen-lockfile --filter @kelay/data-api...
COPY packages/contracts packages/contracts
COPY packages/tokens packages/tokens
COPY services/data-api services/data-api
RUN pnpm --filter @kelay/data-api build

FROM node:22-slim
ENV NODE_ENV=production PORT=4002
WORKDIR /app
COPY --from=build /repo/services/data-api/dist ./dist
USER node
EXPOSE 4002
CMD ["node", "--enable-source-maps", "dist/server.js"]
