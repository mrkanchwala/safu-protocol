// Stellar wallet connector — multi-wallet via Stellar Wallets Kit.
//
// 2026-08-19: swapped from a hand-rolled Freighter-only connector to a small
// vendored bundle of 7 of the kit's own wallet modules — Freighter, xBull,
// Albedo, Rabet, Lobstr, Hana, Hot Wallet. Each module implements the same
// uniform interface (isAvailable/getAddress/signTransaction/getNetwork), so
// this file no longer hand-writes wallet-specific quirks — it applies ONE set
// of safety checks (network-passphrase match, address validation,
// signer-account match) generically across whichever module the user picks,
// same checks the old Freighter-only version had, now shared.
//
// The kit's own WalletConnect module is DELIBERATELY excluded — it pulls in
// @reown/appkit, the exact bundle-bloat problem the EVM WalletConnect bundle
// was rebuilt at 2.19.2 to avoid (see wc-provider.bundle.js). Stellar
// WalletConnect support is a separate, later decision, not silently dropped.
// The kit's own UI widget (`createButton`/`authModal`, built on Preact +
// Twind) is also skipped entirely — this site wires the kit's SDK-only
// modules into its OWN existing `.wallet-option` modal, not the kit's UI.
//
// Vendored build: `docs/vendored-js.md` has the exact esbuild command, source
// package version, and SHA256. Built from 7 explicit module imports so
// tree-shaking excludes Ledger/Trezor/Klever/OneKey/Bitget/WalletConnect/
// AppKit entirely — verified empty via grep on the built bundle, not assumed.
//
// ⚠ isAvailable() TIMING IS NOT UNIFORM ACROSS MODULES. Live-tested with no
// extensions installed (2026-08-19): Freighter and Lobstr hang past the
// kit's own documented 1000ms contract; xBull and Albedo correctly resolve
// `true` even with nothing installed, because both have a web-based/PWA path
// that needs no extension at all — that is real availability, not a bug.
// `_isAvailable()` below wraps every check in a 1200ms race so a slow module
// cannot stall the whole wallet list.
window.SAFU = window.SAFU || {};
window.SAFU.connectors = window.SAFU.connectors || {};

window.SAFU.connectors.stellar = (() => {

  // The active chain MUST belong to this connector's family. wallet.js only
  // ever resolves a connector by the active chain's family, so this holds in
  // the app — but asserting it turns a silent misuse into a clear error.
  function chainCfg() {
    const cfg = window.SAFU.chain();
    if (cfg.family !== 'stellar') {
      throw new Error(
        `SAFU: the Stellar connector was used while "${cfg.id}" (family ${cfg.family}) is active`
      );
    }
    return cfg;
  }

  function modules() {
    if (!window.SAFUStellarWalletModules) {
      throw new Error('SAFU: stellar-wallets-kit not loaded — call ensureDeps() first');
    }
    return window.SAFUStellarWalletModules.modules;
  }

  // Loads BOTH the wallet-kit bundle and the Stellar SDK. Same reasoning as
  // the prior Freighter-only version: a caller reaching this connector
  // without the SDK having been loaded by an earlier stat-read would hit
  // "Stellar SDK not loaded" deep inside signing instead of here.
  function ensureDeps() {
    return Promise.all([
      window.SAFU.loadScript('js/stellar-wallets-kit.bundle.js', 'SAFUStellarWalletModules'),
      window.SAFU.adapter().ensureSdk(),
    ]);
  }

  async function _isAvailable(mod) {
    try {
      return await Promise.race([
        mod.isAvailable(),
        new Promise(resolve => setTimeout(() => resolve(false), 1200)),
      ]);
    } catch {
      return false;
    }
  }

  async function _connectVia(mod, label) {
    const cfg = chainCfg();

    let address;
    try {
      const res = await mod.getAddress();
      address = res && res.address;
    } catch (e) {
      const err = new Error(`${label} access: ${e.message}`);
      err.userMessage = e.message || `${label} did not grant access.`;
      throw err;
    }
    if (!address) {
      const err = new Error(`${label} returned no address — access was not granted.`);
      err.userMessage = `${label} did not grant access. Approve the connection and try again.`;
      throw err;
    }

    // Network is checked by PASSPHRASE, not by the human-readable name.
    // The name ("TESTNET") is a label; the passphrase is what every signature is
    // domain-separated by, so a mismatch here means a signature that is invalid
    // on the network the contract actually lives on.
    let net;
    try {
      net = await mod.getNetwork();
    } catch (e) {
      const err = new Error(`${label} network: ${e.message}`);
      err.userMessage = `Could not read ${label}'s network. Try again.`;
      throw err;
    }
    if (!net || net.networkPassphrase !== cfg.networkPassphrase) {
      const want = cfg.networkLabel || cfg.label;
      const err = new Error(`${label} is on ${(net && net.network) || 'an unknown network'}`);
      err.userMessage =
        `${label} is on ${(net && net.network) || 'an unknown network'} — switch it to ${want} and reconnect.`;
      throw err;
    }

    // Address is validated through the adapter rather than trusted: a malformed
    // strkey would otherwise reach hashBeneficiary and produce a hash the
    // contract silently rejects.
    const a = window.SAFU.adapter();
    if (!a.isValidAddress(address)) {
      const err = new Error(`${label} returned an address this chain does not accept: ${address}`);
      err.userMessage = `${label} returned an address SAFU could not validate.`;
      throw err;
    }

    // Remembered so signTransaction() below knows which module to call —
    // wallet.js only ever holds one active connection at a time, same as the
    // EVM side.
    window.SAFU.state._stellarModule = mod;
    window.SAFU.state._stellarWalletLabel = label;
    return { address };
  }

  // Used by the Stellar adapter's write path. Kept here rather than in the
  // adapter because signing is a WALLET capability, not a chain one — a
  // different Stellar wallet module swaps this out and leaves the adapter
  // untouched.
  async function signTransaction(xdr) {
    const cfg = chainCfg();
    const S = window.SAFU.state;
    const mod = S._stellarModule;
    const label = S._stellarWalletLabel || 'Stellar wallet';
    if (!mod) {
      throw new Error('SAFU: no Stellar wallet module selected — connect first');
    }

    let res;
    try {
      res = await mod.signTransaction(xdr, {
        address:           S.walletAddress,
        networkPassphrase: cfg.networkPassphrase,
      });
    } catch (e) {
      const err = new Error(`${label} signing: ${e.message}`);
      err.userMessage = e.message || 'Signing was cancelled or failed.';
      throw err;
    }
    if (!res || !res.signedTxXdr) {
      const err = new Error(`${label} returned no signed transaction`);
      err.userMessage = 'Signing was cancelled or failed.';
      throw err;
    }
    // Guards a real hazard: the user can switch accounts in the wallet
    // between connect and sign. The contract requires auth from the STAKER, so a
    // signature from a different account fails on-chain after the user has
    // already paid attention to a prompt.
    //
    // signerAddress is REQUIRED, not optionally checked — checking it only
    // when present fails OPEN: an absent signerAddress would silently skip
    // the account-match check entirely rather than being treated as "cannot
    // verify who signed."
    if (!res.signerAddress) {
      const err = new Error(`${label} did not report which account signed`);
      err.userMessage = 'Could not verify which account signed. Reconnect and try again.';
      throw err;
    }
    if (S.walletAddress && res.signerAddress !== S.walletAddress) {
      const err = new Error(`${label} signed with a different account`);
      err.userMessage =
        `${label} signed with ${res.signerAddress.slice(0, 6)}…, not the connected account. ` +
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
      const mods = modules();
      const checks = await Promise.all(
        Object.values(mods).map(async mod => ({ mod, ok: await _isAvailable(mod) }))
      );
      return checks
        .filter(c => c.ok)
        .map(({ mod }) => ({
          name:    mod.productName,
          tag:     'extension',
          connect: () => _connectVia(mod, mod.productName),
        }));
    },

    emptyHint: 'No Stellar wallet detected. Install Freighter, xBull, or another supported wallet, then reopen this dialog.',

    disconnect() {
      // Most of these wallets have no programmatic disconnect — access is a
      // standing per-origin permission the USER controls in the wallet. Try
      // the module's own disconnect() if it has one (optional per the kit's
      // interface); either way, clear SAFU's own session state.
      const mod = window.SAFU.state._stellarModule;
      if (mod && typeof mod.disconnect === 'function') {
        Promise.resolve(mod.disconnect()).catch(() => {});
      }
      window.SAFU.state._stellarModule = null;
      window.SAFU.state._stellarWalletLabel = null;
    },
  };
})();
