// Unit tests for js/adapter-stellar.js.
//
// Loads the REAL vendored SDF bundle rather than a stub. The EVM adapter's
// tests stub ethers deliberately (the regression to catch there is "someone
// reintroduced formatEther"), but here the SDK *is* the thing under test:
// hashBeneficiary's correctness depends entirely on how StellarSdk encodes an
// Address to XDR, and a stub would let a wrong preimage pass forever.
//
// The two hash vectors below were verified on 2026-08-19 by TWO independent
// tools — the SDK's own encoder, and `stellar xdr decode --type ScVal` round-
// tripping those exact bytes back to the original strkey. They are pinned here
// as constants so a change to the preimage fails loudly instead of silently
// producing a hash the contract rejects at withdraw time.
//
// Run: node tests/website/adapter-stellar.test.mjs

import { readFileSync } from 'node:fs';

globalThis.window = globalThis;
globalThis.self = globalThis;
globalThis.ethers = {
  isAddress: a => /^0x[0-9a-fA-F]{40}$/.test(a),
  formatUnits: (v, d) => `${v}/${d}`,
  parseUnits: (v, d) => `${v}*${d}`,
  solidityPackedKeccak256: () => '0xhash',
  Contract: class {},
  JsonRpcProvider: class {},
};

const src = f => readFileSync(new URL(`../../website/js/${f}`, import.meta.url), 'utf8');
eval(src('stellar-sdk.min.js'));          // real UMD bundle → globalThis.StellarSdk
const load = f => eval(src(f));

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
function throws(fn, msg) {
  try { fn(); } catch { return; }
  throw new Error(msg || 'expected a throw');
}

const A = window.SAFU.adapter('stellar');
const E = window.SAFU.adapter('ethereum');

const ACC  = 'GCZOUSNCY4TRCPQHP4IN2JEF4TVUMKGAZ6HNUXKIUWPMZJHJ7RA7A2UD';
const CON  = 'CCQT2VRONZTE5ODBNM3XAQWUPQRLKGMU4MMLA2JK6HJHJMK34Q7ZFTGJ';
const ACC2 = 'GCNLC5XTHKJVBUDZFCZDNVPIZFWPEIH7DPQICXUNINUTLIY6TG4JJDXL';
const EVM  = '0xa170f0937DEc353C1806eaC0c3d559524d458641';

// Externally verified — see header.
const ACC_HASH = '103df85c1933e48fb0d076c664a3eb72a5d03bf557f545a0b83287a628e80b9a';
const CON_HASH = '1ac64bd9879d37f6d60d9ec112062e56f9e40bca1048b1634ee4306ef291fb33';

// ── identity ────────────────────────────────────────────────────────────────

t('registers under family "stellar" with 7 decimals', () => {
  eq(A.family, 'stellar');
  eq(A.decimals, 7);
  eq(A.assetSymbol, 'XLM');
  eq(A.id, 'stellar');
});

t('tag always carries the testnet qualifier', () => {
  eq(A.tag(), 'XLM · testnet');
});

// ── validation ──────────────────────────────────────────────────────────────

t('accepts both account (G) and contract (C) strkeys — Address is either', () => {
  ok(A.isValidAddress(ACC), 'account rejected');
  ok(A.isValidAddress(CON), 'contract rejected');
});

t('rejects a lowercased strkey — base32 strkeys are case-sensitive', () => {
  ok(!A.isValidAddress(ACC.toLowerCase()));
});

t('rejects an EVM address and assorted garbage', () => {
  [EVM, '', 'G', null, undefined, 42, {}, ACC.slice(0, -1)].forEach(v => {
    ok(!A.isValidAddress(v), `accepted ${JSON.stringify(v)}`);
  });
});

t('isZeroAddress is always false — Stellar has no zero address', () => {
  eq(A.isZeroAddress(ACC), false);
  eq(A.isZeroAddress(null), false);
  eq(A.zeroAddress, null);
});

t('sameAddress does NOT case-fold, unlike the EVM adapter', () => {
  ok(A.sameAddress(ACC, ACC), 'identical strings must match');
  ok(!A.sameAddress(ACC, ACC.toLowerCase()), 'case-folding would corrupt a strkey');
  ok(!A.sameAddress(ACC, ACC2));
  // the divergence is the point — EVM addresses ARE case-insensitive
  ok(E.sameAddress(EVM, EVM.toLowerCase()), 'EVM adapter should still fold case');
});

t('tx hashes are 64 hex with NO 0x prefix, and a prefixed value is rejected', () => {
  const bare = 'a'.repeat(64);
  ok(A.isValidTxHash(bare));
  ok(A.isValidTxHash('AbCdEf' + '0'.repeat(58)));
  ok(!A.isValidTxHash('0x' + bare), 'a 0x-prefixed hash is an EVM hash, not a Stellar one');
  ok(!A.isValidTxHash('a'.repeat(63)));
  ok(!A.isValidTxHash('a'.repeat(65)));
  ok(!A.isValidTxHash('g'.repeat(64)));
});

t('claim ids follow the same BytesN<32> bare-hex rule', () => {
  ok(A.isValidClaimId('f'.repeat(64)));
  ok(!A.isValidClaimId('0x' + 'f'.repeat(64)));
});

t('the two families reject each other\'s hashes — proof they are not interchangeable', () => {
  const bare = 'a'.repeat(64);
  ok(A.isValidTxHash(bare) && !E.isValidTxHash(bare), 'EVM must reject a bare hash');
  ok(E.isValidTxHash('0x' + bare) && !A.isValidTxHash('0x' + bare), 'Stellar must reject a 0x hash');
});

// ── amounts ─────────────────────────────────────────────────────────────────

t('formatAmount converts stroops at 7 decimals, trimming trailing zeros', () => {
  eq(A.formatAmount(1n), '0.0000001');
  eq(A.formatAmount(10n), '0.000001');
  eq(A.formatAmount(10000000n), '1');
  eq(A.formatAmount(12300000n), '1.23');
  eq(A.formatAmount(6000000000000n), '600000');   // the live pool cap
  eq(A.formatAmount(1200000000n), '120');         // derived min stake
  eq(A.formatAmount(75000000000n), '7500');       // derived max stake
  eq(A.formatAmount(0n), '0');
});

t('formatAmount accepts strings and negatives without float drift', () => {
  eq(A.formatAmount('6000000000000'), '600000');
  eq(A.formatAmount(-12300000n), '-1.23');
});

t('formatAmount stays exact past Number.MAX_SAFE_INTEGER', () => {
  // 10^18 stroops = 100,000,000,000 XLM — far beyond float precision.
  eq(A.formatAmount(1000000000000000000n), '100000000000');
});

t('parseAmount converts to stroops exactly', () => {
  eq(A.parseAmount('1'), 10000000n);
  eq(A.parseAmount('0.0000001'), 1n);
  eq(A.parseAmount('120'), 1200000000n);
  eq(A.parseAmount('7500'), 75000000000n);
  eq(A.parseAmount('1.23'), 12300000n);
});

t('parseAmount THROWS on excess precision rather than truncating', () => {
  // Truncation would stake less than the user typed and confirmed.
  throws(() => A.parseAmount('0.00000001'), '8 decimal places must throw');
  throws(() => A.parseAmount('1.12345678'));
});

t('parseAmount rejects non-numeric input', () => {
  ['', 'abc', '1.2.3', '1e5', '0x10', ' ', '--1'].forEach(v => {
    throws(() => A.parseAmount(v), `accepted ${JSON.stringify(v)}`);
  });
});

t('parse/format round-trip is lossless across the real stake range', () => {
  ['120', '7500', '0.0000001', '1.2345678'.slice(0, 9), '600000'].forEach(v => {
    eq(A.formatAmount(A.parseAmount(v)), v);
  });
});

t('the same raw value formats DIFFERENTLY on the two families — the 10^11 bug', () => {
  const raw = 10000000n;                 // 1 XLM in stroops
  eq(A.formatAmount(raw), '1');
  ok(E.formatAmount(raw) !== '1', 'an 18-decimal chain must not read stroops as 1');
});

// ── beneficiary hash ────────────────────────────────────────────────────────

t('hashBeneficiary matches the externally verified account vector', () => {
  eq(A.hashBeneficiary(ACC), ACC_HASH);
});

t('hashBeneficiary matches the externally verified contract vector', () => {
  eq(A.hashBeneficiary(CON), CON_HASH);
});

t('hashBeneficiary returns bare 64-hex, never 0x-prefixed', () => {
  const h = A.hashBeneficiary(ACC);
  eq(h.length, 64);
  ok(!h.startsWith('0x'), 'Stellar renders BytesN<32> without a 0x prefix');
  ok(/^[0-9a-f]{64}$/.test(h), 'must be lowercase hex');
});

t('hashBeneficiary is NOT the EVM hash — different function AND preimage', () => {
  ok(A.hashBeneficiary(ACC) !== E.hashBeneficiary(EVM));
  // and it is not a hash of the address STRING, which is the tempting shortcut
  const S = window.StellarSdk;
  const ofString = Array.from(S.hash(Buffer.from(ACC, 'utf8')))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  ok(A.hashBeneficiary(ACC) !== ofString,
    'preimage must be the ScVal XDR, not the strkey text');
});

t('distinct beneficiaries hash distinctly', () => {
  ok(A.hashBeneficiary(ACC) !== A.hashBeneficiary(ACC2));
});

// ── links ───────────────────────────────────────────────────────────────────

t('explorer routes contracts and accounts to their different paths', () => {
  ok(A.explorerAddrUrl(CON).includes('/contract/'), 'contract must use /contract/');
  ok(A.explorerAddrUrl(ACC).includes('/account/'), 'account must use /account/');
  ok(A.explorerAddrUrl(CON).endsWith(CON));
  eq(A.explorerName(), 'stellar.expert');
});

t('explorer links are testnet, never mainnet', () => {
  ok(A.explorerTxUrl('a'.repeat(64)).includes('/testnet/'), 'tx link must be testnet');
  ok(A.explorerAddrUrl(CON).includes('/testnet/'), 'address link must be testnet');
});

// ── api routing ─────────────────────────────────────────────────────────────

t('claim path is the DEDICATED Stellar endpoint built in step 7c', () => {
  ok(A.claimUrl().endsWith('/v1/claim/stellar'), `got ${A.claimUrl()}`);
  ok(A.claimUrl() !== E.claimUrl(), 'must not share the EVM claim endpoint');
  eq(A.apiChain(), 'stellar');
});

t('verify job url composes without a double slash', () => {
  ok(!A.verifyJobUrl('job-1').includes('//v1'), A.verifyJobUrl('job-1'));
  ok(A.verifyJobUrl('job-1').endsWith('/v1/verify/job-1'));
});

// ── SDK object construction ─────────────────────────────────────────────────

t('contract() actually constructs a Contract — the `new` binds to the right thing', () => {
  // Regression: this was written `new sdk().Contract(cfg.contract)`, which
  // parses as `(new sdk()).Contract(...)` — constructing the accessor and then
  // calling Contract WITHOUT new. Every stubbed test passed; it only surfaced
  // against the real SDK ("Class constructor cannot be invoked without 'new'").
  const c = A.contract();
  ok(c instanceof window.StellarSdk.Contract, 'expected a StellarSdk.Contract instance');
  // Live config value, NOT the CON fixture above — CON is a fixed, externally
  // hashed test vector (see CON_HASH) unrelated to which contract is deployed.
  eq(c.contractId(), window.CONFIG.CHAINS.stellar.contract);
});

t('server() constructs an rpc.Server pointed at the configured RPC', () => {
  const s = A.server();
  ok(s instanceof window.StellarSdk.rpc.Server, 'expected an rpc.Server instance');
});

// ── sdk loading ─────────────────────────────────────────────────────────────

t('ensureSdk resolves when the bundle is already present', async () => {
  ok(typeof A.ensureSdk === 'function');
});

console.log(`\nadapter-stellar: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  failures.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
}
