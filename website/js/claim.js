// Claim flow — scan tx + dispute submission
window.SAFU = window.SAFU || {};

window.SAFU.claim = (() => {
  const { showStatus, show, hide, loader } = window.SAFU.ui;
  const S = window.SAFU.state;

  // Monotonic token so a superseded scan cannot write to the status box. Two
  // overlapping _pollJob loops (each up to 90s) previously both wrote to
  // status-scan, so a stale verdict could land on top of a fresh one.
  let _scanSeq = 0;

  async function handleScan() {
    const a = window.SAFU.adapter();

    const txHash = document.getElementById('input-claim-tx').value.trim();
    if (!a.isValidTxHash(txHash)) {
      showStatus('status-scan', 'err', 'That does not look like a valid transaction hash for this chain.');
      return;
    }

    const seq = ++_scanSeq;
    const stale = () => seq !== _scanSeq;

    document.getElementById('btn-scan').disabled = true;
    hide('auto-claim-section');
    hide('dispute-section');
    showStatus('status-scan', 'info', loader('Scanning transaction'));

    try {
      const res = await fetch(a.verifyUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tx_hash:        txHash,
          wallet_address: S.walletAddress || a.zeroAddress,
          asset:          a.assetSymbol,
          chain:          a.apiChain(),
        }),
      });

      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);

      let data = await res.json();
      if (data.status === 'pending' && data.job_id) data = await _pollJob(a, data.job_id, stale);
      if (stale()) return;

      // Coerced here, not escaped at each innerHTML site downstream — score
      // is meant to be a number, so making it one closes every current and
      // future sink at the source instead of relying on each caller to wrap
      // it in esc().
      const score   = Number(data.score) || 0;
      const verdict = data.verdict;

      // Scanning deliberately works before connecting a wallet, in which case
      // the request carries no real staker address. Label that result as a
      // preview rather than presenting it as this wallet's outcome.
      const preview = S.walletAddress
        ? ''
        : '\n> preview only — connect your wallet for a result tied to your address';

      if (verdict === 'drain_detected') {
        const tier = String(data.tier || '—').replace(/[<>&"']/g, '');
        // BigInt() throws on a non-integer string — a decimal/malformed
        // entitlement must not crash the whole verdict render into the outer
        // catch. Validate the shape first, same fallback as an absent value.
        const entRaw = data.entitlement;
        const entValid = entRaw !== undefined && entRaw !== null && /^\d+$/.test(String(entRaw));
        const entitlement = entValid
          ? `${a.formatAmount(BigInt(entRaw))} ${a.assetSymbol}`
          : '—';
        showStatus('status-scan', 'ok',
          `> score: ${score}/100\n> verdict: DRAIN DETECTED\n> tier: ${tier} &nbsp;|&nbsp; entitlement: ${entitlement}\n> tier will be assessed on claim submission${preview}`);
        S._pendingClaimTx    = txHash;
        S._pendingClaimScore = score;
        show('confirm-claim-section');
      } else {
        showStatus('status-scan', 'warn', `> score: ${score}/100\n> verdict: below threshold${preview}`);
        document.getElementById('dispute-tx').value = txHash;
        if (S.walletAddress) document.getElementById('dispute-wallet').value = S.walletAddress;
        show('dispute-section');
      }

    } catch(e) {
      if (!stale()) showStatus('status-scan', 'err', `Error: ${window.SAFU.ui.esc(e.message)}`);
    } finally {
      if (!stale()) document.getElementById('btn-scan').disabled = false;
    }
  }

  // `stale` lets a superseded scan abandon its loop instead of polling for the
  // full 90s and then writing an outdated verdict.
  async function _pollJob(adapter, jobId, stale = () => false, maxAttempts = 30) {
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, 3000));
      if (stale()) return {};
      const res = await fetch(adapter.verifyJobUrl(jobId));
      // Without this check, a 5xx error body (no `status` field) satisfies
      // `data.status !== 'pending'` and returns as if it were a real verdict
      // — a drained user whose scan hit an infra failure mid-poll then saw
      // "score: 0/100, below threshold" instead of an error. An availability
      // fault degrading into a wrong security verdict.
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);
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

    const a = window.SAFU.adapter();

    try {
      // Chain-scoped: T2 step 7c added a dedicated /v1/claim/stellar endpoint,
      // so this cannot be one shared path.
      const res = await fetch(a.claimUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet: S.walletAddress, tx_hash: txHash }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'claim submission failed');

      // VALIDATE, not character-strip. Stripping non-hex characters produces
      // a clean-LOOKING string even when the API response is malformed or
      // truncated — the adapters' own isValidClaimId/isValidTxHash are the
      // real check, and a failure here is treated as an error rather than
      // silently rendering (and linking an explorer URL to) a corrupted id.
      const claimId = String(data.claim_id || '');
      const onChainTx = String(data.on_chain_tx || '');
      if (!a.isValidClaimId(claimId) || !a.isValidTxHash(onChainTx)) {
        throw new Error('Claim activated, but the response was malformed — check your dashboard or contact support.');
      }

      // Persist so the claim ID survives a closed tab / cleared session — same
      // shape as beneficiary storage. Without this, a user who navigates away
      // before the 7-day cooldown clears has no way to recover it.
      window.SAFU.ui.setClaimId(S.walletAddress, a.id, claimId);

      statusEl.innerHTML =
        `> claim activated on-chain<br>` +
        `> score: ${score}/100<br>` +
        `> claim id: ${claimId}<br>` +
        `> tx: <a href="${a.explorerTxUrl(onChainTx)}" target="_blank" rel="noopener noreferrer">${onChainTx.slice(0,20)}…</a><br>` +
        `> payout streaming to your beneficiary`;

      // The stake-status badge (init.js) was last written before this claim
      // existed and silently stays "claim active: no" until a manual reload
      // without this — same refresh call stake.js already makes on success.
      if (window.SAFU.init && window.SAFU.init.loadStakeStatus) {
        window.SAFU.init.loadStakeStatus();
      }
    } catch (e) {
      hide('auto-claim-section');
      // e.message can be the claim POST's data.detail verbatim — backend
      // response text, not developer-authored — reaching showStatus's
      // innerHTML unescaped. Same bug class as the CSP/CSS fixes above:
      // trust the mechanism (a try/catch around a fetch), not the outcome.
      showStatus('status-scan', 'err', `> claim failed: ${window.SAFU.ui.esc(e.message)}`);
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

  // Before 2026-08-19 this function awaited a 600ms setTimeout and then told
  // the user "dispute received — decisions issued within 48 hours." It sent
  // nothing anywhere. There is no dispute endpoint on the API, so the text was
  // a false assurance given to someone who had just been told their drain
  // claim was rejected. It now routes to the real intake form: details are
  // copied to the clipboard and the form opens, and no claim is made about
  // receipt or turnaround that this code cannot keep.
  async function handleDispute() {
    const txHash = document.getElementById('dispute-tx').value.trim();
    const wallet = document.getElementById('dispute-wallet').value.trim();
    const desc   = document.getElementById('dispute-desc').value.trim();

    if (!desc) {
      showStatus('status-dispute', 'err', 'Describe what happened before submitting.');
      return;
    }
    if (wallet && !window.SAFU.adapter().isValidAddress(wallet)) {
      showStatus('status-dispute', 'err', 'That wallet address is not valid — correct it or clear the field.');
      return;
    }

    const summary =
      `SAFU claim dispute\n` +
      `tx hash: ${txHash || '(not provided)'}\n` +
      `wallet: ${wallet || '(not provided)'}\n\n` +
      `what happened:\n${desc}`;

    let copied = false;
    try {
      await navigator.clipboard.writeText(summary);
      copied = true;
    } catch { /* clipboard blocked — the form still opens, user retypes */ }

    window.open(CONFIG.FEEDBACK_FORM_URL, '_blank', 'noopener,noreferrer');

    showStatus('status-dispute', copied ? 'ok' : 'warn',
      copied
        ? `> details copied to your clipboard\n> the dispute form is open in a new tab — paste them there and submit\n> nothing is sent from this page`
        : `> the dispute form is open in a new tab\n> copy your tx hash, wallet and description into it\n> nothing is sent from this page`);
  }

  return { handleScan, handleConfirmClaim, handleCancelClaim, handleDispute };
})();
