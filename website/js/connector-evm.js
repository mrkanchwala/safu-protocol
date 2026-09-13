// EVM wallet connector — EIP-6963 browser extensions + legacy window.ethereum
// + WalletConnect.
//
// Extracted from wallet.js in Phase 2c. wallet.js had one hardcoded connection
// model, so a second chain family had nowhere to go: `ethers.BrowserProvider`,
// `wallet_switchEthereumChain` and `eth_requestAccounts` are all EVM-only, and
// Stellar shares none of them. wallet.js now owns the modal and the shared
// state; each family owns how it actually connects.
//
// Behaviour on the live ETH path is deliberately unchanged from before the
// extraction — same permission dance, same 4001 handling, same network-switch
// text. The WalletConnect QR modal itself was swapped 2026-09-13 (see
// _wcModal below and docs/vendored-js.md) — same @reown/appkit UI
// connector-stellar.js already uses, not the old hand-rolled QR box.
window.SAFU = window.SAFU || {};
window.SAFU.connectors = window.SAFU.connectors || {};

window.SAFU.connectors.evm = (() => {
  const S = window.SAFU.state;

  // EIP-6963 discovery must be listening before wallets announce, so this runs
  // at load rather than when the modal opens.
  const discovered = [];
  window.addEventListener('eip6963:announceProvider', e => {
    discovered.push(e.detail);
    if (window.SAFU.wallet && document.getElementById('wallet-list')) {
      window.SAFU.wallet.refresh();
    }
  });
  window.dispatchEvent(new Event('eip6963:requestProvider'));

  // ── QR modal (WalletConnect only) ──────────────────────────────────────
  // 2026-09-13: swapped the hand-rolled QR box for @reown/appkit's own modal
  // (same UI Stellar's WalletConnect flow already uses — see
  // connector-stellar.js and docs/vendored-js.md). ONE instance per page,
  // never rebuilt — matches the lesson learned there: a second createAppKit()
  // call is wasted work at best and a stale-instance bug at worst.
  let _appKitModal = null;

  function _wcCloseModal() {
    try { if (_appKitModal) _appKitModal.close(); } catch (_) {}
  }

  function _wcModal(createAppKit, mainnet) {
    if (!_appKitModal) {
      _appKitModal = createAppKit({
        projectId: CONFIG.WALLETCONNECT_PROJECT_ID,
        manualWCControl: true,
        enableReconnect: true,
        networks: [mainnet],
        metadata: {
          name:        'SAFU',
          description: 'Stake into a SAFU pool and get covered.',
          url:         'https://safustaking.com',
          icons:       ['https://safustaking.com/favicon.svg'],
        },
      });
    }
    return _appKitModal;
  }

  // ── shared finalisation ────────────────────────────────────────────────
  // Returns the normalised connection wallet.js stores. Throws with a
  // `.userMessage` when the failure is something the user can act on.
  async function _finalize(p) {
    const cfg = window.SAFU.chain();
    const network = await p.getNetwork();

    if (Number(network.chainId) !== cfg.chainId) {
      try {
        // chainIdHex comes from config rather than a hardcoded '0x1', which was
        // the literal here before 2026-08-19 and would silently target mainnet
        // no matter which chain was selected.
        await p.send('wallet_switchEthereumChain', [{ chainId: cfg.chainIdHex }]);
        const switched = await p.getNetwork();
        if (Number(switched.chainId) !== cfg.chainId) throw new Error('switch failed');
      } catch (e) {
        const err = new Error(`Wrong network — switch to ${cfg.label}.`);
        err.userMessage = `Wrong network — switch to ${cfg.label}.`;
        throw err;
      }
    }

    const signer = await p.getSigner();
    return {
      address:  await signer.getAddress(),
      provider: p,
      signer,
      contract: window.SAFU.adapter().signerContract(signer),
    };
  }

  async function _requestAccounts(p) {
    try {
      await p.send('wallet_requestPermissions', [{ eth_accounts: {} }]);
    } catch (pe) {
      if (pe.code === 4001) throw pe;
      await p.send('eth_requestAccounts', []);
    }
  }

  async function _connectInjected(provider) {
    const p = new ethers.BrowserProvider(provider);
    await _requestAccounts(p);
    return _finalize(p);
  }

  // ONE EthereumProvider per page, cached like connector-stellar.js's
  // _wcModule — NOT reconstructed on every click. Calling EthereumProvider.
  // init() twice registers a second Core under the same
  // `_walletConnectCore_safu-evm` global key ("Init() was called 2 times"),
  // the identical bug class Stellar hit before caching its module 2026-09-11.
  // Every configured EVM chain is the same one (Ethereum mainnet — SAFUPoolV8
  // has no other deployment), so unlike Stellar's cache there is no
  // network-mismatch case to guard against on reuse.
  let _wcProvider = null;

  // Bounds the whole connect attempt, not just the pairing wait. Without
  // this a WalletConnect URI nobody scans (or a pairing the user never
  // approves) leaves wallet.js's picker showing "Connecting…" indefinitely —
  // the same failure Stellar's WC path had until its own 120s timeout landed
  // 2026-09-11 (founder report: "some dots appear and doesn't go away").
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

  async function _connectWC() {
    const cfg = window.SAFU.chain();
    const { EthereumProvider, createAppKit, mainnet } = await import('/js/wc-provider.bundle.js');
    const modal = _wcModal(createAppKit, mainnet);

    if (!_wcProvider) {
      _wcProvider = await EthereumProvider.init({
        projectId:   CONFIG.WALLETCONNECT_PROJECT_ID,
        chains:      [cfg.chainId],
        showQrModal: false,
        rpcMap:      { [cfg.chainId]: cfg.rpcUrl },
        metadata: {
          name:        'SAFU',
          description: 'Stake into a SAFU pool and get covered.',
          url:         'https://safustaking.com',
          icons:       ['https://safustaking.com/favicon.svg'],
        },
        // Own Core, own storage — same fix connector-stellar.js already
        // shipped (2026-09-11) for the identical collision: both bundles
        // otherwise park their Core on the same global
        // (`_walletConnectCore_<prefix>`), so whichever chain's WC a
        // visitor tries first silently becomes the Core the other chain
        // reuses. Verified against the type chain (not assumed):
        // EthereumProviderOptions -> UniversalProviderOpts ->
        // SignClientTypes.Options -> CoreTypes.Options, which is where
        // customStoragePrefix is actually declared — NOT under a
        // signClientOptions sub-object, which is the Stellar kit's own
        // different class and does not apply here.
        customStoragePrefix: 'safu-evm',
      });
    }

    const onUri = uri => modal.open({ uri });
    _wcProvider.on('display_uri', onUri);

    try {
      await _wcProvider.connect();
    } finally {
      _wcProvider.off('display_uri', onUri);
      modal.close();
    }

    S.wcProvider = _wcProvider;
    return _finalize(new ethers.BrowserProvider(_wcProvider));
  }

  return {
    family: 'evm',

    // The vendored ethers bundle is a top-level <script> today, so nothing to
    // lazy-load here. Declared so wallet.js can call it uniformly.
    ensureDeps: () => Promise.resolve(),

    options() {
      const out = [];

      if (discovered.length > 0) {
        // MetaMask, Rabby, Rainbow ext, Coinbase ext, Frame, …
        discovered.forEach(detail => out.push({
          name:    detail.info.name,
          tag:     'extension',
          connect: () => _connectInjected(detail.provider),
        }));
      } else if (window.ethereum) {
        const label = window.ethereum.isMetaMask ? 'MetaMask'
                    : window.ethereum.isCoinbaseWallet ? 'Coinbase Wallet'
                    : 'Browser Wallet';
        out.push({ name: label, tag: 'extension', connect: () => _connectInjected(window.ethereum) });
      }

      out.push({
        name:    'WalletConnect',
        tag:     'Rainbow · Trust · Safe · 300+',
        connect: () => _withTimeout(_connectWC(), 'WalletConnect', _wcCloseModal),
        // Signals to wallet.js that a failure here should reopen the picker,
        // because the user was mid-flow in a separate overlay.
        reopenOnError: true,
      });

      return out;
    },

    // Shown when no option can connect at all.
    emptyHint: 'No browser wallet found. Use WalletConnect below.',

    disconnect() {
      if (S.wcProvider?.disconnect) S.wcProvider.disconnect().catch(() => {});
      S.wcProvider = null;
    },
  };
})();
