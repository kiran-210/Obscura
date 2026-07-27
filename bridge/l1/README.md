# ObscuraBridgeL1 — Ethereum L1 lock contract

Minimal lock/unlock escrow for the **Obscura** trust-minimized cross-chain bridge
(Ethereum Sepolia → Stellar/Soroban). Implements `BRIDGE_SPEC.md` §4. Foundry
project; Solidity `^0.8.24`; deploys to Sepolia.

`lock` escrows native ETH or an ERC20 against a Obscura note `commitment`. On the
Stellar side, `EthLightClient` establishes a trusted execution `state_root` (BLS
sync-committee verification) and `ObscuraBridge` proves the resulting **storage
word** with an EIP-1186 Merkle-Patricia inclusion proof, then mints a shielded
note. `unlock` releases the escrow after a verified L2 `bridge_out`
(governor-gated for the hackathon).

The contract is deliberately tiny because **its storage layout is the bridge's
ABI**: the Soroban MPT verifier reads exactly one storage word and decodes it.
The layout below is the load-bearing contract between the two chains.

---

## Storage layout (the cross-chain contract)

```
slot 0 : mapping(bytes32 => LockRecord) public locks      <-- MUST stay first
slot 1 : mapping(bytes32 => bool)       public spentOnL2
         address public immutable relayerOrGovernor        <-- immutable: NO storage slot
```

`relayerOrGovernor` is `immutable`, so it is baked into the contract bytecode and
consumes **no** storage slot — it does not shift `locks` (slot 0) or `spentOnL2`
(slot 1). Keep `locks` declared first so its mapping base slot `p = 0` holds.

### 1. Storage-slot derivation

For a Solidity `mapping` at declaration slot `p`, the slot holding `map[key]` is:

```
slot = keccak256(abi.encode(key, p))
```

For `locks[commitment]` with `p = 0`, `abi.encode(commitment, uint256(0))` is the
32-byte `commitment` concatenated with a 32-byte zero word, so:

```
slot = keccak256(commitment ‖ 0x0000…0000)      // 64 bytes in, 32 bytes out
```

This is exactly what the Soroban `bridge_in` computes (`BRIDGE_SPEC` §7 step 2)
before walking the storage trie.

### 2. `LockRecord` packing (which bytes hold what)

```solidity
struct LockRecord { address token; uint96 amount; }   // token == address(0) => native ETH
```

`address` (20 bytes) + `uint96` (12 bytes) = 32 bytes → **one storage word**.
Solidity packs declaration-order fields **low-order-first**, so within the
32-byte word `W` (big-endian — the order `vm.load` returns and the order stored
in the MPT leaf):

```
            ┌──────────────── 32 bytes ────────────────┐
   W   =    │  amount (12 bytes)  │   token (20 bytes)  │
            └─ high / MSB ────────┴──────── low / LSB ──┘
   byte idx   0 .............. 11   12 ............... 31
```

| Field    | Bits        | Bytes (big-endian)        | Notes                    |
|----------|-------------|---------------------------|--------------------------|
| `token`  | `[0, 160)`  | low-order 20 bytes (12–31)| `address(0)` = native ETH|
| `amount` | `[160, 256)`| high-order 12 bytes (0–11)| `uint96`                 |

As one expression:

```
W = (uint256(amount) << 160) | uint256(uint160(token))

token  = address(uint160(uint256(W)))      // low 160 bits
amount = uint96(uint256(W) >> 160)         // high 96 bits
```

> Note on `BRIDGE_SPEC` §4 wording ("amount in the low 12 bytes, token in the
> next 20 bytes"): the authoritative layout — verified by `vm.load` in
> `test_StorageSlot_*` — is `amount` in the **high-order** 12 bytes and `token`
> in the **low-order** 20 bytes, which is precisely how Solidity packs
> `struct { address token; uint96 amount; }`. The unit test, not the prose, is
> ground truth; the Soroban verifier must decode with the formula above.

### 3. Worked example (real, reproducible with `cast`)

```
commitment = 0x0e86ed873f020b3df2996bcff4fb0b630e4cbbafb03858dde35121f86a754ecf   # keccak256("obscura-note-1")
token      = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238                           # example Sepolia ERC20
amount     = 1000000                                                              # = 0xf4240

# slot = keccak256(abi.encode(commitment, uint256(0)))
abi.encode = 0x0e86ed873f020b3df2996bcff4fb0b630e4cbbafb03858dde35121f86a754ecf
             0000000000000000000000000000000000000000000000000000000000000000
slot       = 0x8c6161de4d4b4289f5737ad9f0af76325499e5c87b1cd3246920f376fb114e58

# packed storage word W = (amount << 160) | uint160(token)
W          = 0x0000000000000000000f42401c7d4b196cb0c7b01d743fbc6116a902379c7238
                 └──── amount = 0x0f4240 ───┘└──────── token (20 bytes) ────────┘
                       (high 12 bytes)               (low 20 bytes)
```

Reproduce:

```bash
cast keccak "obscura-note-1"                                     # commitment
cast keccak $(cast abi-encode "f(bytes32,uint256)" <commitment> 0)   # slot
```

For native ETH (`token == address(0)`) the low 20 bytes are zero and
`W = amount << 160`, e.g. locking `1 ether` (`amount = 0xde0b6b3a7640000`):
`W = 0x000000000de0b6b3a76400000000000000000000000000000000000000000000`
(the `de0b6b3a7640000` sits in the high 12 bytes; the low 20 bytes are zero).

### 4. Note for the Soroban MPT decoder

`eth_getProof` returns the storage value **RLP-encoded with leading zero bytes
stripped** (Ethereum stores the minimal big-endian byte string, then RLP-wraps
it). After the storage-trie leaf is RLP-decoded, **left-pad the value back to 32
bytes** before applying the formula above. In the worked example the leaf value
decodes to `0x0f42401c7d4b196cb0c7b01d743fbc6116a902379c7238` (23 bytes); pad to
32 bytes on the left, then `token = low 20 bytes`, `amount = high 12 bytes`.

---

## Contract surface

```solidity
mapping(bytes32 => LockRecord) public locks;     // slot 0
mapping(bytes32 => bool)       public spentOnL2;  // slot 1
address public immutable relayerOrGovernor;

function lock(bytes32 commitment, address token, uint256 amount) external payable;
function unlock(bytes32 commitment, address to) external;        // onlyGovernor

event Locked(bytes32 indexed commitment, address token, uint256 amount);
event Unlocked(bytes32 indexed commitment, address indexed to, address token, uint256 amount);
```

`lock` rejects a reused `commitment` (`locks[commitment].amount != 0`), requires
`msg.value == amount` for native ETH (and `msg.value == 0` for ERC20, pulled via
`transferFrom`), rejects zero amounts and amounts exceeding `uint96` (value
soundness — the stored `uint96` must equal the locked amount). `unlock` is gated
to `relayerOrGovernor`, sets `spentOnL2` before transferring (checks-effects-
interactions → no double-unlock / re-entrancy), and reverts on an unknown
commitment.

---

## Build & test

Uses the Foundry toolchain. (On this machine the Foundry binaries live at
`~/.foundry/bin`; a different tool also named `forge` may shadow them on `PATH`,
so use the absolute path if `forge --version` is not `1.x-stable`.)

```bash
cd bridge/l1
forge install              # fetch forge-std (submodule) if not present
forge build
forge test -vv
```

The load-bearing test is `test_StorageSlot_Derivation_And_Packing_*`: it calls
`lock`, recomputes `slot = keccak256(abi.encode(commitment, uint256(0)))`, reads
the raw word with `vm.load`, and asserts the packing both ways (decode + bit-for-
bit reconstruct). `testFuzz_Packing_*` proves the formula for arbitrary
`(commitment, amount)` over 256 runs each on both the native and ERC20 paths.

Latest run: **18 passed, 0 failed** (`forge 1.5.1-stable`, `solc 0.8.24`).

---

## Deploy (Sepolia)

`script/Deploy.s.sol` reads secrets from the environment — **never** hardcode a
key.

```bash
export PRIVATE_KEY=0x<funded-sepolia-deployer-key>
export SEPOLIA_RPC_URL=https://<your-sepolia-rpc>
# optional: defaults to the deployer EOA
export RELAYER_OR_GOVERNOR=0x<unlock-authority>

forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$SEPOLIA_RPC_URL" \
  --broadcast \
  --verify \
  -vvvv
```

Drop `--verify` if you have no Etherscan key configured (`ETHERSCAN_API_KEY`).
Record the deployed address and the constructor `relayerOrGovernor` for the
relayer and the Soroban `ObscuraBridge` constructor (`l1_bridge_addr`).

> Not deployed from this repo (no key present here). The command above is the
> intended deployment path.

---

## Layout

```
bridge/l1/
├── foundry.toml
├── src/ObscuraBridgeL1.sol          # contract + minimal IERC20
├── test/ObscuraBridgeL1.t.sol       # storage-slot + lock/unlock + fuzz
├── script/Deploy.s.sol             # Sepolia deploy (env-driven)
└── lib/forge-std/                   # submodule
```
