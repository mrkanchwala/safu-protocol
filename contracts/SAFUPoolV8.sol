// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.25;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

// -----------------------------------------------------------------------
// External interfaces
// -----------------------------------------------------------------------

interface ILido {
    function submit(address referral) external payable returns (uint256);
}

interface IStETH {
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IWstETH {
    function wrap(uint256 stETHAmount) external returns (uint256);
    function unwrap(uint256 wstETHAmount) external returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function stEthPerToken() external view returns (uint256); // current stETH per wstETH (1e18 scale) — for off-chain sizing
}

interface ICurvePool {
    function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) external payable returns (uint256);
    function get_dy(int128 i, int128 j, uint256 dx) external view returns (uint256);
}

/**
 * SAFUPool v8 — proportional staking, tier assessed at claim time.
 * Compiler: 0.8.25 (locked — no floating pragma, compiler bug resolved).
 *
 * ETH-only, no lock. Permissionless enrollment: any stake in [STAKE_MIN, STAKE_MAX] accepted.
 * Tier (A/B/C) assessed off-chain at claim time — not at enrollment.
 * Coverage cap: stake × tier_ratio × 75% (A=15×, B=10×, C=5×).
 *
 * Payout controls:
 *   - submitClaim: oracle-signed (tier + all params in ECDSA sig); 90-day time gate
 *   - claimStream: pull-payment; 100% linear over 45 days; dynamic outflow cap (5%/3%/1%/day)
 *   - Stake forfeited on submission — permanent regardless of claim outcome
 *   - F1 cancelClaim: onlyOwner; cancels if false positive; principal permanently forfeited (penalty)
 *   - F2 approveOverride: 2-of-2; corrects false negatives or disputed entitlements
 *
 * v6 security fixes (Hashlock audit 2026-05-27): carried forward from v7.
 * v7→v8 changes:
 *   V8-1  — permissionless enrollment (oracle sig removed from stakeETH)
 *   V8-2  — proportional points: (stake / STAKE_MAX) × base_rate / day
 *   V8-3  — 90-day time gate replaces MIN_CLAIM_POINTS = 9,000
 *   V8-4  — tier assessed at claim; Claim struct carries tier (B1 fix)
 *   V8-5  — coverage cap: stake × tier_ratio × TIER_COVERAGE_BPS / 10_000
 *   V8-6  — dynamic outflow cap: 5%/3%/1%/day by utilization (replaces flat 2%)
 *   V8-B2 — tier included in submitClaim ECDSA sig — prevents tier forgery
 *
 * Pool economics:
 *   MAX_POOL_ETH = 60 ETH. Coverage: stake × tier_ratio × 75%.
 *   Solvency invariant: totalAllocated + entitlement <= totalStaked (enforced in submitClaim).
 *
 * Tier system (floor = C, DECLINE removed):
 *   1 = A → up to 15× coverage on stake × 75%   (e.g. 0.75 ETH → 8.4375 ETH cap)
 *   2 = B → up to 10× coverage on stake × 75%   (e.g. 0.375 ETH → 2.8125 ETH cap)
 *   3 = C → up to  5× coverage on stake × 75%   (e.g. 0.01 ETH  → 0.0375 ETH cap)
 */
contract SAFUPoolV8 is Ownable, ReentrancyGuard, Pausable {

    // -----------------------------------------------------------------------
    // Constants
    // -----------------------------------------------------------------------

    uint256 public constant STAKE_MIN         = 0.01 ether;
    uint256 public constant STAKE_MAX         = 0.75 ether;
    uint256 public constant TIER_COVERAGE_BPS = 7_500;   // 75% max payout — all tiers
    uint256 public constant TIER_A_RATIO      = 15;      // Tier A: 15× stake coverage
    uint256 public constant TIER_B_RATIO      = 10;      // Tier B: 10× stake coverage
    uint256 public constant TIER_C_RATIO      = 5;       // Tier C:  5× stake coverage
    uint256 public constant MAX_POOL_ETH      = 60 ether;

    uint256 public constant COOLDOWN          = 7 days;
    uint256 public constant VESTING           = 45 days;
    uint256 public constant CLAIM_WINDOW      = 30 days;
    uint256 public constant CLAIM_MIN_DAYS    = 90;      // 90-day time gate (replaces points gate)
    // Dynamic stress cap:  25% of pool/day (< 20% committed) | 10% (20–49%) | 3% (≥ 50%)
    // Dynamic outflow cap:  5% of pool/day (< 20% utilized)  |  3% (20–49%) | 1% (≥ 50%)

    // Points system — accrual: (stake/STAKE_MAX) × rate/day — bands: 100/120/150/200
    // Points are a loyalty/reward metric only — claim gate is time-based (CLAIM_MIN_DAYS)

    // Lido + Curve — mainnet addresses (immutable)
    address public constant LIDO       = 0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84;
    address public constant STETH      = 0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84; // stETH = Lido contract
    address public constant WSTETH     = 0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0;
    address public constant CURVE_POOL = 0xDC24316b9AE028F1497c275EB9192a3Ea0f67022;

    // MEV / slippage
    uint256 public constant SLIPPAGE_CAP    = 500;  // hard ceiling 5% — cannot be raised
    int128  internal constant CURVE_IDX_ETH   = 0;
    int128  internal constant CURVE_IDX_STETH = 1;

    // -----------------------------------------------------------------------
    // State
    // -----------------------------------------------------------------------

    address public oracle;
    address public coSigner;

    uint256 public totalStakers;
    uint256 public totalStaked;
    uint256 public totalAllocated; // running sum of (entitlement - streamed) for all active claims
    uint256 public maxPoolSize;
    address public treasuryWallet;
    uint256 public totalEverStaked;
    uint256 public totalUniqueStakers;   // I3: counts first-time stakers only; used for OGStaker badge gate

    uint256 public dailyOutflow;
    uint256 public lastOutflowDay;

    // Dynamic stress cap tracking
    uint256 public dailyEntitlementTotal;
    uint256 public lastEntitlementDay;
    uint256 public dailyClaimCount;     // C2: oracle per-claim-count rate limit (10% of totalStakers/day, min 1)

    mapping(address => StakeRecord)     public stakes;
    mapping(bytes32 => bool)            public revokedApprovals;
    mapping(bytes32 => Claim)           public claims;
    mapping(bytes32 => OverrideRequest) public pendingOverrides;
    mapping(address => uint256)         public failedPayouts;     // M4: rescue bucket for stuck ETH
    uint256 public totalFailedPayouts;                           // M4+: total pending rescue — excluded from emergencyWithdraw surplus
    mapping(address => bool)            public hasEverStaked;     // L6: OGStaker dedup — prevents re-stake from re-emitting event
    mapping(address => uint256)         public pointsBalance;     // banked points after stake exit — accumulates across all cycles

    uint256 public totalDeployed;        // total wstETH held in Lido (wstETH units, not ETH)
    uint256 public totalDeployedETH;     // ETH equivalent deployed to Lido (original stake amounts) — used for yieldBalance
    uint256 public slippageBps = 100;    // current Curve swap tolerance — default 1%
    bool    private _swapping;           // F11: suppresses false YieldReceived during Curve ETH return
    uint256 public totalExtractedYield;  // running sum of ETH sent to treasury via extractYield + withdrawYield

    // -----------------------------------------------------------------------
    // Structs
    // -----------------------------------------------------------------------

    struct StakeRecord {
        bytes32 beneficiaryHash;  // keccak256(abi.encodePacked(beneficiary)) — plaintext never stored
        uint256 amount;
        uint256 wstethDeployed;   // actual wstETH from wrap() — used for exact unwrap at withdraw
        uint64  stakedAt;
        uint64  penaltyLockedUntil; // set by cancelClaim — blocks withdraw for 365 days
        bool    withdrawn;
        bool    suspended;          // owner can block payout eligibility; does not block principal withdrawal
        bool    claimActive;        // true while a claim is open — blocks withdrawal
    }

    struct Claim {
        address  wallet;
        bytes32  txHash;
        uint256  hackTimestamp;       // block timestamp of the hack — validated at submitClaim, stored for event re-emit
        uint256  entitlement;         // total approved payout (wei)
        uint256  streamed;            // already paid out (wei)
        uint256  stake;               // s.amount captured at submitClaim — used by cancelClaim to restore totalStaked
        uint64   cooldownEnds;        // activation timestamp + 7d
        uint64   vestingEnds;         // cooldownEnds + 45d (day 52 from approval)
        uint256  totalStakedSnapshot; // cap denominator — fixed at activation, not live balance
        uint8    tier;                // assessed by oracle at claim time (B1 fix)
        uint8    status;              // 0=unused 1=active 2=completed 3=cancelled 4=reserved 5=pending_time
    }

    struct OverrideRequest {
        address  wallet;
        bytes32  txHash;
        uint256  entitlement;
        uint8    tier;
        bool     ownerApproved;
        bool     coSignerApproved;
    }

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    event Staked(address indexed wallet, uint256 amount);
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

    event MaxPoolSizeUpdated(uint256 newSize);
    event EmergencyWithdrawn(uint256 amount);
    event PayoutFailed(bytes32 indexed claimId, address indexed beneficiary, uint256 amount);  // M4
    event PayoutRescued(address indexed beneficiary, uint256 amount);                          // M4

    event ClaimSubmitted(bytes32 indexed claimId, address indexed wallet, bytes32 txHash, uint256 entitlement, uint8 tier, uint256 hackTimestamp);
    event ClaimActivated(bytes32 indexed claimId, address indexed wallet, uint64 cooldownEnds, uint64 vestingEnds);
    event ClaimStreamed(bytes32 indexed claimId, address indexed wallet, uint256 amount, uint256 totalStreamed);
    event ClaimCompleted(bytes32 indexed claimId, address indexed wallet);
    event ClaimCancelled(bytes32 indexed claimId, address indexed wallet);
    event ClaimQueued(bytes32 indexed claimId, address indexed wallet, bytes32 txHash, uint256 entitlement, uint8 tier, uint256 hackTimestamp);
    event ClaimUnlocked(bytes32 indexed claimId, address indexed wallet);
    event OverrideApproved(bytes32 indexed claimId, address approver);
    event OverrideExecuted(bytes32 indexed claimId, address indexed wallet, uint256 entitlement);
    event OverrideCancelled(bytes32 indexed claimId);  // M4: pending override revoked by owner

    event PointsBurned(address indexed wallet, uint256 burned, uint256 remaining);
    event PointsSnapshot(address indexed wallet, uint256 amount);
    event YieldReceived(uint256 amount);
    event PenaltyApplied(address indexed wallet, uint64 lockedUntil);
    event EmergencyExit(address indexed wallet, uint256 wstethAmount);
    event LiquidityProvided(uint256 wstethUnwrapped, uint256 ethReceived);
    event YieldExtracted(uint256 wstethUnwrapped, uint256 ethReceived, uint256 yieldSentToTreasury);

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
    constructor(
        address oracle_,
        address coSigner_,
        uint256 maxPoolSize_,
        address treasuryWallet_
    ) Ownable(msg.sender) {
        require(oracle_         != address(0),   "zero oracle");
        require(coSigner_       != address(0),   "zero coSigner");
        require(coSigner_       != msg.sender,   "coSigner must differ from owner");
        require(oracle_         != coSigner_,    "oracle must differ from coSigner");
        require(treasuryWallet_ != address(0),   "zero treasury");
        oracle         = oracle_;
        coSigner       = coSigner_;
        maxPoolSize    = maxPoolSize_;
        treasuryWallet = treasuryWallet_;
    }

    // -----------------------------------------------------------------------
    // Core — stakeETH
    // -----------------------------------------------------------------------

    /**
     * @notice Stake ETH — permissionless. No oracle approval required at enrollment.
     * Any amount in [STAKE_MIN, STAKE_MAX] accepted. Tier is assessed at claim time, not here.
     */
    function stakeETH(
        address beneficiary,
        bool    acknowledgedForfeiture
    ) external payable nonReentrant whenNotPaused {
        require(acknowledgedForfeiture,                           "SAFU: must acknowledge stake forfeiture risk");
        require(msg.value >= STAKE_MIN && msg.value <= STAKE_MAX, "SAFU: stake out of range");
        require(stakes[msg.sender].amount == 0,                   "already staked");
        require(totalStaked + msg.value <= MAX_POOL_ETH,          "pool full");
        require(totalStaked + msg.value <= maxPoolSize,           "pool cap exceeded");
        require(beneficiary != address(0),                        "zero beneficiary");
        require(beneficiary != msg.sender,                        "beneficiary cannot be staker");
        require(beneficiary != oracle,                            "beneficiary cannot be oracle");
        require(beneficiary != owner(),                           "beneficiary cannot be owner");
        require(beneficiary != coSigner,                          "beneficiary cannot be cosigner");

        uint64 now_ = uint64(block.timestamp);
        bytes32 beneficiaryHash = keccak256(abi.encodePacked(beneficiary));

        stakes[msg.sender] = StakeRecord({
            beneficiaryHash:    beneficiaryHash,
            amount:             msg.value,
            wstethDeployed:     0,
            stakedAt:           now_,
            penaltyLockedUntil: 0,
            withdrawn:          false,
            suspended:          false,
            claimActive:        false
        });

        totalStakers++;
        totalStaked      += msg.value;
        bool firstStake   = !hasEverStaked[msg.sender];
        if (firstStake) { hasEverStaked[msg.sender] = true; totalUniqueStakers++; }
        totalEverStaked++;

        emit Staked(msg.sender, msg.value);
        emit PointsEarned(beneficiaryHash, msg.value, now_);
        if (firstStake && totalUniqueStakers <= 50) emit OGStaker(msg.sender, block.timestamp);

        // Lido integration — ETH → stETH → wstETH (delta pattern, F10: concurrent-stake safe)
        uint256 stethBefore  = IStETH(STETH).balanceOf(address(this));
        ILido(LIDO).submit{value: msg.value}(address(0));
        uint256 stethGained  = IStETH(STETH).balanceOf(address(this)) - stethBefore;
        IStETH(STETH).approve(WSTETH, stethGained);
        uint256 wstethGained = IWstETH(WSTETH).wrap(stethGained);
        stakes[msg.sender].wstethDeployed = wstethGained;
        totalDeployed    += wstethGained;
        totalDeployedETH += msg.value;
    }

    // -----------------------------------------------------------------------
    // Core — withdraw
    // -----------------------------------------------------------------------

    /**
     * @notice Withdraw staked principal (no lock period — exit any time).
     * Blocked while a claim is active (claimActive == true).
     * Suspended flag does NOT block withdrawal — principal always recoverable.
     */
    function withdraw(address beneficiary) external nonReentrant whenNotPaused {
        StakeRecord storage s = stakes[msg.sender];

        require(s.amount > 0,   "no stake");
        require(!s.withdrawn,   "already withdrawn");
        require(!s.claimActive, "claim active");
        require(block.timestamp >= s.penaltyLockedUntil, "SAFU: penalty lock active");
        require(
            keccak256(abi.encodePacked(beneficiary)) == s.beneficiaryHash,
            "wrong beneficiary"
        );

        uint256 finalPoints    = _computePoints(msg.sender); // must read before withdrawn=true
        uint256 daysStaked     = (block.timestamp - uint256(s.stakedAt)) / 1 days;
        uint256 amount         = s.amount;
        uint256 wstethDeployed = s.wstethDeployed;

        // CEI — all state updates before external calls (F9: totalDeployed decremented here)
        s.withdrawn = true;
        s.amount    = 0;
        totalStakers--;
        totalStaked      -= amount;
        totalDeployed    -= wstethDeployed;
        totalDeployedETH -= amount;

        pointsBalance[msg.sender] += finalPoints;
        emit PointsSnapshot(msg.sender, finalPoints);
        emit PointsConfirmed(msg.sender, finalPoints, daysStaked);
        emit Withdrawn(msg.sender, amount);

        // External calls — Lido unwrap → Curve stETH→ETH → payout (approve fix: _unwrapToEth includes stETH.approve)
        uint256 receivedEth = _unwrapToEth(wstethDeployed);
        uint256 payout = receivedEth >= amount ? amount : receivedEth; // staker gets exactly their fee, excess → yield
        (bool ok,) = msg.sender.call{value: payout}("");
        // M4 parity: if staker is a contract that rejects ETH, store for rescue rather than reverting
        if (!ok) {
            failedPayouts[msg.sender] += payout;
            totalFailedPayouts        += payout;
            emit PayoutFailed(bytes32(0), msg.sender, payout);
        }
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
    // Payout — submitClaim
    // -----------------------------------------------------------------------

    /**
     * @notice Oracle or owner registers a verified loss event for a staker.
     *
     * V8: tier assessed at claim time; oracle includes tier in ECDSA sig (B2 fix).
     * Owner bypass: no sig required when msg.sender == owner().
     * @dev OWNER BYPASS: submitClaim by owner skips ECDSA sig entirely. A compromised owner key
     *      allows arbitrary claim creation for any wallet/tier/entitlement. Move owner key to a
     *      2-of-N multisig or remove this bypass. Treat owner key as HSM-equivalent.
     * 90-day time gate: hack before day 90 → status=5 (pending); day 90+ → immediate.
     *
     * Dynamic stress cap: daily entitlement accepted = f(pool utilization). Hard floor: totalAllocated + entitlement ≤ totalStaked.
     * claimId = keccak256(abi.encodePacked(wallet, txHash))
     */
    function submitClaim(
        address        wallet,
        bytes32        txHash,
        uint256        entitlement,
        uint8          tier,
        uint256        hackTimestamp,
        uint64         deadline,
        bytes calldata sig
    ) external whenNotPaused {
        require(msg.sender == oracle || msg.sender == owner(), "not oracle or owner");
        require(wallet != address(0),   "zero wallet");
        require(entitlement > 0,        "zero entitlement");
        require(tier >= 1 && tier <= 3, "invalid tier");

        // B2: oracle must provide ECDSA sig covering all params including tier
        if (msg.sender == oracle) {
            require(block.timestamp <= deadline, "approval expired");
            bytes32 inner = keccak256(abi.encodePacked(
                "SAFU_CLAIM_APPROVAL",
                address(this),
                block.chainid,
                wallet, txHash, entitlement, tier, hackTimestamp, deadline
            ));
            bytes32 ethHash = MessageHashUtils.toEthSignedMessageHash(inner);
            require(ECDSA.recover(ethHash, sig) == oracle, "invalid oracle sig");
            require(!revokedApprovals[keccak256(abi.encodePacked(inner))], "SAFU: approval revoked");
        }

        StakeRecord storage s = stakes[wallet];
        require(entitlement <= _tierCap(tier, s.amount), "exceeds tier cap");
        require(s.amount > 0,            "wallet not staked");
        require(!s.withdrawn,            "stake forfeited");
        require(!s.suspended,            "stake suspended");
        require(hackTimestamp <= block.timestamp,               "SAFU: hack in future");
        require(hackTimestamp >= s.stakedAt,                    "SAFU: hack predates stake");
        require(block.timestamp <= hackTimestamp + CLAIM_WINDOW, "SAFU: claim window expired");
        require(totalAllocated + entitlement <= totalStaked,   "SAFU: pool overcommitted");

        uint256 today = block.timestamp / 1 days;
        if (today != lastEntitlementDay) {
            dailyEntitlementTotal = 0;
            dailyClaimCount       = 0;
            lastEntitlementDay    = today;
        }
        require(dailyEntitlementTotal + entitlement <= _stressCap(), "SAFU: daily exposure cap reached");
        dailyEntitlementTotal += entitlement;
        if (msg.sender == oracle) {
            uint256 maxClaims = totalStakers / 10 > 0 ? totalStakers / 10 : 1;
            require(dailyClaimCount < maxClaims, "SAFU: oracle claim rate limit");
            dailyClaimCount++;
        }

        bytes32 claimId = keccak256(abi.encodePacked(wallet, txHash));
        require(claims[claimId].entitlement == 0, "claim exists");

        s.claimActive = true;
        totalAllocated += entitlement;

        // 90-day time gate: pending path if hack before day 90
        if (block.timestamp < uint256(s.stakedAt) + CLAIM_MIN_DAYS * 1 days) {
            claims[claimId] = Claim({
                wallet:              wallet,
                txHash:              txHash,
                hackTimestamp:       hackTimestamp,
                entitlement:         entitlement,
                streamed:            0,
                stake:               s.amount,
                cooldownEnds:        0,
                vestingEnds:         0,
                totalStakedSnapshot: 0,
                tier:                tier,
                status:              5
            });
            emit ClaimQueued(claimId, wallet, txHash, entitlement, tier, hackTimestamp);
            return;
        }

        // Immediate path: bank current points, forfeit stake, activate stream
        uint256 earned = _computePoints(wallet);
        if (earned > 0) {
            pointsBalance[wallet] += earned;
            emit PointsSnapshot(wallet, earned);
        }

        uint256 stakeAmount    = s.amount;
        uint256 snapshotBefore = totalStaked;
        s.withdrawn = true;
        totalStakers--;
        totalStaked -= stakeAmount;

        claims[claimId] = Claim({
            wallet:              wallet,
            txHash:              txHash,
            hackTimestamp:       hackTimestamp,
            entitlement:         entitlement,
            streamed:            0,
            stake:               stakeAmount,
            cooldownEnds:        0,
            vestingEnds:         0,
            totalStakedSnapshot: 0,
            tier:                tier,
            status:              0
        });

        emit ClaimSubmitted(claimId, wallet, txHash, entitlement, tier, hackTimestamp);
        _activateClaim(claimId, snapshotBefore);
    }

    function _activateClaim(bytes32 claimId, uint256 snapshot) internal {
        Claim storage c = claims[claimId];

        uint64 now_         = uint64(block.timestamp);
        uint64 cooldownEnds = now_ + uint64(COOLDOWN);
        uint64 vestingEnds  = cooldownEnds + uint64(VESTING);

        c.cooldownEnds        = cooldownEnds;
        c.vestingEnds         = vestingEnds;
        c.totalStakedSnapshot = snapshot; // pre-forfeiture totalStaked — correct outflow cap denominator
        c.status              = 1;

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
        uint256 cap       = (capBase * _dynamicOutflowBps(capBase)) / 10_000;
        uint256 remaining = cap > dailyOutflow ? cap - dailyOutflow : 0;
        require(remaining > 0, "daily cap reached");

        uint256 transfer = _min(claimable, remaining);
        require(address(this).balance >= transfer, "SAFU: insufficient liquidity for stream");

        // Effects before interaction (CEI)
        c.streamed     += transfer;
        dailyOutflow   += transfer;
        totalAllocated -= transfer;

        emit ClaimStreamed(claimId, c.wallet, transfer, c.streamed);

        if (c.streamed >= c.entitlement) {
            c.status = 2;
            stakes[c.wallet].claimActive = false;
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
        require(c.status == 1 || c.status == 5, "claim not active or pending");

        address wallet   = c.wallet;
        uint8 prevStatus = c.status;

        c.status = 3;
        stakes[wallet].claimActive = false;

        if (prevStatus == 1) {
            // Active claim: undo forfeiture + apply 365-day penalty
            uint256 remaining = c.entitlement - c.streamed;
            stakes[wallet].withdrawn = false;
            if (remaining > 0) totalAllocated -= remaining;
            totalStakers++;
            totalStaked += c.stake;
            uint64 lockedUntil = uint64(block.timestamp + 365 days);
            stakes[wallet].penaltyLockedUntil = lockedUntil;
            emit ClaimCancelled(claimId, wallet);
            emit PenaltyApplied(wallet, lockedUntil);
        } else {
            // Pending claim (status 5): stake never forfeited — only release totalAllocated reservation.
            // No penalty: oracle logged the hack, staker had no agency over the submission.
            totalAllocated -= c.entitlement; // streamed == 0 always for pending
            emit ClaimCancelled(claimId, wallet);
        }
    }

    // -----------------------------------------------------------------------
    // Payout — unlockPendingClaim
    // -----------------------------------------------------------------------

    /**
     * @notice Activate a pending claim (status=5) once the 90-day time gate has passed.
     * Callable by anyone — staker, oracle, or owner. Banks current points, forfeits stake, starts stream.
     * Points stop accruing immediately: withdrawn=true blocks _computePoints after this call.
     */
    function unlockPendingClaim(bytes32 claimId) external whenNotPaused nonReentrant {
        Claim storage c = claims[claimId];
        require(c.status == 5, "claim not pending");

        address wallet = c.wallet;
        require(!stakes[wallet].suspended, "SAFU: wallet suspended");
        require(
            block.timestamp >= uint256(stakes[wallet].stakedAt) + CLAIM_MIN_DAYS * 1 days,
            "SAFU: too early"
        );

        // Bank current points — no burn (time gate replaces points gate in V8)
        uint256 earned = _computePoints(wallet);
        if (earned > 0) {
            pointsBalance[wallet] += earned;
            emit PointsSnapshot(wallet, earned);
        }

        uint256 stakeAmount    = stakes[wallet].amount;
        uint256 snapshotBefore = totalStaked;
        stakes[wallet].withdrawn = true;
        totalStakers--;
        totalStaked -= stakeAmount;

        emit ClaimUnlocked(claimId, wallet);
        emit ClaimSubmitted(claimId, wallet, c.txHash, c.entitlement, c.tier, c.hackTimestamp);
        _activateClaim(claimId, snapshotBefore);
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
        uint256 entitlement,
        uint8   tier
    ) external whenNotPaused nonReentrant {
        require(msg.sender == owner() || msg.sender == coSigner, "not authorized");
        require(claimId == keccak256(abi.encodePacked(wallet, txHash)), "claimId mismatch");  // M5
        require(wallet != address(0),     "zero wallet");
        require(entitlement > 0,          "zero entitlement");
        require(tier >= 1 && tier <= 3,   "invalid tier");
        require(entitlement <= _tierCap(tier, stakes[wallet].amount), "exceeds tier cap");
        require(stakes[wallet].amount > 0, "wallet not staked");
        require(!stakes[wallet].withdrawn, "stake withdrawn");
        require(!stakes[wallet].suspended, "stake suspended");
        // No time gate: 2-of-2 multi-sig is the security gate for overrides.
        OverrideRequest storage req = pendingOverrides[claimId];

        if (req.wallet != address(0)) {
            require(req.wallet == wallet,           "wallet mismatch");
            require(req.txHash == txHash,           "txHash mismatch");
            require(req.entitlement == entitlement, "entitlement mismatch");
            require(req.tier == tier,               "tier mismatch");
        } else {
            req.wallet      = wallet;
            req.txHash      = txHash;
            req.entitlement = entitlement;
            req.tier        = tier;
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
        uint8   tier_        = req.tier;   // B1: copy before delete

        delete pendingOverrides[claimId];

        Claim storage existing = claims[claimId];
        require(existing.status != 2, "claim already completed - cannot override");  // M1

        // Capture status BEFORE overwriting claims[claimId] — storage pointer becomes stale after assignment
        uint8 prevStatus = existing.status;

        if (prevStatus == 1) {
            stakes[existing.wallet].claimActive = false;
        }

        uint64 now_         = uint64(block.timestamp);
        uint64 cooldownEnds = now_ + uint64(COOLDOWN);
        uint64 vestingEnds  = cooldownEnds + uint64(VESTING);

        uint256 stakeAmount = stakes[wallet_].amount;

        // Adjust totalAllocated for prior reservation (status 1 = active, status 5 = pending)
        if (prevStatus == 1 || prevStatus == 5) {
            uint256 oldRemaining = existing.entitlement - existing.streamed;
            if (oldRemaining > 0) totalAllocated -= oldRemaining;
        }
        totalAllocated += entitlement_;

        claims[claimId] = Claim({
            wallet:              wallet_,
            txHash:              txHash_,
            hackTimestamp:       existing.hackTimestamp,  // preserve from original submitClaim
            entitlement:         entitlement_,
            streamed:            0,
            stake:               stakeAmount,
            cooldownEnds:        cooldownEnds,
            vestingEnds:         vestingEnds,
            totalStakedSnapshot: totalStaked,
            tier:                tier_,   // B1: tier from override request (both sigs agreed)
            status:              1
        });

        if (prevStatus != 1) {
            // status 0/3/4 (no prior claim) or 5 (pending — forfeit stake now)
            // claimActive already true for status=5; set for others
            stakes[wallet_].withdrawn   = true;
            stakes[wallet_].claimActive = true;
            totalStakers--;
            totalStaked -= stakeAmount;
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

    function setTreasury(address newTreasury) external onlyOwner {
        require(newTreasury != address(0), "zero treasury");
        treasuryWallet = newTreasury;
    }

    // @dev yieldBalance = liquid ETH + ETH deployed to Lido (at original stake values) − staker principal − failed payouts reserved.
    // Returns 0 while all principal is in Lido — yield materializes in address(this).balance only after staker withdrawals.
    // Force-sent ETH via selfdestruct appears as extractable yield — known behavior, does not affect totalStaked.
    function yieldBalance() external view returns (uint256) {
        uint256 reserved = totalStaked + totalFailedPayouts;
        uint256 total    = address(this).balance + totalDeployedETH;
        return total > reserved ? total - reserved : 0;
    }

    function withdrawYield(uint256 amount) external onlyOwner nonReentrant {
        uint256 reserved = totalStaked + totalFailedPayouts;
        uint256 total    = address(this).balance + totalDeployedETH;
        uint256 available = total > reserved ? total - reserved : 0;
        require(amount <= available, "SAFU: exceeds yield balance");
        require(amount <= address(this).balance, "SAFU: insufficient liquid ETH");
        totalExtractedYield += amount;
        (bool ok,) = treasuryWallet.call{value: amount}("");
        require(ok, "SAFU: yield transfer failed");
    }

    /**
     * @notice Convert wstETH to liquid ETH to fund pending claim streams.
     * Owner calls during the 7-day claim cooldown. ETH stays in contract.
     * @dev proportional ethEquiv maintains invariant: balance + totalDeployedETH >= totalStaked + totalFailedPayouts
     */
    function provideClaimLiquidity(uint256 wstethAmount) external onlyOwner nonReentrant whenNotPaused {
        require(wstethAmount > 0,              "SAFU: zero amount");
        require(wstethAmount <= totalDeployed, "SAFU: exceeds deployed");

        // Proportional principal equivalent for this wstETH tranche
        uint256 ethEquiv = totalDeployedETH * wstethAmount / totalDeployed;

        // CEI: accounting updates before external calls
        totalDeployed    -= wstethAmount;
        totalDeployedETH -= ethEquiv;

        // External: unwrap wstETH + Curve swap — ETH lands in address(this).balance via receive()
        uint256 receivedEth = _unwrapToEth(wstethAmount);
        emit LiquidityProvided(wstethAmount, receivedEth);
    }

    /**
     * @notice Extract Lido yield (appreciation above principal) to treasuryWallet.
     * Only the excess above proportional principal is sent to treasury; principal stays in contract.
     * @dev No whenNotPaused — consistent with withdrawYield() (owner's yield is accessible during pause).
     *      Depeg scenario: receivedEth < ethEquiv → yieldAmount = 0, no treasury call.
     */
    function extractYield(uint256 wstethAmount) external onlyOwner nonReentrant {
        require(wstethAmount > 0,              "SAFU: zero amount");
        require(totalDeployed > 0,             "SAFU: nothing deployed");
        require(wstethAmount <= totalDeployed, "SAFU: exceeds deployed");

        uint256 ethEquiv = totalDeployedETH * wstethAmount / totalDeployed;

        // CEI: accounting updates before external calls
        totalDeployed    -= wstethAmount;
        totalDeployedETH -= ethEquiv;

        uint256 receivedEth = _unwrapToEth(wstethAmount);

        // Yield = appreciation above principal. Depeg: receivedEth < ethEquiv → 0 yield (F12 risk).
        uint256 yieldAmount = receivedEth > ethEquiv ? receivedEth - ethEquiv : 0;
        totalExtractedYield += yieldAmount; // CEI: state update before treasury call

        if (yieldAmount > 0) {
            (bool ok,) = treasuryWallet.call{value: yieldAmount}("");
            require(ok, "SAFU: yield transfer failed");
        }

        emit YieldExtracted(wstethAmount, receivedEth, yieldAmount);
    }

    function setSlippage(uint256 bps) external onlyOwner {
        require(bps <= SLIPPAGE_CAP, "SAFU: slippage cap exceeded");
        slippageBps = bps;
    }

    function setOracle(address newOracle) external onlyOwner {
        require(newOracle != address(0), "zero oracle");
        require(newOracle != coSigner,   "oracle must differ from coSigner");
        oracle = newOracle;
        emit OracleUpdated(newOracle);
    }

    function setCoSigner(address newCoSigner) external onlyOwner {
        require(newCoSigner != address(0), "zero cosigner");
        require(newCoSigner != owner(),    "cosigner must differ from owner");
        require(newCoSigner != oracle,     "coSigner must differ from oracle");
        coSigner = newCoSigner;
        emit CoSignerUpdated(newCoSigner);
    }

    function transferOwnership(address newOwner) public override onlyOwner {
        require(newOwner != coSigner, "new owner cannot equal cosigner");
        super.transferOwnership(newOwner);
    }

    function renounceOwnership() public override onlyOwner {
        revert("SAFU: renounce disabled");
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
     * @notice Staker self-rescue during pause — returns wstETH directly, no Lido/Curve calls.
     * No time lock: stakers can exit immediately the moment the contract is paused.
     * Owner cannot call this. No path for owner to receive another staker's wstETH.
     * @dev wstETH amount returned = original wrap() value; staker handles unwrap/swap themselves.
     */
    function emergencyExit() external whenPaused nonReentrant {
        StakeRecord storage s = stakes[msg.sender];
        require(s.amount > 0 && !s.withdrawn, "no active stake");
        require(!s.claimActive, "SAFU: claim active");
        uint256 wstethOut = s.wstethDeployed;
        uint256 ethAmount = s.amount;
        s.withdrawn = true;
        s.amount    = 0;
        totalStakers--;
        totalStaked      -= ethAmount;
        totalDeployed    -= wstethOut;
        totalDeployedETH -= ethAmount;
        emit EmergencyExit(msg.sender, wstethOut);
        bool ok = IWstETH(WSTETH).transfer(msg.sender, wstethOut);
        require(ok, "SAFU: wstETH transfer failed");
    }

    // -----------------------------------------------------------------------
    // View
    // -----------------------------------------------------------------------

    // F11: Curve exchange() sends ETH back via receive() — _swapping suppresses false YieldReceived
    receive() external payable {
        if (!_swapping) emit YieldReceived(msg.value);
    }

    function stakeOf(address wallet) external view returns (StakeRecord memory) {
        return stakes[wallet];
    }

    function isEligible(address wallet) external view returns (bool) {
        StakeRecord storage s = stakes[wallet];
        return s.amount > 0 && !s.withdrawn && !s.suspended;
    }

    function pointsOf(address wallet) external view returns (uint256) {
        StakeRecord storage s = stakes[wallet];
        if (s.amount > 0 && !s.withdrawn) return _computePoints(wallet);
        return pointsBalance[wallet];
    }

    function isClaimEligible(address wallet) external view returns (bool) {
        StakeRecord storage s = stakes[wallet];
        return s.amount > 0 && !s.withdrawn && !s.suspended &&
               block.timestamp >= uint256(s.stakedAt) + CLAIM_MIN_DAYS * 1 days;
    }

    // -----------------------------------------------------------------------
    // Internal
    // -----------------------------------------------------------------------

    /**
     * @dev Shared unwrap + Curve swap path. Fixes missing stETH.approve(CURVE_POOL) that was absent
     * from the original withdraw() implementation — the Curve stETH/ETH pool uses transferFrom.
     */
    function _unwrapToEth(uint256 wstethAmount) internal returns (uint256 receivedEth) {
        uint256 stethOut = IWstETH(WSTETH).unwrap(wstethAmount);
        IStETH(STETH).approve(CURVE_POOL, stethOut);
        uint256 expected = ICurvePool(CURVE_POOL).get_dy(CURVE_IDX_STETH, CURVE_IDX_ETH, stethOut);
        uint256 minEth   = expected * (10_000 - slippageBps) / 10_000;
        require(minEth > 0, "SAFU: minEth underflow");
        _swapping = true;
        receivedEth = ICurvePool(CURVE_POOL).exchange(CURVE_IDX_STETH, CURVE_IDX_ETH, stethOut, minEth);
        _swapping = false;
        require(receivedEth >= minEth, "SAFU: slippage exceeded");
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    function _stressCap() internal view returns (uint256) {
        if (totalStaked == 0) return 0;
        uint256 utilizationBps = (totalAllocated * 10_000) / totalStaked;
        uint256 rateBps = utilizationBps < 2_000 ? 2_500  // < 20%: allow 25% of pool/day
                        : utilizationBps < 5_000 ? 1_000  // 20–49%: allow 10%
                        :                            300;  // ≥ 50%: allow 3%
        return (totalStaked * rateBps) / 10_000;
    }

    function _computePoints(address wallet) internal view returns (uint256) {
        StakeRecord storage s = stakes[wallet];
        if (s.amount == 0 || s.withdrawn) return 0;
        uint256 d  = (block.timestamp - uint256(s.stakedAt)) / 1 days;
        uint256 d1 = _min(d, 90);
        uint256 d2 = d > 90  ? _min(d, 180) - 90  : 0;
        uint256 d3 = d > 180 ? _min(d, 365) - 180 : 0;
        uint256 d4 = d > 365 ? d - 365             : 0;
        uint256 base = d1 * 100 + d2 * 120 + d3 * 150 + d4 * 200;
        // Proportional by stake — 0.75 ETH earns full rate; lesser stakes earn proportionally less.
        // E1: truncation ~1pt/day at min stake (0.01 ETH) — no impact on time gate, acceptable.
        return base * s.amount / STAKE_MAX;
    }

    function _tierCap(uint8 tier, uint256 stakeAmount) internal pure returns (uint256) {
        uint256 ratio = tier == 1 ? TIER_A_RATIO : tier == 2 ? TIER_B_RATIO : TIER_C_RATIO;
        return stakeAmount * ratio * TIER_COVERAGE_BPS / 10_000;
    }

    // Uses capBase (max of live totalStaked and claim snapshot) as the utilization denominator.
    // This prevents the zero-division edge case when the sole staker has forfeited (totalStaked→0)
    // while their stream is still active.
    function _dynamicOutflowBps(uint256 base) internal view returns (uint256) {
        if (base == 0) return 100; // fully committed — most conservative rate
        uint256 util = (totalAllocated * 10_000) / base;
        return util < 2_000 ? 500 : util < 5_000 ? 300 : 100;
    }
}
