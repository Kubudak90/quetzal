// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

import {IInbox} from "./interfaces/IInbox.sol";
import {IOutbox} from "./interfaces/IOutbox.sol";
import {DataStructures} from "./lib/DataStructures.sol";
import {Epoch} from "./lib/TimeMath.sol";

/// @title  TokenBridge — Aztec L1↔L2 portal for canonical ERC20s.
/// @notice One instance per (L1 ERC20, L2 Token) pair. Governance is split
///         across two roles: GOVERNANCE_ROLE (7-day governance TimelockController
///         in production) and EMERGENCY_PAUSER_ROLE (0-day emergency
///         TimelockController fronted by a 2-of-3 emergency multisig).
contract TokenBridge is Initializable, UUPSUpgradeable, AccessControlUpgradeable, PausableUpgradeable {
    using SafeERC20 for IERC20;

    IERC20 public l1Token;
    bytes32 public l2TokenAddress;

    /// @dev Set once at `initialize`; intentionally has no governance setter.
    ///      If Aztec changes the rollup version deploy a new TokenBridge instance
    ///      rather than mutating this value.
    uint256 public l2Version;

    /// @dev Set once at `initialize`; intentionally has no governance setter.
    ///      If Aztec relocates the Inbox, deploy a new TokenBridge instance
    ///      rather than mutating this value.
    IInbox public inbox;

    /// @dev Set once at `initialize`; intentionally has no governance setter.
    ///      If Aztec relocates the Outbox, deploy a new TokenBridge instance
    ///      rather than mutating this value.
    IOutbox public outbox;

    /// @dev Maximum total ERC20 tokens (by `l1Token.balanceOf(address(this))`) that
    ///      may be held by this bridge at any one time. A value of 0 means UNLIMITED
    ///      (no cap enforcement). To block all deposits use `pause()` instead; do NOT
    ///      use `setMaxTvl(0)` expecting it to block deposits — it will not.
    ///
    ///      IMPORTANT: `_enforceTvlCap` reads `l1Token.balanceOf(address(this))` and
    ///      projects the post-deposit total assuming the token transfers `amount`
    ///      exactly. Not safe with fee-on-transfer / deflationary tokens. ZSwap
    ///      launches with USDC + WETH which are standard ERC20s. Adding any
    ///      non-standard token requires reviewing this assumption.
    uint256 public maxTvl;

    /// @notice Role allowed to invoke governance functions (setMaxTvl,
    ///         setL2TokenAddress, withdrawTreasuryDust, _authorizeUpgrade).
    ///         In production this is the 7-day governance TimelockController.
    bytes32 public constant GOVERNANCE_ROLE       = keccak256("GOVERNANCE_ROLE");

    /// @notice Role allowed to invoke pause/unpause. In production this is the
    ///         delay-0 emergency TimelockController fronted by a separate
    ///         emergency multisig (2-of-3) so security incidents bypass the
    ///         7-day governance window.
    bytes32 public constant EMERGENCY_PAUSER_ROLE = keccak256("EMERGENCY_PAUSER_ROLE");

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

    /// @notice Deposit would push the bridge's token balance above `maxTvl`.
    error TvlCapExceeded(uint256 attempted, uint256 cap);
    /// @notice Caller passed a zero token amount where a non-zero value is required.
    error ZeroAmount();
    /// @notice Caller passed a zero address/bytes32 where a non-zero value is required.
    error ZeroAddress();
    /// @notice The bridge's primary `l1Token` cannot be swept via `withdrawTreasuryDust`.
    error CannotSweepL1Token();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice One-shot initializer. Two timelocks are required: a governance
    ///         timelock (typically 7-day delay) for setMaxTvl/setL2TokenAddress/
    ///         withdrawTreasuryDust/upgrades, and an emergency timelock (typically
    ///         0-day delay) for pause/unpause.
    /// @param _l1Token             The L1 ERC20 token this bridge accepts.
    /// @param _l2TokenAddress      Aztec L2 token contract address (as bytes32 Aztec AztecAddress).
    /// @param _l2Version           Aztec rollup version; used when addressing L2 actors.
    /// @param _inbox               Aztec Inbox contract for L1→L2 messages.
    /// @param _outbox              Aztec Outbox contract for L2→L1 messages.
    /// @param _governanceTimelock  Governance timelock (GOVERNANCE_ROLE + DEFAULT_ADMIN_ROLE).
    /// @param _emergencyTimelock   Emergency timelock (EMERGENCY_PAUSER_ROLE).
    /// @param _maxTvl              Initial TVL cap; 0 = unlimited. See `maxTvl` for full semantics.
    function initialize(
        IERC20 _l1Token,
        bytes32 _l2TokenAddress,
        uint256 _l2Version,
        IInbox _inbox,
        IOutbox _outbox,
        address _governanceTimelock,
        address _emergencyTimelock,
        uint256 _maxTvl
    ) external initializer {
        if (address(_l1Token) == address(0)) revert ZeroAddress();
        if (address(_inbox) == address(0)) revert ZeroAddress();
        if (address(_outbox) == address(0)) revert ZeroAddress();
        if (_governanceTimelock == address(0)) revert ZeroAddress();
        if (_emergencyTimelock == address(0)) revert ZeroAddress();

        __AccessControl_init();
        __Pausable_init();
        __UUPSUpgradeable_init();

        _grantRole(DEFAULT_ADMIN_ROLE,    _governanceTimelock);
        _grantRole(GOVERNANCE_ROLE,        _governanceTimelock);
        _grantRole(EMERGENCY_PAUSER_ROLE,  _emergencyTimelock);

        l1Token = _l1Token;
        l2TokenAddress = _l2TokenAddress;
        l2Version = _l2Version;
        inbox = _inbox;
        outbox = _outbox;
        maxTvl = _maxTvl;
    }

    // ── Deposit flow (L1 → L2) ────────────────────────────────────────────────

    /// @notice Deposit `amount` tokens to a public L2 recipient. The L2 recipient's
    ///         address is visible on-chain. Funds are escrowed on L1 until the L2
    ///         contract mints the corresponding L2 tokens.
    /// @param amount      Token amount to deposit; must be > 0.
    /// @param l2Recipient Aztec L2 recipient address (as bytes32); must be non-zero.
    /// @param secretHash  Secret hash for the L1→L2 message; used by the L2 side to
    ///                    claim the message privately.
    /// @return messageHash  Hash of the L1→L2 message published to the Inbox.
    /// @return messageIndex Index of the message within the Inbox tree.
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

    /// @notice Deposit `amount` tokens to a hidden (private) L2 recipient. The recipient
    ///         is determined on L2 by whoever knows the preimage of `secretHash`. No
    ///         l2Recipient argument is passed; privacy is achieved via the secret.
    /// @param amount     Token amount to deposit; must be > 0.
    /// @param secretHash Secret hash for the L1→L2 message; the holder of the preimage
    ///                   claims the private L2 tokens.
    /// @return messageHash  Hash of the L1→L2 message published to the Inbox.
    /// @return messageIndex Index of the message within the Inbox tree.
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

    /// @notice Consume a finalised L2→L1 exit message from the Outbox and transfer
    ///         `amount` tokens to `recipient`. The caller must supply a valid Merkle
    ///         proof (siblingPath + leafIndex) against the Outbox root for `l2Epoch`.
    /// @param amount       Token amount to withdraw; must be > 0.
    /// @param recipient    L1 address to receive the tokens; must be non-zero.
    /// @param l2Epoch      L2 epoch in which the exit message was included.
    /// @param leafIndex    Leaf position of the exit message in the Outbox Merkle tree.
    /// @param siblingPath  Merkle sibling hashes for proof verification.
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

    /// @return The current L1 token balance held in escrow by this bridge contract.
    function totalLocked() external view returns (uint256) {
        return l1Token.balanceOf(address(this));
    }

    // ── Governance ────────────────────────────────────────────────────────────

    /// @notice Pause all deposit and withdraw operations. Use this to block deposits
    ///         rather than `setMaxTvl(0)` — see `maxTvl` for why.
    function pause() external onlyRole(EMERGENCY_PAUSER_ROLE) { _pause(); }

    /// @notice Resume deposit and withdraw operations after a pause.
    function unpause() external onlyRole(EMERGENCY_PAUSER_ROLE) { _unpause(); }

    /// @notice Update the TVL cap. A value of 0 means UNLIMITED (no cap enforcement).
    ///         To block all new deposits use `pause()` instead; setting this to 0 does
    ///         NOT block deposits.
    function setMaxTvl(uint256 newCap) external onlyRole(GOVERNANCE_ROLE) {
        emit MaxTvlUpdated(maxTvl, newCap);
        maxTvl = newCap;
    }

    /// @notice Update the L2 token address. Allows governance to point the bridge to
    ///         a new L2 token deployment (e.g. after a token migration).
    /// @param newAddr New Aztec L2 token address (as bytes32); must be non-zero.
    function setL2TokenAddress(bytes32 newAddr) external onlyRole(GOVERNANCE_ROLE) {
        if (newAddr == bytes32(0)) revert ZeroAddress();
        emit L2TokenAddressUpdated(l2TokenAddress, newAddr);
        l2TokenAddress = newAddr;
    }

    /// @notice Rescue accidentally sent ERC20 tokens (other than the bridged `l1Token`).
    ///         Cannot be used to drain the bridge's escrowed `l1Token` balance.
    function withdrawTreasuryDust(IERC20 token, uint256 amount, address to) external onlyRole(GOVERNANCE_ROLE) {
        if (address(token) == address(l1Token)) revert CannotSweepL1Token();
        if (to == address(0)) revert ZeroAddress();
        token.safeTransfer(to, amount);
    }

    function _authorizeUpgrade(address) internal override onlyRole(GOVERNANCE_ROLE) {}

    // ── Internal ──────────────────────────────────────────────────────────────

    function _enforceTvlCap(uint256 amount) internal view {
        if (maxTvl == 0) return;
        uint256 newTotal = l1Token.balanceOf(address(this)) + amount;
        if (newTotal > maxTvl) revert TvlCapExceeded(newTotal, maxTvl);
    }

    // L1↔L2 content hash uses sha256 truncated to 31 bytes + a zero
    // prefix byte (matching the Aztec L1↔L2 protocol convention from
    // Hash.sha256ToField). The L2 Noir side reconstructs the same hash
    // via aztec::protocol::hash::sha256_to_field over the same field serialization.
    function _depositContent(bytes32 l2Recipient, uint256 amount, bytes32 secretHash, bytes32 tag)
        internal pure returns (bytes32)
    {
        return _sha256ToField(abi.encode(l2Recipient, amount, secretHash, tag));
    }

    // NOTE: only WITHDRAW_PUBLIC_TAG is consumed here. exit_to_l1_private on L2
    //       emits WITHDRAW_PRIVATE_TAG, but the resulting Outbox content hash
    //       is bound to whichever tag the L2 side used. This portal accepts the
    //       public-tagged path; supporting private-tagged exits would require
    //       a parallel _withdrawContentPrivate + an opt-in withdraw variant.
    //       Sub-5c follow-up if needed.
    function _withdrawContent(address recipient, uint256 amount, bytes32 tag)
        internal pure returns (bytes32)
    {
        return _sha256ToField(abi.encode(bytes32(uint256(uint160(recipient))), amount, tag));
    }

    /// @notice sha256 truncated to 31 bytes + zero-prefixed to 32, matching
    ///         Aztec's L1↔L2 content-hash convention (Hash.sha256ToField).
    function _sha256ToField(bytes memory data) internal pure returns (bytes32) {
        return bytes32(bytes.concat(new bytes(1), bytes31(sha256(data))));
    }
}
