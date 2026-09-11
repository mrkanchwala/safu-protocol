// Tests for js/loader.js, js/connector-stellar.js, and the adapters' normalised
// stake-record layer.
//
// These cover the parts of Phase 2c where being wrong is silent rather than
// loud: a loader that resolves without registering its global, a Freighter call
// whose error is RETURNED rather than thrown, and a stake record whose field
// name differs between the deployed T1 contract and T2 source.
//
// Run: node tests/website/connectors.test.mjs

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

// minimal DOM for loader.js
const appended = [];
globalThis.document = {
  head: { appendChild(el) { appended.push(el); } },
  createElement: () => ({ src: '', async: false, onload: null, onerror: null }),
  addEventListener: () => {},
  getElementById: () => null,
  querySelectorAll: () => [],
};

const src = f => readFileSync(new URL(`../../website/js/${f}`, import.meta.url), 'utf8');
eval(src('stellar-sdk.min.js'));
const load = f => eval(src(f));

load('config.js');
load('abi.js');
load('state.js');
load('loader.js');
load('adapter-evm.js');
load('adapter-stellar.js');
load('chain.js');
load('connector-stellar.js');

let pass = 0;
const failures = [];
function t(name, fn) { try { fn(); pass++; } catch (e) { failures.push(`${name}\n    ${e.message}`); } }
async function ta(name, fn) { try { await fn(); pass++; } catch (e) { failures.push(`${name}\n    ${e.message}`); } }
function eq(a, b, l = '') { if (a !== b) throw new Error(`${l}expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function ok(c, m) { if (!c) throw new Error(m); }
async function rejects(p, m) {
  try { await p; } catch { return; }
  throw new Error(m || 'expected a rejection');
}

const ST = window.SAFU.adapter('stellar');
const EV = window.SAFU.adapter('ethereum');

// ── loader ──────────────────────────────────────────────────────────────────

await ta('loadScript resolves immediately when the global is already present', async () => {
  const before = appended.length;
  const r = await window.SAFU.loadScript('js/stellar-sdk.min.js', 'StellarSdk');
  ok(r === window.StellarSdk, 'should return the existing global');
  eq(appended.length, before, 'must not inject a second <script>: ');
});

await ta('loadScript REJECTS when the file loads but registers no global', async () => {
  // The failure this prevents: a silent resolve, then a TypeError much later
  // from inside an adapter where the cause is no longer visible.
  const p = window.SAFU.loadScript('js/nonexistent-bundle.js', 'NotARealGlobal');
  const el = appended[appended.length - 1];
  el.onload();
  await rejects(p, 'must reject when the promised global is absent');
});

await ta('a failed load is not cached — a retry actually retries', async () => {
  const p1 = window.SAFU.loadScript('js/flaky.js', 'Flaky');
  appended[appended.length - 1].onerror();
  await rejects(p1);

  const before = appended.length;
  const p2 = window.SAFU.loadScript('js/flaky.js', 'Flaky');
  ok(appended.length === before + 1, 'retry must inject a fresh script tag');
  appended[appended.length - 1].onerror();
  await rejects(p2);
});

// ── connector-stellar: multi-wallet via Stellar Wallets Kit modules ─────────
//
// 2026-08-19: connector-stellar.js was rewritten from a hand-rolled
// Freighter-only implementation (window.freighterApi, which RETURNS its
// errors rather than throwing) to 7 kit modules under
// window.SAFUStellarWalletModules.modules, each implementing the kit's own
// ModuleInterface — getAddress()/signTransaction()/getNetwork() THROW on
// failure rather than returning {error}. Every test below now mocks that
// shape. The safety properties being tested (reject on no address, check the
// PASSPHRASE not the label, verify the signer matches, refuse cross-family
// use) are unchanged — this rewrite generalized them across modules, it did
// not relax any of them.

const CONN = window.SAFU.connectors.stellar;
// Real keypairs, not fixed strings: signing is verified cryptographically
// (_verifySignature, 2026-09-11), so mocks must return genuinely signed
// envelopes.
const KP   = StellarSdk.Keypair.random();
const KP2  = StellarSdk.Keypair.random();
const ACC  = KP.publicKey();
const ACC2 = KP2.publicKey();
// Follow whatever network config.js points Stellar at. These tests hard-coded
// the testnet passphrase and broke when 37a1d50 moved Stellar to mainnet —
// 5 of them were failing before the 2026-09-11 connect fix.
window.SAFU.setChain('stellar');
const PASS  = window.SAFU.chain().networkPassphrase;
const OTHER = PASS.startsWith('Public')
  ? 'Test SDF Network ; September 2015'
  : 'Public Global Stellar Network ; September 2015';

// A genuinely signed envelope — the shape a real wallet returns.
function signedBy(kp, passphrase = PASS) {
  const tx = new StellarSdk.TransactionBuilder(new StellarSdk.Account(kp.publicKey(), '1'), {
    fee: '100', networkPassphrase: passphrase,
  })
    .addOperation(StellarSdk.Operation.bumpSequence({ bumpTo: '2' }))
    .setTimeout(30)
    .build();
  tx.sign(kp);
  return tx.toXDR();
}

function mockModule(overrides) {
  const mod = Object.assign({
    productName:  'Freighter',
    isAvailable:  async () => true,
    getAddress:   async () => ({ address: ACC }),
    getNetwork:   async () => ({ network: 'PUBLIC', networkPassphrase: PASS }),
    signTransaction: async () => ({ signedTxXdr: signedBy(KP), signerAddress: ACC }),
  }, overrides);
  window.SAFUStellarWalletModules = { modules: { freighter: mod } };
  return mod;
}

function connectOption() {
  // The connector is only ever reached with its own family active; wallet.js
  // resolves connectors by window.SAFU.chain().family.
  window.SAFU.setChain('stellar');
  return CONN.options().then(o => o[0]);
}

await ta('a rejected access request THROWS instead of connecting with an empty address', async () => {
  // Kit modules throw on a declined permission prompt — a connector that
  // swallowed the throw and fell back to some default would connect nobody
  // while looking successful.
  mockModule({ getAddress: async () => { throw new Error('User declined'); } });
  const opt = await connectOption();
  await rejects(opt.connect(), 'must reject a declined access request');
});

await ta('an empty address with no thrown error still throws', async () => {
  mockModule({ getAddress: async () => ({ address: '' }) });
  const opt = await connectOption();
  await rejects(opt.connect(), 'empty address must never be accepted');
});

await ta('a network-passphrase mismatch is refused, and it checks the PASSPHRASE not the name', async () => {
  // The label can name the right network while the passphrase is another's;
  // the passphrase is what every signature is domain-separated by.
  mockModule({
    getNetwork: async () => ({ network: 'PUBLIC', networkPassphrase: OTHER }),
  });
  const opt = await connectOption();
  await rejects(opt.connect(), 'mismatched passphrase must be refused');
});

await ta('a valid connect returns the address', async () => {
  mockModule({});
  const opt = await connectOption();
  const r = await opt.connect();
  eq(r.address, ACC);
});

await ta('a network read that throws is refused, not treated as a pass', async () => {
  // Isolates the getNetwork() failure path — every other guard passes here
  // (address is real). Without an explicit try/catch around getNetwork(), a
  // thrown error would propagate as an unlabelled exception instead of a
  // clear "could not read network" message.
  mockModule({ getNetwork: async () => { throw new Error('wallet locked'); } });
  const opt = await connectOption();
  await rejects(opt.connect(), 'a getNetwork() failure must be refused');
});

await ta('a wallet that reports getNetwork() as UNSUPPORTED (kit code -3) still connects', async () => {
  // xBull, Albedo, Hana, LOBSTR, Rabet and WalletConnect all do exactly this
  // (kit 2.5.0 source). Refusing it is the bug that left Freighter as the only
  // wallet that could ever connect. Their network is enforced at signing.
  mockModule({
    getNetwork: async () => { throw { code: -3, message: 'X does not support the "getNetwork" function' }; },
  });
  const opt = await connectOption();
  eq((await opt.connect()).address, ACC);
});

await ta('an empty address is refused AS an access failure, not as a bad address', async () => {
  // Isolates the empty-address guard from the strkey validation that would
  // otherwise also reject '' — the distinction matters because the two produce
  // different, differently actionable messages for the user.
  mockModule({ getAddress: async () => ({ address: '' }) });
  const opt = await connectOption();
  let msg = '';
  try { await opt.connect(); } catch (e) { msg = e.message; }
  ok(/no address|not granted/i.test(msg),
    `expected an access-not-granted message, got: ${msg}`);
});

await ta('an address the adapter cannot validate is refused', async () => {
  mockModule({ getAddress: async () => ({ address: 'not-a-strkey' }) });
  const opt = await connectOption();
  await rejects(opt.connect(), 'invalid strkey must be refused');
});

await ta('signing refuses a signature from a DIFFERENT account than the connected one', async () => {
  // Real hazard: the user switches account in the wallet between connect and
  // sign. The contract requires auth from the staker, so this would fail
  // on-chain after the user had already approved a prompt.
  mockModule({ signTransaction: async () => ({ signedTxXdr: signedBy(KP2), signerAddress: ACC2 }) });
  const opt = await connectOption();
  await opt.connect();  // sets state._stellarModule to this mock
  window.SAFU.state.walletAddress = ACC;
  await rejects(CONN.signTransaction('xdr'), 'account switch must be caught');
  window.SAFU.state.walletAddress = null;
});

await ta('signing rejects an empty signed XDR', async () => {
  mockModule({ signTransaction: async () => ({ signedTxXdr: '' }) });
  const opt = await connectOption();
  await opt.connect();
  window.SAFU.state.walletAddress = ACC;
  await rejects(CONN.signTransaction('xdr'), 'empty signature must be rejected');
  window.SAFU.state.walletAddress = null;
});

// Helper for the signature-verification cases below: connect with the default
// mock, then sign as the connected account.
async function signWith(signTransaction) {
  mockModule({ signTransaction });
  const opt = await connectOption();
  await opt.connect();
  window.SAFU.state.walletAddress = ACC;
  try { return await CONN.signTransaction('xdr'); }
  finally { window.SAFU.state.walletAddress = null; }
}

await ta('signing with NO signerAddress succeeds when the signature itself is from the connected account', async () => {
  // LOBSTR, Rabet and WalletConnect never report a signer. The pre-fix rule
  // required one, so none of them could ever sign. The signature proves it.
  const xdr = signedBy(KP);
  eq(await signWith(async () => ({ signedTxXdr: xdr })), xdr);
});

await ta('signing with NO signerAddress is still refused when a DIFFERENT key signed', async () => {
  // The case the old "signerAddress required" rule existed for. With no
  // reported signer this must still fail closed — now via the signature.
  await rejects(signWith(async () => ({ signedTxXdr: signedBy(KP2) })),
    'a signature from another key must be refused');
});

await ta('a reported signerAddress cannot vouch for a signature that does not verify', async () => {
  // The wallet names the right account but the bytes are another key's.
  await rejects(signWith(async () => ({ signedTxXdr: signedBy(KP2), signerAddress: ACC })),
    'a claimed signer must not override the signature bytes');
});

await ta('a signature made for a DIFFERENT network is refused', async () => {
  // This is where the network is enforced for wallets whose getNetwork() is
  // unsupported: the passphrase is inside the signed hash.
  await rejects(signWith(async () => ({ signedTxXdr: signedBy(KP, OTHER), signerAddress: ACC })),
    'a signature for another network must be refused');
});

await ta('signing with no wallet module selected is refused, not a silent no-op', async () => {
  mockModule({});
  window.SAFU.state._stellarModule = null;
  window.SAFU.state.walletAddress = ACC;
  await rejects(CONN.signTransaction('xdr'), 'signing before connect must be refused');
  window.SAFU.state.walletAddress = null;
});

await ta('the Stellar connector REFUSES to run while an EVM chain is active', async () => {
  // Guards against a caller reaching the wrong connector and getting a
  // misleading "wrong network" message aimed at the user's wallet.
  mockModule({});
  window.SAFU.setChain('ethereum');
  await rejects(CONN.signTransaction('xdr'), 'must refuse when family does not match');
  window.SAFU.setChain('stellar');
});

await ta('options() skips a module whose isAvailable() times out', async () => {
  // Live-tested against the real bundle 2026-08-19: Freighter and Lobstr hang
  // past the kit's own documented 1000ms contract with no extension
  // installed. A slow module must not stall or crash the whole wallet list.
  window.SAFU.setChain('stellar');
  const fastMod = {
    productName: 'Fast', isAvailable: async () => true,
    getAddress: async () => ({ address: ACC }),
    getNetwork: async () => ({ network: 'PUBLIC', networkPassphrase: PASS }),
    signTransaction: async () => ({ signedTxXdr: signedBy(KP), signerAddress: ACC }),
  };
  window.SAFUStellarWalletModules = {
    modules: { slow: { productName: 'Slow', isAvailable: () => new Promise(() => {}) }, fast: fastMod },
  };
  const opts = await CONN.options();
  // WalletConnect is always appended — nothing to detect (since 37a1d50).
  eq(opts.map(o => o.name).join(','), 'Fast,WalletConnect',
    'the hanging module must be excluded, not block the list');
});

t('Stellar wallet modules have no programmatic disconnect and do not pretend otherwise', () => {
  // Access is a standing per-origin permission the USER controls in each
  // wallet. Claiming to revoke it would be a false statement about what this
  // page can do.
  eq(typeof CONN.disconnect, 'function');
  CONN.disconnect();
});

// ── normalised stake records ────────────────────────────────────────────────

const HASH_BYTES = new Uint8Array(32).fill(0xab);
const HASH_HEX = 'ab'.repeat(32);

await ta('Stellar record reads the DEPLOYED T1 field name (claim_active)', async () => {
  ST._simulate = async () => ({
    amount: 1200000000n, withdrawn: false, claim_active: true, suspended: false,
    staked_at_timestamp: 1755000000, penalty_locked_until_ledger: 0,
    beneficiary_hash: HASH_BYTES,
  });
  const r = await ST.readStakeRecord(ACC);
  eq(r.claimActive, true);
  eq(r.exists, true);
  eq(r.amountRaw, 1200000000n);
  eq(r.beneficiaryHash, HASH_HEX);
});

await ta('Stellar record ALSO reads the T2 source field name (active_claim_id)', async () => {
  // Reading only one of the two names breaks on one side of the redeploy.
  ST._simulate = async () => ({
    amount: 1n, withdrawn: false, active_claim_id: HASH_BYTES, suspended: false,
    staked_at_timestamp: 1, penalty_locked_until_ledger: 0, beneficiary_hash: HASH_BYTES,
  });
  eq((await ST.readStakeRecord(ACC)).claimActive, true);
});

await ta('T2 shape with no active claim reports claimActive false', async () => {
  ST._simulate = async () => ({
    amount: 1n, withdrawn: false, active_claim_id: null, suspended: false,
    staked_at_timestamp: 1, penalty_locked_until_ledger: 0, beneficiary_hash: HASH_BYTES,
  });
  eq((await ST.readStakeRecord(ACC)).claimActive, false);
});

await ta('a None record reports exists:false rather than throwing', async () => {
  ST._simulate = async () => null;
  const r = await ST.readStakeRecord(ACC);
  eq(r.exists, false);
  eq(r.amountRaw, 0n);
  eq(r.beneficiaryHash, null);
});

await ta('a penalty lock renders as a LEDGER, never as a fabricated date', async () => {
  ST._simulate = async () => ({
    amount: 1n, withdrawn: false, claim_active: false, suspended: false,
    staked_at_timestamp: 1, penalty_locked_until_ledger: 987654,
    beneficiary_hash: HASH_BYTES,
  });
  const r = await ST.readStakeRecord(ACC);
  eq(r.penaltyLockLabel, 'ledger 987654');
  ok(!/\d{4}/.test(r.penaltyLockLabel.replace('987654', '')), 'must not contain a year');
});

await ta('EVM record humanises its penalty lock as a DATE, because V8 stores a timestamp', async () => {
  EV.readContract = () => ({
    stakeOf: async () => ({
      amount: 10n ** 16n, withdrawn: false, claimActive: false, suspended: false,
      stakedAt: 1755000000n, penaltyLockedUntil: 1760000000n, beneficiaryHash: '0x' + 'cd'.repeat(32),
    }),
  });
  const r = await EV.readStakeRecord('0xa170f0937DEc353C1806eaC0c3d559524d458641');
  ok(r.penaltyLockLabel && /\d/.test(r.penaltyLockLabel), 'expected a date-ish label');
  ok(!r.penaltyLockLabel.includes('ledger'), 'EVM must not say ledger');
  eq(r.stakedAtSeconds, 1755000000);
});

t('the two families label a confirmation reference differently', () => {
  eq(EV.blockLabel, 'block');
  eq(ST.blockLabel, 'ledger');
});

await ta('Stellar reports no total-ever-staked rather than substituting a number', async () => {
  // Soroban has no total_ever_staked; the OG-staker badge is EVM-only.
  eq(await ST.readTotalEverStaked(), null);
});

// ── report ──────────────────────────────────────────────────────────────────
console.log(`\nconnectors: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  failures.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
}
