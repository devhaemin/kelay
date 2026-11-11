# syntax=docker/dockerfile:1
# Build from the repo root: docker build -f services/identity/Dockerfile -t kelay-identity .
FROM node:22-slim AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/tokens/package.json packages/tokens/
COPY services/identity/package.json services/identity/
RUN pnpm install --frozen-lockfile --filter @kelay/identity...
COPY packages/contracts packages/contracts
COPY packages/tokens packages/tokens
COPY services/identity services/identity
# The bundle keeps npm packages external, so the runtime image needs the service's production
# dependencies. Installing again with --prod prunes the rest in place. `pnpm deploy` is not used: it
# resolves the root package too, whose workspace dev dependencies are not in this build context.
RUN pnpm --filter @kelay/identity build \
 && pnpm install --frozen-lockfile --offline --prod --filter @kelay/identity...

# Same paths as in the build stage: the service's node_modules are links into /repo/node_modules/.pnpm.
FROM node:22-slim
ENV NODE_ENV=production PORT=4001
WORKDIR /repo/services/identity
COPY --from=build /repo/node_modules /repo/node_modules
COPY --from=build /repo/services/identity/node_modules ./node_modules
COPY --from=build /repo/services/identity/package.json ./
COPY --from=build /repo/services/identity/dist ./dist
USER node
EXPOSE 4001
CMD ["node", "--enable-source-maps", "dist/server.js"]
