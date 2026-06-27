use anchor_lang::prelude::*;

#[error_code]
pub enum SafuError {
    #[msg("Pool is paused")]
    Paused,
    #[msg("Stake amount below minimum (0.25 SOL)")]
    BelowMinStake,
    #[msg("Stake amount above maximum (18 SOL)")]
    AboveMaxStake,
    #[msg("Active claim in progress — unstake blocked")]
    ActiveClaim,
    #[msg("Penalty period active — stake blocked")]
    PenaltyActive,
    #[msg("Already has an active claim")]
    AlreadyHasClaim,
    #[msg("Oracle secp256k1 instruction invalid or missing")]
    InvalidOracleSignature,
    #[msg("CoSigner secp256k1 instruction invalid or missing")]
    InvalidCosignerSignature,
    #[msg("Hack timestamp is more than 30 days in the past")]
    HackTimestampTooOld,
    #[msg("Hack timestamp is in the future")]
    HackTimestampFuture,
    #[msg("Claim not approved — must call submit_claim first")]
    NotApproved,
    #[msg("Claim is not in Streaming state")]
    NotStreaming,
    #[msg("Cooldown period has not elapsed")]
    CooldownActive,
    #[msg("Nothing available to stream yet")]
    NothingToStream,
    #[msg("Daily outflow cap reached (2%/day)")]
    OutflowCapReached,
    #[msg("Vault balance would breach rent-exempt floor")]
    VaultRentFloor,
    #[msg("Claim is already final (Cancelled or Complete)")]
    ClaimFinal,
    #[msg("Secp256k1 instruction has invalid structure")]
    InvalidSecp256k1Instruction,
    #[msg("Message hash in secp256k1 instruction does not match expected")]
    MessageHashMismatch,
    #[msg("ETH address in secp256k1 instruction does not match oracle")]
    OracleAddressMismatch,
    #[msg("ETH address in secp256k1 instruction does not match cosigner")]
    CosignerAddressMismatch,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Unauthorized — owner only")]
    Unauthorized,
    #[msg("No pending override for this staker")]
    NoPendingOverride,
    #[msg("Entitlement exceeds 15x stake (tier A cap)")]
    EntitlementCapExceeded,
}
