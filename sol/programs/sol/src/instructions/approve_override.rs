use anchor_lang::prelude::*;
use crate::{
    constants::*,
    error::SafuError,
    state::*,
    utils::{override_message_hash, verify_cosigner_secp256k1_ix, verify_secp256k1_ix},
};

/// Approve a denied claim (false negative correction). Owner-initiated, 2-of-2 signed.
///
/// Transaction layout (ENFORCED):
///   ix[0] — secp256k1 by oracle
///   ix[1] — secp256k1 by cosigner
///   ix[2] — this approve_override instruction
///
/// Message signed: keccak256("SAFU_SOL_OVERRIDE" || staker(32B) || entitlement(8B LE))
///
/// Creates a ClaimRecord for a staker who either never submitted or was denied.
/// Sets status=Approved and starts the 7-day cooldown immediately.
pub fn handler(ctx: Context<ApproveOverride>, entitlement: u64) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let staker_key = ctx.accounts.staker.key();
    let state = &ctx.accounts.pool_state;

    require!(!state.paused, SafuError::Paused);

    // Cap entitlement at 15x stake
    let max_entitlement = ctx
        .accounts
        .stake_record
        .amount
        .checked_mul(TIER_A_MULT)
        .ok_or(SafuError::Overflow)?;
    require!(entitlement <= max_entitlement, SafuError::EntitlementCapExceeded);

    let msg_hash = override_message_hash(&staker_key, entitlement);

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

    use crate::utils::compute_tier;
    let tier = compute_tier(ctx.accounts.stake_record.amount);
    let cooldown_end = now + COOLDOWN_SECONDS;

    let claim = &mut ctx.accounts.claim_record;
    claim.staker = staker_key;
    claim.hack_timestamp = 0; // not known in override path
    claim.submitted_at = now;
    claim.status = ClaimStatus::Approved;
    claim.tier = tier;
    claim.entitlement = entitlement;
    claim.streamed = 0;
    claim.cooldown_end = cooldown_end;
    claim.vesting_start = cooldown_end;
    claim.bump = ctx.bumps.claim_record;

    ctx.accounts.stake_record.active_claim = true;

    Ok(())
}

#[derive(Accounts)]
pub struct ApproveOverride<'info> {
    #[account(
        mut,
        constraint = pool_state.owner == owner.key() @ SafuError::Unauthorized
    )]
    pub owner: Signer<'info>,

    #[account(
        seeds = [POOL_STATE_SEED],
        bump = pool_state.bump,
    )]
    pub pool_state: Account<'info, PoolState>,

    /// CHECK: instructions sysvar
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,

    pub staker: SystemAccount<'info>,

    #[account(
        mut,
        seeds = [STAKE_SEED, staker.key().as_ref()],
        bump = stake_record.bump,
    )]
    pub stake_record: Account<'info, StakeRecord>,

    #[account(
        init,
        payer = owner,
        space = 8 + ClaimRecord::INIT_SPACE,
        seeds = [CLAIM_SEED, staker.key().as_ref()],
        bump,
    )]
    pub claim_record: Account<'info, ClaimRecord>,

    pub system_program: Program<'info, System>,
}
