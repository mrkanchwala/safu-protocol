// Page init — live contract reads (staker count, stake status)
window.SAFU = window.SAFU || {};

window.SAFU.init = (() => {
  const S = window.SAFU.state;

  // Reads the ACTIVE chain's staker count through the adapter. Previously this
  // called an EVM contract method directly on every page load, so with a second
  // chain selected it would have rendered Ethereum's count under that chain's
  // label — a plausible-looking wrong number, which is worse than the em-dash.
  async function loadStakerCount() {
    try {
      const count = await window.SAFU.adapter().readTotalStakers();
      const el = document.getElementById('stat-stakers');
      if (el) el.textContent = String(count);
    } catch { /* display-only, safe to leave as the em-dash placeholder */ }
  }

  // Reads STAKE_MIN/STAKE_MAX from the contract instead of trusting the
  // hardcoded 0.01/0.75 that was duplicated across markup, the number input,
  // and stake.js's validator. CONFIG.STAKE_MIN_ETH/STAKE_MAX_ETH existed but
  // were referenced nowhere, so the config was decorative at this point.
  async function loadStakeBounds() {
    try {
      const a = window.SAFU.adapter();
      const bounds = await a.readStakeBounds();
      if (!bounds) return;   // chain cannot answer — chain-ui's config pass stands
      const { min, max } = bounds;
      const sym = a.assetSymbol;

      S.stakeMin = min;
      S.stakeMax = max;

      const statEl = document.getElementById('stat-stake-range');
      if (statEl) statEl.textContent = `${min}–${max} ${sym}`;

      const input = document.getElementById('input-amount');
      if (input) {
        input.min = min;
        input.max = max;
        input.placeholder = `${min} – ${max} ${sym}`;
      }

      const desc = document.getElementById('stake-range-desc');
      if (desc) desc.textContent = `Any amount between ${min} and ${max} ${sym}.`;
    } catch {
      // Leave the markup defaults in place. stake.js falls back to them and
      // the contract rejects an out-of-range value regardless, so this is a
      // display degradation rather than a safety hole.
    }
  }

  // Fail closed: if stake state cannot be read we do not know whether this
  // wallet already has a policy, and V8 allows exactly one. Leaving the form
  // enabled on a failed read is how a user pays gas for an "already staked"
  // revert, so the action is disabled and the reason is shown.
  function _lockStakeFormOnError(msg) {
    const { showStatus } = window.SAFU.ui;
    ['btn-enroll', 'btn-stake'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.disabled = true;
    });
    // msg can carry a raw RPC/provider error string — escape before it
    // reaches showStatus's innerHTML.
    showStatus('status-wallet', 'err',
      `> could not read your stake status\n> ${window.SAFU.ui.esc(msg)}\n> staking is disabled until this succeeds — reload to retry`);
  }

  // Family-neutral: every field comes from the adapter's normalised record, so
  // this reads the same whether the record came from an EVM struct or a decoded
  // Soroban ScVal. Units differ between them (seconds vs ledger sequence) and
  // the adapter is what reconciles that.
  async function loadStakeStatus() {
    if (!S.walletAddress) return;
    try {
      const a = window.SAFU.adapter();
      const [rec, count, everStaked] = await Promise.all([
        a.readStakeRecord(S.walletAddress),
        a.readTotalStakers(),
        a.readTotalEverStaked(),
      ]);

      const el = document.getElementById('stat-stakers');
      if (el) el.textContent = String(count);

      if (rec.exists && !rec.withdrawn) {
        // everStaked is null on chains with no total_ever_staked (Soroban has
        // none). The badge is then omitted rather than shown off a stand-in.
        const isOG = everStaked !== null && Number(everStaked) <= 50;
        const daysSinceStake = rec.stakedAtSeconds
          ? Math.floor((Date.now() / 1000 - rec.stakedAtSeconds) / 86400)
          : null;
        // Already humanised by the adapter — a date on EVM, "ledger N" on
        // Soroban, because converting a ledger to a date needs an assumed
        // interval and would present an estimate as a fact.
        const penaltyLocked = rec.penaltyLockLabel
          ? `<br>> penalty lock until: ${window.SAFU.ui.esc(rec.penaltyLockLabel)}`
          : '';

        const box = document.getElementById('active-stake-box');
        const content = document.getElementById('active-stake-content');
        if (box && content) {
          const { esc, getBene } = window.SAFU.ui;
          const bene = getBene(S.walletAddress, a.id);
          content.innerHTML =
            `> active stake found<br>` +
            `> amount: ${esc(a.formatAmount(rec.amountRaw))} ${esc(a.assetSymbol)} &nbsp;|&nbsp; tier: assessed at claim<br>` +
            `> beneficiary: ${bene ? esc(bene) : '[protected]'}<br>` +
            (daysSinceStake === null ? '' : `> days staked: ${daysSinceStake}`) +
            (isOG ? ' &nbsp;<span style="color:var(--cyan)">[ OG STAKER ]</span>' : '') +
            penaltyLocked +
            `<br>> claim active: ${rec.claimActive ? '<span style="color:var(--red)">YES</span>' : 'no'}`;
          box.style.removeProperty('display');
          box.style.display = 'block';
        }

        const amountInput = document.getElementById('input-amount');
        if (amountInput) { amountInput.disabled = true; amountInput.placeholder = 'already staked'; }

        // Lock the entire stake form — one policy per wallet
        const connectBtn = document.getElementById('btn-stake-connect');
        if (connectBtn) { connectBtn.textContent = '✓ already staked'; connectBtn.disabled = true; }
        const beneficiaryInput = document.getElementById('input-beneficiary');
        if (beneficiaryInput) { beneficiaryInput.disabled = true; beneficiaryInput.placeholder = 'already staked'; }
        const enrollBtn = document.getElementById('btn-enroll');
        if (enrollBtn) enrollBtn.disabled = true;
        const stakeBtn = document.getElementById('btn-stake');
        if (stakeBtn) stakeBtn.disabled = true;
      }

    } catch (e) {
      _lockStakeFormOnError(e.shortMessage || e.reason || e.message || 'RPC read failed');
    }
  }

  // Run on page load
  document.addEventListener('DOMContentLoaded', () => {
    loadStakerCount();
    loadStakeBounds();
  });

  return { loadStakeStatus, loadStakerCount, loadStakeBounds };
})();
