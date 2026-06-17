// ─── SAFU CONFIG ──────────────────────────────────────────────────────────────
// WALLETCONNECT_PROJECT_ID is intentionally public — WalletConnect requires it
// in client-side code. Security gate: domain allowlist MUST be enabled in
// WalletConnect Cloud (cloud.walletconnect.com) to prevent use on other domains.
window.CONFIG = {
  CONTRACT_ADDRESS:         '0x8ff7518ff9352F4a81d6914E8A08A47085042896',
  SAFU_API_BASE:            'https://safustaking.com/api',
  RPC_URL:                  'https://safustaking.com/api/v1/rpc',
  WALLETCONNECT_PROJECT_ID: '3824772bb6c01d55a924dac308a3cb3e',
  STAKE_TIER_A_ETH:         '0.25',
  STAKE_TIER_B_ETH:         '0.50',
  STAKE_TIER_C_ETH:         '0.75',
  CHAIN_ID:                 1,
};
