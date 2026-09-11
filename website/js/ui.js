// Shared UI helpers
window.SAFU = window.SAFU || {};

window.SAFU.ui = {

  // Show a status box. type: 'ok' | 'err' | 'info' | 'warn'
  showStatus(id, type, msg) {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = `status-box show ${type}`;
    el.innerHTML = msg.replace(/\n/g, '<br>');
  },

  hideStatus(id) {
    const el = document.getElementById(id);
    if (el) el.className = 'status-box';
  },

  loader(text = 'Working') {
    return `<span class="loader-text">${text}</span>`;
  },

  setBtn(id, text, disabled = false) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.disabled = disabled;
  },

  show(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'block';
  },

  hide(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  },

  // Escape before interpolating any stored or remote value into innerHTML.
  // showStatus() and the active-stake panel both build HTML by concatenation,
  // so values that did not originate in this file must pass through here.
  esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  },

  // ── beneficiary storage ────────────────────────────────────────────────
  // Keys are chain-namespaced and preserve address case. The pre-2026-08-19
  // key was `safu_bene_<address.toLowerCase()>`: harmless for EVM, but it
  // corrupts a Stellar strkey, which is case-sensitive uppercase base32.

  beneKey(address, chainId) {
    return `safu_bene_${chainId}_${address}`;
  },

  // Reads the namespaced key, then falls back to the legacy key and migrates
  // it forward. Without the fallback, everyone who staked before this change
  // silently loses their stored beneficiary.
  getBene(address, chainId) {
    if (!address) return null;
    const key = window.SAFU.ui.beneKey(address, chainId);
    const current = localStorage.getItem(key);
    if (current) return current;

    const legacy = localStorage.getItem('safu_bene_' + String(address).toLowerCase());
    if (legacy) {
      localStorage.setItem(key, legacy);
      return legacy;
    }
    return null;
  },

  setBene(address, chainId, beneficiary) {
    if (!address) return;
    localStorage.setItem(window.SAFU.ui.beneKey(address, chainId), beneficiary);
  },

  // ── claim ID storage ───────────────────────────────────────────────────
  // Same shape as beneficiary storage above. Without this, the claim ID
  // shown once at submission time (claim.js) is unrecoverable if the user
  // navigates away before the 7-day cooldown clears — they'd have no way
  // to collect their payout except their own notes.

  claimKey(address, chainId) {
    return `safu_claim_${chainId}_${address}`;
  },

  getClaimId(address, chainId) {
    if (!address) return null;
    return localStorage.getItem(window.SAFU.ui.claimKey(address, chainId));
  },

  setClaimId(address, chainId, claimId) {
    if (!address) return;
    localStorage.setItem(window.SAFU.ui.claimKey(address, chainId), claimId);
  },

};
