// Unit tests for website/js/ui.js pure helpers.
//
// Why this file exists: before 2026-08-19 `website/` had no test harness of any
// kind, while its flows move real mainnet ETH. The /plan-eng-review at Step 8
// of the T2 D3 work flagged these specific helpers as where a silent wrong
// value originates — escaping, and the chain-namespaced beneficiary key whose
// old form corrupted case-sensitive addresses.
//
// Deliberately dependency-free: website/ has no package.json and no build step,
// and adding one to get a test runner would be a real architecture change.
// Lives outside website/ because deploy-safu-website.sh rsyncs that directory
// wholesale to production.
//
// Run: node tests/website/ui-helpers.test.mjs

import { readFileSync } from 'node:fs';

// ── minimal browser stubs ────────────────────────────────────────────────────
const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
  clear: () => store.clear(),
};
globalThis.document = { getElementById: () => null };
globalThis.window = globalThis;

eval(readFileSync(new URL('../../website/js/ui.js', import.meta.url), 'utf8'));
const ui = window.SAFU.ui;

// ── tiny runner ─────────────────────────────────────────────────────────────
let pass = 0;
const failures = [];

function t(name, fn) {
  store.clear();
  try {
    fn();
    pass++;
  } catch (e) {
    failures.push(`${name}\n    ${e.message}`);
  }
}

function eq(actual, expected, label = '') {
  if (actual !== expected) {
    throw new Error(`${label}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// Real addresses in the formats each chain actually uses. The Stellar strkey is
// the T1 testnet contract id — uppercase base32, which is the whole point.
const EVM   = '0xAbC0000000000000000000000000000000000001';
const STRK  = 'CCQT2VRONZTE5ODBNM3XAQWUPQRLKGMU4MMLA2JK6HJHJMK34Q7ZFTGJ';

// ── esc() ───────────────────────────────────────────────────────────────────

t('esc escapes every HTML-significant character', () => {
  eq(ui.esc('<script>'), '&lt;script&gt;');
  eq(ui.esc('a & b'), 'a &amp; b');
  eq(ui.esc('say "hi"'), 'say &quot;hi&quot;');
  eq(ui.esc("it's"), 'it&#39;s');
});

t('esc neutralises an injection attempt end to end', () => {
  eq(
    ui.esc('<img src=x onerror="alert(1)">'),
    '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'
  );
});

t('esc renders null and undefined as empty, not as the words', () => {
  eq(ui.esc(null), '');
  eq(ui.esc(undefined), '');
});

t('esc leaves an ordinary address untouched', () => {
  eq(ui.esc(EVM), EVM);
});

// ── beneKey() ───────────────────────────────────────────────────────────────

t('beneKey namespaces by chain', () => {
  eq(ui.beneKey(EVM, 1), `safu_bene_1_${EVM}`);
  eq(ui.beneKey(STRK, 'stellar'), `safu_bene_stellar_${STRK}`);
});

t('beneKey preserves address case', () => {
  // The pre-fix key lowercased the address. Harmless for EVM, destroys a
  // Stellar strkey, which is case-sensitive uppercase base32.
  const key = ui.beneKey(STRK, 'stellar');
  eq(key.includes(STRK), true, 'strkey case not preserved: ');
  eq(key.includes(STRK.toLowerCase()), false, 'strkey was lowercased: ');
});

t('the same address on two chains does not collide', () => {
  const a = ui.beneKey(EVM, 1);
  const b = ui.beneKey(EVM, 'stellar');
  eq(a === b, false, 'keys collided across chains: ');
});

// ── getBene() / setBene() ───────────────────────────────────────────────────

t('getBene returns null when nothing is stored', () => {
  eq(ui.getBene(EVM, 1), null);
});

t('getBene returns null for a missing address rather than throwing', () => {
  eq(ui.getBene(null, 1), null);
  eq(ui.getBene(undefined, 1), null);
});

t('setBene then getBene round-trips', () => {
  ui.setBene(EVM, 1, '0xBene0000000000000000000000000000000000002');
  eq(ui.getBene(EVM, 1), '0xBene0000000000000000000000000000000000002');
});

t('setBene then getBene preserves a Stellar strkey exactly', () => {
  ui.setBene(STRK, 'stellar', STRK);
  eq(ui.getBene(STRK, 'stellar'), STRK);
});

t('getBene migrates the legacy lowercased key forward', () => {
  // Anyone who staked before 2026-08-19 has their beneficiary under the old
  // key. Without the fallback they silently lose it.
  const legacyKey = 'safu_bene_' + EVM.toLowerCase();
  localStorage.setItem(legacyKey, '0xLegacy000000000000000000000000000000003');

  eq(ui.getBene(EVM, 1), '0xLegacy000000000000000000000000000000003', 'legacy not read: ');
  // and it is written forward, so the legacy read happens once
  eq(
    localStorage.getItem(ui.beneKey(EVM, 1)),
    '0xLegacy000000000000000000000000000000003',
    'legacy not migrated: '
  );
});

t('getBene prefers the namespaced key over a stale legacy one', () => {
  localStorage.setItem('safu_bene_' + EVM.toLowerCase(), '0xOld0000000000000000000000000000000000004');
  ui.setBene(EVM, 1, '0xNew0000000000000000000000000000000000005');
  eq(ui.getBene(EVM, 1), '0xNew0000000000000000000000000000000000005');
});

t('legacy migration does not fire for a chain the legacy key never covered', () => {
  // The legacy key was EVM-only and lowercased. A Stellar strkey must not
  // accidentally match it.
  localStorage.setItem('safu_bene_' + STRK.toLowerCase(), 'WRONG');
  eq(ui.getBene(STRK, 1), 'WRONG'); // same-address fallback is by design
  store.clear();
  ui.setBene(STRK, 'stellar', STRK);
  eq(ui.getBene(STRK, 'stellar'), STRK, 'namespaced read broke: ');
});

// ── report ──────────────────────────────────────────────────────────────────

console.log(`\nui.js helpers: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFAILURES:');
  failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  process.exit(1);
}
