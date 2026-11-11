# syntax=docker/dockerfile:1
# Build from the repo root: docker build -f services/mcp-gateway/Dockerfile -t kelay/mcp-gateway .
FROM node:22-slim AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/tokens/package.json packages/tokens/
COPY services/mcp-gateway/package.json services/mcp-gateway/
RUN pnpm install --frozen-lockfile --filter @kelay/mcp-gateway...
COPY packages/contracts/src packages/contracts/src
COPY packages/tokens/src packages/tokens/src
COPY services/mcp-gateway/tsconfig.json services/mcp-gateway/tsup.config.ts services/mcp-gateway/
COPY services/mcp-gateway/src services/mcp-gateway/src
RUN pnpm --filter @kelay/mcp-gateway build

# The bundle includes every dependency, so the runtime image needs no node_modules.
FROM node:22-slim
ENV NODE_ENV=production PORT=4004
WORKDIR /app
COPY --from=build --chown=node:node /repo/services/mcp-gateway/dist ./dist
USER node
EXPOSE 4004
CMD ["node", "dist/server.js"]
