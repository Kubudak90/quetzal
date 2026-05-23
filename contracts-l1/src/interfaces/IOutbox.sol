// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.27;

/// @notice Aztec L2→L1 outbox interface. Portal calls consume() during a withdraw.
interface IOutbox {
    function consume(
        uint256 l2BlockNumber,
        uint256 leafIndex,
        bytes32 content,
        bytes32[] calldata siblingPath
    ) external returns (bool);

    function hasMessageBeenConsumed(uint256 l2BlockNumber, uint256 leafIndex) external view returns (bool);
}
