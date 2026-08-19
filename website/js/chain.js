// Active-chain resolution and adapter construction.
//
// Every chain-specific read in the app goes through SAFU.chain() or
// SAFU.adapter(), so adding a chain is a CONFIG.CHAINS entry rather than a hunt
// for flat CONFIG.<KEY> call sites. Loaded after config.js and the adapter
// files, before any module that consumes them.
window.SAFU = window.SAFU || {};

(() => {
  const cache = new Map();

  // Active chain's raw config.
  window.SAFU.chain = function () {
    const state = window.SAFU.state;
    const id = (state && state.activeChain) || CONFIG.DEFAULT_CHAIN;
    return CONFIG.CHAINS[id] || CONFIG.CHAINS[CONFIG.DEFAULT_CHAIN];
  };

  // Adapter for the active chain, or for an explicitly named one.
  //
  // Keyed on `family`, not `id`, so a second EVM chain (Base, Arbitrum) is a
  // config entry with family:'evm' and needs no new adapter code at all.
  window.SAFU.adapter = function (chainId) {
    const cfg = chainId
      ? (CONFIG.CHAINS[chainId] || CONFIG.CHAINS[CONFIG.DEFAULT_CHAIN])
      : window.SAFU.chain();

    if (cache.has(cfg.id)) return cache.get(cfg.id);

    const factory = window.SAFU.adapters[cfg.family];
    if (!factory) {
      throw new Error(`SAFU: no adapter registered for chain family "${cfg.family}" (chain ${cfg.id})`);
    }

    const adapter = factory(cfg);
    cache.set(cfg.id, adapter);
    return adapter;
  };

  // Switching chains is an explicit state transition, not a display toggle.
  // The connection, the contract handle and any in-progress form values all
  // belong to the previous chain, so they are cleared rather than carried
  // across. Cheaper and safer than trying to preserve a session per chain.
  window.SAFU.setChain = function (chainId) {
    if (!CONFIG.CHAINS[chainId]) return false;
    const S = window.SAFU.state;
    if (S.activeChain === chainId) return true;

    if (S.walletAddress && window.SAFU.wallet) {
      window.SAFU.wallet.disconnect();
    }
    S.activeChain  = chainId;
    S.stakeMin     = null;
    S.stakeMax     = null;
    S._stakeAmount = null;
    // A pending claim scan belongs to the chain it was scanned on. Without
    // this, an Ethereum tx hash scanned pre-switch survived into
    // confirm-claim-section while claimUrl() had already moved on to the new
    // chain's endpoint — a claim confirm button pointed at the wrong chain.
    S._pendingClaimTx    = null;
    S._pendingClaimScore = null;
    return true;
  };
})();
