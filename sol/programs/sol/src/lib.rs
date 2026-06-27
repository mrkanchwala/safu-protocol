// Needed: instruction handlers take many params; comparison chains in tier logic
#![allow(clippy::too_many_arguments)]
#![allow(clippy::comparison_chain)]

pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;
pub mod utils;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("GcB56zjFUweTEBKzRH3PmsnCErqyCFoaBrQ9AzgK7wSC");

#[program]
pub mod sol {
    use super::*;

    // --- Pool lifecycle ---

    pub fn initialize(
        ctx: Context<Initialize>,
        oracle_eth: [u8; 20],
        cosigner_eth: [u8; 20],
    ) -> Result<()> {
        initialize::handler(ctx, oracle_eth, cosigner_eth)
    }

    // --- Staker operations ---

    pub fn stake(ctx: Context<Stake>, amount: u64) -> Result<()> {
        stake::handler(ctx, amount)
    }

    pub fn unstake(ctx: Context<Unstake>) -> Result<()> {
        unstake::handler(ctx)
    }

    // --- Claim lifecycle ---

    /// ix[0]=oracle secp256k1, ix[1]=cosigner secp256k1, ix[2]=this instruction
    pub fn submit_claim(
        ctx: Context<SubmitClaim>,
        hack_timestamp: i64,
        entitlement: u64,
    ) -> Result<()> {
        submit_claim::handler(ctx, hack_timestamp, entitlement)
    }

    pub fn stream_claim(ctx: Context<StreamClaim>) -> Result<()> {
        stream_claim::handler(ctx)
    }

    /// ix[0]=oracle secp256k1, ix[1]=cosigner secp256k1, ix[2]=this instruction
    pub fn cancel_claim(ctx: Context<CancelClaim>) -> Result<()> {
        cancel_claim::handler(ctx)
    }

    // --- Override (false negative) ---

    /// ix[0]=oracle secp256k1, ix[1]=cosigner secp256k1, ix[2]=this instruction
    pub fn approve_override(ctx: Context<ApproveOverride>, entitlement: u64) -> Result<()> {
        approve_override::handler(ctx, entitlement)
    }

    // --- Admin ---

    pub fn pause(ctx: Context<AdminOnly>) -> Result<()> {
        admin::pause_handler(ctx)
    }

    pub fn unpause(ctx: Context<AdminOnly>) -> Result<()> {
        admin::unpause_handler(ctx)
    }

    pub fn set_oracle(ctx: Context<AdminOnly>, new_eth: [u8; 20]) -> Result<()> {
        admin::set_oracle_handler(ctx, new_eth)
    }

    pub fn set_cosigner(ctx: Context<AdminOnly>, new_eth: [u8; 20]) -> Result<()> {
        admin::set_cosigner_handler(ctx, new_eth)
    }

    pub fn emergency_exit(ctx: Context<EmergencyExit>) -> Result<()> {
        admin::emergency_exit_handler(ctx)
    }
}
