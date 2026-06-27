use anchor_lang::prelude::*;
use crate::{constants::*, state::*};

pub fn handler(
    ctx: Context<Initialize>,
    oracle_eth: [u8; 20],
    cosigner_eth: [u8; 20],
) -> Result<()> {
    let clock = Clock::get()?;

    let state = &mut ctx.accounts.pool_state;
    state.owner = ctx.accounts.owner.key();
    state.oracle_eth = oracle_eth;
    state.cosigner_eth = cosigner_eth;
    state.paused = false;
    state.total_staked = 0;
    state.og_count = 0;
    state.outflow_day = (clock.unix_timestamp / SECONDS_PER_DAY) * SECONDS_PER_DAY;
    state.outflow_today = 0;
    state.bump = ctx.bumps.pool_state;
    state.vault_bump = ctx.bumps.pool_vault;

    ctx.accounts.pool_vault.bump = ctx.bumps.pool_vault;

    Ok(())
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init,
        payer = owner,
        space = 8 + PoolState::INIT_SPACE,
        seeds = [POOL_STATE_SEED],
        bump,
    )]
    pub pool_state: Account<'info, PoolState>,

    /// Vault is program-owned — payouts use direct lamport manipulation (no invoke_signed needed).
    #[account(
        init,
        payer = owner,
        space = 8 + VaultState::INIT_SPACE,
        seeds = [POOL_VAULT_SEED],
        bump,
    )]
    pub pool_vault: Account<'info, VaultState>,

    pub system_program: Program<'info, System>,
}
