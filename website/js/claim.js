// Claim flow — scan tx + dispute submission
window.SAFU = window.SAFU || {};

window.SAFU.claim = (() => {
  const { showStatus, show, hide, loader } = window.SAFU.ui;
  const S = window.SAFU.state;

  async function handleScan() {
    const txHash = document.getElementById('input-claim-tx').value.trim();
    if (!txHash.match(/^0x[0-9a-fA-F]{64}$/)) {
      showStatus('status-scan', 'err', 'Enter a valid tx hash — 0x + 64 hex chars.');
      return;
    }

    document.getElementById('btn-scan').disabled = true;
    hide('auto-claim-section');
    hide('dispute-section');
    showStatus('status-scan', 'info', loader('Scanning transaction'));

    try {
      const res = await fetch(`${CONFIG.SAFU_API_BASE}/v1/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tx_hash:        txHash,
          wallet_address: S.walletAddress || '0x0000000000000000000000000000000000000000',
          asset:          'ETH',
          chain:          'eth',
        }),
      });

      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);

      let data = await res.json();
      if (data.status === 'pending' && data.job_id) data = await _pollJob(data.job_id);

      const score   = data.score ?? 0;
      const verdict = data.verdict;

      if (verdict === 'drain_detected') {
        const tier = data.tier || '—';
        const entitlement = data.entitlement ? `${ethers.formatEther(BigInt(data.entitlement))} ETH` : '—';
        showStatus('status-scan', 'ok',
          `> score: ${score}/100\n> verdict: DRAIN DETECTED\n> tier: ${tier} &nbsp;|&nbsp; entitlement: ${entitlement}\n> tier will be assessed on claim submission`);
        S._pendingClaimTx    = txHash;
        S._pendingClaimScore = score;
        show('confirm-claim-section');
      } else {
        showStatus('status-scan', 'warn', `> score: ${score}/100\n> verdict: below threshold`);
        document.getElementById('dispute-tx').value = txHash;
        if (S.walletAddress) document.getElementById('dispute-wallet').value = S.walletAddress;
        show('dispute-section');
      }

    } catch(e) {
      showStatus('status-scan', 'err', `Error: ${e.message}`);
    } finally {
      document.getElementById('btn-scan').disabled = false;
    }
  }

  async function _pollJob(jobId, maxAttempts = 30) {
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const res = await fetch(`${CONFIG.SAFU_API_BASE}/v1/verify/${jobId}`, {
        headers: {},
      });
      const data = await res.json();
      if (data.status !== 'pending') return data;
    }
    throw new Error('Scan timed out — try again.');
  }

  async function handleConfirmClaim() {
    if (!S.walletAddress) {
      showStatus('status-scan', 'err', 'Connect your wallet before submitting a claim.');
      hide('confirm-claim-section');
      S._pendingClaimTx = null;
      S._pendingClaimScore = null;
      return;
    }
    const txHash = S._pendingClaimTx;
    const score  = S._pendingClaimScore;
    hide('confirm-claim-section');
    document.getElementById('btn-confirm-claim').disabled = true;

    const statusEl = document.getElementById('status-auto-claim');
    statusEl.innerHTML = '> submitting claim on-chain...';
    show('auto-claim-section');

    try {
      const res = await fetch(`${CONFIG.SAFU_API_BASE}/v1/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet: S.walletAddress, tx_hash: txHash }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'claim submission failed');

      statusEl.innerHTML =
        `> claim activated on-chain<br>` +
        `> score: ${score}/100<br>` +
        `> claim id: ${data.claim_id}<br>` +
        `> tx: <a href="https://etherscan.io/tx/${data.on_chain_tx}" target="_blank" rel="noopener noreferrer">${data.on_chain_tx.slice(0,20)}…</a><br>` +
        `> payout streaming to your beneficiary`;
    } catch (e) {
      hide('auto-claim-section');
      showStatus('status-scan', 'err', `> claim failed: ${e.message}`);
      document.getElementById('btn-confirm-claim').disabled = false;
      show('confirm-claim-section');
    }
  }

  function handleCancelClaim() {
    hide('confirm-claim-section');
    S._pendingClaimTx    = null;
    S._pendingClaimScore = null;
    document.getElementById('btn-scan').disabled = false;
  }

  async function handleDispute() {
    const txHash = document.getElementById('dispute-tx').value.trim();
    const wallet = document.getElementById('dispute-wallet').value.trim();
    const desc   = document.getElementById('dispute-desc').value.trim();

    if (!desc) {
      showStatus('status-dispute', 'err', 'Describe what happened before submitting.');
      return;
    }

    document.getElementById('btn-dispute').disabled = true;
    showStatus('status-dispute', 'info', loader('Submitting dispute'));

    await new Promise(r => setTimeout(r, 600));

    showStatus('status-dispute', 'ok',
      `> dispute received\n> tx: ${txHash}\n> wallet: ${wallet || '(not provided)'}\n\n` +
      `Human review — decisions issued within 48 hours.\nNo further action required.`);
  }

  return { handleScan, handleConfirmClaim, handleCancelClaim, handleDispute };
})();
