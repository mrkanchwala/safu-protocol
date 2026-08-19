// Wallet modal + shared connection state.
//
// Phase 2c split this file: everything about HOW a family connects moved to
// js/connector-{evm,stellar}.js. What stays here is the part that is the same
// whichever chain you pick — the modal, the chain choice, the shared state
// fields, and the connected/disconnected UI.
//
// Chain selection lives on the PAGE, as the two #chain-picker buttons in the
// hero (founder decision, 2026-08-19 — supersedes the earlier "chain
// switcher is step 1 inside the wallet modal" call). Rationale for
// superseding: the original lock existed to stop a user reading one chain's
// numbers and transacting on another's; a page-level switcher that visibly
// reshapes the whole page serves that same goal better, because the active
// chain is never ambiguous. The modal's own chain step stays as a SECONDARY
// confirmation at connect time, not the primary picker.
window.SAFU = window.SAFU || {};

window.SAFU.wallet = (() => {
  const { showStatus, loader } = window.SAFU.ui;
  const S = window.SAFU.state;

  function _connector() {
    return window.SAFU.connectors[window.SAFU.chain().family] || null;
  }

  // ── option buttons ─────────────────────────────────────────────────────
  // Reuses .wallet-option / .wname / .wtag so the chain row and the wallet row
  // share one visual language and this needs no new CSS. The active marker is an
  // inline border colour rather than a class, for the same reason.
  function _optionBtn(name, tag, onClick, active) {
    const btn = document.createElement('button');
    btn.className = 'wallet-option';
    btn.type = 'button';
    const nameEl = document.createElement('span');
    nameEl.className = 'wname';
    nameEl.textContent = active ? `✓ ${name}` : name;
    const tagEl = document.createElement('span');
    tagEl.className = 'wtag';
    tagEl.textContent = tag;
    btn.appendChild(nameEl);
    btn.appendChild(tagEl);
    if (active) btn.style.borderColor = 'var(--white)';
    if (onClick) btn.addEventListener('click', onClick);
    else btn.disabled = true;
    return btn;
  }

  function _hint(text) {
    const p = document.createElement('p');
    p.className = 'note';
    p.style.marginBottom = '1rem';
    p.textContent = text;
    return p;
  }

  // ── page-level chain picker (hero) ──────────────────────────────────────
  // Primary chain selection. Built dynamically over CHAIN_ORDER, same
  // scalability rule as the modal's own switcher below — a new chain is one
  // CONFIG entry, never a new button hand-written into index.html.
  function _renderChainPicker() {
    const host = document.getElementById('chain-picker');
    if (!host) return;
    host.innerHTML = '';

    const order = CONFIG.CHAIN_ORDER || [];
    const activeId = window.SAFU.chain().id;

    order.forEach(id => {
      const cfg = CONFIG.CHAINS[id];
      if (!cfg) return;
      const isActive = id === activeId;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chain-btn' + (isActive ? ' active' : '');
      btn.disabled = isActive;

      const nameEl = document.createElement('span');
      nameEl.textContent = cfg.label;
      btn.appendChild(nameEl);

      // The tag carries live/testnet through the adapter — never hand-write
      // "live" here, the same reasoning as the modal switcher's own tag.
      const tagEl = document.createElement('span');
      tagEl.className = 'cbtag';
      tagEl.textContent = cfg.networkLabel ? cfg.networkLabel : 'live';
      btn.appendChild(tagEl);

      if (!isActive) btn.addEventListener('click', () => _switchChain(id));
      host.appendChild(btn);
    });
  }

  function _renderTestnetBand() {
    const band = document.getElementById('testnet-band');
    if (!band) return;
    const cfg = window.SAFU.chain();
    if (cfg.networkLabel) {
      band.textContent =
        `⚠ ${cfg.label} ${cfg.networkLabel} — no real funds, no real payouts. ` +
        `This demonstrates the live mechanism, not the production pool.`;
      band.classList.remove('d-none');
    } else {
      band.classList.add('d-none');
    }
  }

  // ── step 1: chain ──────────────────────────────────────────────────────
  function _renderChains() {
    const host = document.getElementById('chain-switcher');
    if (!host) return;
    host.innerHTML = '';

    const order = CONFIG.CHAIN_ORDER || [];
    // With one chain configured a switcher is noise, so the whole step hides
    // rather than rendering a single unclickable row.
    const wrap = document.getElementById('chain-step');
    if (wrap) wrap.style.display = order.length > 1 ? '' : 'none';
    if (order.length <= 1) return;

    const activeId = window.SAFU.chain().id;
    order.forEach(id => {
      const cfg = CONFIG.CHAINS[id];
      if (!cfg) return;
      const isActive = id === activeId;
      // The tag carries the network qualifier through the adapter, so a testnet
      // can never be offered here at visual parity with a live mainnet.
      const tag = window.SAFU.adapter(id).tag();
      host.appendChild(_optionBtn(
        cfg.label,
        tag,
        isActive ? null : () => _switchChain(id),
        isActive
      ));
    });
  }

  // Wipes every trace of the claim/dispute flow's UI state. setChain() already
  // clears the underlying S._pendingClaimTx/_pendingClaimScore — this is the
  // DOM side of the same bug: a scanned tx hash, a confirm-claim button, or a
  // status message from the OLD chain rendering unchanged after the switch,
  // which is exactly the "chain-specific fact presented as protocol-wide"
  // failure class chain-ui.js's own header comment warns about, just in the
  // claim flow instead of the evidence panels.
  const _STATUS_BOX_IDS = [
    'status-wallet', 'status-beneficiary-match', 'status-enroll', 'status-stake',
    'status-scan', 'status-auto-claim', 'status-dispute', 'status-stream',
  ];
  const _CLAIM_INPUT_IDS = ['input-claim-tx', 'dispute-tx', 'dispute-wallet', 'dispute-desc'];

  function resetFlowUI() {
    const { hide, hideStatus } = window.SAFU.ui;
    ['confirm-claim-section', 'auto-claim-section', 'dispute-section'].forEach(hide);
    _CLAIM_INPUT_IDS.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    _STATUS_BOX_IDS.forEach(hideStatus);

    // Restore btn-stake to its pre-flow default. disconnect() (fired inside
    // setChain() when a wallet was connected) already disables it, but never
    // resets its label — stake.js writes a chain-specific
    // "[ stake 0.5 ETH ]" once step 3 is confirmed, and that text is exactly
    // as stale under a new chain's tag as any of the evidence-panel numbers.
    const stakeBtn = document.getElementById('btn-stake');
    if (stakeBtn) { stakeBtn.textContent = '[ stake ]'; stakeBtn.disabled = true; }
  }

  function _switchChain(id) {
    // setChain() is an explicit transition: it disconnects and clears the stake
    // bounds and any in-progress amount, all of which belonged to the old chain.
    if (!window.SAFU.setChain(id)) return;
    resetFlowUI();

    // Re-render every chain-scoped surface, then re-read the new chain's live
    // numbers. Without the re-read the page would show the previous chain's
    // staker count under the new chain's label.
    window.SAFU.chainUI.render();
    window.SAFU.init.loadStakerCount();
    window.SAFU.init.loadStakeBounds();
    _renderChainPicker();
    _renderTestnetBand();

    _render();
  }

  // Renders the picker + band on first load too — chain-ui.js's own render()
  // fires on DOMContentLoaded, but it doesn't know about wallet.js's DOM, so
  // this needs its own listener rather than piggybacking on that one.
  document.addEventListener('DOMContentLoaded', () => {
    _renderChainPicker();
    _renderTestnetBand();
  });

  // ── step 2: wallet ─────────────────────────────────────────────────────
  async function _renderWallets() {
    const list = document.getElementById('wallet-list');
    if (!list) return;
    list.innerHTML = '';

    const conn = _connector();
    if (!conn) {
      list.appendChild(_hint(`No wallet support is wired for ${window.SAFU.chain().label} yet.`));
      return;
    }

    list.appendChild(_hint('checking for wallets…'));
    let options = [];
    try {
      await conn.ensureDeps();
      options = await conn.options();
    } catch (e) {
      list.innerHTML = '';
      list.appendChild(_hint(`Could not load wallet support: ${e.userMessage || e.message}`));
      return;
    }
    list.innerHTML = '';

    if (!options.length) {
      list.appendChild(_hint(conn.emptyHint || 'No wallet found for this chain.'));
      return;
    }
    options.forEach(o => list.appendChild(_optionBtn(o.name, o.tag, () => _run(o))));
  }

  function _render() {
    _renderChains();
    _renderWallets();
  }

  async function _run(option) {
    _closeModal();
    showStatus('status-wallet', 'info', loader('Connecting'));
    try {
      const r = await option.connect();
      S.provider        = r.provider ?? null;
      S.signer          = r.signer ?? null;
      S.contract        = r.contract ?? null;
      S.walletAddress   = r.address;
      S.connectedFamily = window.SAFU.chain().family;
      _onConnected();
    } catch (e) {
      // 4001 is the EIP-1193 user-rejection code; it is not a fault worth
      // rendering as a failure.
      // e.userMessage/e.message can originate from the wallet extension or
      // provider — escape before it reaches showStatus's innerHTML.
      const msg = e.code === 4001
        ? 'Connection cancelled.'
        : `Connection failed: ${window.SAFU.ui.esc(e.userMessage || e.message)}`;
      showStatus('status-wallet', 'err', msg);
      if (option.reopenOnError) _openModal();
    }
  }

  // ── connected / disconnected UI ─────────────────────────────────────────
  function _disconnect() {
    const conn = window.SAFU.connectors[S.connectedFamily] || _connector();
    if (conn) { try { conn.disconnect(); } catch { /* best effort */ } }

    S.provider = null; S.signer = null; S.contract = null;
    S.walletAddress = null; S.enrollData = null; S.wcProvider = null;
    S.connectedFamily = null;

    const navBtn = document.getElementById('btn-connect');
    if (navBtn) { navBtn.textContent = '[ connect wallet ]'; navBtn.classList.remove('connected'); }
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
    // Stellar strkeys are 56 chars and EVM addresses 42, so a fixed 6/4 slice
    // suits both — but the ellipsis is built from the real string either way.
    const addr = S.walletAddress;
    const short = `${addr.slice(0, 6)}…${addr.slice(-4)}`;
    const navBtn = document.getElementById('btn-connect');
    if (navBtn) { navBtn.textContent = `[ ${short} ]`; navBtn.classList.add('connected'); }
    const discBtn = document.getElementById('btn-disconnect');
    if (discBtn) discBtn.style.display = 'inline-block';

    const stakeBtn = document.getElementById('btn-stake-connect');
    if (stakeBtn) { stakeBtn.textContent = '✓ connected'; stakeBtn.disabled = true; }

    showStatus('status-wallet', 'ok', `> connected: ${window.SAFU.ui.esc(addr)}`);

    const enrollBtn = document.getElementById('btn-enroll');
    if (enrollBtn) enrollBtn.disabled = false;

    const disputeWallet = document.getElementById('dispute-wallet');
    if (disputeWallet) disputeWallet.value = addr;

    window.SAFU.init.loadStakeStatus();
  }

  function _openModal() {
    // The nav button doubles as the connected-address display. events.js binds
    // a click listener to it once at load, and assigning `.onclick = null`
    // does NOT remove an addEventListener handler — they are independent
    // registration channels — so before 2026-08-19 clicking the connected
    // address reopened this modal, and disconnecting left both channels bound
    // so _openModal ran twice per click. The guard belongs here, once.
    if (S.walletAddress) return;

    const modal = document.getElementById('wallet-modal');
    if (modal) { modal.classList.add('open'); _render(); }
  }

  function _closeModal() {
    const modal = document.getElementById('wallet-modal');
    if (modal) modal.classList.remove('open');
  }

  return {
    open: _openModal,
    close: _closeModal,
    disconnect: _disconnect,
    // Called by connector-evm when a late EIP-6963 announcement arrives.
    refresh: () => { if (document.getElementById('wallet-list')) _renderWallets(); },
  };
})();
