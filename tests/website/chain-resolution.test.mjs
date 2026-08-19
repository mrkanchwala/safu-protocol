// Integration test for chain resolution against the REAL config.js.
//
// The unit tests for adapter-evm.js use synthetic chain configs, so they would
// still pass if config.js itself were malformed or if the load order were
// wrong. This file loads the real modules in the real order that index.html
// declares, and asserts the wiring resolves.
//
// It also enforces invariants that must hold for EVERY chain added to
// CONFIG.CHAINS, so a future chain entry missing `decimals` or an api path
// fails here rather than in production.
//
// Run: node tests/website/chain-resolution.test.mjs

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

const load = f => eval(readFileSync(new URL(`../../website/js/${f}`, import.meta.url), 'utf8'));

// Same order index.html declares: config → abi → state → adapters → chain
load('config.js');
load('abi.js');
load('state.js');
load('adapter-evm.js');
load('adapter-stellar.js');
load('chain.js');

let pass = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; } catch (e) { failures.push(`${name}\n    ${e.message}`); }
}
function eq(a, b, label = '') {
  if (a !== b) throw new Error(`${label}expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }

// ── resolution ──────────────────────────────────────────────────────────────

t('SAFU.chain() resolves to the default chain when activeChain is null', () => {
  eq(window.SAFU.state.activeChain, null, 'activeChain should start null: ');
  eq(window.SAFU.chain().id, CONFIG.DEFAULT_CHAIN);
});

t('SAFU.adapter() builds an adapter for the default chain', () => {
  const a = window.SAFU.adapter();
  eq(a.family, 'evm');
  eq(a.id, 'ethereum');
  eq(a.decimals, 18);
});

t('SAFU.adapter() is cached — repeated calls return the same object', () => {
  ok(window.SAFU.adapter() === window.SAFU.adapter(), 'adapter not cached');
});

t('SAFU.adapter(id) can resolve a named chain explicitly', () => {
  eq(window.SAFU.adapter('ethereum').id, 'ethereum');
});

t('an unknown chain id falls back to the default rather than throwing', () => {
  eq(window.SAFU.adapter('does-not-exist').id, CONFIG.DEFAULT_CHAIN);
});

t('setChain rejects an unknown chain', () => {
  eq(window.SAFU.setChain('does-not-exist'), false);
});

t('setChain accepts the current chain idempotently', () => {
  eq(window.SAFU.setChain(CONFIG.DEFAULT_CHAIN), true);
});

t('setChain clears per-chain state on a real switch', () => {
  // Register a second chain at runtime to exercise the transition without
  // depending on Stellar being wired yet.
  CONFIG.CHAINS.testchain = { ...CONFIG.CHAINS.ethereum, id: 'testchain', decimals: 7 };
  const S = window.SAFU.state;
  S.stakeMin = '0.01';
  S.stakeMax = '0.75';
  S._stakeAmount = '0.5';

  eq(window.SAFU.setChain('testchain'), true);
  eq(S.activeChain, 'testchain');
  eq(S.stakeMin, null, 'stakeMin not cleared: ');
  eq(S.stakeMax, null, 'stakeMax not cleared: ');
  eq(S._stakeAmount, null, 'in-progress amount not cleared: ');

  // and the adapter follows the switch, with the new chain's precision
  eq(window.SAFU.adapter().decimals, 7, 'adapter did not follow the chain switch: ');

  delete CONFIG.CHAINS.testchain;
  S.activeChain = null;
});

// 2026-08-19: chainGeneration() is the shared staleness token wallet.js's
// _renderWallets() and init.js's three async reads all check after an await,
// closing a real bug (rapid chain switching let a slower stale render
// overwrite a faster fresh one — reported as "the WalletConnect button
// disappears" and "chose XLM, form still shows ETH numbers"). Direct
// regression coverage for the primitive itself, not just its callers.
t('chainGeneration() increments on a real chain switch', () => {
  CONFIG.CHAINS.testchain = { ...CONFIG.CHAINS.ethereum, id: 'testchain', decimals: 7 };
  const before = window.SAFU.chainGeneration();
  window.SAFU.setChain('testchain');
  ok(window.SAFU.chainGeneration() > before, 'a real switch must bump the generation token');
  delete CONFIG.CHAINS.testchain;
  window.SAFU.state.activeChain = null;
});

t('chainGeneration() does NOT increment on an idempotent setChain to the same chain', () => {
  // If it bumped on every call regardless of whether the chain actually
  // changed, a caller's own guard check (`gen !== chainGeneration()`) could
  // spuriously fail even with no real race — the exact false-positive shape
  // that would make the wallet list get stuck permanently empty.
  window.SAFU.setChain(CONFIG.DEFAULT_CHAIN);
  const before = window.SAFU.chainGeneration();
  window.SAFU.setChain(CONFIG.DEFAULT_CHAIN);
  eq(window.SAFU.chainGeneration(), before, 'setChain to the SAME chain must not bump the token');
});

t('a staleness check simulating the real race resolves to the NEWER chain, not whichever finished last', () => {
  // Models the actual bug: render A starts (captures gen), a real switch
  // happens (bumps gen), render A "finishes" and checks staleness before
  // writing — must detect it is stale and refuse to write, regardless of
  // finishing after or before render B.
  CONFIG.CHAINS.testchain = { ...CONFIG.CHAINS.ethereum, id: 'testchain', decimals: 7 };
  const genAtRenderAStart = window.SAFU.chainGeneration();
  window.SAFU.setChain('testchain');  // a newer switch supersedes render A mid-flight
  const staleRenderAIsStale = genAtRenderAStart !== window.SAFU.chainGeneration();
  ok(staleRenderAIsStale, 'a superseded render must detect its own staleness');
  delete CONFIG.CHAINS.testchain;
  window.SAFU.state.activeChain = null;
});

// ── invariants every chain entry must satisfy ────────────────────────────────

t('CHAIN_ORDER only names chains that exist in CHAINS', () => {
  CONFIG.CHAIN_ORDER.forEach(id => {
    ok(CONFIG.CHAINS[id], `CHAIN_ORDER names "${id}" which is absent from CHAINS`);
  });
});

t('DEFAULT_CHAIN exists in CHAINS', () => {
  ok(CONFIG.CHAINS[CONFIG.DEFAULT_CHAIN], `DEFAULT_CHAIN "${CONFIG.DEFAULT_CHAIN}" not in CHAINS`);
});

t('every chain declares the fields the adapter and UI depend on', () => {
  const required = [
    'id', 'label', 'assetSymbol', 'tag', 'family', 'status', 'decimals',
    'contract', 'rpcUrl', 'explorerTxBase', 'explorerName',
    'repoUrl', 'verifyPath', 'claimPath', 'apiChain',
    'stakeMinFallback', 'stakeMaxFallback',
  ];
  // Explorer address routing is family-shaped, not universal: Etherscan has one
  // /address/ path for everything, stellar.expert routes accounts and contracts
  // separately. Demanding one flat `explorerAddrBase` everywhere would force a
  // dead field onto Stellar just to satisfy the check.
  const requiredByFamily = {
    evm:     ['explorerAddrBase', 'chainId', 'chainIdHex'],
    stellar: ['explorerAccountBase', 'explorerContractBase', 'networkPassphrase',
              'stakeMinBps', 'stakeMaxBps', 'stakeBpsDenominator'],
  };
  Object.values(CONFIG.CHAINS).forEach(c => {
    required.concat(requiredByFamily[c.family] || []).forEach(k => {
      ok(c[k] !== undefined, `chain "${c.id}" is missing "${k}"`);
    });
    // networkLabel and disclosures may be null/empty but must be declared,
    // because "absent" and "deliberately none" have to be distinguishable.
    ok('networkLabel' in c, `chain "${c.id}" must declare networkLabel (null for mainnet)`);
    ok(Array.isArray(c.disclosures), `chain "${c.id}" must declare disclosures as an array`);
  });
});

t('every chain has an adapter registered for its family', () => {
  Object.values(CONFIG.CHAINS).forEach(c => {
    ok(window.SAFU.adapters[c.family], `no adapter for family "${c.family}" (chain ${c.id})`);
  });
});

t('decimals is a positive integer on every chain', () => {
  Object.values(CONFIG.CHAINS).forEach(c => {
    ok(Number.isInteger(c.decimals) && c.decimals > 0,
      `chain "${c.id}" has invalid decimals: ${c.decimals}`);
  });
});

t('a non-live chain must carry a networkLabel', () => {
  // Enforces the rule that a testnet can never render at parity with mainnet.
  Object.values(CONFIG.CHAINS).forEach(c => {
    if (c.status !== 'live') {
      ok(c.networkLabel, `chain "${c.id}" has status "${c.status}" but no networkLabel`);
    }
  });
});

t('the live Ethereum contract address is the expected V8 pool', () => {
  eq(CONFIG.CHAINS.ethereum.contract, '0xa170f0937DEc353C1806eaC0c3d559524d458641');
  eq(CONFIG.CHAINS.ethereum.chainId, 1);
  eq(CONFIG.CHAINS.ethereum.chainIdHex, '0x1');
});

console.log(`\nchain resolution: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFAILURES:');
  failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  process.exit(1);
}
