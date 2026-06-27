use anchor_lang::prelude::*;

/// Global pool configuration and accounting.
/// PDA: seeds=[b"pool_state"]
#[account]
#[derive(InitSpace)]
pub struct PoolState {
    pub owner: Pubkey,
    pub oracle_eth: [u8; 20],     // ETH address (20 bytes) of KMS oracle key
    pub cosigner_eth: [u8; 20],   // ETH address (20 bytes) of coSigner key
    pub paused: bool,
    pub total_staked: u64,        // lamports currently staked
    pub og_count: u64,            // number of OG stakers minted so far
    pub outflow_day: i64,         // start of current outflow window (unix timestamp, day-aligned)
    pub outflow_today: u64,       // lamports paid out in the current day
    pub bump: u8,
    pub vault_bump: u8,
}

/// Per-staker deposit record.
/// PDA: seeds=[b"stake", staker_pubkey]
#[account]
#[derive(InitSpace)]
pub struct StakeRecord {
    pub staker: Pubkey,
    pub amount: u64,              // lamports staked (determines tier at claim time)
    pub staked_at: i64,          // unix timestamp of stake
    pub is_og: bool,             // true if minted as one of the first 50 stakers
    pub active_claim: bool,      // true while a ClaimRecord exists for this staker
    pub penalty_until: i64,      // if >0, staking is blocked until this timestamp (cancel penalty)
    pub bump: u8,
}

/// Per-staker claim record. Created by submit_claim, closed on completion or cancellation.
/// PDA: seeds=[b"claim", staker_pubkey]
#[account]
#[derive(InitSpace)]
pub struct ClaimRecord {
    pub staker: Pubkey,
    pub hack_timestamp: i64,     // reported timestamp of the exploit
    pub submitted_at: i64,       // when submit_claim was called
    pub status: ClaimStatus,
    pub tier: u8,                // TIER_C=0, TIER_B=1, TIER_A=2 — set at submit_claim
    pub entitlement: u64,        // total lamports oracle approved for payout
    pub streamed: u64,           // lamports already streamed to staker
    pub cooldown_end: i64,       // streaming begins after this timestamp
    pub vesting_start: i64,      // vesting clock starts here (= cooldown_end)
    pub bump: u8,
}

/// Temporary record created when owner submits a manual override (false-negative correction).
/// PDA: seeds=[b"override", staker_pubkey]
#[account]
#[derive(InitSpace)]
pub struct PendingOverride {
    pub staker: Pubkey,
    pub entitlement: u64,
    pub created_at: i64,
    pub bump: u8,
}

/// Vault marker — program-owned account that accumulates staked SOL.
/// Actual balance is stored as lamports on this account.
/// PDA: seeds=[b"pool_vault"]
#[account]
#[derive(InitSpace)]
pub struct VaultState {
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, InitSpace, Default)]
pub enum ClaimStatus {
    #[default]
    Pending,    // submitted, oracle verified, waiting for cooldown
    Approved,   // same as Pending (explicit approved state for override path)
    Streaming,  // cooldown elapsed, stream in progress
    Complete,   // fully streamed
    Cancelled,  // cancelled via 2-of-2 (false positive)
}
