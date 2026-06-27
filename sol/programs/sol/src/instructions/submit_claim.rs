use anchor_lang::prelude::*;
use crate::{
    constants::*,
    error::SafuError,
    state::*,
    utils::{claim_message_hash, compute_tier, verify_cosigner_secp256k1_ix, verify_secp256k1_ix},
};

/// Submit a claim after a hack event.
///
/// Transaction layout (ENFORCED):
///   ix[0] — secp256k1 instruction signed by oracle (KMS key ETH address)
///   ix[1] — secp256k1 instruction signed by cosigner
///   ix[2] — this submit_claim instruction
///
/// The oracle and cosigner each sign the same message:
///   keccak256("SAFU_SOL_CLAIM" || staker(32B) || hack_ts(8B LE) || entitlement(8B LE))
///
/// This is verified on-chain by reading ix[0] and ix[1] from the instructions sysvar.
/// The secp256k1 program already verified the cryptographic signatures — we verify the
/// recovered ETH addresses and the signed message hash.
pub fn handler(
    ctx: Context<SubmitClaim>,
    hack_timestamp: i64,
    entitlement: u64,
) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let staker_key = ctx.accounts.staker.key();
    let state = &ctx.accounts.pool_state;

    require!(!state.paused, SafuError::Paused);
    require!(!ctx.accounts.stake_record.active_claim, SafuError::AlreadyHasClaim);

    // Hack timestamp must be within the 30-day backdating window
    require!(hack_timestamp <= now, SafuError::HackTimestampFuture);
    require!(
        now - hack_timestamp <= CLAIM_WINDOW_SECONDS,
        SafuError::HackTimestampTooOld
    );

    // Entitlement cap: cannot exceed stake * TIER_A_MULT (15x) regardless of oracle value
    let max_entitlement = ctx
        .accounts
        .stake_record
        .amount
        .checked_mul(TIER_A_MULT)
        .ok_or(SafuError::Overflow)?;
    require!(entitlement <= max_entitlement, SafuError::EntitlementCapExceeded);

    // Compute the message hash both oracle and cosigner must have signed
    let msg_hash = claim_message_hash(&staker_key, hack_timestamp, entitlement);

    // Verify oracle secp256k1 instruction at ix[0]
    verify_secp256k1_ix(
        &ctx.accounts.instructions_sysvar,
        0,
        &state.oracle_eth,
        &msg_hash,
    )?;

    // Verify cosigner secp256k1 instruction at ix[1]
    verify_cosigner_secp256k1_ix(
        &ctx.accounts.instructions_sysvar,
        1,
        &state.cosigner_eth,
        &msg_hash,
    )?;

    // Compute tier at claim time from current stake amount
    let tier = compute_tier(ctx.accounts.stake_record.amount);

    let cooldown_end = now + COOLDOWN_SECONDS;

    // Populate claim record
    let claim = &mut ctx.accounts.claim_record;
    claim.staker = staker_key;
    claim.hack_timestamp = hack_timestamp;
    claim.submitted_at = now;
    claim.status = ClaimStatus::Pending;
    claim.tier = tier;
    claim.entitlement = entitlement;
    claim.streamed = 0;
    claim.cooldown_end = cooldown_end;
    claim.vesting_start = cooldown_end;
    claim.bump = ctx.bumps.claim_record;

    // Lock stake record
    ctx.accounts.stake_record.active_claim = true;

    Ok(())
}

#[derive(Accounts)]
pub struct SubmitClaim<'info> {
    #[account(mut)]
    pub staker: Signer<'info>,

    #[account(
        seeds = [POOL_STATE_SEED],
        bump = pool_state.bump,
    )]
    pub pool_state: Account<'info, PoolState>,

    #[account(
        mut,
        seeds = [STAKE_SEED, staker.key().as_ref()],
        bump = stake_record.bump,
    )]
    pub stake_record: Account<'info, StakeRecord>,

    #[account(
        init,
        payer = staker,
        space = 8 + ClaimRecord::INIT_SPACE,
        seeds = [CLAIM_SEED, staker.key().as_ref()],
        bump,
    )]
    pub claim_record: Account<'info, ClaimRecord>,

    /// CHECK: Solana instructions sysvar — used to load ix[0] and ix[1] for secp256k1 verification
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}
