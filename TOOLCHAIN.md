# Toolchain

Pinned versions used to build Obscura. Source `env.sh` to put these on your `PATH`.

| Tool | Version | Install |
|------|---------|---------|
| `nargo` (Noir) | `1.0.0-beta.9` | `noirup -v 1.0.0-beta.9` |
| `bb` (Barretenberg) | `0.87.0` | `bbup -v 0.87.0` |
| `poseidon` (Noir lib) | `v0.2.0` | `Nargo.toml`: `poseidon = { tag = "v0.2.0", git = "https://github.com/noir-lang/poseidon" }` |
| `stellar` (CLI) | `27.0.0` | `brew install stellar-cli` |
| `rustc` / `cargo` | `1.91.0` | `rustup`; add target `wasm32-unknown-unknown` |
| `node` | `20.19.2` | — |
| `pnpm` | `10.11.0` | `corepack enable` |

> **These versions are not arbitrary** — they are exactly what the on-chain UltraHonk verifier
> (`rs-soroban-ultrahonk`) was built against. Verified locally: this pin produces a **14,592-byte
> proof** and **1,760-byte VK**, which the verifier accepts. The latest Noir/bb (beta.22 / bb 5.0.0)
> produce a 4,544-byte proof / 1,888-byte VK that the verifier **rejects**. Do not upgrade.

## Proof generation (UltraHonk, keccak transcript)

```bash
nargo execute witness
bb prove   --scheme ultra_honk --oracle_hash keccak -b target/<circuit>.json -w target/witness.gz -o target --output_format bytes_and_fields
bb write_vk --scheme ultra_honk --oracle_hash keccak -b target/<circuit>.json                      -o target --output_format bytes_and_fields
# -> target/proof (14592 B), target/vk (1760 B), target/public_inputs (N*32 B)
```

## Paths

- `nargo`   → `~/.nargo/bin/nargo`
- `bb`      → `~/.bb/bb`
- `stellar` → `/opt/homebrew/bin/stellar`
