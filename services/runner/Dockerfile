# syntax=docker/dockerfile:1
# Build from the repo root: docker build -f services/runner/Dockerfile -t kelay/runner .
FROM node:22-slim AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/tokens/package.json packages/tokens/
COPY packages/graph/package.json packages/graph/
COPY services/runner/package.json services/runner/
RUN pnpm install --frozen-lockfile --filter @kelay/runner...
COPY packages/contracts/src packages/contracts/src
COPY packages/tokens/src packages/tokens/src
COPY packages/graph/src packages/graph/src
COPY services/runner/tsconfig.json services/runner/tsup.config.ts services/runner/
COPY services/runner/src services/runner/src
RUN pnpm --filter @kelay/runner build

# The bundle includes every dependency, so the runtime image needs no node_modules.
FROM node:22-slim
ENV NODE_ENV=production PORT=4007
WORKDIR /app
COPY --from=build --chown=node:node /repo/services/runner/dist ./dist
USER node
EXPOSE 4007
CMD ["node", "dist/server.js"]
