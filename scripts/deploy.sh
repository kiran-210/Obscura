#!/usr/bin/env bash
# Deploy Obscura to Stellar testnet: 5 UltraHonk verifiers (one per circuit VK) + the pool.
# Prereqs: `source ./env.sh`; a funded testnet identity (default: obscura-deployer).
set -euo pipefail
cd "$(dirname "$0")/.."

IDENT="${IDENT:-obscura-deployer}"
NET="${NET:-testnet}"
VERIFIER_WASM="vendor/rs-soroban-ultrahonk/target/wasm32v1-none/release/rs_soroban_ultrahonk.wasm"
POOL_WASM="contracts/target/wasm32v1-none/release/obscura_pool.wasm"

stellar keys address "$IDENT" >/dev/null 2>&1 || stellar keys generate "$IDENT" --network "$NET" --fund
stellar keys fund "$IDENT" --network "$NET" || true

echo "==> Building wasms (stellar build needs rust 1.92.0)"
( cd vendor/rs-soroban-ultrahonk && RUSTUP_TOOLCHAIN=1.92.0 stellar contract build )
( cd contracts && RUSTUP_TOOLCHAIN=1.92.0 stellar contract build )

declare -A VF
for c in withdraw transfer place_order match_orders cancel_order; do
  echo "==> Deploying verifier: $c"
  VF[$c]=$(stellar contract deploy --wasm "$VERIFIER_WASM" --source "$IDENT" --network "$NET" \
            -- --vk_bytes-file-path "circuits/artifacts/$c/vk" | tail -1)
  echo "    ${VF[$c]}"
done

# Native-XLM SAC address — the pool maps it to the canonical native asset_id 0
# (SHARED §4) when binding `withdraw`'s `asset` arg to the proof's public `asset_id`.
NATIVE=$(stellar contract id asset --asset native --network "$NET")

echo "==> Deploying obscura-pool"
POOL=$(stellar contract deploy --wasm "$POOL_WASM" --source "$IDENT" --network "$NET" -- \
  --transfer_vf  "${VF[transfer]}" \
  --order_vf     "${VF[place_order]}" \
  --match_vf     "${VF[match_orders]}" \
  --withdraw_vf  "${VF[withdraw]}" \
  --cancel_vf    "${VF[cancel_order]}" \
  --native_asset "$NATIVE" | tail -1)
echo "    POOL=$POOL"

cat > deployments.json <<JSON
{
  "network": "$NET",
  "deployer": "$(stellar keys address "$IDENT")",
  "contracts": {
    "obscuraPool": "$POOL",
    "verifiers": {
      "withdraw": "${VF[withdraw]}", "transfer": "${VF[transfer]}",
      "place_order": "${VF[place_order]}", "match_orders": "${VF[match_orders]}",
      "cancel_order": "${VF[cancel_order]}"
    },
    "assets": { "native": "$NATIVE" }
  }
}
JSON
echo "==> Wrote deployments.json"
