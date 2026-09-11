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
//
// ⚠ getNetwork() AND signerAddress ARE OPTIONAL IN THE KIT — fixed 2026-09-11.
// Read from the kit 2.5.0 source, not assumed: xBull, Albedo, Hana, LOBSTR,
// Rabet and WalletConnect all reject getNetwork() with code -3 ("does not
// support"), and LOBSTR, Rabet and WalletConnect return no signerAddress from
// signTransaction(). This file used to REQUIRE both — Freighter's shape
// applied to every module — so from 2026-08-19 until this fix only Freighter
// could ever connect. Both guarantees still hold, enforced where they
// actually bind: _verifySignature() checks the returned signature itself
// against the connected account AND this chain's passphrase, for every wallet.
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
      // ?v= because the bundle was rebuilt 2026-09-11 (Buffer polyfill for HOT
      // Wallet) and this path is fetched by loadScript, not an index.html tag.
      window.SAFU.loadScript('js/stellar-wallets-kit.bundle.js?v=40', 'SAFUStellarWalletModules'),
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
    //
    // getNetwork() is optional (see header): code -3 means "this wallet has no
    // such function", not "wrong network". For those wallets the network is
    // enforced at signing by _verifySignature(). Any OTHER failure — a locked
    // wallet, an extension fault — is still a refusal.
    let net = null;
    let networkUnsupported = false;
    try {
      net = await mod.getNetwork();
    } catch (e) {
      if (e && e.code === -3) {
        networkUnsupported = true;
      } else {
        const err = new Error(`${label} network: ${e && e.message}`);
        err.userMessage = `Could not read ${label}'s network. Try again.`;
        throw err;
      }
    }
    if (!networkUnsupported && (!net || net.networkPassphrase !== cfg.networkPassphrase)) {
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

    return { address };
  }

  // Remembered so signTransaction() below knows which module to call —
  // wallet.js only ever holds one active connection at a time, same as the
  // EVM side. Called only AFTER the connect-timeout race resolves, never from
  // inside _connectVia(): a wallet that approves after its attempt already
  // timed out must not silently become the signing module for whatever the
  // user connected next (/cso 2026-09-11).
  function _select(mod, label) {
    window.SAFU.state._stellarModule = mod;
    window.SAFU.state._stellarWalletLabel = label;
  }

  // The authoritative signing check, run for EVERY wallet. The returned
  // envelope must carry a valid ed25519 signature from the connected account
  // over this transaction's hash — and that hash is domain-separated by this
  // chain's network passphrase. So one check proves both WHO signed and FOR
  // WHICH NETWORK, from the signature bytes rather than from what a wallet
  // reports about itself. It is what lets wallets without getNetwork() or
  // signerAddress connect without relaxing either guarantee.
  function _verifySignature(signedXdr, cfg, address, label) {
    const Sdk = window.StellarSdk;
    const want = cfg.networkLabel || `${cfg.label} mainnet`;
    let tx;
    try {
      tx = Sdk.TransactionBuilder.fromXDR(signedXdr, cfg.networkPassphrase);
    } catch (e) {
      const err = new Error(`${label} returned an unreadable transaction: ${e.message}`);
      err.userMessage = `${label} returned a transaction SAFU could not read.`;
      throw err;
    }
    const kp = Sdk.Keypair.fromPublicKey(address);
    const hash = tx.hash();
    const valid = (tx.signatures || []).some(sig => {
      try { return kp.verify(hash, sig.signature()); } catch { return false; }
    });
    if (!valid) {
      const err = new Error(`${label} signature does not verify for ${address} on ${cfg.networkPassphrase}`);
      err.userMessage =
        `${label}'s signature is not from ${address.slice(0, 6)}… on ${want}. ` +
        `Check the wallet is on ${want} and on the connected account, then retry.`;
      throw err;
    }
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
    if (!S.walletAddress) {
      throw new Error('SAFU: no connected Stellar account to sign for — connect first');
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
    // A reported signerAddress gets the fast, clearly-worded check below. It is
    // NOT the guarantee any more: the pre-2026-09-11 version required one and
    // so refused LOBSTR, Rabet and WalletConnect outright — they never report
    // it. The guarantee is _verifySignature(), which does not fail open when
    // signerAddress is absent: it proves the signer from the signature bytes.
    if (res.signerAddress && res.signerAddress !== S.walletAddress) {
      const err = new Error(`${label} signed with a different account`);
      err.userMessage =
        `${label} signed with ${res.signerAddress.slice(0, 6)}…, not the connected account. ` +
        `Switch back and retry.`;
      throw err;
    }
    _verifySignature(res.signedTxXdr, cfg, S.walletAddress, label);
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
  //
  // ONE instance per page, never rebuilt. The kit's constructor fires
  // SignClient.init() without awaiting it, and a second construction re-runs
  // it ("WalletConnect Core is already initialized ... Init() was called 2
  // times" — observed live 2026-09-11, because the pre-fix failure path
  // dropped and rebuilt the instance on every retry).
  let _wcModule = null;
  let _wcPassphrase = null;
  const WC_READY_TIMEOUT_MS = 20000;

  // The module is usable only once its async SignClient.init() resolves —
  // until then isAvailable() is false and getAddress() throws "WalletConnect
  // modules has not been started yet." The pre-fix code called getAddress()
  // straight after construction, so EVERY first click failed that check.
  // Wait on the kit's own readiness signal instead of guessing a delay.
  async function _wcWhenReady() {
    const deadline = Date.now() + WC_READY_TIMEOUT_MS;
    while (!(await _wcModule.isAvailable())) {
      if (Date.now() > deadline) {
        const err = new Error('WalletConnect SignClient never initialised');
        err.userMessage = 'WalletConnect could not start. Check your connection and try again.';
        throw err;
      }
      await new Promise(r => setTimeout(r, 150));
    }
  }

  function _wcCloseModal() {
    try { if (_wcModule && _wcModule.modal) _wcModule.modal.close(); } catch (_) {}
  }

  async function _connectWC() {
    const cfg = chainCfg();
    if (_wcModule && _wcPassphrase !== cfg.networkPassphrase) {
      // allowedChains is fixed at construction and the instance cannot be
      // rebuilt (see above) — refuse rather than pair on the wrong network.
      const err = new Error('WalletConnect instance is scoped to a different Stellar network');
      err.userMessage = 'Reload the page to use WalletConnect on this network.';
      throw err;
    }
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
      _wcPassphrase = cfg.networkPassphrase;
    }
    await _wcWhenReady();
    try {
      return await _connectVia(_wcModule, 'WalletConnect');
    } catch (err) {
      // Never leave the QR modal stranded over the page after a failure. The
      // instance is kept (see _wcModule); the next attempt pairs fresh anyway.
      _wcCloseModal();
      throw err;
    }
  }

  // One bound on EVERY connect, not only WalletConnect. HOT Wallet's relay
  // poll (@hot-wallet/sdk hot.js) retries every 3 s with no limit at all, a
  // WalletConnect pairing nobody scans never settles, and a web-wallet popup
  // the user closes may never settle either \u2014 each used to leave "Connecting"
  // spinning until a reload. Long enough for a real scan-and-approve on a
  // phone, short enough that a dead attempt does not strand the UI.
  const CONNECT_TIMEOUT_MS = 120000;

  function _withTimeout(promise, label, onTimeout) {
    let timer;
    const limit = new Promise((_, reject) => {
      timer = setTimeout(() => {
        if (onTimeout) onTimeout();
        const err = new Error(`${label} connect timed out`);
        err.userMessage = `${label} did not finish connecting within 2 minutes. Try again.`;
        reject(err);
      }, CONNECT_TIMEOUT_MS);
    });
    return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
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
          // _connectVia() is CALLED synchronously inside the click, so a wallet
          // that opens a popup (xBull, Albedo) still does it within the user
          // gesture and is not popup-blocked. Only the wait is bounded.
          connect: () => _withTimeout(_connectVia(mod, mod.productName), mod.productName)
            .then(r => { _select(mod, mod.productName); return r; }),
        }));

      // Always offered — unlike the extension modules there is nothing to
      // detect, and it is the only path for a user with no Stellar extension
      // installed at all (which is what emptyHint used to dead-end on).
      out.push({
        name:    'WalletConnect',
        tag:     'LOBSTR · HOT · mobile',
        connect: () => _withTimeout(_connectWC(), 'WalletConnect', _wcCloseModal)
          .then(r => { _select(_wcModule, 'WalletConnect'); return r; }),
        // No reopenOnError flag: wallet.js now puts the picker back, with the
        // reason shown in it, after ANY failed connect.
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
      // mod.disconnect() above ends it. The instance itself is KEPT: rebuilding
      // it re-runs SignClient.init() (see _wcModule), and the next connect
      // negotiates a fresh pairing through signClient.connect() regardless.
      window.SAFU.state._stellarModule = null;
      window.SAFU.state._stellarWalletLabel = null;
    },
  };
})();
