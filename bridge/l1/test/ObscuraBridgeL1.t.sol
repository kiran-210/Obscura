// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ObscuraBridgeL1} from "../src/ObscuraBridgeL1.sol";

/// @dev Minimal standards-compliant ERC20 for the ERC20 lock/unlock paths.
contract MockERC20 {
    string public name = "Mock";
    string public symbol = "MOCK";
    uint8 public decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
    }

    function approve(address spender, uint256 amt) external returns (bool) {
        allowance[msg.sender][spender] = amt;
        return true;
    }

    function transfer(address to, uint256 amt) external returns (bool) {
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        return true;
    }

    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        allowance[from][msg.sender] -= amt;
        balanceOf[from] -= amt;
        balanceOf[to] += amt;
        return true;
    }
}

/// @dev ERC20 that returns no data (USDT-style) — exercises the defensive transfer path.
contract NoReturnERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
    }

    function approve(address spender, uint256 amt) external {
        allowance[msg.sender][spender] = amt;
    }

    function transfer(address to, uint256 amt) external {
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
    }

    function transferFrom(address from, address to, uint256 amt) external {
        allowance[from][msg.sender] -= amt;
        balanceOf[from] -= amt;
        balanceOf[to] += amt;
    }
}

contract ObscuraBridgeL1Test is Test {
    ObscuraBridgeL1 internal bridge;
    MockERC20 internal token;

    address internal governor;
    address internal alice = address(0xA11CE);
    address internal recipient = address(0xBEEF);

    bytes32 internal constant COMMITMENT = keccak256("obscura-note-1");

    event Locked(bytes32 indexed commitment, address token, uint256 amount);
    event Unlocked(bytes32 indexed commitment, address indexed to, address token, uint256 amount);

    function setUp() public {
        governor = makeAddr("governor");
        bridge = new ObscuraBridgeL1(governor);
        token = new MockERC20();
    }

    // =========================================================================
    // LOAD-BEARING: storage-slot derivation + LockRecord packing
    //
    // The entire Soroban MPT inclusion proof depends on:
    //   slot = keccak256(abi.encode(commitment, uint256(0)))    // locks at decl slot 0
    //   word = (uint256(amount) << 160) | uint256(uint160(token))
    // i.e. token in the LOW 20 bytes, amount in the HIGH 12 bytes of the 32-byte word.
    // =========================================================================

    function test_StorageSlot_Derivation_And_Packing_ERC20() public {
        uint96 amount = 123_456_789;
        token.mint(alice, amount);

        vm.startPrank(alice);
        token.approve(address(bridge), amount);
        bridge.lock(COMMITMENT, address(token), amount);
        vm.stopPrank();

        // 1. Derive the storage slot exactly as the Soroban verifier will.
        bytes32 slot = keccak256(abi.encode(COMMITMENT, uint256(0)));

        // 2. Read the raw 32-byte word straight out of contract storage.
        bytes32 word = vm.load(address(bridge), slot);

        // 3. Decode (token, amount) from the word per the documented packing.
        address decodedToken = address(uint160(uint256(word)));         // low 160 bits
        uint96 decodedAmount = uint96(uint256(word) >> 160);            // high 96 bits

        assertEq(decodedToken, address(token), "token mismatch");
        assertEq(decodedAmount, amount, "amount mismatch");

        // 4. Reconstruct the expected word independently and compare bit-for-bit.
        bytes32 expected = bytes32((uint256(amount) << 160) | uint256(uint160(address(token))));
        assertEq(word, expected, "packed word mismatch");

        // 5. Byte-position assertions (unambiguous): token = low 20 bytes, amount = high 12 bytes.
        assertEq(uint256(word) & ((uint256(1) << 160) - 1), uint256(uint160(address(token))), "low 20 bytes != token");
        assertEq(uint256(word) >> 160, uint256(amount), "high 12 bytes != amount");

        // 6. Public getter agrees with the raw word.
        (address gToken, uint96 gAmount) = bridge.locks(COMMITMENT);
        assertEq(gToken, address(token));
        assertEq(gAmount, amount);
    }

    function test_StorageSlot_Derivation_And_Packing_NativeETH() public {
        uint96 amount = 1 ether;
        vm.deal(alice, amount);

        vm.prank(alice);
        bridge.lock{value: amount}(COMMITMENT, address(0), amount);

        bytes32 slot = keccak256(abi.encode(COMMITMENT, uint256(0)));
        bytes32 word = vm.load(address(bridge), slot);

        // token == address(0) => low 160 bits are zero; amount sits in the high 96 bits.
        assertEq(address(uint160(uint256(word))), address(0), "native token slot not zero");
        assertEq(uint96(uint256(word) >> 160), amount, "native amount mismatch");
        assertEq(word, bytes32(uint256(amount) << 160), "native packed word mismatch");
    }

    // =========================================================================
    // lock — native vs ERC20, events, balances, replay/validation guards
    // =========================================================================

    function test_Lock_NativeETH_EscrowsAndEmits() public {
        uint96 amount = 2 ether;
        vm.deal(alice, amount);

        vm.expectEmit(true, false, false, true, address(bridge));
        emit Locked(COMMITMENT, address(0), amount);

        vm.prank(alice);
        bridge.lock{value: amount}(COMMITMENT, address(0), amount);

        assertEq(address(bridge).balance, amount, "eth not escrowed");
        (address t, uint96 a) = bridge.locks(COMMITMENT);
        assertEq(t, address(0));
        assertEq(a, amount);
    }

    function test_Lock_ERC20_PullsAndEmits() public {
        uint96 amount = 5_000;
        token.mint(alice, amount);

        vm.startPrank(alice);
        token.approve(address(bridge), amount);

        vm.expectEmit(true, false, false, true, address(bridge));
        emit Locked(COMMITMENT, address(token), amount);
        bridge.lock(COMMITMENT, address(token), amount);
        vm.stopPrank();

        assertEq(token.balanceOf(address(bridge)), amount, "erc20 not pulled");
        assertEq(token.balanceOf(alice), 0);
    }

    function test_Lock_NoReturnERC20_Succeeds() public {
        NoReturnERC20 weird = new NoReturnERC20();
        uint96 amount = 7;
        weird.mint(alice, amount);

        vm.startPrank(alice);
        weird.approve(address(bridge), amount);
        bridge.lock(COMMITMENT, address(weird), amount);
        vm.stopPrank();

        assertEq(weird.balanceOf(address(bridge)), amount);
    }

    function test_Lock_RevertWhen_CommitmentReused() public {
        uint96 amount = 1 ether;
        vm.deal(alice, 2 ether);

        vm.startPrank(alice);
        bridge.lock{value: amount}(COMMITMENT, address(0), amount);

        vm.expectRevert(ObscuraBridgeL1.CommitmentUsed.selector);
        bridge.lock{value: amount}(COMMITMENT, address(0), amount);
        vm.stopPrank();
    }

    function test_Lock_RevertWhen_NativeValueMismatch() public {
        vm.deal(alice, 3 ether);
        vm.prank(alice);
        vm.expectRevert(ObscuraBridgeL1.BadEthValue.selector);
        bridge.lock{value: 1 ether}(COMMITMENT, address(0), 2 ether);
    }

    function test_Lock_RevertWhen_EthSentWithERC20() public {
        uint96 amount = 100;
        token.mint(alice, amount);
        vm.deal(alice, 1 ether);
        vm.startPrank(alice);
        token.approve(address(bridge), amount);
        vm.expectRevert(ObscuraBridgeL1.BadEthValue.selector);
        bridge.lock{value: 1}(COMMITMENT, address(token), amount);
        vm.stopPrank();
    }

    function test_Lock_RevertWhen_ZeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(ObscuraBridgeL1.ZeroAmount.selector);
        bridge.lock(COMMITMENT, address(0), 0);
    }

    function test_Lock_RevertWhen_AmountExceedsUint96() public {
        uint256 tooBig = uint256(type(uint96).max) + 1;
        vm.deal(alice, tooBig);
        vm.prank(alice);
        vm.expectRevert(ObscuraBridgeL1.AmountTooLarge.selector);
        bridge.lock{value: tooBig}(COMMITMENT, address(0), tooBig);
    }

    // =========================================================================
    // unlock — gating, double-unlock, native + ERC20 settlement
    // =========================================================================

    function test_Unlock_Native_OnlyGovernor_ReleasesFunds() public {
        uint96 amount = 4 ether;
        vm.deal(alice, amount);
        vm.prank(alice);
        bridge.lock{value: amount}(COMMITMENT, address(0), amount);

        vm.expectEmit(true, true, false, true, address(bridge));
        emit Unlocked(COMMITMENT, recipient, address(0), amount);

        vm.prank(governor);
        bridge.unlock(COMMITMENT, recipient);

        assertEq(recipient.balance, amount, "recipient not paid");
        assertEq(address(bridge).balance, 0, "bridge still holds eth");
        assertTrue(bridge.spentOnL2(COMMITMENT), "spent flag not set");
    }

    function test_Unlock_ERC20_ReleasesFunds() public {
        uint96 amount = 9_000;
        token.mint(alice, amount);
        vm.startPrank(alice);
        token.approve(address(bridge), amount);
        bridge.lock(COMMITMENT, address(token), amount);
        vm.stopPrank();

        vm.prank(governor);
        bridge.unlock(COMMITMENT, recipient);

        assertEq(token.balanceOf(recipient), amount);
        assertEq(token.balanceOf(address(bridge)), 0);
    }

    function test_Unlock_RevertWhen_NotGovernor() public {
        uint96 amount = 1 ether;
        vm.deal(alice, amount);
        vm.prank(alice);
        bridge.lock{value: amount}(COMMITMENT, address(0), amount);

        vm.prank(alice); // not the governor
        vm.expectRevert(ObscuraBridgeL1.NotGovernor.selector);
        bridge.unlock(COMMITMENT, recipient);
    }

    function test_Unlock_RevertWhen_DoubleUnlock() public {
        uint96 amount = 1 ether;
        vm.deal(alice, amount);
        vm.prank(alice);
        bridge.lock{value: amount}(COMMITMENT, address(0), amount);

        vm.startPrank(governor);
        bridge.unlock(COMMITMENT, recipient);
        vm.expectRevert(ObscuraBridgeL1.AlreadyUnlocked.selector);
        bridge.unlock(COMMITMENT, recipient);
        vm.stopPrank();
    }

    function test_Unlock_RevertWhen_UnknownCommitment() public {
        vm.prank(governor);
        vm.expectRevert(ObscuraBridgeL1.UnknownCommitment.selector);
        bridge.unlock(keccak256("never-locked"), recipient);
    }

    // =========================================================================
    // Constructor wiring
    // =========================================================================

    function test_Constructor_SetsGovernor() public view {
        assertEq(bridge.relayerOrGovernor(), governor);
    }

    // =========================================================================
    // Fuzz: the slot/word formula the Soroban verifier relies on holds for any
    // (commitment, amount) on the native path, and for any (commitment, amount)
    // against a real ERC20 (token in the low 20 bytes).
    // =========================================================================

    function testFuzz_Packing_NativeETH(bytes32 commitment, uint96 amount) public {
        vm.assume(amount != 0);
        vm.deal(address(this), amount);
        bridge.lock{value: amount}(commitment, address(0), amount);

        bytes32 slot = keccak256(abi.encode(commitment, uint256(0)));
        bytes32 word = vm.load(address(bridge), slot);
        assertEq(address(uint160(uint256(word))), address(0));
        assertEq(uint96(uint256(word) >> 160), amount);
        assertEq(word, bytes32(uint256(amount) << 160));
    }

    function testFuzz_Packing_ERC20(bytes32 commitment, uint96 amount) public {
        vm.assume(amount != 0);
        token.mint(address(this), amount);
        token.approve(address(bridge), amount);
        bridge.lock(commitment, address(token), amount);

        bytes32 slot = keccak256(abi.encode(commitment, uint256(0)));
        bytes32 word = vm.load(address(bridge), slot);
        assertEq(address(uint160(uint256(word))), address(token), "token low-bytes mismatch");
        assertEq(uint96(uint256(word) >> 160), amount, "amount high-bytes mismatch");
        assertEq(word, bytes32((uint256(amount) << 160) | uint256(uint160(address(token)))));
    }

    // This contract receives ETH in the fuzz native path (it is msg.sender of lock).
    receive() external payable {}
}
