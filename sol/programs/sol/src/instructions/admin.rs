use anchor_lang::prelude::*;
use crate::{constants::*, error::SafuError, state::*};

// --- pause ---

pub fn pause_handler(ctx: Context<AdminOnly>) -> Result<()> {
    ctx.accounts.pool_state.paused = true;
    Ok(())
}

// --- unpause ---

pub fn unpause_handler(ctx: Context<AdminOnly>) -> Result<()> {
    ctx.accounts.pool_state.paused = false;
    Ok(())
}

// --- set_oracle ---

pub fn set_oracle_handler(ctx: Context<AdminOnly>, new_eth: [u8; 20]) -> Result<()> {
    ctx.accounts.pool_state.oracle_eth = new_eth;
    Ok(())
}

// --- set_cosigner ---

pub fn set_cosigner_handler(ctx: Context<AdminOnly>, new_eth: [u8; 20]) -> Result<()> {
    ctx.accounts.pool_state.cosigner_eth = new_eth;
    Ok(())
}

// --- emergency_exit ---

pub fn emergency_exit_handler(ctx: Context<EmergencyExit>) -> Result<()> {
    let vault_lamports = ctx.accounts.pool_vault.to_account_info().lamports();

    // Leave exactly VAULT_RENT_BUFFER behind to keep the account alive
    let withdraw = vault_lamports.saturating_sub(VAULT_RENT_BUFFER);
    require!(withdraw > 0, SafuError::VaultRentFloor);

    **ctx.accounts.pool_vault.to_account_info().try_borrow_mut_lamports()? -= withdraw;
    **ctx.accounts.owner.to_account_info().try_borrow_mut_lamports()? += withdraw;

    ctx.accounts.pool_state.paused = true;
    ctx.accounts.pool_state.total_staked = 0;

    Ok(())
}

// --- shared accounts ---

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(
        constraint = pool_state.owner == owner.key() @ SafuError::Unauthorized
    )]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [POOL_STATE_SEED],
        bump = pool_state.bump,
    )]
    pub pool_state: Account<'info, PoolState>,
}

#[derive(Accounts)]
pub struct EmergencyExit<'info> {
    #[account(
        mut,
        constraint = pool_state.owner == owner.key() @ SafuError::Unauthorized
    )]
    pub owner: Signer<'info>,

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

    pub system_program: Program<'info, System>,
}
