# syntax=docker/dockerfile:1
# Remy's call worker on LiveKit Cloud. `lk agent create` and `lk agent deploy` build it from this folder alone: the
# worker imports nothing from the rest of the repo, and pnpm-lock.yaml here pins its dependencies at the workspace's
# versions (`pnpm --filter @collab/remy-call lockfile` writes it). Node runs the TypeScript sources as they are.

ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# The LiveKit SDK's native core reads the system's CA certificates, which slim images leave out.
RUN apt-get update -qq && apt-get install --no-install-recommends -y ca-certificates && rm -rf /var/lib/apt/lists/*
# The workspace's pnpm, which wrote the lockfile.
RUN npm install -g pnpm@9.15.0

FROM base AS build
WORKDIR /app
# The voice detector's runtime would also fetch GPU libraries on x64 Linux; Remy runs on the CPU.
ENV ONNXRUNTIME_NODE_INSTALL=skip
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY src ./src

FROM base
ARG UID=10001
RUN adduser --disabled-password --gecos "" --home "/app" --shell "/sbin/nologin" --uid "${UID}" appuser
WORKDIR /app
COPY --from=build --chown=appuser:appuser /app /app
USER appuser
ENV NODE_ENV=production
# The hosted worker: a call ends when its share of the visit's minutes runs out (five minutes at most), or after 30
# seconds nobody speaks, for everyone (src/limits.ts). Remy speaks with
# OpenAI's voice; ELEVEN_LABS_* secrets are optional and switch her to ElevenLabs.
ENV GANTRY_HOSTED=1
CMD ["node", "src/main.ts", "start"]
