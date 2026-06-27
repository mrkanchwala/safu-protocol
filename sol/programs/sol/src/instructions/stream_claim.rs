use anchor_lang::prelude::*;
use crate::{constants::*, error::SafuError, state::*};

/// Pull vesting after cooldown. Can be called repeatedly until fully streamed.
/// Linear vesting over VESTING_SECONDS starting from claim.vesting_start.
pub fn handler(ctx: Context<StreamClaim>) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    let claim = &mut ctx.accounts.claim_record;

    // Cooldown must have elapsed
    require!(now >= claim.cooldown_end, SafuError::CooldownActive);

    // Transition Pending → Streaming on first pull
    if claim.status == ClaimStatus::Pending {
        claim.status = ClaimStatus::Streaming;
    }
    require!(
        claim.status == ClaimStatus::Streaming,
        SafuError::NotStreaming
    );

    // Compute how much has vested so far
    let elapsed = now
        .checked_sub(claim.vesting_start)
        .unwrap_or(0)
        .max(0);
    let vested = if elapsed >= VESTING_SECONDS {
        claim.entitlement
    } else {
        // elapsed / VESTING_SECONDS * entitlement (integer math, no overflow)
        (claim.entitlement as u128)
            .checked_mul(elapsed as u128)
            .and_then(|v| v.checked_div(VESTING_SECONDS as u128))
            .and_then(|v| u64::try_from(v).ok())
            .ok_or(SafuError::Overflow)?
    };

    let streamable = vested.saturating_sub(claim.streamed);
    require!(streamable > 0, SafuError::NothingToStream);

    // Outflow cap check
    let state = &mut ctx.accounts.pool_state;
    let today_start = (now / SECONDS_PER_DAY) * SECONDS_PER_DAY;
    if today_start > state.outflow_day {
        state.outflow_day = today_start;
        state.outflow_today = 0;
    }
    let daily_cap = state
        .total_staked
        .checked_mul(OUTFLOW_CAP_BPS)
        .and_then(|v| v.checked_div(BPS_DENOM))
        .ok_or(SafuError::Overflow)?;

    let allowed = daily_cap.saturating_sub(state.outflow_today).min(streamable);
    require!(allowed > 0, SafuError::OutflowCapReached);

    // Vault rent floor: vault must retain at least VAULT_RENT_BUFFER after payout
    let vault_lamports = ctx.accounts.pool_vault.to_account_info().lamports();
    require!(
        vault_lamports >= allowed.checked_add(VAULT_RENT_BUFFER).ok_or(SafuError::Overflow)?,
        SafuError::VaultRentFloor
    );

    // Transfer from program-owned vault to staker via direct lamport manipulation
    **ctx.accounts.pool_vault.to_account_info().try_borrow_mut_lamports()? -= allowed;
    **ctx.accounts.staker.to_account_info().try_borrow_mut_lamports()? += allowed;

    // Update state
    state.outflow_today = state
        .outflow_today
        .checked_add(allowed)
        .ok_or(SafuError::Overflow)?;

    claim.streamed = claim
        .streamed
        .checked_add(allowed)
        .ok_or(SafuError::Overflow)?;

    // If fully paid out, mark complete and unlock stake
    if claim.streamed >= claim.entitlement {
        claim.status = ClaimStatus::Complete;
        ctx.accounts.stake_record.active_claim = false;
    }

    Ok(())
}

#[derive(Accounts)]
pub struct StreamClaim<'info> {
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
    )]
    pub stake_record: Account<'info, StakeRecord>,

    #[account(
        mut,
        seeds = [CLAIM_SEED, staker.key().as_ref()],
        bump = claim_record.bump,
    )]
    pub claim_record: Account<'info, ClaimRecord>,

    pub system_program: Program<'info, System>,
}
