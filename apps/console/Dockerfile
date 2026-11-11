# syntax=docker/dockerfile:1
# Build from the repo root: docker build -f apps/console/Dockerfile -t kelay/console .
# Runtime env: CONSOLE_DATA=http, CONTROL_API_URL, KELAY_APP_ORIGIN, MCP_PUBLIC_BASE_URL, PORT.
FROM node:22-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/policy/package.json packages/policy/
COPY apps/console/package.json apps/console/
RUN pnpm install --frozen-lockfile --filter @kelay/console...
COPY packages/contracts packages/contracts
COPY packages/policy packages/policy
COPY apps/console apps/console
RUN pnpm --filter @kelay/console build

# Next's standalone output (next.config.ts) is traced from the workspace root, so it keeps the repo
# layout: the server is apps/console/server.js, beside the node_modules it needs and nothing else.
FROM node:22-slim
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/console/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/console/.next/static ./apps/console/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/console/server.js"]
