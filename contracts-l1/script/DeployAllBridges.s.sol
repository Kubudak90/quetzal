// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.27;

import {Script, console} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {TokenBridge} from "../src/TokenBridge.sol";
import {IInbox} from "../src/interfaces/IInbox.sol";
import {IOutbox} from "../src/interfaces/IOutbox.sol";

/// @notice Deploys (governance TimelockController, emergency TimelockController,
///         USDCBridge proxy, WETHBridge proxy, wBTCBridge proxy) in one broadcast.
///         All 3 portals are owned by both timelocks (GOVERNANCE_ROLE +
///         EMERGENCY_PAUSER_ROLE).
contract DeployAllBridges is Script {
    function run(
        address l1Usdc,
        address l1Weth,
        address l1Wbtc,
        address l1Inbox,
        address l1Outbox,
        address l1GovernanceMultisig,
        address l1EmergencyMultisig,
        uint256 governanceDelaySec,
        uint256 maxTvl
    ) external returns (
        address governanceTimelock,
        address emergencyTimelock,
        address usdcBridge,
        address wethBridge,
        address wbtcBridge
    ) {
        vm.startBroadcast();

        // 1. Governance timelock (typically 7d on mainnet, 0d on testnet)
        address[] memory govProposers = new address[](1); govProposers[0] = l1GovernanceMultisig;
        address[] memory govExecutors = new address[](1); govExecutors[0] = address(0);
        governanceTimelock = address(new TimelockController(
            governanceDelaySec, govProposers, govExecutors, l1GovernanceMultisig
        ));

        // 2. Emergency timelock (always 0d — security incidents bypass governance window)
        address[] memory emProposers = new address[](1); emProposers[0] = l1EmergencyMultisig;
        address[] memory emExecutors = new address[](1); emExecutors[0] = address(0);
        emergencyTimelock = address(new TimelockController(
            0, emProposers, emExecutors, l1EmergencyMultisig
        ));

        // 3. Three TokenBridge proxies (l2TokenAddress=bytes32(0) placeholder;
        //    the TS orchestrator wires real L2 addresses post-deploy via wirePortalL2Token)
        usdcBridge = _deployBridgeProxy(IERC20(l1Usdc), governanceTimelock, emergencyTimelock, IInbox(l1Inbox), IOutbox(l1Outbox), maxTvl);
        wethBridge = _deployBridgeProxy(IERC20(l1Weth), governanceTimelock, emergencyTimelock, IInbox(l1Inbox), IOutbox(l1Outbox), maxTvl);
        wbtcBridge = _deployBridgeProxy(IERC20(l1Wbtc), governanceTimelock, emergencyTimelock, IInbox(l1Inbox), IOutbox(l1Outbox), maxTvl);

        vm.stopBroadcast();

        console.log("GovernanceTimelock:", governanceTimelock);
        console.log("EmergencyTimelock: ", emergencyTimelock);
        console.log("USDCBridge:        ", usdcBridge);
        console.log("WETHBridge:        ", wethBridge);
        console.log("wBTCBridge:        ", wbtcBridge);
    }

    function _deployBridgeProxy(
        IERC20 token,
        address governanceTl,
        address emergencyTl,
        IInbox inbox,
        IOutbox outbox,
        uint256 maxTvl
    ) internal returns (address) {
        TokenBridge impl = new TokenBridge();
        bytes memory init = abi.encodeWithSelector(
            TokenBridge.initialize.selector,
            token, bytes32(0), uint256(1), inbox, outbox,
            governanceTl, emergencyTl, maxTvl
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), init);
        return address(proxy);
    }
}
