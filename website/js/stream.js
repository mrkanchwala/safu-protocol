// Claim stream — user pulls daily entitlement via claimStream(bytes32)
window.SAFU = window.SAFU || {};

window.SAFU.stream = (() => {
  const { showStatus, loader } = window.SAFU.ui;
  const S = window.SAFU.state;

  async function handleClaimStream() {
    // S.contract is EVM-only and null on Stellar by design, so connection is
    // tested by address on every family.
    if (!S.walletAddress) {
      showStatus('status-stream', 'err', 'Connect your wallet first.');
      return;
    }

    const a = window.SAFU.adapter();

    const claimId = document.getElementById('input-claim-id').value.trim();
    if (!a.isValidClaimId(claimId)) {
      showStatus('status-stream', 'err', 'Enter a valid claim ID — bytes32 hex string.');
      return;
    }

    const storedBene = window.SAFU.ui.getBene(S.walletAddress, a.id);
    const beneficiary = (document.getElementById('input-stream-beneficiary')?.value.trim()) || storedBene || '';
    if (!a.isValidAddress(beneficiary)) {
      showStatus('status-stream', 'err', 'Enter your beneficiary address — the address set when you staked.');
      return;
    }

    document.getElementById('btn-stream').disabled = true;
    showStatus('status-stream', 'info', loader('Verifying beneficiary'));

    try {
      // The contract rejects a claim whose beneficiary does not match the hash
      // stored at stake time — V8 with keccak256(abi.encodePacked(beneficiary))
      // (SAFUPoolV8.sol:544), Soroban with sha256(Address ScVal XDR)
      // (stake.rs:250). DIFFERENT hash function AND different preimage, which is
      // exactly why this comparison goes through the adapter instead of being
      // written once here. Format validation alone let a format-valid but
      // incorrect address through, and the user paid the fee for the revert.
      const rec = await a.readStakeRecord(S.walletAddress);
      const expected = rec.beneficiaryHash;
      const actual = a.hashBeneficiary(beneficiary);

      if (!expected || expected !== actual) {
        showStatus('status-stream', 'err',
          '> beneficiary does not match this stake\n' +
          '> the contract would reject this and you would still pay gas\n' +
          '> use the exact address you set when you staked');
        return;
      }

      showStatus('status-stream', 'info', loader('Sending pull transaction'));
      const sent = await a.sendClaimStream({ claimId, beneficiary });
      showStatus('status-stream', 'info',
        `${loader('Waiting for confirmation')}<br>> tx: ${window.SAFU.ui.esc(sent.hash)}`);

      const { blockRef } = await sent.confirm();
      showStatus('status-stream', 'ok',
        `> stream pulled ✓\n> tx: ${window.SAFU.ui.esc(sent.hash)}\n> ${a.blockLabel}: ${blockRef}`);

    } catch(e) {
      showStatus('status-stream', 'err',
        `Error: ${window.SAFU.ui.esc(e.userMessage || e.reason || e.message)}`);
    } finally {
      document.getElementById('btn-stream').disabled = false;
    }
  }

  return { handleClaimStream };
})();
