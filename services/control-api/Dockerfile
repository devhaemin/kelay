# Build from the repo root: docker build -f services/control-api/Dockerfile -t kelay/control-api .
# Run migrations with: docker run --rm -e CONTROL_DATABASE_URL=... kelay/control-api node dist/migrate.js
FROM node:22-slim AS build
RUN npm install -g pnpm@10.4.1
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/tokens/package.json packages/tokens/
COPY services/control-api/package.json services/control-api/
RUN pnpm install --frozen-lockfile --filter @kelay/control-api...
COPY packages/contracts packages/contracts
COPY packages/tokens packages/tokens
COPY services/control-api services/control-api
RUN pnpm --filter @kelay/control-api build

FROM node:22-slim
ENV NODE_ENV=production PORT=4003
WORKDIR /app
COPY --from=build /repo/services/control-api/dist ./dist
COPY --from=build /repo/services/control-api/migrations ./migrations
USER node
EXPOSE 4003
CMD ["node", "--enable-source-maps", "dist/server.js"]
