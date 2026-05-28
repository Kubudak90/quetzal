# Sub-8.1 aggregator — multi-stage Docker build.
#
# Build context: monorepo root (one level above this file). From /repo root:
#   docker build -t quetzal-aggregator:latest -f aggregator/Dockerfile .
#
# The aggregator package runs via tsx (no JS emit) so we don't need a separate
# build stage like the faucet does. We DO pull in @quetzal/sdk + cli/src/
# (relayer-mode imports cli/src/config.js) so the runtime needs both source
# trees + node_modules.
#
# Prerequisite: BEFORE `docker build`, run from repo root:
#   pnpm install
#   pnpm compile        # optional — only required if the on-chain epoch-poll
#                       # path is enabled (AZTEC_NODE_URL + ORDERBOOK_ADDRESS).
#                       # The reveal-server path (/reveal + /health) does NOT
#                       # need compiled Noir artifacts.
#
# Image footprint stays small: only ~3 source trees + node_modules ship.

# ---------------------------------------------------------------------------
# Stage 1: deps — install workspace deps from lockfile.
# Cached aggressively when only source files change.
# ---------------------------------------------------------------------------
FROM node:22-trixie-slim AS deps

RUN corepack enable pnpm

# Native build deps (some @aztec/* and viem chains pull native binaries).
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /repo

# Workspace manifest + every package.json that pnpm-workspace.yaml enumerates.
# pnpm needs the full workspace graph to resolve workspace:* deps deterministically.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY sdk/package.json ./sdk/package.json
COPY cli/package.json ./cli/package.json
COPY aggregator/package.json ./aggregator/package.json
COPY frontend/package.json ./frontend/package.json
COPY examples/package.json ./examples/package.json
COPY faucet/package.json ./faucet/package.json
COPY tools/outbox-proof/package.json ./tools/outbox-proof/package.json
COPY tools/exporters/package.json ./tools/exporters/package.json
COPY tests ./tests

# --frozen-lockfile=false: tolerate lockfile drift across contributor branches.
# Workspace topology is stable so the resolved tree is deterministic anyway.
RUN pnpm install --frozen-lockfile=false

# ---------------------------------------------------------------------------
# Stage 2: runtime — slim node:22 with source + node_modules from deps.
# No build step required (tsx executes TS directly).
# ---------------------------------------------------------------------------
FROM node:22-trixie-slim AS runtime

RUN corepack enable pnpm

# curl for HEALTHCHECK; ca-certificates so the L2 PXE HTTPS works.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /repo

# Workspace metadata + installed dependencies.
COPY --from=deps /repo/package.json ./package.json
COPY --from=deps /repo/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=deps /repo/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=deps /repo/node_modules ./node_modules

# Source trees the aggregator touches at runtime:
# - aggregator/  — the daemon + server + main.ts
# - sdk/         — workspace dep (exports point at src/*.ts directly)
# - cli/         — relayer-mode imports cli/src/config.js + cli/src/bridge-helpers.js
# - tests/       — relayer-mode imports tests/integration/generated/Treasury.js
# - contracts/   — Noir artifacts for SDK contract registration (optional;
#                  reveal-server-only path doesn't need them)
COPY aggregator ./aggregator
COPY sdk ./sdk
COPY cli ./cli
COPY tests ./tests
COPY contracts ./contracts

# Pre-create the snapshots dir so the bind-mount volume picks up clean perms.
RUN mkdir -p /repo/aggregator/data && chmod 0755 /repo/aggregator/data

ENV NODE_ENV=production \
    PORT=3000 \
    LOG_LEVEL=info

EXPOSE 3000

# Container-level healthcheck.  Docker-compose also defines a healthcheck
# (with start_period for cold-start tolerance); this one keeps `docker ps`
# accurate even when the image runs standalone.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=30s \
    CMD curl -sf http://localhost:${PORT}/health || exit 1

WORKDIR /repo/aggregator

CMD ["pnpm", "start"]
