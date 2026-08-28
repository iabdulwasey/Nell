# Nell core runtime.
#
# One image serves both the hosted deployment and self-host, so the open-core
# promise holds: what you run yourself is what we run.

FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# Dependencies are installed from the lockfile only, so a build cannot silently
# drift from what CI verified.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/core/package.json apps/core/
COPY packages/shared/package.json packages/shared/
COPY packages/license/package.json packages/license/
COPY packages/db/package.json packages/db/
COPY packages/durable/package.json packages/durable/
COPY packages/aegis/package.json packages/aegis/
COPY packages/agent/package.json packages/agent/
COPY packages/vault/package.json packages/vault/
COPY packages/browser/package.json packages/browser/
COPY packages/channels/package.json packages/channels/
COPY packages/memory/package.json packages/memory/
COPY packages/integrations/package.json packages/integrations/
COPY packages/audit/package.json packages/audit/
COPY packages/evals/package.json packages/evals/
COPY packages/recipes/package.json packages/recipes/
RUN pnpm install --frozen-lockfile

FROM base AS runtime
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps ./apps
COPY --from=deps /app/packages ./packages
COPY . .

# Never run as root.
USER node
EXPOSE 4000
ENV NODE_ENV=production
ENV PORT=4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:4000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["pnpm", "--filter", "@nell/core-app", "start"]
