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
    TimelockController governanceTimelock;
    TimelockController emergencyTimelock;
    address multisig = address(0xA11CE);
    address emergencyMultisig = address(0xE000);
    bytes32 constant L2_TOKEN = bytes32(uint256(0xa2c7e9));

    function setUp() public {
        vm.warp(100);  // avoid OZ TimelockController _DONE_TIMESTAMP=1 collision

        token = new MockERC20();
        inbox = new MockInbox();
        outbox = new MockOutbox();

        // Governance timelock: 0 delay (testnet) for test ergonomics
        address[] memory proposers = new address[](1); proposers[0] = multisig;
        address[] memory executors = new address[](1); executors[0] = address(0);
        governanceTimelock = new TimelockController(0, proposers, executors, multisig);

        // Emergency timelock: 0 delay, separate multisig
        address[] memory emProposers = new address[](1); emProposers[0] = emergencyMultisig;
        address[] memory emExecutors = new address[](1); emExecutors[0] = address(0);
        emergencyTimelock = new TimelockController(0, emProposers, emExecutors, emergencyMultisig);

        // Bridge proxy
        TokenBridge impl = new TokenBridge();
        bytes memory init = abi.encodeWithSelector(
            TokenBridge.initialize.selector,
            IERC20(address(token)), L2_TOKEN, uint256(1),
            IInbox(address(inbox)), IOutbox(address(outbox)),
            address(governanceTimelock), address(emergencyTimelock), uint256(0)
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), init);
        bridge = TokenBridge(address(proxy));
    }

    // ── 1. pause via emergency timelock ──────────────────────────────────────
    function test_pause_throughTimelock_succeeds() public {
        bytes memory data = abi.encodeWithSignature("pause()");
        vm.prank(emergencyMultisig);
        emergencyTimelock.schedule(address(bridge), 0, data, bytes32(0), bytes32(0), 0);
        vm.prank(emergencyMultisig);
        emergencyTimelock.execute(address(bridge), 0, data, bytes32(0), bytes32(0));
        assertTrue(bridge.paused());
    }

    // ── 2. direct pause from any address (no role) reverts ───────────────────
    function test_pause_byNonOwner_reverts() public {
        // OZ AccessControl: AccessControlUnauthorizedAccount(address,bytes32)
        vm.expectRevert();
        bridge.pause();
    }

    // ── 3. setL2TokenAddress via governance timelock succeeds + updates state ─
    function test_setL2TokenAddress_throughTimelock_succeeds() public {
        bytes32 newAddr = bytes32(uint256(0xbeefcafe));
        bytes memory data = abi.encodeWithSignature("setL2TokenAddress(bytes32)", newAddr);

        vm.prank(multisig);
        governanceTimelock.schedule(address(bridge), 0, data, bytes32(0), bytes32(0), 0);
        vm.prank(multisig);
        governanceTimelock.execute(address(bridge), 0, data, bytes32(0), bytes32(0));

        assertEq(bridge.l2TokenAddress(), newAddr);
    }

    // ── 4. setMaxTvl via governance timelock succeeds + updates state ─────────
    function test_setMaxTvl_throughTimelock_succeeds() public {
        bytes memory data = abi.encodeWithSignature("setMaxTvl(uint256)", uint256(1_000_000_000_000));
        vm.prank(multisig);
        governanceTimelock.schedule(address(bridge), 0, data, bytes32(0), bytes32(0), 0);
        vm.prank(multisig);
        governanceTimelock.execute(address(bridge), 0, data, bytes32(0), bytes32(0));
        assertEq(bridge.maxTvl(), 1_000_000_000_000);
    }

    // ── 5. multisig calling bridge directly (bypassing timelock) reverts ─────
    function test_directPauseFromMultisig_reverts() public {
        // Even multisig (the governance timelock's admin) cannot call bridge.pause()
        // directly because multisig holds no role on the bridge — only the
        // governance TimelockController holds GOVERNANCE_ROLE.
        // OZ AccessControl: AccessControlUnauthorizedAccount(address,bytes32)
        vm.prank(multisig);
        vm.expectRevert();
        bridge.pause();
    }

    // ── 6. governance timelock cannot pause (lacks EMERGENCY_PAUSER_ROLE) ────
    function test_governanceTimelockCannotPause() public {
        bytes memory data = abi.encodeWithSignature("pause()");
        vm.prank(multisig);
        governanceTimelock.schedule(address(bridge), 0, data, bytes32(0), bytes32(0), 0);
        vm.prank(multisig);
        vm.expectRevert();  // bridge reverts: governanceTimelock lacks EMERGENCY_PAUSER_ROLE
        governanceTimelock.execute(address(bridge), 0, data, bytes32(0), bytes32(0));
    }
}
