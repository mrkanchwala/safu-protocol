// Page init — live contract reads (staker count, stake status)
window.SAFU = window.SAFU || {};

window.SAFU.init = (() => {
  const S = window.SAFU.state;

  function _readContract() {
    return new ethers.Contract(
      CONFIG.CONTRACT_ADDRESS,
      window.SAFU_ABI,
      new ethers.JsonRpcProvider(CONFIG.RPC_URL)
    );
  }

  async function loadStakerCount() {
    try {
      const count = await _readContract().totalStakers();
      const el = document.getElementById('stat-stakers');
      if (el) el.textContent = count.toString();
    } catch { /* non-fatal */ }
  }

  async function loadStakeStatus() {
    if (!S.walletAddress) return;
    try {
      const rc = _readContract();
      const stake = await rc.stakeOf(S.walletAddress);

      const [count, everStaked] = await Promise.all([rc.totalStakers(), rc.totalEverStaked()]);
      const el = document.getElementById('stat-stakers');
      if (el) el.textContent = count.toString();

      if (stake.amount > 0n && !stake.withdrawn) {
        const tierMap = { 1: 'A', 2: 'B', 3: 'C' };
        const tier    = tierMap[stake.tier] || stake.tier;
        const unlock  = new Date(Number(stake.unlocksAt) * 1000).toLocaleDateString();
        const isOG    = Number(everStaked) <= 50;

        const box = document.getElementById('active-stake-box');
        const content = document.getElementById('active-stake-content');
        if (box && content) {
          content.innerHTML =
            `> active stake found<br>` +
            `> tier: ${tier} &nbsp;|&nbsp; amount: ${ethers.formatEther(stake.amount)} ETH<br>` +
            `> beneficiary: ${localStorage.getItem('safu_bene_' + S.walletAddress.toLowerCase()) || '[protected]'}<br>` +
            `> unlocks: ${unlock}<br>` +
            `> points: ${isOG ? '<span style="color:var(--cyan)">[ OG STAKER ]</span>' : '—'}<br>` +
            `> claim active: ${stake.claimActive ? '<span style="color:var(--red)">YES</span>' : 'no'}`;
          box.style.removeProperty('display');
          box.style.display = 'block';
        }

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

    } catch { /* non-fatal */ }
  }

  // Run on page load
  document.addEventListener('DOMContentLoaded', loadStakerCount);

  return { loadStakeStatus, loadStakerCount };
})();
