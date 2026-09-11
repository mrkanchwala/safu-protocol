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

  // ── WalletConnect (added 2026-09-11) ───────────────────────────────────
  // Kept OUT of stellar-wallets-kit.bundle.js on purpose. The kit's
  // wallet-connect module pulls @reown/appkit, which takes the shared bundle
  // from 440 KB to 2.5 MB — measured, not estimated. Shipping that to every
  // visitor to cover one wallet option is the wrong trade, so it lives in its
  // own 2.1 MB bundle that is fetched ONLY when a user actually picks
  // WalletConnect. Same on-demand pattern connector-evm.js:138 already uses
  // for wc-provider.bundle.js.
  //
  // The kit's module does REAL Stellar signing, not just pairing — verified
  // against the built bundle in Chromium: CAIP chains `stellar:pubnet` /
  // `stellar:testnet`, methods `stellar_signXDR` / `stellar_signAndSubmitXDR`
  // / `stellar_signMessage` / `stellar_signAuthEntry`, and the same
  // ModuleInterface every other module here implements — so it flows through
  // _connectVia() and signTransaction() with no special-casing.
  let _wcModule = null;

  // Long enough for a real scan-and-approve on a phone, short enough
  // that a dead pairing does not strand the UI.
  const WC_CONNECT_TIMEOUT_MS = 120000;

  async function _connectWC() {
    const cfg = chainCfg();
    if (!_wcModule) {
      const { WalletConnectModule, WalletConnectTargetChain } =
        await import('/js/stellar-wc.bundle.js');
      _wcModule = new WalletConnectModule({
        projectId: CONFIG.WALLETCONNECT_PROJECT_ID,
        metadata: {
          name:        'SAFU',
          description: 'Stake into a SAFU pool and get covered.',
          url:         'https://safustaking.com',
          icons:       ['https://safustaking.com/favicon.svg'],
        },
        // Scoped to the chain actually selected — never both. A session
        // negotiated for pubnet must not be reused to sign on testnet.
        allowedChains: [
          String(cfg.networkPassphrase || '').startsWith('Public')
            ? WalletConnectTargetChain.PUBLIC
            : WalletConnectTargetChain.TESTNET,
        ],
      });
    }
    // WalletConnect is the only option here that can hang with no error to
    // show for it. The kit settles its promise on pairing, so a user who
    // never scans, or dismisses the prompt on their phone, leaves it pending
    // forever and the caller's "Connecting" spinner spins until a reload.
    // Bound it, and tear the module down on the way out so a retry pairs
    // fresh rather than reusing a session that was never established.
    let timer;
    try {
      return await Promise.race([
        _connectVia(_wcModule, 'WalletConnect'),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(
              'WalletConnect timed out. No wallet approved the pairing \u2014 try again.'
            )),
            WC_CONNECT_TIMEOUT_MS
          );
        }),
      ]);
    } catch (err) {
      try { if (_wcModule && _wcModule.disconnect) _wcModule.disconnect(); } catch (_) {}
      _wcModule = null;
      throw err;
    } finally {
      clearTimeout(timer);
    }
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
      const out = checks
        .filter(c => c.ok)
        .map(({ mod }) => ({
          name:    mod.productName,
          tag:     'extension',
          connect: () => _connectVia(mod, mod.productName),
        }));

      // Always offered — unlike the extension modules there is nothing to
      // detect, and it is the only path for a user with no Stellar extension
      // installed at all (which is what emptyHint used to dead-end on).
      out.push({
        name:    'WalletConnect',
        tag:     'LOBSTR · HOT · mobile',
        connect: _connectWC,
        // The user is mid-flow in WalletConnect's own overlay when this runs,
        // so a failure should put the picker back rather than leave them on a
        // bare page — same reasoning as connector-evm.js's WC entry.
        reopenOnError: true,
      });

      return out;
    },

    emptyHint: 'No Stellar wallet detected. Install Freighter, xBull, or another supported wallet — or use WalletConnect to pair a mobile wallet.',

    disconnect() {
      // Most of these wallets have no programmatic disconnect — access is a
      // standing per-origin permission the USER controls in the wallet. Try
      // the module's own disconnect() if it has one (optional per the kit's
      // interface); either way, clear SAFU's own session state.
      const mod = window.SAFU.state._stellarModule;
      if (mod && typeof mod.disconnect === 'function') {
        Promise.resolve(mod.disconnect()).catch(() => {});
      }
      // WalletConnect is the one module here with a REAL session to end, and
      // the cached instance holds it. Dropping the reference forces a fresh
      // pairing next time instead of silently reusing a session the user just
      // asked to end — the bundle itself stays cached by the browser, so this
      // costs a re-init, not a re-download.
      _wcModule = null;
      window.SAFU.state._stellarModule = null;
      window.SAFU.state._stellarWalletLabel = null;
    },
  };
})();
