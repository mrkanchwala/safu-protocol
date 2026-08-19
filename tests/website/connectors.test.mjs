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

// ── connector-stellar: freighter returns errors, it does not throw ──────────

const CONN = window.SAFU.connectors.stellar;
const ACC  = 'GCZOUSNCY4TRCPQHP4IN2JEF4TVUMKGAZ6HNUXKIUWPMZJHJ7RA7A2UD';
const ACC2 = 'GCNLC5XTHKJVBUDZFCZDNVPIZFWPEIH7DPQICXUNINUTLIY6TG4JJDXL';
const PASS = 'Test SDF Network ; September 2015';

function mockFreighter(overrides) {
  window.freighterApi = Object.assign({
    isConnected:     async () => ({ isConnected: true }),
    requestAccess:   async () => ({ address: ACC }),
    getNetwork:      async () => ({ network: 'TESTNET', networkPassphrase: PASS }),
    signTransaction: async () => ({ signedTxXdr: 'AAA=', signerAddress: ACC }),
  }, overrides);
  window.freighter = true;
}

function connectOption() {
  // The connector is only ever reached with its own family active; wallet.js
  // resolves connectors by window.SAFU.chain().family.
  window.SAFU.setChain('stellar');
  return CONN.options().then(o => o[0]);
}

await ta('a rejected access request THROWS instead of connecting with an empty address', async () => {
  // freighter resolves { address: '', error } — a try/catch-only connector
  // would treat this as success and connect nobody.
  mockFreighter({ requestAccess: async () => ({ address: '', error: { message: 'User declined' } }) });
  const opt = await connectOption();
  await rejects(opt.connect(), 'must reject a declined access request');
});

await ta('an empty address with NO error object still throws', async () => {
  mockFreighter({ requestAccess: async () => ({ address: '' }) });
  const opt = await connectOption();
  await rejects(opt.connect(), 'empty address must never be accepted');
});

await ta('a network-passphrase mismatch is refused, and it checks the PASSPHRASE not the name', async () => {
  // The label can say TESTNET while the passphrase is mainnet's; the passphrase
  // is what every signature is domain-separated by.
  mockFreighter({
    getNetwork: async () => ({ network: 'TESTNET', networkPassphrase: 'Public Global Stellar Network ; September 2015' }),
  });
  const opt = await connectOption();
  await rejects(opt.connect(), 'mismatched passphrase must be refused');
});

await ta('a valid connect returns the address', async () => {
  mockFreighter({});
  const opt = await connectOption();
  const r = await opt.connect();
  eq(r.address, ACC);
});

await ta('an error alongside a VALID-LOOKING value is still refused', async () => {
  // Isolates the .error check itself. Every other guard passes here: the
  // address is real, the passphrase matches. Only _unwrap sees the problem.
  // Without it, a call freighter reported as failed would be treated as good
  // data — the same "degraded result read as a clean result" shape the scanner
  // audit chased out of the backend.
  mockFreighter({
    getNetwork: async () => ({ network: 'TESTNET', networkPassphrase: PASS, error: { message: 'internal error' } }),
  });
  const opt = await connectOption();
  await rejects(opt.connect(), 'a returned error must be refused even when the value looks usable');
});

await ta('an empty address is refused AS an access failure, not as a bad address', async () => {
  // Isolates the empty-address guard from the strkey validation that would
  // otherwise also reject '' — the distinction matters because the two produce
  // different, differently actionable messages for the user.
  mockFreighter({ requestAccess: async () => ({ address: '' }) });
  const opt = await connectOption();
  let msg = '';
  try { await opt.connect(); } catch (e) { msg = e.message; }
  ok(/no address|not granted/i.test(msg),
    `expected an access-not-granted message, got: ${msg}`);
});

await ta('an address the adapter cannot validate is refused', async () => {
  mockFreighter({ requestAccess: async () => ({ address: 'not-a-strkey' }) });
  const opt = await connectOption();
  await rejects(opt.connect(), 'invalid strkey must be refused');
});

await ta('signing refuses a signature from a DIFFERENT account than the connected one', async () => {
  // Real hazard: the user switches account in the extension between connect and
  // sign. The contract requires auth from the staker, so this would fail
  // on-chain after the user had already approved a prompt.
  mockFreighter({ signTransaction: async () => ({ signedTxXdr: 'AAA=', signerAddress: ACC2 }) });
  window.SAFU.state.walletAddress = ACC;
  await rejects(CONN.signTransaction('xdr'), 'account switch must be caught');
  window.SAFU.state.walletAddress = null;
});

await ta('signing rejects an empty signed XDR', async () => {
  mockFreighter({ signTransaction: async () => ({ signedTxXdr: '' }) });
  window.SAFU.state.walletAddress = ACC;
  await rejects(CONN.signTransaction('xdr'), 'empty signature must be rejected');
  window.SAFU.state.walletAddress = null;
});

await ta('the Stellar connector REFUSES to run while an EVM chain is active', async () => {
  // Guards against a caller reaching the wrong connector and getting a
  // misleading "wrong network" message aimed at the user's wallet.
  mockFreighter({});
  window.SAFU.setChain('ethereum');
  await rejects(CONN.signTransaction('xdr'), 'must refuse when family does not match');
  window.SAFU.setChain('stellar');
});

t('Freighter has no programmatic disconnect and does not pretend otherwise', () => {
  // Access is a standing per-origin permission the USER controls. Claiming to
  // revoke it would be a false statement about what this page can do.
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
