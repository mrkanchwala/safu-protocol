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

};
