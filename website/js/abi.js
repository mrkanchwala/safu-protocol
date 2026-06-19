// Minimal ABI — only functions the UI calls (v8)
window.SAFU_ABI = [
  // Core stake/withdraw — permissionless, no oracle sig required
  "function stakeETH(address beneficiary, bool acknowledgedForfeiture) payable",
  "function withdraw(address beneficiary)",
  "function emergencyExit()",

  // Claim flow
  "function claimStream(bytes32 claimId, address beneficiary)",
  "function unlockPendingClaim(bytes32 claimId)",

  // View — staker
  "function stakeOf(address wallet) view returns (tuple(bytes32 beneficiaryHash, uint256 amount, uint256 wstethDeployed, uint64 stakedAt, uint64 penaltyLockedUntil, bool withdrawn, bool suspended, bool claimActive))",
  "function isEligible(address wallet) view returns (bool)",
  "function isClaimEligible(address wallet) view returns (bool)",
  "function pointsOf(address wallet) view returns (uint256)",

  // View — pool
  "function totalStakers() view returns (uint256)",
  "function totalEverStaked() view returns (uint256)",
  "function totalStaked() view returns (uint256)",
  "function totalAllocated() view returns (uint256)",

  // Constants
  "function STAKE_MIN() view returns (uint256)",
  "function STAKE_MAX() view returns (uint256)",

  // Events
  "event Staked(address indexed wallet, uint256 amount)",
  "event Withdrawn(address indexed wallet, uint256 amount)",
  "event ClaimSubmitted(bytes32 indexed claimId, address indexed wallet, bytes32 txHash, uint256 entitlement, uint8 tier, uint256 hackTimestamp)",
  "event ClaimActivated(bytes32 indexed claimId, address indexed wallet, uint64 cooldownEnds, uint64 vestingEnds)",
  "event ClaimQueued(bytes32 indexed claimId, address indexed wallet, bytes32 txHash, uint256 entitlement, uint8 tier, uint256 hackTimestamp)",
  "event ClaimUnlocked(bytes32 indexed claimId, address indexed wallet)",
  "event ClaimStreamed(bytes32 indexed claimId, address indexed wallet, uint256 amount, uint256 totalStreamed)",
  "event ClaimCompleted(bytes32 indexed claimId, address indexed wallet)",
  "event ClaimCancelled(bytes32 indexed claimId, address indexed wallet)",
  "event PointsEarned(bytes32 indexed walletHash, uint256 amount, uint64 stakedAt)",
  "event PointsConfirmed(address indexed wallet, uint256 finalPoints, uint256 daysStaked)",
  "event PointsBurned(address indexed wallet, uint256 burned, uint256 remaining)",
  "event PointsSnapshot(address indexed wallet, uint256 amount)",
  "event OGStaker(address indexed wallet, uint256 timestamp)",
];
