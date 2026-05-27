// Claim stream — user pulls daily entitlement via claimStream(bytes32)
window.SAFU = window.SAFU || {};

window.SAFU.stream = (() => {
  const { showStatus, loader } = window.SAFU.ui;
  const S = window.SAFU.state;

  async function handleClaimStream() {
    if (!S.contract) {
      showStatus('status-stream', 'err', 'Connect your wallet first.');
      return;
    }

    const claimId = document.getElementById('input-claim-id').value.trim();
    if (!claimId.match(/^0x[0-9a-fA-F]{64}$/)) {
      showStatus('status-stream', 'err', 'Enter a valid claim ID — bytes32 hex string.');
      return;
    }

    const storedBene = localStorage.getItem('safu_bene_' + (S.walletAddress || '').toLowerCase());
    const beneficiary = (document.getElementById('input-stream-beneficiary')?.value.trim()) || storedBene || '';
    if (!ethers.isAddress(beneficiary)) {
      showStatus('status-stream', 'err', 'Enter your beneficiary address — the address set when you staked.');
      return;
    }

    document.getElementById('btn-stream').disabled = true;
    showStatus('status-stream', 'info', loader('Sending pull transaction'));

    try {
      const tx = await S.contract.claimStream(claimId, beneficiary);
      showStatus('status-stream', 'info',
        `${loader('Waiting for confirmation')}<br>> tx: ${tx.hash}`);

      const receipt = await tx.wait();
      showStatus('status-stream', 'ok',
        `> stream pulled ✓\n> tx: ${tx.hash}\n> block: ${receipt.blockNumber}`);

    } catch(e) {
      showStatus('status-stream', 'err', `Error: ${e.reason || e.message}`);
    } finally {
      document.getElementById('btn-stream').disabled = false;
    }
  }

  return { handleClaimStream };
})();
