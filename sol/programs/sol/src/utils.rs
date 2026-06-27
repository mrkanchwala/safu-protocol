use anchor_lang::prelude::*;
use solana_instructions_sysvar::load_instruction_at_checked;
use tiny_keccak::{Hasher, Keccak};
use crate::error::SafuError;

// Native secp256k1 program — hardcoded because the ID crate moved in Solana 3.x SDK
const SECP256K1_PROGRAM_ID: Pubkey = pubkey!("KeccakSecp256k11111111111111111111111111111");

/// Verify that a secp256k1 instruction at `ix_index` exists in the transaction,
/// that its recovered ETH address matches `expected_eth_addr`, and that the signed
/// message hash matches `expected_msg_hash`.
///
/// The secp256k1 program verifies the cryptographic signature automatically when the
/// instruction executes — we only confirm the recovered address and signed message.
///
/// Secp256k1 instruction data layout (Secp256k1SignatureOffsets):
///   [0]      count: u8
///   [1..3]   signature_offset: u16 LE
///   [3]      signature_instruction_index: u8
///   [4..6]   eth_address_offset: u16 LE
///   [6]      eth_address_instruction_index: u8
///   [7..9]   message_data_offset: u16 LE
///   [9..11]  message_data_size: u16 LE
///   [11]     message_instruction_index: u8
///   [12..]   raw data: sig(64B) || eth_addr(20B) || msg_hash(32B)
pub fn verify_secp256k1_ix(
    instructions_sysvar: &AccountInfo,
    ix_index: usize,
    expected_eth_addr: &[u8; 20],
    expected_msg_hash: &[u8; 32],
) -> Result<()> {
    let ix = load_instruction_at_checked(ix_index, instructions_sysvar)
        .map_err(|_| error!(SafuError::InvalidSecp256k1Instruction))?;

    require_keys_eq!(
        ix.program_id,
        SECP256K1_PROGRAM_ID,
        SafuError::InvalidSecp256k1Instruction
    );

    let data = &ix.data;
    require!(data.len() >= 12, SafuError::InvalidSecp256k1Instruction);
    require!(data[0] >= 1, SafuError::InvalidSecp256k1Instruction);

    let eth_addr_offset = u16::from_le_bytes([data[4], data[5]]) as usize;
    let msg_offset     = u16::from_le_bytes([data[7], data[8]]) as usize;
    let msg_size       = u16::from_le_bytes([data[9], data[10]]) as usize;

    require!(
        data.len() >= eth_addr_offset.saturating_add(20),
        SafuError::InvalidSecp256k1Instruction
    );
    let eth_addr = &data[eth_addr_offset..eth_addr_offset + 20];
    require!(eth_addr == expected_eth_addr, SafuError::OracleAddressMismatch);

    require!(msg_size == 32, SafuError::InvalidSecp256k1Instruction);
    require!(
        data.len() >= msg_offset.saturating_add(32),
        SafuError::InvalidSecp256k1Instruction
    );
    let msg_hash = &data[msg_offset..msg_offset + 32];
    require!(msg_hash == expected_msg_hash, SafuError::MessageHashMismatch);

    Ok(())
}

/// Same as verify_secp256k1_ix but emits CosignerAddressMismatch on address failure.
pub fn verify_cosigner_secp256k1_ix(
    instructions_sysvar: &AccountInfo,
    ix_index: usize,
    expected_eth_addr: &[u8; 20],
    expected_msg_hash: &[u8; 32],
) -> Result<()> {
    let ix = load_instruction_at_checked(ix_index, instructions_sysvar)
        .map_err(|_| error!(SafuError::InvalidSecp256k1Instruction))?;

    require_keys_eq!(
        ix.program_id,
        SECP256K1_PROGRAM_ID,
        SafuError::InvalidSecp256k1Instruction
    );

    let data = &ix.data;
    require!(data.len() >= 12, SafuError::InvalidSecp256k1Instruction);
    require!(data[0] >= 1, SafuError::InvalidSecp256k1Instruction);

    let eth_addr_offset = u16::from_le_bytes([data[4], data[5]]) as usize;
    let msg_offset     = u16::from_le_bytes([data[7], data[8]]) as usize;
    let msg_size       = u16::from_le_bytes([data[9], data[10]]) as usize;

    require!(
        data.len() >= eth_addr_offset.saturating_add(20),
        SafuError::InvalidSecp256k1Instruction
    );
    let eth_addr = &data[eth_addr_offset..eth_addr_offset + 20];
    require!(eth_addr == expected_eth_addr, SafuError::CosignerAddressMismatch);

    require!(msg_size == 32, SafuError::InvalidSecp256k1Instruction);
    require!(
        data.len() >= msg_offset.saturating_add(32),
        SafuError::InvalidSecp256k1Instruction
    );
    let msg_hash = &data[msg_offset..msg_offset + 32];
    require!(msg_hash == expected_msg_hash, SafuError::MessageHashMismatch);

    Ok(())
}

fn keccak256(inputs: &[&[u8]]) -> [u8; 32] {
    let mut h = Keccak::v256();
    for i in inputs { h.update(i); }
    let mut out = [0u8; 32];
    h.finalize(&mut out);
    out
}

/// Claim message hash — must match sign_claim_solana() in signer.py exactly.
/// keccak256("SAFU_SOL_CLAIM" || staker(32B) || hack_ts(8B LE) || entitlement(8B LE))
pub fn claim_message_hash(staker: &Pubkey, hack_ts: i64, entitlement: u64) -> [u8; 32] {
    keccak256(&[
        b"SAFU_SOL_CLAIM",
        staker.as_ref(),
        &hack_ts.to_le_bytes(),
        &entitlement.to_le_bytes(),
    ])
}

/// Cancel message hash — must match sign_cancel_solana() in signer.py.
pub fn cancel_message_hash(staker: &Pubkey, submitted_at: i64) -> [u8; 32] {
    keccak256(&[
        b"SAFU_SOL_CANCEL",
        staker.as_ref(),
        &submitted_at.to_le_bytes(),
    ])
}

/// Override message hash — must match sign_override_solana() in signer.py.
pub fn override_message_hash(staker: &Pubkey, entitlement: u64) -> [u8; 32] {
    keccak256(&[
        b"SAFU_SOL_OVERRIDE",
        staker.as_ref(),
        &entitlement.to_le_bytes(),
    ])
}

/// Compute tier from stake amount at claim time.
/// 12 SOL boundary: amount < TIER_B_MAX → Tier B; ≥ TIER_B_MAX → Tier A.
pub fn compute_tier(amount: u64) -> u8 {
    use crate::constants::{TIER_A, TIER_B, TIER_C, TIER_B_MAX, TIER_C_MAX};
    if amount < TIER_C_MAX {
        TIER_C
    } else if amount < TIER_B_MAX {
        TIER_B
    } else {
        TIER_A
    }
}
