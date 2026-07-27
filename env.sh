#!/usr/bin/env bash
# Wraith toolchain environment.
# Source this before running nargo / bb / stellar:  `source ./env.sh`
export PATH="$HOME/.nargo/bin:$HOME/.bb:$HOME/.cargo/bin:/opt/homebrew/bin:$PATH"

# Pinned toolchain (see TOOLCHAIN.md) — MUST match the rs-soroban-ultrahonk verifier:
#   nargo   1.0.0-beta.9            (noirup -v 1.0.0-beta.9)
#   bb      0.87.0                  (bbup   -v 0.87.0)
#   poseidon lib  v0.2.0            (github.com/noir-lang/poseidon)
#   stellar 27.0.0
#   rustc   1.91.0  (wasm32-unknown-unknown)
# Verified proof = 14592 bytes, vk = 1760 bytes (UltraHonk, keccak transcript).
