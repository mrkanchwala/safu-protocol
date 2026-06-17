// Stake flow — enroll (oracle approval) + stakeETH
window.SAFU = window.SAFU || {};

window.SAFU.stake = (() => {
  const { showStatus, loader } = window.SAFU.ui;
  const S = window.SAFU.state;

  async function handleEnroll() {
    if (!S.walletAddress) return;

    const beneficiary = document.getElementById('input-beneficiary').value.trim();
    if (!ethers.isAddress(beneficiary)) {
      showStatus('status-enroll', 'err', 'Enter a valid beneficiary address first (step 02).');
      return;
    }
    if (beneficiary.toLowerCase() === S.walletAddress.toLowerCase()) {
      showStatus('status-enroll', 'err', 'Beneficiary must differ from your staker wallet.');
      return;
    }

    document.getElementById('btn-enroll').disabled = true;
    showStatus('status-enroll', 'info', loader('Scoring wallet'));

    try {
      const res = await fetch(`${CONFIG.SAFU_API_BASE}/v1/enroll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet_address: S.walletAddress, beneficiary }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }));
        throw new Error(err.detail || res.statusText);
      }

      S.enrollData = await res.json();
      const tierNames = { 1: 'A', 2: 'B', 3: 'C' };
      const tier = tierNames[S.enrollData.tier_uint8] || S.enrollData.tier;
      const deadline = new Date(S.enrollData.deadline * 1000).toUTCString();

      showStatus('status-enroll', 'ok',
        `> oracle approval issued\n> tier: ${tier}\n> deadline: ${deadline}`);
      document.getElementById('btn-stake').disabled = false;

    } catch(e) {
      showStatus('status-enroll', 'err', `Error: ${e.message}`);
      document.getElementById('btn-enroll').disabled = false;
    }
  }

  async function handleStake() {
    if (!S.enrollData || !S.contract) return;

    const beneficiary = document.getElementById('input-beneficiary').value.trim();
    if (!ethers.isAddress(beneficiary)) {
      showStatus('status-stake', 'err', 'Enter a valid beneficiary address.');
      return;
    }
    if (beneficiary.toLowerCase() === S.walletAddress.toLowerCase()) {
      showStatus('status-stake', 'err', 'Beneficiary must differ from your staker wallet.');
      return;
    }
    if (S.enrollData.deadline && Math.floor(Date.now() / 1000) > S.enrollData.deadline) {
      showStatus('status-stake', 'err', 'Oracle approval expired — click [ get approval ] again.');
      document.getElementById('btn-stake').disabled = true;
      document.getElementById('btn-enroll').disabled = false;
      return;
    }

    document.getElementById('btn-stake').disabled = true;
    showStatus('status-stake', 'info', loader('Sending transaction'));

    try {
      const stakeWei = ethers.parseEther(CONFIG.MIN_STAKE_ETH);
      const tx = await S.contract.stakeETH(
        S.enrollData.tier_uint8,
        S.enrollData.deadline,
        S.enrollData.reason_hash,
        S.enrollData.signature,
        beneficiary,
        { value: stakeWei }
      );

      showStatus('status-stake', 'info',
        `${loader('Waiting for confirmation')}<br>> tx: ${tx.hash}`);

      const receipt = await tx.wait();
      showStatus('status-stake', 'ok',
        `> staked ✓\n> tx: ${tx.hash}\n> block: ${receipt.blockNumber}\n> coverage active — withdraw anytime`);

      localStorage.setItem('safu_bene_' + S.walletAddress.toLowerCase(), beneficiary);
      window.SAFU.init.loadStakeStatus();

    } catch(e) {
      showStatus('status-stake', 'err', `Error: ${e.message}`);
      document.getElementById('btn-stake').disabled = false;
    }
  }

  function checkBeneficiary() {
    const val = (document.getElementById('input-beneficiary')?.value || '').trim().toLowerCase();
    const box = document.getElementById('status-beneficiary-match');
    if (!box) return;
    const match = S.walletAddress && val === S.walletAddress.toLowerCase();
    box.classList.toggle('show', match);
  }

  return { handleEnroll, handleStake, checkBeneficiary };
})();
