// Event wiring — all onclick/oninput handlers centralised here.
// Replaces inline handlers so Content-Security-Policy can drop 'unsafe-inline'.
document.addEventListener('DOMContentLoaded', () => {
  function on(id, evt, fn) {
    const el = document.getElementById(id);
    if (el) el.addEventListener(evt, fn);
  }

  // The for-protocols CTA points at the same intake form as the nav link and
  // the claim-dispute flow. Set from CONFIG rather than hardcoded in markup so
  // the URL has one source of truth.
  const getInTouch = document.getElementById('btn-get-in-touch');
  if (getInTouch) getInTouch.href = CONFIG.FEEDBACK_FORM_URL;

  // Wallet modal
  on('btn-wallet-close',  'click', () => window.SAFU.wallet.close());

  // Nav
  on('btn-connect',       'click', () => window.SAFU.wallet.open());
  on('btn-disconnect',    'click', () => window.SAFU.wallet.disconnect());

  // Hero
  on('btn-hero-stake', 'click', () => document.getElementById('stake').scrollIntoView({ behavior: 'smooth' }));
  on('btn-hero-learn', 'click', () => document.getElementById('about').scrollIntoView({ behavior: 'smooth' }));

  // Stake section
  on('btn-stake-connect',   'click', () => window.SAFU.wallet.open());
  on('input-beneficiary',   'input', () => window.SAFU.stake.checkBeneficiary());
  on('btn-enroll',          'click', () => window.SAFU.stake.handleEnroll());
  on('btn-stake',           'click', () => window.SAFU.stake.handleStake());
  on('btn-withdraw',        'click', () => window.SAFU.stake.handleWithdraw());

  // Claim section
  on('btn-scan',            'click', () => window.SAFU.claim.handleScan());
  on('btn-confirm-claim',   'click', () => window.SAFU.claim.handleConfirmClaim());
  on('btn-cancel-claim',    'click', () => window.SAFU.claim.handleCancelClaim());
  on('btn-dispute',         'click', () => window.SAFU.claim.handleDispute());

  // Stream section
  on('btn-stream',          'click', () => window.SAFU.stream.handleClaimStream());
});
