// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IERC20 — minimal ERC20 interface (no external deps).
/// @dev Only the two methods the bridge needs. Return values are checked
///      defensively (some non-standard tokens, e.g. USDT, return no data).
interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @title ObscuraBridgeL1
/// @notice Minimal lock/unlock escrow for the Obscura trust-minimized cross-chain
///         bridge (Ethereum Sepolia -> Stellar/Soroban). See BRIDGE_SPEC §4, §12.
///
///         `lock` escrows native ETH or an ERC20 against a Obscura note `commitment`.
///         The Soroban `EthLightClient` + `ObscuraBridge` prove the resulting storage
///         word via an EIP-1186 MPT inclusion proof against a trusted execution
///         `state_root`, then mint a shielded note. `unlock` releases the escrow
///         after a verified L2 `bridge_out` (governor-gated for the hackathon).
///
/// @dev    STORAGE LAYOUT IS LOAD-BEARING. `locks` MUST stay the first declared
///         state variable so its mapping lives at declaration slot p = 0. The
///         Soroban MPT verifier derives the storage slot as
///             slot = keccak256(abi.encode(commitment, uint256(0)))
///         and decodes the single 32-byte word as the packed `LockRecord`.
///         See bridge/l1/README.md for the exact byte packing + a worked example.
contract ObscuraBridgeL1 {
    // -------------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------------

    /// @notice Packed lock record — fits in ONE 32-byte storage word.
    /// @dev    Solidity packs declaration-order fields low-order-first, so within
    ///         the word W (big-endian, as returned by `vm.load` / read from the
    ///         MPT leaf):
    ///           - `token`  occupies the low-order 160 bits  -> the 20 LEAST-significant bytes
    ///           - `amount` occupies the high-order 96 bits   -> the 12 MOST-significant bytes
    ///         i.e. W == (uint256(amount) << 160) | uint256(uint160(token)).
    ///         `token == address(0)` means native ETH.
    struct LockRecord {
        address token;  // low 20 bytes
        uint96  amount; // high 12 bytes
    }

    // -------------------------------------------------------------------------
    // Storage — order is part of the protocol. Do NOT reorder.
    // -------------------------------------------------------------------------

    /// @notice commitment => packed lock record. DECLARATION SLOT 0 (load-bearing).
    mapping(bytes32 => LockRecord) public locks; // slot 0

    /// @notice commitment => settled-on-L2 flag, set true on `unlock`. SLOT 1.
    mapping(bytes32 => bool) public spentOnL2; // slot 1

    /// @notice Address authorized to settle `unlock` (relayer/governor).
    /// @dev    `immutable` => baked into bytecode, consumes NO storage slot, so it
    ///         does not shift `locks` (slot 0) or `spentOnL2` (slot 1).
    address public immutable relayerOrGovernor;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    /// @notice Emitted on a successful lock. `amount` is the full (untruncated) value.
    event Locked(bytes32 indexed commitment, address token, uint256 amount);

    /// @notice Emitted when escrowed funds are released back on L1.
    event Unlocked(bytes32 indexed commitment, address indexed to, address token, uint256 amount);

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error CommitmentUsed();
    error ZeroAmount();
    error AmountTooLarge();
    error BadEthValue();
    error NotGovernor();
    error UnknownCommitment();
    error AlreadyUnlocked();
    error EthTransferFailed();
    error TransferFromFailed();
    error TransferFailed();

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    /// @param _relayerOrGovernor address allowed to call `unlock`.
    constructor(address _relayerOrGovernor) {
        relayerOrGovernor = _relayerOrGovernor;
    }

    // -------------------------------------------------------------------------
    // Lock
    // -------------------------------------------------------------------------

    /// @notice Escrow `amount` of `token` (or native ETH if `token == address(0)`)
    ///         against a unique Obscura note `commitment`.
    /// @param commitment Obscura note commitment = hash4(asset_id, amount, owner, blinding).
    /// @param token      ERC20 address, or `address(0)` for native ETH.
    /// @param amount     amount to lock; must be non-zero and fit in uint96.
    function lock(bytes32 commitment, address token, uint256 amount) external payable {
        // Replay guard: a populated record always has amount != 0 (see ZeroAmount below),
        // so amount != 0 unambiguously means "commitment already used".
        if (locks[commitment].amount != 0) revert CommitmentUsed();
        if (amount == 0) revert ZeroAmount();
        // Value soundness: the stored uint96 MUST equal the locked amount, otherwise the
        // L2 mint would not match the L1 escrow. Reject anything that would truncate.
        if (amount > type(uint96).max) revert AmountTooLarge();

        if (token == address(0)) {
            if (msg.value != amount) revert BadEthValue();
        } else {
            if (msg.value != 0) revert BadEthValue();
            _safeTransferFrom(token, msg.sender, address(this), amount);
        }

        // Safe: `amount <= type(uint96).max` is enforced above.
        // forge-lint: disable-next-line(unsafe-typecast)
        locks[commitment] = LockRecord({token: token, amount: uint96(amount)});
        emit Locked(commitment, token, amount);
    }

    // -------------------------------------------------------------------------
    // Unlock (settlement)
    // -------------------------------------------------------------------------

    /// @notice Release the escrow for `commitment` to `to`. Settles a verified L2
    ///         `bridge_out`. Governor-gated for the hackathon (BRIDGE_SPEC §4, §8).
    /// @dev    Checks-Effects-Interactions: `spentOnL2` is set before any transfer,
    ///         so a re-entrant call hits `AlreadyUnlocked`.
    function unlock(bytes32 commitment, address to) external {
        if (msg.sender != relayerOrGovernor) revert NotGovernor();
        if (spentOnL2[commitment]) revert AlreadyUnlocked();

        LockRecord memory rec = locks[commitment];
        if (rec.amount == 0) revert UnknownCommitment();

        spentOnL2[commitment] = true; // effect before interaction

        if (rec.token == address(0)) {
            (bool ok, ) = payable(to).call{value: rec.amount}("");
            if (!ok) revert EthTransferFailed();
        } else {
            _safeTransfer(rec.token, to, rec.amount);
        }

        emit Unlocked(commitment, to, rec.token, rec.amount);
    }

    // -------------------------------------------------------------------------
    // Internal: defensive ERC20 transfers (tolerate no-return-data tokens)
    // -------------------------------------------------------------------------

    function _safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory data) =
            token.call(abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFromFailed();
    }

    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) =
            token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
