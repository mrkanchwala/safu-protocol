// ─── SAFU CONFIG ──────────────────────────────────────────────────────────────
// WALLETCONNECT_PROJECT_ID is intentionally public — WalletConnect requires it
// in client-side code. Security gate: domain allowlist MUST be enabled in
// WalletConnect Cloud (cloud.walletconnect.com) to prevent use on other domains.
window.CONFIG = {
  CONTRACT_ADDRESS:         '0xa170f0937DEc353C1806eaC0c3d559524d458641',
  SAFU_API_BASE:            'https://safustaking.com/api',
  RPC_URL:                  'https://safustaking.com/api/v1/rpc',
  WALLETCONNECT_PROJECT_ID: '3824772bb6c01d55a924dac308a3cb3e',
  STAKE_MIN_ETH:            '0.01',
  STAKE_MAX_ETH:            '0.75',
  CHAIN_ID:                 1,
};
