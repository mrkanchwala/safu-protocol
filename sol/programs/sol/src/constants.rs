// PDA seeds
pub const POOL_STATE_SEED: &[u8] = b"pool_state";
pub const POOL_VAULT_SEED: &[u8] = b"pool_vault";
pub const STAKE_SEED: &[u8] = b"stake";
pub const CLAIM_SEED: &[u8] = b"claim";
pub const OVERRIDE_SEED: &[u8] = b"override";

// Stake tiers (lamports). 1 SOL = 1_000_000_000 lamports.
// Tier is determined AT CLAIM, not at stake — these thresholds are evaluated
// against stake_record.amount when submit_claim is called.
pub const MIN_STAKE: u64 = 250_000_000;      // 0.25 SOL
pub const TIER_C_MAX: u64 = 6_000_000_000;   // < 6 SOL  → Tier C
pub const TIER_B_MAX: u64 = 12_000_000_000;  // 6–12 SOL → Tier B
pub const MAX_STAKE: u64 = 18_000_000_000;   // 12–18 SOL → Tier A

// Coverage multipliers (oracle computes entitlement = stake * mult off-chain)
pub const TIER_A_MULT: u64 = 15;
pub const TIER_B_MULT: u64 = 10;
pub const TIER_C_MULT: u64 = 5;

// Tier IDs stored in ClaimRecord
pub const TIER_C: u8 = 0;
pub const TIER_B: u8 = 1;
pub const TIER_A: u8 = 2;

// Timing (seconds)
pub const COOLDOWN_SECONDS: i64 = 7 * 24 * 60 * 60;        // 7 days
pub const VESTING_SECONDS: i64 = 45 * 24 * 60 * 60;        // 45 days — matches EVM V8
pub const CLAIM_WINDOW_SECONDS: i64 = 30 * 24 * 60 * 60;   // 30-day backdating limit
pub const PENALTY_SECONDS: i64 = 365 * 24 * 60 * 60;       // 1-year cancel penalty
pub const SECONDS_PER_DAY: i64 = 86_400;

// Outflow cap: 2%/day of total_staked
pub const OUTFLOW_CAP_BPS: u64 = 200;
pub const BPS_DENOM: u64 = 10_000;

// OG badge: first 50 stakers
pub const OG_STAKER_LIMIT: u64 = 50;

// Minimum vault lamports to keep above rent-exempt floor (~0.002 SOL buffer)
pub const VAULT_RENT_BUFFER: u64 = 2_000_000;
