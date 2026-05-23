// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.27;

import {DataStructures} from "../lib/DataStructures.sol";
import {Epoch} from "../lib/TimeMath.sol";

/**
 * @title  IOutbox — Aztec L2→L1 message outbox interface.
 * @notice Mirrors @aztec/l1-artifacts@4.2.1 IOutbox surface.
 */
interface IOutbox {
    event RootAdded(Epoch indexed epoch, bytes32 indexed root);
    event MessageConsumed(Epoch indexed epoch, bytes32 indexed root, bytes32 indexed messageHash, uint256 leafId);

    function insert(Epoch _epoch, bytes32 _root) external;

    function consume(
        DataStructures.L2ToL1Msg calldata _message,
        Epoch _epoch,
        uint256 _leafIndex,
        bytes32[] calldata _path
    ) external;

    function hasMessageBeenConsumedAtEpoch(Epoch _epoch, uint256 _leafId) external view returns (bool);

    function getRootData(Epoch _epoch) external view returns (bytes32);
}
