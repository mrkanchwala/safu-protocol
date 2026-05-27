// Shared mutable state — read/write via SAFU.state across all modules
window.SAFU = window.SAFU || {};
window.SAFU.state = {
  provider:      null,
  signer:        null,
  contract:      null,
  walletAddress: null,
  enrollData:    null,   // oracle approval payload from /v1/enroll
  wcProvider:    null,   // WalletConnect provider (for disconnect)
};
