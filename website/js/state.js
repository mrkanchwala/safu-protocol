// Shared mutable state — read/write via SAFU.state across all modules
window.SAFU = window.SAFU || {};
window.SAFU.state = {
  // Which chain every chain-scoped read resolves against. Set via
  // SAFU.setChain(), never assigned directly — switching chains has to clear
  // the connection and form state that belonged to the previous one.
  activeChain:   null,   // null → CONFIG.DEFAULT_CHAIN

  // Which family the CURRENT connection belongs to. Needed because disconnect
  // must tear down the connector that actually connected, which is not
  // necessarily the active chain's connector if the chain was switched.
  connectedFamily: null,

  provider:      null,
  signer:        null,
  // EVM-only (an ethers.Contract). Stellar builds each invocation instead, so
  // this stays null there — never use it as "is a wallet connected".
  contract:      null,
  walletAddress: null,
  enrollData:    null,   // oracle approval payload from /v1/enroll
  wcProvider:    null,   // WalletConnect provider (for disconnect)

  // Contract-sourced stake bounds, populated by init.loadStakeBounds() on load.
  // Null until that read completes; consumers fall back to the active chain's
  // stakeMinFallback / stakeMaxFallback.
  stakeMin:      null,
  stakeMax:      null,
};
