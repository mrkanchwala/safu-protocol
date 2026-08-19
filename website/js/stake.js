// Stake flow — permissionless V8 (no oracle approval needed)
window.SAFU = window.SAFU || {};

window.SAFU.stake = (() => {
  const { showStatus, loader } = window.SAFU.ui;
  const S = window.SAFU.state;

  function handleEnroll() {
    if (!S.walletAddress) return;

    const a   = window.SAFU.adapter();
    const cfg = window.SAFU.chain();
    const sym = a.assetSymbol;

    const beneficiary = document.getElementById('input-beneficiary').value.trim();
    if (!a.isValidAddress(beneficiary)) {
      showStatus('status-enroll', 'err', 'Enter a valid beneficiary address first (step 02).');
      return;
    }
    // isValidAddress accepts the zero address, and the contract rejects it with
    // "zero beneficiary" — so without this the check above lets a guaranteed
    // revert through.
    if (a.isZeroAddress(beneficiary)) {
      showStatus('status-enroll', 'err', 'Beneficiary cannot be the zero address.');
      return;
    }
    if (a.sameAddress(beneficiary, S.walletAddress)) {
      showStatus('status-enroll', 'err', 'Beneficiary must differ from your staker wallet.');
      return;
    }

    // Bounds come from the contract via init.loadStakeBounds(). The fallbacks
    // are for a failed read only — never the source of truth.
    const min = parseFloat(S.stakeMin ?? cfg.stakeMinFallback);
    const max = parseFloat(S.stakeMax ?? cfg.stakeMaxFallback);

    const amountInput = document.getElementById('input-amount');
    const amount = parseFloat(amountInput?.value);
    if (isNaN(amount) || amount < min || amount > max) {
      showStatus('status-enroll', 'err', `Enter an amount between ${min} and ${max} ${sym}.`);
      return;
    }

    S._stakeAmount = amount.toString();
    showStatus('status-enroll', 'ok',
      `> amount: ${S._stakeAmount} ${sym}\n> tier: assessed at claim time\n> ready to stake`);
    document.getElementById('btn-stake').textContent = `[ stake ${S._stakeAmount} ${sym} ]`;
    document.getElementById('btn-stake').disabled = false;
  }

  // The pre-flight itself moved INTO the adapters in Phase 2c. It has to: the
  // EVM version reads eight contract getters, and Soroban exposes none of them
  // as functions — its equivalents live in instance storage and its guard set
  // differs (admin instead of owner, bps-derived bounds instead of STAKE_MIN).
  // Both still answer the same question: "would this stake revert?"
  async function handleStake() {
    // NOT S.contract — that is an ethers.Contract and is null on Stellar by
    // design. Connection state is S.walletAddress on every family.
    if (!S._stakeAmount || !S.walletAddress) return;

    const a = window.SAFU.adapter();

    const beneficiary = document.getElementById('input-beneficiary').value.trim();
    if (!a.isValidAddress(beneficiary) || a.isZeroAddress(beneficiary)) {
      showStatus('status-stake', 'err', 'Enter a valid beneficiary address.');
      return;
    }
    if (a.sameAddress(beneficiary, S.walletAddress)) {
      showStatus('status-stake', 'err', 'Beneficiary must differ from your staker wallet.');
      return;
    }

    document.getElementById('btn-stake').disabled = true;
    showStatus('status-stake', 'info', loader('Checking pool state'));

    try {
      const stakeRaw = a.parseAmount(S._stakeAmount);

      const blocker = await a.preflightStake({
        staker: S.walletAddress,
        beneficiary,
        amountRaw: stakeRaw,
      });
      if (blocker) {
        showStatus('status-stake', 'err', `> cannot stake\n> ${blocker}`);
        document.getElementById('btn-stake').disabled = false;
        return;
      }

      showStatus('status-stake', 'info', loader('Sending transaction'));
      const sent = await a.sendStake({ beneficiary, amountRaw: stakeRaw });

      showStatus('status-stake', 'info',
        `${loader('Waiting for confirmation')}<br>> tx: ${window.SAFU.ui.esc(sent.hash)}`);

      // Soroban submission is asynchronous — sendTransaction returns PENDING and
      // the real outcome arrives later — so confirm() polls there and awaits the
      // receipt on EVM. Reporting success before this resolves would report
      // success for a transaction that went on to fail.
      const { blockRef } = await sent.confirm();
      showStatus('status-stake', 'ok',
        `> staked ✓\n> tx: ${window.SAFU.ui.esc(sent.hash)}\n> ${a.blockLabel}: ${blockRef}\n> coverage active — withdraw anytime`);

      window.SAFU.ui.setBene(S.walletAddress, a.id, beneficiary);
      window.SAFU.init.loadStakeStatus();

    } catch(e) {
      // userMessage is set by the Stellar connector for things the user can act
      // on (wrong Freighter network, signing cancelled, account switched
      // mid-flow) — prefer it over a raw SDK string.
      let msg = e.userMessage || e.message || 'Transaction failed';
      if (e.code === 'INSUFFICIENT_FUNDS' || msg.includes('insufficient funds'))
        msg = `Insufficient ${a.assetSymbol} — check your balance and try again.`;
      else if (e.code === 'ACTION_REJECTED' || msg.includes('user rejected'))
        msg = 'Transaction cancelled.';
      else if (msg.length > 120)
        msg = msg.slice(0, 120) + '...';
      // msg can carry an unmodified provider/RPC error string — escape before
      // it reaches showStatus's innerHTML, same as the sent.hash values above.
      showStatus('status-stake', 'err', `Error: ${window.SAFU.ui.esc(msg)}`);
      document.getElementById('btn-stake').disabled = false;
    }
  }

  function checkBeneficiary() {
    const val = (document.getElementById('input-beneficiary')?.value || '').trim();
    const box = document.getElementById('status-beneficiary-match');
    if (!box) return;
    // Case-insensitive comparison is correct for EVM and wrong for chains with
    // case-sensitive addresses, so the adapter owns the comparison.
    const match = Boolean(S.walletAddress && window.SAFU.adapter().sameAddress(val, S.walletAddress));
    box.classList.toggle('show', match);
  }

  return { handleEnroll, handleStake, checkBeneficiary };
})();
