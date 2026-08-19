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
// text, same QR modal.
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
  function _showWCModal(uri) {
    _hideWCModal();
    const overlay = document.createElement('div');
    overlay.id = 'wc-qr-overlay';
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'background:rgba(0,0,0,0.92)',
      'z-index:600', 'display:flex', 'align-items:center', 'justify-content:center',
    ].join(';');

    const box = document.createElement('div');
    box.style.cssText = [
      'background:#0d0d0d', 'border:1px solid #333', 'padding:1.75rem',
      'text-align:center', 'width:280px', "font-family:'JetBrains Mono',monospace",
    ].join(';');

    const label = document.createElement('div');
    label.style.cssText = 'font-size:0.72rem;color:#888;letter-spacing:0.1em;margin-bottom:1.25rem;';
    label.textContent = '> scan with your mobile wallet';

    const img = document.createElement('img');
    img.id = 'wc-qr-img';
    img.style.cssText = 'display:block;margin:0 auto 1.25rem;border:4px solid #fff;width:220px;height:220px;background:#fff;';

    const uriBox = document.createElement('div');
    uriBox.style.cssText = 'font-size:0.6rem;color:#444;word-break:break-all;margin-bottom:1.25rem;';
    uriBox.textContent = uri.slice(0, 52) + '…';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = '[ cancel ]';
    cancelBtn.style.cssText = [
      'background:transparent', 'border:1px solid #444', 'color:#888',
      "font-family:'JetBrains Mono',monospace", 'padding:0.4rem 1.2rem',
      'cursor:pointer', 'font-size:0.72rem', 'letter-spacing:0.06em',
    ].join(';');
    cancelBtn.onclick = _hideWCModal;

    box.appendChild(label);
    box.appendChild(img);
    box.appendChild(uriBox);
    box.appendChild(cancelBtn);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    try {
      const qr = qrcode(0, 'L');
      qr.addData(uri);
      qr.make();
      img.src = qr.createDataURL(4, 0);
    } catch (e) {
      img.style.display = 'none';
      uriBox.style.color = '#aaa';
    }
  }

  function _hideWCModal() {
    const el = document.getElementById('wc-qr-overlay');
    if (el) el.remove();
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

  async function _connectWC() {
    const cfg = window.SAFU.chain();
    const { EthereumProvider } = await import('/js/wc-provider.bundle.js');
    const wcProvider = await EthereumProvider.init({
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
    });

    const onUri = uri => _showWCModal(uri);
    wcProvider.on('display_uri', onUri);

    try {
      await wcProvider.connect();
    } finally {
      wcProvider.off('display_uri', onUri);
      _hideWCModal();
    }

    S.wcProvider = wcProvider;
    return _finalize(new ethers.BrowserProvider(wcProvider));
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
        connect: _connectWC,
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
