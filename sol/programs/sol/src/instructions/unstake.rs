use anchor_lang::prelude::*;
use crate::{constants::*, error::SafuError, state::*};

pub fn handler(ctx: Context<Unstake>) -> Result<()> {
    let stake_record = &ctx.accounts.stake_record;

    require!(!stake_record.active_claim, SafuError::ActiveClaim);

    let amount = stake_record.amount;

    // Vault rent floor: leave enough lamports that the vault stays rent-exempt
    let vault_lamports = ctx.accounts.pool_vault.to_account_info().lamports();
    require!(
        vault_lamports >= amount.checked_add(VAULT_RENT_BUFFER).ok_or(SafuError::Overflow)?,
        SafuError::VaultRentFloor
    );

    // Transfer stake amount from vault to staker via direct lamport manipulation.
    // This is valid because pool_vault is program-owned (we can subtract from it).
    **ctx.accounts.pool_vault.to_account_info().try_borrow_mut_lamports()? -= amount;
    **ctx.accounts.staker.to_account_info().try_borrow_mut_lamports()? += amount;

    // Update pool accounting (stake_record is closed below, so read before the close)
    ctx.accounts.pool_state.total_staked = ctx
        .accounts
        .pool_state
        .total_staked
        .saturating_sub(amount);

    // stake_record is closed by Anchor via `close = staker` — rent returned to staker
    Ok(())
}

#[derive(Accounts)]
pub struct Unstake<'info> {
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

    #[account(
        mut,
        seeds = [STAKE_SEED, staker.key().as_ref()],
        bump = stake_record.bump,
        close = staker,
    )]
    pub stake_record: Account<'info, StakeRecord>,

    pub system_program: Program<'info, System>,
}
