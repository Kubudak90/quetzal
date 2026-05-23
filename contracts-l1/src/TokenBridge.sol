// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

import {IInbox} from "./interfaces/IInbox.sol";
import {IOutbox} from "./interfaces/IOutbox.sol";
import {DataStructures} from "./lib/DataStructures.sol";
import {Epoch} from "./lib/TimeMath.sol";

/// @title  TokenBridge — Aztec L1↔L2 portal for canonical ERC20s.
/// @notice One instance per (L1 ERC20, L2 Token) pair. Owner is a
///         TimelockController whose admin is a 3-of-5 multisig (mainnet)
///         or a 1-of-1 deployer (testnet, delay=0).
contract TokenBridge is Initializable, UUPSUpgradeable, OwnableUpgradeable, PausableUpgradeable {
    using SafeERC20 for IERC20;

    IERC20 public l1Token;
    bytes32 public l2TokenAddress;
    uint256 public l2Version;
    IInbox public inbox;
    IOutbox public outbox;
    uint256 public maxTvl;

    event DepositInitiated(
        address indexed sender,
        bytes32 indexed l2Recipient,
        uint256 amount,
        bytes32 secretHash,
        uint256 messageIndex,
        bool isPrivate
    );
    event WithdrawCompleted(
        address indexed recipient,
        uint256 amount,
        uint256 l2Epoch,
        uint256 leafIndex
    );
    event MaxTvlUpdated(uint256 oldCap, uint256 newCap);
    event L2TokenAddressUpdated(bytes32 oldAddr, bytes32 newAddr);

    error TvlCapExceeded(uint256 attempted, uint256 cap);
    error ZeroAmount();
    error ZeroAddress();
    error CannotSweepL1Token();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        IERC20 _l1Token,
        bytes32 _l2TokenAddress,
        uint256 _l2Version,
        IInbox _inbox,
        IOutbox _outbox,
        address _owner,
        uint256 _maxTvl
    ) external initializer {
        if (address(_l1Token) == address(0)) revert ZeroAddress();
        if (address(_inbox) == address(0)) revert ZeroAddress();
        if (address(_outbox) == address(0)) revert ZeroAddress();
        if (_owner == address(0)) revert ZeroAddress();

        __Ownable_init(_owner);
        __Pausable_init();
        __UUPSUpgradeable_init();

        l1Token = _l1Token;
        l2TokenAddress = _l2TokenAddress;
        l2Version = _l2Version;
        inbox = _inbox;
        outbox = _outbox;
        maxTvl = _maxTvl;
    }

    // ── Deposit flow (L1 → L2) ────────────────────────────────────────────────

    function depositToL2Public(uint256 amount, bytes32 l2Recipient, bytes32 secretHash)
        external
        whenNotPaused
        returns (bytes32 messageHash, uint256 messageIndex)
    {
        if (amount == 0) revert ZeroAmount();
        if (l2Recipient == bytes32(0)) revert ZeroAddress();
        _enforceTvlCap(amount);

        l1Token.safeTransferFrom(msg.sender, address(this), amount);

        bytes32 content = _depositContent(l2Recipient, amount, secretHash, DataStructures.DEPOSIT_PUBLIC_TAG);
        DataStructures.L2Actor memory recipient = DataStructures.L2Actor({
            actor: l2TokenAddress,
            version: l2Version
        });
        (messageHash, messageIndex) = inbox.sendL2Message(recipient, content, secretHash);

        emit DepositInitiated(msg.sender, l2Recipient, amount, secretHash, messageIndex, false);
    }

    function depositToL2Private(uint256 amount, bytes32 secretHash)
        external
        whenNotPaused
        returns (bytes32 messageHash, uint256 messageIndex)
    {
        if (amount == 0) revert ZeroAmount();
        _enforceTvlCap(amount);

        l1Token.safeTransferFrom(msg.sender, address(this), amount);

        bytes32 content = _depositContent(bytes32(0), amount, secretHash, DataStructures.DEPOSIT_PRIVATE_TAG);
        DataStructures.L2Actor memory recipient = DataStructures.L2Actor({
            actor: l2TokenAddress,
            version: l2Version
        });
        (messageHash, messageIndex) = inbox.sendL2Message(recipient, content, secretHash);

        emit DepositInitiated(msg.sender, bytes32(0), amount, secretHash, messageIndex, true);
    }

    // ── Withdraw flow (L2 → L1) ───────────────────────────────────────────────

    function withdraw(
        uint256 amount,
        address recipient,
        uint256 l2Epoch,
        uint256 leafIndex,
        bytes32[] calldata siblingPath
    ) external whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroAddress();

        bytes32 content = _withdrawContent(recipient, amount, DataStructures.WITHDRAW_PUBLIC_TAG);

        DataStructures.L2ToL1Msg memory message = DataStructures.L2ToL1Msg({
            sender: DataStructures.L2Actor({actor: l2TokenAddress, version: l2Version}),
            recipient: DataStructures.L1Actor({actor: address(this), chainId: block.chainid}),
            content: content
        });
        outbox.consume(message, Epoch.wrap(l2Epoch), leafIndex, siblingPath);

        l1Token.safeTransfer(recipient, amount);
        emit WithdrawCompleted(recipient, amount, l2Epoch, leafIndex);
    }

    function totalLocked() external view returns (uint256) {
        return l1Token.balanceOf(address(this));
    }

    // ── Governance (owner = TimelockController) ───────────────────────────────

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    function setMaxTvl(uint256 newCap) external onlyOwner {
        emit MaxTvlUpdated(maxTvl, newCap);
        maxTvl = newCap;
    }

    function setL2TokenAddress(bytes32 newAddr) external onlyOwner {
        require(newAddr != bytes32(0), "zero l2 addr");
        emit L2TokenAddressUpdated(l2TokenAddress, newAddr);
        l2TokenAddress = newAddr;
    }

    function withdrawTreasuryDust(IERC20 token, uint256 amount, address to) external onlyOwner {
        if (address(token) == address(l1Token)) revert CannotSweepL1Token();
        if (to == address(0)) revert ZeroAddress();
        token.safeTransfer(to, amount);
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    // ── Internal ──────────────────────────────────────────────────────────────

    function _enforceTvlCap(uint256 amount) internal view {
        if (maxTvl == 0) return;
        uint256 newTotal = l1Token.balanceOf(address(this)) + amount;
        if (newTotal > maxTvl) revert TvlCapExceeded(newTotal, maxTvl);
    }

    function _depositContent(bytes32 l2Recipient, uint256 amount, bytes32 secretHash, bytes32 tag)
        internal pure returns (bytes32)
    {
        // NOTE: scaffolding hash. Task C1 reconciles to the canonical Aztec L1↔L2
        //       content-hash format (sha256_to_field or poseidon2) and updates both
        //       this function and the matching Noir-side reconstruction.
        return keccak256(abi.encode(l2Recipient, amount, secretHash, tag));
    }

    function _withdrawContent(address recipient, uint256 amount, bytes32 tag)
        internal pure returns (bytes32)
    {
        return keccak256(abi.encode(bytes32(uint256(uint160(recipient))), amount, tag));
    }
}
