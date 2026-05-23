// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.27;

/**
 * @title Data Structures Library
 * @notice Mirrors @aztec/l1-artifacts@4.2.1 DataStructures + adds ZSwap-Sub-5b
 *         domain-separator tag constants for the four bridge flow content hashes.
 */
library DataStructures {
    struct L1Actor {
        address actor;
        uint256 chainId;
    }

    struct L2Actor {
        bytes32 actor;
        uint256 version;
    }

    struct L1ToL2Msg {
        L1Actor sender;
        L2Actor recipient;
        bytes32 content;
        bytes32 secretHash;
        uint256 index;
    }

    struct L2ToL1Msg {
        L2Actor sender;
        L1Actor recipient;
        bytes32 content;
    }

    /// @notice ZSwap-Sub-5b domain-separation tags. Placeholder hex literals;
    ///         Task C1 replaces them with real poseidon2 hash values computed
    ///         at Task B1 in contracts/token/src/main.nr.
    bytes32 internal constant DEPOSIT_PUBLIC_TAG   = bytes32(uint256(0xdeadbeef01));
    bytes32 internal constant DEPOSIT_PRIVATE_TAG  = bytes32(uint256(0xdeadbeef02));
    bytes32 internal constant WITHDRAW_PUBLIC_TAG  = bytes32(uint256(0xdeadbeef03));
    bytes32 internal constant WITHDRAW_PRIVATE_TAG = bytes32(uint256(0xdeadbeef04));
}
