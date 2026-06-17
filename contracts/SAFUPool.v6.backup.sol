// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.25;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/**
 * SAFUPool v6 — IBW staking pool with payout controls.
 * Compiler: 0.8.25 (locked — no floating pragma, compiler bug resolved).
 *
 * ETH-only. 0.015 ETH stake secures 0.25 ETH coverage for 90 days.
 * Oracle-gated enrollment: off-chain fraud scanner signs tier approval;
 * on-chain contract verifies via ECDSA before accepting stake.
 *
 * Payout controls:
 *   - submitClaim: oracle or owner registers a verified loss — auto-activates
 *   - claimStream: pull-payment; claimant calls each day; 100% linear over 45 days
 *   - 2%/day outflow cap on totalStakedSnapshot — no exemptions
 *   - Stake forfeited on submission — permanent regardless of claim outcome
 *   - F1 cancelClaim: onlyOwner; cancels if false positive; principal permanently forfeited (penalty)
 *   - F2 approveOverride: 2-of-2; corrects false negatives or disputed entitlements
 *
 * v6 security fixes (Hashlock audit 2026-05-27):
 *   H3   — totalStaked decremented on claim completion
 *   H4   — slotReleased set in _executeOverride (prevents double-decrement)
 *   M1   — completed claims blocked from override (no double payout)
 *   M4   — failed ETH transfer stored in failedPayouts; rescueFailedPayout() added
 *   M5   — claimId validated on-chain in approveOverride
 *   M6   — claimStream gated by whenNotPaused
 *   L1   — reasonHash auto-revoked after stake
 *   L3   — releaseExpiredSlot blocked on suspended wallets
 *   L4   — PointsConfirmed emits correct wallet address (not beneficiary)
 *   G2   — poolId and communityLabel removed
 *   C1   — emergencyWithdraw limited to surplus (balance - totalStaked - totalFailedPayouts)
 *   C2   — oracle claim rate limit: max 2% of MAX_STAKERS per 24h (= 1/day at 50 stakers)
 *   I2   — setBeneficiary gated by whenNotPaused
 *   COMP — pragma locked to 0.8.25; LostStorageArrayWriteOnSlotOverflow resolved
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

    uint256 public constant MIN_STAKE        = 0.015 ether;
    uint256 public constant MAX_COVERAGE     = 0.25 ether;
    uint64  public constant LOCK_PERIOD      = 90 days;
    uint256 public constant MAX_STAKERS      = 50;

    uint256 public constant COOLDOWN         = 7 days;
    uint256 public constant VESTING          = 45 days;
    uint256 public constant OUTFLOW_CAP_BPS  = 200;   // 2%/day outflow cap
    uint256 public constant CLAIM_RATE_BPS   = 200;   // C2: 2% of MAX_STAKERS per day via oracle

    // -----------------------------------------------------------------------
    // State
    // -----------------------------------------------------------------------

    address public oracle;
    address public coSigner;

    uint256 public totalStakers;
    uint256 public totalStaked;
    uint256 public maxPoolSize;
    uint256 public totalEverStaked;

    uint256 public dailyOutflow;
    uint256 public lastOutflowDay;

    // C2: oracle daily claim rate limiting
    uint256 public dailyClaimCount;
    uint256 public lastClaimDay;

    mapping(address => StakeRecord)     public stakes;
    mapping(bytes32 => bool)            public revokedApprovals;
    mapping(bytes32 => Claim)           public claims;
    mapping(bytes32 => OverrideRequest) public pendingOverrides;
    mapping(address => uint256)         public failedPayouts;     // M4: rescue bucket for stuck ETH
    uint256 public totalFailedPayouts;                           // M4+: total pending rescue — excluded from emergencyWithdraw surplus
    mapping(address => bool)            public hasEverStaked;     // L6: OGStaker dedup — prevents re-stake from re-emitting event

    // -----------------------------------------------------------------------
    // Structs
    // -----------------------------------------------------------------------

    struct StakeRecord {
        bytes32 beneficiaryHash;  // keccak256(abi.encodePacked(beneficiary)) — plaintext never stored
        uint256 amount;
        uint8   tier;         // 1=A  2=B  3=C
        uint64  stakedAt;
        uint64  unlocksAt;
        bool    withdrawn;
        bool    suspended;    // owner can block payout eligibility; does not block principal withdrawal
        bool    claimActive;  // true while a claim is open — blocks withdrawal
        bool    slotReleased; // slot freed on lock expiry — totalStakers already decremented
    }

    struct Claim {
        address  wallet;
        bytes32  txHash;
        uint256  entitlement;         // total approved payout (wei)
        uint256  streamed;            // already paid out (wei)
        uint64   cooldownEnds;        // activation timestamp + 7d
        uint64   vestingEnds;         // cooldownEnds + 45d (day 52 from approval)
        uint256  totalStakedSnapshot; // cap denominator — fixed at activation, not live balance
        uint8    status;              // 0=unused 1=active 2=completed 3=cancelled 4=overridden
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
    event PointsEarned(bytes32 indexed walletHash, uint256 amount, uint64 stakedAt);
    event PointsConfirmed(address indexed wallet, uint256 finalPoints, uint256 daysStaked);
    event StakeSuspended(address indexed wallet);
    event StakeUnsuspended(address indexed wallet);
    event ApprovalRevoked(bytes32 indexed approvalHash);
    event OGStaker(address indexed wallet, uint256 timestamp);
    event OracleUpdated(address indexed newOracle);
    event CoSignerUpdated(address indexed newCoSigner);
    event BeneficiaryUpdated(address indexed wallet, bytes32 newBeneficiaryHash);
    event SlotReleased(address indexed wallet);
    event MaxPoolSizeUpdated(uint256 newSize);
    event EmergencyWithdrawn(uint256 amount);
    event PayoutFailed(bytes32 indexed claimId, address indexed beneficiary, uint256 amount);  // M4
    event PayoutRescued(address indexed beneficiary, uint256 amount);                          // M4

    event ClaimSubmitted(bytes32 indexed claimId, address indexed wallet, bytes32 txHash, uint256 entitlement);
    event ClaimActivated(bytes32 indexed claimId, address indexed wallet, uint64 cooldownEnds, uint64 vestingEnds);
    event ClaimStreamed(bytes32 indexed claimId, address indexed wallet, uint256 amount, uint256 totalStreamed);
    event ClaimCompleted(bytes32 indexed claimId, address indexed wallet);
    event ClaimCancelled(bytes32 indexed claimId, address indexed wallet);
    event OverrideApproved(bytes32 indexed claimId, address approver);
    event OverrideExecuted(bytes32 indexed claimId, address indexed wallet, uint256 entitlement);
    event OverrideCancelled(bytes32 indexed claimId);  // M4: pending override revoked by owner

    // -----------------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------------

    /**
     * @param oracle_      Address of the off-chain fraud scanner signing key.
     * @param coSigner_    Address of the second approval key (must differ from owner).
     * @param maxPoolSize_ Initial pool ETH cap.
     *
     * M3 fix: coSigner is set at deploy time — no post-deploy setCoSigner call required.
     */
    constructor(address oracle_, address coSigner_, uint256 maxPoolSize_) Ownable(msg.sender) {
        require(oracle_    != address(0),   "zero oracle");
        require(coSigner_  != address(0),   "zero coSigner");
        require(coSigner_  != msg.sender,   "coSigner must differ from owner");
        oracle      = oracle_;
        coSigner    = coSigner_;
        maxPoolSize = maxPoolSize_;
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
     *
     * L1 fix: reasonHash is auto-revoked after use — one approval = one stake only.
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
        require(beneficiary != msg.sender,              "beneficiary cannot be staker");
        require(beneficiary != oracle,                  "beneficiary cannot be oracle");
        require(beneficiary != owner(),                 "beneficiary cannot be owner");
        require(beneficiary != coSigner,                "beneficiary cannot be cosigner");

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
        require(ECDSA.recover(ethHash, sig) == oracle, "invalid oracle sig");

        // L1: auto-revoke — prevents replay if staker withdraws and tries to re-stake
        revokedApprovals[reasonHash] = true;

        uint64 now_    = uint64(block.timestamp);
        uint64 unlocks = now_ + LOCK_PERIOD;

        bytes32 beneficiaryHash = keccak256(abi.encodePacked(beneficiary));

        stakes[msg.sender] = StakeRecord({
            beneficiaryHash: beneficiaryHash,
            amount:          msg.value,
            tier:            tier,
            stakedAt:        now_,
            unlocksAt:       unlocks,
            withdrawn:       false,
            suspended:       false,
            claimActive:     false,
            slotReleased:    false
        });

        totalStakers++;
        totalStaked      += msg.value;
        bool firstStake   = !hasEverStaked[msg.sender];
        if (firstStake) hasEverStaked[msg.sender] = true;
        totalEverStaked++;

        emit Staked(msg.sender, msg.value, tier, unlocks, reasonHash);
        emit PointsEarned(beneficiaryHash, msg.value, now_);
        if (firstStake && totalEverStaked <= 50) emit OGStaker(msg.sender, block.timestamp);
    }

    // -----------------------------------------------------------------------
    // Core — withdraw
    // -----------------------------------------------------------------------

    /**
     * @notice Withdraw staked principal after the 90-day lock expires.
     * Blocked while a claim is active (claimActive == true).
     * Suspended flag does NOT block withdrawal — principal always recoverable.
     */
    function withdraw(address beneficiary) external nonReentrant whenNotPaused {
        StakeRecord storage s = stakes[msg.sender];

        require(s.amount > 0,                   "no stake");
        require(!s.withdrawn,                   "already withdrawn");
        require(!s.claimActive,                 "claim active");
        require(block.timestamp >= s.unlocksAt, "lock period active");
        require(
            keccak256(abi.encodePacked(beneficiary)) == s.beneficiaryHash,
            "wrong beneficiary"
        );

        uint256 daysStaked = (block.timestamp - s.stakedAt) / 1 days;
        uint256 amount     = s.amount;
        s.withdrawn = true;
        s.amount    = 0;
        if (!s.slotReleased) totalStakers--;
        totalStaked -= amount;

        // L4: emit staker wallet (msg.sender), not beneficiary address
        emit PointsConfirmed(msg.sender, daysStaked, daysStaked);
        emit Withdrawn(msg.sender, amount);

        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "ETH transfer failed");
    }

    // -----------------------------------------------------------------------
    // Core — setBeneficiary
    // -----------------------------------------------------------------------

    /**
     * @notice Update the wallet that receives claim payouts and points.
     * Locked once withdrawn == true.
     * I2 fix: gated by whenNotPaused — cannot change beneficiary during emergency pause.
     */
    function setBeneficiary(address newBeneficiary) external whenNotPaused {
        require(newBeneficiary != address(0),   "zero beneficiary");
        require(newBeneficiary != msg.sender,   "beneficiary cannot be staker");
        require(newBeneficiary != oracle,       "beneficiary cannot be oracle");
        require(newBeneficiary != owner(),      "beneficiary cannot be owner");
        require(newBeneficiary != coSigner,     "beneficiary cannot be cosigner");
        StakeRecord storage s = stakes[msg.sender];
        require(s.amount > 0,  "no stake");
        require(!s.withdrawn,  "stake forfeited");
        bytes32 newHash = keccak256(abi.encodePacked(newBeneficiary));
        s.beneficiaryHash = newHash;
        emit BeneficiaryUpdated(msg.sender, newHash);
    }

    // -----------------------------------------------------------------------
    // Core — releaseExpiredSlot
    // -----------------------------------------------------------------------

    /**
     * @notice Free the staker slot once the 90-day lock has expired.
     * Callable by anyone — condition is objective (clock > unlocksAt).
     * L3 fix: blocked on suspended wallets — owner must unsuspend before slot can be freed.
     */
    function releaseExpiredSlot(address wallet) external {
        StakeRecord storage s = stakes[wallet];
        require(s.amount > 0,                  "no stake");
        require(!s.withdrawn,                  "already withdrawn");
        require(!s.slotReleased,               "slot already released");
        require(!s.suspended,                  "wallet suspended");   // L3
        require(block.timestamp >= s.unlocksAt,"lock still active");
        s.slotReleased = true;
        totalStakers--;
        emit SlotReleased(wallet);
    }

    // -----------------------------------------------------------------------
    // Payout — submitClaim
    // -----------------------------------------------------------------------

    /**
     * @notice Oracle or owner registers a verified loss event for a staker.
     *
     * C2 fix: oracle submissions rate-limited to 2% of MAX_STAKERS per 24h (= 1 at 50 stakers).
     *         Owner bypasses the limit — emergency correction path.
     *
     * claimId = keccak256(abi.encodePacked(wallet, txHash))
     */
    function submitClaim(
        address wallet,
        bytes32 txHash,
        uint256 entitlement
    ) external whenNotPaused {
        require(msg.sender == oracle || msg.sender == owner(), "not oracle or owner");
        require(wallet != address(0),               "zero wallet");
        require(entitlement > 0,                    "zero entitlement");
        require(entitlement <= MAX_COVERAGE,        "exceeds max coverage");
        require(entitlement <= _tierCap(stakes[wallet].tier), "exceeds tier cap");
        require(stakes[wallet].amount > 0,          "wallet not staked");
        require(!stakes[wallet].withdrawn,          "stake forfeited");
        require(!stakes[wallet].suspended,          "stake suspended");
        require(block.timestamp < stakes[wallet].unlocksAt, unicode"lock expired — no coverage");

        // C2: rate limit oracle only — owner has no cap (emergency path)
        if (msg.sender == oracle) {
            uint256 today = block.timestamp / 1 days;
            if (today != lastClaimDay) {
                dailyClaimCount = 0;
                lastClaimDay    = today;
            }
            uint256 dailyLimit = (MAX_STAKERS * CLAIM_RATE_BPS) / 10_000;
            if (dailyLimit == 0) dailyLimit = 1;   // always allow at least 1 per day
            require(dailyClaimCount < dailyLimit,  "oracle daily claim limit reached");
            dailyClaimCount++;
        }

        bytes32 claimId = keccak256(abi.encodePacked(wallet, txHash));
        require(claims[claimId].entitlement == 0, "claim exists");

        // Permanent forfeiture on submission — independent of claim outcome.
        stakes[wallet].withdrawn    = true;
        stakes[wallet].claimActive  = true;
        if (!stakes[wallet].slotReleased) totalStakers--;
        stakes[wallet].slotReleased = true;
        // totalStaked NOT decremented here — principal stays in pool as reserve until claim completes

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
     * M6 fix: whenNotPaused — emergency pause stops all ETH outflow including active streams.
     * H3 fix: totalStaked decremented when claim completes — accounting stays accurate.
     * M4 fix: failed ETH transfer stored in failedPayouts — never traps permanently.
     * L4 fix: PointsConfirmed emits c.wallet (staker), not beneficiary.
     *
     * @dev Integer truncation in vestedTotal loses up to 1 wei per call. Dust recovered
     * on final call: _min caps elapsed to VESTING, making vestedTotal == entitlement exactly.
     */
    function claimStream(bytes32 claimId, address beneficiary) external nonReentrant whenNotPaused {
        Claim storage c = claims[claimId];

        require(c.status == 1,                     "claim not active");
        require(msg.sender == c.wallet,            "not claimant");
        require(block.timestamp >= c.cooldownEnds, "cooldown active");
        require(c.streamed < c.entitlement,        "already completed");
        require(
            keccak256(abi.encodePacked(beneficiary)) == stakes[c.wallet].beneficiaryHash,
            "wrong beneficiary"
        );

        uint256 elapsed     = _min(block.timestamp, uint256(c.vestingEnds)) - uint256(c.cooldownEnds);
        uint256 vestedTotal = (c.entitlement * elapsed) / VESTING;
        uint256 claimable   = vestedTotal - c.streamed;
        require(claimable > 0, "nothing claimable");

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

        if (c.streamed >= c.entitlement) {
            c.status = 2;   // completed
            stakes[c.wallet].claimActive = false;
            totalStaked -= stakes[c.wallet].amount;  // H3: principal slot consumed — remove from pool total
            stakes[c.wallet].amount = 0;             // H3: zero amount for consistency
            emit PointsConfirmed(c.wallet, LOCK_PERIOD / 1 days, LOCK_PERIOD / 1 days);  // L4: staker wallet
            emit ClaimCompleted(claimId, c.wallet);
        }

        // M4: don't revert on failed transfer — store for owner rescue
        (bool ok,) = beneficiary.call{value: transfer}("");
        if (!ok) {
            failedPayouts[beneficiary] += transfer;
            totalFailedPayouts         += transfer;
            emit PayoutFailed(claimId, beneficiary, transfer);
        }
    }

    // -----------------------------------------------------------------------
    // Payout — F1 cancelClaim
    // -----------------------------------------------------------------------

    /**
     * @notice F1: owner cancels an active claim (false positive).
     * Any ETH already streamed is not recovered. Remaining entitlement cancelled.
     * Principal is permanently forfeited — intentional penalty design.
     * H1 fix: totalStaked decremented and amount zeroed to eliminate accounting inflation.
     * ETH stays in contract as pool surplus. No refund is issued.
     */
    function cancelClaim(bytes32 claimId) external onlyOwner nonReentrant {
        Claim storage c = claims[claimId];
        require(c.status == 1, "claim not active");

        address wallet = c.wallet;
        uint256 amount = stakes[wallet].amount;

        c.status = 3;
        stakes[wallet].claimActive = false;
        stakes[wallet].amount      = 0;
        if (amount > 0) totalStaked -= amount;

        emit ClaimCancelled(claimId, wallet);
    }

    /**
     * @notice F3: owner revokes a pending 2-of-2 override before it executes.
     * M4 fix: prevents fraudulent or mistaken overrides from completing after first approval.
     */
    function cancelPendingOverride(bytes32 claimId) external onlyOwner {
        require(pendingOverrides[claimId].wallet != address(0), "no pending override");
        delete pendingOverrides[claimId];
        emit OverrideCancelled(claimId);
    }

    // -----------------------------------------------------------------------
    // Payout — F2 approveOverride (2-of-2)
    // -----------------------------------------------------------------------

    /**
     * @notice F2: 2-of-2 manual override for false negatives or disputes.
     * Owner and coSigner each call with identical params.
     * Second call executes — creates claim in active state, bypassing submitClaim.
     *
     * M5 fix: claimId validated on-chain against wallet+txHash — no off-chain trust.
     * M1 fix: completed claims (status=2) cannot be overridden — prevents double payout.
     *
     * @param claimId     keccak256(abi.encodePacked(wallet, txHash)) — validated on-chain
     * @param wallet      Wallet to receive the override payout
     * @param txHash      Transaction hash of the drain event
     * @param entitlement Override payout amount (wei)
     */
    function approveOverride(
        bytes32 claimId,
        address wallet,
        bytes32 txHash,
        uint256 entitlement
    ) external whenNotPaused {
        require(msg.sender == owner() || msg.sender == coSigner, "not authorized");
        require(claimId == keccak256(abi.encodePacked(wallet, txHash)), "claimId mismatch");  // M5
        require(wallet != address(0),           "zero wallet");
        require(entitlement > 0,                "zero entitlement");
        require(entitlement <= MAX_COVERAGE,    "exceeds max coverage");
        require(entitlement <= _tierCap(stakes[wallet].tier), "exceeds tier cap");
        require(stakes[wallet].amount > 0,                  "wallet not staked");
        require(!stakes[wallet].withdrawn,                  "stake withdrawn");
        require(!stakes[wallet].suspended,                  "stake suspended");
        require(block.timestamp < stakes[wallet].unlocksAt, unicode"lock expired — no coverage");

        OverrideRequest storage req = pendingOverrides[claimId];

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
            require(!req.ownerApproved,    "owner already approved");
            req.ownerApproved = true;
        } else {
            require(!req.coSignerApproved, "cosigner already approved");
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

        address wallet_      = req.wallet;
        bytes32 txHash_      = req.txHash;
        uint256 entitlement_ = req.entitlement;

        delete pendingOverrides[claimId];

        Claim storage existing = claims[claimId];
        require(existing.status != 2, "claim already completed - cannot override");  // M1
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
            status:              1   // active — both sigs verified
        });

        stakes[wallet_].withdrawn   = true;
        stakes[wallet_].claimActive = true;
        if (!stakes[wallet_].slotReleased) {
            totalStakers--;
            stakes[wallet_].slotReleased = true;   // H4: prevent double-decrement via releaseExpiredSlot
        }

        emit OverrideExecuted(claimId, wallet_, entitlement_);
    }

    // -----------------------------------------------------------------------
    // Owner — rescue failed payouts (M4)
    // -----------------------------------------------------------------------

    /**
     * @notice Rescue ETH stuck due to a reverting beneficiary address.
     * Sends recovered amount to owner for manual redistribution to the staker.
     */
    function rescueFailedPayout(address beneficiary) external onlyOwner nonReentrant {
        uint256 amount = failedPayouts[beneficiary];
        require(amount > 0, "nothing to rescue");
        failedPayouts[beneficiary] = 0;
        totalFailedPayouts        -= amount;
        emit PayoutRescued(beneficiary, amount);
        (bool ok,) = owner().call{value: amount}("");
        require(ok, "rescue transfer failed");
    }

    // -----------------------------------------------------------------------
    // Owner — suspension
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
        require(newCoSigner != owner(),    "cosigner must differ from owner");
        coSigner = newCoSigner;
        emit CoSignerUpdated(newCoSigner);
    }

    function transferOwnership(address newOwner) public override onlyOwner {
        require(newOwner != coSigner, "new owner cannot equal cosigner");
        super.transferOwnership(newOwner);
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

    /**
     * @notice Emergency withdrawal of pool surplus only.
     * C1 fix: limited to address(this).balance - totalStaked - totalFailedPayouts.
     *         Staker principals and pending rescue reserves are always protected.
     */
    function emergencyWithdraw() external onlyOwner whenPaused nonReentrant {
        uint256 reserved = totalStaked + totalFailedPayouts;
        uint256 surplus  = address(this).balance > reserved
            ? address(this).balance - reserved
            : 0;
        require(surplus > 0, "no surplus to withdraw");
        emit EmergencyWithdrawn(surplus);
        (bool ok,) = owner().call{value: surplus}("");
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

    function _tierCap(uint8 tier) internal pure returns (uint256) {
        if (tier == 1) return (MAX_COVERAGE * 8_000) / 10_000;  // A: 80% = 0.20 ETH
        if (tier == 2) return (MAX_COVERAGE * 7_000) / 10_000;  // B: 70% = 0.175 ETH
        return             (MAX_COVERAGE * 5_000) / 10_000;       // C: 50% = 0.125 ETH
    }
}
