// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.27;

import {Script, console} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {TokenBridge} from "../src/TokenBridge.sol";
import {IInbox} from "../src/interfaces/IInbox.sol";
import {IOutbox} from "../src/interfaces/IOutbox.sol";

/// @notice Deploys (TimelockController, USDCBridge proxy, WETHBridge proxy)
///         in a single broadcast. l2TokenAddress is set to bytes32(0) — the
///         TS orchestrator (deploy-bridge.ts) deploys the L2 aUSDC/aWETH
///         contracts AFTER and then schedules+executes setL2TokenAddress
///         via the TimelockController.
contract DeployAllBridges is Script {
    function run(
        address l1Usdc,
        address l1Weth,
        address l1Inbox,
        address l1Outbox,
        address l1Multisig,
        uint256 timelockDelaySec,
        uint256 maxTvl
    ) external returns (address timelock, address usdcBridge, address wethBridge) {
        vm.startBroadcast();

        // 1. TimelockController. Proposers = multisig. Executors = anyone (0x0)
        //    so any proposer-signed batch can self-execute after delay.
        address[] memory proposers = new address[](1);
        proposers[0] = l1Multisig;
        address[] memory executors = new address[](1);
        executors[0] = address(0);
        TimelockController tlc = new TimelockController(
            timelockDelaySec, proposers, executors, l1Multisig
        );
        timelock = address(tlc);

        // 2. USDC + WETH portal proxies. l2TokenAddress = bytes32(0) placeholder.
        usdcBridge = _deployBridgeProxy(
            IERC20(l1Usdc), bytes32(0), 1, IInbox(l1Inbox), IOutbox(l1Outbox), timelock, maxTvl
        );
        wethBridge = _deployBridgeProxy(
            IERC20(l1Weth), bytes32(0), 1, IInbox(l1Inbox), IOutbox(l1Outbox), timelock, maxTvl
        );

        vm.stopBroadcast();

        console.log("TimelockController:", timelock);
        console.log("USDCBridge:        ", usdcBridge);
        console.log("WETHBridge:        ", wethBridge);
    }

    function _deployBridgeProxy(
        IERC20 token,
        bytes32 l2Token,
        uint256 l2Version,
        IInbox inbox,
        IOutbox outbox,
        address owner,
        uint256 maxTvl
    ) internal returns (address) {
        TokenBridge impl = new TokenBridge();
        bytes memory init = abi.encodeWithSelector(
            TokenBridge.initialize.selector,
            token, l2Token, l2Version, inbox, outbox, owner, maxTvl
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), init);
        return address(proxy);
    }
}
