// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/**
 * SAFUPool v3 — IBW staking pool with payout controls.
 *
 * ETH-only. 0.015 ETH stake secures 0.25 ETH coverage for 90 days.
 * Oracle-gated enrollment: off-chain fraud scanner signs tier approval;
 * on-chain contract verifies via ECDSA before accepting stake.
 *
 * Payout controls added in v3:
 *   - submitClaim: owner registers a verified loss — auto-activates (deterministic, no vote needed)
 *   - claimStream: pull-payment; claimant calls each day; 100% linear over 45 days
 *   - 2%/day outflow cap on totalStakedSnapshot — no exemptions, pull queued implicitly
 *   - Stake forfeited on submission — permanent regardless of claim outcome
 *   - F1 cancelClaim: onlyOwner; cancels if false positive; principal stays in pool
 *   - F2 approveOverride: 2-of-2; corrects false negatives or user-disputed entitlements
 *
 * IBW constraints (demo-economics — disclose at Istanbul):
 *   50 stakers × 0.015 ETH = 0.75 ETH pool
 *   Max liability: 50 × 0.25 ETH = 12.5 ETH
 *   Frame as demo pool — not production collateralisation.
 *
 * Tier system (IBW rule: no wallet ever rejected — DECLINE floors to C off-chain):
 *   1 = A (score 81–100) → 8000 bps max payout
 *   2 = B (score 61–80)  → 7000 bps max payout
 *   3 = C (score 40–60 or DECLINE) → 5000 bps max payout
 */
contract SAFUPool is Ownable, ReentrancyGuard, Pausable {

    // -----------------------------------------------------------------------
    // Constants
    // -----------------------------------------------------------------------

    uint256 public constant MIN_STAKE       = 0.015 ether;
    uint256 public constant MAX_COVERAGE    = 0.25 ether;
    uint64  public constant LOCK_PERIOD     = 90 days;
    uint256 public constant MAX_STAKERS     = 50;

    uint256 public constant COOLDOWN        = 7 days;
    uint256 public constant VESTING         = 45 days;
    uint256 public constant OUTFLOW_CAP_BPS = 200;   // 2% — no exemptions

    // -----------------------------------------------------------------------
    // State
    // -----------------------------------------------------------------------

    address public oracle;
    address public coSigner;    // second key for 2-of-2 claim approval/override

    uint256 public totalStakers;
    uint256 public totalStaked;
    uint256 public maxPoolSize;
    uint256 public totalEverStaked;

    uint256 public dailyOutflow;    // ETH paid out in current calendar day
    uint256 public lastOutflowDay;  // block.timestamp / 1 days at last cap reset

    bytes32 public poolId;
    string  public communityLabel;

    mapping(address => StakeRecord)              public stakes;
    mapping(bytes32 => bool)                     public revokedApprovals;
    mapping(bytes32 => Claim)                    public claims;
    mapping(bytes32 => OverrideRequest)          public pendingOverrides;

    // -----------------------------------------------------------------------
    // Structs
    // -----------------------------------------------------------------------

    struct StakeRecord {
        address beneficiary;  // receives hack payouts and points — set at stake, changeable before claim
        uint256 amount;
        uint8   tier;         // 1=A  2=B  3=C
        uint64  stakedAt;
        uint64  unlocksAt;
        bool    withdrawn;
        bool    suspended;    // owner can block payout eligibility; does not block principal withdrawal
        bool    claimActive;  // true while a claim is open — blocks withdrawal
        bool    slotReleased; // slot freed on lock expiry without withdrawal — totalStakers already decremented
    }

    struct Claim {
        address  wallet;
        bytes32  txHash;
        uint256  entitlement;         // total approved payout (wei)
        uint256  streamed;            // already paid out (wei)
        uint64   cooldownEnds;        // activation timestamp + 7d
        uint64   vestingEnds;         // cooldownEnds + 45d (day 52 from approval)
        uint256  totalStakedSnapshot; // cap denominator — fixed at activation, not live balance
        uint8    status;              // 0=unused  1=active 2=completed 3=cancelled 4=overridden
    }

    struct OverrideRequest {
        address  wallet;
        bytes32  txHash;
        uint256  entitlement;
        bool     ownerApproved;
        bool     coSignerApproved;
    }

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    event Staked(address indexed wallet, uint256 amount, uint8 tier, uint64 unlocksAt, bytes32 reasonHash);
    event Withdrawn(address indexed wallet, uint256 amount);
    event PointsEarned(address indexed wallet, uint256 amount, uint64 stakedAt);
    event PointsConfirmed(address indexed wallet, uint256 finalPoints, uint256 daysStaked);
    event StakeSuspended(address indexed wallet);
    event StakeUnsuspended(address indexed wallet);
    event ApprovalRevoked(bytes32 indexed approvalHash);
    event OGStaker(address indexed wallet, uint256 timestamp);
    event OracleUpdated(address indexed newOracle);
    event CoSignerUpdated(address indexed newCoSigner);
    event BeneficiaryUpdated(address indexed wallet, address indexed newBeneficiary);
    event SlotReleased(address indexed wallet);
    event MaxPoolSizeUpdated(uint256 newSize);
    event EmergencyWithdrawn(uint256 amount);

    event ClaimSubmitted(bytes32 indexed claimId, address indexed wallet, bytes32 txHash, uint256 entitlement);
    event ClaimActivated(bytes32 indexed claimId, address indexed wallet, uint64 cooldownEnds, uint64 vestingEnds);
    event ClaimStreamed(bytes32 indexed claimId, address indexed wallet, uint256 amount, uint256 totalStreamed);
    event ClaimCompleted(bytes32 indexed claimId, address indexed wallet);
    event ClaimCancelled(bytes32 indexed claimId, address indexed wallet);
    event OverrideApproved(bytes32 indexed claimId, address approver);
    event OverrideExecuted(bytes32 indexed claimId, address indexed wallet, uint256 entitlement);

    // -----------------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------------

    /**
     * @param oracle_      Address of the off-chain fraud scanner signing key.
     * @param maxPoolSize_ Initial pool ETH cap.
     *
     * coSigner defaults to owner (msg.sender). Call setCoSigner() before mainnet
     * to move the second approval key to a separate hardware wallet.
     */
    constructor(address oracle_, uint256 maxPoolSize_) Ownable(msg.sender) {
        require(oracle_ != address(0), "zero oracle");
        oracle      = oracle_;
        maxPoolSize = maxPoolSize_;
        coSigner    = msg.sender;
    }

    // -----------------------------------------------------------------------
    // Core — stakeETH
    // -----------------------------------------------------------------------

    /**
     * @notice Stake ETH with a valid oracle approval.
     *
     * The oracle signs: keccak256(abi.encodePacked(
     *   "SAFU_STAKE_APPROVAL", address(this), block.chainid, wallet, tier, deadline, reasonHash
     * )) then wraps as an Ethereum signed message (EIP-191).
     */
    function stakeETH(
        uint8          tier,
        uint64         deadline,
        bytes32        reasonHash,
        bytes calldata sig,
        address        beneficiary
    ) external payable nonReentrant whenNotPaused {
        require(block.timestamp <= deadline,             "approval expired");
        require(!revokedApprovals[reasonHash],           "approval revoked");
        require(tier >= 1 && tier <= 3,                 "invalid tier");
        require(stakes[msg.sender].amount == 0,         "already staked");
        require(msg.value == MIN_STAKE,                 "wrong stake amount");
        require(totalStakers < MAX_STAKERS,             "pool full");
        require(totalStaked + msg.value <= maxPoolSize, "pool cap exceeded");
        require(beneficiary != address(0),              "zero beneficiary");

        bytes32 inner = keccak256(abi.encodePacked(
            "SAFU_STAKE_APPROVAL",
            address(this),
            block.chainid,
            msg.sender,
            tier,
            deadline,
            reasonHash
        ));
        bytes32 ethHash = MessageHashUtils.toEthSignedMessageHash(inner);
        require(ECDSA.recover(ethHash, sig) == oracle,  "invalid oracle sig");

        uint64 now_    = uint64(block.timestamp);
        uint64 unlocks = now_ + LOCK_PERIOD;

        stakes[msg.sender] = StakeRecord({
            beneficiary:  beneficiary,
            amount:       msg.value,
            tier:         tier,
            stakedAt:     now_,
            unlocksAt:    unlocks,
            withdrawn:    false,
            suspended:    false,
            claimActive:  false,
            slotReleased: false
        });

        totalStakers++;
        totalStaked     += msg.value;
        totalEverStaked++;

        emit Staked(msg.sender, msg.value, tier, unlocks, reasonHash);
        emit PointsEarned(beneficiary, msg.value, now_);
        if (totalEverStaked <= 10) emit OGStaker(msg.sender, block.timestamp);
    }

    // -----------------------------------------------------------------------
    // Core — withdraw
    // -----------------------------------------------------------------------

    /**
     * @notice Withdraw staked principal after the 90-day lock expires.
     * Blocked while a claim is active (claimActive == true).
     * Suspended flag does NOT block withdrawal — principal always recoverable.
     */
    function withdraw() external nonReentrant whenNotPaused {
        StakeRecord storage s = stakes[msg.sender];

        require(s.amount > 0,                   "no stake");
        require(!s.withdrawn,                   "already withdrawn");
        require(!s.claimActive,                 "claim active");
        require(block.timestamp >= s.unlocksAt, "lock period active");

        uint256 daysStaked = (block.timestamp - s.stakedAt) / 1 days;
        uint256 amount     = s.amount;
        s.withdrawn = true;
        s.amount    = 0;
        if (!s.slotReleased) totalStakers--;   // already decremented if releaseExpiredSlot was called
        totalStaked -= amount;

        emit PointsConfirmed(s.beneficiary, daysStaked, daysStaked);
        emit Withdrawn(msg.sender, amount);

        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "ETH transfer failed");
    }

    // -----------------------------------------------------------------------
    // Core — setBeneficiary
    // -----------------------------------------------------------------------

    /**
     * @notice Update the wallet that receives claim payouts and points.
     * Can be changed any time while staked, as long as no claim has been submitted.
     * Locked once withdrawn == true (covers both claim submission and normal withdrawal).
     * Two different staker wallets may share the same beneficiary.
     */
    function setBeneficiary(address newBeneficiary) external {
        require(newBeneficiary != address(0), "zero beneficiary");
        StakeRecord storage s = stakes[msg.sender];
        require(s.amount > 0,  "no stake");
        require(!s.withdrawn,  "stake forfeited");
        s.beneficiary = newBeneficiary;
        emit BeneficiaryUpdated(msg.sender, newBeneficiary);
    }

    // -----------------------------------------------------------------------
    // Core — releaseExpiredSlot
    // -----------------------------------------------------------------------

    /**
     * @notice Free the staker slot once the 90-day lock has expired.
     *
     * Callable by anyone (no auth — the condition is objective: clock > unlocksAt).
     * The staker's ETH remains in the pool; they can still call withdraw() to recover it.
     * Only the MAX_STAKERS slot is freed — totalStaked is NOT decremented here.
     * No coverage is granted after lock expiry regardless.
     */
    function releaseExpiredSlot(address wallet) external {
        StakeRecord storage s = stakes[wallet];
        require(s.amount > 0,                  "no stake");
        require(!s.withdrawn,                  "already withdrawn");
        require(!s.slotReleased,               "slot already released");
        require(block.timestamp >= s.unlocksAt,"lock still active");
        s.slotReleased = true;
        totalStakers--;
        emit SlotReleased(wallet);
    }

    // -----------------------------------------------------------------------
    // Payout — submitClaim
    // -----------------------------------------------------------------------

    /**
     * @notice Owner registers a verified loss event for a staker.
     *
     * @param wallet      Staker whose wallet was drained.
     * @param txHash      Drain transaction hash — forms half of claimId.
     * @param entitlement Payout amount (wei), pre-computed by the off-chain gate pipeline.
     *
     * claimId = keccak256(abi.encodePacked(wallet, txHash))
     */
    function submitClaim(
        address wallet,
        bytes32 txHash,
        uint256 entitlement
    ) external onlyOwner {
        require(wallet != address(0),               "zero wallet");
        require(entitlement > 0,                    "zero entitlement");
        require(entitlement <= MAX_COVERAGE,        "exceeds max coverage");
        require(stakes[wallet].amount > 0,                        "wallet not staked");
        require(!stakes[wallet].withdrawn,                        "stake forfeited");
        require(!stakes[wallet].suspended,                        "stake suspended");
        require(block.timestamp < stakes[wallet].unlocksAt,       unicode"lock expired — no coverage");

        bytes32 claimId = keccak256(abi.encodePacked(wallet, txHash));
        require(claims[claimId].entitlement == 0,   "claim exists");

        // Permanent forfeiture on submission — independent of claim outcome.
        // Wallet can never withdraw principal or stake again. Only payout path is claimStream.
        stakes[wallet].withdrawn   = true;
        stakes[wallet].claimActive = true;
        totalStakers--;
        // totalStaked NOT decremented — principal stays in pool as reserve

        claims[claimId] = Claim({
            wallet:              wallet,
            txHash:              txHash,
            entitlement:         entitlement,
            streamed:            0,
            cooldownEnds:        0,
            vestingEnds:         0,
            totalStakedSnapshot: 0,
            status:              0   // placeholder — _activateClaim sets to 1 immediately
        });

        emit ClaimSubmitted(claimId, wallet, txHash, entitlement);
        _activateClaim(claimId);
    }

    function _activateClaim(bytes32 claimId) internal {
        Claim storage c = claims[claimId];

        uint64 now_         = uint64(block.timestamp);
        uint64 cooldownEnds = now_ + uint64(COOLDOWN);
        uint64 vestingEnds  = cooldownEnds + uint64(VESTING);

        c.cooldownEnds        = cooldownEnds;
        c.vestingEnds         = vestingEnds;
        c.totalStakedSnapshot = totalStaked;   // denominator fixed at activation — not live
        c.status              = 1;             // active

        emit ClaimActivated(claimId, c.wallet, cooldownEnds, vestingEnds);
    }

    // -----------------------------------------------------------------------
    // Payout — claimStream (pull-payment)
    // -----------------------------------------------------------------------

    /**
     * @notice Claimant pulls their daily entitlement after the cooldown expires.
     *
     * Streams proportionally: each second after cooldownEnds accrues 1/VESTING of entitlement.
     * Subject to 2%/day outflow cap on max(totalStakedSnapshot, live totalStaked) —
     * pool growth after claim helps; pool shrinkage never hurts.
     * If the daily cap is exhausted, reverts — caller retries next calendar day.
     * Stake is forfeited on completion (principal stays in pool as reserve).
     */
    function claimStream(bytes32 claimId) external nonReentrant {
        Claim storage c = claims[claimId];

        require(c.status == 1,                     "claim not active");
        require(msg.sender == c.wallet,            "not claimant");
        require(block.timestamp >= c.cooldownEnds, "cooldown active");
        require(c.streamed < c.entitlement,        "already completed");

        // Vested so far: linear from cooldownEnds to vestingEnds
        uint256 elapsed     = _min(block.timestamp, uint256(c.vestingEnds)) - uint256(c.cooldownEnds);
        uint256 vestedTotal = (c.entitlement * elapsed) / VESTING;
        uint256 claimable   = vestedTotal - c.streamed;
        require(claimable > 0, "nothing claimable");

        // Daily outflow cap: 2% of totalStakedSnapshot, resets each calendar day
        uint256 today = block.timestamp / 1 days;
        if (today != lastOutflowDay) {
            dailyOutflow   = 0;
            lastOutflowDay = today;
        }
        uint256 capBase   = totalStaked > c.totalStakedSnapshot ? totalStaked : c.totalStakedSnapshot;
        uint256 cap       = (capBase * OUTFLOW_CAP_BPS) / 10_000;
        uint256 remaining = cap > dailyOutflow ? cap - dailyOutflow : 0;
        require(remaining > 0, "daily cap reached");

        uint256 transfer = _min(claimable, remaining);

        // Effects before interaction (CEI)
        c.streamed   += transfer;
        dailyOutflow += transfer;

        emit ClaimStreamed(claimId, c.wallet, transfer, c.streamed);

        address beneficiary_ = stakes[c.wallet].beneficiary;

        if (c.streamed >= c.entitlement) {
            c.status = 2;
            stakes[c.wallet].claimActive = false;
            emit PointsConfirmed(beneficiary_, LOCK_PERIOD / 1 days, LOCK_PERIOD / 1 days);
            emit ClaimCompleted(claimId, c.wallet);
        }

        (bool ok,) = beneficiary_.call{value: transfer}("");
        require(ok, "ETH transfer failed");
    }

    // -----------------------------------------------------------------------
    // Payout — F1 cancelClaim
    // -----------------------------------------------------------------------

    /**
     * @notice F1: owner cancels an active claim before it completes.
     * Any ETH already streamed is not recovered. Remaining entitlement is cancelled.
     * Stake is permanently forfeited (set at submitClaim) — withdrawal is NOT restored.
     */
    function cancelClaim(bytes32 claimId) external onlyOwner {
        Claim storage c = claims[claimId];
        require(c.status == 1, "claim not active");

        c.status = 3; // cancelled
        stakes[c.wallet].claimActive = false;

        emit ClaimCancelled(claimId, c.wallet);
    }

    // -----------------------------------------------------------------------
    // Payout — F2 approveOverride (2-of-2)
    // -----------------------------------------------------------------------

    /**
     * @notice F2: 2-of-2 manual override for false negatives.
     * Owner and coSigner each call with identical params.
     * Second call executes immediately — creates the claim in active state,
     * skipping submitClaim and approveClaim.
     *
     * @param claimId    keccak256(abi.encodePacked(wallet, txHash)) — caller computes off-chain
     * @param wallet     Wallet to receive the override payout
     * @param txHash     Transaction hash of the drain event
     * @param entitlement Override payout amount (wei)
     */
    function approveOverride(
        bytes32 claimId,
        address wallet,
        bytes32 txHash,
        uint256 entitlement
    ) external {
        require(msg.sender == owner() || msg.sender == coSigner, "not authorized");
        require(wallet != address(0),           "zero wallet");
        require(entitlement > 0,                "zero entitlement");
        require(entitlement <= MAX_COVERAGE,    "exceeds max coverage");
        require(stakes[wallet].amount > 0,                  "wallet not staked");
        require(!stakes[wallet].withdrawn,                  "stake withdrawn");
        require(!stakes[wallet].suspended,                  "stake suspended");
        require(block.timestamp < stakes[wallet].unlocksAt, unicode"lock expired — no coverage");

        OverrideRequest storage req = pendingOverrides[claimId];

        // Consistency check: second caller must match first caller's params
        if (req.wallet != address(0)) {
            require(req.wallet == wallet,           "wallet mismatch");
            require(req.txHash == txHash,           "txHash mismatch");
            require(req.entitlement == entitlement, "entitlement mismatch");
        } else {
            req.wallet      = wallet;
            req.txHash      = txHash;
            req.entitlement = entitlement;
        }

        if (msg.sender == owner()) {
            req.ownerApproved = true;
        } else {
            req.coSignerApproved = true;
        }

        emit OverrideApproved(claimId, msg.sender);

        bool bothApproved = (coSigner == owner())
            ? req.ownerApproved
            : (req.ownerApproved && req.coSignerApproved);

        if (bothApproved) {
            _executeOverride(claimId);
        }
    }

    function _executeOverride(bytes32 claimId) internal {
        OverrideRequest storage req = pendingOverrides[claimId];

        // Cache before delete (storage ref becomes invalid after delete)
        address wallet_      = req.wallet;
        bytes32 txHash_      = req.txHash;
        uint256 entitlement_ = req.entitlement;

        delete pendingOverrides[claimId];

        // If a claim already exists in any state, cancel/overwrite it
        Claim storage existing = claims[claimId];
        if (existing.status == 1) {
            stakes[existing.wallet].claimActive = false;
        }

        uint64 now_         = uint64(block.timestamp);
        uint64 cooldownEnds = now_ + uint64(COOLDOWN);
        uint64 vestingEnds  = cooldownEnds + uint64(VESTING);

        claims[claimId] = Claim({
            wallet:              wallet_,
            txHash:              txHash_,
            entitlement:         entitlement_,
            streamed:            0,
            cooldownEnds:        cooldownEnds,
            vestingEnds:         vestingEnds,
            totalStakedSnapshot: totalStaked,
            status:              1   // active — both sigs already verified
        });

        // False-negative override: forfeit stake permanently, same as submitClaim path
        stakes[wallet_].withdrawn   = true;
        stakes[wallet_].claimActive = true;
        if (!stakes[wallet_].slotReleased) totalStakers--;   // avoid double-decrement if slot already released

        emit OverrideExecuted(claimId, wallet_, entitlement_);
    }

    // -----------------------------------------------------------------------
    // Owner — suspension scaffold
    // -----------------------------------------------------------------------

    function suspendStake(address wallet) external onlyOwner {
        require(stakes[wallet].amount > 0, "no stake");
        require(!stakes[wallet].withdrawn, "already withdrawn");
        stakes[wallet].suspended = true;
        emit StakeSuspended(wallet);
    }

    function unsuspendStake(address wallet) external onlyOwner {
        require(stakes[wallet].amount > 0, "no stake");
        stakes[wallet].suspended = false;
        emit StakeUnsuspended(wallet);
    }

    function revokeApproval(bytes32 approvalHash) external onlyOwner {
        revokedApprovals[approvalHash] = true;
        emit ApprovalRevoked(approvalHash);
    }

    // -----------------------------------------------------------------------
    // Owner — config
    // -----------------------------------------------------------------------

    function setOracle(address newOracle) external onlyOwner {
        require(newOracle != address(0), "zero oracle");
        oracle = newOracle;
        emit OracleUpdated(newOracle);
    }

    function setCoSigner(address newCoSigner) external onlyOwner {
        require(newCoSigner != address(0), "zero cosigner");
        require(newCoSigner != owner(), "cosigner must differ from owner");
        coSigner = newCoSigner;
        emit CoSignerUpdated(newCoSigner);
    }

    function setMaxPoolSize(uint256 newSize) external onlyOwner {
        require(newSize >= totalStaked, "below current staked");
        maxPoolSize = newSize;
        emit MaxPoolSizeUpdated(newSize);
    }

    // -----------------------------------------------------------------------
    // Owner — Pausable
    // -----------------------------------------------------------------------

    function pause()   external onlyOwner { _pause();   }
    function unpause() external onlyOwner { _unpause(); }

    function emergencyWithdraw() external onlyOwner whenPaused {
        uint256 balance = address(this).balance;
        require(balance > 0, "nothing to withdraw");
        emit EmergencyWithdrawn(balance);
        (bool ok,) = owner().call{value: balance}("");
        require(ok, "transfer failed");
    }

    // -----------------------------------------------------------------------
    // View
    // -----------------------------------------------------------------------

    function stakeOf(address wallet) external view returns (StakeRecord memory) {
        return stakes[wallet];
    }

    function isEligible(address wallet) external view returns (bool) {
        StakeRecord storage s = stakes[wallet];
        return s.amount > 0 && !s.withdrawn && !s.suspended && block.timestamp < s.unlocksAt;
    }

    // -----------------------------------------------------------------------
    // Internal
    // -----------------------------------------------------------------------

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}
