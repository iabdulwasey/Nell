# The dashboard.
#
# Its own image rather than a second process in the core's, because they fail
# differently and should be able to fail apart: the agent going down must not
# take the page that explains why with it.

FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/aegis/package.json packages/aegis/
COPY packages/agent/package.json packages/agent/
COPY packages/audit/package.json packages/audit/
COPY packages/auth/package.json packages/auth/
COPY packages/views/package.json packages/views/
COPY packages/vault/package.json packages/vault/
COPY packages/memory/package.json packages/memory/
COPY packages/browser/package.json packages/browser/
COPY packages/channels/package.json packages/channels/
COPY packages/integrations/package.json packages/integrations/
COPY packages/durable/package.json packages/durable/
COPY packages/license/package.json packages/license/
COPY packages/evals/package.json packages/evals/
COPY packages/recipes/package.json packages/recipes/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm --filter @nell/web build

FROM build AS runtime
# Never run as root.
USER node
EXPOSE 3000
ENV NODE_ENV=production

# Inside a container the loopback default would make it unreachable even to the
# host's own port mapping, so it binds to every interface *here* — and the
# compose file publishes it on 127.0.0.1, which is where the boundary belongs.
ENV NELL_WEB_HOST=0.0.0.0
ENV NELL_WEB_PORT=3000

CMD ["pnpm", "--filter", "@nell/web", "start"]
