// Wallet connection — EIP-6963 browser extensions + WalletConnect AppKit
window.SAFU = window.SAFU || {};

window.SAFU.wallet = (() => {
  const { showStatus, setBtn, loader } = window.SAFU.ui;
  const S = window.SAFU.state;

  // EIP-6963 provider discovery
  const eip6963Providers = [];
  window.addEventListener('eip6963:announceProvider', e => {
    eip6963Providers.push(e.detail);
    _refreshWalletList();
  });
  window.dispatchEvent(new Event('eip6963:requestProvider'));

  function _refreshWalletList() {
    if (!document.getElementById('wallet-list')) return;
    _renderWalletList();
  }

  function _renderWalletList() {
    const list = document.getElementById('wallet-list');
    if (!list) return;
    list.innerHTML = '';

    // EIP-6963 wallets (MetaMask, Rabby, Rainbow ext, Coinbase ext, Frame, etc.)
    if (eip6963Providers.length > 0) {
      eip6963Providers.forEach(detail => {
        const btn = _walletBtn(detail.info.name, 'extension', () => _connectEIP6963(detail));
        list.appendChild(btn);
      });
    } else if (window.ethereum) {
      // Fallback: legacy window.ethereum
      const label = window.ethereum.isMetaMask ? 'MetaMask'
                  : window.ethereum.isCoinbaseWallet ? 'Coinbase Wallet'
                  : 'Browser Wallet';
      list.appendChild(_walletBtn(label, 'extension', () => _connectLegacy(window.ethereum)));
    } else {
      const msg = document.createElement('p');
      msg.style.cssText = 'font-size:0.75rem;color:var(--dim);margin-bottom:1rem;';
      msg.textContent = 'No browser wallet found. Use WalletConnect below.';
      list.appendChild(msg);
    }

    // WalletConnect (Rainbow mobile, Trust, Safe, 300+)
    list.appendChild(_walletBtn('WalletConnect', 'Rainbow · Trust · Safe · 300+', _connectWC));
  }

  function _walletBtn(name, tag, onClick) {
    const btn = document.createElement('button');
    btn.className = 'wallet-option';
    btn.innerHTML = `<span class="wname">${name}</span><span class="wtag">${tag}</span>`;
    btn.onclick = onClick;
    return btn;
  }

  async function _connectEIP6963(detail) {
    _closeModal();
    try {
      const p = new ethers.BrowserProvider(detail.provider);
      try {
        await p.send('wallet_requestPermissions', [{ eth_accounts: {} }]);
      } catch(pe) {
        if (pe.code === 4001) throw pe;
        await p.send('eth_requestAccounts', []);
      }
      await _finalize(p);
    } catch(e) {
      showStatus('status-wallet', 'err', `Connection failed: ${e.message}`);
    }
  }

  async function _connectLegacy(eth) {
    _closeModal();
    try {
      const p = new ethers.BrowserProvider(eth);
      try {
        await p.send('wallet_requestPermissions', [{ eth_accounts: {} }]);
      } catch(pe) {
        if (pe.code === 4001) throw pe;
        await p.send('eth_requestAccounts', []);
      }
      await _finalize(p);
    } catch(e) {
      showStatus('status-wallet', 'err', `Connection failed: ${e.message}`);
    }
  }

  async function _connectWC() {
    _closeModal();
    try {
      const { EthereumProvider } = await import('/js/wc-provider.bundle.js');
      const wcProvider = await EthereumProvider.init({
        projectId:   CONFIG.WALLETCONNECT_PROJECT_ID,
        chains:      [CONFIG.CHAIN_ID],
        showQrModal: false,
        rpcMap:      { [CONFIG.CHAIN_ID]: CONFIG.RPC_URL },
        metadata: {
          name:        'SAFU',
          description: 'Stake ETH. Get covered.',
          url:         'https://safustaking.com',
          icons:       ['https://safustaking.com/favicon.svg'],
        },
      });

      const _onUri = (uri) => _showWCModal(uri);
      wcProvider.on('display_uri', _onUri);

      await wcProvider.connect();
      wcProvider.off('display_uri', _onUri);
      _hideWCModal();
      S.wcProvider = wcProvider;
      const p = new ethers.BrowserProvider(wcProvider);
      await _finalize(p);
    } catch(e) {
      _hideWCModal();
      _openModal();
      showStatus('status-wallet', 'err', `WalletConnect: ${e.message}`);
    }
  }

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
    } catch(e) {
      img.style.display = 'none';
      uriBox.style.color = '#aaa';
    }
  }

  function _hideWCModal() {
    const el = document.getElementById('wc-qr-overlay');
    if (el) el.remove();
  }

  async function _finalize(p) {
    const network = await p.getNetwork();
    if (Number(network.chainId) !== CONFIG.CHAIN_ID) {
      try {
        await p.send('wallet_switchEthereumChain', [{ chainId: '0x1' }]);
        const switched = await p.getNetwork();
        if (Number(switched.chainId) !== CONFIG.CHAIN_ID) throw new Error('switch failed');
      } catch(e) {
        showStatus('status-wallet', 'err', 'Wrong network — switch to Ethereum Mainnet.');
        return;
      }
    }
    S.provider      = p;
    S.signer        = await p.getSigner();
    S.walletAddress = await S.signer.getAddress();
    S.contract      = new ethers.Contract(CONFIG.CONTRACT_ADDRESS, window.SAFU_ABI, S.signer);
    _onConnected();
  }

  function _disconnect() {
    if (S.wcProvider?.disconnect) S.wcProvider.disconnect().catch(() => {});
    S.provider = null; S.signer = null; S.contract = null;
    S.walletAddress = null; S.enrollData = null; S.wcProvider = null;

    const navBtn = document.getElementById('btn-connect');
    if (navBtn) { navBtn.textContent = '[ connect wallet ]'; navBtn.classList.remove('connected'); navBtn.onclick = _openModal; }
    const discBtn = document.getElementById('btn-disconnect');
    if (discBtn) discBtn.style.display = 'none';
    const stakeBtn = document.getElementById('btn-stake-connect');
    if (stakeBtn) { stakeBtn.textContent = '[ connect wallet ]'; stakeBtn.disabled = false; }
    const enrollBtn = document.getElementById('btn-enroll');
    if (enrollBtn) enrollBtn.disabled = true;
    const stakeActionBtn = document.getElementById('btn-stake');
    if (stakeActionBtn) stakeActionBtn.disabled = true;
    const activeBox = document.getElementById('active-stake-box');
    if (activeBox) activeBox.style.display = 'none';
  }

  function _onConnected() {
    const short = `${S.walletAddress.slice(0,6)}…${S.walletAddress.slice(-4)}`;
    const navBtn = document.getElementById('btn-connect');
    if (navBtn) { navBtn.textContent = `[ ${short} ]`; navBtn.classList.add('connected'); navBtn.onclick = null; }
    const discBtn = document.getElementById('btn-disconnect');
    if (discBtn) discBtn.style.display = 'inline-block';

    const stakeBtn = document.getElementById('btn-stake-connect');
    if (stakeBtn) { stakeBtn.textContent = '✓ connected'; stakeBtn.disabled = true; }

    showStatus('status-wallet', 'ok', `> connected: ${S.walletAddress}`);

    const enrollBtn = document.getElementById('btn-enroll');
    if (enrollBtn) enrollBtn.disabled = false;

    const disputeWallet = document.getElementById('dispute-wallet');
    if (disputeWallet) disputeWallet.value = S.walletAddress;

    window.SAFU.init.loadStakeStatus();
  }

  function _openModal() {
    const modal = document.getElementById('wallet-modal');
    if (modal) { modal.classList.add('open'); _renderWalletList(); }
  }

  function _closeModal() {
    const modal = document.getElementById('wallet-modal');
    if (modal) modal.classList.remove('open');
  }

  return { open: _openModal, close: _closeModal, disconnect: _disconnect };
})();
