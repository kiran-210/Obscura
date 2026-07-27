# Obscura — dev task runner.  `just` (or `just --list`) shows all recipes.
#
# Prereqs: pnpm (workspace deps). The frontend reads bridge wiring from
# frontend/.env.local (contract addresses + RPCs; no secrets).

set shell := ["bash", "-uc"]

# List available recipes.
default:
    @just --list

# --- setup -----------------------------------------------------------------

# Install all workspace dependencies.
install:
    pnpm install

# Build the TypeScript SDK — the frontend & relayer import @obscura/sdk from dist/.
sdk:
    pnpm --filter @obscura/sdk build

# One-time first-run setup: install deps + build the SDK.
setup: install sdk

# --- run the app (dev mode) ------------------------------------------------

# Run the app in dev mode (build SDK, then Vite at http://localhost:5173).
dev: sdk
    pnpm --filter frontend dev

# Frontend only (assumes the SDK is already built).
frontend:
    pnpm --filter frontend dev

# Typecheck the frontend without emitting.
typecheck:
    pnpm --filter frontend typecheck

# Production build of the frontend (tsc + vite build).
build:
    pnpm --filter frontend build

# --- relayer (optional — needed for the cross-chain bridge_in loop) ---------

# Build + run the relayer CLI, reading env from your shell. e.g. `just relayer watch`.
relayer *ARGS:
    pnpm --filter @obscura/relayer build >/dev/null && node bridge/relayer/dist/index.js {{ARGS}}

# Run the relayer test suite.
relayer-test:
    pnpm --filter @obscura/relayer test
