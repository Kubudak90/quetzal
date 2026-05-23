// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.27;

/// @notice Aztec L1→L2 inbox interface. Real implementation lives in the Aztec
///         rollup contracts on L1; we depend only on the function shapes that
///         our portal calls.
interface IInbox {
    struct L2Actor {
        bytes32 actor;
        uint256 version;
    }

    struct L1Actor {
        address actor;
        uint256 chainId;
    }

    function sendL2Message(L2Actor calldata recipient, bytes32 content, bytes32 secretHash)
        external
        payable
        returns (bytes32 messageHash, uint256 messageIndex);
}
