// Chain-aware UI rendering.
//
// Every number and tool name this file writes is a fact about ONE chain. Before
// 2026-08-19 they lived in markup: "100% CATCH RATE", "75 / 75 forge tests",
// "12 / 12 halmos properties", "Solidity 0.8.25". Add a chain switcher to that
// page and all of it renders unchanged under the new chain's tag — a
// chain-specific number presented as protocol-wide, which is the exact claim
// the multi-chain positioning guardrail forbids.
//
// Deliberately a VALUE POPULATOR, not a markup renderer. It writes textContent
// into existing elements and never rebuilds a subtree, because events.js binds
// handlers once by element id and an innerHTML replacement silently unbinds
// them. The visual restructure is a separate phase.
//
// The renderer owns the presentation chrome — the [ brackets ], the "✓", the
// ".txt — date" filename — and config holds semantic values only, so a chain
// cannot ship a label in the wrong house style by an author forgetting it.
window.SAFU = window.SAFU || {};

window.SAFU.chainUI = (() => {

  // ── primitives ─────────────────────────────────────────────────────────
  function setText(id, value) {
    const el = document.getElementById(id);
    if (!el || value === undefined || value === null) return false;
    el.textContent = value;
    return true;
  }

  function setAll(className, value) {
    if (value === undefined || value === null) return 0;
    const els = document.querySelectorAll('.' + className);
    els.forEach(el => { el.textContent = value; });
    return els.length;
  }

  // Toggles the page's own `.d-none` class rather than an inline display style.
  //
  // Not cosmetic: this page's CSP sets `style-src 'self' …` with NO
  // 'unsafe-inline', which blocks inline style ATTRIBUTES in markup. A
  // `style="display:none"` default would therefore be ignored in production and
  // the element would render visible — while `el.style.display = 'none'` from
  // script keeps working, because CSSOM writes are not covered by style-src.
  // Mixing the two means the JS path works and the markup default silently does
  // not. One class, both paths, no CSP dependency.
  function setDisplay(id, visible) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('d-none', !visible);
  }

  // ── stat strip ─────────────────────────────────────────────────────────
  // The stake-range cell is rendered here from the chain's FALLBACK bounds and
  // then overwritten by init.loadStakeBounds() with contract-read values.
  // Without this pass the markup default ("0.01–0.75 ETH") survives a failed
  // read on any chain, which on a non-Ethereum chain means printing Ethereum's
  // numbers under that chain's asset symbol. A chain whose bounds are genuinely
  // unknown renders an em-dash rather than a plausible borrowed number.
  //
  // A chain with NO VERIFIED VALUE for a stat omits the key, and the cell is
  // hidden rather than left showing the previous chain's number. This is the
  // whole point: Stellar has no measured catch-rate figure, and "100%" is an
  // Ethereum result from controlled testing against verified historical EVM
  // hacks. Inheriting it would be the exact false protocol-wide claim the
  // positioning guardrail forbids — and an em-dash in its place reads as a
  // broken page, so the cell goes away instead.
  function renderStatCell(cellId, valId, lblId, stat) {
    const has = Boolean(stat && stat.value);
    setDisplay(cellId, has);
    if (has) {
      setText(valId, stat.value);
      setText(lblId, stat.label);
    }
    return has;
  }

  function renderStats(cfg) {
    const s = cfg.stats || {};

    // The about-section card repeats the catch-rate claim in prose, so it lives
    // or dies with the stat itself.
    const hasCatchRate = renderStatCell('stat-cell-catch-rate', 'stat-catch-rate', 'stat-catch-rate-lbl', s.catchRate);
    setDisplay('about-card-catch-rate', hasCatchRate);
    if (hasCatchRate) setText('about-catch-rate', s.catchRate.value);

    renderStatCell('stat-cell-coverage', 'stat-coverage', 'stat-coverage-lbl', s.coverageRatio);
    renderStatCell('stat-cell-lock', 'stat-lock', 'stat-lock-lbl', s.lock);

    renderStakeBounds(cfg);
  }

  // Config-fallback pass over EVERY element that prints a stake bound.
  //
  // init.loadStakeBounds() reads the live values from the contract and
  // overwrites all three, but it is async and its catch is deliberately silent.
  // Before this pass, a failed read left the markup defaults — "0.01–0.75 ETH",
  // "Any amount between 0.01 and 0.75 ETH", and a 0.01/0.75 number input — in
  // place under whatever chain happened to be active. Those are Ethereum's
  // numbers and Ethereum's symbol, and on another chain they are simply wrong
  // rather than merely stale.
  //
  // A chain whose bounds are genuinely unknown renders an em-dash and leaves
  // the input unconstrained rather than inheriting a borrowed range: a wrong
  // min/max would client-side-reject amounts the contract would have accepted.
  function renderStakeBounds(cfg) {
    const min = cfg.stakeMinFallback;
    const max = cfg.stakeMaxFallback;
    const sym = cfg.assetSymbol;
    const known = Boolean(min && max);

    setText('stat-stake-range', known ? `${min}–${max} ${sym}` : '—');
    setText('stake-range-desc', known
      ? `Any amount between ${min} and ${max} ${sym}.`
      : `Stake bounds are read from the contract.`);

    const input = document.getElementById('input-amount');
    if (input) {
      if (known) {
        input.min = min;
        input.max = max;
        input.placeholder = `${min} – ${max} ${sym}`;
      } else {
        input.removeAttribute('min');
        input.removeAttribute('max');
        input.placeholder = `amount in ${sym}`;
      }
    }
  }

  // ── evidence / security panels ──────────────────────────────────────────
  // A chain that has not run a given tool omits that key. The panel is then
  // hidden outright rather than relabelled into a generic "audit coverage" box,
  // which would imply a check nobody performed.
  function renderEvidence(cfg) {
    const e = cfg.evidence || {};

    if (e.audit) {
      setText('sec-audit-file',    `security-audit.txt — ${e.audit.date}`);
      setText('sec-audit-label',   `[ Security Audit — ${e.audit.toolLabel} ]`);
      setText('sec-audit-verdict', `✓ ${e.audit.toolLabel} — ${e.audit.verdict}`);

      // A five-severity table is only honest for a chain whose audit actually
      // produced one. The 7a combined audit refused to record 0/0/0/0/0 for the
      // Soroban contract — the static analyser's build failed, so its zeros
      // were vacuous — and rendering them would reproduce precisely the defect
      // class that audit existed to find. Such a chain sets severities:null and
      // supplies findingsSummary instead; the table is hidden, not zeroed.
      const sev = e.audit.severities;
      const hasSeverityTable = Boolean(sev && typeof sev === 'object');
      setDisplay('sec-audit-table', hasSeverityTable);
      setDisplay('sec-audit-note', !hasSeverityTable);

      if (hasSeverityTable) {
        ['critical', 'high', 'medium', 'low', 'info'].forEach(k => {
          setText('sec-sev-' + k, sev[k] === undefined ? '—' : String(sev[k]));
        });
      } else {
        setText('sec-audit-note', e.audit.findingsSummary || 'audit detail on request');
      }
    }

    const sym = e.symbolic;
    setDisplay('sec-symbolic-panel', Boolean(sym));
    if (sym) {
      setText('sec-symbolic-file',  `${sym.fileSlug}.txt — ${sym.date}`);
      setText('sec-symbolic-label', `[ ${sym.toolLabel} ]`);
      setText('sec-symbolic-score', sym.score);
      setText('sec-symbolic-sub',   sym.sub);
    }

    if (e.review) {
      setText('sec-review-label',   `[ ${e.review.label} ]`);
      setText('sec-review-verdict', `✓ ${e.review.verdict} — ${e.review.date}`);
    }

    if (e.tests) {
      setText('sec-tests-label', `[ ${e.tests.label} ]`);
      setText('sec-tests-value', e.tests.value);
      setText('sec-tests-sub',   e.tests.sub);
    }

    // Same pattern as the symbolic-execution panel: a chain without a
    // verified solvency invariant omits the key and the whole guarantee
    // card disappears, rather than the page asserting an unverified claim.
    setDisplay('guarantee-invariant', Boolean(e.invariant && e.invariant.verified));

    // Explorer URL is DERIVED, never a second copy of the address in config.
    const meta = cfg.contractMeta || {};
    setText('sec-contract-lang', meta.langLine);

    const link = document.getElementById('sec-contract-link');
    if (link) {
      const a = window.SAFU.adapter();
      link.href = a.explorerAddrUrl(cfg.contract);
      link.textContent = `${a.explorerName()} verified ↗`;
    }
  }

  // ── asset symbol / chain name in prose ─────────────────────────────────
  // Only the symbol is wrapped, never the sentence. Every one of these sites
  // sits inside prose or carries inline <strong>, so rewriting whole sentences
  // would drop markup.
  function renderProse(cfg) {
    setAll('js-asset', cfg.assetSymbol);
    setAll('js-chain-name', cfg.label);
  }

  // ── chain-specific prose (wallet list, claim-id hint, MEV note) ─────────
  // All three are TRUSTED, developer-authored HTML from config — not user or
  // API input — so innerHTML here carries the same trust basis as loader()'s
  // <span>, not the untrusted-content class of bug esc() guards against
  // elsewhere. A chain with nothing accurate to say (mevChainNote) omits the
  // key and the note disappears, same pattern as evidence.symbolic.
  function renderChainProse(cfg) {
    setText('step-desc-connect', cfg.walletsLine);

    const beneInput = document.getElementById('input-beneficiary');
    if (beneInput && cfg.beneficiaryPlaceholder) beneInput.placeholder = cfg.beneficiaryPlaceholder;

    const hintEl = document.getElementById('step-desc-stream-hint');
    if (hintEl && cfg.claimIdHint) hintEl.innerHTML = cfg.claimIdHint;

    setDisplay('sec-mev-chain-note', Boolean(cfg.mevChainNote));
    const mevEl = document.getElementById('sec-mev-chain-note');
    if (mevEl && cfg.mevChainNote) mevEl.innerHTML = cfg.mevChainNote;
  }

  // ── chain tag on the security section ──────────────────────────────────
  // Rides the section-label line, which already has small dim styling. In the
  // <h2> the qualifier would render at heading size.
  function renderChainTag(cfg) {
    const a = window.SAFU.adapter();
    setText('sec-chain-tag', ` · ${a.tag()}`);
  }

  // ── JSON-LD operatingSystem ────────────────────────────────────────────
  // Joined over CHAIN_ORDER so the machine-readable chain claim cannot drift
  // from config.js. The live value was a hardcoded "Ethereum Mainnet", which is
  // how it became an assertion that SAFU runs on exactly one chain.
  function renderSchema() {
    const el = document.getElementById('ld-webapp');
    if (!el) return null;

    const labels = (CONFIG.CHAIN_ORDER || [])
      .map(id => CONFIG.CHAINS[id])
      .filter(Boolean)
      .map(c => c.osLabel)
      .filter(Boolean);
    if (!labels.length) return null;

    try {
      const data = JSON.parse(el.textContent);
      data.operatingSystem = labels.join(', ');
      el.textContent = JSON.stringify(data, null, 2);
      return data.operatingSystem;
    } catch {
      // Malformed JSON-LD is a content bug, not a runtime one. Leaving the
      // static block untouched is strictly better than emitting broken
      // structured data.
      return null;
    }
  }

  function render() {
    const cfg = window.SAFU.chain();
    renderStats(cfg);
    renderEvidence(cfg);
    renderProse(cfg);
    renderChainProse(cfg);
    renderChainTag(cfg);
    renderSchema();
  }

  // Runs before init.js's listener (script order), so the async contract read
  // in loadStakeBounds() overwrites this pass rather than racing it.
  document.addEventListener('DOMContentLoaded', render);

  return { render, renderStats, renderStakeBounds, renderEvidence, renderProse, renderChainProse, renderChainTag, renderSchema };
})();
