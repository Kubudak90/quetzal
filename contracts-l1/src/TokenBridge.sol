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
    ///      exactly. Not safe with fee-on-transfer / deflationary tokens. Quetzal
    ///      launches with USDC + WETH which are standard ERC20s. Adding any
    ///      non-standard token requires reviewing this assumption.
    uint256 public maxTvl;

    /// @notice Tracks a deposit for potential 90-day-windowed recovery.
    struct Deposit {
        uint128 amount;
        uint64  timestamp;
        bool    isPrivate;
    }

    /// @notice Per-deposit record keyed by keccak256(sender, secretHash). Lookup
    ///         enables the 3-phase recoverDeposit flow: a maker who lost their L2
    ///         wallet can request → governance approves → maker executes the
    ///         on-L1 refund. Only the original depositor (msg.sender match) can
    ///         recover, so secret-knowledge alone is insufficient.
    mapping(bytes32 => Deposit) public deposits;

    /// @notice Maker-flagged deposits awaiting governance review.
    mapping(bytes32 => bool) public pendingRecoveries;

    /// @notice Governance-approved deposits awaiting maker execution.
    mapping(bytes32 => bool) public approvedRecoveries;

    /// @notice Role allowed to invoke governance functions (setMaxTvl,
    ///         setL2TokenAddress, withdrawTreasuryDust, _authorizeUpgrade).
    ///         In production this is the 7-day governance TimelockController.
    bytes32 public constant GOVERNANCE_ROLE       = keccak256("GOVERNANCE_ROLE");

    /// @notice Role allowed to invoke pause/unpause. In production this is the
    ///         delay-0 emergency TimelockController fronted by a separate
    ///         emergency multisig (2-of-3) so security incidents bypass the
    ///         7-day governance window.
    ///         The role is its OWN admin (set in initialize via _setRoleAdmin):
    ///         governance cannot revoke it. Only existing emergency-role holders
    ///         may rotate emergency-role membership.
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
    event DepositTracked(address indexed sender, bytes32 indexed secretHash, uint128 amount, bool isPrivate);
    event RecoveryRequested(address indexed sender, bytes32 indexed secretHash, uint128 amount);
    event RecoveryApproved(bytes32 indexed key);
    event RecoveryExecuted(address indexed sender, bytes32 indexed secretHash, address indexed l1Recipient, uint128 amount);

    /// @notice Deposit would push the bridge's token balance above `maxTvl`.
    error TvlCapExceeded(uint256 attempted, uint256 cap);
    /// @notice Caller passed a zero token amount where a non-zero value is required.
    error ZeroAmount();
    /// @notice Caller passed a zero address/bytes32 where a non-zero value is required.
    error ZeroAddress();
    /// @notice The bridge's primary `l1Token` cannot be swept via `withdrawTreasuryDust`.
    error CannotSweepL1Token();
    /// @notice No deposit record found for (msg.sender, secretHash).
    error NoSuchDeposit();
    /// @notice 90-day waiting period has not elapsed since the deposit.
    error DepositTooRecent();
    /// @notice No pending recovery request found for the given key.
    error NoSuchRequest();
    /// @notice Recovery has not been approved by governance.
    error NotApproved();

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
        // I-2 trust-model hardening: EMERGENCY_PAUSER_ROLE is self-admin so the
        // governance timelock cannot silently revoke the emergency multisig's
        // pause authority. Only existing emergency-role holders can grant or
        // revoke the role on others.
        _setRoleAdmin(EMERGENCY_PAUSER_ROLE, EMERGENCY_PAUSER_ROLE);

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

        // Track the deposit so the depositor may recover it via requestRecovery
        // + governance approveRecovery + executeRecovery after 90 days if their
        // L2 wallet becomes inaccessible. Key by (sender, secretHash) so only
        // the original depositor can recover.
        bytes32 trackKey = keccak256(abi.encode(msg.sender, secretHash));
        deposits[trackKey] = Deposit({
            amount: uint128(amount),
            timestamp: uint64(block.timestamp),
            isPrivate: false
        });
        emit DepositTracked(msg.sender, secretHash, uint128(amount), false);
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

        bytes32 trackKey = keccak256(abi.encode(msg.sender, secretHash));
        deposits[trackKey] = Deposit({
            amount: uint128(amount),
            timestamp: uint64(block.timestamp),
            isPrivate: true
        });
        emit DepositTracked(msg.sender, secretHash, uint128(amount), true);
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

    /// @notice Sub-5c B3: L2→L1 message consumer for WITHDRAW_PRIVATE_TAG content
    ///         emitted by the L2 Token's exit_to_l1_private path. Identical to
    ///         withdraw() except the content-hash domain tag is the PRIVATE
    ///         variant, so the L2-emitted message can only be consumed via
    ///         this entry point (no cross-mode confusion).
    function withdrawPrivate(
        uint256 amount,
        address recipient,
        uint256 l2Epoch,
        uint256 leafIndex,
        bytes32[] calldata siblingPath
    ) external whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroAddress();

        bytes32 content = _withdrawContent(recipient, amount, DataStructures.WITHDRAW_PRIVATE_TAG);
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

    // ── Recovery flow (Sub-5c) ────────────────────────────────────────────────

    /// @notice Sub-5c B2/B3: maker requests recovery of a deposit whose L2 claim
    ///         path has been unreachable for 90+ days (lost L2 wallet, no PXE
    ///         access, etc.). This creates an on-chain recovery request; phase 2
    ///         (approveRecovery) requires governance multisig manual verification
    ///         that the L2 message remains unconsumed; phase 3 (executeRecovery)
    ///         releases funds back to the original depositor.
    ///
    ///         Only the original depositor (msg.sender match at deposit time) can
    ///         call. The 90-day waiting period is enforced; the L2-consumption
    ///         check happens off-chain at governance approval time.
    function requestRecovery(bytes32 secretHash) external {
        bytes32 key = keccak256(abi.encode(msg.sender, secretHash));
        Deposit memory d = deposits[key];
        if (d.amount == 0) revert NoSuchDeposit();
        if (block.timestamp < uint256(d.timestamp) + 90 days) revert DepositTooRecent();
        pendingRecoveries[key] = true;
        emit RecoveryRequested(msg.sender, secretHash, d.amount);
    }

    /// @notice Sub-5c B2/B3: phase 2 — governance multisig approves a pending
    ///         recovery after manually verifying the L2 message is still
    ///         unconsumed. The off-chain check is the trust-minimization
    ///         boundary (L1 cannot read L2 nullifier state directly).
    function approveRecovery(bytes32 key) external onlyRole(GOVERNANCE_ROLE) {
        if (!pendingRecoveries[key]) revert NoSuchRequest();
        approvedRecoveries[key] = true;
        emit RecoveryApproved(key);
    }

    /// @notice Sub-5c B2/B3: phase 3 — original depositor executes the approved
    ///         recovery. msg.sender match against the deposit's (sender,
    ///         secretHash) key is the access control: an attacker who knows the
    ///         secret but is not the original depositor cannot recover. State is
    ///         fully cleared on success to prevent re-recovery.
    function executeRecovery(bytes32 secretHash, address l1Recipient) external {
        if (l1Recipient == address(0)) revert ZeroAddress();
        bytes32 key = keccak256(abi.encode(msg.sender, secretHash));
        if (!approvedRecoveries[key]) revert NotApproved();
        uint128 amount = deposits[key].amount;
        delete deposits[key];
        delete pendingRecoveries[key];
        delete approvedRecoveries[key];
        l1Token.safeTransfer(l1Recipient, amount);
        emit RecoveryExecuted(msg.sender, secretHash, l1Recipient, amount);
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

    /// @dev UUPS upgrade gate. Callable only via the 7-day governance
    ///      TimelockController; cannot be bypassed even by the emergency
    ///      multisig (which holds EMERGENCY_PAUSER_ROLE only, not GOVERNANCE_ROLE).
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

    // Generic content-hash helper used by both withdraw() (PUBLIC tag) and
    // withdrawPrivate() (PRIVATE tag). The tag parameter is the only
    // distinguishing factor between the two L2→L1 paths.
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
