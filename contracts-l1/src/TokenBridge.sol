// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

import {IInbox} from "./interfaces/IInbox.sol";
import {IOutbox} from "./interfaces/IOutbox.sol";
import {DataStructures} from "./lib/DataStructures.sol";
import {Epoch} from "./lib/TimeMath.sol";

/// @title  TokenBridge — Aztec L1↔L2 portal for canonical ERC20s.
/// @notice One instance per (L1 ERC20, L2 Token) pair. Owner is a
///         TimelockController whose admin is a 3-of-5 multisig (mainnet)
///         or a 1-of-1 deployer (testnet, delay=0).
///
/// @dev    OZ v5 (non-upgradeable package) is installed in this repo — it ships
///         Ownable and Pausable with constructor-based state, incompatible with
///         proxy storage. Ownership and pause logic are therefore implemented
///         inline using the Initializable idiom so all state lives in proxy
///         storage. The external API (`owner`, `paused`, `transferOwnership`,
///         `renounceOwnership`, `onlyOwner`, `whenNotPaused`) is identical to
///         the OZ equivalents.
contract TokenBridge is Initializable, UUPSUpgradeable {
    using SafeERC20 for IERC20;

    // ── Storage ───────────────────────────────────────────────────────────────

    IERC20 public l1Token;
    bytes32 public l2TokenAddress;
    uint256 public l2Version;
    IInbox public inbox;
    IOutbox public outbox;
    uint256 public maxTvl;

    // Inline Ownable state (proxy-storage-safe)
    address private _owner;

    // Inline Pausable state (proxy-storage-safe)
    bool private _paused;

    // ── Events ────────────────────────────────────────────────────────────────

    event DepositInitiated(
        address indexed sender,
        bytes32 indexed l2Recipient,
        uint256 amount,
        bytes32 secretHash,
        uint256 messageIndex,
        bool isPrivate
    );
    event WithdrawCompleted(address indexed recipient, uint256 amount, uint256 l2Epoch, uint256 leafIndex);
    event MaxTvlUpdated(uint256 oldCap, uint256 newCap);
    event L2TokenAddressUpdated(bytes32 oldAddr, bytes32 newAddr);

    // OZ-compatible ownership / pause events
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event Paused(address account);
    event Unpaused(address account);

    // ── Errors ────────────────────────────────────────────────────────────────

    error TvlCapExceeded(uint256 attempted, uint256 cap);
    error ZeroAmount();
    error ZeroAddress();
    error CannotSweepL1Token();
    error OwnableUnauthorizedAccount(address account);
    error OwnableInvalidOwner(address owner);
    error EnforcedPause();
    error ExpectedPause();

    // ── Modifiers ─────────────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != _owner) revert OwnableUnauthorizedAccount(msg.sender);
        _;
    }

    modifier whenNotPaused() {
        if (_paused) revert EnforcedPause();
        _;
    }

    modifier whenPaused() {
        if (!_paused) revert ExpectedPause();
        _;
    }

    // ── Constructor ───────────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // ── Initializer ───────────────────────────────────────────────────────────

    function initialize(
        IERC20 _l1Token,
        bytes32 _l2TokenAddress,
        uint256 _l2Version,
        IInbox _inbox,
        IOutbox _outbox,
        address owner_,
        uint256 _maxTvl
    ) external initializer {
        if (address(_l1Token) == address(0)) revert ZeroAddress();
        if (address(_inbox) == address(0)) revert ZeroAddress();
        if (address(_outbox) == address(0)) revert ZeroAddress();
        if (owner_ == address(0)) revert OwnableInvalidOwner(address(0));

        // Set ownership
        _owner = owner_;
        emit OwnershipTransferred(address(0), owner_);

        // _paused defaults to false — no-op needed

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
        DataStructures.L2Actor memory recipient =
            DataStructures.L2Actor({actor: l2TokenAddress, version: l2Version});
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
        DataStructures.L2Actor memory recipient =
            DataStructures.L2Actor({actor: l2TokenAddress, version: l2Version});
        (messageHash, messageIndex) = inbox.sendL2Message(recipient, content, secretHash);

        emit DepositInitiated(msg.sender, bytes32(0), amount, secretHash, messageIndex, true);
    }

    // ── Withdraw flow (L2 → L1) ───────────────────────────────────────────────

    /// @notice Consume an L2→L1 message and release `amount` to `recipient`.
    /// @param l2Epoch     Epoch id (uint256) containing the L2→L1 message; wrapped to Epoch internally.
    /// @param leafIndex   Leaf position in the epoch's Outbox tree.
    /// @param siblingPath Merkle proof for the leaf.
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

    // ── Views ─────────────────────────────────────────────────────────────────

    function totalLocked() external view returns (uint256) {
        return l1Token.balanceOf(address(this));
    }

    function owner() public view returns (address) {
        return _owner;
    }

    function paused() public view returns (bool) {
        return _paused;
    }

    // ── Governance (owner = TimelockController) ───────────────────────────────

    function pause() external onlyOwner {
        if (_paused) revert EnforcedPause();
        _paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        if (!_paused) revert ExpectedPause();
        _paused = false;
        emit Unpaused(msg.sender);
    }

    function setMaxTvl(uint256 newCap) external onlyOwner {
        emit MaxTvlUpdated(maxTvl, newCap);
        maxTvl = newCap;
    }

    function setL2TokenAddress(bytes32 newAddr) external onlyOwner {
        if (newAddr == bytes32(0)) revert ZeroAddress();
        emit L2TokenAddressUpdated(l2TokenAddress, newAddr);
        l2TokenAddress = newAddr;
    }

    function withdrawTreasuryDust(IERC20 token, uint256 amount, address to) external onlyOwner {
        if (address(token) == address(l1Token)) revert CannotSweepL1Token();
        if (to == address(0)) revert ZeroAddress();
        token.safeTransfer(to, amount);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert OwnableInvalidOwner(address(0));
        address old = _owner;
        _owner = newOwner;
        emit OwnershipTransferred(old, newOwner);
    }

    function renounceOwnership() external onlyOwner {
        address old = _owner;
        _owner = address(0);
        emit OwnershipTransferred(old, address(0));
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    // ── Internal ──────────────────────────────────────────────────────────────

    function _enforceTvlCap(uint256 amount) internal view {
        if (maxTvl == 0) return;
        uint256 newTotal = l1Token.balanceOf(address(this)) + amount;
        if (newTotal > maxTvl) revert TvlCapExceeded(newTotal, maxTvl);
    }

    function _depositContent(bytes32 l2Recipient, uint256 amount, bytes32 secretHash, bytes32 tag)
        internal
        pure
        returns (bytes32)
    {
        // NOTE: scaffolding hash. Task C1 reconciles to the canonical Aztec L1↔L2
        //       content-hash format (sha256_to_field or poseidon2) and updates both
        //       this function and the matching Noir-side reconstruction.
        return keccak256(abi.encode(l2Recipient, amount, secretHash, tag));
    }

    function _withdrawContent(address recipient, uint256 amount, bytes32 tag) internal pure returns (bytes32) {
        return keccak256(abi.encode(bytes32(uint256(uint160(recipient))), amount, tag));
    }
}
