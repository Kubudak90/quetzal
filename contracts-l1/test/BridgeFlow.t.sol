// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.27;

import {Test, console} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {TokenBridge} from "../src/TokenBridge.sol";
import {IInbox} from "../src/interfaces/IInbox.sol";
import {IOutbox} from "../src/interfaces/IOutbox.sol";
import {DataStructures} from "../src/lib/DataStructures.sol";
import {Epoch} from "../src/lib/TimeMath.sol";

// Same minimal mocks as TokenBridge.t.sol — inlined for isolation
contract MockERC20 is IERC20 {
    string public name = "M"; string public symbol = "M"; uint8 public decimals = 6;
    mapping(address => uint256) public override balanceOf;
    mapping(address => mapping(address => uint256)) public override allowance;
    uint256 public override totalSupply;
    function mint(address t, uint256 a) external { balanceOf[t]+=a; totalSupply+=a; emit Transfer(address(0),t,a); }
    function transfer(address t, uint256 a) external override returns (bool) { balanceOf[msg.sender]-=a; balanceOf[t]+=a; emit Transfer(msg.sender,t,a); return true; }
    function approve(address s, uint256 a) external override returns (bool) { allowance[msg.sender][s]=a; emit Approval(msg.sender,s,a); return true; }
    function transferFrom(address f, address t, uint256 a) external override returns (bool) { allowance[f][msg.sender]-=a; balanceOf[f]-=a; balanceOf[t]+=a; emit Transfer(f,t,a); return true; }
}
contract MockInbox is IInbox {
    uint256 public nextIndex;
    function sendL2Message(DataStructures.L2Actor memory, bytes32, bytes32)
        external returns (bytes32, uint256)
    { uint256 i = nextIndex++; return (bytes32(uint256(i)+1), i); }
    function consume(uint256) external pure returns (bytes32) { return bytes32(0); }
    function catchUp(uint256) external pure {}
    function getFeeAssetPortal() external pure returns (address) { return address(0); }
    function getRoot(uint256) external pure returns (bytes32) { return bytes32(0); }
    function getState() external pure returns (InboxState memory) { return InboxState(bytes16(0), 0, 0); }
    function getTotalMessagesInserted() external pure returns (uint64) { return 0; }
    function getInProgress() external pure returns (uint64) { return 0; }
}
contract MockOutbox is IOutbox {
    function insert(Epoch, bytes32) external {}
    function consume(DataStructures.L2ToL1Msg calldata, Epoch, uint256, bytes32[] calldata) external {}
    function hasMessageBeenConsumedAtEpoch(Epoch, uint256) external pure returns (bool) { return false; }
    function getRootData(Epoch) external pure returns (bytes32) { return bytes32(0); }
}

contract BridgeFlowTest is Test {
    TokenBridge bridge;
    MockERC20 token;
    MockInbox inbox;
    MockOutbox outbox;
    TimelockController timelock;
    address multisig = address(0xA11CE);
    bytes32 constant L2_TOKEN = bytes32(uint256(0xa2c7e9));

    function setUp() public {
        // Warp past timestamp=1 (_DONE_TIMESTAMP sentinel in TimelockController).
        // Without this, schedule() with delay=0 sets _timestamps[id] = block.timestamp = 1,
        // which equals _DONE_TIMESTAMP, making the operation appear Done before execute() runs.
        vm.warp(100);

        token = new MockERC20();
        inbox = new MockInbox();
        outbox = new MockOutbox();

        // TimelockController: 0 delay (testnet), multisig as proposer + admin,
        // executors = [address(0)] = anyone-can-execute-after-delay.
        address[] memory proposers = new address[](1); proposers[0] = multisig;
        address[] memory executors = new address[](1); executors[0] = address(0);
        timelock = new TimelockController(0, proposers, executors, multisig);

        // Bridge proxy owned by the timelock (production topology).
        TokenBridge impl = new TokenBridge();
        bytes memory init = abi.encodeWithSelector(
            TokenBridge.initialize.selector,
            IERC20(address(token)), L2_TOKEN, uint256(1),
            IInbox(address(inbox)), IOutbox(address(outbox)),
            address(timelock), uint256(0)
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), init);
        bridge = TokenBridge(address(proxy));
    }

    // ── 1. pause via timelock ─────────────────────────────────────────────────
    function test_pause_throughTimelock_succeeds() public {
        bytes memory data = abi.encodeWithSignature("pause()");
        vm.prank(multisig);
        timelock.schedule(address(bridge), 0, data, bytes32(0), bytes32(0), 0);

        vm.prank(multisig);
        timelock.execute(address(bridge), 0, data, bytes32(0), bytes32(0));

        assertTrue(bridge.paused(), "bridge should be paused after timelock execution");
    }

    // ── 2. direct pause from any address (not owner) reverts ─────────────────
    function test_pause_byNonOwner_reverts() public {
        // OZ OwnableUpgradeable: OwnableUnauthorizedAccount(address)
        vm.expectRevert();
        bridge.pause();
    }

    // ── 3. setL2TokenAddress via timelock succeeds + updates state ───────────
    function test_setL2TokenAddress_throughTimelock_succeeds() public {
        bytes32 newAddr = bytes32(uint256(0xbeefcafe));
        bytes memory data = abi.encodeWithSignature("setL2TokenAddress(bytes32)", newAddr);

        vm.prank(multisig);
        timelock.schedule(address(bridge), 0, data, bytes32(0), bytes32(0), 0);
        vm.prank(multisig);
        timelock.execute(address(bridge), 0, data, bytes32(0), bytes32(0));

        assertEq(bridge.l2TokenAddress(), newAddr);
    }

    // ── 4. setMaxTvl via timelock succeeds + updates state ───────────────────
    function test_setMaxTvl_throughTimelock_succeeds() public {
        bytes memory data = abi.encodeWithSignature("setMaxTvl(uint256)", uint256(1_000_000_000_000));
        vm.prank(multisig);
        timelock.schedule(address(bridge), 0, data, bytes32(0), bytes32(0), 0);
        vm.prank(multisig);
        timelock.execute(address(bridge), 0, data, bytes32(0), bytes32(0));
        assertEq(bridge.maxTvl(), 1_000_000_000_000);
    }

    // ── 5. multisig calling bridge directly (bypassing timelock) reverts ─────
    function test_directPauseFromMultisig_reverts() public {
        // Even multisig (the timelock's admin) cannot call bridge.pause() directly
        // because the bridge's owner() is the TimelockController, not multisig.
        // OZ OwnableUpgradeable: OwnableUnauthorizedAccount(multisig)
        vm.prank(multisig);
        vm.expectRevert();
        bridge.pause();
    }
}
