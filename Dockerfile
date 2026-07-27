# syntax=docker/dockerfile:1

#
# Wraith off-chain matcher — production image.
#
# Builds @wraith/sdk + @wraith/matcher from the pnpm monorepo and runs the HTTP
# matching service (POST/GET /orders, GET /health) plus its background match loop.
# Live proving uses @aztec/bb.js (WASM) — no native `bb` binary required, but the
# first proof downloads the SRS over HTTPS (cache it with a volume; see compose).
#

# ---------- build stage ----------
FROM node:20-slim AS build
WORKDIR /app
ENV CI=1
RUN corepack enable && corepack prepare pnpm@10.11.0 --activate

# Manifests first so `pnpm install` is cached until a package.json / the lockfile changes.
# A filtered install pulls ONLY the matcher subgraph (matcher + sdk + their deps),
# never the frontend / relayer — much smaller than a full workspace install.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY sdk/package.json ./sdk/
COPY matcher/package.json ./matcher/
COPY frontend/package.json ./frontend/
COPY bridge/relayer/package.json ./bridge/relayer/
RUN pnpm install --frozen-lockfile --filter "@wraith/matcher..."

# Sources for the two packages we actually build, then compile.
# NB: don't `pnpm prune --prod` here — it drops the @wraith/sdk workspace symlink the
# matcher resolves at runtime. The filtered install already keeps the image lean.
COPY sdk ./sdk
COPY matcher ./matcher
RUN pnpm -C sdk build \
 && pnpm -C matcher build

# ---------- runtime stage ----------
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787 \
    WRAITH_DEPLOYMENTS=/app/deployments.json \
    MATCH_CIRCUIT=/app/circuits/match_orders.json

# Built workspace + resolved node_modules (workspace symlinks preserved).
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=build /app/sdk ./sdk
COPY --from=build /app/matcher ./matcher

# Runtime data baked into the image: on-chain addresses + the compiled match_orders circuit.
COPY deployments.json ./deployments.json
COPY circuits/noir/match_orders/target/match_orders.json ./circuits/match_orders.json

EXPOSE 8787
CMD ["node", "matcher/dist/index.js"]
