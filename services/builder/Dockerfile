# The Builder's image, used twice (infra/deploy/images.json):
#   workspace  the task the fargate driver starts for an app (the default command): the workspace
#              runtime, the coding agent and `next dev`, with the app's repo on /workspace
#   builder    the Builder service itself: the same files, started with src/server.ts
# It holds the fixed toolchain every app is built with: Node, pnpm, git, and the dependencies of
# templates/starter installed once, so a workspace starts from a git checkout and installs nothing.
#
# Build from the repo root: docker build -f services/builder/Dockerfile -t kelay/workspace .
FROM node:22-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g pnpm@10.4.1
WORKDIR /opt/kelay
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/graph/package.json packages/graph/
COPY packages/policy/package.json packages/policy/
COPY packages/runtime/package.json packages/runtime/
COPY packages/sdk/package.json packages/sdk/
COPY packages/tokens/package.json packages/tokens/
COPY examples/ticket-board-nodes/package.json examples/ticket-board-nodes/
COPY templates/starter/package.json templates/starter/
COPY services/builder/package.json services/builder/
RUN pnpm install --frozen-lockfile --filter @kelay/builder... --filter @kelay/template-starter...
COPY packages packages
COPY examples/ticket-board-nodes examples/ticket-board-nodes
COPY templates/starter templates/starter
COPY services/builder services/builder

# An app is built on a copy inside the toolchain folder (src/artifacts/build.ts), and the workspace
# keeps its repo on the mount; the task writes nowhere else. The node user is uid 1000, the owner of
# every workspace access point on EFS (src/drivers/fargate.ts).
RUN mkdir -p /opt/kelay/.kelay /workspace /var/lib/kelay-builder \
  && chown node:node /opt/kelay/.kelay /workspace /var/lib/kelay-builder
USER node
ENV HOME=/home/node \
  NEXT_TELEMETRY_DISABLED=1 \
  KELAY_WORKSPACES_ROOT=/workspace \
  BUILDER_HOME=/var/lib/kelay-builder
WORKDIR /opt/kelay/services/builder
# 4007: the workspace runtime. 3000: `next dev`. 4006: the Builder service.
EXPOSE 4007 3000 4006
CMD ["node", "--import", "tsx", "src/runtime-server.ts"]
