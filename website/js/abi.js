// Minimal ABI — only functions the UI calls
window.SAFU_ABI = [
  "function stakeETH(uint8 tier, uint64 deadline, bytes32 reasonHash, bytes sig, address beneficiary) payable",
  "function claimStream(bytes32 claimId, address beneficiary)",
  "function withdraw(address beneficiary)",
  "function stakeOf(address wallet) view returns (tuple(bytes32 beneficiaryHash, uint256 amount, uint8 tier, uint64 stakedAt, uint64 unlocksAt, bool withdrawn, bool suspended, bool claimActive, bool slotReleased))",
  "function isEligible(address wallet) view returns (bool)",
  "function totalStakers() view returns (uint256)",
  "function totalEverStaked() view returns (uint256)",
  "event PointsEarned(bytes32 indexed walletHash, uint256 amount, uint64 stakedAt)",
  "event OGStaker(address indexed wallet, uint256 timestamp)",
];
