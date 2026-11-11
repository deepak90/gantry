# syntax=docker/dockerfile:1
# The assistant service on Fly.io (apps/agent/fly.toml). Built from the repo root, as the README's deploy command does:
# it needs the workspace's lockfile, packages/shared, the how-to clips' list and the shared PayPal client it reads PayPal
# with (supabase/functions/_shared). The root .dockerignore sends only those.

ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# The workspace's pnpm, which wrote the lockfile.
RUN npm install -g pnpm@9.15.0

FROM base AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/agent/package.json apps/agent/
COPY apps/clip-studio/package.json apps/clip-studio/
COPY apps/remy-call/package.json apps/remy-call/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY supabase/functions/package.json supabase/functions/
# The service and what it takes from the workspace, with tsx (a dev dependency), which runs its TypeScript.
RUN pnpm install --frozen-lockfile --filter @collab/agent...
COPY packages/shared packages/shared
COPY apps/agent apps/agent
COPY apps/web/public/clips/clips.json apps/web/public/clips/clips.json
# The shared PayPal client and what it imports: check_with_paypal reads payout batches and orders with it (src/paypal).
COPY supabase/functions/_shared/paypal.ts supabase/functions/_shared/amounts.ts supabase/functions/_shared/json.ts supabase/functions/_shared/outcomes.ts supabase/functions/_shared/

FROM base
ARG UID=10001
RUN adduser --disabled-password --gecos "" --home "/app" --shell "/sbin/nologin" --uid "${UID}" appuser
COPY --from=build --chown=appuser:appuser /app /app
USER appuser
WORKDIR /app/apps/agent
ENV NODE_ENV=production
# This image is the hosted service: the limits before each turn and the health check (src/hosted.ts, src/health.ts).
ENV GANTRY_HOSTED=1
ENV PORT=8080
EXPOSE 8080
CMD ["node", "--import", "tsx", "src/main.ts"]
