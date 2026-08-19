// Unit tests for website/js/adapter-evm.js.
//
// The adapter exists so that no module outside it touches `ethers`, and so that
// amount precision is per-chain rather than hardcoded to 18. The single most
// dangerous defect this guards against: formatting a 7-decimal Stellar amount
// through an 18-decimal path understates it by 10^11, in a UI that displays
// stake amounts and claim entitlements.
//
// `ethers` is stubbed with recording spies rather than loaded for real. That is
// deliberate: what these tests need to prove is that the adapter *passes the
// chain's decimals* and uses the right primitive, not that ethers itself works.
// A spy catches the actual regression (someone reintroducing formatEther, or
// dropping the decimals argument) which a real-ethers test would not surface
// any more clearly.
//
// Run: node tests/website/adapter-evm.test.mjs

import { readFileSync } from 'node:fs';

// ── ethers stub with call recording ─────────────────────────────────────────
const calls = [];
globalThis.ethers = {
  isAddress: a => { calls.push(['isAddress', a]); return /^0x[0-9a-fA-F]{40}$/.test(a); },
  formatUnits: (v, d) => { calls.push(['formatUnits', v, d]); return `fmt(${v},${d})`; },
  parseUnits:  (v, d) => { calls.push(['parseUnits', v, d]);  return `parse(${v},${d})`; },
  solidityPackedKeccak256: (types, vals) => {
    calls.push(['solidityPackedKeccak256', types, vals]);
    return '0xhash';
  },
  Contract: class { constructor(...a) { calls.push(['Contract', ...a]); } },
  JsonRpcProvider: class { constructor(u) { calls.push(['JsonRpcProvider', u]); } },
  // Deliberately absent: formatEther / parseEther. If the adapter regresses to
  // them, these tests throw rather than silently passing.
};
globalThis.window = globalThis;
globalThis.CONFIG = { SAFU_API_BASE: 'https://api.test' };
globalThis.SAFU_ABI = ['dummy'];
window.SAFU_ABI = globalThis.SAFU_ABI;

eval(readFileSync(new URL('../../website/js/adapter-evm.js', import.meta.url), 'utf8'));

// Two chain configs: a live 18-decimal mainnet and a synthetic 7-decimal
// testnet, so precision and the network qualifier are both exercised.
const ETH_CFG = {
  id: 'ethereum', label: 'Ethereum', assetSymbol: 'ETH', tag: 'ETH',
  networkLabel: null, family: 'evm', decimals: 18,
  chainId: 1, chainIdHex: '0x1',
  rpcUrl: 'https://rpc.test', contract: '0xCONTRACT',
  explorerName: 'etherscan',
  explorerTxBase: 'https://etherscan.io/tx/',
  explorerAddrBase: 'https://etherscan.io/address/',
  verifyPath: '/v1/verify', claimPath: '/v1/claim', apiChain: 'eth',
};

const SEVEN_CFG = {
  ...ETH_CFG,
  id: 'sevendec', label: 'SevenDec', assetSymbol: 'XLM', tag: 'XLM',
  networkLabel: 'testnet', decimals: 7,
  verifyPath: '/v1/verify', claimPath: '/v1/claim/stellar', apiChain: 'stellar',
};

const eth = window.SAFU.adapters.evm(ETH_CFG);
const sev = window.SAFU.adapters.evm(SEVEN_CFG);

// ── runner ──────────────────────────────────────────────────────────────────
let pass = 0;
const failures = [];
function t(name, fn) {
  calls.length = 0;
  try { fn(); pass++; } catch (e) { failures.push(`${name}\n    ${e.message}`); }
}
// BigInt-safe serializer — amounts are BigInt, which JSON.stringify throws on.
const ser = v => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x));

function eq(a, b, label = '') {
  if (a !== b) throw new Error(`${label}expected ${ser(b)}, got ${ser(a)}`);
}
function deep(a, b, label = '') {
  if (ser(a) !== ser(b)) {
    throw new Error(`${label}expected ${ser(b)}, got ${ser(a)}`);
  }
}

const ADDR = '0xAbC0000000000000000000000000000000000001';
const ZERO = '0x0000000000000000000000000000000000000000';

// ── decimals: the load-bearing behaviour ────────────────────────────────────

t('formatAmount passes the chain decimals, not a hardcoded 18', () => {
  eth.formatAmount(123n);
  deep(calls[0], ['formatUnits', 123n, 18], 'eth: ');

  calls.length = 0;
  sev.formatAmount(123n);
  deep(calls[0], ['formatUnits', 123n, 7], '7-dec: ');
});

t('parseAmount passes the chain decimals', () => {
  eth.parseAmount('1.5');
  deep(calls[0], ['parseUnits', '1.5', 18], 'eth: ');

  calls.length = 0;
  sev.parseAmount('1.5');
  deep(calls[0], ['parseUnits', '1.5', 7], '7-dec: ');
});

t('two chains never share a decimals value', () => {
  eq(eth.decimals === sev.decimals, false, 'decimals collapsed across chains: ');
});

t('parseAmount coerces a number without throwing', () => {
  sev.parseAmount(2);
  deep(calls[0], ['parseUnits', '2', 7]);
});

// ── validation ──────────────────────────────────────────────────────────────

t('isValidAddress delegates and accepts a real address', () => {
  eq(eth.isValidAddress(ADDR), true);
});

t('isValidAddress rejects non-strings without throwing', () => {
  eq(eth.isValidAddress(null), false);
  eq(eth.isValidAddress(undefined), false);
  eq(eth.isValidAddress(12345), false);
});

t('isZeroAddress catches what isValidAddress lets through', () => {
  // The contract rejects the zero address with "zero beneficiary", and
  // ethers.isAddress returns true for it, so this must be a separate check.
  eq(eth.isValidAddress(ZERO), true, 'precondition: ');
  eq(eth.isZeroAddress(ZERO), true);
  eq(eth.isZeroAddress(ADDR), false);
});

t('sameAddress is case-insensitive for EVM and null-safe', () => {
  eq(eth.sameAddress(ADDR, ADDR.toLowerCase()), true);
  eq(eth.sameAddress(ADDR, ZERO), false);
  eq(eth.sameAddress(null, ADDR), false);
  eq(eth.sameAddress(ADDR, undefined), false);
});

t('isValidTxHash requires the 0x prefix and exactly 64 hex', () => {
  const h = '0x' + 'a'.repeat(64);
  eq(eth.isValidTxHash(h), true);
  eq(eth.isValidTxHash('a'.repeat(64)), false, 'accepted a prefixless hash: ');
  eq(eth.isValidTxHash('0x' + 'a'.repeat(63)), false, 'accepted 63 chars: ');
  eq(eth.isValidTxHash('0x' + 'a'.repeat(65)), false, 'accepted 65 chars: ');
  eq(eth.isValidTxHash('0x' + 'z'.repeat(64)), false, 'accepted non-hex: ');
  eq(eth.isValidTxHash(null), false);
});

t('isValidClaimId matches bytes32 shape', () => {
  eq(eth.isValidClaimId('0x' + '1'.repeat(64)), true);
  eq(eth.isValidClaimId('0x' + '1'.repeat(63)), false);
});

// ── contract preimage ───────────────────────────────────────────────────────

t('hashBeneficiary uses solidityPackedKeccak256 over a single address', () => {
  // Must equal keccak256(abi.encodePacked(beneficiary)) — the preimage
  // SAFUPoolV8.sol uses at :147, :272, :323, :544. Encoding it any other way
  // (abi.encode, or adding a salt) produces a hash the contract will reject.
  const out = eth.hashBeneficiary(ADDR);
  eq(out, '0xhash');
  deep(calls[0], ['solidityPackedKeccak256', ['address'], [ADDR]]);
});

// ── tag / network qualifier ─────────────────────────────────────────────────

t('tag omits the qualifier on an unmarked mainnet', () => {
  eq(eth.tag(), 'ETH');
});

t('tag always appends the qualifier when the chain declares one', () => {
  // A testnet must never render at visual parity with a live mainnet.
  eq(sev.tag(), 'XLM · testnet');
});

// ── links + api routing ─────────────────────────────────────────────────────

t('explorer URLs come from the chain config', () => {
  eq(eth.explorerTxUrl('0xdeadbeef'), 'https://etherscan.io/tx/0xdeadbeef');
  eq(eth.explorerAddrUrl(ADDR), `https://etherscan.io/address/${ADDR}`);
  eq(eth.explorerName(), 'etherscan');
});

t('api paths are per-chain, so the Stellar claim endpoint can differ', () => {
  eq(eth.claimUrl(), 'https://api.test/v1/claim');
  eq(sev.claimUrl(), 'https://api.test/v1/claim/stellar', 'claim path not chain-scoped: ');
  eq(eth.verifyUrl(), 'https://api.test/v1/verify');
  eq(eth.verifyJobUrl('job-1'), 'https://api.test/v1/verify/job-1');
  eq(eth.apiChain(), 'eth');
  eq(sev.apiChain(), 'stellar');
});

// ── network access ──────────────────────────────────────────────────────────

t('readContract builds against the chain contract and rpc', () => {
  eth.readContract();
  deep(calls[0], ['JsonRpcProvider', 'https://rpc.test']);
  eq(calls[1][0], 'Contract');
  eq(calls[1][1], '0xCONTRACT');
});

t('signerContract binds the chain contract to the given signer', () => {
  eth.signerContract('SIGNER');
  eq(calls[0][0], 'Contract');
  eq(calls[0][1], '0xCONTRACT');
  eq(calls[0][3], 'SIGNER');
});

t('family is reported as evm', () => {
  eq(eth.family, 'evm');
  eq(eth.id, 'ethereum');
  eq(eth.assetSymbol, 'ETH');
});

// ── report ──────────────────────────────────────────────────────────────────
console.log(`\nadapter-evm: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFAILURES:');
  failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  process.exit(1);
}
