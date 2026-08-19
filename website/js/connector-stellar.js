// Stellar wallet connector — Freighter.
//
// Official SDF wallet API (`@stellar/freighter-api` 6.0.1, vendored). The
// third-party Stellar Wallets Kit was rejected in 2c's prerequisite work: it is
// what would have required the bundler step the official packages avoid, and
// SCF #44's D3 text names "Freighter / Stellar Wallets Kit", so official-only
// satisfies the deliverable. Revisit only if multi-wallet breadth is required.
//
// ⚠ EVERY freighter-api CALL RETURNS ITS ERROR, IT DOES NOT THROW.
// The shape is `{ ...value, error }` — e.g. requestAccess() resolves to
// `{ address: '', error: {code, message} }` when the user rejects. Verified by
// reading the vendored bundle 2026-08-19. A connector that only used try/catch
// would treat a rejected permission prompt as a SUCCESSFUL connect with an
// empty address, which is the same silent-degradation class as the scanner's
// `except → return None`. Hence an explicit `_unwrap` on every call.
window.SAFU = window.SAFU || {};
window.SAFU.connectors = window.SAFU.connectors || {};

window.SAFU.connectors.stellar = (() => {

  // The active chain MUST belong to this connector's family. wallet.js only
  // ever resolves a connector by the active chain's family, so this holds in
  // the app — but asserting it turns a silent misuse into a clear error.
  // Without it, a caller reaching this connector while an EVM chain is active
  // would compare Freighter's passphrase against `undefined` and be told
  // "Freighter is on TESTNET" — a wrong-but-plausible message pointing at the
  // wallet when the fault is in the caller.
  function chainCfg() {
    const cfg = window.SAFU.chain();
    if (cfg.family !== 'stellar') {
      throw new Error(
        `SAFU: the Stellar connector was used while "${cfg.id}" (family ${cfg.family}) is active`
      );
    }
    return cfg;
  }

  function api() {
    if (!window.freighterApi) {
      throw new Error('SAFU: freighter-api not loaded — call ensureDeps() first');
    }
    return window.freighterApi;
  }

  // Turns freighter's returned-error convention into a real throw, so callers
  // cannot accidentally proceed on a failed call.
  function _unwrap(res, what) {
    if (!res || res.error) {
      const msg = res?.error?.message || 'no response from Freighter';
      const err = new Error(`${what}: ${msg}`);
      err.userMessage = msg;
      throw err;
    }
    return res;
  }

  // Loads BOTH freighter-api.min.js and the Stellar SDK. Before this fix only
  // the wallet script was loaded here — the SDK happened to already be
  // present by the time a user reached connect(), but only because
  // wallet.js's chain-switch handler calls loadStakerCount()/loadStakeBounds()
  // first, and those adapter reads call ensureSdk() as a side effect. A
  // caller reaching this connector without that stat-read having run first
  // (or won the race) would hit "Stellar SDK not loaded" deep inside signing.
  function ensureDeps() {
    return Promise.all([
      window.SAFU.loadScript('js/freighter-api.min.js', 'freighterApi'),
      window.SAFU.adapter().ensureSdk(),
    ]);
  }

  async function _isInstalled() {
    // window.freighter is the extension's own presence flag and is the fast
    // path inside isConnected(); checking it first avoids a 2s internal timeout
    // when the extension simply is not there.
    if (window.freighter) return true;
    try {
      const res = await api().isConnected();
      return Boolean(res && res.isConnected);
    } catch {
      return false;
    }
  }

  async function _connect() {
    const cfg = chainCfg();

    // requestAccess() prompts on first use and resolves immediately afterwards.
    const { address } = _unwrap(await api().requestAccess(), 'Freighter access');
    if (!address) {
      const err = new Error('Freighter returned no address — access was not granted.');
      err.userMessage = 'Freighter did not grant access. Approve the connection and try again.';
      throw err;
    }

    // Network is checked by PASSPHRASE, not by the human-readable name.
    // The name ("TESTNET") is a label; the passphrase is what every signature is
    // domain-separated by, so a mismatch here means a signature that is invalid
    // on the network the contract actually lives on.
    const net = _unwrap(await api().getNetwork(), 'Freighter network');
    if (net.networkPassphrase !== cfg.networkPassphrase) {
      const want = cfg.networkLabel || cfg.label;
      const err = new Error(`Freighter is on ${net.network || 'an unknown network'}`);
      err.userMessage =
        `Freighter is on ${net.network || 'an unknown network'} — switch it to ${want} and reconnect.`;
      throw err;
    }

    // Address is validated through the adapter rather than trusted: a malformed
    // strkey would otherwise reach hashBeneficiary and produce a hash the
    // contract silently rejects.
    const a = window.SAFU.adapter();
    if (!a.isValidAddress(address)) {
      const err = new Error(`Freighter returned an address this chain does not accept: ${address}`);
      err.userMessage = 'Freighter returned an address SAFU could not validate.';
      throw err;
    }

    return { address };
  }

  // Used by the Stellar adapter's write path. Kept here rather than in the
  // adapter because signing is a WALLET capability, not a chain one — a second
  // Stellar wallet would swap this out and leave the adapter untouched.
  async function signTransaction(xdr) {
    const cfg = chainCfg();
    const S = window.SAFU.state;
    const res = _unwrap(
      await api().signTransaction(xdr, {
        address:           S.walletAddress,
        networkPassphrase: cfg.networkPassphrase,
      }),
      'Freighter signing'
    );
    if (!res.signedTxXdr) {
      const err = new Error('Freighter returned no signed transaction');
      err.userMessage = 'Signing was cancelled or failed in Freighter.';
      throw err;
    }
    // Guards a real hazard: the user can switch accounts in the extension
    // between connect and sign. The contract requires auth from the STAKER, so a
    // signature from a different account fails on-chain after the user has
    // already paid attention to a prompt.
    //
    // signerAddress is REQUIRED, not optionally checked — an earlier version
    // only compared it when present, which fails OPEN: an absent
    // signerAddress silently skipped the account-match check entirely rather
    // than being treated as "cannot verify who signed."
    if (!res.signerAddress) {
      const err = new Error('Freighter did not report which account signed');
      err.userMessage = 'Could not verify which account signed. Reconnect and try again.';
      throw err;
    }
    if (S.walletAddress && res.signerAddress !== S.walletAddress) {
      const err = new Error('Freighter signed with a different account');
      err.userMessage =
        `Freighter signed with ${res.signerAddress.slice(0, 6)}…, not the connected account. ` +
        `Switch back and retry.`;
      throw err;
    }
    return res.signedTxXdr;
  }

  return {
    family: 'stellar',
    ensureDeps,
    signTransaction,

    async options() {
      if (!(await _isInstalled())) return [];
      return [{ name: 'Freighter', tag: 'extension', connect: _connect }];
    },

    emptyHint: 'Freighter not detected. Install it from freighter.app, then reopen this dialog.',

    // Freighter has no programmatic disconnect — access is a standing
    // per-origin permission the USER controls in the extension. So this clears
    // SAFU's session only. Saying otherwise in the UI would be a false claim
    // about a permission this page cannot revoke.
    disconnect() { /* no wallet-side session to tear down */ },
  };
})();
