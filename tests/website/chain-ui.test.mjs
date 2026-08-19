// Tests for js/chain-ui.js — the chain-aware value populator.
//
// What these guard against, concretely: every number the security panel and
// stat strip print used to live in markup. A chain switcher over that markup
// renders Ethereum's "75 / 75 forge tests" and "100% CATCH RATE" unchanged
// under a second chain's tag. So the tests that matter most are not "does it
// render" but "does it render THIS chain's value, and does it refuse to invent
// one it does not have".
//
// A synthetic second chain is registered on purpose. With only Ethereum in
// CONFIG.CHAINS, a renderer that ignored the config entirely and hardcoded the
// same strings would pass every assertion. The second chain is what makes the
// chain-drivenness falsifiable.
//
// Run: node tests/website/chain-ui.test.mjs

import { readFileSync } from 'node:fs';

globalThis.window = globalThis;
globalThis.ethers = {
  isAddress: a => /^0x[0-9a-fA-F]{40}$/.test(a),
  formatUnits: (v, d) => `${v}/${d}`,
  parseUnits: (v, d) => `${v}*${d}`,
  solidityPackedKeccak256: () => '0xhash',
  Contract: class {},
  JsonRpcProvider: class {},
};

// ── minimal DOM ─────────────────────────────────────────────────────────────
// Only the four APIs chain-ui.js uses. A real DOM would be a dependency, and
// website/ has no package.json by design.
//
// CSS-cascade correctness is OUT OF SCOPE here on purpose. classList
// assertions below prove chain-ui.js adds/removes 'd-none' correctly — they
// cannot catch a CSS specificity clash (a competing rule with equal
// specificity and later source order overriding it), because this mock loads
// no stylesheet and computes no cascade. That was exactly how
// sec-symbolic-panel rendered 535px tall on Stellar while every classList
// check here still reported it hidden. The real regression guard for that
// class of bug is `getComputedStyle` in tests/website/smoke.playwright.mjs,
// which runs against a real browser and the real styles.css.
const ID_ELEMENTS = [
  // wrapper cells — hiding these is how a chain declines to make a claim
  'stat-cell-catch-rate', 'stat-cell-coverage', 'stat-cell-lock', 'about-card-catch-rate',
  'sec-audit-table',
  'stat-catch-rate', 'stat-catch-rate-lbl', 'stat-coverage', 'stat-coverage-lbl',
  'stat-lock', 'stat-lock-lbl', 'stat-stake-range', 'about-catch-rate',
  'stake-range-desc', 'input-amount',
  'sec-chain-tag', 'sec-audit-file', 'sec-audit-label', 'sec-audit-verdict',
  'sec-sev-critical', 'sec-sev-high', 'sec-sev-medium', 'sec-sev-low', 'sec-sev-info',
  'sec-symbolic-panel', 'sec-symbolic-file', 'sec-symbolic-label',
  'sec-symbolic-score', 'sec-symbolic-sub',
  'sec-review-label', 'sec-review-verdict',
  'sec-tests-label', 'sec-tests-value', 'sec-tests-sub',
  'sec-contract-lang', 'sec-contract-link', 'ld-webapp',
  'guarantee-invariant',
  'step-desc-connect', 'step-desc-stream-hint', 'sec-mev-chain-note',
];

const LD_STATIC = JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'WebApplication',
  name: 'SAFU Protocol',
  operatingSystem: 'Ethereum Mainnet',
}, null, 2);

let byId, byClass;

function mkEl(id) {
  const el = {
    id,
    textContent: '',
    innerHTML: '',
    href: '',
    min: '',
    max: '',
    placeholder: '',
    removed: [],
    removeAttribute(k) { this[k] = null; this.removed.push(k); },
    classes: new Set(),
    classList: {
      toggle(name, force) {
        const on = force === undefined ? !this._s.has(name) : Boolean(force);
        if (on) this._s.add(name); else this._s.delete(name);
        return on;
      },
      contains(name) { return this._s.has(name); },
    },
    style: {
      display: '',
      removeProperty(k) { this[k] = ''; },
      setProperty(k, v) { this[k] = v; },
    },
  };
  el.classList._s = el.classes;
  return el;
}

function resetDom() {
  byId = new Map(ID_ELEMENTS.map(id => [id, mkEl(id)]));
  byId.get('ld-webapp').textContent = LD_STATIC;
  byClass = new Map([
    ['js-asset', [mkEl('a1'), mkEl('a2'), mkEl('a3')]],
    ['js-chain-name', [mkEl('c1'), mkEl('c2')]],
  ]);
}
resetDom();

globalThis.document = {
  getElementById: id => byId.get(id) || null,
  querySelectorAll: sel => byClass.get(sel.replace(/^\./, '')) || [],
  addEventListener: () => {},
};

const load = f => eval(readFileSync(new URL(`../../website/js/${f}`, import.meta.url), 'utf8'));

// Real load order from index.html: config → abi → state → adapters → chain → ui → chain-ui
load('config.js');
load('abi.js');
load('state.js');
load('adapter-evm.js');
load('chain.js');
load('chain-ui.js');

let pass = 0;
const failures = [];
function t(name, fn) {
  try { resetDom(); fn(); pass++; } catch (e) { failures.push(`${name}\n    ${e.message}`); }
}
function eq(a, b, label = '') {
  if (a !== b) throw new Error(`${label}expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }
const txt = id => byId.get(id).textContent;

const CU = window.SAFU.chainUI;

// ── a synthetic second chain ────────────────────────────────────────────────
// family:'evm' deliberately — this doubles as proof of the Phase 2a design
// call that a second EVM chain needs zero new adapter code. Every value differs
// from Ethereum's so a hardcoded renderer cannot pass.
const FIXTURE = {
  id: 'testchain',
  label: 'TestChain',
  assetSymbol: 'TST',
  tag: 'TST',
  networkLabel: 'testnet',
  family: 'evm',
  status: 'testnet',
  osLabel: 'TestChain Testnet',
  decimals: 7,
  chainId: 999,
  chainIdHex: '0x3e7',
  rpcUrl: 'https://rpc.test',
  contract: '0x00000000000000000000000000000000000000ff',
  explorerName: 'testscan',
  explorerTxBase: 'https://testscan.io/tx/',
  explorerAddrBase: 'https://testscan.io/address/',
  repoName: 'safu-test',
  repoUrl: 'https://github.com/x/safu-test',
  verifyPath: '/v1/verify',
  claimPath: '/v1/claim/test',
  apiChain: 'tst',
  stakeMinFallback: '5',
  stakeMaxFallback: '500',
  disclosures: [],
  stats: {
    catchRate:     { value: '91%',        label: 'DETECTION RATE' },
    coverageRatio: { value: 'UP TO 10:1', label: 'COVER RATIO' },
    lock:          { value: '30D LOCK',   label: 'LOCKED PERIOD' },
  },
  evidence: {
    audit: {
      toolLabel: 'audit-chain + cso',
      date: '2026-08-17',
      verdict: 'PASS',
      severities: { critical: 0, high: 1, medium: 2, low: 3, info: 4 },
    },
    // no `symbolic` key — the panel must disappear, not be relabelled
    review: { label: 'combined audit', date: '2026-08-17', verdict: 'PASS' },
    tests:  { label: 'rust test suite', value: '238 / 238', sub: 'tests pass' },
  },
  contractMeta: { langLine: 'Rust 1.81 · BUSL-1.1' },
  walletsLine: 'TestWallet — the official TestChain wallet extension.',
  claimIdHint: 'Claim ID is emitted in the <strong>TestClaimed</strong> event, viewable on testscan.',
  // no mevChainNote — mirrors Stellar's real omission
};

function withFixture(fn) {
  CONFIG.CHAINS.testchain = FIXTURE;
  const order = CONFIG.CHAIN_ORDER.slice();
  CONFIG.CHAIN_ORDER.push('testchain');
  const prev = window.SAFU.state.activeChain;
  try {
    window.SAFU.setChain('testchain');
    fn();
  } finally {
    window.SAFU.state.activeChain = prev;
    CONFIG.CHAIN_ORDER.length = 0;
    order.forEach(x => CONFIG.CHAIN_ORDER.push(x));
    delete CONFIG.CHAINS.testchain;
  }
}

// ── stat strip, real config ─────────────────────────────────────────────────

t('stat strip renders the active chain\'s values and labels', () => {
  CU.renderStats(window.SAFU.chain());
  eq(txt('stat-catch-rate'), '100%');
  eq(txt('stat-catch-rate-lbl'), 'CATCH RATE');
  eq(txt('stat-coverage'), 'UP TO 15:1');
  eq(txt('stat-coverage-lbl'), 'COVERAGE RATIO');
  eq(txt('stat-lock'), 'NO LOCK');
  eq(txt('stat-lock-lbl'), 'WITHDRAW ANYTIME');
});

t('the about-section catch rate is driven by the SAME config value as the stat strip', () => {
  CU.renderStats(window.SAFU.chain());
  eq(txt('about-catch-rate'), txt('stat-catch-rate'));
});

t('stake range renders from the chain fallbacks with the chain\'s own asset symbol', () => {
  CU.renderStats(window.SAFU.chain());
  eq(txt('stat-stake-range'), '0.01–0.75 ETH');
});

t('ALL THREE stake-bound sites are covered by the config pass, not just the stat cell', () => {
  // Regression guard: stake-range-desc and the amount input were previously
  // written only by init.loadStakeBounds(), whose catch is silent — so a failed
  // contract read left Ethereum's numbers on screen under any chain.
  CU.renderStakeBounds(window.SAFU.chain());
  eq(txt('stat-stake-range'), '0.01–0.75 ETH');
  eq(txt('stake-range-desc'), 'Any amount between 0.01 and 0.75 ETH.');
  const input = byId.get('input-amount');
  eq(input.min, '0.01');
  eq(input.max, '0.75');
  eq(input.placeholder, '0.01 – 0.75 ETH');
});

t('stake range renders an em-dash, never a borrowed number, when bounds are unknown', () => {
  CU.renderStakeBounds({ ...window.SAFU.chain(), stakeMinFallback: null, stakeMaxFallback: null });
  eq(txt('stat-stake-range'), '—');
});

t('a partially-known bound still refuses to render half a range', () => {
  CU.renderStakeBounds({ ...window.SAFU.chain(), stakeMaxFallback: null });
  eq(txt('stat-stake-range'), '—');
});

t('unknown bounds leave the input UNCONSTRAINED rather than inheriting a wrong range', () => {
  // A borrowed min/max would client-side-reject amounts the contract accepts.
  CU.renderStakeBounds({ ...window.SAFU.chain(), stakeMinFallback: null, stakeMaxFallback: null });
  const input = byId.get('input-amount');
  ok(input.removed.includes('min'), 'min attribute must be removed');
  ok(input.removed.includes('max'), 'max attribute must be removed');
  eq(input.placeholder, 'amount in ETH');
  ok(!txt('stake-range-desc').includes('0.01'), 'desc must not carry a borrowed bound');
});

t('a second chain drives every stake-bound site with its own numbers and symbol', () => {
  withFixture(() => {
    CU.renderStakeBounds(window.SAFU.chain());
    eq(txt('stat-stake-range'), '5–500 TST');
    eq(txt('stake-range-desc'), 'Any amount between 5 and 500 TST.');
    eq(byId.get('input-amount').placeholder, '5 – 500 TST');
  });
});

// ── evidence panels, real config ────────────────────────────────────────────

t('audit panel composes filename, label and verdict from semantic config values', () => {
  CU.renderEvidence(window.SAFU.chain());
  eq(txt('sec-audit-file'), 'security-audit.txt — 2026-06-18');
  eq(txt('sec-audit-label'), '[ Security Audit — CSO + Slither ]');
  eq(txt('sec-audit-verdict'), '✓ CSO + Slither — PASS');
});

t('severity counts are written from config, all five rows', () => {
  CU.renderEvidence(window.SAFU.chain());
  ['critical', 'high', 'medium', 'low', 'info'].forEach(k => eq(txt('sec-sev-' + k), '0', k + ': '));
});

t('symbolic-execution panel renders and stays visible when the chain has one', () => {
  CU.renderEvidence(window.SAFU.chain());
  ok(!byId.get('sec-symbolic-panel').classList.contains('d-none'), 'panel must be visible');
  eq(txt('sec-symbolic-file'), 'halmos-symbolic.txt — 2026-06-18');
  eq(txt('sec-symbolic-label'), '[ Halmos Symbolic Execution — a16z ]');
  // Derived from config, not hardcoded: a literal here is what let the wrong
  // "12 / 12" survive. The value's CORRECTNESS is asserted against the .sol
  // file further down; this only checks it reaches the DOM.
  eq(txt('sec-symbolic-score'), CONFIG.CHAINS.ethereum.evidence.symbolic.score);
  eq(txt('sec-symbolic-sub'), 'properties verified — zero counterexamples');
});

t('the solvency-invariant guarantee card is visible when the chain has a verified invariant', () => {
  CU.renderEvidence(window.SAFU.chain());
  ok(!byId.get('guarantee-invariant').classList.contains('d-none'), 'card must be visible');
});

t('a chain with no verified solvency invariant HIDES the guarantee card', () => {
  withFixture(() => {
    // FIXTURE deliberately omits evidence.invariant, same as the real Stellar
    // config — Soroban has no enforced liquid-vs-deployed check yet.
    CU.renderEvidence(window.SAFU.chain());
    ok(byId.get('guarantee-invariant').classList.contains('d-none'), 'card must be hidden');
  });
});

// ── chain-specific prose (wallet list, claim-id hint, MEV note) ────────────

t('the wallet list, claim-id hint, and MEV note render from config on the real chain', () => {
  CU.renderChainProse(window.SAFU.chain());
  eq(txt('step-desc-connect'), 'MetaMask, Rabby, Rainbow, Trust, Safe — any EIP-1193 compatible wallet.');
  eq(byId.get('step-desc-stream-hint').innerHTML,
    'Claim ID is emitted in the <strong>ClaimActivated</strong> event on Etherscan.');
  ok(!byId.get('sec-mev-chain-note').classList.contains('d-none'), 'MEV note must be visible on Ethereum');
  ok(byId.get('sec-mev-chain-note').innerHTML.includes('public mempool'));
});

t('a second chain renders its OWN wallet list and claim-id hint, not Ethereum\'s', () => {
  withFixture(() => {
    CU.renderChainProse(window.SAFU.chain());
    eq(txt('step-desc-connect'), FIXTURE.walletsLine);
    eq(byId.get('step-desc-stream-hint').innerHTML, FIXTURE.claimIdHint);
  });
});

t('a chain with no verified MEV claim (mevChainNote omitted) HIDES the note, not a borrowed one', () => {
  withFixture(() => {
    CU.renderChainProse(window.SAFU.chain());
    ok(byId.get('sec-mev-chain-note').classList.contains('d-none'), 'MEV note must be hidden');
  });
});

t('the real Stellar config has no mempool/gas claim — Etherscan event name is chain-specific', () => {
  const s = CONFIG.CHAINS.stellar;
  ok(!s.mevChainNote, 'Stellar must not assert an unverified MEV/mempool claim');
  ok(!/Etherscan/.test(s.claimIdHint), 'Stellar hint must not reference an EVM-only explorer');
  ok(!/MetaMask/.test(s.walletsLine), 'Stellar wallet line must not point to an EVM wallet');
});

t('review and test-suite cards compose their brackets from config', () => {
  CU.renderEvidence(window.SAFU.chain());
  eq(txt('sec-review-label'), '[ security review — comprehensive ]');
  eq(txt('sec-review-verdict'), '✓ PASS — 2026-06-18');
  eq(txt('sec-tests-label'), '[ forge test suite ]');
  eq(txt('sec-tests-value'), '75 / 75');
  eq(txt('sec-tests-sub'), 'tests pass — full coverage');
  eq(txt('sec-contract-lang'), 'Solidity 0.8.25 · BUSL-1.1');
});

t('the verified-contract link is DERIVED from the adapter, not a second copy of the address', () => {
  CU.renderEvidence(window.SAFU.chain());
  const cfg = window.SAFU.chain();
  const link = byId.get('sec-contract-link');
  eq(link.href, cfg.explorerAddrBase + cfg.contract);
  eq(link.textContent, 'etherscan verified ↗');
  ok(link.href.includes(cfg.contract), 'link must carry the config contract address');
});

// ── prose substitution ──────────────────────────────────────────────────────

t('every .js-asset span gets the chain asset symbol — not just the first', () => {
  CU.renderProse(window.SAFU.chain());
  const els = byClass.get('js-asset');
  eq(els.length, 3, 'fixture span count: ');
  els.forEach((el, i) => eq(el.textContent, 'ETH', `span ${i}: `));
});

t('every .js-chain-name span gets the chain display label', () => {
  CU.renderProse(window.SAFU.chain());
  byClass.get('js-chain-name').forEach((el, i) => eq(el.textContent, 'Ethereum', `span ${i}: `));
});

// ── chain tag ───────────────────────────────────────────────────────────────

t('mainnet renders a bare tag with no network qualifier', () => {
  CU.renderChainTag(window.SAFU.chain());
  eq(txt('sec-chain-tag'), ' · ETH');
});

// ── schema ──────────────────────────────────────────────────────────────────

t('JSON-LD operatingSystem is joined over CHAIN_ORDER, not left hardcoded', () => {
  // Expected value is DERIVED from config here on purpose. Hardcoding it is
  // what made this assertion stale the moment Stellar was added, which is the
  // same failure mode as hardcoding it in the page.
  const expected = CONFIG.CHAIN_ORDER.map(id => CONFIG.CHAINS[id].osLabel).join(', ');
  eq(CU.renderSchema(), expected);
  eq(JSON.parse(txt('ld-webapp')).operatingSystem, expected);
  ok(CONFIG.CHAIN_ORDER.length >= 2, 'this assertion is weak with only one chain configured');
});

t('renderSchema leaves a malformed JSON-LD block untouched rather than emitting broken data', () => {
  byId.get('ld-webapp').textContent = '{ not json';
  eq(CU.renderSchema(), null);
  eq(txt('ld-webapp'), '{ not json');
});

// ── THE POINT OF THE SUITE: a second chain ──────────────────────────────────

t('a second chain renders ITS OWN stat values, not Ethereum\'s', () => {
  withFixture(() => {
    CU.renderStats(window.SAFU.chain());
    eq(txt('stat-catch-rate'), '91%');
    eq(txt('stat-catch-rate-lbl'), 'DETECTION RATE');
    eq(txt('stat-coverage'), 'UP TO 10:1');
    eq(txt('stat-lock'), '30D LOCK');
    eq(txt('stat-lock-lbl'), 'LOCKED PERIOD');
    eq(txt('stat-stake-range'), '5–500 TST');
  });
});

t('a second chain renders its own evidence, tool names and severity counts', () => {
  withFixture(() => {
    CU.renderEvidence(window.SAFU.chain());
    eq(txt('sec-audit-file'), 'security-audit.txt — 2026-08-17');
    eq(txt('sec-audit-label'), '[ Security Audit — audit-chain + cso ]');
    eq(txt('sec-audit-verdict'), '✓ audit-chain + cso — PASS');
    eq(txt('sec-tests-label'), '[ rust test suite ]');
    eq(txt('sec-tests-value'), '238 / 238');
    eq(txt('sec-contract-lang'), 'Rust 1.81 · BUSL-1.1');
    eq(txt('sec-sev-high'), '1');
    eq(txt('sec-sev-info'), '4');
  });
});

t('a chain with no symbolic-execution run HIDES the panel instead of relabelling it', () => {
  withFixture(() => {
    CU.renderEvidence(window.SAFU.chain());
    ok(byId.get('sec-symbolic-panel').classList.contains('d-none'), 'panel must be hidden');
    eq(txt('sec-symbolic-score'), '', 'stale score must not survive: ');
  });
});

t('a second chain\'s explorer link and name both come from that chain', () => {
  withFixture(() => {
    CU.renderEvidence(window.SAFU.chain());
    const link = byId.get('sec-contract-link');
    eq(link.href, 'https://testscan.io/address/' + FIXTURE.contract);
    eq(link.textContent, 'testscan verified ↗');
  });
});

t('a second chain substitutes its own asset symbol and display name into prose', () => {
  withFixture(() => {
    CU.renderProse(window.SAFU.chain());
    byClass.get('js-asset').forEach(el => eq(el.textContent, 'TST'));
    byClass.get('js-chain-name').forEach(el => eq(el.textContent, 'TestChain'));
  });
});

t('a non-mainnet chain ALWAYS carries its network qualifier in the security tag', () => {
  withFixture(() => {
    CU.renderChainTag(window.SAFU.chain());
    eq(txt('sec-chain-tag'), ' · TST · testnet');
  });
});

t('operatingSystem grows to cover every configured chain automatically', () => {
  const before = CONFIG.CHAIN_ORDER.map(id => CONFIG.CHAINS[id].osLabel).join(', ');
  withFixture(() => {
    eq(CU.renderSchema(), before + ', TestChain Testnet');
  });
});

t('render() drives every region in one pass', () => {
  CU.render();
  eq(txt('stat-catch-rate'), '100%');
  eq(txt('sec-tests-value'), '75 / 75');
  eq(txt('sec-chain-tag'), ' · ETH');
  eq(byClass.get('js-asset')[2].textContent, 'ETH');
});

// ── invariants every future chain entry must satisfy ────────────────────────

t('every configured chain declares stats, evidence, contractMeta and osLabel', () => {
  Object.values(CONFIG.CHAINS).forEach(c => {
    // coverageRatio and lock are contract-derived and knowable on any chain.
    // catchRate is a MEASURED result and is deliberately optional: requiring it
    // would pressure a chain without one into publishing an invented number.
    ok(c.stats && c.stats.coverageRatio && c.stats.lock, `${c.id}: incomplete stats block`);
    ok(c.evidence && c.evidence.audit && c.evidence.tests, `${c.id}: incomplete evidence block`);
    ok(c.contractMeta && c.contractMeta.langLine, `${c.id}: missing contractMeta.langLine`);
    ok(typeof c.osLabel === 'string' && c.osLabel.length, `${c.id}: missing osLabel`);
  });
});

t('an omitted stat is omitted, never present-but-empty', () => {
  // "stats.catchRate = { value: '' }" would render an empty cell instead of
  // hiding it. Absence must be expressed by absence.
  Object.values(CONFIG.CHAINS).forEach(c => {
    ['catchRate', 'coverageRatio', 'lock'].forEach(k => {
      const s = c.stats[k];
      if (s !== undefined) {
        ok(s.value && String(s.value).trim(), `${c.id}.stats.${k} is declared but has no value`);
        ok(s.label && String(s.label).trim(), `${c.id}.stats.${k} is declared but has no label`);
      }
    });
  });
});

t('a chain without a severity table supplies a findings summary instead', () => {
  Object.values(CONFIG.CHAINS).forEach(c => {
    const a = c.evidence.audit;
    if (!a.severities) {
      ok(a.findingsSummary && a.findingsSummary.trim(),
        `${c.id}: severities is null but no findingsSummary — the panel would render a bare placeholder`);
    }
  });
});

t('a chain with no verified catch rate HIDES the cell and the about-card', () => {
  // Asserting the config lacks the value is NOT the same as asserting the page
  // hides it — a renderer that ignored the absence would keep Ethereum's "100%"
  // on screen under a Stellar tag. Caught by mutation testing: the config-only
  // assertion below passed while the render path was broken.
  const cfg = { ...window.SAFU.chain(), stats: { coverageRatio: { value: 'X', label: 'Y' }, lock: { value: 'Z', label: 'W' } } };
  CU.renderStats(cfg);
  ok(byId.get('stat-cell-catch-rate').classList.contains('d-none'), 'stat cell must hide');
  ok(byId.get('about-card-catch-rate').classList.contains('d-none'), 'about card must hide');
});

t('a chain WITH a catch rate shows both, so the hide is conditional not permanent', () => {
  CU.renderStats(window.SAFU.chain());
  ok(!byId.get('stat-cell-catch-rate').classList.contains('d-none'), 'stat cell must show');
  ok(!byId.get('about-card-catch-rate').classList.contains('d-none'), 'about card must show');
});

t('the real Stellar config renders with its catch-rate cell hidden', () => {
  CU.renderStats(CONFIG.CHAINS.stellar);
  ok(byId.get('stat-cell-catch-rate').classList.contains('d-none'),
    'Stellar must not display a catch-rate figure it has never measured');
  eq(txt('stat-coverage'), 'UP TO 15:1');
});

t('Stellar renders NO catch-rate claim and NO severity table', () => {
  // Both are Ethereum-only results. This is the guardrail assertion: it fails
  // the moment someone "fills in" Stellar's blanks by copying Ethereum's.
  const s = CONFIG.CHAINS.stellar;
  ok(!s.stats.catchRate, 'Stellar must not assert a catch rate — no measured figure exists');
  eq(s.evidence.severities, undefined);
  eq(s.evidence.audit.severities, null);
  ok(!s.evidence.symbolic, 'Halmos does not run on Soroban — no symbolic panel');
  // Licence: was previously asserted ABSENT because safu-soroban had no
  // LICENSE file. It now has a real Apache-2.0 LICENSE + Cargo `license`
  // field (SCF #44, 2026-08-19), so the guardrail inverts: the claim must be
  // present AND must be Apache-2.0, never Ethereum's BUSL-1.1 copied across.
  ok(/Apache-2\.0/.test(s.contractMeta.langLine),
    'Stellar must state its real Apache-2.0 licence');
  ok(!/BUSL/i.test(s.contractMeta.langLine),
    'BUSL-1.1 is the EVM licence — copying it here would be an unverified claim');
});

t('Stellar stake bounds match the bps formula against the live pool cap', () => {
  // pool_cap read from the deployed contract's instance storage 2026-08-19 was
  // 600,000 XLM. If someone edits a fallback by hand, this catches the drift.
  const s = CONFIG.CHAINS.stellar;
  const POOL_CAP_XLM = 600000n;
  eq(String(POOL_CAP_XLM * BigInt(s.stakeMinBps) / BigInt(s.stakeBpsDenominator)), s.stakeMinFallback);
  eq(String(POOL_CAP_XLM * BigInt(s.stakeMaxBps) / BigInt(s.stakeBpsDenominator)), s.stakeMaxFallback);
});

t('no chain stores an explorer URL that duplicates its contract address', () => {
  Object.values(CONFIG.CHAINS).forEach(c => {
    ok(!(c.contractMeta && c.contractMeta.explorerUrl),
      `${c.id}: explorerUrl must be derived from the adapter, not stored`);
  });
});

t('evidence values are strings — a bare number would render without its total', () => {
  Object.values(CONFIG.CHAINS).forEach(c => {
    eq(typeof c.evidence.tests.value, 'string', `${c.id} tests.value: `);
    if (c.evidence.symbolic) eq(typeof c.evidence.symbolic.score, 'string', `${c.id} symbolic.score: `);
  });
});

// ── evidence numbers vs their SOURCE OF TRUTH ───────────────────────────────
// The site shipped "12 / 12" Halmos properties while rendering a ten-item list,
// because the 12 was V7's count and nobody re-derived it for V8. Asserting the
// config value against the .sol file itself is the only version of this check
// that cannot go stale — a human re-counting is exactly what failed before.

t('halmos score matches the actual check_ count in the V8 suite', () => {
  const sol = readFileSync(new URL('../../test/SAFUPoolHalmos.t.sol', import.meta.url), 'utf8');
  const actual = (sol.match(/function\s+check_/g) || []).length;
  ok(actual > 0, 'found no check_ functions — wrong file, or the suite moved');
  eq(CONFIG.CHAINS.ethereum.evidence.symbolic.score, `${actual} / ${actual}`,
    `halmos score must equal the V8 suite's real property count (${actual}): `);
});

t('index.html\'s STATIC markup default matches the same real property count', () => {
  // The live regression this guards: index.html shipped a hardcoded
  // "12 / 12" markup default (V7's count) under sec-symbolic-score while
  // CONFIG.CHAINS.ethereum.evidence.symbolic.score correctly said "10 / 10" —
  // chain-ui.js overwrites the element on DOMContentLoaded, so the two never
  // visibly disagreed in a working browser, but the markup default is what
  // renders in the gap before JS runs, and drifts silently because nothing
  // asserted it against the same source of truth the config value above is
  // checked against.
  const sol = readFileSync(new URL('../../test/SAFUPoolHalmos.t.sol', import.meta.url), 'utf8');
  const actual = (sol.match(/function\s+check_/g) || []).length;
  const html = readFileSync(new URL('../../website/index.html', import.meta.url), 'utf8');
  const m = html.match(/id="sec-symbolic-score">([^<]+)</);
  ok(m, 'sec-symbolic-score element not found in index.html');
  eq(m[1], `${actual} / ${actual}`,
    `index.html's markup default must equal the V8 suite's real property count (${actual}): `);
});

t('halmos score is NOT the superseded V7 count', () => {
  // Guards the specific regression: V7's file is still in the repo, and its
  // count is the number that was live and wrong.
  const v7 = readFileSync(new URL('../../test/SAFUPoolV7Halmos.t.sol', import.meta.url), 'utf8');
  const v7count = (v7.match(/function\s+check_/g) || []).length;
  const score = CONFIG.CHAINS.ethereum.evidence.symbolic.score;
  ok(score !== `${v7count} / ${v7count}`,
    `score ${score} equals V7's count (${v7count}) — V8's suite is the source of truth`);
});

// ── report ──────────────────────────────────────────────────────────────────
console.log(`\nchain-ui: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  failures.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
}
