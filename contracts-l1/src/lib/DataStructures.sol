// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.27;

library DataStructures {
    /// @notice Domain-separation tags for deposit / withdraw flows. Placeholder
    ///         hex literals here; Task C1 replaces them with real poseidon2
    ///         hash values computed at Task B1 in contracts/token/src/main.nr.
    bytes32 internal constant DEPOSIT_PUBLIC_TAG   = bytes32(uint256(0xdeadbeef01));
    bytes32 internal constant DEPOSIT_PRIVATE_TAG  = bytes32(uint256(0xdeadbeef02));
    bytes32 internal constant WITHDRAW_PUBLIC_TAG  = bytes32(uint256(0xdeadbeef03));
    bytes32 internal constant WITHDRAW_PRIVATE_TAG = bytes32(uint256(0xdeadbeef04));

    struct L2Actor {
        bytes32 actor;
        uint256 version;
    }
}
