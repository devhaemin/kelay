# syntax=docker/dockerfile:1
# Build from the repo root: docker build -f services/identity/Dockerfile -t kelay/identity .
FROM node:22-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/tokens/package.json packages/tokens/
COPY services/identity/package.json services/identity/
RUN pnpm install --frozen-lockfile --filter @kelay/identity...
COPY packages/contracts packages/contracts
COPY packages/tokens packages/tokens
COPY services/identity services/identity
RUN pnpm --filter @kelay/identity build

# The bundle includes every dependency, so the runtime image needs no node_modules.
FROM node:22-slim
ENV NODE_ENV=production PORT=4001
WORKDIR /app
COPY --from=build --chown=node:node /repo/services/identity/dist ./dist
USER node
EXPOSE 4001
CMD ["node", "--enable-source-maps", "dist/server.js"]
