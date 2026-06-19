// Stake flow — permissionless V8 (no oracle approval needed)
window.SAFU = window.SAFU || {};

window.SAFU.stake = (() => {
  const { showStatus, loader } = window.SAFU.ui;
  const S = window.SAFU.state;

  function handleEnroll() {
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

    const amountInput = document.getElementById('input-amount');
    const amount = parseFloat(amountInput?.value);
    if (isNaN(amount) || amount < 0.01 || amount > 0.75) {
      showStatus('status-enroll', 'err', 'Enter an amount between 0.01 and 0.75 ETH.');
      return;
    }

    S._stakeAmount = amount.toString();
    showStatus('status-enroll', 'ok',
      `> amount: ${S._stakeAmount} ETH\n> tier: assessed at claim time\n> ready to stake`);
    document.getElementById('btn-stake').textContent = `[ stake ${S._stakeAmount} ETH ]`;
    document.getElementById('btn-stake').disabled = false;
  }

  async function handleStake() {
    if (!S._stakeAmount || !S.contract) return;

    const beneficiary = document.getElementById('input-beneficiary').value.trim();
    if (!ethers.isAddress(beneficiary)) {
      showStatus('status-stake', 'err', 'Enter a valid beneficiary address.');
      return;
    }
    if (beneficiary.toLowerCase() === S.walletAddress.toLowerCase()) {
      showStatus('status-stake', 'err', 'Beneficiary must differ from your staker wallet.');
      return;
    }

    document.getElementById('btn-stake').disabled = true;
    showStatus('status-stake', 'info', loader('Sending transaction'));

    try {
      const stakeWei = ethers.parseEther(S._stakeAmount);
      const tx = await S.contract.stakeETH(
        beneficiary,
        true,
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
      let msg = e.message || 'Transaction failed';
      if (e.code === 'INSUFFICIENT_FUNDS' || msg.includes('insufficient funds'))
        msg = 'Insufficient ETH — check your balance and try again.';
      else if (e.code === 'ACTION_REJECTED' || msg.includes('user rejected'))
        msg = 'Transaction cancelled.';
      else if (msg.length > 120)
        msg = msg.slice(0, 120) + '...';
      showStatus('status-stake', 'err', `Error: ${msg}`);
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
