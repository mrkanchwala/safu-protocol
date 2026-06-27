use anchor_lang::prelude::*;
use crate::{
    constants::*,
    error::SafuError,
    state::*,
    utils::{cancel_message_hash, verify_cosigner_secp256k1_ix, verify_secp256k1_ix},
};

/// Cancel a claim (false positive correction). Owner-initiated, 2-of-2 oracle+cosigner signed.
///
/// Transaction layout (ENFORCED):
///   ix[0] — secp256k1 by oracle
///   ix[1] — secp256k1 by cosigner
///   ix[2] — this cancel_claim instruction
///
/// Message signed: keccak256("SAFU_SOL_CANCEL" || staker(32B) || submitted_at(8B LE))
///
/// Effect: claim is Cancelled, staker receives 365-day penalty (penalty_until is set).
/// False positive cancel is punitive by design — principal remains with staker, but staking
/// is blocked for 1 year.
pub fn handler(ctx: Context<CancelClaim>) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let state = &ctx.accounts.pool_state;

    let claim = &ctx.accounts.claim_record;
    require!(
        claim.status != ClaimStatus::Complete && claim.status != ClaimStatus::Cancelled,
        SafuError::ClaimFinal
    );

    let msg_hash = cancel_message_hash(&claim.staker, claim.submitted_at);

    verify_secp256k1_ix(
        &ctx.accounts.instructions_sysvar,
        0,
        &state.oracle_eth,
        &msg_hash,
    )?;
    verify_cosigner_secp256k1_ix(
        &ctx.accounts.instructions_sysvar,
        1,
        &state.cosigner_eth,
        &msg_hash,
    )?;

    ctx.accounts.claim_record.status = ClaimStatus::Cancelled;

    // Apply 1-year penalty
    ctx.accounts.stake_record.active_claim = false;
    ctx.accounts.stake_record.penalty_until = now + PENALTY_SECONDS;

    Ok(())
}

#[derive(Accounts)]
pub struct CancelClaim<'info> {
    /// Owner initiates cancel on behalf of the pool
    #[account(
        constraint = pool_state.owner == owner.key() @ SafuError::Unauthorized
    )]
    pub owner: Signer<'info>,

    #[account(
        seeds = [POOL_STATE_SEED],
        bump = pool_state.bump,
    )]
    pub pool_state: Account<'info, PoolState>,

    /// CHECK: instructions sysvar for secp256k1 ix verification
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,

    /// The staker whose claim is being cancelled
    pub staker: SystemAccount<'info>,

    #[account(
        mut,
        seeds = [STAKE_SEED, staker.key().as_ref()],
        bump = stake_record.bump,
    )]
    pub stake_record: Account<'info, StakeRecord>,

    #[account(
        mut,
        seeds = [CLAIM_SEED, staker.key().as_ref()],
        bump = claim_record.bump,
    )]
    pub claim_record: Account<'info, ClaimRecord>,
}
