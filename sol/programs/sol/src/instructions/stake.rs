use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke, system_instruction};
use crate::{constants::*, error::SafuError, state::*};

pub fn handler(ctx: Context<Stake>, amount: u64) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    let state = &mut ctx.accounts.pool_state;
    let staker_key = ctx.accounts.staker.key();

    require!(!state.paused, SafuError::Paused);
    require!(amount >= MIN_STAKE, SafuError::BelowMinStake);
    require!(amount <= MAX_STAKE, SafuError::AboveMaxStake);

    let stake_record = &mut ctx.accounts.stake_record;
    if stake_record.penalty_until > 0 {
        require!(now >= stake_record.penalty_until, SafuError::PenaltyActive);
    }
    require!(!stake_record.active_claim, SafuError::ActiveClaim);

    // Transfer SOL staker → vault via raw invoke (most stable across Solana SDK versions)
    invoke(
        &system_instruction::transfer(
            &ctx.accounts.staker.key(),
            &ctx.accounts.pool_vault.key(),
            amount,
        ),
        &[
            ctx.accounts.staker.to_account_info(),
            ctx.accounts.pool_vault.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
    )?;

    let is_og = state.og_count < OG_STAKER_LIMIT;
    if is_og {
        state.og_count = state.og_count.checked_add(1).ok_or(SafuError::Overflow)?;
    }

    stake_record.staker = staker_key;
    stake_record.amount = amount;
    stake_record.staked_at = now;
    stake_record.is_og = is_og;
    stake_record.active_claim = false;
    stake_record.penalty_until = 0;
    stake_record.bump = ctx.bumps.stake_record;

    state.total_staked = state
        .total_staked
        .checked_add(amount)
        .ok_or(SafuError::Overflow)?;

    Ok(())
}

#[derive(Accounts)]
pub struct Stake<'info> {
    #[account(mut)]
    pub staker: Signer<'info>,

    #[account(
        mut,
        seeds = [POOL_STATE_SEED],
        bump = pool_state.bump,
    )]
    pub pool_state: Account<'info, PoolState>,

    #[account(
        mut,
        seeds = [POOL_VAULT_SEED],
        bump = pool_state.vault_bump,
    )]
    pub pool_vault: Account<'info, VaultState>,

    // `init` not `init_if_needed`: stake record is closed on unstake, so re-stake always inits fresh.
    #[account(
        init,
        payer = staker,
        space = 8 + StakeRecord::INIT_SPACE,
        seeds = [STAKE_SEED, staker.key().as_ref()],
        bump,
    )]
    pub stake_record: Account<'info, StakeRecord>,

    pub system_program: Program<'info, System>,
}
