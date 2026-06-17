// Minimal ABI — only functions the UI calls (v7)
window.SAFU_ABI = [
  // Core stake/withdraw
  "function stakeETH(uint8 tier, uint64 deadline, bytes32 reasonHash, bytes sig, address beneficiary) payable",
  "function withdraw(address beneficiary)",
  "function emergencyExit()",

  // Claim flow
  "function claimStream(bytes32 claimId, address beneficiary)",
  "function unlockPendingClaim(bytes32 claimId)",

  // View — staker
  "function stakeOf(address wallet) view returns (tuple(bytes32 beneficiaryHash, uint256 amount, uint256 wstethDeployed, uint8 tier, uint64 stakedAt, uint64 penaltyLockedUntil, bool withdrawn, bool suspended, bool claimActive))",
  "function isEligible(address wallet) view returns (bool)",
  "function isClaimEligible(address wallet) view returns (bool)",
  "function pointsOf(address wallet) view returns (uint256)",

  // View — pool
  "function totalStakers() view returns (uint256)",
  "function totalEverStaked() view returns (uint256)",
  "function totalStaked() view returns (uint256)",
  "function totalAllocated() view returns (uint256)",
  "function yieldBalance() view returns (uint256)",
  "function MIN_STAKE() view returns (uint256)",

  // Events
  "event Staked(address indexed wallet, uint256 amount, uint8 tier, bytes32 reasonHash)",
  "event Withdrawn(address indexed wallet, uint256 amount)",
  "event ClaimSubmitted(bytes32 indexed claimId, address indexed wallet, bytes32 txHash, uint256 entitlement)",
  "event ClaimQueued(bytes32 indexed claimId, address indexed wallet, bytes32 txHash, uint256 entitlement)",
  "event ClaimUnlocked(bytes32 indexed claimId, address indexed wallet)",
  "event ClaimStreamed(bytes32 indexed claimId, address indexed wallet, uint256 amount, uint256 totalStreamed)",
  "event ClaimCompleted(bytes32 indexed claimId, address indexed wallet)",
  "event PointsEarned(bytes32 indexed walletHash, uint256 amount, uint64 stakedAt)",
  "event PointsBurned(address indexed wallet, uint256 burned, uint256 remaining)",
  "event OGStaker(address indexed wallet, uint256 timestamp)",
];
