// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {TokenBridge} from "../src/TokenBridge.sol";
import {IInbox} from "../src/interfaces/IInbox.sol";
import {IOutbox} from "../src/interfaces/IOutbox.sol";
import {DataStructures} from "../src/lib/DataStructures.sol";
import {Epoch} from "../src/lib/TimeMath.sol";

// ── Mocks ─────────────────────────────────────────────────────────────────────

contract MockERC20 is IERC20 {
    string public name = "Mock";
    string public symbol = "MOCK";
    uint8 public decimals = 6;
    mapping(address => uint256) public override balanceOf;
    mapping(address => mapping(address => uint256)) public override allowance;
    uint256 public override totalSupply;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external override returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external override returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

contract MockInbox is IInbox {
    uint256 public nextIndex;

    function sendL2Message(DataStructures.L2Actor memory /* recipient */, bytes32 content, bytes32 secretHash)
        external
        returns (bytes32, uint256)
    {
        uint256 idx = nextIndex++;
        return (keccak256(abi.encode(content, secretHash, idx)), idx);
    }

    function consume(uint256) external pure returns (bytes32) { return bytes32(0); }
    function catchUp(uint256) external pure {}
    function getFeeAssetPortal() external pure returns (address) { return address(0); }
    function getRoot(uint256) external pure returns (bytes32) { return bytes32(0); }
    function getState() external pure returns (InboxState memory) { return InboxState(bytes16(0), 0, 0); }
    function getTotalMessagesInserted() external pure returns (uint64) { return 0; }
    function getInProgress() external pure returns (uint64) { return 0; }
}

contract MockOutbox is IOutbox {
    bool public shouldRevert;
    mapping(uint256 => mapping(uint256 => bool)) public consumed;

    function setShouldRevert(bool v) external { shouldRevert = v; }

    function insert(Epoch, bytes32) external {}

    function consume(
        DataStructures.L2ToL1Msg calldata,
        Epoch epoch,
        uint256 leafIndex,
        bytes32[] calldata
    ) external {
        if (shouldRevert) revert("outbox: invalid proof");
        uint256 e = Epoch.unwrap(epoch);
        require(!consumed[e][leafIndex], "already consumed");
        consumed[e][leafIndex] = true;
    }

    function hasMessageBeenConsumedAtEpoch(Epoch epoch, uint256 leafId) external view returns (bool) {
        return consumed[Epoch.unwrap(epoch)][leafId];
    }

    function getRootData(Epoch) external pure returns (bytes32) { return bytes32(0); }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

contract TokenBridgeTest is Test {
    TokenBridge bridge;
    MockERC20 token;
    MockInbox inbox;
    MockOutbox outbox;
    address governanceTimelock = address(0xA11CE);
    address emergencyTimelock  = address(0xE0E0);
    address alice = address(0xB0B);
    bytes32 constant L2_TOKEN = bytes32(uint256(0xa2c7e9));

    function setUp() public {
        token = new MockERC20();
        inbox = new MockInbox();
        outbox = new MockOutbox();

        // Deploy implementation + proxy + initialize in one step.
        TokenBridge impl = new TokenBridge();
        bytes memory init = abi.encodeWithSelector(
            TokenBridge.initialize.selector,
            IERC20(address(token)),
            L2_TOKEN,
            uint256(1),
            IInbox(address(inbox)),
            IOutbox(address(outbox)),
            governanceTimelock,
            emergencyTimelock,
            uint256(0) // unlimited TVL
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), init);
        bridge = TokenBridge(address(proxy));

        token.mint(alice, 1_000_000_000); // 1 000 USDC at 6 decimals
    }

    // 1. Public deposit happy path: locks tokens + returns valid index
    function test_depositToL2Public_locksTokensAndEmitsMessage() public {
        vm.startPrank(alice);
        token.approve(address(bridge), 100_000_000);
        (bytes32 hash, uint256 idx) = bridge.depositToL2Public(
            100_000_000,
            bytes32(uint256(0xfeed)),
            bytes32(uint256(0xbeef))
        );
        vm.stopPrank();

        assertEq(token.balanceOf(address(bridge)), 100_000_000, "bridge locked amount");
        assertEq(token.balanceOf(alice), 900_000_000, "alice debited");
        assertEq(idx, 0, "first message index");
        assertGt(uint256(hash), 0, "non-zero message hash");
    }

    // 2. Private deposit happy path: same lock semantics, recipient hidden in payload
    function test_depositToL2Private_omitsRecipientFromMessage() public {
        vm.startPrank(alice);
        token.approve(address(bridge), 50_000_000);

        // Expect DepositInitiated(sender=alice, l2Recipient=bytes32(0), amount, secretHash, idx=0, isPrivate=true)
        // checkTopic1=true (sender indexed), checkTopic2=true (l2Recipient indexed),
        // checkTopic3=false (no third indexed field), checkData=true (verify non-indexed fields).
        vm.expectEmit(true, true, false, true, address(bridge));
        emit TokenBridge.DepositInitiated(alice, bytes32(0), 50_000_000, bytes32(uint256(0xcafe)), 0, true);

        (, uint256 idx) = bridge.depositToL2Private(50_000_000, bytes32(uint256(0xcafe)));
        vm.stopPrank();

        assertEq(token.balanceOf(address(bridge)), 50_000_000, "bridge locked private deposit amount");
        assertEq(idx, 0, "first private deposit index");
    }

    // 3. Paused portal blocks deposits
    function test_deposit_revertsWhenPaused() public {
        vm.prank(emergencyTimelock);
        bridge.pause();

        vm.startPrank(alice);
        token.approve(address(bridge), 100);
        // OZ PausableUpgradeable: EnforcedPause() — selector omitted to keep test concise
        vm.expectRevert();
        bridge.depositToL2Public(100, bytes32(uint256(0xfeed)), bytes32(uint256(0xbeef)));
        vm.stopPrank();
    }

    // 4. TVL cap is enforced (custom error TvlCapExceeded)
    function test_deposit_revertsOnTvlCap() public {
        vm.prank(governanceTimelock);
        bridge.setMaxTvl(50_000_000);

        vm.startPrank(alice);
        token.approve(address(bridge), 100_000_000);
        vm.expectRevert(
            abi.encodeWithSelector(
                TokenBridge.TvlCapExceeded.selector,
                uint256(100_000_000),
                uint256(50_000_000)
            )
        );
        bridge.depositToL2Public(100_000_000, bytes32(uint256(0xfeed)), bytes32(uint256(0xbeef)));
        vm.stopPrank();
    }

    // 5a. Zero-amount deposit reverts
    function test_deposit_revertsOnZeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(TokenBridge.ZeroAmount.selector);
        bridge.depositToL2Public(0, bytes32(uint256(0xfeed)), bytes32(uint256(0xbeef)));
    }

    // 5b. Zero-recipient deposit reverts
    function test_deposit_revertsOnZeroL2Recipient() public {
        vm.startPrank(alice);
        token.approve(address(bridge), 100);
        vm.expectRevert(TokenBridge.ZeroAddress.selector);
        bridge.depositToL2Public(100, bytes32(0), bytes32(uint256(0xbeef)));
        vm.stopPrank();
    }

    // 5c. Zero-amount withdraw reverts
    function test_withdraw_revertsOnZeroAmount() public {
        bytes32[] memory proof = new bytes32[](6);
        vm.expectRevert(TokenBridge.ZeroAmount.selector);
        bridge.withdraw(0, alice, uint256(12345), uint256(7), proof);
    }

    // 5d. Zero-recipient withdraw reverts
    function test_withdraw_revertsOnZeroRecipient() public {
        bytes32[] memory proof = new bytes32[](6);
        vm.expectRevert(TokenBridge.ZeroAddress.selector);
        bridge.withdraw(100, address(0), uint256(12345), uint256(7), proof);
    }

    // 6. Withdraw happy path: outbox.consume succeeds → release to recipient
    function test_withdraw_releasesTokensOnValidProof() public {
        // Pre-fund bridge as if a prior deposit happened.
        token.mint(address(bridge), 100_000_000);

        bytes32[] memory proof = new bytes32[](6);
        bridge.withdraw(80_000_000, alice, uint256(12345), uint256(7), proof);

        assertEq(token.balanceOf(alice), 1_000_000_000 + 80_000_000, "alice received withdrawn amount");
        assertEq(token.balanceOf(address(bridge)), 20_000_000, "bridge debited correctly");
    }

    // 6a. Double-withdrawal replay is rejected by MockOutbox's consumed[] guard
    function test_withdraw_doubleConsume_reverts() public {
        token.mint(address(bridge), 200_000_000);
        bytes32[] memory proof = new bytes32[](6);

        // First withdrawal succeeds
        bridge.withdraw(80_000_000, alice, uint256(12345), uint256(7), proof);
        assertEq(token.balanceOf(alice), 1_000_000_000 + 80_000_000, "alice received first withdraw");

        // Second withdrawal with same (l2Epoch, leafIndex) must revert via Outbox replay guard
        vm.expectRevert(bytes("already consumed"));
        bridge.withdraw(80_000_000, alice, uint256(12345), uint256(7), proof);
    }

    // 7. Withdraw reverts when outbox proof is invalid
    function test_withdraw_revertsOnInvalidProof() public {
        token.mint(address(bridge), 100_000_000);
        outbox.setShouldRevert(true);

        bytes32[] memory proof = new bytes32[](6);
        vm.expectRevert(bytes("outbox: invalid proof"));
        bridge.withdraw(50_000_000, alice, uint256(12345), uint256(7), proof);
    }

    // 7. Paused portal blocks withdraws
    function test_withdraw_revertsWhenPaused() public {
        vm.prank(emergencyTimelock);
        bridge.pause();

        bytes32[] memory proof = new bytes32[](6);
        // OZ PausableUpgradeable: EnforcedPause() — selector omitted to keep test concise
        vm.expectRevert();
        bridge.withdraw(50_000_000, alice, uint256(12345), uint256(7), proof);
    }

    // 8. pause() requires EMERGENCY_PAUSER_ROLE
    function test_pause_requiresEmergencyRole() public {
        // Called from address(this) which holds no role.
        // OZ AccessControl: AccessControlUnauthorizedAccount(address,bytes32) — selector omitted
        vm.expectRevert();
        bridge.pause();
    }

    // 9. setMaxTvl() requires GOVERNANCE_ROLE
    function test_setMaxTvl_requiresGovernanceRole() public {
        // OZ AccessControl: AccessControlUnauthorizedAccount(address,bytes32) — selector omitted
        vm.expectRevert();
        bridge.setMaxTvl(123);
    }

    // 10. withdrawTreasuryDust cannot drain l1Token
    function test_withdrawTreasuryDust_cannotDrainL1Token() public {
        token.mint(address(bridge), 100);
        vm.prank(governanceTimelock);
        vm.expectRevert(TokenBridge.CannotSweepL1Token.selector);
        bridge.withdrawTreasuryDust(IERC20(address(token)), 100, governanceTimelock);
    }

    // 11. totalLocked() reports the live ERC20 balance
    function test_totalLocked_reportsBalance() public {
        token.mint(address(bridge), 500);
        assertEq(bridge.totalLocked(), 500, "totalLocked reflects minted balance");
    }

    // 12. Role separation invariant: governance cannot pause; emergency cannot govern
    function test_governanceCannotPause_emergencyCannotGovern() public {
        // governanceTimelock holds GOVERNANCE_ROLE only; cannot pause
        vm.prank(governanceTimelock);
        vm.expectRevert();  // OZ AccessControl: AccessControlUnauthorizedAccount(governanceTimelock, EMERGENCY_PAUSER_ROLE)
        bridge.pause();

        // emergencyTimelock holds EMERGENCY_PAUSER_ROLE only; cannot setMaxTvl
        vm.prank(emergencyTimelock);
        vm.expectRevert();  // OZ AccessControl: AccessControlUnauthorizedAccount(emergencyTimelock, GOVERNANCE_ROLE)
        bridge.setMaxTvl(123);
    }

    // 13. A1 self-admin invariant: governance CANNOT revoke emergency role
    function test_governanceCannotRevokeEmergencyRole() public {
        // governanceTimelock holds DEFAULT_ADMIN_ROLE but EMERGENCY_PAUSER_ROLE's
        // admin role is EMERGENCY_PAUSER_ROLE itself (set in initialize).
        // Pre-fetch the role before vm.expectRevert so the view call doesn't consume it.
        bytes32 emergencyRole = bridge.EMERGENCY_PAUSER_ROLE();
        vm.prank(governanceTimelock);
        vm.expectRevert();  // AccessControlUnauthorizedAccount: governance lacks EMERGENCY_PAUSER_ROLE admin
        bridge.revokeRole(emergencyRole, emergencyTimelock);
    }

    // ── Sub-5c B2: recoverDeposit 3-phase flow tests ──────────────────────────────

    function test_requestRecovery_revertsBeforeWindow() public {
        vm.startPrank(alice);
        token.approve(address(bridge), 100_000_000);
        bridge.depositToL2Public(100_000_000, bytes32(uint256(0xfeed)), bytes32(uint256(0xbeef)));
        // Try to recover immediately (no 90-day wait)
        vm.expectRevert(TokenBridge.DepositTooRecent.selector);
        bridge.requestRecovery(bytes32(uint256(0xbeef)));
        vm.stopPrank();
    }

    function test_requestRecovery_revertsForUnknownDeposit() public {
        vm.prank(alice);
        vm.expectRevert(TokenBridge.NoSuchDeposit.selector);
        bridge.requestRecovery(bytes32(uint256(0xc0ffee)));
    }

    function test_recoveryHappyPath_3phase() public {
        // Phase 0: alice deposits 100 USDC
        vm.startPrank(alice);
        token.approve(address(bridge), 100_000_000);
        bridge.depositToL2Public(100_000_000, bytes32(uint256(0xfeed)), bytes32(uint256(0xbeef)));
        vm.stopPrank();

        // Skip 91 days
        vm.warp(block.timestamp + 91 days);

        // Phase 1: alice requests recovery
        vm.prank(alice);
        bridge.requestRecovery(bytes32(uint256(0xbeef)));

        // Phase 2: governance multisig approves
        bytes32 aliceKey = keccak256(abi.encode(alice, bytes32(uint256(0xbeef))));
        vm.prank(governanceTimelock);
        bridge.approveRecovery(aliceKey);

        // Phase 3: alice executes recovery to her own address
        uint256 balanceBefore = token.balanceOf(alice);
        vm.prank(alice);
        bridge.executeRecovery(bytes32(uint256(0xbeef)), alice);

        assertEq(token.balanceOf(alice), balanceBefore + 100_000_000, "alice recovered amount");
        assertEq(token.balanceOf(address(bridge)), 0, "bridge fully debited");
    }

    function test_recovery_foreignSenderCannotExecute() public {
        // Alice deposits + waits + requests + governance approves
        vm.startPrank(alice);
        token.approve(address(bridge), 100_000_000);
        bridge.depositToL2Public(100_000_000, bytes32(uint256(0xfeed)), bytes32(uint256(0xbeef)));
        vm.stopPrank();
        vm.warp(block.timestamp + 91 days);
        vm.prank(alice);
        bridge.requestRecovery(bytes32(uint256(0xbeef)));
        bytes32 aliceKey = keccak256(abi.encode(alice, bytes32(uint256(0xbeef))));
        vm.prank(governanceTimelock);
        bridge.approveRecovery(aliceKey);

        // Bob (knows the secret) attempts to execute — his msg.sender computes a
        // different key, no approval exists for that key, revert.
        address bob = address(0xB0B1);
        vm.prank(bob);
        vm.expectRevert(TokenBridge.NotApproved.selector);
        bridge.executeRecovery(bytes32(uint256(0xbeef)), bob);
    }

    function test_approveRecovery_requiresGovernance() public {
        vm.startPrank(alice);
        token.approve(address(bridge), 100_000_000);
        bridge.depositToL2Public(100_000_000, bytes32(uint256(0xfeed)), bytes32(uint256(0xbeef)));
        vm.stopPrank();
        vm.warp(block.timestamp + 91 days);
        vm.prank(alice);
        bridge.requestRecovery(bytes32(uint256(0xbeef)));

        // Alice (not governance) tries to approve — should revert
        bytes32 key = keccak256(abi.encode(alice, bytes32(uint256(0xbeef))));
        vm.prank(alice);
        vm.expectRevert();  // OZ AccessControlUnauthorizedAccount(alice, GOVERNANCE_ROLE)
        bridge.approveRecovery(key);
    }
}
